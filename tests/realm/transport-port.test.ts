import { describe, it } from 'fino:test/test';
import { EnvelopeKind } from 'internal:realm/envelope';
import {
  TransportPort,
  type RealmLink,
  type RealmWireFrame,
  type TransportFrame,
} from 'internal:realm/transport-port';

function channel(): TransportPort {
  const frames: RealmWireFrame[] = [];
  const link: RealmLink = {
    transport: 'scheduled',
    wakeFd: -1,
    supportsPortTransfer: true,
    send: (header, data, stores, ports) => frames.push([[data, ...stores], ports, header]),
    drain: () => frames.splice(0),
  };
  return new TransportPort(link);
}

describe('TransportPort tee', () => {
  it('filters metadata before delivering a representation', (t) => {
    const port = channel();
    let filtered = 0;
    port.observe({
      capture: 'snapshot',
      filter: (metadata) => {
        filtered++;
        return false;
      },
      next: () => t.fail('filtered branch must not receive a frame'),
    });

    port.postMessage({ value: 1 });

    t.equal(filtered, 1, 'the inexpensive metadata filter ran');
  });

  it('shares each requested representation across matching branches', (t) => {
    const port = channel();
    const metadata: TransportFrame[] = [];
    const snapshots: TransportFrame[] = [];
    const storage: TransportFrame[] = [];
    port.observe({ next: (frame) => metadata.push(frame) });
    port.observe({ capture: 'snapshot', next: (frame) => snapshots.push(frame) });
    port.observe({ capture: 'snapshot', next: (frame) => snapshots.push(frame) });
    port.observe({ capture: 'storage', next: (frame) => storage.push(frame) });
    port.observe({ capture: 'storage', next: (frame) => storage.push(frame) });

    port.postMessage({ value: 1 });

    t.equal(metadata.length, 1, 'metadata branch received the frame');
    t.equal(snapshots.length, 2, 'snapshot branches received the frame');
    t.equal(storage.length, 2, 'storage branches received the frame');
    t.equal(snapshots[0], snapshots[1], 'snapshot materialization is shared');
    t.equal(storage[0], storage[1], 'storage materialization is shared');
  });

  it('isolates branch failures and supports detaching a branch', (t) => {
    const port = channel();
    const errors: unknown[] = [];
    const seen: TransportFrame[] = [];
    port.observe({
      filter: () => {
        throw new Error('filter failed');
      },
      next: () => t.fail('failed filter must not receive a frame'),
      error: (error) => errors.push(error),
    });
    port.observe({
      next: () => {
        throw new Error('callback failed');
      },
      error: (error) => errors.push(error),
    });
    const detach = port.observe({ next: (frame) => seen.push(frame) });

    port.postMessage(null);
    detach();
    port.postMessage(null);

    t.equal(errors.length, 4, 'both failures were reported for both frames');
    t.equal(seen.length, 1, 'detached branch received no later frame');
  });

  it('tees both directions at the shared serialized boundary', (t) => {
    const frames: RealmWireFrame[] = [];
    const link: RealmLink = {
      transport: 'scheduled',
      wakeFd: -1,
      supportsPortTransfer: true,
      send: (header, data, stores, ports) => frames.push([[data, ...stores], ports, header]),
      drain: () => frames.splice(0),
    };
    const sender = new TransportPort(link);
    const receiver = new TransportPort(link);
    const sent: TransportFrame[] = [];
    const received: TransportFrame[] = [];
    sender.observe({ capture: 'snapshot', next: (frame) => sent.push(frame) });
    receiver.observe({ capture: 'storage', next: (frame) => received.push(frame) });
    receiver.start();

    sender._postControl(EnvelopeKind.RpcRequest, 19, { method: 'read', args: ['a'] });
    receiver._drain();

    t.equal(sent[0]!.direction, 'outbound', 'sender observes an outbound frame');
    t.equal(received[0]!.direction, 'inbound', 'receiver observes an inbound frame');
    t.equal(sent[0]!.kind, EnvelopeKind.RpcRequest, 'envelope kind is preserved');
    t.equal(sent[0]!.correlation, 19, 'correlation is preserved');
    t.deepEqual(
      (sent[0] as Extract<TransportFrame, { capture: 'snapshot' }>).value,
      { method: 'read', args: ['a'] },
      'snapshot contains the crossing value',
    );
    t.ok(
      (received[0] as Extract<TransportFrame, { capture: 'storage' }>).parts[0]!.byteLength > 0,
      'storage capture contains stable serialized bytes',
    );
  });

  it('snapshots an explicit transfer only when a branch requests it', (t) => {
    const port = channel();
    const observations: TransportFrame[] = [];
    const bytes = new Uint8Array([3, 1, 4]);
    port.observe({ capture: 'snapshot', next: (frame) => observations.push(frame) });

    port.postMessage({ bytes }, [bytes.buffer]);

    t.equal(bytes.buffer.byteLength, 0, 'live transfer detaches the sender');
    t.deepEqual(
      [
        ...(
          (observations[0] as Extract<TransportFrame, { capture: 'snapshot' }>).value as {
            bytes: Uint8Array;
          }
        ).bytes,
      ],
      [3, 1, 4],
      'the tee receives an independent snapshot of the in-flight transfer',
    );
  });
});
