/**
 * Tests for internal:cluster/protocol — encode/decode + helpers.
 */
import { describe, it } from 'fino:test/test';
import { encode, decode, nodeIdFromId, type ClusterMessage } from 'internal:cluster/protocol';
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
  it('HEARTBEAT round-trips with and without a load sample', (t) => {
    const bare = roundTrip({ t: 'HEARTBEAT', ts: 42 });
    t.equal(bare.t, 'HEARTBEAT');
    if (bare.t === 'HEARTBEAT') {
      t.equal(bare.ts, 42);
      t.equal(bare.load, undefined, 'load stays absent when not sent');
    }
    const loaded = roundTrip({
      t: 'HEARTBEAT',
      ts: 43,
      load: { cpu: 0.25, memory: 2048, loopIdle: 0.75 },
    });
    if (loaded.t === 'HEARTBEAT') {
      t.equal(loaded.load?.cpu, 0.25, 'cpu survives the heartbeat');
      t.equal(loaded.load?.memory, 2048, 'memory survives the heartbeat');
      t.equal(loaded.load?.loopIdle, 0.75, 'loopIdle survives the heartbeat');
    }
    t.throws(
      () => encode({ t: 'HEARTBEAT', ts: 1, load: { cpu: 0, memory: 0, loopIdle: 2 } }),
      /loopIdle must be in/,
      'out-of-range loopIdle is rejected',
    );
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
        rules: [],
        bootstrapData: { cliOtel: { endpoint: 'http://collector.example:4318/remote' } },
      },
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'SPAWN');
    if (got.t === 'SPAWN') {
      t.equal(got.spawnReqId, 'req-1');
      t.equal(got.parentPortId, 'nodeA/p-0');
      t.equal(got.config.entry, './fn.ts');
      t.deepEqual(got.config.bootstrapData, {
        cliOtel: { endpoint: 'http://collector.example:4318/remote' },
      });
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

describe('cask transfer messages', () => {
  it('round-trips chunks, gets, and acks', (t) => {
    const hash = 'ab'.repeat(32);
    const chunk = decode(
      encode({ t: 'CASK_PUT', hash, seq: 3, chunk: new Uint8Array([1, 2, 3]), last: false }),
    );
    if (chunk.t !== 'CASK_PUT') throw new Error('wrong kind');
    t.equal(chunk.hash, hash, 'hash survives');
    t.equal(chunk.seq, 3, 'sequence survives');
    t.deepEqual(Array.from(chunk.chunk), [1, 2, 3], 'bytes survive');
    t.equal(chunk.last, false, 'not last');

    const data = decode(
      encode({ t: 'CASK_DATA', hash, seq: 9, chunk: new Uint8Array([7]), last: true }),
    );
    if (data.t !== 'CASK_DATA') throw new Error('wrong kind');
    t.equal(data.last, true, 'last flag survives');

    const get = decode(encode({ t: 'CASK_GET', hash }));
    t.equal(get.t, 'CASK_GET', 'get round-trips');

    const ack = decode(encode({ t: 'CASK_ACK', hash, ok: false, error: 'unknown cask' }));
    if (ack.t !== 'CASK_ACK') throw new Error('wrong kind');
    t.equal(ack.error, 'unknown cask', 'error survives');

    t.throws(
      () => encode({ t: 'CASK_GET', hash: 'nope' }),
      /64 lowercase hex/,
      'malformed hashes are refused at encode',
    );
  });
});

describe('shed handoff messages', () => {
  it('round-trips SHED_OFFER and SHED_RESULT through the real codec', (t) => {
    // The ids below mirror exactly what the client mints: dash-joined request
    // ids (bare handles) and slash-joined port ids. The distinction matters —
    // a slash in a request id fails encode inside the transport's async send,
    // where the rejection is swallowed and the message silently never leaves
    // the node. Loopback tests bypass encode, so only this test guards it.
    const offer = decode(
      encode({
        t: 'SHED_OFFER',
        spawnReqId: 'node-a-o-7',
        parentPortId: 'node-a/p-shed-42',
        config: { entry: 'main.ts', root: '/app', rules: [] },
      }),
    );
    if (offer.t !== 'SHED_OFFER') throw new Error('wrong kind');
    t.equal(offer.spawnReqId, 'node-a-o-7', 'request id survives');
    t.equal(offer.parentPortId, 'node-a/p-shed-42', 'port id survives');
    t.equal(offer.config.entry, 'main.ts', 'config survives');

    const accept = decode(
      encode({ t: 'SHED_RESULT', spawnReqId: 'node-a-o-7', childPortId: 'node-b/9', ok: true }),
    );
    if (accept.t !== 'SHED_RESULT') throw new Error('wrong kind');
    t.equal(accept.childPortId, 'node-b/9', 'accepted port survives');

    const refuse = decode(
      encode({
        t: 'SHED_RESULT',
        spawnReqId: 'node-a-o-7',
        childPortId: '',
        ok: false,
        error: 'overloaded',
      }),
    );
    if (refuse.t !== 'SHED_RESULT') throw new Error('wrong kind');
    t.equal(refuse.error, 'overloaded', 'refusal reason survives');

    t.throws(
      () => encode({ t: 'SHED_OFFER', spawnReqId: 'node-a/o-7', parentPortId: 'node-a/p-1', config: { entry: 'm', root: '', rules: [] } }),
      /malformed/,
      'slash-joined request ids are refused at encode — the bug this guards',
    );
  });

  it('round-trips DEPLOY and a cask-carrying SPAWN', (t) => {
    const hash = 'ab'.repeat(32);
    const deploy = decode(
      encode({ t: 'DEPLOY', spawnReqId: 'cli-1-0', parentPortId: 'cli-1/p-d-1', name: 'web', hash }),
    );
    if (deploy.t !== 'DEPLOY') throw new Error('wrong kind');
    t.equal(deploy.name, 'web', 'name survives');
    t.equal(deploy.hash, hash, 'hash survives');

    const spawn = decode(
      encode({
        t: 'SPAWN',
        spawnReqId: 'cli-1-0',
        parentPortId: 'cli-1/p-d-1',
        config: { entry: 'main.ts', root: '', rules: [] },
        caskHash: hash,
      }),
    );
    if (spawn.t !== 'SPAWN') throw new Error('wrong kind');
    t.equal(spawn.caskHash, hash, 'the cask identity rides the spawn');
  });
});
