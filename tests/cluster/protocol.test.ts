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
        memory: 1024
      }
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
      peers: [{
        nodeId: 'worker1',
        load: {
          cpu: 0,
          memory: 512
        }
      }]
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
        rules: []
      }
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'SPAWN');
    if (got.t === 'SPAWN') {
      t.equal(got.spawnReqId, 'req-1');
      t.equal(got.parentPortId, 'nodeA/p-0');
      t.equal(got.config.entry, './fn.ts');
    }
  });
  it('SPAWN_ACK round-trips', (t) => {
    const ok: ClusterMessage = {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-1',
      childPortId: 'nodeB/0',
      ok: true
    };
    const fail: ClusterMessage = {
      t: 'SPAWN_ACK',
      spawnReqId: 'req-2',
      childPortId: '',
      ok: false,
      error: 'no worker'
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
    const msg: ClusterMessage = {
      t: 'PORT_MSG',
      fromPort: 'nodeA/p-0',
      toPort: 'nodeB/0',
      payload: btoa('hello')
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'PORT_MSG');
    if (got.t === 'PORT_MSG') {
      t.equal(got.fromPort, 'nodeA/p-0');
      t.equal(got.toPort, 'nodeB/0');
      t.equal(got.payload, btoa('hello'));
    }
  });
  it('TERMINATE round-trips', (t) => {
    const msg: ClusterMessage = {
      t: 'TERMINATE',
      realmId: 'nodeB/5'
    };
    const got = roundTrip(msg);
    t.equal(got.t, 'TERMINATE');
    if (got.t === 'TERMINATE') t.equal(got.realmId, 'nodeB/5');
  });
  it('rejects malformed envelopes', (t) => {
    t.throws(() => decode('null'), /protocol/, 'non-object JSON rejected');
    t.throws(() => decode('{"t":"NOPE"}'), /unknown message type/, 'unknown discriminator rejected');
    t.throws(() => decode('{"t":"HELLO","nodeId":"node/1","load":{"cpu":0,"memory":1}}'), /nodeId/, 'node id with slash rejected');
    t.throws(() => decode('{"t":"PORT_MSG","fromPort":"nodeA/p-1","toPort":"nodeB/2","payload":5}'), /payload/, 'non-string payload rejected');
    t.throws(() => decode('{"t":"WELCOME","nodeId":"seed","peers":[{"nodeId":"bad/node","load":{"cpu":0,"memory":1}}]}'), /peer/, 'malformed peer rejected');
  });
  it('does not preserve authentication or transport negotiation fields', (t) => {
    const hello = decode('{"t":"HELLO","nodeId":"node1","load":{"cpu":0,"memory":1},"token":"secret"}');
    const portMsg = decode('{"t":"PORT_MSG","fromPort":"nodeA/p-1","toPort":"nodeB/p-2","payload":"","direct":true,"transport":"quic"}');
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
