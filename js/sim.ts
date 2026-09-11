/**
 * fino:sim — run code in a deterministic Realm against an explicit world.
 *
 * A simulation is an ordinary child Realm with deterministic time and
 * randomness, a deny-by-default import map, and parent-owned Facades for every
 * external service. The harness observes the existing Realm transport to
 * produce a journal; it does not introduce a second RPC or capability system.
 *
 * The child owns its local values and execution state. The parent owns Facade
 * implementations, journal copies, and Realm cleanup. Filesystem and network
 * fakes are separate adapters and are not installed implicitly.
 * Descriptor I/O and application readiness are denied by default, even when a
 * high-level file or socket module is inherited. Trusted harness overrides can
 * replace `internal:io` and `internal:runtime/readiness` to admit virtual devices.
 * The runtime's control transport remains live independently of those devices.
 *
 * ## Example
 *
 * ```ts no_run
 * import { simulate } from 'fino:sim';
 *
 * const report = await simulate({
 *   entry: './worker.ts',
 *   seed: 'checkout-flow',
 *   world: {
 *     'app:inventory': {
 *       available: async (sku: string) => sku === 'blue-shirt',
 *     },
 *   },
 * });
 *
 * console.log(report.result, report.journal.entries);
 * ```
 */
import { Facade, ImportMap, Realm, type ImportRule } from 'fino:realm';
import { MemoryFileSystem } from 'fino:file/memory';
import { resolve } from 'fino:file/path';
import { cwd } from 'fino:process';
import { createSeededRandom } from 'internal:runtime/random';
import { bindRpcFaults } from 'internal:sim/faults';
import { CassetteReplay, SimJournal as InternalSimJournal } from 'internal:sim/journal';
import type { Cassette, CassetteFrame, SimCall, SimCallKind } from 'internal:sim/journal';

export type { Cassette, CassetteFrame, SimCall, SimCallKind };

/** A parent-owned implementation exposed to the guest through one module specifier. */
export type SimProvider = Facade | Record<string, unknown>;

/** An adapter that contributes one or more parent-owned modules to a simulation world. */
export interface SimMock {
  /** Return the world entries installed by this adapter, keyed by module specifier. */
  world(): Record<string, SimProvider>;
}

/** Copied HTTP request delivered to a `FakeNet` route handler. */
export interface FakeRequest {
  /** Absolute request URL. */
  url: string;
  /** Normalized uppercase HTTP method. */
  method: string;
  /** Normalized request headers keyed by lowercase name. */
  headers: Record<string, string>;
  /** Buffered request body, or `null` for requests without a body. */
  body: Uint8Array<ArrayBuffer> | null;
}

/** HTTP response returned by a `FakeNet` route. */
export interface FakeResponse {
  /** HTTP status code. Defaults to `200`. */
  status?: number;
  /** HTTP reason phrase. Defaults to the empty string. */
  statusText?: string;
  /** Response headers. */
  headers?: Record<string, string>;
  /** Buffered response body. Strings are UTF-8 encoded. */
  body?: string | Uint8Array;
}

/** Static response or request-aware handler stored in a `FakeNet` route table. */
export type FakeRoute =
  | FakeResponse
  | ((request: FakeRequest) => FakeResponse | undefined | Promise<FakeResponse | undefined>);

/**
 * Parent-owned HTTP route table for a simulated Realm's ambient `fetch()`.
 *
 * Method-specific keys such as `POST https://api.example.com/orders` take
 * precedence over URL-only keys. A handler that returns `undefined`, or a URL
 * with no matching route, produces a diagnostic `502` response without
 * touching the operating-system network.
 *
 * ```ts no_run
 * const net = new FakeNet().route('GET https://api.example.com/health', {
 *   body: 'ok',
 * });
 *
 * const report = await simulate({
 *   entry: './worker.ts',
 *   world: net.world(),
 * });
 * ```
 */
export class FakeNet implements SimMock {
  /** Facade specifier used by the simulation's ambient Fetch adapter. */
  static readonly specifier = 'fino:net/fetch';
  #routes: Map<string, FakeRoute>;

