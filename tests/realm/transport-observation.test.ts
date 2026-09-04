import { describe, it } from 'fino:test/test';
import { decodeEnvelope, EnvelopeKind } from 'internal:realm/envelope';
import { deserialize, serialize } from 'internal:serializer';
import {
  RealmPort,
  type RealmFrame,
  type RealmLink,
  type TransportFrame,
} from 'internal:realm/transport-port';

function channel(): RealmPort {
  const frames: RealmFrame[] = [];
  const link: RealmLink = {
    transport: 'scheduled',
    wakeFd: -1,
    supportsPortTransfer: true,
    send: (header, data, stores, ports) => frames.push([[data, ...stores], ports, header]),
    drain: () => frames.splice(0),
  };
  return new RealmPort(link);
}

describe('RealmPort observation', () => {
  it('filters metadata before copying a payload', (t) => {
    const port = channel();
    let filtered = 0;
    port.observe({
      filter: (metadata) => {
        filtered++;
        return false;
      },
      next: () => t.fail('filtered observer must not receive a frame'),
    });

    port.postMessage({ value: 1 });

    t.equal(filtered, 1, 'the metadata filter ran');
  });

  it('gives each observer an independent serialized copy', (t) => {
    const port = channel();
    const observations: TransportFrame[] = [];
    port.observe({
      next: (frame) => {
        observations.push(frame);
        for (const part of frame.parts) part.fill(0);
      },
    });
    port.observe({ next: (frame) => observations.push(frame) });

    port.postMessage({ value: 1 });

    t.equal(observations.length, 2, 'both observers received the frame');
    t.notEqual(observations[0], observations[1], 'frame objects are not shared');
    t.notEqual(observations[0]!.parts[0], observations[1]!.parts[0], 'frame bytes are not shared');
    t.deepEqual(
      deserialize(observations[1]!.parts[0]!, observations[1]!.parts.slice(1)),
      { value: 1 },
      'one observer cannot mutate another observer copy',
    );
  });

  it('isolates observer failures and supports detaching', (t) => {
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
    t.equal(seen.length, 1, 'the detached observer received no later frame');
  });

  it('observes both directions at the serialized boundary', (t) => {
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
    const sent: TransportFrame[] = [];
    const received: TransportFrame[] = [];
    sender.observe({ next: (frame) => sent.push(frame) });
    receiver.observe({ next: (frame) => received.push(frame) });
    receiver.start();

    sender._postControl(EnvelopeKind.RpcRequest, 19, { method: 'read', args: ['a'] });
    receiver._drain();

    t.equal(sent[0]!.direction, 'outbound', 'the sender observes an outbound frame');
    t.equal(received[0]!.direction, 'inbound', 'the receiver observes an inbound frame');
    t.equal(sent[0]!.kind, EnvelopeKind.RpcRequest, 'the envelope kind is preserved');
    t.equal(sent[0]!.correlation, 19, 'the correlation is preserved');
    t.deepEqual(deserialize(sent[0]!.parts[0]!, sent[0]!.parts.slice(1)), {
      method: 'read',
      args: ['a'],
    });
    t.ok(received[0]!.parts[0]!.byteLength > 0, 'the observation contains stable serialized bytes');
  });

  it('copies an explicit transfer before detaching the sender buffer', (t) => {
    const port = channel();
    const observations: TransportFrame[] = [];
    const bytes = new Uint8Array([3, 1, 4]);
    port.observe({ next: (frame) => observations.push(frame) });

    port.postMessage({ bytes }, [bytes.buffer]);

    t.equal(bytes.buffer.byteLength, 0, 'the live transfer detaches the sender');
    const value = deserialize(observations[0]!.parts[0]!, observations[0]!.parts.slice(1)) as {
      bytes: Uint8Array;
    };
    t.deepEqual(
      [...value.bytes],
      [3, 1, 4],
      'the observer receives an independent serialized copy',
    );
  });

  it('keeps inbound observation mutations out of primary delivery', (t) => {
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
    let delivered: unknown;
    receiver.observe({
      next: (frame) => {
        for (const part of frame.parts) part.fill(0);
      },
    });
    receiver.onmessage = (event) => {
      delivered = (event as MessageEvent).data;
    };

    sender.postMessage({ value: 1 });
    receiver._drain();

    t.deepEqual(delivered, { value: 1 }, 'the observer cannot mutate primary delivery');
  });

  it('sends recorded control bytes and backing stores without reserializing them', (t) => {
    const sent: RealmFrame[] = [];
    const link: RealmLink = {
      transport: 'scheduled',
      wakeFd: -1,
      supportsPortTransfer: true,
      send: (header, data, stores, ports) => sent.push([[data, ...stores], ports, header]),
      drain: () => sent.splice(0),
    };
    const port = new RealmPort(link);
    const observed: TransportFrame[] = [];
    port.observe({ next: (frame) => observed.push(frame) });
    const bytes = new Uint8Array([2, 7, 1, 8]);
    const sourceParts = serialize({ bytes }, [bytes.buffer]);

    port._postSerializedControl(EnvelopeKind.RpcResponse, 42, sourceParts);

    const [parts, transferredPorts, header] = sent[0]!;
    t.deepEqual(decodeEnvelope(header), {
      kind: EnvelopeKind.RpcResponse,
      correlation: 42,
    });
    t.equal(transferredPorts.length, 0, 'recorded cassettes never synthesize MessagePorts');
    t.equal(parts.length, 2, 'the transferred backing store stays separate from the payload');
    t.notEqual(parts[0], sourceParts[0], 'replay owns the bytes handed to the live transport');
    t.deepEqual(
      [...(deserialize(parts[0]!, parts.slice(1)) as { bytes: Uint8Array }).bytes],
      [2, 7, 1, 8],
      'the recorded transfer remains deserializable',
    );
    t.deepEqual(observed[0]!.parts, parts, 'replayed output remains observable as live traffic');
  });

  it('lets an interceptor claim control traffic before existing dispatchers', (t) => {
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
    const order: string[] = [];
    receiver._addControlHandler(() => {
      order.push('live');
      return true;
    });
    receiver._addControlHandler(
      () => {
        order.push('interceptor');
        return true;
      },
      { first: true },
    );
    receiver.start();

    sender._postControl(EnvelopeKind.RpcRequest, 1, null);
    receiver._drain();

    t.deepEqual(order, ['interceptor'], 'claimed traffic never reaches the live dispatcher');
  });
});
