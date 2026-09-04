import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { EnvelopeKind, type EnvelopeKindValue } from 'internal:realm/envelope';
import { serialize } from 'internal:serializer';
import { SimJournal } from 'internal:sim/journal';
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
    const frame: TransportFrame = {
      sequence: 0,
      direction,
      kind,
      correlation,
      payloadBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
      arrayBufferTransfers: 0,
      portTransfers: 0,
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
  it('projects scalar, read-stream, and sink traffic in invocation order', async (t) => {
    using realm = new Realm<typeof journalTraffic>({
      entry: new URL('./fixtures/journal-traffic.ts', import.meta.url).pathname,
      overrides: ImportMap.deny([
        { pattern: 'internal:runtime/loop', directive: 'inherit' },
        { pattern: 'app:journal', directive: journalFacade() },
      ]),
    });
    const journal = new SimJournal();
    const detach = journal.observe(realm.port);

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
