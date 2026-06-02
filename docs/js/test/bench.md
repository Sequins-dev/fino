# js/test/bench

fino:bench — benchmark suite, a JS port of benc.h.

Mirrors the structure of `fino:test`: register suites with `bench()`,
then call `run()` to execute them all and print results. Each suite
receives a `Group` object for registering measurements and nested
sub-groups. Output format matches benc.h v1.0.0 so results are comparable
with C benchmarks.

Benchmark functions may be **synchronous or async**. Async benchmarks are
detected automatically: if `fn()` returns a thenable, the measurement loop
spins the global event loop synchronously to completion on every iteration:

```js
import { DiskFileSystem } from '../file/fs.mts';

bench('file I/O', (b) => {
  b.measure('readFile', async () => {
    const fs = new DiskFileSystem();
    await fs.readFile('/etc/hosts');
  });
});
```

Setup and teardown can be separated from the measured body using object form.
The `setup()` return value is passed to each `fn(ctx)` invocation; neither
`setup()` nor `teardown()` is included in the timing:

```js
b.measure('name', {
  setup()    { return createResources(); },
  fn(ctx)    { return doWork(ctx); },
  teardown() { cleanup(); },
});
```

## High-resolution timer (now())

The timer is platform-specific:

- **macOS**: `mach_continuous_time()` returns ticks in a hardware-defined
  unit. The conversion ratio is fetched once via `mach_timebase_info()`,
  which fills a `{ uint32_t numer; uint32_t denom; }` struct. The tick
  count is multiplied by `numer/denom` to get nanoseconds. On Apple Silicon
  the ratio is 1/1 (ticks are already nanoseconds); on Intel Macs it is
  a small rational number. `mach_continuous_time()` is preferred over
  `mach_absolute_time()` because it continues advancing while the system
  is asleep, giving consistent wall-clock readings.

- **Linux**: `clock_gettime(CLOCK_MONOTONIC, &ts)` returns a `struct timespec
  { time_t tv_sec; long tv_nsec; }`. We allocate a 16-byte buffer (large
  enough for 64-bit `time_t` on LP64), read both fields as `BigInt64` (to
  handle the full 64-bit range), and convert to nanoseconds.

## Welford's online algorithm (Stats class)

Rather than collecting all sample values and computing stats at the end,
the `Stats` class uses Welford's online algorithm to compute mean and
variance in a single pass with O(1) memory. Each call to `stats.push(x)`:

  1. Increments the count.
  2. Computes a new mean: `mean' = mean + (x - mean) / count`
  3. Updates the sum of squared deviations:
     `dSquared' = dSquared + (x - mean') * (x - mean)`

Population variance is `dSquared / count`. Standard deviation is the
square root of variance. This matches the benc.h implementation exactly
(which uses the same recurrence).

## Measurement loop

`group.measure(name, fn)` defers registration until `finalize()`. When
executed, it runs `fn()` repeatedly until at least 1 second of wall time
has elapsed (measured by accumulating `now()` deltas in `stats.total`).
This adaptive approach ensures that fast functions get many samples (better
statistics) and slow functions get at least one full second of coverage.

For async benchmarks, each iteration spins the global event loop
synchronously via `loop.spin()`.

## Comparison output

After all measurements in a group complete, `#compare()` sorts them by
ops/sec (descending), prints the fastest as a baseline, and prints each
slower measurement as a percentage overhead relative to the fastest's mean
nanoseconds per iteration. This matches benc.h's `bench_compare()`.

## Output format

  benc.h v1.0.0
  # string ops
  concat   - 26.92m i/s (±49.87%) (34.11ns/i)
  template - 3.53m i/s (±165.47%) (278.89ns/i)
  Comparing...
    - concat (fastest)
    - template (663.07% slower)

```ts
import { bench } from './bench.mts';

bench('string ops', (b) => {
  b.measure('concat',   () => { 'hello' + ' world'; });
  b.measure('template', () => { `hello ${' world'}`; });
});

bench('with sub-groups', (b) => {
  b.group('parsing', (g) => {
    g.measure('parseInt', () => { parseInt('42', 10); });
    g.measure('Number()', () => { Number('42'); });
  });
});
```

## MeasureOptions

```ts
interface MeasureOptions<T = unknown> {
```

