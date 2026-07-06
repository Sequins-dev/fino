/**
* fino:cache — small application cache abstraction with memory, SQLite, and HTTP helpers.
*
* This module provides local cache primitives for application code that needs
* short-lived reuse without committing to a distributed cache contract. Cache
* entries are scoped by namespace, expire by millisecond TTL, and can be
* invalidated through tags. Values are serialized as JSON so the memory and
* SQLite backends share one observable value model.
*
* ## Design
*
* A `Cache` is a simple async key/value interface. `memoryCache()` is an LRU
* cache intended for tests and single-process applications; `sqliteCache()`
* persists entries through `fino:database/sqlite` and the configured
* filesystem provider. `responseCache()` is a layer for `fino:net/http/app`
* and caches safe `GET`/`HEAD` responses by method, URL, and configured vary
* headers, stamping each response with an `x-fino-cache` diagnostic header.
*
* Expiry is lazy: expired entries are removed by the read that observes them,
* not by a background sweeper.
*
* This is deliberately not a distributed systems layer. There is no cross-
* process invalidation for memory caches, no cluster coherence, and no binary
* structured-clone value support in this baseline.
*
* ```ts no_run
* import { memoryCache, responseCache } from 'fino:cache';
* import { App } from 'fino:net/http/app';
*
* const cache = memoryCache({ maxEntries: 1_000 });
* await cache.set('user:1', { name: 'Ada' }, { ttlMs: 60_000, tags: ['users'] });
* const user = await cache.get('user:1');
*
* const app = new App().layer(responseCache(cache, { ttlMs: 5_000 }));
* ```
*/
import { Database } from 'fino:database/sqlite';
import type { FileSystem } from 'internal:file/provider';
import { defineMiddleware, type LayerMiddleware } from 'fino:net/http/app';

/**
* Clock used by cache backends to decide when entries expire.
*
* Both `memoryCache()` and `sqliteCache()` read the clock on every operation
* and compare it against each entry's stored expiry. Supplying a fake clock
* makes TTL behavior deterministic in tests: advance the fake time instead of
* sleeping.
*
* ```ts no_run
* import { memoryCache, type CacheClock } from 'fino:cache';
*
* let now = 0;
* const clock: CacheClock = { now: () => now };
* const cache = memoryCache({ clock });
*
* await cache.set('k', 'v', { ttlMs: 50 });
* now += 51;
* await cache.get('k'); // null — expired without waiting
* ```
*/
export interface CacheClock {
  /** Return the current time in milliseconds. */
  now(): number;
}

/**
* Options applied when writing a cache entry with `Cache.set()`.
*
* Omitting `ttlMs` stores the entry without an expiry. A `ttlMs` of `0` (or a
* negative value, which is clamped to `0`) produces an entry that is already
* expired on the next read. Tags are remembered per entry and matched later by
* `invalidateTags()`; writing a key again replaces its previous tags entirely.
*
* ```ts no_run
* import { memoryCache } from 'fino:cache';
*
* const cache = memoryCache();
* await cache.set('user:1', { name: 'Ada' }, { ttlMs: 60_000, tags: ['users'] });
* await cache.invalidateTags(['users']); // removes user:1
* ```
*/
export interface CacheSetOptions {
  /** Milliseconds until the entry expires. Omit for no expiry. */
  ttlMs?: number;
  /** Tags used by `invalidateTags()` to remove related entries. */
  tags?: string[];
}

/**
* Small async cache interface shared by all backends.
*
* Values round-trip through JSON, so only JSON-serializable data survives a
* `set()`/`get()` cycle, and reads return a fresh deserialized copy rather
* than the object that was stored. `get()` returns `null` for missing or
* expired entries; the read that observes an expired entry also deletes it.
*
* Every operation is scoped to the cache's current namespace. `namespace()`
* returns a view over the same backend with a different namespace, so keys do
* not collide across namespaces and tag invalidation only affects the
* namespace it is called on.
*
* ```ts no_run
* import { memoryCache, type Cache } from 'fino:cache';
*
* const cache: Cache = memoryCache();
* await cache.set('config', { theme: 'dark' }, { tags: ['settings'] });
*
* const tenant = cache.namespace('tenant-42');
* await tenant.set('config', { theme: 'light' });
*
* await cache.get('config');  // { theme: 'dark' }
* await tenant.get('config'); // { theme: 'light' }
*
* await cache.invalidateTags(['settings']); // leaves tenant-42 untouched
* ```
*/
export interface Cache {
  /** Read `key`, returning `null` when the entry is missing or expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Store `value` under `key`, replacing any previous value in this namespace. */
  set<T = unknown>(key: string, value: T, opts?: CacheSetOptions): Promise<void>;
  /** Delete `key` from this namespace. Missing keys are ignored. */
  delete(key: string): Promise<void>;
  /** Delete entries in this namespace that have any of the supplied tags. */
  invalidateTags(tags: string[]): Promise<void>;
  /** Return a view over the same backend using `name` as its namespace. */
  namespace(name: string): Cache;
}

