/**
 * fino:bench — benchmark suite, a JS port of benc.h.
 *
 * Mirrors the structure of `fino:test`: register suites with `bench()`,
 * then call `run()` to execute them all and print results. Each suite
 * receives a `Group` object for registering measurements and nested
 * sub-groups. Output format matches benc.h v1.0.0 so results are comparable
 * with C benchmarks.
 *
 * Benchmark functions may be **synchronous or async**. Async benchmarks are
 * detected automatically: if `fn()` returns a thenable, the measurement loop
 * awaits it to completion on every iteration:
 *
 * ```js
 * import { DiskFileSystem } from '../file/fs.mts';
 *
 * bench('file I/O', (b) => {
 *   b.measure('readFile', async () => {
 *     const fs = new DiskFileSystem();
 *     await fs.readFile('/etc/hosts');
 *   });
 * });
 * ```
 *
 * Setup and teardown can be separated from the measured body using object form.
 * The `setup()` return value is passed to each `fn(ctx)` invocation; neither
 * `setup()` nor `teardown()` is included in the timing:
 *
 * ```js
 * b.measure('name', {
 *   setup()    { return createResources(); },
 *   fn(ctx)    { return doWork(ctx); },
 *   teardown() { cleanup(); },
 * });
 * ```
 *
 *
 * ## High-resolution timer (now())
 *
 * The timer is platform-specific:
 *
 * - **macOS**: `mach_continuous_time()` returns ticks in a hardware-defined
 *   unit. The conversion ratio is fetched once via `mach_timebase_info()`,
 *   which fills a `{ uint32_t numer; uint32_t denom; }` struct. The tick
 *   count is multiplied by `numer/denom` to get nanoseconds. On Apple Silicon
 *   the ratio is 1/1 (ticks are already nanoseconds); on Intel Macs it is
 *   a small rational number. `mach_continuous_time()` is preferred over
 *   `mach_absolute_time()` because it continues advancing while the system
 *   is asleep, giving consistent wall-clock readings.
 *
 * - **Linux**: `clock_gettime(CLOCK_MONOTONIC, &ts)` returns a `struct timespec
 *   { time_t tv_sec; long tv_nsec; }`. We allocate a 16-byte buffer (large
 *   enough for 64-bit `time_t` on LP64), read both fields as `BigInt64` (to
 *   handle the full 64-bit range), and convert to nanoseconds.
 *
 *
 * ## Welford's online algorithm (Stats class)
 *
 * Rather than collecting all sample values and computing stats at the end,
 * the `Stats` class uses Welford's online algorithm to compute mean and
 * variance in a single pass with O(1) memory. Each call to `stats.push(x)`:
 *
 *   1. Increments the count.
 *   2. Computes a new mean: `mean' = mean + (x - mean) / count`
 *   3. Updates the sum of squared deviations:
 *      `dSquared' = dSquared + (x - mean') * (x - mean)`
 *
 * Population variance is `dSquared / count`. Standard deviation is the
 * square root of variance. This matches the benc.h implementation exactly
 * (which uses the same recurrence).
 *
 *
 * ## Measurement loop
 *
 * `group.measure(name, fn)` defers registration until `finalize()`. When
 * executed, it runs `fn()` repeatedly until at least 1 second of wall time
 * has elapsed (measured by accumulating `now()` deltas in `stats.total`).
 * Tests can set the internal `FINO_BENCH_MIN_NS` environment variable to lower
 * this duration for CLI runner fixtures; normal benchmark runs keep the
 * one-second default.
 * This adaptive approach ensures that fast functions get many samples (better
 * statistics) and slow functions get at least one full second of coverage.
 *
 * For async benchmarks, each iteration awaits the returned thenable before
 * recording the elapsed time.
 *
 * The release contract is a benc.h-style adaptive harness with human,
 * TAP-adjacent text output. `FINO_BENCH_MIN_NS` is an internal test knob for
 * shortening the minimum sample duration in CLI fixtures. There is no public
 * warmup option, fixed-iteration mode, fixed-sample mode, variance-threshold
 * gate, JSON output, pluggable reporter, or CI regression gate in this module.
 *
 *
 * ## Comparison output
 *
 * After all measurements in a group complete, `#compare()` sorts them by
 * ops/sec (descending), prints the fastest as a baseline, and prints each
 * slower measurement as a percentage overhead relative to the fastest's mean
 * nanoseconds per iteration. This matches benc.h's `bench_compare()`.
 *
 *
 * ## Output format
 *
 *   benc.h v1.0.0
 *   # string ops
 *   concat   - 26.92m i/s (±49.87%) (34.11ns/i)
 *   template - 3.53m i/s (±165.47%) (278.89ns/i)
 *   Comparing...
 *     - concat (fastest)
 *     - template (663.07% slower)
 *
 *
 * ```ts no_run
 * import { bench } from './bench.mts';
 *
 * bench('string ops', (b) => {
 *   b.measure('concat',   () => { 'hello' + ' world'; });
 *   b.measure('template', () => { `hello ${' world'}`; });
 * });
 *
 * bench('with sub-groups', (b) => {
 *   b.group('parsing', (g) => {
 *     g.measure('parseInt', () => { parseInt('42', 10); });
 *     g.measure('Number()', () => { Number('42'); });
 *   });
 * });
 * ```
 */

