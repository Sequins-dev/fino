/**
* Tests for the node isolate collection — allocator-driven placement, leases,
* release reconciliation, and load-driven balancing. Pure main-thread state, no
* threads.
*/
import { describe, it } from 'fino:test/test';
import { NodeIsolateCollection } from 'internal:orchestrator/node';

function twoShards(capacity = 8): NodeIsolateCollection {
  const c = new NodeIsolateCollection();
  c.registerShard('shard-0', capacity);
  c.registerShard('shard-1', capacity);
  return c;
}

describe('node isolate collection placement', () => {
  it('spreads unpinned workloads evenly across threads', (t) => {
    const c = twoShards();
    for (let i = 0; i < 4; i++) c.deploy({ tenantId: 'acme' });
    t.equal(c.workloadsOn('shard-0').length, 2, 'shard-0 got half');
    t.equal(c.workloadsOn('shard-1').length, 2, 'shard-1 got half');
  });

  it('hard-pins a workload to its affinity thread', (t) => {
    const c = twoShards();
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-1' });
    t.equal(c.placementOf(id), 'shard-1');
  });

  it('defaults local mobility on and honors explicit pins', (t) => {
    const c = twoShards(4);
    const movable = c.deploy({ tenantId: 'acme' });
    const pinned = c.deploy({ tenantId: 'acme', localMobility: 'pinned' });
    const affinity = c.deploy({ tenantId: 'core', affinity: 'shard-1' });
    t.equal(c.isLocallyMovable(movable), true, 'ordinary pooled work is movable');
    t.equal(c.isLocallyMovable(pinned), false, 'explicit local pin is honored');
    t.equal(c.isLocallyMovable(affinity), false, 'hard affinity also implies a local pin');
  });

  it('defaults realms to replicated latency placement and isolates bound state on batch reactors', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('latency-0', 4, 'latency');
    c.registerShard('batch-0', 4, 'batch');
    const replicated = c.deploy({ tenantId: 'acme' });
    const bound = c.deploy({ tenantId: 'acme', replication: 'bound' });
    t.equal(c.replicationOf(replicated), 'replicated', 'omitted policy defaults to replicated');
    t.equal(c.placementOf(replicated), 'latency-0', 'replicated work receives latency placement');
    t.equal(c.replicationOf(bound), 'bound', 'bound state is recorded');
    t.equal(c.placementOf(bound), 'batch-0', 'bound state is isolated on a lower-priority reactor');
  });

  it('colocates a workload with a named sibling', (t) => {
    const c = twoShards();
    const a = c.deploy({ tenantId: 'acme', affinity: 'shard-1' });
    const b = c.deploy({ tenantId: 'acme', colocateWith: a });
    t.equal(c.placementOf(b), 'shard-1', 'b followed a onto shard-1');
  });

  it('rejects deploy when no thread is registered', (t) => {
    const c = new NodeIsolateCollection();
    t.throws(() => c.deploy({ tenantId: 'acme' }), /no scheduler threads/);
  });

  it('rejects affinity that would over-subscribe a thread instead of stranding it', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('shard-0', 2);
    c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    // Third pin exceeds capacity 2 — must throw rather than place-but-never-claim.
    t.throws(() => c.deploy({ tenantId: 'acme', affinity: 'shard-0' }), /at capacity/);
  });

  it('rejects deploy when every thread is at capacity', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('shard-0', 1);
    c.registerShard('shard-1', 1);
    c.deploy({ tenantId: 'acme' });
    c.deploy({ tenantId: 'acme' });
    t.throws(() => c.deploy({ tenantId: 'acme' }), /all scheduler threads at capacity/);
  });

  it('places new work on the least-loaded thread', (t) => {
    const c = twoShards();
    c.recordLoad('shard-0', { shardId: 'shard-0', heldLeases: 4, runnableWorkloads: 5, dispatches: 20, debtMicros: 500 });
    c.recordLoad('shard-1', { shardId: 'shard-1', heldLeases: 0, runnableWorkloads: 0, dispatches: 0, debtMicros: 0 });
    const id = c.deploy({ tenantId: 'acme' });
    t.equal(c.placementOf(id), 'shard-1', 'avoided the loaded thread');
  });
});