/**
* Options for `memoryCache()`.
*
* ```ts no_run
* import { memoryCache } from 'fino:cache';
*
* const cache = memoryCache({
*   maxEntries: 10_000,
*   namespace: 'sessions'
* });
* ```
*/
export interface MemoryCacheOptions {
  /** Maximum retained entries across all namespaces. Defaults to unlimited. */
  maxEntries?: number;
  /** Initial namespace. Defaults to `"default"`. */
  namespace?: string;
  /** Clock used for TTL checks. Defaults to `Date.now()`. */
  clock?: CacheClock;
}

/**
* Options for `sqliteCache()`.
*
* ```ts no_run
* import { sqliteCache } from 'fino:cache';
* import { DiskFileSystem } from 'fino:file';
*
* const cache = await sqliteCache({
*   path: '/var/lib/myapp/cache.db',
*   namespace: 'render',
*   fs: new DiskFileSystem()
* });
* ```
*/
export interface SqliteCacheOptions {
  /** SQLite database path. */
  path: string;
  /** Initial namespace. Defaults to `"default"`. */
  namespace?: string;
  /** Clock used for TTL checks. Defaults to `Date.now()`. */
  clock?: CacheClock;
  /** Optional filesystem provider for the SQLite VFS. */
  fs?: FileSystem;
}

type StoredEntry = {
  value: string;
  expiresAt: number | null;
  touchedAt: number;
  tags: Set<string>;
};

const defaultClock: CacheClock = { now: () => Date.now() };

function encodeValue(value: unknown): string {
  return JSON.stringify(value);
}

function decodeValue<T>(value: string): T {
  return JSON.parse(value) as T;
}

function nsKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

class MemoryCache implements Cache {
  #entries: Map<string, StoredEntry>;
  #namespace: string;
  #maxEntries: number;
  #clock: CacheClock;

  constructor(entries: Map<string, StoredEntry>, opts: Required<MemoryCacheOptions>) {
    this.#entries = entries;
    this.#namespace = opts.namespace;
    this.#maxEntries = opts.maxEntries;
    this.#clock = opts.clock;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const full = nsKey(this.#namespace, key);
    const entry = this.#entries.get(full);
    if (!entry) return null;
    const now = this.#clock.now();
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.#entries.delete(full);
      return null;
    }
    entry.touchedAt = now;
    this.#entries.delete(full);
    this.#entries.set(full, entry);
    return decodeValue<T>(entry.value);
  }

  async set<T = unknown>(key: string, value: T, opts: CacheSetOptions = {}): Promise<void> {
    const now = this.#clock.now();
    const full = nsKey(this.#namespace, key);
    this.#entries.set(full, {
      value: encodeValue(value),
      expiresAt: opts.ttlMs === undefined ? null : now + Math.max(0, opts.ttlMs),
      touchedAt: now,
      tags: new Set(opts.tags ?? [])
    });
    this.#evict();
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(nsKey(this.#namespace, key));
  }

  async invalidateTags(tags: string[]): Promise<void> {
    const wanted = new Set(tags);
    const prefix = `${this.#namespace}\0`;
    for (const [key, entry] of [...this.#entries]) {
      if (!key.startsWith(prefix)) continue;
      if ([...entry.tags].some((tag) => wanted.has(tag))) this.#entries.delete(key);
    }
  }

  namespace(name: string): Cache {
    return new MemoryCache(this.#entries, {
      namespace: name,
      maxEntries: this.#maxEntries,
      clock: this.#clock
    });
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries) {
      const first = this.#entries.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.#entries.delete(first);
    }
  }
}

/**
* Create an in-memory LRU cache.
*
* Recency is tracked per key: reads refresh an entry's position, and when a
* `set()` pushes the cache past `maxEntries` the least recently used entries
* are evicted regardless of namespace. Entries are lost when the process exits
* and are not shared across realms or processes. LRU size is counted in
* entries, not bytes.
*
* ```ts no_run
* import { memoryCache } from 'fino:cache';
*
* const cache = memoryCache({ maxEntries: 2 });
* await cache.set('one', 1);
* await cache.set('two', 2);
* await cache.get('one');      // refreshes 'one'
* await cache.set('three', 3); // evicts 'two', the least recently used
*
* await cache.get('two'); // null
* await cache.get('one'); // 1
* ```
*/
export function memoryCache(opts: MemoryCacheOptions = {}): Cache {
  return new MemoryCache(new Map(), {
    namespace: opts.namespace ?? 'default',
    maxEntries: opts.maxEntries ?? Number.POSITIVE_INFINITY,
    clock: opts.clock ?? defaultClock
  });
}

