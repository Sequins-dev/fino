/** Tests for generic stores and their optional provider capabilities. */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { cache } from 'fino:cache';
import {
  memoryStore,
  sqliteStore,
  type AtomicExpiringStore,
  type Store,
  type StoreCodec,
} from 'fino:store';
import { loadViewState, saveViewState } from 'fino:ui/web/state';
import { listWorkflowRuns, loadWorkflowRun, saveWorkflowRun } from 'fino:workflow';

function tmpPath(): string {
  return `/tmp/fino-store-test-${Math.floor(Math.random() * 1e9)}.db`;
}

function fakeClock(now = 1_000) {
  return {
    clock: { now: () => now },
    advance(ms: number) {
      now += ms;
    },
  };
}

async function assertStoreContract(t: any, store: Store): Promise<void> {
  t.equal(await store.get('missing'), null);
  await store.set('item/2', { nested: { value: 1 } });
  await store.set('item/1', 'one');
  t.deepEqual(
    (await store.list({ prefix: 'item/' })).map((entry) => entry.key),
    ['item/1', 'item/2'],
    'prefix listing uses deterministic key order',
  );

  const scoped = store.namespace('child');
  await scoped.set('item/1', 'child');
  t.equal(await scoped.get('item/1'), 'child');
  t.equal(await store.get('item/1'), 'one', 'namespaces do not collide');
  t.equal(await store.delete('item/1'), true);
  t.equal(await store.delete('item/1'), false);
}

async function assertAtomicContract(t: any, store: AtomicExpiringStore): Promise<void> {
  const created = await store.atomic.commit({
    checks: [{ key: 'atomic', ifVersion: null }],
    writes: [{ key: 'atomic', value: 'one' }],
  });
  t.ok(created);
  const first = created!.writes[0]!;
  t.equal(
    await store.atomic.commit({
      checks: [{ key: 'atomic', ifVersion: null }],
      writes: [{ key: 'atomic', value: 'duplicate' }],
    }),
    null,
  );
  const updated = await store.atomic.commit({
    checks: [{ key: 'atomic', ifVersion: first.version }],
    writes: [
      { key: 'atomic', value: 'updated' },
      { key: 'related', value: { ok: true } },
    ],
  });
  t.ok(updated);
  t.notEqual(updated!.writes[0]!.version, first.version);
  t.equal(
    await store.atomic.commit({
      checks: [{ key: 'atomic', ifVersion: first.version }],
      writes: [{ key: 'related', value: { ok: false } }],
      deletes: ['atomic'],
    }),
    null,
  );
  t.equal(await store.get('atomic'), 'updated');
  t.deepEqual(await store.get('related'), { ok: true }, 'failed commits write nothing');
}

describe('fino:store', () => {
  it('memoryStore retains arbitrary values without encoding or cloning', async (t) => {
    const store = memoryStore();
    await assertStoreContract(t, store);
    const object = { bigint: 1n };
    const bytes = new Uint8Array([1, 2, 3]);
    await store.set('object', object);
    await store.set('bytes', bytes);
    t.equal(await store.get('object'), object, 'memory values retain identity');
    t.equal(await store.get('bytes'), bytes, 'memory bytes retain identity');
    await assertAtomicContract(t, store);
  });

  it('sqliteStore owns serialization and round-trips binary values', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    const store = await sqliteStore({ path, fs });
    try {
      await assertStoreContract(t, store);
      const bytes = new Uint8Array([0, 1, 127, 255]);
      await store.set('bytes', bytes);
      await store.set('nested', { body: bytes, items: [bytes] });
      t.deepEqual(await store.get('bytes'), bytes);
      t.deepEqual(await store.get('nested'), { body: bytes, items: [bytes] });
      await t.rejects(() => store.set('bigint', 1n), /cannot encode bigint/);
      await assertAtomicContract(t, store);
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });

  it('provider expiry applies to ordinary and atomic writes', async (t) => {
    const time = fakeClock();
    const store = memoryStore({ clock: time.clock });
    await store.expiration.set('ordinary', true, 50);
    const committed = await store.atomic.commit({
      writes: [{ key: 'atomic', value: true, ttlMs: 50 }],
    });
    t.ok(committed);
    time.advance(51);
    t.equal(await store.get('ordinary'), null);
    t.equal(await store.atomic.getEntry('atomic'), null);
    t.deepEqual(await store.list(), []);
  });

  it('lets a backing provider choose a non-JSON codec', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    const codec: StoreCodec = {
      encode(value) {
        return new TextEncoder().encode((value as bigint).toString(16));
      },
      decode(bytes) {
        return BigInt(`0x${new TextDecoder().decode(bytes)}`);
      },
    };
    const store = await sqliteStore({ path, fs, codec });
    try {
      await store.set('large', 0x1234_5678_9abcn);
      t.equal(await store.get('large'), 0x1234_5678_9abcn);
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });

  it('shares one root safely across generic cache and domain codecs', async (t) => {
    const root = memoryStore();
    const values = cache(root);
    await saveWorkflowRun(root, {
      runId: 'same',
      workflowId: 'example',
      status: 'done',
      cursor: 0,
      input: null,
      steps: [],
      state: {},
      signals: [],
      createdAt: 1,
      updatedAt: 2,
      result: 'workflow',
    });
    await saveViewState(root, {
      viewId: 'same',
      view: 'example',
      version: 0,
      data: { source: 'view' },
      regions: {},
      applied: [],
      createdAt: 1,
      updatedAt: 2,
      expiresAt: 10_000,
    });
    await values.set('same', 'cache');
    await root.set('same', 'application');

    t.equal((await loadWorkflowRun(root, 'same'))?.result, 'workflow');
    const listed = await listWorkflowRuns(root);
    listed[0]!.state.mutated = true;
    t.equal(
      (await loadWorkflowRun(root, 'same'))?.state.mutated,
      undefined,
      'workflow codec detaches values retained by memoryStore',
    );
    t.deepEqual((await loadViewState(root, 'same'))?.data, { source: 'view' });
    t.equal(await values.get('same'), 'cache');
    t.equal(await root.get('same'), 'application');
  });

  it('sqliteStore conditional commits are atomic across connections', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    const left = await sqliteStore({ path, fs });
    const right = await sqliteStore({ path, fs });
    try {
      for (let round = 0; round < 16; round++) {
        await left.set('shared', round);
        const initial = await left.atomic.getEntry('shared');
        const results = await Promise.all([
          left.atomic.commit({
            checks: [{ key: 'shared', ifVersion: initial!.version }],
            writes: [{ key: 'shared', value: round * 2 + 1 }],
          }),
          right.atomic.commit({
            checks: [{ key: 'shared', ifVersion: initial!.version }],
            writes: [{ key: 'shared', value: round * 2 + 2 }],
          }),
        ]);
        t.equal(results.filter(Boolean).length, 1, 'exactly one contender commits');
        t.ok([round * 2 + 1, round * 2 + 2].includes((await left.get<number>('shared'))!));
      }
    } finally {
      await left.close();
      await right.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