describe('node isolate collection leases', () => {
  it('claims placed workloads into leases and advances state', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0', entryPath: '/w.ts', data: { k: 1 } });
    const leases = c.claim('shard-0', 4);
    t.equal(leases.length, 1);
    t.equal(leases[0]?.workloadId, id);
    t.equal(leases[0]?.entryPath, '/w.ts', 'entry path carried to the lease');
    t.deepEqual(leases[0]?.data, { k: 1 }, 'data carried to the lease');
    t.equal(c.record(id)?.state, 'claimed');
    t.equal(c.leaseOf(id), leases[0]?.leaseId);
    t.equal(c.placementOf(id), 'shard-0');
  });

  it('never claims more than the thread capacity', (t) => {
    const c = twoShards(2);
    c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const leases = c.claim('shard-0', 10);
    t.equal(leases.length, 2, 'capped at the thread capacity even when more is requested');
  });
});

describe('node isolate collection release', () => {
  it('drops terminated workloads out of the collection', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const [lease] = c.claim('shard-0', 4);
    c.release(lease!.leaseId, 'terminated');
    t.equal(c.record(id), undefined, 'record removed');
    t.equal(c.leaseOf(id), null, 'lease removed');
  });

  it('keeps a failed workload observable as failed', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const [lease] = c.claim('shard-0', 4);
    c.release(lease!.leaseId, 'failed');
    t.equal(c.record(id)?.state, 'failed');
    t.equal(c.leaseOf(id), null);
  });

  it('does not let an observable failed workload consume reactor capacity', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('shard-0', 1);
    const id = c.deploy({ tenantId: 'acme' });
    const [lease] = c.claim('shard-0', 1);
    c.release(lease!.leaseId, 'failed');

    t.equal(c.record(id)?.state, 'failed');
    t.equal(c.placementOf(id), null, 'failed record no longer owns a placement');
    t.ok(c.deploy({ tenantId: 'replacement' }), 'capacity can admit a replacement');
  });

  it('re-places a workload whose lease renewal failed', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const [lease] = c.claim('shard-0', 4);
    c.release(lease!.leaseId, 'renew_failed');
    t.equal(c.record(id)?.state, 'unclaimed', 'back to unclaimed for re-placement');
    t.equal(c.placementOf(id), 'shard-1', 're-placed off the original thread');
    const reclaimed = c.claim('shard-1', 4);
    t.equal(reclaimed[0]?.workloadId, id, 'the other thread can reclaim it');
  });

  it('ignores a release for a stale lease id', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const [lease] = c.claim('shard-0', 4);
    c.release(lease!.leaseId, 'renew_failed');
    // A second, stale release must not double-move the workload.
    c.release(lease!.leaseId, 'renew_failed');
    t.equal(c.record(id)?.state, 'unclaimed');
    t.equal(c.placementOf(id), 'shard-1');
  });
});

describe('workload allocator', () => {
  it('routes fresh work to latency threads, never batch', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('latency-0', 4, 'latency');
    c.registerShard('batch-0', 4, 'batch');
    for (let i = 0; i < 4; i++) c.deploy({ tenantId: 'acme' });
    t.equal(c.workloadsOn('batch-0').length, 0, 'batch thread got no fresh placement');
    t.equal(c.workloadsOn('latency-0').length, 4, 'all fresh work went to the latency thread');
  });

  it('targets the least-loaded thread of a class for migration', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('latency-0', 4, 'latency');
    c.registerShard('batch-0', 4, 'batch');
    c.registerShard('batch-1', 4, 'batch');
    const alloc = c.allocator();
    alloc.recordLoad('batch-0', { shardId: 'batch-0', heldLeases: 3, runnableWorkloads: 3, dispatches: 9, debtMicros: 0 });
    alloc.recordLoad('batch-1', { shardId: 'batch-1', heldLeases: 0, runnableWorkloads: 0, dispatches: 0, debtMicros: 0 });
    t.equal(alloc.leastLoadedOfClass('batch'), 'batch-1', 'picked the idle batch thread');
    t.equal(alloc.leastLoadedOfClass('nonexistent' as 'batch'), null, 'empty class returns null');
  });

  it('excludes full threads from class migration targets', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('batch-full', 0, 'batch');
    c.registerShard('batch-room', 1, 'batch');
    t.equal(c.allocator().leastLoadedOfClass('batch'), 'batch-room', 'only a destination with capacity is eligible');
  });

  it('reports no room once a thread is at capacity', (t) => {
    const c = new NodeIsolateCollection();
    c.registerShard('shard-0', 1);
    const alloc = c.allocator();
    t.equal(alloc.hasRoom('shard-0'), true, 'room before placing');
    c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    t.equal(alloc.hasRoom('shard-0'), false, 'full after placing to capacity');
  });
});
