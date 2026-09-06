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
import { createSeededRandom } from 'internal:runtime/random';
import { bindRpcFaults } from 'internal:sim/faults';
import { CassetteReplay, SimJournal as InternalSimJournal } from 'internal:sim/journal';
import type { Cassette, CassetteFrame, SimCall, SimCallKind } from 'internal:sim/journal';

export type { Cassette, CassetteFrame, SimCall, SimCallKind };

/** A parent-owned implementation exposed to the guest through one module specifier. */
export type SimProvider = Facade | Record<string, unknown>;

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
  using realm = new Realm<(...args: unknown[]) => Result>({
    entry: options.entry,
    deterministic: {
      seed,
      startTime,
      ...(options.faults?.latency === undefined ? {} : { responseLatency: options.faults.latency }),
    },
    overrides: ImportMap.deny([
      { pattern: 'internal:runtime/loop', directive: 'inherit' },
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
    const result = await realm.call(...(options.args ?? []));
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
