/**
 * The balance-loop host: timer driving, peer mapping, and the handle plumbing
 * between taking a spec and offering it. The shedding policy itself is
 * covered by the balancer tests.
 */
import { describe, it } from 'fino:test/test';
import { drainQueue, startBalanceLoop, type DrainQueue } from 'internal:cluster/balance-loop';
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

/** DrainQueue over the fake, recording forced failures. */
function fakeDrainQueue(): ReturnType<typeof fakeQueue> &
  DrainQueue & { failures: Array<{ handle: number; reason: string }> } {
  const base = fakeQueue();
  const failures: Array<{ handle: number; reason: string }> = [];
  return Object.assign(base, {
    failures,
    fail(handle: number, reason: string) {
      failures.push({ handle, reason });
    },
  });
}

describe('node drain', () => {
  it('sheds everything to willing peers, ignoring watermarks', async (t) => {
    const queue = fakeDrainQueue();
    const client = {
      nodeId: 'node-a',
      // A peer with MORE pending work than this node: normal balancing would
      // never touch it, but a drain has no watermark.
      peers: [peer('node-b', 50)],
      offerShed: () => Promise.resolve({ accepted: true }),
    };
    const report = await drainQueue(client, { deadlineMs: 2000, queue, samplePeers: lightest });
    t.equal(report.shed, 5, 'every pre-init spec left the node');
    t.equal(report.failed, 0, 'nothing was forced');
    t.equal(queue.depth().pendingSpecs, 0, 'the queue is empty');
  });

  it('never offers to a draining peer', async (t) => {
    const queue = fakeDrainQueue();
    const offered: string[] = [];
    const client = {
      nodeId: 'node-a',
      peers: [
        { nodeId: 'node-b', load: { cpu: 0, memory: 0, pendingSpecs: 0, draining: true } },
        peer('node-c', 30),
      ],
      offerShed(to: string) {
        offered.push(to);
        return Promise.resolve({ accepted: true });
      },
    };
    await drainQueue(client, { deadlineMs: 2000, queue, samplePeers: lightest });
    t.ok(offered.length > 0, 'offers were made');
    t.ok(
      offered.every((to) => to === 'node-c'),
      'a node that is itself leaving is never a drain target',
    );
  });

  it('fails what nobody accepts at the deadline, with an explicit reason', async (t) => {
    const queue = fakeDrainQueue();
    const client = {
      nodeId: 'node-a',
      peers: [peer('node-b', 0)],
      offerShed: () => Promise.resolve({ accepted: false, reason: 'full' }),
    };
    const report = await drainQueue(client, { deadlineMs: 80, queue, samplePeers: lightest });
    t.equal(report.shed, 0, 'nothing was accepted');
    t.equal(report.failed, 5, 'every leftover spec was explicitly failed');
    t.equal(queue.failures.length, 5, 'each failure was delivered');
    t.ok(
      queue.failures.every((f) => f.reason.includes('deadline')),
      'the parent learns why its workload died',
    );
    t.equal(queue.depth().pendingSpecs, 0, 'nothing lingers silently');
  });

  it('drains an empty queue immediately', async (t) => {
    const queue = fakeDrainQueue();
    // Empty the fake by taking every spec.
    for (;;) {
      const owner = queue.markLowest();
      if (owner === 0) break;
      queue.take(owner);
    }
    const client = {
      nodeId: 'node-a',
      peers: [peer('node-b', 0)],
      offerShed: () => Promise.resolve({ accepted: true }),
    };
    const report = await drainQueue(client, { deadlineMs: 2000, queue, samplePeers: lightest });
    t.equal(report.shed + report.failed, 0, 'an idle node drains instantly');
  });
});
