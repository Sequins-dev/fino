/**
 * The durable workload ledger: records outlive the node processing them, and
 * lease expiry is what returns work to the pool after a crash.
 */
import { describe, it } from 'fino:test/test';
import { WorkloadLedger } from 'internal:cluster/ledger';

async function tempLedger(name: string): Promise<WorkloadLedger> {
  return WorkloadLedger.open(`/tmp/fino-ledger-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

describe('workload ledger', () => {
  it('commits records and grants them to exactly one claimant', async (t) => {
    const ledger = await tempLedger('claim');
    try {
      const committed = await ledger.commit('node-a/1', '{"entry":"/app/main.ts"}');
      t.equal(committed.state, 'unclaimed', 'a fresh record is grantable');
      t.equal(committed.epoch, 0, 'epoch starts at zero');

      const first = await ledger.claim('node-a/1', 'node-a', 7, 60_000);
      t.ok(first !== null, 'the first claimant wins');
      t.equal(first!.owner, 'node-a', 'ownership recorded');
      t.equal(first!.ownerIncarnation, 7, 'owner incarnation recorded');
      t.ok(first!.epoch > committed.epoch, 'ownership change bumps the epoch');

      const second = await ledger.claim('node-a/1', 'node-b', 3, 60_000);
      t.equal(second, null, 'a second claimant is refused while the lease holds');
    } finally {
      await ledger.close();
    }
  });

  it('refuses grants computed against a stale epoch', async (t) => {
    const ledger = await tempLedger('epoch');
    try {
      const record = await ledger.commit('node-a/2', '{}');
      await ledger.claim('node-a/2', 'node-a', 1, 60_000);
      await ledger.release('node-a/2', 'node-a');
      const stale = await ledger.claim('node-a/2', 'node-b', 1, 60_000, {
        expectEpoch: record.epoch,
      });
      t.equal(stale, null, 'a grant against the pre-release epoch is refused');
      const fresh = await ledger.get('node-a/2');
      const granted = await ledger.claim('node-a/2', 'node-b', 1, 60_000, {
        expectEpoch: fresh!.epoch,
      });
      t.ok(granted !== null, 'a grant against the current epoch succeeds');
    } finally {
      await ledger.close();
    }
  });

  it('returns lease-expired work to the pool and pins initialized work', async (t) => {
    const ledger = await tempLedger('expiry');
    try {
      const now = Date.now();
      await ledger.commit('node-a/3', '{}', now);
      await ledger.claim('node-a/3', 'node-a', 1, 1000, { now });
      t.deepEqual(await ledger.sweepExpired(now + 500), [], 'a live lease is not swept');

      const reclaimed = await ledger.sweepExpired(now + 2000);
      t.equal(reclaimed.length, 1, 'the expired lease is reclaimed');
      t.equal(reclaimed[0]!.state, 'unclaimed', 'the record returns to the pool');
      t.equal(reclaimed[0]!.owner, null, 'ownership is cleared');

      const regranted = await ledger.claim('node-a/3', 'node-b', 2, 60_000, { now: now + 2000 });
      t.ok(regranted !== null, 'another node can take the reclaimed record');

      const initialized = await ledger.markInitialized('node-a/3', 'node-b', 2, now + 2100);
      t.ok(initialized !== null, 'the owner can mark it initialized');
      t.equal(initialized!.state, 'initialized', 'state advances to initialized');
      const stolen = await ledger.claim('node-a/3', 'node-c', 1, 60_000, { now: now + 2200 });
      t.equal(stolen, null, 'an initialized workload is pinned to its owner');
    } finally {
      await ledger.close();
    }
  });

  it('survives a leader restart and re-offers outstanding work', async (t) => {
    const path = `/tmp/fino-ledger-restart-${Date.now()}.db`;
    const first = await WorkloadLedger.open(path);
    const now = Date.now();
    try {
      await first.commit('node-a/4', '{"entry":"/app/a.ts"}', now);
      await first.commit('node-a/5', '{"entry":"/app/b.ts"}', now);
      await first.claim('node-a/5', 'node-a', 1, 500, { now });
    } finally {
      await first.close();
    }

    const reopened = await WorkloadLedger.open(path);
    try {
      const survived = await reopened.get('node-a/4');
      t.ok(survived !== null, 'records survive the restart');
      t.equal(survived!.spec, '{"entry":"/app/a.ts"}', 'the serialized spec survives intact');

      const grantable = await reopened.grantable(now + 5000);
      const ids = grantable.map((r) => r.id).sort();
      t.deepEqual(ids, ['node-a/4', 'node-a/5'], 'unclaimed and lease-expired work is re-offered');

      const owned = await reopened.ownedBy('node-a');
      t.equal(owned.length, 1, 'ownership is still visible before the sweep');
    } finally {
      await reopened.close();
    }
  });
});

describe('deployment records', () => {
  it('tracks generations with immutable history and instant rollback', async (t) => {
    const ledger = await tempLedger('deployments');
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);

    const gen1 = await ledger.recordDeployment('web', hashA, 'main.ts');
    t.equal(gen1.generation, 1, 'first deploy is generation 1');
    t.equal(gen1.state, 'active', 'and active');

    const gen2 = await ledger.recordDeployment('web', hashB, 'main.ts');
    t.equal(gen2.generation, 2, 'second deploy increments');
    const active = await ledger.activeDeployment('web');
    t.equal(active?.caskHash, hashB, 'the new generation is active');

    const history = await ledger.deployments('web');
    t.equal(history.length, 2, 'history is retained');
    t.equal(history[1]?.state, 'superseded', 'the old generation is superseded, not deleted');

    const rolled = await ledger.rollbackDeployment('web');
    t.equal(rolled?.generation, 3, 'rollback is a NEW generation');
    t.equal(rolled?.caskHash, hashA, 'pointing at the previous cask');
    t.equal((await ledger.activeDeployment('web'))?.caskHash, hashA, 'and now active');

    t.equal(await ledger.rollbackDeployment('brand-new'), null, 'nothing to roll back to');

    const referenced = await ledger.referencedCaskHashes();
    t.ok(referenced.has(hashA) && referenced.has(hashB), 'every generation pins its cask for GC');
    await ledger.close();
  });
});
