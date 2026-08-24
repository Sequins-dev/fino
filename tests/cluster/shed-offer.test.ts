/**
 * The shed handoff between two nodes: a destination decides whether to accept
 * a neighbour's queued work, and says so.
 *
 * A loopback transport stands in for the network so the protocol exchange is
 * deterministic; the wire path itself is covered by the peer-mesh tests.
 */
import { describe, it } from 'fino:test/test';
import { ClusterClient } from 'internal:cluster/client';
import type { ClusterMessage } from 'internal:cluster/protocol';

interface Wire {
  send(to: string, msg: ClusterMessage): void;
}

/**
 * Two clients wired directly to each other. Returns each node's transport and
 * the full message log, so a test can drive one side and read the answer.
 */
function loopbackPair() {
  const handlers = new Map<string, (from: string, msg: ClusterMessage) => void>();
  const sent: Array<{ from: string; to: string; msg: ClusterMessage }> = [];
  const transport = (nodeId: string) => ({
    nodeId,
    send(to: string, msg: ClusterMessage) {
      sent.push({ from: nodeId, to, msg });
      const handler = handlers.get(to);
      if (handler !== undefined) queueMicrotask(() => handler(nodeId, msg));
    },
    broadcast() {},
    broadcastExcept() {},
    on(handler: (from: string, msg: ClusterMessage) => void) {
      handlers.set(nodeId, handler);
    },
    close() {},
  });
  return { transport, sent };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
};

const offer = (): ClusterMessage => ({
  t: 'SHED_OFFER',
  toNode: 'node-b',
  spawnReqId: 'node-a/o-1',
  parentPortId: 'node-a/p-shed-1',
  config: { entry: '/app/shed.ts', root: '/app', rules: [] },
});

describe('shed offer handoff', () => {
  it('refuses an offer when the destination is over its watermark', async (t) => {
    const { transport, sent } = loopbackPair();
    const sourceWire: Wire = transport('node-a');
    const destination = new ClusterClient(transport('node-b') as never, 'node-b', {
      admission: () => ({ accept: false, reason: 'overloaded: 9 pending specs' }),
    });
    destination.start();
    try {
      sent.length = 0;
      sourceWire.send('node-b', offer());
      await settle();

      const results = sent.filter((entry) => entry.msg.t === 'SHED_RESULT');
      t.equal(results.length, 1, 'the destination answered the offer');
      const result = results[0]!.msg;
      if (result.t !== 'SHED_RESULT') return;
      t.equal(result.ok, false, 'an overloaded destination refuses');
      t.ok(
        (result.error ?? '').includes('overloaded'),
        `the refusal explains itself: ${result.error}`,
      );
      t.equal(result.childPortId, '', 'no workload was created');
    } finally {
      destination.stop();
    }
  });

  it('does not refuse when the destination has headroom', async (t) => {
    const { transport, sent } = loopbackPair();
    const sourceWire: Wire = transport('node-a');
    const destination = new ClusterClient(transport('node-b') as never, 'node-b', {
      admission: () => ({ accept: true }),
    });
    destination.start();
    try {
      sent.length = 0;
      sourceWire.send('node-b', offer());
      await settle();

      const refusals = sent
        .filter((entry) => entry.msg.t === 'SHED_RESULT')
        .filter((entry) => entry.msg.t === 'SHED_RESULT' && !entry.msg.ok);
      t.equal(refusals.length, 0, 'a node with headroom does not refuse the offer');
    } finally {
      destination.stop();
    }
  });
});
