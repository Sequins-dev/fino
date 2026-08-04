/**
 * The `simulate()` harness: a facade world, a journal of everything that
 * crossed the boundary.
 */
import { describe, it } from 'fino:test/test';
import { simulate } from 'fino:sim';
const KV_GUEST = new URL('./fixtures/kv-guest.ts', import.meta.url).pathname;
function kvWorld() {
  const store = new Map<string, unknown>();
  return {
    'app:kv': {
      get: async (key: unknown) => store.get(String(key)),
      set: async (key: unknown, value: unknown) => {
        store.set(String(key), value);
        return null;
      },
    },
  };
}
describe('simulate()', () => {
  it('serves the guest from facades and journals every call', async (t) => {
    const report = await simulate({ entry: KV_GUEST, seed: 1, world: kvWorld() });
    t.deepEqual(
      report.result,
      { value: 'hello', leaked: 'blocked' },
      'guest ran against the fake store',
    );
    const calls = report.journal.calls('app:kv');
    t.equal(calls.length, 2, 'both store calls recorded');
    t.equal(calls[0]!.method, 'set', 'set recorded first');
    t.deepEqual(calls[0]!.args, ['greeting', 'hello'], 'arguments captured');
    t.equal(calls[1]!.method, 'get', 'get recorded second');
    t.equal(calls[1]!.result, 'hello', 'result captured');
  });
  it('records a cassette and replays it', async (t) => {
    const recorded = await simulate({
      entry: KV_GUEST,
      seed: 5,
      world: kvWorld(),
      cassette: { mode: 'record' },
    });
    t.ok(recorded.cassette !== undefined, 'cassette produced');
    t.equal(recorded.cassette!.entries.length, 2, 'both calls on the cassette');
    // Replay against a world that would answer differently if it were consulted.
    const replayed = await simulate({
      entry: KV_GUEST,
      seed: 5,
      world: {
        'app:kv': {
          get: async () => 'WRONG',
          set: async () => null,
        },
      },
      cassette: { mode: 'replay', data: recorded.cassette },
    });
    t.deepEqual(replayed.result, recorded.result, 'replay reproduced the recorded run');
  });
  it('a diverging guest fails replay with the offending call named', async (t) => {
    const recorded = await simulate({
      entry: KV_GUEST,
      seed: 5,
      world: kvWorld(),
      cassette: { mode: 'record' },
    });
    const shortened = { ...recorded.cassette!, entries: recorded.cassette!.entries.slice(0, 1) };
    await t.rejects(
      () =>
        simulate({
          entry: KV_GUEST,
          seed: 5,
          world: kvWorld(),
          cassette: { mode: 'replay', data: shortened },
        }),
      /cassette ended|divergence/,
      'divergence is reported',
    );
  });
});
