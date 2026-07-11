/** Cluster membership protocol regression tests. */
import { describe, it } from 'fino:test/test';
import { encode, decode, type ClusterMessage } from 'internal:cluster/protocol';

describe('cluster membership protocol', () => {
  const roundTrip = (message: ClusterMessage): ClusterMessage => decode(encode(message));

  it('round-trips membership messages', (t) => {
    const hello = roundTrip({
      t: 'HELLO',
      nodeId: 'node-1',
      load: { cpu: .5, memory: 1024 }
    });
    const welcome = roundTrip({
      t: 'WELCOME',
      nodeId: 'seed',
      peers: [{ nodeId: 'node-1', load: { cpu: .5, memory: 1024 } }]
    });
    t.equal(hello.t, 'HELLO');
    t.equal(welcome.t, 'WELCOME');
    if (welcome.t === 'WELCOME') t.equal(welcome.peers[0]?.nodeId, 'node-1');
  });

  it('rejects malformed and legacy realm messages', (t) => {
    t.throws(() => decode('null'), /protocol/);
    t.throws(() => decode('{"t":"HELLO","nodeId":"bad/node","load":{"cpu":0,"memory":0}}'), /nodeId/);
    t.throws(() => decode('{"t":"HELLO","nodeId":"node","load":{"cpu":2,"memory":0}}'), /cpu/);
    t.throws(() => decode('{"t":"SPAWN"}'), /unknown message type/);
    t.throws(() => decode('{"t":"PORT_MSG"}'), /unknown message type/);
  });

  it('drops unknown wire properties', (t) => {
    const message = decode('{"t":"HELLO","nodeId":"node","load":{"cpu":0,"memory":0},"token":"secret"}');
    t.equal((message as any).token, undefined);
  });
});
