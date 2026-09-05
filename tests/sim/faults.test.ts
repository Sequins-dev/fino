import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { createSeededRandom } from 'internal:runtime/random';
import { bindRpcFaults } from 'internal:sim/faults';
import { SimJournal } from 'internal:sim/journal';

const SCALAR_ENTRY = new URL('./fixtures/cassette-short.ts', import.meta.url).pathname;
const STREAM_ENTRY = new URL('../realm/fixtures/facade-stream-fn.ts', import.meta.url).pathname;
const SINK_ENTRY = new URL('../realm/fixtures/facade-sink-fn.ts', import.meta.url).pathname;

function realmFor(
  entry: string,
  specifier: string,
  facade: Facade,
): Realm<(...args: never[]) => unknown> {
  return new Realm({
    entry,
    overrides: ImportMap.deny([
      { pattern: 'internal:runtime/loop', directive: 'inherit' },
      { pattern: specifier, directive: facade },
    ]),
  });
}

describe('simulation RPC faults', () => {
  it('claims selected scalar calls before the live Facade handler', async (t) => {
    let calls = 0;
    const facade = new Facade('app:cassette', []).handle('fast', async () => {
      calls++;
      return 'live';
    });
    using realm = realmFor(SCALAR_ENTRY, 'app:cassette', facade);
    const journal = new SimJournal();
    const stopRecording = journal.record(realm.port);
    bindRpcFaults(realm.port, createSeededRandom(1), {
      errorRate: 1,
      specifiers: new Set(['app:cassette']),
      message: 'injected scalar failure',
    });

    await t.rejects(() => realm.call(), /injected scalar failure/);
    stopRecording();
    t.equal(calls, 0, 'the claimed call never reaches the live handler');
    t.equal(journal.entries[0]?.outcome, 'error', 'the injected response is ordinary journal data');
    t.equal(journal.entries[0]?.error, 'injected scalar failure');
  });

  it('leaves calls outside the selected schedule on ordinary dispatch', async (t) => {
    let calls = 0;
    const facade = new Facade('app:cassette', []).handle('fast', async () => {
      calls++;
      return 'live';
    });
    using realm = realmFor(SCALAR_ENTRY, 'app:cassette', facade);
    bindRpcFaults(realm.port, createSeededRandom(1), {
      errorRate: 1,
      specifiers: new Set(['app:other']),
    });

    t.equal(await realm.call(), 'live');
    t.equal(calls, 1, 'the live handler owns an unclaimed call');
  });

  it('uses the correct terminal error for read streams and sinks', async (t) => {
    const cases = [
      {
        entry: STREAM_ENTRY,
        facade: new Facade('fino:test-facade', []).stream('chunks', async function* () {
          yield 'live';
        }),
      },
      {
        entry: SINK_ENTRY,
        facade: new Facade('fino:test-facade', []).sendStream('writeChunks', async () => 'live'),
      },
    ];

    for (const { entry, facade } of cases) {
      using realm = realmFor(entry, 'fino:test-facade', facade);
      bindRpcFaults(realm.port, createSeededRandom(2), {
        errorRate: 1,
        message: 'injected channel failure',
      });
      await t.rejects(() => realm.call(), /injected channel failure/);
    }
  });

  it('repeats the same fault schedule for the same seed', async (t) => {
    const run = async (): Promise<string[]> => {
      const outcomes: string[] = [];
      const facade = new Facade('app:cassette', []).handle('fast', async () => 'live');
      using realm = realmFor(SCALAR_ENTRY, 'app:cassette', facade);
      bindRpcFaults(realm.port, createSeededRandom('fault-seed'), { errorRate: 0.5 });
      for (let call = 0; call < 8; call++) {
        try {
          outcomes.push(String(await realm.call()));
        } catch {
          outcomes.push('fault');
        }
      }
      return outcomes;
    };

    const first = await run();
    const second = await run();
    t.deepEqual(second, first);
    t.ok(first.includes('live'), 'the schedule includes successful calls');
    t.ok(first.includes('fault'), 'the schedule includes injected failures');
  });

  it('rejects invalid rates and transport values before binding', (t) => {
    const random = createSeededRandom(1);
    for (const errorRate of [-0.1, 1.1, Number.NaN]) {
      t.throws(() => bindRpcFaults({}, random, { errorRate }), /controllable Realm transport port/);
    }

    const facade = new Facade('app:cassette', []).handle('fast', async () => 'live');
    using realm = realmFor(SCALAR_ENTRY, 'app:cassette', facade);
    for (const errorRate of [-0.1, 1.1, Number.NaN]) {
      t.throws(() => bindRpcFaults(realm.port, random, { errorRate }), /errorRate/);
    }
  });
});
