/**
 * fino:data/dataset - deterministic datasets and pull-driven data loading.
 *
 * `Dataset` owns finite, deterministic random-access values.
 * `IterableDataset` is the single lazy composition path for finite and
 * streaming inputs, and `DataLoader` adds batching plus collation without
 * introducing a second scheduler. Every transform is an `AsyncIterable`, so
 * consumers control demand: the pipeline reads one item only when the next
 * item or batch is requested. Early return and cancellation close upstream
 * iterators.
 *
 * Randomness is explicit. Buffered shuffle derives its stream from `seed`,
 * `epoch`, and `workerId`, which makes repeated evaluation and future worker
 * execution reproducible. FIN-98 can add realm workers and durable checkpoints
 * behind this contract without changing callers.
 *
 * Built-in adapters cover CSV, JSON Lines, Arrow IPC, Parquet, SQLite, HTTP,
 * and hub-style HTTP repositories. Tabular binary sources yield Arrow
 * `RecordBatch` objects; row sources can use `arrowCollator` at the loader
 * boundary.
 *
 * ```ts no_run
 * import { DataLoader, csvDataset, arrowCollator } from 'fino:data/dataset';
 *
 * const rows = csvDataset('id,text\n1,hello\n2,world\n', {
 *   header: true,
 *   cast: true,
 * });
 * const batches = new DataLoader(rows, {
 *   batchSize: 128,
 *   shuffle: { bufferSize: 2048 },
 *   seed: 7,
 *   collate: arrowCollator,
 * });
 *
 * for await (const batch of batches.forEpoch(0)) {
 *   console.log(batch.numRows);
 * }
 * ```
 */
import { parseStream, type CsvParseOptions } from 'fino:format/csv';
import { RecordBatch, RecordBatchReader, Table } from 'fino:data/arrow';
import { readParquet } from 'fino:data/parquet';
import type { Database, SqlValue } from 'fino:database/sqlite';

/**
 * Value returned directly or through a promise by transform and collator callbacks.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Synchronous or asynchronous iterable accepted by dataset composition APIs.
 */
export type DatasetSource<T> = Iterable<T> | AsyncIterable<T>;

/**
 * Reproducibility and cancellation inputs for one dataset traversal.
 *
 * `epoch` and `workerId` default to zero. `seed` also defaults to zero unless
 * an operation, such as `shuffle`, supplies its own seed. A canceled signal
 * rejects the next pull and closes the active upstream iterator.
 */
export interface DatasetIterationOptions {
  /** Epoch number mixed into seeded transforms. Defaults to `0`. */
  epoch?: number;
  /** Worker number mixed into seeded transforms. Defaults to `0`. */
  workerId?: number;
  /** Base seed used when a transform does not provide one. Defaults to `0`. */
  seed?: number;
  /** Optional cancellation signal checked before every upstream pull. */
  signal?: AbortSignal;
}

/**
 * Fully normalized context received by dataset factories.
 *
 * Numeric values are always present and validated; only `signal` is optional.
 */
export interface DatasetIterationContext {
  /** Epoch number for this traversal. */
  epoch: number;
  /** Worker number for this traversal. */
  workerId: number;
  /** Base random seed for this traversal. */
  seed: number;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Context passed to `map` and `filter` callbacks.
 *
 * `index` is the zero-based position in that traversal, before the current
 * transform removes or changes any item.
 */
export interface DatasetTransformContext extends DatasetIterationContext {
  /** Zero-based source position for the current traversal. */
  index: number;
}

/**
 * Factory used by `IterableDataset`.
 *
 * A factory should create a fresh iterable for each traversal. It receives the
 * normalized epoch, worker, seed, and cancellation context.
 */
export type DatasetFactory<T> = (context: DatasetIterationContext) => DatasetSource<T>;

/**
 * Options for bounded-memory streaming shuffle.
 */
export interface ShuffleOptions {
  /**
   * Maximum number of items retained for random selection.
   *
   * Must be a positive integer. Larger values approach a full random
   * permutation while using proportionally more memory.
   */
  bufferSize: number;
  /** Seed for this shuffle. Defaults to the traversal's seed. */
  seed?: number;
}

/**
 * Options for deterministic dataset partitioning.
 */
export interface SplitOptions {
  /** Seed controlling membership. Defaults to `0`. */
  seed?: number;
}

/**
 * Options for grouping adjacent items.
 */
export interface BatchOptions {
  /** Omit the final group when it contains fewer than `size` items. */
  dropLast?: boolean;
}

function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

function normalizeContext(options: DatasetIterationOptions = {}): DatasetIterationContext {
  return {
    epoch: integer(options.epoch ?? 0, 'epoch'),
    workerId: integer(options.workerId ?? 0, 'workerId'),
    seed: integer(options.seed ?? 0, 'seed'),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('dataset iteration aborted');
}

function asyncIterator<T>(source: DatasetSource<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) return (source as AsyncIterable<T>)[Symbol.asyncIterator]();
  const iterator = (source as Iterable<T>)[Symbol.iterator]();
  const result: AsyncIterator<T> = {
    next: async () => iterator.next(),
  };
  if (iterator.return) result.return = async () => iterator.return!();
  if (iterator.throw) result.throw = async (error?: unknown) => iterator.throw!(error);
  return result;
}

async function* guard<T>(
  source: DatasetSource<T>,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<T> {
  const iterator = asyncIterator(source);
  let completed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await iterator.next();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) await iterator.return?.();
  }
}