  /** Create a route table from optional initial entries. */
  constructor(routes: Record<string, FakeRoute> = {}) {
    this.#routes = new Map(Object.entries(routes));
  }

  /** Add or replace `pattern`, returning this route table for chaining. */
  route(pattern: string, handler: FakeRoute): this {
    this.#routes.set(pattern, handler);
    return this;
  }

  /** Return the fetch Facade entry expected by `simulate()`. */
  world(): Record<string, SimProvider> {
    return { [FakeNet.specifier]: this.provider() };
  }

  /** Return the parent-side provider independently for custom world composition. */
  provider(): Record<string, unknown> {
    return {
      handleRequest: async (value: unknown) => {
        const request = value as {
          method: string;
          url: string;
          headers: Array<[string, string]>;
          body: Uint8Array | null;
        };
        const publicRequest: FakeRequest = {
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: request.body === null ? null : copyBytes(request.body),
        };
        const route =
          this.#routes.get(`${request.method} ${request.url}`) ?? this.#routes.get(request.url);
        const response =
          typeof route === 'function' ? await route(publicRequest) : (route as FakeResponse);
        if (response === undefined) {
          return {
            status: 502,
            statusText: 'No simulated route',
            headers: [['content-type', 'text/plain']],
            body: new TextEncoder().encode(
              `fino:sim — no route for ${request.method} ${request.url}`,
            ),
          };
        }
        return {
          status: response.status ?? 200,
          statusText: response.statusText ?? '',
          headers: Object.entries(response.headers ?? {}),
          body:
            response.body === undefined
              ? null
              : typeof response.body === 'string'
                ? new TextEncoder().encode(response.body)
                : copyBytes(response.body),
        };
      },
    };
  }
}

/**
 * Parent-owned in-memory filesystem for a simulated Realm.
 *
 * The adapter replaces `fino:file` through the simulation import map, so guest
 * code constructs `DiskFileSystem` normally while every operation crosses the
 * existing Facade transport. The parent can seed state before a run and inspect
 * a copied text snapshot afterwards.
 *
 * ```ts no_run
 * import { FakeFs, simulate } from 'fino:sim';
 *
 * const fs = new FakeFs({ '/etc/app.conf': 'debug=true' });
 * const report = await simulate({ entry: './worker.ts', world: fs.world() });
 * console.log(fs.snapshot(), report.journal.calls(FakeFs.specifier).length);
 * ```
 */
export class FakeFs implements SimMock {
  /** Facade specifier replaced by this adapter. */
  static readonly specifier = 'fino:file';
  #tick = 0;
  #filesystem: MemoryFileSystem;

  /** Create an independent filesystem seeded with `files`. */
  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.#filesystem = new MemoryFileSystem(files, { now: () => ++this.#tick });
  }

  /** Parent-owned filesystem used for setup and direct assertions. */
  get filesystem(): MemoryFileSystem {
    return this.#filesystem;
  }

  /** Return a copied text snapshot of every file currently in the tree. */
  snapshot(): Record<string, string> {
    return this.#filesystem.snapshot();
  }

  /** Return the `fino:file` Facade entry expected by `simulate()`. */
  world(): Record<string, SimProvider> {
    return { [FakeFs.specifier]: this.provider() };
  }

  /** Return the filesystem Facade independently for custom world composition. */
  provider(): Facade {
    const fs = this.#filesystem;
    return new Facade(FakeFs.specifier, [])
      .handle('readFile', (path) => fs.readFile(String(path)))
      .handle('writeFile', (path, data) => fs.writeFile(String(path), data as Uint8Array))
      .handle('exists', async (path) => {
        try {
          await fs.stat(String(path));
          return true;
        } catch {
          return false;
        }
      })
      .handle('stat', (path) => readFileStat(() => fs.stat(String(path))))
      .handle('lstat', (path) => readFileStat(() => fs.lstat(String(path))))
      .handle('readdir', async (path) =>
        (await fs.readdir(String(path))).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : entry.isSymlink() ? 'link' : 'file',
        })),
      )
      .handle('symlink', (target, path) => fs.symlink(String(target), String(path)))
      .handle('readlink', (path) => fs.readlink(String(path)))
      .handle('mkdir', (path, mode) =>
        mode === undefined ? fs.mkdir(String(path)) : fs.mkdir(String(path), Number(mode)),
      )
      .handle('rmdir', (path) => fs.rmdir(String(path)))
      .handle('unlink', (path) => fs.unlink(String(path)))
      .handle('rename', (from, to) => fs.rename(String(from), String(to)))
      .handle('realpath', (path) => fs.realpath(String(path)))
      .moduleFrom('internal:sim/file');
  }
}

