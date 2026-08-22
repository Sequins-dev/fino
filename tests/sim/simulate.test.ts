/**
 * The `simulate()` harness: a facade world, a journal of everything that
 * crossed the boundary.
 */
import { describe, it } from 'fino:test/test';
import { Facade, FacadeHandle } from 'fino:realm';
import { simulate } from 'fino:sim';
import { EnvelopeKind } from 'internal:realm/envelope';
import { decodeFrame, type Cassette, type CassetteFrame } from 'internal:sim/journal';
const KV_GUEST = new URL('./fixtures/kv-guest.ts', import.meta.url).pathname;
const SESSION_GUEST = new URL('./fixtures/session-traffic-guest.ts', import.meta.url).pathname;
const HANDLE_GUEST = new URL('../realm/fixtures/facade-handle-fn.ts', import.meta.url).pathname;
const DIAGNOSTICS_GUEST = new URL('./fixtures/diagnostics-guest.ts', import.meta.url).pathname;
const NESTED_GUEST = new URL('./fixtures/nested-realm-guest.ts', import.meta.url).pathname;
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
function handleFacade(fail = false): Facade {
  return new Facade('fino:test-facade', ['openHandle']).handle('openHandle', async (key) => {
    if (fail) throw new Error('live handle provider must not run during replay');
    return new FacadeHandle(
      {
        getValue: async () => `value-for-${String(key)}`,
        close: async () => undefined,
      },
      {
        readChunks: async function* (count) {
          for (let index = 0; index < Number(count); index++) yield `chunk-${index}`;
        },
      },
    );
  });
}
function requestFrames(cassette: Cassette): CassetteFrame[] {
  return cassette.frames.filter(
    (frame) =>
      frame.direction === 'inbound' &&
      (frame.kind === EnvelopeKind.RpcRequest ||
        frame.kind === EnvelopeKind.RpcStreamRequest ||
        frame.kind === EnvelopeKind.SinkStart),
  );
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
    t.equal(requestFrames(recorded.cassette!).length, 2, 'both calls are channel frames');
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
    const second = requestFrames(recorded.cassette!)[1]!;
    await t.rejects(
      () =>
        simulate({
          entry: KV_GUEST,
          seed: 5,
          world: kvWorld(),
          cassette: {
            mode: 'replay',
            data: {
              ...recorded.cassette!,
              manifest: { ...recorded.cassette!.manifest, runtime: 'different-runtime' },
            },
          },
        }),
      /manifest differs/,
      'manifest divergence is rejected before guest execution',
    );
    const shortened = {
      ...recorded.cassette!,
      frames: recorded.cassette!.frames.filter(
        (frame) =>
          !(
            frame.correlation === second.correlation &&
            (frame.kind === EnvelopeKind.RpcRequest || frame.kind === EnvelopeKind.RpcResponse)
          ),
      ),
    };
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
    const requests = requestFrames(recorded.cassette!);
    const wrongArgs = {
      ...recorded.cassette!,
      frames: recorded.cassette!.frames.map((frame) =>
        frame === requests[0] ? { ...frame, parts: requests[1]!.parts } : frame,
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
    const extraCall = {
      ...recorded.cassette!,
      frames: [...recorded.cassette!.frames, requests[0]!],
    };
    await t.rejects(
      () =>
        simulate({
          entry: KV_GUEST,
          seed: 5,
          world: kvWorld(),
          cassette: { mode: 'replay', data: extraCall },
        }),
      /did not send/,
      'unused cassette entries are reported after the guest returns',
    );
  });
  it('projects ordered scalar and stream traffic from the realm channel', async (t) => {
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
    t.ok(
      report.cassette!.frames.some((frame) => frame.kind === EnvelopeKind.SinkChunk),
      'cassette stores each sink chunk as a frame',
    );

    const replayed = await simulate({
      entry: SESSION_GUEST,
      world: { 'app:session': sessionFacade() },
      cassette: { mode: 'replay', data: report.cassette },
    });
    t.deepEqual(replayed.result, report.result, 'scalar and stream traffic replays together');

    const sinkChunk = report.cassette!.frames.find(
      (frame) => frame.kind === EnvelopeKind.SinkChunk,
    )!;
    const readChunk = report.cassette!.frames.find(
      (frame) => frame.kind === EnvelopeKind.RpcChunk,
    )!;
    const wrongChunks = {
      ...report.cassette!,
      frames: report.cassette!.frames.map((frame) =>
        frame === sinkChunk ? { ...frame, parts: readChunk.parts } : frame,
      ),
    };
    await t.rejects(
      () =>
        simulate({
          entry: SESSION_GUEST,
          world: { 'app:session': sessionFacade() },
          cassette: { mode: 'replay', data: wrongChunks },
        }),
      /differ/,
      'sink chunk divergence is reported',
    );
  });

  it('replays returned handles through the same channel peer', async (t) => {
    const recorded = await simulate({
      entry: HANDLE_GUEST,
      world: { 'fino:test-facade': handleFacade() },
      cassette: { mode: 'record' },
    });
    t.ok(
      requestFrames(recorded.cassette!).some(
        (frame) => (decodeFrame(frame) as { specifier?: unknown }).specifier === '__h0',
      ),
      'handle method traffic is part of the cassette',
    );

    const replayed = await simulate({
      entry: HANDLE_GUEST,
      world: { 'fino:test-facade': handleFacade(true) },
      cassette: { mode: 'replay', data: recorded.cassette },
    });

    t.deepEqual(replayed.result, recorded.result, 'handle scalar and stream methods replay');
  });

  it('records bootstrap, console, telemetry, lifecycle, and the module graph', async (t) => {
    const report = await simulate({
      entry: DIAGNOSTICS_GUEST,
      overrides: [{ pattern: 'fino:context/topic', directive: 'inherit' }],
      cassette: { mode: 'record' },
    });
    const kinds = report.cassette!.frames.map((frame) => frame.kind);
    t.ok(kinds.includes(EnvelopeKind.Bootstrap), 'bootstrap crossed the session');
    t.ok(kinds.includes(EnvelopeKind.Console), 'console output crossed the session');
    t.ok(kinds.includes(EnvelopeKind.Telemetry), 'telemetry crossed the session');
    t.ok(kinds.includes(EnvelopeKind.Lifecycle), 'lifecycle crossed the session');
    t.ok(
      report.cassette!.manifest.modules.some(
        (module) => module.path === DIAGNOSTICS_GUEST && module.sha256 !== undefined,
      ),
      'loaded entry is content-addressed in the manifest',
    );
  });

  it('rejects untracked nested realms in deterministic mode', async (t) => {
    const report = await simulate({
      entry: NESTED_GUEST,
      overrides: [{ pattern: 'fino:realm', directive: 'inherit' }],
    });
    t.match(
      String(report.result),
      /nested Realm construction is not replayable/,
      'a nested realm cannot bypass the root session',
    );
  });
});