import console from '../internal/globals/console.mts';
import { env, os } from 'internal:process';
import { dlopen } from 'fino:ffi';

// ---------------------------------------------------------------------------
// High-resolution timer (nanoseconds) — mirrors benc.h bench_now()
// ---------------------------------------------------------------------------

const NANOS   = 1;
const MICROS  = NANOS  * 1000;
const MILLIS  = MICROS * 1000;
const SECONDS = MILLIS * 1000;
const DEFAULT_MIN_NS = SECONDS;

function minDurationNs(): number {
  const raw = env.FINO_BENCH_MIN_NS;
  if (raw === undefined || raw === '') return DEFAULT_MIN_NS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_NS;
}

/** Returns a monotonic nanosecond timestamp as a Number. */
const now = (() => {
  if (os === 'darwin') {
    // mach_continuous_time() returns ticks; multiply by numer/denom for ns.
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      mach_continuous_time: { parameters: [], result: 'u64' },
      mach_timebase_info:   { parameters: ['buffer'], result: 'i32' },
    });

    // mach_timebase_info_data_t: { uint32_t numer; uint32_t denom; }
    const tbiBuf = new ArrayBuffer(8);
    lib.symbols.mach_timebase_info(tbiBuf);
    const tbView = new DataView(tbiBuf);
    const numer = tbView.getUint32(0, true);
    const denom = tbView.getUint32(4, true);

    return () => Number(lib.symbols.mach_continuous_time()) * numer / denom;
  } else {
    // clock_gettime(CLOCK_MONOTONIC, &ts) — struct timespec { time_t tv_sec; long tv_nsec; }
    const CLOCK_MONOTONIC = 1;
    const lib = dlopen('libc.so.6', {
      clock_gettime: { parameters: ['i32', 'buffer'], result: 'i32' },
    });
    const tsBuf = new ArrayBuffer(16); // enough for 64-bit time_t + long

    return () => {
      lib.symbols.clock_gettime(CLOCK_MONOTONIC, tsBuf);
      const v = new DataView(tsBuf);
      const sec  = Number(v.getBigInt64(0, true));
      const nsec = Number(v.getBigInt64(8, true));
      return sec * SECONDS + nsec;
    };
  }
})();

// ---------------------------------------------------------------------------
// Streaming stats — Welford's online algorithm (mirrors bench_stats_*)
// ---------------------------------------------------------------------------

class Stats {
  #count:    number = 0;
  #total:    number = 0;
  #mean:     number = 0;
  #dSquared: number = 0;

  push(value: number): void {
    this.#count++;
    this.#total += value;
    const newMean = this.#mean + (value - this.#mean) / this.#count;
    this.#dSquared += (value - newMean) * (value - this.#mean);
    this.#mean = newMean;
  }

