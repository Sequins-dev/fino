/** Tests for generic cache policy and HTTP response caching. */
import { describe, it } from 'fino:test/test';
import { cache, responseCache } from 'fino:cache';
import { App } from 'fino:net/http/app';
import { DiskFileSystem } from 'fino:file';
import { memoryStore, sqliteStore, type AtomicExpiringStore, type Store } from 'fino:store';

function fakeClock(now = 1_000) {
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function tmpPath(): string {
  return `/tmp/fino-cache-test-${Math.floor(Math.random() * 1e9)}.db`;
}

function withoutExpiration(store: AtomicExpiringStore): Store {
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key),
    list: (options) => store.list(options),
    namespace: (name) => withoutExpiration(store.namespace(name)),
  };
}

function redisLike(store: AtomicExpiringStore, writes: { count: number }): Store {
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key),
    list: (options) => store.list(options),
    namespace: (name) => redisLike(store.namespace(name), writes),
    expiration: {
      async set(key, value, ttlMs) {
        writes.count++;
        await store.expiration.set(key, value, ttlMs);
      },
    },
  };
}

describe('fino:cache', () => {
  it('delegates TTL to a provider with native expiry', async (t) => {
    const time = fakeClock();
    const writes = { count: 0 };
    const values = cache(redisLike(memoryStore({ clock: time }), writes), { clock: time });
    await values.set('key', new Uint8Array([1, 2]), { ttlMs: 50 });
    t.equal(writes.count, 1, 'cache used the provider expiry capability');
    t.deepEqual(await values.get('key'), new Uint8Array([1, 2]));
    time.advance(51);
    t.equal(await values.get('key'), null, 'provider expiry removes the value');
  });

  it('falls back to lazy expiry for a plain store', async (t) => {
    const time = fakeClock();
    const values = cache(withoutExpiration(memoryStore()), { clock: time });
    await values.set('key', 'value', { ttlMs: 50 });
    time.advance(51);
    t.equal(await values.get('key'), null);
  });

  it('applies namespaces, LRU, and tag invalidation', async (t) => {
    const root = memoryStore();
    const values = cache(root, { maxEntries: 2 });
    const peer = cache(root);
    const tenant = values.namespace('tenant');
    await values.set('same', 'root');
    t.equal(await peer.get('same'), 'root', 'cache views share their selected store');
    await tenant.set('same', 'tenant');
    t.equal(await values.get('same'), 'root');
    t.equal(await tenant.get('same'), 'tenant');

    const lru = cache(memoryStore(), { maxEntries: 2 });
    await lru.set('one', 1);
    await lru.set('two', 2);
    await lru.get('one');
    await lru.set('three', 3);
    t.equal(await lru.get('two'), null, 'least recently used value was evicted');
    await values.set('tagged-a', 'a', { tags: ['flush'] });
    await values.set('tagged-b', 'b', { tags: ['flush'] });
    await values.invalidateTags(['flush']);
    t.equal(await values.get('tagged-a'), null);
    t.equal(await values.get('tagged-b'), null);
  });

  it('uses SQLite through the same cache constructor', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    const store = await sqliteStore({ path, fs });
    try {
      const values = cache(store);
      await values.set('k', { body: new Uint8Array([1, 2, 3]) }, { tags: ['tag'] });
      t.deepEqual(await values.get('k'), { body: new Uint8Array([1, 2, 3]) });
      await values.invalidateTags(['tag']);
      t.equal(await values.get('k'), null);
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });

  it('responseCache stores binary GET responses and respects vary headers', async (t) => {
    const values = cache(memoryStore());
    const app = new App();
    const cached = app.layer(
      responseCache(values, {
        ttlMs: 1_000,
        vary: ['accept-language'],
      }),
    );
    let calls = 0;
    cached.get('/hello').handle((ctx) => {
      calls++;
      const language = ctx.request.headers.get('accept-language') ?? 'none';
      return new Response(new Uint8Array([0, language.charCodeAt(0), calls]));
    });
    const first = await app.handle(
      new Request('http://example.test/hello', { headers: { 'accept-language': 'en' } }),
    );
    t.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([0, 101, 1]));
    t.equal(first.headers.get('x-fino-cache'), 'MISS');
    const second = await app.handle(
      new Request('http://example.test/hello', { headers: { 'accept-language': 'en' } }),
    );
    t.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array([0, 101, 1]));
    t.equal(second.headers.get('x-fino-cache'), 'HIT');
    const third = await app.handle(
      new Request('http://example.test/hello', { headers: { 'accept-language': 'fr' } }),
    );
    t.deepEqual(new Uint8Array(await third.arrayBuffer()), new Uint8Array([0, 102, 2]));
  });

  it('responseCache bypasses unsafe or private responses', async (t) => {
    const app = new App();
    const cached = app.layer(responseCache(cache(memoryStore()), { ttlMs: 1_000 }));
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
