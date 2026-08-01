/**
 * Tail-shedding balancer policy: when work moves, when it must not, and what
 * happens when a local reactor wins the race against an in-flight offer.
 */
import { describe, it } from 'fino:test/test';
import {
  QueueBalancer,
  type OfferResult,
  type PeerPressure,
  type ShedQueue,
} from 'internal:cluster/balancer';

/** In-memory queue standing in for the native tail-shedding surface. */
class FakeQueue implements ShedQueue {
  specs: Array<{ owner: number; priority: number }>;
  marked = new Set<number>();
  taken = new Map<number, { owner: number; priority: number }>();
  dropped: number[] = [];
  /** Owners a reactor grabs the moment they are marked. */
  reclaimOnTake = new Set<number>();
  #handleSeq = 100;

  constructor(priorities: number[]) {
    this.specs = priorities.map((priority, index) => ({ owner: index + 1, priority }));
  }
  depth() {
    return { pendingSpecs: this.specs.length, parkedLive: 0, active: 0 };
  }
  markLowest(): number {
    const available = this.specs.filter((s) => !this.marked.has(s.owner));
    if (available.length === 0) return 0;
    const lowest = available.reduce((a, b) => (b.priority < a.priority ? b : a));
    this.marked.add(lowest.owner);
    return lowest.owner;
  }
  take(owner: number): number | null {
    if (!this.marked.delete(owner)) return null;
    if (this.reclaimOnTake.has(owner)) {
      // Simulates a reactor claiming the spec under the lock.
      this.specs = this.specs.filter((s) => s.owner !== owner);
      return null;
    }
    const index = this.specs.findIndex((s) => s.owner === owner);
    if (index === -1) return null;
    const [spec] = this.specs.splice(index, 1);
    const handle = this.#handleSeq++;
    this.taken.set(handle, spec!);
    return handle;
  }
  clear(owner: number): boolean {
    return this.marked.delete(owner);
  }
  resubmit(handle: number): number {
    const spec = this.taken.get(handle)!;
    this.taken.delete(handle);
    this.specs.push(spec);
    return spec.owner;
  }
  config(handle: number) {
    const spec = this.taken.get(handle)!;
    return {
      entry: `/app/${spec.owner}.ts`,
      root: '/app',
      rules: '[]',
      watch: false,
      repl: false,
      data: null,
      bootstrapData: null,
    };
  }
  drop(handle: number): void {
    this.dropped.push(handle);
    this.taken.delete(handle);
  }
}

function transportThat(result: OfferResult | ((node: string) => OfferResult)) {
  const offers: Array<{ nodeId: string; workloadId: number }> = [];
  return {
    offers,
    offer(nodeId: string, _spec: unknown, workloadId: number): Promise<OfferResult> {
      offers.push({ nodeId, workloadId });
      return Promise.resolve(typeof result === 'function' ? result(nodeId) : result);
    },
  };
}

/** Always take the lightest candidate, so tests are deterministic. */
const lightest = (candidates: PeerPressure[]): PeerPressure | null =>
  candidates.length === 0 ? null : candidates.reduce((a, b) => (b.pendingSpecs < a.pendingSpecs ? b : a));