  get count()  { return this.#count; }
  get total()  { return this.#total; }
  get mean()   { return this.#mean; }

  variance() { return this.#dSquared / this.#count; }
  stddev()   { return Math.sqrt(this.variance()); }
  opsPerSec() {
    return (this.#count / this.#total) * SECONDS;
  }
}

// ---------------------------------------------------------------------------
// Human-readable number formatting — mirrors bench_human_number()
// ---------------------------------------------------------------------------

function humanNumber(number: number, isTime: boolean): string {
  const levelCap = isTime ? 3 : 4;
  let level = 0;
  let n = number;

  while (n >= 1000 && ++level <= levelCap) {
    n /= 1000;
  }

  const fmt = n.toFixed(2);
  if (isTime) {
    const suffix = ['ns', 'us', 'ms', 's'];
    return fmt + (suffix[level] ?? 's');
  } else {
    const suffix = ['', 'k', 'm', 'b', 't'];
    return fmt + (suffix[level] ?? 't');
  }
}

function formatStats(stats: Stats): string {
  const ops  = humanNumber(stats.opsPerSec(), false);
  const pct  = stats.stddev().toFixed(2);
  const mean = humanNumber(stats.mean, true);
  return `${ops} i/s (±${pct}%) (${mean}/i)`;
}

// ---------------------------------------------------------------------------
// Group — a named collection of measurements with optional sub-groups
// ---------------------------------------------------------------------------

/**
 * Options for registering a benchmark measurement with setup and teardown hooks.
 *
 * `setup()` and `teardown()` run outside the measured loop. The value returned
 * by `setup()` is passed to `fn(ctx)` for every timed iteration and then to
 * `teardown(ctx)` once the adaptive one-second sample window completes.
 *
 * ```ts no_run
 * import { bench, type MeasureOptions } from 'fino:test/bench';
 *
 * const opts: MeasureOptions<{ value: string }> = {
 *   setup: () => ({ value: '42' }),
 *   fn: (ctx) => Number(ctx.value),
 *   teardown: () => {},
 * };
 * bench('numbers', (b) => b.measure('Number()', opts));
 * ```
 */
export interface MeasureOptions<T = unknown> {
  /**
   * Prepare state for the measured function.
   *
   * ```ts no_run
   * const setup = () => ({ buffer: new Uint8Array(1024) });
   * ```
   */
  setup?: () => T;
  /**
   * Function measured repeatedly until at least one second of runtime has been sampled.
   *
   * ```ts no_run
   * const fn = (ctx: { value: string }) => Number(ctx.value);
   * ```
   */
  fn: (ctx: T) => unknown;
  /**
   * Clean up state created by `setup()`.
   *
   * ```ts no_run
   * const teardown = (_ctx: { close?: () => void }) => {};
   * ```
   */
  teardown?: (ctx: T) => void;
}

interface PendingMeasurement {
  name: string;
  fn: (ctx?: unknown) => unknown;
  setup: (() => unknown) | undefined;
  teardown: ((ctx?: unknown) => void) | undefined;
  isGroup?: false;
}

interface PendingGroup {
  name: string;
  fn: (g: Group) => void;
  isGroup: true;
}

type PendingSpec = PendingMeasurement | PendingGroup;

/**
 * Benchmark group containing deferred measurements and nested groups.
 *
 * Group instances are passed to `bench()` callbacks and nested `group()`
 * callbacks. Registration is cheap; work runs later when `finalize()` executes.
 *
 * ```ts no_run
 * import { Group } from 'fino:test/bench';
 *
 * const group = new Group('manual');
 * group.measure('noop', () => {});
 * ```
 */
export class Group {
  /**
   * Private property `#name` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #name = undefined;
   *
   *   readInternalState() {
   *     return this.#name;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #name: string;
  /**
   * Private property `#indent` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #indent = undefined;
   *
   *   readInternalState() {
   *     return this.#indent;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #indent: number;
  /**
   * Private property `#filter` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #filter = undefined;
   *
   *   readInternalState() {
   *     return this.#filter;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #filter: string | null;
  /**
   * Private property `#path` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #path = undefined;
   *
   *   readInternalState() {
   *     return this.#path;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #path: string[];
  /**
   * Private property `#measurements` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #measurements = undefined;
   *
   *   readInternalState() {
   *     return this.#measurements;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #measurements: Array<{ name: string; stats: Stats }> = [];
  /**
   * Private property `#pending` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pending = undefined;
   *
   *   readInternalState() {
   *     return this.#pending;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pending: PendingSpec[] = [];

  /**
   * Create a benchmark group.
   *
   * Most application code receives groups from `bench()` rather than calling
   * this constructor directly. `indent`, `filter`, and `path` are used by the
   * runner for nested output and filtered execution.
   *
   * ```ts no_run
   * import { Group } from 'fino:test/bench';
   *
   * const group = new Group('manual', 0, null, ['manual']);
   * ```
   */
  constructor(name: string, indent: number = 0, filter: string | null = null, path: string[] = [name]) {
    this.#name   = name;
    this.#indent = indent;
    this.#filter = filter;
    this.#path = path;
  }

  /**
   * Private method `#pad` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pad() {
   *     return 'pad';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#pad();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pad() {
    return ' '.repeat(this.#indent);
  }

  /**
   * Register a measurement. Execution is deferred until `finalize()`.
   *
   * Accepts either a function or an options object:
   *
   * ```ts no_run
   *   b.measure('name', fn)
   *   b.measure('name', { setup, fn, teardown })
   * ```
   *
   * `fn` may be synchronous or async. If `fn()` returns a thenable, the
   * measurement loop awaits it to completion on every iteration.
   *
   * `setup()` and `teardown()` are synchronous and are not included in timing.
   * The return value of `setup()` is passed as the first argument to `fn(ctx)`.
   *
   * @param {string}            name
   * @param {function|object}   fnOrOpts  Function or `{ setup, fn, teardown }`.
   *
   * ```ts no_run
   * import { bench } from 'fino:test/bench';
   *
   * bench('strings', (b) => {
   *   b.measure('concat', () => { 'a' + 'b'; });
   *   b.measure('with setup', {
   *     setup: () => ['a', 'b'],
   *     fn: (parts) => parts.join(''),
   *   });
   * });
   * ```
   */
  measure<T>(name: string, fnOrOpts: ((ctx?: unknown) => unknown) | MeasureOptions<T>): void {
    if (typeof fnOrOpts === 'function') {
      this.#pending.push({ name, fn: fnOrOpts, setup: undefined, teardown: undefined });
    } else {
      this.#pending.push({
        name,
        fn: fnOrOpts.fn as (ctx?: unknown) => unknown,
        setup: fnOrOpts.setup as (() => unknown) | undefined,
        teardown: fnOrOpts.teardown as ((ctx?: unknown) => void) | undefined,
      });
    }
  }

  /**
   * Add a named sub-group. Registration is deferred until `finalize()`.
   *
   * @param {string}   name
   * @param {function} fn    Receives a Group instance.
   *
   * ```ts no_run
   * import { bench } from 'fino:test/bench';
   *
   * bench('runtime', (b) => {
   *   b.group('numbers', (g) => {
   *     g.measure('parseInt', () => parseInt('42', 10));
   *   });
   * });
   * ```
   */
  group(name: string, fn: (g: Group) => void): void {
    this.#pending.push({ name, fn, isGroup: true });
  }

  /**
   * Execute all pending measurements and sub-groups, then print the
   * comparison. Called by run() after the suite body returns.
   *
   * ```ts no_run
   * import { Group } from 'fino:test/bench';
   *
   * const group = new Group('manual');
   * group.measure('noop', () => {});
   * group.finalize();
   * ```
   */
  async finalize() {
    const pad = this.#pad();
    const selfMatches = this.#matchesSelf();

    for (const spec of this.#pending) {
      if (spec.isGroup) {
        const sub = new Group(spec.name, this.#indent + 2, this.#filter, [...this.#path, spec.name]);
        spec.fn(sub);
        if (!sub.shouldRun()) continue;
        console.log(`${pad}  # ${spec.name}`);
        await sub.finalize();
      } else if (selfMatches) {
        await this.#executeMeasurement(spec);
      }
    }

    this.#compare();
  }

  /**
   * Run a single measurement to completion, collect stats, print the result.
   *
   * For async benchmarks (fn returns a thenable), each iteration awaits it
   * before recording the elapsed time.
   *
   * @param {{ name: string, fn: function, setup?: function, teardown?: function }} spec
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #executeMeasurement() {
   *     return 'executeMeasurement';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#executeMeasurement();
   *   }
   * }
   * ```
   */
  async #executeMeasurement({ name, fn, setup, teardown }: PendingMeasurement) {
    const pad = this.#pad();
    const stats = new Stats();
    const ctx = setup ? setup() : undefined;

    try {
      do {
        const start = now();
        const result = ctx !== undefined ? fn(ctx) : fn();
        if (result !== null && result !== undefined && typeof (result as Record<string, unknown>)['then'] === 'function') {
          await (result as Promise<unknown>);
        }
        const end = now();
        stats.push(end - start);
      } while (stats.total < minDurationNs());
    } finally {
      if (teardown) teardown(ctx);
    }

    console.log(`${pad}${name} - ${formatStats(stats)}`);
    this.#measurements.push({ name, stats });
  }

  /**
   * Print a comparison of all measurements in this group, sorted by ops/sec.
   * Matches benc.h bench_compare().
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #compare() {
   *     return 'compare';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#compare();
   *   }
   * }
   * ```
   */
  #compare() {
    const m = this.#measurements;
    if (m.length < 2) return;

    const sorted = m.slice().sort(
      (a, b) => b.stats.opsPerSec() - a.stats.opsPerSec(),
    );

    const pad = this.#pad();
    console.log(`${pad}Comparing...`);

    const fastest = sorted[0];
    if (fastest === undefined) return;
    const fastestMean = fastest.stats.mean;
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      if (item === undefined) continue;
      const { name, stats } = item;
      if (i === 0) {
        console.log(`${pad}  - ${name} (fastest)`);
      } else {
        const pct = ((stats.mean / fastestMean) * 100 - 100).toFixed(2);
        console.log(`${pad}  - ${name} (${pct}% slower)`);
      }
    }
  }

  /**
   * Private method `#matchesSelf` used by `Group`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #matchesSelf() {
   *     return 'matchesSelf';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#matchesSelf();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #matchesSelf(): boolean {
    if (this.#filter === null) return true;
    return this.#path.join(' ').includes(this.#filter);
  }

  /**
   * Return whether this group has measurements matching the active filter.
   *
   * This is mainly used by the runner before printing a group heading. With no
   * filter, every group runs.
   *
   * ```ts no_run
   * import { Group } from 'fino:test/bench';
   *
   * new Group('strings', 0, 'strings').shouldRun(); // true
   * ```
   */
  shouldRun(): boolean {
    if (this.#matchesSelf()) return true;
    for (const spec of this.#pending) {
      if (!spec.isGroup) continue;
      const sub = new Group(spec.name, this.#indent + 2, this.#filter, [...this.#path, spec.name]);
      spec.fn(sub);
      if (sub.shouldRun()) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal suite registry
// ---------------------------------------------------------------------------

const _benches: Array<{ name: string; fn: (g: Group) => void }> = [];

/**
 * Clear the process-local benchmark registry.
 *
 * This is an internal test helper for unit tests that need to exercise
 * `run()` with isolated benchmark registrations. Application code should not
 * call it; normal benchmark files register once and then run in process order.
 *
 * ```ts no_run
 * import { _resetBenchmarksForTest } from 'fino:test/bench';
 * _resetBenchmarksForTest();
 * ```
 *
 * @internal
 */
export function _resetBenchmarksForTest(): void {
  _benches.length = 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a benchmark suite.
 *
 * @param {string}   name  Suite name — printed as a heading.
 * @param {function} fn    Suite body — receives a Group instance `b`.
 *
 * ```ts no_run
 * import { bench } from 'fino:test/bench';
 *
 * bench('strings', (b) => {
 *   b.measure('concat', () => { 'a' + 'b'; });
 * });
 * ```
 */
export function bench(name: string, fn: (b: Group) => void): void {
  _benches.push({ name, fn });
}

/**
 * Run all registered benchmark suites and print results.
 *
 * Prints the benc.h v1.0.0 header, then each suite in registration order.
 *
 * ```ts no_run
 * import { bench, run } from 'fino:test/bench';
 *
 * bench('noop', (b) => b.measure('empty', () => {}));
 * await run({ filter: 'noop' });
 * ```
 */
export async function run(options: { filter?: string } = {}) {
  console.log('benc.h v1.0.0');
  const filter = options.filter ?? null;

  for (const { name, fn } of _benches) {
    const g = new Group(name, 0, filter, [name]);
    fn(g);
    if (!g.shouldRun()) continue;
    console.log(`# ${name}`);
    await g.finalize();
  }
}
