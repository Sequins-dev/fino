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
* A `Cache` is a simple async key/value interface. `memoryCache()` is intended
* for tests and single-process applications; `sqliteCache()` persists entries
* through `fino:database/sqlite` and the configured filesystem provider.
* `responseCache()` is middleware for `fino:net/http/app` and caches safe
* `GET`/`HEAD` responses by method, URL, and configured vary headers.
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
* const app = new App().use(responseCache(cache, { ttlMs: 5_000 }));
* ```
*/
import { Database } from 'fino:database/sqlite';
import type { FileSystem } from 'internal:file/provider';
import { defineMiddleware, type Middleware } from 'fino:net/http/app';

/**
* Clock used by cache backends.
*
* Supplying a fake clock makes TTL behavior deterministic in tests.
*/
export interface CacheClock {
  /** Return the current time in milliseconds. */
  now(): number;
}

/**
* Options applied when writing a cache entry.
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
* `get()` returns `null` for missing or expired entries. `namespace()` returns a
* view over the same backend with a different namespace, so tag invalidation is
* local to that namespace.
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
* Entries are lost when the process exits and are not shared across realms or
* processes. LRU size is counted in entries, not bytes.
*/
export function memoryCache(opts: MemoryCacheOptions = {}): Cache {
  return new MemoryCache(new Map(), {
    namespace: opts.namespace ?? 'default',
    maxEntries: opts.maxEntries ?? Number.POSITIVE_INFINITY,
    clock: opts.clock ?? defaultClock
  });
}

/**
* SQLite-backed cache with optional `close()`.
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
*/
export function sqliteCache(opts: SqliteCacheOptions): Promise<SqliteCache> {
  return SqliteCacheImpl.open(opts);
}

/**
* Options for `responseCache()`.
*/
export interface ResponseCacheOptions {
  /** TTL for stored responses. Required for writes. */
  ttlMs: number;
  /** HTTP methods to cache. Defaults to `GET` and `HEAD`. */
  methods?: string[];
  /** Response statuses to cache. Defaults to `[200]`. */
  statuses?: number[];
  /** Request header names included in the cache key. */
  vary?: string[];
  /** Disable the `x-fino-cache` diagnostic header. */
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
* The middleware only caches responses that are safe by default: method is
* `GET` or `HEAD`, status is `200`, no `Set-Cookie` header is present, and
* `Cache-Control` does not include `no-store`.
*/
export function responseCache(cache: Cache, opts: ResponseCacheOptions): Middleware {
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
