/**
 * Tests for fino:cache — namespaces, TTL, tags, backends, and HTTP middleware.
 */
import { describe, it } from 'fino:test/test';
import { memoryCache, responseCache, sqliteCache, type RevisionedCache } from 'fino:cache';
import { App } from 'fino:net/http/app';
import { DiskFileSystem } from 'fino:file';
import { Database } from 'fino:database/sqlite';
function fakeClock(now = 1e3) {
  return {
    now,
    clock: { now: () => now },
    advance(ms: number) {
      now += ms;
    },
  };
}
function tmpPath(): string {
  return `/tmp/fino-cache-test-${Math.floor(Math.random() * 1e9)}.db`;
}
async function assertRevisionedCache(t: any, cache: RevisionedCache): Promise<void> {
  t.equal(await cache.getEntry('missing'), null, 'missing entry has no revision');
  const created = await cache.compareAndSet('key', { value: 1 }, { ifRevision: null });
  t.ok(created !== null, 'missing entry can be created conditionally');
  t.deepEqual(created!.value, { value: 1 });
  const duplicate = await cache.compareAndSet('key', { value: 2 }, { ifRevision: null });
  t.equal(duplicate, null, 'create-only write rejects an existing entry');
  const updated = await cache.compareAndSet('key', { value: 2 }, { ifRevision: created!.revision });
  t.ok(updated !== null, 'matching revision updates the entry');
  t.notEqual(updated!.revision, created!.revision, 'successful writes advance the revision');
  const stale = await cache.compareAndSet('key', { value: 3 }, { ifRevision: created!.revision });
  t.equal(stale, null, 'stale revision rejects without overwriting');
  t.deepEqual(await cache.get('key'), { value: 2 });
}
describe('fino:cache', () => {
  it('memory cache provides atomic revisioned writes', async (t) => {
    await assertRevisionedCache(t, memoryCache());
  });
  it('sqlite cache provides atomic revisioned writes', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const cache = await sqliteCache({
      path,
      fs,
    });
    try {
      await assertRevisionedCache(t, cache);
    } finally {
      await cache.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('sqlite cache upgrades existing databases with revision metadata', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const db = await Database.open(path, { fs });
    await db.exec(`CREATE TABLE fino_cache_entries (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER,
      touched_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)
    )`);
    await db.exec(`CREATE TABLE fino_cache_tags (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY(namespace, key, tag)
    )`);
    await db
      .prepare(
        `INSERT INTO fino_cache_entries(namespace, key, value, expires_at, touched_at) VALUES(?, ?, ?, ?, ?)`,
      )
      .run('default', 'legacy', '"value"', null, 1);
    await db.close();
    const cache = await sqliteCache({
      path,
      fs,
    });
    try {
      const entry = await cache.getEntry<string>('legacy');
      t.equal(entry!.value, 'value');
      t.ok(entry!.revision.length > 0, 'legacy entry receives an opaque revision');
      const updated = await cache.compareAndSet('legacy', 'updated', {
        ifRevision: entry!.revision,
      });
      t.equal(updated!.value, 'updated');
    } finally {
      await cache.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('memory cache applies TTL, namespaces, LRU, and tag invalidation', async (t) => {
    const time = fakeClock();
    const cache = memoryCache({
      maxEntries: 2,
      clock: time.clock,
    });
    await cache.set(
      'a',
      { n: 1 },
      {
        ttlMs: 50,
        tags: ['group'],
      },
    );
    t.deepEqual(await cache.get('a'), { n: 1 });
    time.advance(51);
    t.equal(await cache.get('a'), null, 'expired entries return null');
    const ns = cache.namespace('tenant');
    await cache.set('same', 'root');
    await ns.set('same', 'scoped');
    t.equal(await cache.get('same'), 'root');
    t.equal(await ns.get('same'), 'scoped');
    await cache.set('one', 1);
    await cache.set('two', 2);
    await cache.get('one');
    await cache.set('three', 3);
    t.equal(await cache.get('one'), 1, 'recently read entry is retained');
    t.equal(await cache.get('two'), null, 'least recently used entry is evicted');
    t.equal(await cache.get('three'), 3);
    await cache.set('tagged-a', 'a', { tags: ['flush'] });
    await cache.set('tagged-b', 'b', { tags: ['flush'] });
    await cache.invalidateTags(['flush']);
    t.equal(await cache.get('tagged-a'), null);
    t.equal(await cache.get('tagged-b'), null);
  });
  it('sqlite cache persists values and invalidates by namespace-local tags', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const cache = await sqliteCache({
      path,
      fs,
    });
    try {
      await cache.set('k', { ok: true }, { tags: ['tag'] });
      t.deepEqual(await cache.get('k'), { ok: true });
      const scoped = cache.namespace('scoped');
      await scoped.set('k', 'scoped', { tags: ['tag'] });
      await cache.invalidateTags(['tag']);
      t.equal(await cache.get('k'), null, 'root namespace tag was invalidated');
      t.equal(await scoped.get('k'), 'scoped', 'other namespace is retained');
    } finally {
      await cache.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('responseCache stores cacheable GET responses and respects vary headers', async (t) => {
    const cache = memoryCache();
    const app = new App();
    const cached = app.layer(
      responseCache(cache, {
        ttlMs: 1e3,
        vary: ['accept-language'],
      }),
    );
    let calls = 0;
    cached.get('/hello').handle((ctx) => {
      calls++;
      return new Response(
        `hello ${ctx.request.headers.get('accept-language') ?? 'none'} ${calls}`,
        { headers: { 'content-type': 'text/plain' } },
      );
    });
    const first = await app.handle(
      new Request('http://example.test/hello', { headers: { 'accept-language': 'en' } }),
    );
    t.equal(await first.text(), 'hello en 1');
    t.equal(first.headers.get('x-fino-cache'), 'MISS');
    const second = await app.handle(
      new Request('http://example.test/hello', { headers: { 'accept-language': 'en' } }),
    );
    t.equal(await second.text(), 'hello en 1');
    t.equal(second.headers.get('x-fino-cache'), 'HIT');
    const third = await app.handle(
      new Request('http://example.test/hello', { headers: { 'accept-language': 'fr' } }),
    );
    t.equal(await third.text(), 'hello fr 2');
    t.equal(third.headers.get('x-fino-cache'), 'MISS');
  });
  it('responseCache bypasses unsafe or private responses', async (t) => {
    const cache = memoryCache();
    const app = new App();
    const cached = app.layer(responseCache(cache, { ttlMs: 1e3 }));
    let calls = 0;
    cached.post('/mutate').handle(() => new Response('mutated'));
    cached.get('/private').handle(() => {
      calls++;
      return new Response(`private ${calls}`, { headers: { 'set-cookie': 'sid=1' } });
    });
    const post = await app.handle(new Request('http://example.test/mutate', { method: 'POST' }));
    t.equal(post.headers.get('x-fino-cache'), 'BYPASS');
    const one = await app.handle(new Request('http://example.test/private'));
    const two = await app.handle(new Request('http://example.test/private'));
    t.equal(await one.text(), 'private 1');
    t.equal(await two.text(), 'private 2');
    t.equal(two.headers.get('x-fino-cache'), 'BYPASS');
  });
});
