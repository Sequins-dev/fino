/**
 * The balance-loop host: timer driving, peer mapping, and the handle plumbing
 * between taking a spec and offering it. The shedding policy itself is
 * covered by the balancer tests.
 */
import { describe, it } from 'fino:test/test';
import { startBalanceLoop } from 'internal:cluster/balance-loop';
import type { PeerPressure, ShedQueue } from 'internal:cluster/balancer';
import type { PeerInfo } from 'internal:cluster/protocol';

/** Deterministic queue with one low-priority spec ready to move. */
function fakeQueue(): ShedQueue & { taken: number[]; resubmitted: number[] } {
  let pending = 5;
  const taken: number[] = [];
  const resubmitted: number[] = [];
  return {
    taken,
    resubmitted,
    depth: () => ({ pendingSpecs: pending, parkedLive: 0, active: 0 }),
    markLowest: () => (pending > 0 ? 7 : 0),
    take(owner) {
      if (pending === 0) return null;
      pending--;
      taken.push(owner);
      return 700 + owner;
    },
    clear: () => true,
    resubmit(handle) {
      pending++;
      resubmitted.push(handle);
      return handle - 700;
    },
    config: () => ({
      entry: '/app/x.ts',
      root: '/app',
      rules: '[]',
      watch: false,
      repl: false,
      data: null,
      bootstrapData: null,
    }),
    drop() {},
  };
}

const peer = (nodeId: string, pendingSpecs: number): PeerInfo => ({
  nodeId,
  load: { cpu: 0, memory: 0, pendingSpecs },
});

const lightest = (candidates: PeerPressure[]): PeerPressure | null =>
  candidates.length === 0
    ? null
    : candidates.reduce((a, b) => (b.pendingSpecs < a.pendingSpecs ? b : a));

describe('balance loop host', () => {
  it('offers the taken spec handle to the lightest peer on a timer', async (t) => {
    const queue = fakeQueue();
    const offers: Array<{ to: string; handle: number; workloadId: number }> = [];
    const client = {
      nodeId: 'node-a',
      peers: [peer('node-a', 99), peer('node-b', 0), peer('node-c', 4)],
      offerShed(toNodeId: string, shedHandle: number, workloadId: number) {
        offers.push({ to: toNodeId, handle: shedHandle, workloadId });
        return Promise.resolve({ accepted: true });
      },
    };
    const stop = startBalanceLoop(client, { intervalMs: 5, queue, samplePeers: lightest });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      stop();
    }
    t.ok(offers.length > 0, 'the timer drove at least one pass');
    t.equal(offers[0]!.to, 'node-b', 'the lightest peer received the offer');
    t.ok(
      offers.every((o) => o.to !== 'node-a'),
      'the node never offers work to itself',
    );
    t.equal(offers[0]!.handle, 707, 'the offer carries the handle the take produced');
    t.equal(offers[0]!.workloadId, 7, 'the offer names the workload being moved');
    t.equal(queue.resubmitted.length, 0, 'accepted specs are not resubmitted');
  });

  it('resubmits when every offer is refused, and stops offering when told', async (t) => {
    const queue = fakeQueue();
    let refusals = 0;
    const client = {
      nodeId: 'node-a',
      peers: [peer('node-b', 0)],
      offerShed() {
        refusals++;
        return Promise.resolve({ accepted: false, reason: 'overloaded' });
      },
    };
    const stop = startBalanceLoop(client, { intervalMs: 5, queue, samplePeers: lightest });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();
    // A pass may be mid-offer when the timer stops; let it finish before
    // comparing counters.
    await new Promise((resolve) => setTimeout(resolve, 20));
    t.ok(refusals > 0, 'offers were made');
    t.equal(queue.resubmitted.length, refusals, 'every refused spec went back to the queue');
    const settled = refusals;
    await new Promise((resolve) => setTimeout(resolve, 30));
    t.equal(refusals, settled, 'no offers happen after stop');
  });
});
