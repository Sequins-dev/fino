import { describe, it } from 'fino:test/test';
import benchConsole from 'internal:globals/console';
import { env } from 'internal:process';
import { Group, bench, run, _resetBenchmarksForTest } from 'fino:bench';
import * as benchModule from 'fino:bench';

async function withBenchMinNs<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = env.FINO_BENCH_MIN_NS;
  env.FINO_BENCH_MIN_NS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete env.FINO_BENCH_MIN_NS;
    } else {
      env.FINO_BENCH_MIN_NS = previous;
    }
  }
}

async function captureBenchLogs(fn: () => Promise<void>): Promise<string[]> {
  const target = benchConsole as unknown as { log(...args: unknown[]): void };
  const original = target.log;
  const logs: string[] = [];
  target.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    target.log = original;
  }
  return logs;
}

describe('bench Group', () => {
  it('awaits async measurements and runs setup/teardown outside the measured body', async (t) => {
    const events: string[] = [];
    const group = new Group('unit');

    group.measure('async measure', {
      setup() {
        events.push('setup');
        return { calls: 0 };
      },
      async fn(ctx) {
        if (ctx.calls === 0) events.push('fn');
        ctx.calls++;
        await Promise.resolve();
      },
      teardown(ctx) {
        events.push('teardown:' + ctx.calls);
      },
    });

    const logs = await withBenchMinNs('1000', () => captureBenchLogs(() => group.finalize()));

    t.deepEqual(events.slice(0, 2), ['setup', 'fn'], 'setup runs before the measured body');
    t.ok(events[2]?.startsWith('teardown:'), 'teardown runs after measurement');
    t.ok(logs.some((line) => line.includes('async measure - ')), 'measurement result is printed after async body settles');
  });

  it('filters nested groups without running unmatched parent measurements', async (t) => {
    const events: string[] = [];
    const group = new Group('top', 0, 'needle', ['top']);

    group.measure('top measure', () => events.push('top'));
    group.group('other child', (child) => {
      child.measure('other measure', () => events.push('other'));
    });
    group.group('needle child', (child) => {
      child.measure('needle measure', () => events.push('needle'));
    });

    const logs = await withBenchMinNs('1000', () => captureBenchLogs(() => group.finalize()));

    t.deepEqual(events, ['needle'], 'only the matching nested measurement runs');
    t.ok(logs.some((line) => line.includes('# needle child')), 'matching nested group heading is printed');
    t.ok(!logs.some((line) => line.includes('top measure - ')), 'unmatched parent measurement is omitted');
  });

  it('runs teardown when a measurement throws', async (t) => {
    const events: string[] = [];
    const group = new Group('failing');

    group.measure('throws measure', {
      setup() {
        events.push('setup');
        return 'ctx';
      },
      fn() {
        events.push('fn');
        throw new Error('measured failure');
      },
      teardown(ctx) {
        events.push('teardown:' + ctx);
      },
    });

    await t.rejects(() => withBenchMinNs('1000', () => captureBenchLogs(() => group.finalize())), /measured failure/, 'measurement failure rejects finalize');
    t.deepEqual(events, ['setup', 'fn', 'teardown:ctx'], 'teardown runs after a thrown measurement');
  });
});

describe('bench run()', () => {
  it('runs registered suites and applies top-level and nested filtering', async (t) => {
    _resetBenchmarksForTest();
    const events: string[] = [];

    bench('alpha suite', (b) => {
      b.measure('alpha measure', () => events.push('alpha'));
    });
    bench('beta suite', (b) => {
      b.measure('beta measure', () => events.push('beta'));
      b.group('needle group', (g) => {
        g.measure('needle measure', () => events.push('needle'));
      });
    });

    const logs = await withBenchMinNs('1000', () => captureBenchLogs(() => run({ filter: 'needle' })));
    _resetBenchmarksForTest();

    t.deepEqual(events, ['needle'], 'only the nested matching benchmark runs');
    t.equal(logs[0], 'benc.h v1.0.0', 'run prints the benchmark header');
    t.ok(!logs.some((line) => line.includes('# alpha suite')), 'unmatched top-level suite is omitted');
    t.ok(logs.some((line) => line.includes('# beta suite')), 'ancestor of matching nested group is printed');
    t.ok(logs.some((line) => line.includes('# needle group')), 'matching nested group is printed');
  });

  it('resets the registry through the internal test helper', async (t) => {
    _resetBenchmarksForTest();
    bench('empty suite', (b) => b.measure('empty measure', () => {}));
    _resetBenchmarksForTest();

    const logs = await withBenchMinNs('1000', () => captureBenchLogs(() => run()));

    t.deepEqual(logs, ['benc.h v1.0.0'], 'reset helper leaves no registered suites to run');
  });

  it('keeps the release output human-readable and non-machine-readable', async (t) => {
    _resetBenchmarksForTest();
    bench('release suite', (b) => {
      b.measure('first measure', () => {});
      b.measure('second measure', () => {});
    });

    let result: unknown;
    const logs = await withBenchMinNs('1000', () => captureBenchLogs(async () => {
      result = await run();
    }));
    _resetBenchmarksForTest();

    t.equal(result, undefined, 'run() does not return structured benchmark data');
    t.equal(logs[0], 'benc.h v1.0.0', 'output starts with benc.h-compatible header');
    t.ok(logs.includes('# release suite'), 'suite heading is printed as human text');
    t.ok(logs.some((line) => /^first measure - .+ i\/s /.test(line)), 'measurement line is human-formatted');
    t.ok(logs.some((line) => line === 'Comparing...'), 'multi-measure groups print comparison text');
    t.ok(!logs.some((line) => line.trim().startsWith('{') || line.trim().startsWith('[')), 'runner does not emit JSON lines');
  });

  it('does not expose public benchmark tuning or reporter APIs', (t) => {
    const exported = benchModule as Record<string, unknown>;

    for (const name of [
      'warmup',
      'setWarmup',
      'fixedIterations',
      'samples',
      'varianceThreshold',
      'json',
      'reporter',
      'setReporter',
    ]) {
      t.equal(exported[name], undefined, `${name} is not a public bench API`);
    }
  });
});
