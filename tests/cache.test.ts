/**
* Tests for fino:cache — namespaces, TTL, tags, backends, and HTTP middleware.
*/
import { describe, it } from 'fino:test/test';
import { memoryCache, responseCache, sqliteCache } from 'fino:cache';
import { App } from 'fino:net/http/app';
import { DiskFileSystem } from 'fino:file';

function fakeClock(now = 1_000) {
  return {
    now,
    clock: { now: () => now },
    advance(ms: number) {
      now += ms;
    }
  };
}

function tmpPath(): string {
  return `/tmp/fino-cache-test-${Math.floor(Math.random() * 1e9)}.db`;
}

describe('fino:cache', () => {
  it('memory cache applies TTL, namespaces, LRU, and tag invalidation', async (t) => {
    const time = fakeClock();
    const cache = memoryCache({ maxEntries: 2, clock: time.clock });
    await cache.set('a', { n: 1 }, { ttlMs: 50, tags: ['group'] });
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
    const cache = await sqliteCache({ path, fs });
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
    const app = new App().use(responseCache(cache, { ttlMs: 1_000, vary: ['accept-language'] }));
    let calls = 0;
    app.get('/hello', (ctx) => {
      calls++;
      return new Response(`hello ${ctx.request.headers.get('accept-language') ?? 'none'} ${calls}`, {
        headers: { 'content-type': 'text/plain' }
      });
    });
    const first = await app.handle(new Request('http://example.test/hello', { headers: { 'accept-language': 'en' } }));
    t.equal(await first.text(), 'hello en 1');
    t.equal(first.headers.get('x-fino-cache'), 'MISS');
    const second = await app.handle(new Request('http://example.test/hello', { headers: { 'accept-language': 'en' } }));
    t.equal(await second.text(), 'hello en 1');
    t.equal(second.headers.get('x-fino-cache'), 'HIT');
    const third = await app.handle(new Request('http://example.test/hello', { headers: { 'accept-language': 'fr' } }));
    t.equal(await third.text(), 'hello fr 2');
    t.equal(third.headers.get('x-fino-cache'), 'MISS');
  });

  it('responseCache bypasses unsafe or private responses', async (t) => {
    const cache = memoryCache();
    const app = new App().use(responseCache(cache, { ttlMs: 1_000 }));
    let calls = 0;
    app.post('/mutate', () => new Response('mutated'));
    app.get('/private', () => {
      calls++;
      return new Response(`private ${calls}`, {
        headers: { 'set-cookie': 'sid=1' }
      });
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