function mixSeed(seed: number, epoch: number, workerId: number): number {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ epoch, 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ workerId, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function random(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function hashIndex(index: number, seed: number): number {
  let value = (index ^ seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

/**
 * Lazy, repeatable dataset backed by a synchronous or asynchronous factory.
 *
 * Transform methods return another `IterableDataset` and do no work until it
 * is iterated. Use `iterate(options)` when an epoch, worker id, seed, or
 * cancellation signal matters; ordinary `for await` uses all-zero defaults.
 *
 * ```ts no_run
 * import { IterableDataset } from 'fino:data/dataset';
 *
 * const values = IterableDataset.from([1, 2, 3, 4])
 *   .filter((value) => value % 2 === 0)
 *   .map((value) => value * 10);
 * console.log(await Array.fromAsync(values)); // [20, 40]
 * ```
 */
export class IterableDataset<T> implements AsyncIterable<T> {
  readonly #factory: DatasetFactory<T>;

  /**
   * Create a lazy dataset from a factory.
   *
   * The factory runs once for each traversal and should return a fresh
   * iterable when repeatability is required.
   */
  constructor(factory: DatasetFactory<T>) {
    if (typeof factory !== 'function')
      throw new TypeError('IterableDataset requires a factory function');
    this.#factory = factory;
  }

  /**
   * Wrap an existing iterable.
   *
   * Arrays, sets, and normal iterable containers can be traversed repeatedly.
   * A self-returning one-shot iterator remains one-shot; use the constructor
   * with a factory when the source must be reopened.
   */
  static from<T>(source: DatasetSource<T>): IterableDataset<T> {
    return new IterableDataset(() => source);
  }

  /**
   * Start a traversal with explicit reproducibility and cancellation inputs.
   */
  iterate(options: DatasetIterationOptions = {}): AsyncIterableIterator<T> {
    const context = normalizeContext(options);
    return guard(this.#factory(context), context.signal);
  }

  /** Iterate with epoch, worker, and seed all set to zero. */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this.iterate();
  }

  /**
   * Lazily transform every item.
   *
   * The mapper may be synchronous or asynchronous. Results preserve source
   * order.
   */
  map<U>(
    mapper: (value: T, context: DatasetTransformContext) => MaybePromise<U>,
  ): IterableDataset<U> {
    const source = this;
    return new IterableDataset<U>(async function* (context) {
      let index = 0;
      for await (const value of source.iterate(context)) {
        throwIfAborted(context.signal);
        yield await mapper(value, { ...context, index: index++ });
      }
    });
  }

  /**
   * Lazily retain items accepted by `predicate`.
   *
   * The predicate may be synchronous or asynchronous. Its index refers to the
   * input position, not the number of accepted rows.
   */
  filter(
    predicate: (value: T, context: DatasetTransformContext) => MaybePromise<boolean>,
  ): IterableDataset<T> {
    const source = this;
    return new IterableDataset<T>(async function* (context) {
      let index = 0;
      for await (const value of source.iterate(context)) {
        throwIfAborted(context.signal);
        if (await predicate(value, { ...context, index })) yield value;
        index++;
      }
    });
  }

  /**
   * Shuffle with bounded memory.
   *
   * The first `bufferSize` items fill a reservoir. Each later item replaces a
   * randomly selected slot whose previous value is emitted; the remaining
   * slots are drained randomly at the end. The same seed, epoch, worker id,
   * and input yield the same order.
   */
  shuffle(options: ShuffleOptions): IterableDataset<T> {
    const bufferSize = integer(options.bufferSize, 'bufferSize', 1);
    const source = this;
    return new IterableDataset<T>(async function* (context) {
      const rng = random(mixSeed(options.seed ?? context.seed, context.epoch, context.workerId));
      const buffer: T[] = [];
      for await (const value of source.iterate(context)) {
        if (buffer.length < bufferSize) {
          buffer.push(value);
          continue;
        }
        const index = Math.floor(rng() * buffer.length);
        const selected = buffer[index]!;
        buffer[index] = value;
        yield selected;
      }
      while (buffer.length > 0) {
        const index = Math.floor(rng() * buffer.length);
        yield buffer[index]!;
        buffer[index] = buffer[buffer.length - 1]!;
        buffer.pop();
      }
    });
  }

  /**
   * Group adjacent items.
   *
   * At most `size` source values are retained. The final partial batch is
   * emitted unless `dropLast` is true.
   */
  batch(size: number, options: BatchOptions = {}): IterableDataset<T[]> {
    integer(size, 'size', 1);
    const source = this;
    return new IterableDataset<T[]>(async function* (context) {
      let values: T[] = [];
      for await (const value of source.iterate(context)) {
        values.push(value);
        if (values.length === size) {
          yield values;
          values = [];
        }
      }
      if (values.length > 0 && !options.dropLast) yield values;
    });
  }

  /**
   * Yield at most `count` items and then close the source iterator.
   */
  take(count: number): IterableDataset<T> {
    integer(count, 'count');
    const source = this;
    return new IterableDataset<T>(async function* (context) {
      if (count === 0) return;
      let emitted = 0;
      for await (const value of source.iterate(context)) {
        yield value;
        emitted++;
        if (emitted === count) return;
      }
    });
  }

  /**
   * Partition a stream deterministically according to positive weights.
   *
   * Membership is a stable hash of source position and `seed`; it does not
   * change with epoch or worker id. Each returned dataset traverses the source
   * independently, so use a replayable source when consuming several splits.
   */
  split(weights: readonly number[], options: SplitOptions = {}): IterableDataset<T>[] {
    if (weights.length === 0) throw new RangeError('split requires at least one weight');
    let total = 0;
    const boundaries = weights.map((weight) => {
      if (!Number.isFinite(weight) || weight <= 0)
        throw new RangeError('split weights must be finite and positive');
      total += weight;
      return total;
    });
    const seed = integer(options.seed ?? 0, 'seed');
    return weights.map((_, partition) =>
      this.filter((__, context) => {
        const point = (hashIndex(context.index, seed) / 0x1_0000_0000) * total;
        const selected = boundaries.findIndex((boundary) => point < boundary);
        return selected === partition;
      }),
    );
  }

  /**
   * Round-robin this dataset with another source.
   *
   * When one source finishes, the remaining source continues alone. Both
   * iterators are closed if the consumer stops early.
   */
  interleave<U>(other: DatasetSource<U>): IterableDataset<T | U> {
    const source = this;
    return new IterableDataset<T | U>(async function* (context) {
      const iterators: AsyncIterator<T | U>[] = [
        source.iterate(context),
        other instanceof IterableDataset ? other.iterate(context) : asyncIterator(other),
      ];
      const active = [true, true];
      try {
        while (active[0] || active[1]) {
          for (let index = 0; index < iterators.length; index++) {
            if (!active[index]) continue;
            throwIfAborted(context.signal);
            const next = await iterators[index]!.next();
            if (next.done) active[index] = false;
            else yield next.value;
          }
        }
      } finally {
        await Promise.all(
          iterators.map(async (iterator, index) => {
            if (active[index]) await iterator.return?.();
          }),
        );
      }
    });
  }
}

/**
 * Finite dataset with deterministic asynchronous random access.
 *
 * `Dataset.from` snapshots its input array, so later mutations of the caller's
 * array cannot change indexing or iteration. `get` is always asynchronous to
 * keep consumer code compatible with future random-access storage sources.
 *
 * ```ts no_run
 * import { Dataset } from 'fino:data/dataset';
 *
 * const rows = Dataset.from([{ id: 1 }, { id: 2 }]);
 * console.log(await rows.get(1)); // { id: 2 }
 * ```
 */
export class Dataset<T> extends IterableDataset<T> {
  readonly #values: readonly T[];

  /** Number of indexed values. */
  readonly length: number;

  private constructor(values: readonly T[]) {
    const snapshot = [...values];
    super(() => snapshot);
    this.#values = snapshot;
    this.length = snapshot.length;
  }

  /** Snapshot an array-like sequence as a deterministic indexed dataset. */
  static from<T>(values: readonly T[]): Dataset<T> {
    return new Dataset(values);
  }

  /**
   * Read one position.
   *
   * Throws `RangeError` for indices outside `[0, length)`.
   */
  async get(index: number): Promise<T> {
    integer(index, 'index');
    if (index >= this.length) throw new RangeError('dataset index is out of range');
    return this.#values[index]!;
  }

  /** Copy all indexed values into a plain array. */
  toArray(): T[] {
    return [...this.#values];
  }
}

/**
 * Context passed to a DataLoader collator.
 */
export interface CollateContext {
  /** Zero-based batch position within this loader traversal. */
  batchIndex: number;
  /** Epoch selected for this traversal. */
  epoch: number;
  /** Worker id selected for this traversal. */
  workerId: number;
  /** Cancellation signal, when supplied. */
  signal?: AbortSignal;
}

/**
 * Convert one item group into the value yielded by `DataLoader`.
 */
export type CollateFunction<T, B> = (
  values: readonly T[],
  context: CollateContext,
) => MaybePromise<B>;

/**
 * DataLoader construction options.
 */
export interface DataLoaderOptions<T, B = T[]> {
  /** Number of source items per yielded value. Defaults to `1`. */
  batchSize?: number;
  /** Omit the final incomplete group. Defaults to `false`. */
  dropLast?: boolean;
  /**
   * Enable deterministic buffered shuffle.
   *
   * The buffer bound is explicit so memory use cannot grow to the full source
   * by accident.
   */
  shuffle?: ShuffleOptions;
  /** Loader seed mixed with traversal epoch and worker id. Defaults to `0`. */
  seed?: number;
  /** Convert an item group into the yielded batch value. Defaults to a new array. */
  collate?: CollateFunction<T, B>;
}

/**
 * Pull-driven batching and collation over an `IterableDataset`.
 *
 * A loader does not prefetch in FIN-97: requesting the next batch pulls only
 * enough source items to build that batch. This is the base backpressure
 * contract that FIN-98's bounded worker queues will preserve.
 *
 * ```ts no_run
 * import { DataLoader, Dataset } from 'fino:data/dataset';
 *
 * const loader = new DataLoader(Dataset.from([1, 2, 3]), {
 *   batchSize: 2,
 *   collate: (values) => new Uint32Array(values),
 * });
 * for await (const values of loader) console.log(values);
 * ```
 */
export class DataLoader<T, B = T[]> implements AsyncIterable<B> {
  readonly #source: IterableDataset<T>;
  readonly #batchSize: number;
  readonly #dropLast: boolean;
  readonly #shuffle: ShuffleOptions | undefined;
  readonly #seed: number;
  readonly #collate: CollateFunction<T, B>;

  /** Create a reusable loader over a dataset or arbitrary iterable. */
  constructor(
    source: IterableDataset<T> | DatasetSource<T>,
    options: DataLoaderOptions<T, B> = {},
  ) {
    this.#source = source instanceof IterableDataset ? source : IterableDataset.from(source);
    this.#batchSize = integer(options.batchSize ?? 1, 'batchSize', 1);
    this.#dropLast = options.dropLast ?? false;
    this.#shuffle = options.shuffle;
    this.#seed = integer(options.seed ?? 0, 'seed');
    this.#collate = options.collate ?? ((values) => [...values] as B);
  }

  /**
   * Traverse and collate with explicit epoch, worker, and cancellation inputs.
   */
  iterate(options: DatasetIterationOptions = {}): AsyncIterableIterator<B> {
    const context = normalizeContext({
      ...options,
      seed: options.seed ?? this.#seed,
    });
    let source = this.#source;
    if (this.#shuffle)
      source = source.shuffle({
        ...this.#shuffle,
        seed: this.#shuffle.seed ?? context.seed,
      });
    const groups = source.batch(this.#batchSize, { dropLast: this.#dropLast });
    const collate = this.#collate;
    return new IterableDataset<B>(async function* () {
      let batchIndex = 0;
      for await (const values of groups.iterate(context)) {
        throwIfAborted(context.signal);
        yield await collate(values, {
          batchIndex: batchIndex++,
          epoch: context.epoch,
          workerId: context.workerId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
      }
    }).iterate(context);
  }

  /** Traverse epoch zero with the loader's configured seed. */
  [Symbol.asyncIterator](): AsyncIterableIterator<B> {
    return this.iterate();
  }

  /**
   * Return an iterable view for one epoch.
   *
   * Calling this repeatedly with the same epoch reproduces the same shuffle
   * and batch order.
   */
  forEpoch(
    epoch: number,
    options: Omit<DatasetIterationOptions, 'epoch'> = {},
  ): IterableDataset<B> {
    integer(epoch, 'epoch');
    const loader = this;
    return new IterableDataset(() => loader.iterate({ ...options, epoch }));
  }
}

/**
 * Collate plain object rows into one Arrow `RecordBatch`.
 *
 * Column order follows first appearance across the rows; missing values become
 * null. Type inference uses `RecordBatch.from`, so provide a custom collator
 * when an explicit schema is required or a column contains only nulls.
 */
export function arrowCollator(rows: readonly Record<string, unknown>[]): RecordBatch {
  if (rows.length === 0) throw new RangeError('arrowCollator requires at least one row');
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  const columns: Record<string, unknown[]> = {};
  for (const name of names) columns[name] = rows.map((row) => row[name] ?? null);
  return RecordBatch.from(columns);
}

/**
 * Text, bytes, or chunked bytes accepted by row-oriented source adapters.
 *
 * Strings are interpreted as content, not filesystem paths. Use a
 * `DiskFileSystem` reader as the async iterable for bounded file input.
 */
export type ByteSource =
  | string
  | Uint8Array
  | ArrayBuffer
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

async function* bytes(
  source: ByteSource,
  context?: DatasetIterationContext,
): AsyncIterableIterator<Uint8Array> {
  if (typeof source === 'string') {
    yield new TextEncoder().encode(source);
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }
  const chunks = context && source instanceof IterableDataset ? source.iterate(context) : source;
  for await (const chunk of chunks) yield chunk;
}

async function collectBytes(
  source: ByteSource,
  context?: DatasetIterationContext,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of bytes(source, context)) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Stream CSV content as positional arrays or header-keyed records.
 *
 * Parsing delegates to `fino:format/csv`, including dialect, header, casting,
 * and column-count behavior. Chunked sources retain only the current logical
 * row.
 */
export function csvDataset(
  source: ByteSource,
  options?: CsvParseOptions & {
    header?: false;
    columns?: undefined;
  },
): IterableDataset<string[]>;
export function csvDataset(
  source: ByteSource,
  options: CsvParseOptions & {
    header: true;
  },
): IterableDataset<Record<string, unknown>>;
export function csvDataset(
  source: ByteSource,
  options: CsvParseOptions & {
    columns: string[];
  },
): IterableDataset<Record<string, unknown>>;
export function csvDataset(
  source: ByteSource,
  options?: CsvParseOptions,
): IterableDataset<Record<string, unknown> | string[]>;
export function csvDataset(
  source: ByteSource,
  options: CsvParseOptions = {},
): IterableDataset<Record<string, unknown> | string[]> {
  return new IterableDataset(
    (context) =>
      parseStream(bytes(source, context), options) as AsyncIterable<
        Record<string, unknown> | string[]
      >,
  );
}

/**
 * JSON Lines parsing options.
 */
export interface JsonlDatasetOptions {
  /** Optional `JSON.parse` reviver. */
  reviver?: (this: unknown, key: string, value: unknown) => unknown;
  /** Ignore blank or whitespace-only lines. Defaults to `true`. */
  skipEmptyLines?: boolean;
}

/**
 * Stream newline-delimited JSON values across arbitrary UTF-8 chunk boundaries.
 *
 * Each non-empty line is parsed independently. A final line does not require a
 * trailing newline.
 */
export function jsonlDataset<T = unknown>(
  source: ByteSource,
  options: JsonlDatasetOptions = {},
): IterableDataset<T> {
  return new IterableDataset<T>(async function* (context) {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of bytes(source, context)) {
      pending += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if ((options.skipEmptyLines ?? true) && line.trim() === '') continue;
        yield JSON.parse(line, options.reviver) as T;
      }
    }
    pending += decoder.decode();
    const line = pending.replace(/\r$/, '');
    if (line !== '' && (!(options.skipEmptyLines ?? true) || line.trim() !== ''))
      yield JSON.parse(line, options.reviver) as T;
  });
}

/**
 * Arrow values accepted by `arrowDataset`.
 */
export type ArrowDatasetSource =
  | RecordBatch
  | Table
  | Uint8Array
  | ArrayBuffer
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>;

/**
 * Expose Arrow tables, batches, or IPC input as a record-batch stream.
 *
 * Existing `RecordBatch` and `Table` objects are yielded without copying.
 * IPC byte inputs use `RecordBatchReader`; its current streaming helper
 * buffers bytes before decode, matching the underlying reader contract.
 */
export function arrowDataset(source: ArrowDatasetSource): IterableDataset<RecordBatch> {
  return new IterableDataset<RecordBatch>(async function* (context) {
    if (source instanceof RecordBatch) {
      yield source;
      return;
    }
    if (source instanceof Table) {
      yield* source.batches;
      return;
    }
    const reader =
      source instanceof Uint8Array || source instanceof ArrayBuffer
        ? RecordBatchReader.from(source)
        : await RecordBatchReader.fromAsync(bytes(source, context));
    yield* reader.batches;
  });
}

/**
 * Decode a complete or chunked Parquet file as Arrow record batches.
 *
 * Parquet footer discovery requires the complete file, so chunked sources are
 * bounded by the file size rather than by one row group. Each decoded row
 * group is then yielded as its own `RecordBatch`.
 */
export function parquetDataset(source: ByteSource): IterableDataset<RecordBatch> {
  return new IterableDataset<RecordBatch>(async function* (context) {
    const table = readParquet(await collectBytes(source, context));
    yield* table.batches;
  });
}

/**
 * Stream rows from a SQLite query.
 *
 * The statement is prepared lazily for every traversal, resets on early
 * return through `Statement.iterate`, and is finalized when traversal ends.
 */
export function sqliteDataset(
  database: Database,
  query: string,
  parameters: readonly SqlValue[] = [],
): IterableDataset<Record<string, SqlValue>> {
  return new IterableDataset<Record<string, SqlValue>>(async function* () {
    const statement = database.prepare(query);
    try {
      yield* statement.iterate(...parameters);
    } finally {
      statement.finalize();
    }
  });
}

/**
 * Wire formats decoded by `httpDataset` and `hubDataset`.
 */
export type HttpDatasetFormat = 'json' | 'jsonl' | 'csv' | 'arrow' | 'parquet';

/**
 * HTTP-backed dataset options.
 */
export interface HttpDatasetOptions<F extends HttpDatasetFormat = HttpDatasetFormat> {
  /** Response wire format. */
  format: F;
  /** Request headers merged into `request`. */
  headers?: HeadersInit;
  /** CSV dialect and row-shape options for `format: 'csv'`. */
  csv?: CsvParseOptions;
  /** JSON Lines options for `format: 'jsonl'`. */
  jsonl?: JsonlDatasetOptions;
  /** Other request settings. Traversal cancellation overrides its signal. */
  request?: RequestInit;
  /** Injectable Fetch-compatible implementation for testing or custom transports. */
  fetch?: (request: Request) => Promise<Response>;
}

async function* responseBytes(response: Response): AsyncIterableIterator<Uint8Array> {
  if (!response.body) {
    yield new Uint8Array(await response.arrayBuffer());
    return;
  }
  const reader = response.body.getReader();
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the consumer's return or original error.
      }
    }
    reader.releaseLock();
  }
}

/**
 * Fetch and decode a dataset lazily.
 *
 * No request is sent until iteration starts. JSON arrays yield one item per
 * element; a non-array JSON document yields once. JSONL and CSV consume the
 * response stream incrementally. Arrow IPC and Parquet follow their underlying
 * whole-buffer reader constraints and yield `RecordBatch` values.
 */
export function httpDataset<T = unknown>(
  input: string | URL | Request,
  options: HttpDatasetOptions<'json' | 'jsonl'>,
): IterableDataset<T>;
export function httpDataset(
  input: string | URL | Request,
  options: HttpDatasetOptions<'csv'>,
): IterableDataset<Record<string, unknown> | string[]>;
export function httpDataset(
  input: string | URL | Request,
  options: HttpDatasetOptions<'arrow' | 'parquet'>,
): IterableDataset<RecordBatch>;
export function httpDataset<T = unknown>(
  input: string | URL | Request,
  options: HttpDatasetOptions,
): IterableDataset<T>;
export function httpDataset<T = unknown>(
  input: string | URL | Request,
  options: HttpDatasetOptions,
): IterableDataset<T> {
  return new IterableDataset<T>(async function* (context) {
    const headers = new Headers(options.request?.headers);
    if (options.headers) {
      for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
    }
    const request = new Request(input, {
      ...options.request,
      headers,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const response = await (options.fetch ?? fetch)(request);
    if (!response.ok)
      throw new Error(`dataset request failed: ${response.status} ${response.statusText}`);
    if (options.format === 'json') {
      const value = await response.json();
      if (Array.isArray(value)) yield* value as T[];
      else yield value as T;
      return;
    }
    const body = responseBytes(response);
    if (options.format === 'jsonl') {
      yield* jsonlDataset<T>(body, options.jsonl).iterate(context);
      return;
    }
    if (options.format === 'csv') {
      yield* csvDataset(body, options.csv).iterate(context) as AsyncIterable<T>;
      return;
    }
    if (options.format === 'arrow') {
      yield* arrowDataset(body).iterate(context) as AsyncIterable<T>;
      return;
    }
    yield* parquetDataset(body).iterate(context) as AsyncIterable<T>;
  });
}

/**
 * Options for a revision-addressed hub repository.
 */
export interface HubDatasetOptions<
  F extends HttpDatasetFormat = HttpDatasetFormat,
> extends HttpDatasetOptions<F> {
  /** Hub root. Defaults to the Hugging Face-compatible dataset endpoint. */
  baseUrl?: string | URL;
  /** Repository revision. Defaults to `"main"`. */
  revision?: string;
  /** Optional bearer token added unless `authorization` is already set. */
  token?: string;
}

/**
 * Read a file from a revision-addressed HTTP dataset repository.
 *
 * The URL shape is
 * `{baseUrl}/{repository}/resolve/{revision}/{path}`. Custom `baseUrl` and
 * injectable `fetch` make the adapter usable with self-hosted or
 * Hugging-Face-compatible hubs without adding a second transport path.
 */
export function hubDataset<T = unknown>(
  repository: string,
  path: string,
  options: HubDatasetOptions<'json' | 'jsonl'>,
): IterableDataset<T>;
export function hubDataset(
  repository: string,
  path: string,
  options: HubDatasetOptions<'csv'>,
): IterableDataset<Record<string, unknown> | string[]>;
export function hubDataset(
  repository: string,
  path: string,
  options: HubDatasetOptions<'arrow' | 'parquet'>,
): IterableDataset<RecordBatch>;
export function hubDataset<T = unknown>(
  repository: string,
  path: string,
  options: HubDatasetOptions,
): IterableDataset<T>;
export function hubDataset<T = unknown>(
  repository: string,
  path: string,
  options: HubDatasetOptions,
): IterableDataset<T> {
  const {
    baseUrl = 'https://huggingface.co/datasets',
    revision: requestedRevision = 'main',
    token,
    ...httpOptions
  } = options;
  const base = String(baseUrl).replace(/\/$/, '');
  const repo = repository.split('/').map(encodeURIComponent).join('/');
  const file = path.split('/').map(encodeURIComponent).join('/');
  const revision = encodeURIComponent(requestedRevision);
  const headers = new Headers(httpOptions.headers);
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return httpDataset<T>(`${base}/${repo}/resolve/${revision}/${file}`, {
    ...httpOptions,
    headers,
  });
}
