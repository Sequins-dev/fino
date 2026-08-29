/**
 * internal:bytes — explicit byte views, owned copies, collection, and equality.
 *
 * This module provides protocol-neutral binary primitives for runtime builtins.
 * Its names encode the ownership contract: `asByteView` never copies and always
 * aliases the caller's backing store, while `copyBytes` and `copyArrayBuffer`
 * always return independently owned storage. `concatBytes` allocates only when
 * multiple parts must be joined. Callers remain responsible for domain-specific
 * coercion, error messages, byte ordering, and resource policy.
 *
 * Concatenation accounts for the complete result before allocating it and can
 * enforce a caller-provided byte limit. Collection snapshots each yielded chunk,
 * enforces limits before copying it, and closes iterators on early failure. The
 * equality helpers separate ordinary early-exit comparison from a comparison
 * loop that visits every byte. JavaScript engines do not guarantee constant-time
 * execution, so `timingSafeEqualBytes` only promises not to exit early based on
 * byte contents.
 *
 * The value primitives are synchronous and side-effect free apart from their
 * documented allocations. `collectBytes` is asynchronous and interacts only
 * with its source iterator and optional abort signal. The module keeps no
 * process-global state. Owned results use ordinary Realm-local JavaScript buffers.
 * `asByteView` preserves the input backing store, including shared storage when
 * passed a SharedArrayBuffer-backed view.
 *
 * ```ts no_run
 * import { asByteView, concatBytes, copyBytes } from 'internal:bytes';
 *
 * const source = new Uint16Array([0x1234]);
 * const aliased = asByteView(source);
 * const owned = copyBytes(source);
 * const packet = concatBytes([owned, new Uint8Array([0xff])], { maxBytes: 64 });
 * ```
 *
 * @internal
 */

import { AbortSignal } from '../globals/abort.ts';

type ByteSource = ArrayBuffer | ArrayBufferView;

interface ConcatBytesOptions {
  readonly maxBytes?: number;
}

export interface CollectBytesOptions {
  readonly maxBytes?: number;
  readonly expectedBytes?: number;
  readonly signal?: AbortSignal;
}

interface ByteCollection {
  readonly maxBytes: number;
  readonly expectedBytes: number | undefined;
  readonly output: Uint8Array | null;
  readonly parts: Uint8Array[];
  total: number;
}

interface CollectBytesConfig {
  readonly maxBytes: number;
  readonly expectedBytes: number | undefined;
  readonly signal: AbortSignal | undefined;
}

function byteLimit(value: number | undefined): number {
  const maxBytes = value ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  return maxBytes;
}

function expectedByteLength(expectedBytes: number | undefined): number | undefined {
  if (expectedBytes === undefined) return undefined;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new RangeError('expectedBytes must be a non-negative safe integer');
  }
  return expectedBytes;
}

function collectBytesConfig(options?: CollectBytesOptions): CollectBytesConfig {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError('collectBytes options must be an object');
  }
  const maxBytes = byteLimit(options?.maxBytes);
  const expectedBytes = expectedByteLength(options?.expectedBytes);
  const signal = options?.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (expectedBytes !== undefined && expectedBytes > maxBytes) {
    throw new RangeError('expectedBytes must be less than or equal to maxBytes');
  }
  return { maxBytes, expectedBytes, signal };
}

function startCollection(config: CollectBytesConfig): ByteCollection {
  const { maxBytes, expectedBytes } = config;
  return {
    maxBytes,
    expectedBytes,
    output: expectedBytes === undefined ? null : new Uint8Array(expectedBytes),
    parts: [],
    total: 0,
  };
}

function byteIterator(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterator<Uint8Array> | Iterator<Uint8Array> {
  const asyncMethod: unknown = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator];
  if (asyncMethod !== undefined && asyncMethod !== null) {
    if (typeof asyncMethod !== 'function') {
      throw new TypeError('Byte source async iterator must be callable');
    }
    return (asyncMethod as () => AsyncIterator<Uint8Array>).call(source);
  }

  const syncMethod: unknown = (source as Iterable<Uint8Array>)[Symbol.iterator];
  if (typeof syncMethod !== 'function') {
    throw new TypeError('Byte source iterator must be callable');
  }
  return (syncMethod as () => Iterator<Uint8Array>).call(source);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

function appendChunk(collection: ByteCollection, chunk: Uint8Array): void {
  if (!(chunk instanceof Uint8Array)) {
    throw new TypeError('Byte source chunks must be Uint8Array');
  }
  const limit = collection.expectedBytes ?? collection.maxBytes;
  if (chunk.byteLength > limit - collection.total) {
    const label = collection.expectedBytes === undefined ? 'maxBytes' : 'expectedBytes';
    throw new RangeError(`Collected bytes exceed ${label} (${limit})`);
  }

  if (collection.output === null) collection.parts.push(copyBytes(chunk));
  else collection.output.set(chunk, collection.total);
  collection.total += chunk.byteLength;
}

function finishCollection(collection: ByteCollection): Uint8Array {
  if (collection.expectedBytes !== undefined && collection.total !== collection.expectedBytes) {
    throw new RangeError(
      `Collected ${collection.total} bytes; expected ${collection.expectedBytes}`,
    );
  }
  if (collection.output !== null) return collection.output;
  if (collection.parts.length === 0) return new Uint8Array(0);
  if (collection.parts.length === 1) return collection.parts[0]!;
  return concatBytes(collection.parts, { maxBytes: collection.maxBytes });
}

async function closeAsyncIterator(
  iterator: Iterator<Uint8Array> | AsyncIterator<Uint8Array>,
): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Preserve the collection error that caused early closure.
  }
}

