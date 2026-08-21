/**
 * The `simulate()` harness: a facade world, a journal of everything that
 * crossed the boundary.
 */
import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { mockFacade, SimJournal, simulate } from 'fino:sim';
const KV_GUEST = new URL('./fixtures/kv-guest.ts', import.meta.url).pathname;
const SESSION_GUEST = new URL('./fixtures/session-traffic-guest.ts', import.meta.url).pathname;
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
function sessionFacade(): Facade {
  return new Facade('app:session', ['slow', 'fast', 'mutate'])
    .handle('slow', async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    })
    .handle('fast', async (value) => value)
    .handle('mutate', async (value) => {
      (value as { state: string }).state = 'after';
      return null;
    })
    .stream('chunks', async function* () {
      yield 'alpha';
      yield { beta: 2 };
    })
    .sendStream('upload', async (_args, source) => {
      const chunks: unknown[] = [];
      for await (const chunk of source) chunks.push(chunk);
      return chunks.length;
    });
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
    const wrongArgs = {
      ...recorded.cassette!,
      entries: recorded.cassette!.entries.map((entry, index, entries) =>
        index === 0 ? { ...entry, args: entries[1]!.args } : entry,
      ),
    };
    await t.rejects(
      () =>
        simulate({
          entry: KV_GUEST,
          seed: 5,
          world: kvWorld(),
          cassette: { mode: 'replay', data: wrongArgs },
        }),
      /arguments.*differ/,
      'argument divergence is reported before replaying a response',
    );
  });
  it('projects ordered scalar and stream traffic from the realm session', async (t) => {
    const report = await simulate({
      entry: SESSION_GUEST,
      world: { 'app:session': sessionFacade() },
      cassette: { mode: 'record' },
    });
    const calls = report.journal.calls('app:session');
    t.deepEqual(
      calls.map(({ method, kind }) => [method, kind]),
      [
        ['slow', 'call'],
        ['fast', 'call'],
        ['mutate', 'call'],
        ['chunks', 'stream'],
        ['upload', 'sink'],
      ],
      'journal follows invocation order rather than completion order',
    );
    t.deepEqual(calls[2]!.args, [{ state: 'before' }], 'arguments are snapshots at the boundary');
    t.deepEqual(calls[3]!.chunks, ['alpha', { beta: 2 }], 'read chunks are projected');
    t.deepEqual(calls[4]!.chunks, ['one', { two: 2 }], 'sink chunks are projected');
    t.equal(calls[4]!.result, 2, 'sink result is correlated with its chunks');
    t.ok(report.cassette!.entries[4]!.chunks !== undefined, 'cassette stores sink chunks');

    const replayed = await simulate({
      entry: SESSION_GUEST,
      world: { 'app:session': sessionFacade() },
      cassette: { mode: 'replay', data: report.cassette },
    });
    t.deepEqual(replayed.result, report.result, 'scalar and stream traffic replays together');

    const wrongChunks = {
      ...report.cassette!,
      entries: report.cassette!.entries.map((entry, index, entries) =>
        index === 4 ? { ...entry, chunks: entries[3]!.value } : entry,
      ),
    };
    await t.rejects(
      () =>
        simulate({
          entry: SESSION_GUEST,
          world: { 'app:session': sessionFacade() },
          cassette: { mode: 'replay', data: wrongChunks },
        }),
      /sink chunks.*differ/,
      'sink chunk divergence is reported',
    );
  });

  it('mockFacade records through the port session when bound directly', async (t) => {
    const journal = new SimJournal();
    const facade = mockFacade('app:kv', kvWorld()['app:kv'], journal);
    const realm = new Realm({
      entry: KV_GUEST,
      overrides: ImportMap.deny([
        { pattern: 'internal:runtime/loop', directive: 'inherit' },
        { pattern: 'app:kv', directive: facade },
      ]),
    });

    await realm.call();

    t.deepEqual(
      journal.calls('app:kv').map((call) => call.method),
      ['set', 'get'],
      'standalone facade uses the shared session recorder',
    );
  });
});
