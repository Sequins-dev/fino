/**
* Handoff, recovery, and locality/spread for the node isolate collection. A
* tenant isolate cannot be moved across OS threads, so a move is drain →
* data-only snapshot → transfer lease + snapshot → reconstruct. These tests
* prove the pending work (messages, timers, in-flight facade ops) survives the
* transfer, and that a failed thread's workloads are recovered onto survivors.
*/
import { describe, it } from 'fino:test/test';
import { NodeIsolateCollection } from 'internal:orchestrator/node';
import { captureHandoff, reconstructRecord, createWorkloadRecord } from 'internal:scheduler/workload';

function twoShards(capacity = 4): NodeIsolateCollection {
  const c = new NodeIsolateCollection();
  c.registerShard('shard-0', capacity);
  c.registerShard('shard-1', capacity);
  return c;
}

const PENDING = {
  mailbox: [{ sequence: 1, data: 'm1' }, { sequence: 2, data: 'm2' }],
  timers: [{ id: 't1', dueAtNanos: 1000, kind: 'timeout' as const }],
  facadeOps: [{ id: 5, provider: 'file', method: 'readFile', args: { path: '/x' } }]
};

describe('handoff snapshot', () => {
  it('captures pending work as pure data and preserves identity on reconstruct', (t) => {
    const record = createWorkloadRecord({ tenantId: 'acme', workloadId: 'w1', isolateId: 'iso1', priority: 'interactive' });
    record.budget.debtMicros = 700;
    const snapshot = captureHandoff(record, { entryPath: '/w.ts', ...PENDING }, 42);

    t.equal(snapshot.mailbox.length, 2, 'messages captured');
    t.equal(snapshot.timers[0]?.id, 't1', 'timers captured');
    t.equal(snapshot.facadeOps[0]?.method, 'readFile', 'facade ops captured');
    t.equal(snapshot.capturedAtNanos, 42);

    // The snapshot is a deep copy: mutating the live record must not change it.
    record.budget.debtMicros = 0;
    t.equal(snapshot.record.budget.debtMicros, 700, 'snapshot record is decoupled from the live record');

    const rebuilt = reconstructRecord(snapshot);
    t.equal(rebuilt.workloadId, 'w1');
    t.equal(rebuilt.priority, 'interactive', 'priority carried over');
    t.equal(rebuilt.budget.debtMicros, 700, 'accumulated debt carried over');
    t.equal(rebuilt.state, 'unclaimed', 'ready to be reclaimed');
    t.equal(rebuilt.threadId, null, 'thread binding reset');
    t.equal(rebuilt.counters.mailboxDepth, 2, 'mailbox depth reflects pending messages');
  });
});

describe('node collection handoff', () => {
  it('moves a workload to another thread carrying its pending work', (t) => {
    const c = twoShards();
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0', entryPath: '/w.ts', data: { seed: 1 } });
    c.claim('shard-0', 4);

    c.drainForHandoff(id);
    t.equal(c.record(id)?.state, 'draining', 'walked to draining');
    c.completeHandoff(id, PENDING, 99);
    t.equal(c.record(id)?.state, 'handoff_ready', 'quiesced to handoff_ready');
    t.equal(c.leaseOf(id), null, 'old lease dropped');

    const target = c.placeHandoff(id, 'shard-1');
    t.equal(target, 'shard-1');
    t.equal(c.record(id)?.state, 'unclaimed', 're-placed for reclaim');

    const [lease] = c.claim('shard-1', 4);
    t.equal(lease?.workloadId, id, 'destination reclaimed it');
    t.equal(lease?.handoff?.mailbox.length, 2, 'messages survived the transfer');
    t.equal(lease?.handoff?.timers[0]?.id, 't1', 'timers survived the transfer');
    t.equal(lease?.handoff?.facadeOps[0]?.method, 'readFile', 'facade ops survived the transfer');
    t.equal(c.snapshotOf(id), undefined, 'snapshot handed over exactly once');
  });

  it('defaults the destination to the least-loaded thread other than the source', (t) => {
    const c = twoShards();
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0', entryPath: '/w.ts' });
    c.claim('shard-0', 4);
    c.drainForHandoff(id);
    c.completeHandoff(id, {}, 1);
    const target = c.placeHandoff(id);
    t.equal(target, 'shard-1', 'moved off the source thread');
  });
});

describe('node collection recovery', () => {
  it('respawns a failed thread\'s workloads from their record and entry onto survivors', (t) => {
    const c = twoShards();
    const id = c.deploy({ tenantId: 'acme', affinity: 'shard-0', entryPath: '/w.ts' });
    c.claim('shard-0', 4);

    // Crash recovery respawns from the entry (pending in-flight work is lost on a
    // hard crash — periodic checkpointing is intentionally not wired).
    const recovered = c.recoverShard('shard-0');
    t.deepEqual(recovered, [id], 'the workload was respawned');
    t.equal(c.placementOf(id), 'shard-1', 're-placed on the survivor');
    t.equal(c.record(id)?.state, 'unclaimed');
    t.equal(c.snapshotOf(id), undefined, 'no snapshot — respawned fresh from the entry');
    const [lease] = c.claim('shard-1', 4);
    t.equal(lease?.workloadId, id, 'the survivor reclaimed it');
    t.equal(lease?.handoff, undefined, 'reclaimed without pending work');
  });
});