type FileStatDescription = {
  kind: 'file' | 'dir' | 'link';
  size: number;
  mtimeMs: number;
};

async function readFileStat(
  read: () => Promise<{
    isDirectory(): boolean;
    isSymlink(): boolean;
    size: number;
    mtimeMs: number;
  }>,
): Promise<FileStatDescription | null> {
  let info;
  try {
    info = await read();
  } catch {
    return null;
  }
  return {
    kind: info.isDirectory() ? 'dir' : info.isSymlink() ? 'link' : 'file',
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** Options for one deterministic simulation run. */
export interface SimulateOptions {
  /** Entry module whose default export the harness calls. */
  entry: string;
  /** Arguments passed to the entry module's default export. */
  args?: unknown[];
  /** Seed for guest randomness. Defaults to `0`. */
  seed?: number | string;
  /** Initial virtual Unix time in milliseconds. Defaults to `1700000000000`. */
  startTime?: number;
  /** Parent-owned modules available to the guest, keyed by import specifier. */
  world?: Record<string, SimProvider>;
  /** Additional rules appended after world entries. Last match wins. */
  overrides?: ImportRule[];
  /** Record Realm RPC traffic or replay it from an in-memory cassette. */
  cassette?: SimCassetteOptions;
  /** Seeded failure and response-latency policy for Facade calls. */
  faults?: SimFaultOptions;
}

/** In-memory cassette behavior for one run. File storage policy is caller-owned. */
export type SimCassetteOptions = { mode: 'record' } | { mode: 'replay'; data: Cassette };

/** Deterministic behavior injected at the Realm RPC boundary. */
export interface SimFaultOptions {
  /** Probability from zero through one that an eligible call fails. Defaults to `0`. */
  errorRate?: number;
  /** Restrict injected failures to these Facade specifiers. */
  only?: string[];
  /** Error text returned for an injected failure. */
  message?: string;
  /** Inclusive virtual-millisecond range charged to each Facade response. */
  latency?: [number, number];
}

/** Read-only projection of completed Facade calls from one simulation. */
export interface SimJournal {
  /** Completed calls in guest invocation order. */
  readonly entries: readonly SimCall[];
  /** Return completed calls matching an optional Facade `specifier` and `method`. */
  calls(specifier?: string, method?: string): SimCall[];
}

/** Observable outcome of one simulation run. */
export interface SimReport<Result = unknown> {
  /** Value returned by the entry module's default export. */
  result: Result;
  /** Completed Facade calls observed at the Realm transport boundary. */
  journal: SimJournal;
  /** Seed used for this run. */
  seed: number | string;
  /** Initial virtual Unix time used for this run. */
  startTime: number;
  /** Recorded transport frames when `cassette.mode` is `record`. */
  cassette?: Cassette;
}

/** Result or failure produced by one seed in a simulation sweep. */
export interface SweepOutcome<Result = unknown> {
  /** Seed used for this run. */
  seed: number | string;
  /** Completed report when the run succeeded. */
  report?: SimReport<Result>;
  /** Thrown value when the run failed. */
  error?: unknown;
}

const DEFAULT_START_TIME = 1_700_000_000_000;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function resolveEntry(entry: string): string {
  if (entry.startsWith('/') || SCHEME_RE.test(entry)) return entry;
  return resolve(cwd(), entry).toString();
}

function worldRules(world: Record<string, SimProvider>): ImportRule[] {
  return Object.entries(world).map(([specifier, provider]) => ({
    pattern: specifier,
    directive: provider instanceof Facade ? provider : Facade.from(provider, { specifier }),
  }));
}

/**
 * Run an entry module in a deterministic, deny-by-default Realm.
 *
 * Plain objects in `world` become Facades; existing Facades retain their custom
 * module and streaming shapes. `overrides` are applied last so callers can
 * deliberately replace a world entry or inherit an additional pure module.
 * The Realm and its transport observer are disposed whether the call returns
 * or throws.
 *
 * `options` defines the entry, arguments, deterministic inputs, import world,
 * and optional in-memory recording, replay, or fault policy.
 */
export async function simulate<Result = unknown>(
  options: SimulateOptions,
): Promise<SimReport<Result>> {
  const seed = options.seed ?? 0;
  const startTime = options.startTime ?? DEFAULT_START_TIME;
  const entry = resolveEntry(options.entry);
  using realm = new Realm<(entry: string, args: unknown[]) => Result>({
    entry: 'internal:sim/guest',
    deterministic: {
      seed,
      startTime,
      ...(options.faults?.latency === undefined ? {} : { responseLatency: options.faults.latency }),
    },
    overrides: ImportMap.deny([
      {
        pattern: 'internal:io',
        directive: { type: 'source', code: "export * from 'internal:sim/io';", source_map: '' },
      },
      {
        pattern: 'internal:runtime/readiness',
        directive: {
          type: 'source',
          code: "export * from 'internal:sim/readiness';",
          source_map: '',
        },
      },
      { pattern: 'internal:runtime/loop', directive: 'inherit' },
      { pattern: entry, directive: 'inherit' },
      ...worldRules(options.world ?? {}),
      ...(options.overrides ?? []),
    ]),
  });
  const journal = new InternalSimJournal();
  const recording = options.cassette?.mode === 'record';
  const stopObservation = recording ? journal.record(realm.port) : journal.observe(realm.port);
  const replay =
    options.cassette?.mode === 'replay' ? new CassetteReplay(options.cassette.data) : undefined;
  const stopFaults =
    options.faults === undefined
      ? undefined
      : bindRpcFaults(realm.port, createSeededRandom(`${String(seed)}:rpc-faults`), {
          errorRate: options.faults.errorRate ?? 0,
          ...(options.faults.only === undefined
            ? {}
            : { specifiers: new Set(options.faults.only) }),
          ...(options.faults.message === undefined ? {} : { message: options.faults.message }),
        });
  const stopReplay = replay?.bind(realm.port);
  try {
    const result = await realm.call(entry, options.args ?? []);
    replay?.assertComplete();
    return {
      result,
      journal,
      seed,
      startTime,
      ...(recording ? { cassette: journal.toCassette() } : {}),
    };
  } finally {
    stopReplay?.();
    stopFaults?.();
    stopObservation();
  }
}

/**
 * Run the same simulation sequentially for each seed.
 *
 * Failures are retained beside their seed instead of stopping later runs. The
 * sequential order keeps a reported seed sufficient to reproduce an outcome,
 * without introducing cross-run scheduling as another input.
 *
 * `options` is reused for each run. An array in `seeds` is used verbatim; a
 * numeric `seeds` value runs integer seeds from zero up to that count.
 */
export async function sweep<Result = unknown>(
  options: Omit<SimulateOptions, 'seed'>,
  seeds: number | Array<number | string>,
): Promise<Array<SweepOutcome<Result>>> {
  const outcomes: Array<SweepOutcome<Result>> = [];
  const seedList =
    typeof seeds === 'number' ? Array.from({ length: seeds }, (_, index) => index) : seeds;
  for (const seed of seedList) {
    try {
      outcomes.push({ seed, report: await simulate<Result>({ ...options, seed }) });
    } catch (error) {
      outcomes.push({ seed, error });
    }
  }
  return outcomes;
}
