/**
* Tests for the node isolate collection — placement, epoch-CAS leases, release
* reconciliation, and load-driven balancing. Pure main-thread state, no threads.
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

  it('places new work on the least-loaded thread', (t) => {
    const c = twoShards();
    c.recordLoad('shard-0', { shardId: 'shard-0', heldLeases: 4, runnableWorkloads: 5, dispatches: 20, debtMicros: 500 });
    c.recordLoad('shard-1', { shardId: 'shard-1', heldLeases: 0, runnableWorkloads: 0, dispatches: 0, debtMicros: 0 });
    const id = c.deploy({ tenantId: 'acme' });
    t.equal(c.placementOf(id), 'shard-1', 'avoided the loaded thread');
  });
});

describe('node isolate collection leases', () => {
  it('claims placed workloads into epoch-stamped leases and advances state', (t) => {
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
    for (let i = 0; i < 4; i++) c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const leases = c.claim('shard-0', 10);
    t.equal(leases.length, 2, 'capped at the thread capacity');
  });

  it('renews only while the epoch matches, and stops after revoke', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    const [lease] = c.claim('shard-0', 4);
    t.equal(c.renew(lease!.leaseId, lease!.epoch), true, 'valid epoch renews');
    t.equal(c.renew(lease!.leaseId, lease!.epoch + 99), false, 'stale epoch rejected');
    t.equal(c.revoke(id), true, 'revoke bumps the epoch');
    t.equal(c.renew(lease!.leaseId, lease!.epoch), false, 'holder can no longer renew after revoke');
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

describe('node isolate collection wakes', () => {
  it('delivers queued wakes to the hosting thread and clears them', (t) => {
    const c = twoShards(4);
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0' });
    c.claim('shard-0', 4);
    c.enqueueWake(id, { workloadId: id, reason: 'io', sourceId: 's1' });
    const first = c.pollWakes('shard-0');
    t.equal(first.length, 1, 'wake delivered to the hosting thread');
    t.equal(first[0]?.sourceId, 's1');
    t.equal(c.pollWakes('shard-0').length, 0, 'drained after delivery');
    t.equal(c.pollWakes('shard-1').length, 0, 'other thread sees nothing');
  });
});