describe('queue balancer', () => {
  it('does not shed when the local queue is below the watermark', async (t) => {
    const queue = new FakeQueue([5]);
    const transport = transportThat({ accepted: true });
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 3,
      samplePeers: lightest,
    });
    const outcome = await balancer.balance([{ nodeId: 'idle', pendingSpecs: 0 }]);
    t.equal(outcome.shed, 0, 'a shallow queue sheds nothing');
    t.equal(transport.offers.length, 0, 'no peer was contacted');
  });

  it('does not shed to peers that are not materially lighter', async (t) => {
    const queue = new FakeQueue([1, 2, 3, 4]);
    const transport = transportThat({ accepted: true });
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 2,
      minDelta: 3,
      samplePeers: lightest,
    });
    const outcome = await balancer.balance([{ nodeId: 'peer', pendingSpecs: 3 }]);
    t.equal(outcome.shed, 0, 'a near-equal peer receives nothing');
    t.equal(transport.offers.length, 0, 'hysteresis prevents the offer entirely');
  });

  it('sheds the lowest-priority specs first, up to the batch size', async (t) => {
    const queue = new FakeQueue([9, 1, 5, 2]);
    const transport = transportThat({ accepted: true });
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 2,
      minDelta: 1,
      batch: 2,
      samplePeers: lightest,
    });
    const outcome = await balancer.balance([{ nodeId: 'idle', pendingSpecs: 0 }]);
    t.equal(outcome.shed, 2, 'the batch cap is honored');
    t.deepEqual(
      transport.offers.map((o) => o.workloadId),
      [2, 4],
      'the two lowest-priority specs left, lowest first',
    );
    t.equal(queue.specs.length, 2, 'the rest stayed put');
    t.deepEqual(
      queue.specs.map((s) => s.priority).sort(),
      [5, 9],
      'the highest-priority work is still local',
    );
  });

  it('returns a refused spec to the queue unchanged', async (t) => {
    const queue = new FakeQueue([1, 2, 3]);
    const transport = transportThat({ accepted: false, reason: 'overloaded' });
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 2,
      minDelta: 1,
      batch: 1,
      samplePeers: lightest,
    });
    const outcome = await balancer.balance([{ nodeId: 'peer', pendingSpecs: 0 }]);
    t.equal(outcome.refused, 1, 'the refusal is reported');
    t.equal(outcome.shed, 0, 'nothing was shed');
    t.equal(queue.specs.length, 3, 'the spec came back');
    t.equal(queue.dropped.length, 0, 'and was never dropped');
  });

  it('lets a local reactor beat an in-flight offer', async (t) => {
    const queue = new FakeQueue([1, 2, 3]);
    queue.reclaimOnTake.add(1);
    const transport = transportThat({ accepted: true });
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 2,
      minDelta: 1,
      batch: 1,
      samplePeers: lightest,
    });
    const outcome = await balancer.balance([{ nodeId: 'peer', pendingSpecs: 0 }]);
    t.equal(outcome.reclaimed, 1, 'the local claim is reported');
    t.equal(outcome.shed, 0, 'the reclaimed spec was not shed');
    t.equal(transport.offers.length, 0, 'no offer was made for locally claimed work');
  });

  it('transfers durable ownership before forgetting a shed spec', async (t) => {
    const queue = new FakeQueue([1, 2, 3]);
    const transport = transportThat({ accepted: true });
    const order: string[] = [];
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 2,
      minDelta: 1,
      batch: 1,
      samplePeers: lightest,
      onTransfer: (workloadId, toNodeId) => {
        order.push(`transfer:${workloadId}->${toNodeId}`);
      },
    });
    const originalDrop = queue.drop.bind(queue);
    queue.drop = (handle: number) => {
      order.push('drop');
      originalDrop(handle);
    };
    await balancer.balance([{ nodeId: 'peer', pendingSpecs: 0 }]);
    t.deepEqual(order, ['transfer:1->peer', 'drop'], 'ownership moves before the local release');
  });

  it('treats a transport failure as a refusal', async (t) => {
    const queue = new FakeQueue([1, 2, 3]);
    const balancer = new QueueBalancer(
      queue,
      {
        offer(): Promise<OfferResult> {
          return Promise.reject(new Error('peer unreachable'));
        },
      },
      { highWatermark: 2, minDelta: 1, batch: 1, samplePeers: lightest },
    );
    const outcome = await balancer.balance([{ nodeId: 'peer', pendingSpecs: 0 }]);
    t.equal(outcome.refused, 1, 'an unreachable peer counts as a refusal');
    t.equal(queue.specs.length, 3, 'the spec stayed in the queue');
  });

  it('stops shedding once the local queue is no longer heavy', async (t) => {
    const queue = new FakeQueue([1, 2, 3]);
    const transport = transportThat({ accepted: true });
    const balancer = new QueueBalancer(queue, transport, {
      highWatermark: 3,
      minDelta: 1,
      batch: 10,
      samplePeers: lightest,
    });
    const outcome = await balancer.balance([{ nodeId: 'idle', pendingSpecs: 0 }]);
    t.equal(outcome.shed, 1, 'shedding stops as soon as the watermark is satisfied');
    t.equal(queue.specs.length, 2, 'the node keeps the rest of its work');
  });
});