/**
* SQLite-backed cache handle returned by `sqliteCache()`.
*
* Adds `close()` on top of the `Cache` interface. Only the handle returned by
* `sqliteCache()` owns the database connection; namespace views created with
* `namespace()` share it without owning it, so closing the owning handle ends
* access for every view derived from it.
*
* ```ts no_run
* import { sqliteCache } from 'fino:cache';
*
* const cache = await sqliteCache({ path: '/tmp/app-cache.db' });
* try {
*   await cache.set('greeting', 'hello', { ttlMs: 60_000 });
* } finally {
*   await cache.close();
* }
* ```
*/
export interface SqliteCache extends Cache {
  /** Close the underlying SQLite database. */
  close(): Promise<void>;
}

class SqliteCacheImpl implements SqliteCache {
  #db: Database;
  #namespace: string;
  #clock: CacheClock;
  #ownsDb: boolean;

  constructor(db: Database, namespace: string, clock: CacheClock, ownsDb: boolean) {
    this.#db = db;
    this.#namespace = namespace;
    this.#clock = clock;
    this.#ownsDb = ownsDb;
  }

  static async open(opts: SqliteCacheOptions): Promise<SqliteCacheImpl> {
    const db = await Database.open(opts.path, { fs: opts.fs });
    await db.exec(`CREATE TABLE IF NOT EXISTS fino_cache_entries (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER,
      touched_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, key)
    )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS fino_cache_tags (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY(namespace, key, tag)
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_fino_cache_tags ON fino_cache_tags(namespace, tag)`);
    return new SqliteCacheImpl(db, opts.namespace ?? 'default', opts.clock ?? defaultClock, true);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const stmt = this.#db.prepare(`SELECT value, expires_at FROM fino_cache_entries WHERE namespace = ? AND key = ?`);
    try {
      const row = await stmt.get(this.#namespace, key);
      if (!row) return null;
      const expiresAt = row.expires_at === null ? null : Number(row.expires_at);
      const now = this.#clock.now();
      if (expiresAt !== null && expiresAt <= now) {
        await this.delete(key);
        return null;
      }
      await this.#db.prepare(`UPDATE fino_cache_entries SET touched_at = ? WHERE namespace = ? AND key = ?`).run(now, this.#namespace, key);
      return decodeValue<T>(row.value as string);
    } finally {
      stmt.finalize();
    }
  }

  async set<T = unknown>(key: string, value: T, opts: CacheSetOptions = {}): Promise<void> {
    const now = this.#clock.now();
    const expiresAt = opts.ttlMs === undefined ? null : now + Math.max(0, opts.ttlMs);
    await this.#db.prepare(`INSERT OR REPLACE INTO fino_cache_entries(namespace, key, value, expires_at, touched_at) VALUES(?, ?, ?, ?, ?)`).run(this.#namespace, key, encodeValue(value), expiresAt, now);
    await this.#db.prepare(`DELETE FROM fino_cache_tags WHERE namespace = ? AND key = ?`).run(this.#namespace, key);
    const insert = this.#db.prepare(`INSERT OR IGNORE INTO fino_cache_tags(namespace, key, tag) VALUES(?, ?, ?)`);
    try {
      for (const tag of opts.tags ?? []) await insert.run(this.#namespace, key, tag);
    } finally {
      insert.finalize();
    }
  }

  async delete(key: string): Promise<void> {
    await this.#db.prepare(`DELETE FROM fino_cache_entries WHERE namespace = ? AND key = ?`).run(this.#namespace, key);
    await this.#db.prepare(`DELETE FROM fino_cache_tags WHERE namespace = ? AND key = ?`).run(this.#namespace, key);
  }

  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const placeholders = tags.map(() => '?').join(',');
    const rows = await this.#db.prepare(`SELECT key FROM fino_cache_tags WHERE namespace = ? AND tag IN (${placeholders})`).all(this.#namespace, ...tags);
    for (const row of rows) await this.delete(row.key as string);
  }

  namespace(name: string): Cache {
    return new SqliteCacheImpl(this.#db, name, this.#clock, false);
  }

  async close(): Promise<void> {
    if (this.#ownsDb) await this.#db.close();
  }
}

/**
* Open a SQLite-backed cache.
*
* Opens (creating if necessary) the database at `opts.path` and ensures the
* `fino_cache_entries` and `fino_cache_tags` tables exist, so the same file
* can also hold unrelated application tables. Entries persist across process
* restarts; expired entries are removed lazily when a read observes them.
* Call `close()` on the returned handle when the cache is no longer needed.
*
* ```ts no_run
* import { sqliteCache } from 'fino:cache';
*
* const cache = await sqliteCache({ path: '/var/lib/myapp/cache.db' });
* let report = await cache.get<string>('report:2026-07');
* if (report === null) {
*   report = 'expensive result';
*   await cache.set('report:2026-07', report, { ttlMs: 3_600_000, tags: ['reports'] });
* }
* await cache.close();
* ```
*/
export function sqliteCache(opts: SqliteCacheOptions): Promise<SqliteCache> {
  return SqliteCacheImpl.open(opts);
}

/**
* Options for `responseCache()`.
*
* ```ts no_run
* import { memoryCache, responseCache } from 'fino:cache';
*
* const middleware = responseCache(memoryCache(), {
*   ttlMs: 5_000,
*   vary: ['accept-language'],
*   statuses: [200, 404],
*   header: 'x-cache'
* });
* ```
*/
export interface ResponseCacheOptions {
  /** TTL applied to every stored response. */
  ttlMs: number;
  /** HTTP methods to cache. Defaults to `GET` and `HEAD`. */
  methods?: string[];
  /** Response statuses to cache. Defaults to `[200]`. */
  statuses?: number[];
  /** Request header names included in the cache key. */
  vary?: string[];
  /** Diagnostic header name, or `false` to disable it. Defaults to `x-fino-cache`. */
  header?: false | string;
}

type CachedResponse = {
  status: number;
  headers: Array<[string, string]>;
  body: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function responseKey(req: Request, vary: string[]): string {
  const parts = [req.method.toUpperCase(), req.url];
  for (const name of vary) parts.push(`${name.toLowerCase()}:${req.headers.get(name) ?? ''}`);
  return parts.join('\n');
}

function cacheHeaderName(opts: ResponseCacheOptions): string | null {
  if (opts.header === false) return null;
  return opts.header ?? 'x-fino-cache';
}

/**
* Create HTTP response-cache middleware for `fino:net/http/app`.
*
* Requests whose method is in `methods` (default `GET`/`HEAD`) are looked up
* by method, full URL, and the values of the configured `vary` request
* headers. On a hit the stored status, headers, and body are replayed without
* invoking downstream handlers. On a miss the downstream response is stored
* when it is safe to reuse: its status is in `statuses` (default `[200]`), it
* carries no `Set-Cookie` header, and its `Cache-Control` does not include
* `no-store`.
*
* Unless disabled with `header: false`, every response gains a diagnostic
* header (default `x-fino-cache`) valued `HIT`, `MISS`, or `BYPASS`, so cache
* behavior is observable in tests and from clients. Stored entries expire
* after `ttlMs`; pair the cache with `invalidateTags()` or `delete()` on a
* namespaced view if routes need explicit invalidation.
*
* ```ts no_run
* import { memoryCache, responseCache } from 'fino:cache';
* import { App } from 'fino:net/http/app';
*
* const app = new App()
*   .layer(responseCache(memoryCache({ maxEntries: 500 }), {
*     ttlMs: 5_000,
*     vary: ['accept-language']
*   }));
*
* app.get('/hello').handle(() => new Response('hello'));
* // First request: x-fino-cache: MISS. Repeats within 5s: HIT.
* ```
*/
export function responseCache(cache: Cache, opts: ResponseCacheOptions): LayerMiddleware {
  const methods = new Set((opts.methods ?? ['GET', 'HEAD']).map((method) => method.toUpperCase()));
  const statuses = new Set(opts.statuses ?? [200]);
  const vary = opts.vary ?? [];
  const header = cacheHeaderName(opts);
  return defineMiddleware(async (ctx, next) => {
    const method = ctx.request.method.toUpperCase();
    if (!methods.has(method)) {
      const res = await next();
      if (res instanceof Response && header) res.headers.set(header, 'BYPASS');
      return res;
    }
    const key = responseKey(ctx.request, vary);
    const hit = await cache.get<CachedResponse>(key);
    if (hit) {
      const res = new Response(base64ToBytes(hit.body), {
        status: hit.status,
        headers: hit.headers
      });
      if (header) res.headers.set(header, 'HIT');
      return res;
    }
    const res = await next();
    if (!(res instanceof Response)) return res;
    const control = res.headers.get('cache-control') ?? '';
    const cacheable = statuses.has(res.status) && !res.headers.has('set-cookie') && !/\bno-store\b/i.test(control);
    if (!cacheable) {
      if (header) res.headers.set(header, 'BYPASS');
      return res;
    }
    const clone = res.clone();
    const bytes = new Uint8Array(await clone.arrayBuffer());
    const headers = [...res.headers].filter(([name]) => name.toLowerCase() !== (header ?? '').toLowerCase());
    await cache.set(key, {
      status: res.status,
      headers,
      body: bytesToBase64(bytes)
    }, { ttlMs: opts.ttlMs });
    if (header) res.headers.set(header, 'MISS');
    return res;
  });
}
