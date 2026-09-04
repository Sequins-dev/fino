import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { EnvelopeKind } from 'internal:realm/envelope';
import { serialize } from 'internal:serializer';
import { CassetteReplay, SimJournal } from 'internal:sim/journal';
import type cassetteTraffic from './fixtures/cassette-traffic.ts';
import type cassetteShort from './fixtures/cassette-short.ts';

function cassetteFacade(onCall: () => void, suffix: string): Facade {
  return new Facade('app:cassette', [])
    .handle('fast', async (value) => {
      onCall();
      return { value, suffix };
    })
    .stream('chunks', async function* (prefix) {
      onCall();
      yield `${String(prefix)}:one:${suffix}`;
      yield { suffix };
    })
    .sendStream('upload', async (args, source) => {
      onCall();
      const chunks: unknown[] = [];
      for await (const chunk of source) chunks.push(chunk);
      return { args, chunks, suffix };
    });
}

function createRealm<T extends (...args: never[]) => unknown>(
  facade: Facade,
  fixture = 'cassette-traffic.ts',
): Realm<T> {
  return new Realm<T>({
    entry: new URL(`./fixtures/${fixture}`, import.meta.url).pathname,
    overrides: ImportMap.deny([
      { pattern: 'internal:runtime/loop', directive: 'inherit' },
      { pattern: 'app:cassette', directive: facade },
    ]),
  });
}

