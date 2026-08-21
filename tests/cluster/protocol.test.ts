/**
 * Tests for internal:cluster/protocol — encode/decode + helpers.
 */
import { describe, it } from 'fino:test/test';
import {
  encode,
  decode,
  nodeIdFromId,
  PayloadFormat,
  type ClusterMessage,
} from 'internal:cluster/protocol';
describe('ClusterMessage encode/decode', () => {
  const roundTrip = (msg: ClusterMessage): ClusterMessage => decode(encode(msg));
  it('HELLO round-trips', (t) => {
    const msg: ClusterMessage = {
      t: 'HELLO',
      nodeId: 'node1',
      load: {
        cpu: .5,
        memory: 1024,
      },
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'HELLO');
    if (got.t === 'HELLO') {
      t.equal(got.nodeId, 'node1');
      t.equal(got.load.cpu, .5);
    }
  });
  it('WELCOME round-trips with peer list', (t) => {
    const msg: ClusterMessage = {
      t: 'WELCOME',
      nodeId: 'seed',
      peers: [
        {
          nodeId: 'worker1',
          load: {
            cpu: 0,
            memory: 512,
          },
        },
      ],
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'WELCOME');
    if (got.t === 'WELCOME') {
      t.equal(got.peers.length, 1);
      t.equal(got.peers[0]?.nodeId, 'worker1');
    }
  });
  it('SPAWN round-trips', (t) => {
    const msg: ClusterMessage = {
      t: 'SPAWN',
      spawnReqId: 'req-1',
      parentPortId: 'nodeA/p-0',
      config: {
        entry: './fn.ts',
        root: '/app',
        rules: [
          {
            pattern: 'app:clock',
            directive: {
              type: 'facade',
              specifier: 'app:clock',
              exports: [],
              source: 'export class Clock {}',
            },
          },
        ],
        bootstrapData: { channelBootstrap: true },
      },
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'SPAWN');
    if (got.t === 'SPAWN') {
      t.equal(got.spawnReqId, 'req-1');
      t.equal(got.parentPortId, 'nodeA/p-0');
      t.equal(got.config.entry, './fn.ts');
      t.deepEqual(got.config.bootstrapData, { channelBootstrap: true });
      t.equal(
        (got.config.rules[0]?.directive as { source?: string }).source,
        'export class Clock {}',
        'custom facade module source survives the cluster wire',
      );
    }
  });
  it('SPAWN_ACK round-trips', (t) => {
    const ok: ClusterMessage = {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-1',
      childPortId: 'nodeB/0',
      ok: true,
    };
    const fail: ClusterMessage = {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-2',
      childPortId: '',
      ok: false,
      error: 'no worker',
    };
    const gotOk = roundTrip(ok);
    const gotFail = roundTrip(fail);
    t.equal(gotOk.t, 'SPAWN_ACK');
    if (gotOk.t === 'SPAWN_ACK') t.ok(gotOk.ok, 'ok=true preserved');
    if (gotFail.t === 'SPAWN_ACK') {
      t.ok(!gotFail.ok, 'ok=false preserved');
      t.equal(gotFail.error, 'no worker', 'error message preserved');
    }
  });
  it('PORT_MSG round-trips', (t) => {
    const msg = {
      t: 'PORT_MSG',
      fromPort: 'nodeA/p-0',
      toPort: 'nodeB/0',
      payload: [new TextEncoder().encode('hello')],
      seq: 3,
    } as ClusterMessage;
    const got = roundTrip(msg);
    t.equal(got.t, 'PORT_MSG');
    if (got.t === 'PORT_MSG') {
      t.equal(got.fromPort, 'nodeA/p-0');
      t.equal(got.toPort, 'nodeB/0');
      t.deepEqual(got.payload, [new TextEncoder().encode('hello')]);
      t.equal((got as any).seq, 3);
    }
  });
  it('REALM_EXIT round-trips its final port-message sequence', (t) => {
    const msg = {
      t: 'REALM_EXIT',
      realmId: 'nodeB/5',
      lastPortSeq: 7,
    } as ClusterMessage;
    const got = roundTrip(msg);
    t.equal(got.t, 'REALM_EXIT');
    if (got.t === 'REALM_EXIT') t.equal((got as any).lastPortSeq, 7);
  });
  it('TERMINATE round-trips', (t) => {
    const msg: ClusterMessage = {
      t: 'TERMINATE',
      realmId: 'nodeB/5',
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'TERMINATE');
    if (got.t === 'TERMINATE') t.equal(got.realmId, 'nodeB/5');
  });
  it('rejects malformed envelopes', (t) => {
    t.throws(() => decode(new Uint8Array()), /protocol/, 'empty envelope rejected');
    t.throws(
      () => decode(new Uint8Array([0x08, 0x7f])),
      /unknown message type/,
      'unknown discriminator rejected',
    );
    t.throws(
      () =>
        encode({
          t: 'HELLO',
          nodeId: 'node/1',
          load: { cpu: 0, memory: 1 },
        }),
      /nodeId/,
      'node id with slash rejected',
    );
    t.throws(
      () =>
        encode({
          t: 'PORT_MSG',
          fromPort: 'nodeA/p-1',
          toPort: 'nodeB/2',
          payload: 5,
          seq: 1,
        } as unknown as ClusterMessage),
      /payload/,
      'non-binary payload rejected',
    );
    t.throws(
      () =>
        encode({
          t: 'PORT_MSG',
          fromPort: 'nodeA/p-1',
          toPort: 'nodeB/2',
          payload: [],
          seq: -1,
        }),
      /seq/,
      'negative sequence rejected',
    );
    t.throws(
      () =>
        encode({
          t: 'REALM_EXIT',
          realmId: 'nodeB/2',
        } as unknown as ClusterMessage),
      /lastPortSeq/,
      'realm exits require a final sequence fence',
    );
    t.throws(
      () =>
        encode({
          t: 'WELCOME',
          nodeId: 'seed',
          peers: [{ nodeId: 'bad/node', load: { cpu: 0, memory: 1 } }],
        }),
      /peer/,
      'malformed peer rejected',
    );
  });
  it('does not preserve authentication or transport negotiation fields', (t) => {
    const helloBytes = encode({
      t: 'HELLO',
      nodeId: 'node1',
      load: { cpu: 0, memory: 1 },
    });
    const withUnknownField = new Uint8Array(helloBytes.byteLength + 3);
    withUnknownField.set(helloBytes);
    withUnknownField.set([0xa0, 0x06, 0x01], helloBytes.byteLength);
    const hello = decode(withUnknownField);
    const portMsg = decode(
      encode({
        t: 'PORT_MSG',
        fromPort: 'nodeA/p-1',
        toPort: 'nodeB/p-2',
        payload: [],
        seq: 1,
      }),
    );
    t.equal((hello as any).token, undefined, 'auth token is not part of HELLO');
    t.equal((portMsg as any).direct, undefined, 'direct peer routing flag is not part of PORT_MSG');
    t.equal((portMsg as any).transport, undefined, 'transport negotiation is not part of PORT_MSG');
  });
});
describe('nodeIdFromId helper', () => {
  it('extracts prefix before first slash', (t) => {
    t.equal(nodeIdFromId('nodeA/p-0'), 'nodeA');
    t.equal(nodeIdFromId('worker-123/42'), 'worker-123');
  });
  it('returns the whole string if no slash', (t) => {
    t.equal(nodeIdFromId('nodeA'), 'nodeA');
  });
});

