import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { EnvelopeKind, type EnvelopeKindValue } from 'internal:realm/envelope';
import { deserialize, serialize } from 'internal:serializer';
import { decodeCassette, SimJournal } from 'internal:sim/journal';
import type { TransportFrame, TransportObserver } from 'internal:realm/transport-port';
import type journalTraffic from './fixtures/journal-traffic.ts';

class ObservedPort {
  #observer?: TransportObserver;

  observe(observer: TransportObserver): () => void {
    this.#observer = observer;
    return () => {
      this.#observer = undefined;
    };
  }

  emit(
    direction: TransportFrame['direction'],
    kind: EnvelopeKindValue,
    correlation: number,
    value: unknown,
  ): void {
    const parts = serialize(value);
    this.emitParts(direction, kind, correlation, parts);
  }

  emitParts(
    direction: TransportFrame['direction'],
    kind: EnvelopeKindValue,
    correlation: number,
    parts: Uint8Array[],
    portTransfers = 0,
  ): void {
    const frame: TransportFrame = {
      sequence: 0,
      direction,
      kind,
      correlation,
      payloadBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
      arrayBufferTransfers: parts.length - 1,
      portTransfers,
      parts,
    };
    if (this.#observer?.filter?.(frame) ?? true) this.#observer?.next(frame);
  }
}

function journalFacade(): Facade {
  return new Facade('app:journal', ['slow', 'fast', 'mutate'])
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

describe('SimJournal', () => {
  it('records exact serialized RPC frames as a JSON-safe cassette', (t) => {
    const port = new ObservedPort();
    const journal = new SimJournal();
    journal.record(port);
    const bytes = new Uint8Array([3, 1, 4]);
    const requestParts = serialize(
      {
        specifier: 'app:cassette',
        method: 'store',
        args: [new Map([['when', new Date(1_700_000_000_000)]]), bytes],
      },
      [bytes.buffer],
    );
    port.emitParts('inbound', EnvelopeKind.RpcRequest, 7, requestParts);
    port.emit('outbound', EnvelopeKind.RpcResponse, 7, { result: 9n });

    const cassette = journal.toCassette();
    t.equal(cassette.version, 1, 'the persisted format is explicitly versioned');
    t.deepEqual(
      cassette.frames.map(({ direction, kind, correlation }) => ({
        direction,
        kind,
        correlation,
      })),
      [
        { direction: 'inbound', kind: EnvelopeKind.RpcRequest, correlation: 7 },
        { direction: 'outbound', kind: EnvelopeKind.RpcResponse, correlation: 7 },
      ],
      'transport order and envelope metadata are preserved',
    );
    const [data, ...stores] = cassette.frames[0]!.parts.map((part) => {
      const binary = atob(part);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    });
    const request = deserialize(data!, stores) as { args: [Map<string, Date>, Uint8Array] };
    t.equal(request.args[0].get('when')!.getTime(), 1_700_000_000_000, 'Map and Date survive');
    t.deepEqual([...request.args[1]], [3, 1, 4], 'transferred backing-store bytes survive');
    t.equal(journal.entries[0]!.result, 9n, 'recording still projects the journal entry');
  });

  it('decodes persisted cassettes back into the shared transport frame shape', (t) => {
    const parts = serialize({ value: new Set([1n, 2n]) });
    const cassette = JSON.parse(
      JSON.stringify({
        version: 1,
        frames: [
          {
            direction: 'inbound',
            kind: EnvelopeKind.RpcRequest,
            correlation: 12,
            parts: parts.map((part) => {
              let binary = '';
              for (const byte of part) binary += String.fromCharCode(byte);
              return btoa(binary);
            }),
          },
        ],
      }),
    );

    const [frame] = decodeCassette(cassette);
    t.deepEqual(
      {
        sequence: frame!.sequence,
        direction: frame!.direction,
        kind: frame!.kind,
        correlation: frame!.correlation,
        payloadBytes: frame!.payloadBytes,
        arrayBufferTransfers: frame!.arrayBufferTransfers,
        portTransfers: frame!.portTransfers,
      },
      {
        sequence: 0,
        direction: 'inbound',
        kind: EnvelopeKind.RpcRequest,
        correlation: 12,
        payloadBytes: parts[0]!.byteLength,
        arrayBufferTransfers: 0,
        portTransfers: 0,
      },
      'derived metadata restores a complete TransportFrame',
    );
    t.deepEqual(deserialize(frame!.parts[0]!), { value: new Set([1n, 2n]) });
  });

  it('rejects unsupported or malformed cassette data before replay can use it', (t) => {
    const validFrame = {
      direction: 'inbound',
      kind: EnvelopeKind.RpcRequest,
      correlation: 1,
      parts: ['AA=='],
    };
    const malformed: unknown[] = [
      { version: 2, frames: [] },
      { version: 1, frames: null },
      { version: 1, frames: [{ ...validFrame, direction: 'sideways' }] },
      { version: 1, frames: [{ ...validFrame, kind: 255 }] },
      { version: 1, frames: [{ ...validFrame, correlation: -1 }] },
      { version: 1, frames: [{ ...validFrame, parts: [] }] },
      { version: 1, frames: [{ ...validFrame, parts: ['not base64'] }] },
    ];

    for (const value of malformed) {
      t.throws(
        () => decodeCassette(value),
        /invalid simulation cassette/i,
        'invalid persisted data is rejected with a cassette-specific error',
      );
    }
  });

  it('refuses to persist frames that transferred Realm-local ports', (t) => {
    const port = new ObservedPort();
    const journal = new SimJournal();
    journal.record(port);
    port.emitParts(
      'inbound',
      EnvelopeKind.RpcRequest,
      9,
      serialize({ specifier: 'app:ports', method: 'send', args: [] }),
      1,
    );

    t.throws(
      () => journal.toCassette(),
      /MessagePort transfers cannot be persisted/i,
      'a partial cassette is never emitted for non-portable traffic',
    );
  });

  it('persists empty sink termination as a protocol signal, not a chunk', (t) => {
    const port = new ObservedPort();
    const journal = new SimJournal();
    journal.record(port);
    port.emit('inbound', EnvelopeKind.SinkStart, 4, {
      specifier: 'app:sink',
      method: 'empty',
      args: [],
    });
    port.emit('inbound', EnvelopeKind.SinkEnd, 4, null);
    port.emit('outbound', EnvelopeKind.RpcResponse, 4, { result: 'closed' });

    t.deepEqual(
      journal.toCassette().frames.map(({ kind }) => kind),
      [EnvelopeKind.SinkStart, EnvelopeKind.SinkEnd, EnvelopeKind.RpcResponse],
      'the cassette retains the terminal signal needed to close replay input',
    );
    t.deepEqual(journal.entries[0]!.chunks, [], 'the terminal signal does not invent a chunk');
  });

  it('projects scalar, read-stream, and sink traffic in invocation order', async (t) => {
    using realm = new Realm<typeof journalTraffic>({
      entry: new URL('./fixtures/journal-traffic.ts', import.meta.url).pathname,
      overrides: ImportMap.deny([
        { pattern: 'internal:runtime/loop', directive: 'inherit' },
        { pattern: 'app:journal', directive: journalFacade() },
      ]),
    });
    const journal = new SimJournal();
    const detach = journal.record(realm.port);

    const result = await realm.call();
    detach();

    t.deepEqual(result, {
      calls: ['first', 'second'],
      input: { state: 'before' },
      streamed: ['alpha', { beta: 2 }],
      uploaded: 2,
    });
    const calls = journal.calls('app:journal');
    t.deepEqual(
      calls.map(({ method, kind }) => [method, kind]),
      [
        ['slow', 'call'],
        ['fast', 'call'],
        ['mutate', 'call'],
        ['chunks', 'stream'],
        ['upload', 'sink'],
      ],
      'completion order does not reorder invocations',
    );
    t.deepEqual(calls[2]!.args, [{ state: 'before' }], 'arguments are boundary snapshots');
    t.deepEqual(calls[3]!.chunks, ['alpha', { beta: 2 }], 'read-stream chunks are recorded');
    t.deepEqual(calls[4]!.chunks, ['one', { two: 2 }], 'sink chunks are recorded');
    t.equal(calls[4]!.result, 2, 'sink results remain correlated with their chunks');
    const frames = decodeCassette(JSON.parse(JSON.stringify(journal.toCassette())));
    t.ok(
      frames.some((frame) => frame.kind === EnvelopeKind.SinkEnd),
      'live recording retains the sink terminal signal',
    );
  });

  it('rejects ports that cannot provide copied transport observations', (t) => {
    const journal = new SimJournal();
    t.throws(
      () => journal.observe({}),
      /observable Realm transport port/,
      'embedded ports cannot silently bypass the observation boundary',
    );
  });

  it('projects failures and keeps empty terminal frames out of chunk data', (t) => {
    const port = new ObservedPort();
    const journal = new SimJournal();
    journal.observe(port);

    port.emit('inbound', EnvelopeKind.RpcRequest, 1, {
      specifier: 'app:errors',
      method: 'scalar',
      args: [],
    });
    port.emit('inbound', EnvelopeKind.RpcStreamRequest, 2, {
      specifier: 'app:errors',
      method: 'stream',
      args: [],
    });
    port.emit('outbound', EnvelopeKind.RpcChunk, 2, 'before failure');
    port.emit('outbound', EnvelopeKind.RpcError, 2, { error: 'stream failed' });
    port.emit('outbound', EnvelopeKind.RpcResponse, 1, { error: 'scalar failed' });
    port.emit('inbound', EnvelopeKind.SinkStart, 3, {
      specifier: 'app:errors',
      method: 'sink',
      args: [],
    });
    port.emit('inbound', EnvelopeKind.SinkChunk, 3, 'written');
    port.emit('inbound', EnvelopeKind.SinkError, 3, { error: 'sink aborted' });

    t.deepEqual(
      journal.entries.map(({ method, outcome, error, chunks }) => ({
        method,
        outcome,
        error,
        chunks,
      })),
      [
        { method: 'scalar', outcome: 'error', error: 'scalar failed', chunks: undefined },
        {
          method: 'stream',
          outcome: 'error',
          error: 'stream failed',
          chunks: ['before failure'],
        },
        { method: 'sink', outcome: 'error', error: 'sink aborted', chunks: ['written'] },
      ],
      'failures retain real chunks but do not invent values for terminal frames',
    );
  });
});
