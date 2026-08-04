/**
 * Virtual latency: facade responses are held for simulated milliseconds, so a
 * round trip has a cost the guest can observe without any real time passing.
 */
import { describe, it } from 'fino:test/test';
import { simulate } from 'fino:sim';
const LATENCY_GUEST = new URL('./fixtures/latency-guest.ts', import.meta.url).pathname;
const world = {
  'app:api': {
    ping: async () => 'pong',
    tail: async function* () {
      yield 'a';
      yield 'b';
      yield 'c';
    },
  },
};
describe('virtual latency', () => {
  it('charges a fixed delay to the virtual clock, not the real one', async (t) => {
    const startedAt = Date.now();
    const report = await simulate({
      entry: LATENCY_GUEST,
      seed: 1,
      world,
      faults: { latency: [200, 200] },
    });
    const { elapsed, chunks, chunkTimes } = report.result as {
      elapsed: number[];
      chunks: string[];
      chunkTimes: number[];
    };
    t.deepEqual(elapsed, [200, 200, 200], 'every round trip cost exactly 200 virtual ms');
    t.ok(Date.now() - startedAt < 5_000, 'but almost no real time passed');
    t.deepEqual(chunks, ['a', 'b', 'c'], 'stream chunks arrive in order');
    t.ok(
      chunkTimes.every((ms) => ms >= 200),
      `every chunk paid at least the configured latency: ${chunkTimes.join(', ')}`,
    );
  });
  it('lets a timer scheduled before a slow call fire first', async (t) => {
    const report = await simulate({
      entry: LATENCY_GUEST,
      seed: 1,
      world,
      faults: { latency: [100, 100] },
    });
    const { order } = report.result as { order: string[] };
    t.deepEqual(order, ['timer-50', 'response'], 'the 50ms timer beat the 100ms response');
  });
  it('an instant world delivers the response first', async (t) => {
    const report = await simulate({ entry: LATENCY_GUEST, seed: 1, world });
    const { elapsed, order } = report.result as { elapsed: number[]; order: string[] };
    t.deepEqual(elapsed, [0, 0, 0], 'no latency without a fault config');
    t.deepEqual(order, ['response', 'timer-50'], 'an instant reply beats the timer');
  });
  it('a latency range is seeded and reproducible', async (t) => {
    const first = await simulate({
      entry: LATENCY_GUEST,
      seed: 7,
      world,
      faults: { latency: [10, 500] },
    });
    const second = await simulate({
      entry: LATENCY_GUEST,
      seed: 7,
      world,
      faults: { latency: [10, 500] },
    });
    const a = (first.result as { elapsed: number[] }).elapsed;
    const b = (second.result as { elapsed: number[] }).elapsed;
    t.deepEqual(b, a, `same seed, same delays: ${a.join(', ')}`);
    t.deepEqual(
      (second.result as { chunkTimes: number[] }).chunkTimes,
      (first.result as { chunkTimes: number[] }).chunkTimes,
      'chunk delays reproduce with the seed too',
    );
    t.ok(
      a.every((ms) => ms >= 10 && ms <= 500),
      'delays fall inside the configured range',
    );
    t.ok(new Set(a).size > 1, 'the range actually varies');
  });
});