Options for registering a benchmark measurement with setup and teardown hooks.

`setup()` and `teardown()` run outside the measured loop. The value returned
by `setup()` is passed to `fn(ctx)` for every timed iteration and then to
`teardown(ctx)` once the adaptive one-second sample window completes.

```ts
import { bench, type MeasureOptions } from 'fino:test/bench';

const opts: MeasureOptions<{ value: string }> = {
  setup: () => ({ value: '42' }),
  fn: (ctx) => Number(ctx.value),
  teardown: () => {},
};
bench('numbers', (b) => b.measure('Number()', opts));
```

### setup

```ts
setup?: () => T
```

Prepare state for the measured function.

```ts
const setup = () => ({ buffer: new Uint8Array(1024) });
```

### fn

```ts
fn: (ctx: T) => unknown
```

Function measured repeatedly until at least one second of runtime has been sampled.

```ts
const fn = (ctx: { value: string }) => Number(ctx.value);
```

### teardown

```ts
teardown?: (ctx: T) => void
```

Clean up state created by `setup()`.

```ts
const teardown = (_ctx: { close?: () => void }) => {};
```

## Group

```ts
class Group {
```

Benchmark group containing deferred measurements and nested groups.

Group instances are passed to `bench()` callbacks and nested `group()`
callbacks. Registration is cheap; work runs later when `finalize()` executes.

```ts
import { Group } from 'fino:test/bench';

const group = new Group('manual');
group.measure('noop', () => {});
```

### constructor

```ts
constructor(name: string, indent: number = 0, filter: string | null = null, path: string[] = [name])
```

Create a benchmark group.

Most application code receives groups from `bench()` rather than calling
this constructor directly. `indent`, `filter`, and `path` are used by the
runner for nested output and filtered execution.

```ts
import { Group } from 'fino:test/bench';

const group = new Group('manual', 0, null, ['manual']);
```

### measure

```ts
measure<T>(name: string, fnOrOpts: ((ctx?: unknown) => unknown) | MeasureOptions<T>): void
```

Register a measurement. Execution is deferred until `finalize()`.

Accepts either a function or an options object:

```ts
b.measure('name', fn)
b.measure('name', { setup, fn, teardown })
```

`fn` may be synchronous or async. If `fn()` returns a thenable, the
measurement loop spins the global event loop to completion on every
iteration.

`setup()` and `teardown()` are synchronous and are not included in timing.
The return value of `setup()` is passed as the first argument to `fn(ctx)`.

```ts
import { bench } from 'fino:test/bench';

bench('strings', (b) => {
  b.measure('concat', () => { 'a' + 'b'; });
  b.measure('with setup', {
    setup: () => ['a', 'b'],
    fn: (parts) => parts.join(''),
  });
});
```

### group

```ts
group(name: string, fn: (g: Group) => void): void
```

Add a named sub-group. Registration is deferred until `finalize()`.

```ts
import { bench } from 'fino:test/bench';

bench('runtime', (b) => {
  b.group('numbers', (g) => {
    g.measure('parseInt', () => parseInt('42', 10));
  });
});
```

### finalize

```ts
finalize()
```

Execute all pending measurements and sub-groups, then print the
comparison. Called by run() after the suite body returns.

```ts
import { Group } from 'fino:test/bench';

const group = new Group('manual');
group.measure('noop', () => {});
group.finalize();
```

### shouldRun

```ts
shouldRun(): boolean
```

Return whether this group has measurements matching the active filter.

This is mainly used by the runner before printing a group heading. With no
filter, every group runs.

```ts
import { Group } from 'fino:test/bench';

new Group('strings', 0, 'strings').shouldRun(); // true
```

## bench

```ts
function bench(name: string, fn: (b: Group) => void): void
```

Register a benchmark suite.

```ts
import { bench } from 'fino:test/bench';

bench('strings', (b) => {
  b.measure('concat', () => { 'a' + 'b'; });
});
```

## run

```ts
async function run(options: { filter?: string } = {})
```

Run all registered benchmark suites and print results.

Prints the benc.h v1.0.0 header, then each suite in registration order.

```ts
import { bench, run } from 'fino:test/bench';

bench('noop', (b) => b.measure('empty', () => {}));
await run({ filter: 'noop' });
```
