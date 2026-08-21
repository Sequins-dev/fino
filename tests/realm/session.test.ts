import { describe, it } from 'fino:test/test';
import { EnvelopeKind } from 'internal:realm/envelope';
import {
  RealmSession,
  type RealmFrameCapture,
  type RealmObservation,
} from 'internal:realm/session';
import { RealmPort, type RealmFrame, type RealmLink } from 'internal:realm/transport-port';

function capture(snapshot: () => unknown, storage: () => readonly Uint8Array[]): RealmFrameCapture {
  return {
    direction: 'outbound',
    envelope: { kind: EnvelopeKind.RpcRequest, correlation: 7 },
    payloadBytes: 12,
    arrayBufferTransfers: 0,
    portTransfers: 0,
    snapshot,
    storage,
  };
}

describe('RealmSession', () => {
  it('does not materialize payloads without a matching observer', (t) => {
    const session = new RealmSession();
    let snapshots = 0;
    let storageCopies = 0;
    const frame = capture(
      () => (++snapshots, { value: 1 }),
      () => (++storageCopies, [new Uint8Array([1])]),
    );

    session._capture(frame);
    session.observe({
      capture: 'snapshot',
      filter: () => false,
      next: () => t.fail('filtered observer must not run'),
    });
    session._capture(frame);

    t.equal(snapshots, 0, 'snapshot materializer was skipped');
    t.equal(storageCopies, 0, 'storage materializer was skipped');
  });

  it('materializes each requested representation once', (t) => {
    const session = new RealmSession();
    const observations: RealmObservation[] = [];
    let snapshots = 0;
    let storageCopies = 0;
    for (const mode of ['metadata', 'snapshot', 'snapshot', 'storage', 'storage'] as const) {
      session.observe({ capture: mode, next: (event) => observations.push(event) });
    }

    session._capture(
      capture(
        () => (++snapshots, { value: 1 }),
        () => (++storageCopies, [new Uint8Array([1])]),
      ),
    );

    t.equal(observations.length, 5, 'every observer received the frame');
    t.equal(snapshots, 1, 'snapshot was shared');
    t.equal(storageCopies, 1, 'storage copy was shared');
    t.deepEqual(
      observations.map((event) => event.capture),
      ['metadata', 'snapshot', 'snapshot', 'storage', 'storage'],
      'each observer received its requested representation',
    );
  });

  it('isolates filter and callback failures from other observers', (t) => {
    const session = new RealmSession();
    const errors: unknown[] = [];
    const seen: RealmObservation[] = [];
    session.observe({
      filter: () => {
        throw new Error('filter failed');
      },
      next: () => t.fail('failed filter must not receive a frame'),
      error: (error) => errors.push(error),
    });
    session.observe({
      next: () => {
        throw new Error('callback failed');
      },
      error: (error) => errors.push(error),
    });
    session.observe({ next: (event) => seen.push(event) });

    session._capture(
      capture(
        () => null,
        () => [],
      ),
    );

    t.equal(errors.length, 2, 'both observer failures were reported');
    t.equal(seen.length, 1, 'healthy observer still received the frame');
  });
});

describe('realm transport observation', () => {
  it('observes both directions at the shared serialized boundary', (t) => {
    const frames: RealmFrame[] = [];
    const link: RealmLink = {
      transport: 'scheduled',
      wakeFd: -1,
      supportsPortTransfer: true,
      send: (header, data, stores, ports) => frames.push([[data, ...stores], ports, header]),
      drain: () => frames.splice(0),
    };
    const sender = new RealmPort(link);
    const receiver = new RealmPort(link);
    const sent: RealmObservation[] = [];
    const received: RealmObservation[] = [];
    sender._observe({ capture: 'snapshot', next: (event) => sent.push(event) });
    receiver._observe({ capture: 'storage', next: (event) => received.push(event) });
    receiver.start();

    sender._postControl(EnvelopeKind.RpcRequest, 19, { method: 'read', args: ['a'] });
    receiver._drain();

    t.equal(sent.length, 1, 'outbound frame was observed');
    t.equal(sent[0]!.direction, 'outbound', 'outbound direction is relative to sender');
    t.equal(sent[0]!.kind, EnvelopeKind.RpcRequest, 'outbound envelope kind is preserved');
    t.equal(sent[0]!.correlation, 19, 'outbound correlation is preserved');
    t.deepEqual(
      (sent[0] as Extract<RealmObservation, { capture: 'snapshot' }>).value,
      { method: 'read', args: ['a'] },
      'snapshot contains the crossing value',
    );

    t.equal(received.length, 1, 'inbound frame was observed');
    t.equal(received[0]!.direction, 'inbound', 'inbound direction is relative to receiver');
    t.equal(received[0]!.kind, EnvelopeKind.RpcRequest, 'inbound envelope kind is preserved');
    t.ok(
      (received[0] as Extract<RealmObservation, { capture: 'storage' }>).parts[0]!.byteLength > 0,
      'storage capture contains stable serialized bytes',
    );
  });

  it('snapshots transferred values only for an attached observer', (t) => {
    const frames: RealmFrame[] = [];
    const link: RealmLink = {
      transport: 'scheduled',
      wakeFd: -1,
      supportsPortTransfer: true,
      send: (header, data, stores, ports) => frames.push([[data, ...stores], ports, header]),
      drain: () => frames.splice(0),
    };
    const port = new RealmPort(link);
    const observations: RealmObservation[] = [];
    const bytes = new Uint8Array([3, 1, 4]);
    port._observe({ capture: 'snapshot', next: (event) => observations.push(event) });

    port.postMessage({ bytes }, [bytes.buffer]);

    t.equal(bytes.buffer.byteLength, 0, 'live transfer still detaches the sender');
    t.deepEqual(
      [
        ...(
          (observations[0] as Extract<RealmObservation, { capture: 'snapshot' }>).value as {
            bytes: Uint8Array;
          }
        ).bytes,
      ],
      [3, 1, 4],
      'observer receives an independent snapshot of the in-flight transfer',
    );
  });
});