function encoded(value: unknown): string[] {
  return serialize(value).map((part) => {
    let binary = '';
    for (const byte of part) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

describe('CassetteReplay', () => {
  it('rejects frame sequences that could leave a guest request unsettled', (t) => {
    const request = {
      direction: 'inbound',
      kind: EnvelopeKind.RpcRequest,
      correlation: 4,
      parts: encoded({ specifier: 'app:cassette', method: 'fast', args: [] }),
    };
    const response = {
      direction: 'outbound',
      kind: EnvelopeKind.RpcResponse,
      correlation: 4,
      parts: encoded({ result: 'orphaned' }),
    };

    t.throws(
      () => new CassetteReplay({ version: 1, frames: [request] }),
      /incomplete.*frame 0/i,
      'an incomplete request is rejected before it can hang the guest',
    );
    t.throws(
      () => new CassetteReplay({ version: 1, frames: [response] }),
      /output.*matching request/i,
      'an orphaned response is rejected before binding',
    );
  });

  it('owns exactly one Realm transport binding', (t) => {
    using realm = createRealm<typeof cassetteShort>(
      cassetteFacade(() => {}, 'unused'),
      'cassette-short.ts',
    );
    const replay = new CassetteReplay({ version: 1, frames: [] });
    const stopReplay = replay.bind(realm.port);

    t.throws(
      () => replay.bind(realm.port),
      /already bound/i,
      'one cassette cursor cannot drive two dispatch bindings',
    );
    stopReplay();
  });

  it('replays scalar, read-stream, and sink frames without invoking live handlers', async (t) => {
    let recordedCalls = 0;
    using recordedRealm = createRealm<typeof cassetteTraffic>(
      cassetteFacade(() => recordedCalls++, 'recorded'),
    );
    const journal = new SimJournal();
    const stopRecording = journal.record(recordedRealm.port);
    const recorded = await recordedRealm.call();
    stopRecording();
    t.equal(recordedCalls, 3, 'the recording exercised each live handler');

    let replayedCalls = 0;
    using replayRealm = createRealm<typeof cassetteTraffic>(
      cassetteFacade(() => replayedCalls++, 'live'),
    );
    const replay = new CassetteReplay(JSON.parse(JSON.stringify(journal.toCassette())));
    const stopReplay = replay.bind(replayRealm.port);
    const result = await replayRealm.call();
    replay.assertComplete();
    stopReplay();

    t.deepEqual(result, recorded, 'the guest receives the recorded results and chunks');
    t.equal(replayedCalls, 0, 'replay claims traffic before the live Facade dispatcher');
  });

  it('maps recorded correlations onto the live request identifiers', async (t) => {
    using recordedRealm = createRealm<typeof cassetteTraffic>(cassetteFacade(() => {}, 'saved'));
    const journal = new SimJournal();
    const stopRecording = journal.record(recordedRealm.port);
    const recorded = await recordedRealm.call();
    stopRecording();
    const cassette = journal.toCassette();
    for (const frame of cassette.frames) frame.correlation += 100;

    using replayRealm = createRealm<typeof cassetteTraffic>(cassetteFacade(() => {}, 'unused'));
    const replay = new CassetteReplay(cassette);
    const stopReplay = replay.bind(replayRealm.port);
    const result = await replayRealm.call();
    replay.assertComplete();
    stopReplay();

    t.deepEqual(result, recorded, 'responses use the corresponding live request identifiers');
  });

  it('rejects changed request data before a live handler can observe it', async (t) => {
    using recordedRealm = createRealm<typeof cassetteTraffic>(cassetteFacade(() => {}, 'saved'));
    const journal = new SimJournal();
    const stopRecording = journal.record(recordedRealm.port);
    await recordedRealm.call('recorded');
    stopRecording();

    let liveCalls = 0;
    using replayRealm = createRealm<typeof cassetteTraffic>(
      cassetteFacade(() => liveCalls++, 'live'),
    );
    const replay = new CassetteReplay(journal.toCassette());
    const stopReplay = replay.bind(replayRealm.port);
    await t.rejects(
      () => replayRealm.call('changed'),
      /simulation cassette diverged at frame 0/i,
      'the guest receives a terminal divergence error instead of hanging',
    );
    t.throws(
      () => replay.assertComplete(),
      /expected app:cassette\.fast but received app:cassette\.fast/i,
      'the parent retains the exact divergence for the simulation report',
    );
    stopReplay();
    t.equal(liveCalls, 0, 'mismatched traffic is never forwarded to the live Facade');
  });

  it('reports recorded traffic left unused by an early guest return', async (t) => {
    using recordedRealm = createRealm<typeof cassetteTraffic>(cassetteFacade(() => {}, 'saved'));
    const journal = new SimJournal();
    const stopRecording = journal.record(recordedRealm.port);
    await recordedRealm.call();
    stopRecording();

    using replayRealm = createRealm<typeof cassetteShort>(
      cassetteFacade(() => {}, 'unused'),
      'cassette-short.ts',
    );
    const replay = new CassetteReplay(journal.toCassette());
    const stopReplay = replay.bind(replayRealm.port);
    await replayRealm.call();
    t.throws(
      () => replay.assertComplete(),
      /guest did not send recorded app:cassette\.chunks/i,
      'completion requires every recorded request and response',
    );
    stopReplay();
  });

  it('rejects calls after the cassette has ended', async (t) => {
    using recordedRealm = createRealm<typeof cassetteShort>(
      cassetteFacade(() => {}, 'saved'),
      'cassette-short.ts',
    );
    const journal = new SimJournal();
    const stopRecording = journal.record(recordedRealm.port);
    await recordedRealm.call();
    stopRecording();

    let liveCalls = 0;
    using replayRealm = createRealm<typeof cassetteTraffic>(
      cassetteFacade(() => liveCalls++, 'live'),
    );
    const replay = new CassetteReplay(journal.toCassette());
    const stopReplay = replay.bind(replayRealm.port);
    await t.rejects(
      () => replayRealm.call(),
      /cassette ended before app:cassette\.chunks/i,
      'an extra streaming call receives the correct stream error',
    );
    t.throws(() => replay.assertComplete(), /cassette ended before app:cassette\.chunks/i);
    stopReplay();
    t.equal(liveCalls, 0, 'extra traffic remains isolated from live handlers');
  });
});
