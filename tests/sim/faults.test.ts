/**
 * Seeded fault injection and seed sweeps.
 */
import { describe, it } from 'fino:test/test';
import { Facade } from 'fino:realm';
import { simulate, sweep } from 'fino:sim';
const RETRY_GUEST = new URL('./fixtures/retry-guest.ts', import.meta.url).pathname;
const STREAM_GUEST = new URL('../realm/fixtures/facade-stream-fn.ts', import.meta.url).pathname;
const SINK_GUEST = new URL('../realm/fixtures/facade-sink-fn.ts', import.meta.url).pathname;
const world = { 'app:api': { fetchRecord: async (id: unknown) => ({ id, ok: true }) } };
describe('fault injection', () => {
  it('injects failures on a seeded schedule that the seed reproduces', async (t) => {
    const first = await simulate({
      entry: RETRY_GUEST,
      seed: 3,
      world,
      faults: { errorRate: 0.5 },
    });
    const second = await simulate({
      entry: RETRY_GUEST,
      seed: 3,
      world,
      faults: { errorRate: 0.5 },
    });
    t.deepEqual(second.result, first.result, 'same seed, same failures');
    t.deepEqual(
      second.journal.entries.map((e) => e.outcome),
      first.journal.entries.map((e) => e.outcome),
      'identical outcome sequence',
    );
  });
  it('never failing and always failing are both reachable', async (t) => {
    const never = await simulate({ entry: RETRY_GUEST, seed: 1, world, faults: { errorRate: 0 } });
    t.deepEqual(never.result, { attempts: 1, value: { id: 'r-1', ok: true } }, 'no faults');
    await t.rejects(
      () => simulate({ entry: RETRY_GUEST, seed: 1, world, faults: { errorRate: 1 } }),
      /injected fault/,
      'every attempt failed and the guest gave up',
    );
  });
  it('a sweep finds the seeds a flaky dependency breaks', async (t) => {
    const outcomes = await sweep({ entry: RETRY_GUEST, world, faults: { errorRate: 0.6 } }, 12);
    t.equal(outcomes.length, 12, 'every seed ran');
    const failed = outcomes.filter((o) => o.error !== undefined);
    const passed = outcomes.filter((o) => o.report !== undefined);
    t.ok(passed.length > 0, `some seeds survive (${passed.length}/12)`);
    t.ok(failed.length > 0, `some seeds exhaust the retries (${failed.length}/12)`);
    // A failing seed is a complete reproduction on its own.
    const seed = failed[0]!.seed;
    await t.rejects(
      () => simulate({ entry: RETRY_GUEST, seed, world, faults: { errorRate: 0.6 } }),
      /injected fault/,
      `seed ${String(seed)} reproduces the failure by itself`,
    );
  });
  it('injects read-stream and sink failures at the channel boundary', async (t) => {
    const stream = new Facade('fino:test-facade', []).stream('chunks', async function* () {
      yield 'unreachable';
    });
    const sink = new Facade('fino:test-facade', []).sendStream('writeChunks', async () => 0);
    for (const [entry, provider] of [
      [STREAM_GUEST, stream],
      [SINK_GUEST, sink],
    ] as const) {
      await t.rejects(
        () =>
          simulate({
            entry,
            world: { 'fino:test-facade': provider },
            faults: { errorRate: 1, message: 'channel fault' },
          }),
        /channel fault/,
        `${entry === STREAM_GUEST ? 'stream' : 'sink'} request was intercepted`,
      );
    }
  });
});