function pullWithSignal(
  iterator: Iterator<Uint8Array> | AsyncIterator<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (signal === undefined) return Promise.resolve(iterator.next());
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const beginSettle = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (beginSettle()) reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    let next: IteratorResult<Uint8Array> | PromiseLike<IteratorResult<Uint8Array>>;
    try {
      next = iterator.next();
    } catch (error) {
      if (beginSettle()) reject(error);
      return;
    }
    Promise.resolve(next).then(
      (result) => {
        if (beginSettle()) resolve(result);
      },
      (error) => {
        if (beginSettle()) reject(error);
      },
    );
  });
}

/**
 * Return a `Uint8Array` spanning exactly the bytes visible through `value`.
 *
 * An existing `Uint8Array` is returned unchanged. Other views preserve their
 * `byteOffset` and `byteLength`. This operation never copies: the result aliases
 * the input's backing storage, and mutations made through either owner are visible
 * through the other. A view over `SharedArrayBuffer` remains shared. Unsupported
 * runtime values throw `TypeError`.
 */
export function asByteView(value: ByteSource): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer or ArrayBufferView');
}

/**
 * Copy exactly the bytes visible through `value` into an owned `Uint8Array`.
 *
 * The result never aliases the input, including when `value` is already a
 * `Uint8Array` or has zero length.
 */
export function copyBytes(value: ByteSource): Uint8Array {
  return new Uint8Array(asByteView(value));
}

/**
 * Copy a byte view into an exact-length, independently owned `ArrayBuffer`.
 *
 * Only the view's visible span is copied; bytes before its `byteOffset` or after
 * its `byteLength` are excluded.
 */
export function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

/**
 * Concatenate `parts`, allocating only when multiple byte spans must be joined.
 *
 * The total is validated before allocation. When `options.maxBytes` is present,
 * a result larger than that limit throws `RangeError`; invalid limits and totals
 * outside JavaScript's safe-integer range also throw `RangeError`. An empty input
 * returns a new empty view. A single part is returned unchanged and remains
 * caller-owned; use `copyBytes` when independent ownership is required.
 */
export function concatBytes(
  parts: readonly Uint8Array[],
  options?: ConcatBytesOptions,
): Uint8Array {
  const maxBytes = byteLimit(options?.maxBytes);
  let total = 0;
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      throw new TypeError('concatBytes parts must be Uint8Array');
    }
    if (part.byteLength > maxBytes - total) {
      throw new RangeError(`Concatenated bytes exceed maxBytes (${maxBytes})`);
    }
    total += part.byteLength;
  }
  if (parts.length === 1) return parts[0]!;

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/**
 * Collect an asynchronous or synchronous byte iterable into one owned byte array.
 *
 * Each chunk is snapshotted before the source is advanced, so producers may
 * safely reuse their buffers. `maxBytes` and `expectedBytes` must be non-negative
 * safe integers; `expectedBytes` is an exact final length and also acts as the
 * tighter collection limit. Limits are checked before a chunk is copied.
 * `maxBytes` bounds the logical result length, not peak memory: collection without
 * `expectedBytes` temporarily retains owned chunks while assembling the result.
 *
 * `signal` is checked before every pull and again before accepting each yielded
 * chunk. Aborting or any source, chunk, or limit failure invokes and awaits the
 * iterator's `return()` method once when present. Cleanup failures do not replace
 * the original collection error. A pending pull is raced with abort; collection
 * completion still awaits cooperative iterator cleanup before rejecting.
 */
export async function collectBytes(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options?: CollectBytesOptions,
): Promise<Uint8Array> {
  const config = collectBytesConfig(options);
  throwIfAborted(config.signal);
  const collection = startCollection(config);
  const iterator = byteIterator(source);
  try {
    while (true) {
      throwIfAborted(config.signal);
      const next = await pullWithSignal(iterator, config.signal);
      if (next.done) break;
      throwIfAborted(config.signal);
      appendChunk(collection, next.value);
    }
  } catch (error) {
    await closeAsyncIterator(iterator);
    throw error;
  }
  return finishCollection(collection);
}

/**
 * Compare two byte spans for equality, returning immediately on a mismatch.
 *
 * This is the ordinary, efficient comparison for non-secret data. Both offsets
 * and visible lengths are respected. Shared inputs must not be concurrently
 * mutated while comparison is in progress.
 */
export function equalBytes(left: ByteSource, right: ByteSource): boolean {
  const a = asByteView(left);
  const b = asByteView(right);
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare two byte spans without exiting early based on their contents.
 *
 * Unequal lengths are compared across the longer span, treating missing bytes
 * as zero while preserving a length mismatch in the result. This reduces an
 * obvious timing side channel but cannot guarantee constant-time execution in
 * a JavaScript engine; callers must still avoid secret-dependent work around it
 * and must not concurrently mutate shared inputs during comparison.
 */
export function timingSafeEqualBytes(left: ByteSource, right: ByteSource): boolean {
  const a = asByteView(left);
  const b = asByteView(right);
  const length = Math.max(a.byteLength, b.byteLength);
  let different = a.byteLength === b.byteLength ? 0 : 1;
  for (let i = 0; i < length; i++) {
    different |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return different === 0;
}