describe('PORT_MSG payload encoding', () => {
  it('round-trips the payload format descriptor', (t) => {
    const frame = encode({
      t: 'PORT_MSG',
      fromPort: 'a/p-1',
      toPort: 'b/p-2',
      payload: [new Uint8Array([1, 2]), new Uint8Array([0xff, 15, 42])],
      seq: 1,
      payloadFormat: PayloadFormat.V8StructuredClone,
    });
    const decoded = decode(frame);
    t.equal(decoded.t, 'PORT_MSG', 'frame type survives');
    if (decoded.t !== 'PORT_MSG') return;
    t.equal(
      decoded.payloadFormat,
      PayloadFormat.V8StructuredClone,
      'the receiver learns how the payload was encoded rather than assuming',
    );
  });
  it('treats a frame without the descriptor as unspecified', (t) => {
    const frame = encode({
      t: 'PORT_MSG',
      fromPort: 'a/p-1',
      toPort: 'b/p-2',
      payload: [new Uint8Array([1])],
      seq: 1,
    });
    const decoded = decode(frame);
    t.equal(decoded.t, 'PORT_MSG', 'frame type survives');
    if (decoded.t !== 'PORT_MSG') return;
    t.equal(
      decoded.payloadFormat ?? PayloadFormat.Unspecified,
      PayloadFormat.Unspecified,
      'a peer predating the descriptor stays decodable',
    );
  });
});
