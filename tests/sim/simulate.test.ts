/**
 * Public deterministic simulation harness coverage.
 */
import { describe, it } from 'fino:test/test';
import { Facade } from 'fino:realm';
import { simulate, sweep } from 'fino:sim';

const HARNESS_GUEST = new URL('./fixtures/harness-guest.ts', import.meta.url).pathname;
const EFFECTS_GUEST = new URL('../runtime/fixtures/deterministic-effects.ts', import.meta.url)
  .pathname;
const LATENCY_GUEST = new URL('../runtime/fixtures/facade-latency.ts', import.meta.url).pathname;

describe('simulate()', { exclusive: true }, () => {
  it('runs a deterministic Realm against object providers and journals its calls', async (t) => {
    const values = new Map<string, unknown>();
    const report = await simulate({
      entry: 'tests/sim/fixtures/harness-guest.ts',
      args: ['greeting', 'hello'],
      seed: 'public-harness',
      startTime: 1_234,
      world: {
        'app:kv': {
          get: async (key: unknown) => values.get(String(key)),
          set: async (key: unknown, value: unknown) => {
            values.set(String(key), value);
          },
        },
      },
    });

    t.equal(report.result, 'hello');
    t.equal(report.seed, 'public-harness');
    t.equal(report.startTime, 1_234);
    t.deepEqual(
      report.journal.calls('app:kv').map(({ method, args, result }) => ({
        method,
        args,
        result,
      })),
      [
        { method: 'set', args: ['greeting', 'hello'], result: undefined },
        { method: 'get', args: ['greeting'], result: 'hello' },
      ],
    );
  });

  it('records and replays transport traffic without calling live providers', async (t) => {
    const recordedValues = new Map<string, unknown>();
    const recorded = await simulate({
      entry: HARNESS_GUEST,
      args: ['answer', 42],
      world: {
        'app:kv': {
          get: async (key: unknown) => recordedValues.get(String(key)),
          set: async (key: unknown, value: unknown) => {
            recordedValues.set(String(key), value);
          },
        },
      },
      cassette: { mode: 'record' },
    });

    t.ok(recorded.cassette !== undefined, 'recording returns a cassette');

    let liveCalls = 0;
    const replayed = await simulate({
      entry: HARNESS_GUEST,
      args: ['answer', 42],
      world: {
        'app:kv': {
          get: async () => {
            liveCalls++;
            return 'wrong';
          },
          set: async () => {
            liveCalls++;
          },
        },
      },
      cassette: { mode: 'replay', data: recorded.cassette! },
    });

    t.equal(replayed.result, 42, 'replay returns the recorded result');
    t.equal(liveCalls, 0, 'replay claims calls before live Facade handlers');
    t.equal(replayed.journal.calls('app:kv').length, 2, 'replayed calls remain observable');
  });

  it('injects configured faults before live providers run', async (t) => {
    let liveCalls = 0;
    await t.rejects(
      () =>
        simulate({
          entry: HARNESS_GUEST,
          args: ['answer', 42],
          seed: 'fault-seed',
          world: {
            'app:kv': {
              get: async () => {
                liveCalls++;
              },
              set: async () => {
                liveCalls++;
              },
            },
          },
          faults: {
            errorRate: 1,
            only: ['app:kv'],
            message: 'planned failure',
          },
        }),
      /planned failure/,
    );
    t.equal(liveCalls, 0);
  });

  it('charges configured response latency to the guest virtual clock', async (t) => {
    const latency = new Facade('app:latency', [])
      .handle('ping', async () => undefined)
      .stream('tail', async function* () {
        yield 'first';
        yield 'second';
      });
    const report = await simulate({
      entry: LATENCY_GUEST,
      world: { 'app:latency': latency },
      faults: { latency: [25, 25] },
    });
    const result = report.result as {
      elapsed: number;
      order: string[];
      chunkTimes: number[];
    };

    t.equal(result.elapsed, 25);
    t.deepEqual(result.order, ['timer', 'response']);
    t.deepEqual(result.chunkTimes, [25, 50]);
  });
});

describe('sweep()', { exclusive: true }, () => {
  it('runs seeds sequentially and retains each reproducible outcome', async (t) => {
    const outcomes = await sweep({ entry: EFFECTS_GUEST }, ['first', 'second']);

    t.deepEqual(
      outcomes.map(({ seed }) => seed),
      ['first', 'second'],
    );
    t.ok(outcomes.every(({ report }) => report !== undefined));
    t.notEqual(
      (outcomes[0]!.report!.result as { before: { random: number } }).before.random,
      (outcomes[1]!.report!.result as { before: { random: number } }).before.random,
      'different seeds drive different guest randomness',
    );
  });

  it('expands a seed count and collects failures without stopping the sweep', async (t) => {
    const outcomes = await sweep({ entry: '/missing-simulation-entry.ts' }, 2);

    t.deepEqual(
      outcomes.map(({ seed }) => seed),
      [0, 1],
    );
    t.ok(outcomes.every(({ error, report }) => error !== undefined && report === undefined));
  });
});
