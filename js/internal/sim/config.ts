/**
 * internal:sim/config — the simulation settings a realm is created with.
 *
 * This travels to the child inside the realm bootstrap payload, which is an
 * opaque JSON string end to end, so the shape is plain data with no imports.
 * The parent writes it; `internal:sim/install` reads it before the entry module
 * is imported.
 *
 * ```ts no_run
 * import { resolveSimConfig } from 'internal:sim/config';
 *
 * console.log(resolveSimConfig({ seed: 1 }).virtualTime); // true
 * ```
 *
 * @internal
 */
/**
 * Simulation settings for one realm.
 *
 * @internal
 */
export interface SimConfig {
  /**
   * Seed for every random source in the realm. Equal seeds replay equally.
   *
   * Strings are hashed, so a named simulation is as reproducible as a numeric
   * seed and easier to read in a failure report.
   */
  seed: number | string;
  /**
   * Wall-clock milliseconds the simulation starts at. Defaults to
   * 2023-11-14T22:13:20Z, an arbitrary fixed instant chosen so that runs are
   * comparable across machines.
   */
  startTime?: number;
  /**
   * Virtualize `Date`, `performance`, and timers. Defaults to `true`.
   *
   * Turning this off keeps seeded randomness while leaving time real, which is
   * occasionally useful when recording against a live dependency.
   */
  virtualTime?: boolean;
  /**
   * Inclusive range of virtual milliseconds to delay each facade response by,
   * drawn from a generator seeded separately from the guest's own randomness.
   *
   * Requires `virtualTime`; with a real clock there is no simulated delay to
   * apply. Read-stream chunks are delayed too, each drawing its own latency in
   * arrival order while chunk order is preserved.
   */
  latency?: [number, number];
}
/**
 * A `SimConfig` with every optional field filled in.
 *
 * @internal
 */
export interface ResolvedSimConfig {
  seed: number | string;
  startTime: number;
  virtualTime: boolean;
  latency: [number, number] | null;
}
/** 2023-11-14T22:13:20Z. */
const DEFAULT_START_TIME = 1_700_000_000_000;
/**
 * Fill in the optional fields of a `SimConfig`.
 *
 * @internal
 */
export function resolveSimConfig(config: SimConfig): ResolvedSimConfig {
  return {
    seed: config.seed,
    startTime: config.startTime ?? DEFAULT_START_TIME,
    virtualTime: config.virtualTime ?? true,
    latency: config.latency ?? null,
  };
}
