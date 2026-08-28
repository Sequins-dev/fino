/**
 * fino:cache — expiry, invalidation, and eviction policy over `fino:store`.
 *
 * `cache(store)` is the only cache constructor. Applications choose and own a
 * generic backing store directly; memory, SQLite, Redis, and other providers
 * do not need cache-specific wrapper classes.
 *
 * ## Expiry
 *
 * When a store exposes its optional `expiration` capability, cache writes pass
 * TTL to that provider. A Redis-like provider can therefore use `SET PX`, and
 * Fino does not duplicate expiry metadata or schedule external cleanup. For a
 * plain store, the cache records an absolute expiry and removes stale entries
 * lazily when they are read.
 *
 * Tags and optional process-local LRU eviction remain cache policy. Values are
 * not serialized by this layer; they follow the backing store's value rules,
 * including native `Uint8Array` support.
 *
 * ```ts no_run
 * import { cache, responseCache } from 'fino:cache';
 * import { memoryStore } from 'fino:store';
 * import { App } from 'fino:net/http/app';
 *
 * const values = cache(memoryStore(), { maxEntries: 1_000 });
 * await values.set('user:1', { name: 'Ada' }, { ttlMs: 60_000 });
 *
 * const app = new App().layer(responseCache(values, { ttlMs: 5_000 }));
 * ```
 */
import { defineMiddleware, type LayerMiddleware } from 'fino:net/http/app';
import type { Store } from 'fino:store';

/** Clock used by the fallback expiry policy. */
export interface CacheClock {
  /** Return the current Unix timestamp in milliseconds. */
  now(): number;
}

/** Options applied when writing one cache entry. */
export interface CacheSetOptions {
  /** Milliseconds until expiry. Omit for no expiry. */
  ttlMs?: number;
  /** Tags used by `invalidateTags()` to remove related entries. */
  tags?: string[];
}

/**
 * Small async cache interface independent of any backing provider.
 *
 * The provider owns value identity and serialization. Missing and expired
 * entries return `null`; cache namespaces and tag invalidation remain isolated.
 */
export interface Cache {
  /** Read `key`, returning `null` when it is missing or expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Store `value` with optional TTL and invalidation tags. */
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  /** Delete `key`. Missing keys are ignored. */
  delete(key: string): Promise<void>;
  /** Delete entries carrying any of `tags`. */
  invalidateTags(tags: string[]): Promise<void>;
  /** Return a cache view in an isolated child namespace. */
  namespace(name: string): Cache;
}

/** Options for `cache()`. */
export interface CacheOptions {
  /** Maximum entries retained by this process across namespace views. */
  maxEntries?: number;
  /** Clock used only when the provider has no native expiry capability. */
  clock?: CacheClock;
}

type CacheRecord = {
  value: unknown;
  tags: string[];
  /** Present only for the fallback expiry policy. */
  expiresAt: number | null;
};

type RecencyEntry = {
  store: Store;
  key: string;
};

type CachePolicy = {
  clock: CacheClock;
  maxEntries: number;
  recency: Map<string, RecencyEntry>;
};

const defaultClock: CacheClock = { now: () => Date.now() };

function ttl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) throw new TypeError('Cache ttlMs must be finite');
  return Math.max(0, ttlMs);
}

class StoreCache implements Cache {
  #store: Store;
  #policy: CachePolicy;
  #scope: string;

  constructor(store: Store, policy: CachePolicy, scope: string) {
    this.#store = store;
    this.#policy = policy;
    this.#scope = scope;
  }

  #recencyKey(key: string): string {
    return `${this.#scope}\0${key}`;
  }

  #forget(key: string): void {
    this.#policy.recency.delete(this.#recencyKey(key));
  }

  async #touch(key: string): Promise<void> {
    const id = this.#recencyKey(key);
    this.#policy.recency.delete(id);
    this.#policy.recency.set(id, { store: this.#store, key });
    while (this.#policy.recency.size > this.#policy.maxEntries) {
      const oldest = this.#policy.recency.entries().next().value as
        | [string, RecencyEntry]
        | undefined;
      if (!oldest) break;
      this.#policy.recency.delete(oldest[0]);
      await oldest[1].store.delete(oldest[1].key);
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const record = await this.#store.get<CacheRecord>(key);
    if (!record) {
      this.#forget(key);
      return null;
    }
    if (record.expiresAt !== null && record.expiresAt <= this.#policy.clock.now()) {
      await this.#store.delete(key);
      this.#forget(key);
      return null;
    }
    await this.#touch(key);
    return record.value as T;
  }

  async set<T = unknown>(key: string, value: T, options: CacheSetOptions = {}): Promise<void> {
    const lifetime = options.ttlMs === undefined ? undefined : ttl(options.ttlMs);
    const nativeExpiry = lifetime !== undefined && this.#store.expiration !== undefined;
    const record: CacheRecord = {
      value,
      tags: [...(options.tags ?? [])],
      expiresAt:
        lifetime === undefined || nativeExpiry ? null : this.#policy.clock.now() + lifetime,
    };
    if (nativeExpiry) await this.#store.expiration!.set(key, record, lifetime);
    else await this.#store.set(key, record);
    await this.#touch(key);
  }

  async delete(key: string): Promise<void> {
    this.#forget(key);
    await this.#store.delete(key);
  }

  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const wanted = new Set(tags);
    for (const entry of await this.#store.list<CacheRecord>()) {
      if (!entry.value.tags.some((tag) => wanted.has(tag))) continue;
      await this.#store.delete(entry.key);
      this.#forget(entry.key);
    }
  }

  namespace(name: string): Cache {
    if (name.length === 0) throw new TypeError('Cache namespace must not be empty');
    return new StoreCache(this.#store.namespace(name), this.#policy, `${this.#scope}\0${name}`);
  }
}

/**
 * Add cache policy to a caller-owned store.
 *
 * The returned cache occupies an isolated child namespace. Store lifecycle and
 * serialization remain the caller's and provider's responsibility.
 */
export function cache(store: Store, options: CacheOptions = {}): Cache {
  return new StoreCache(
    store.namespace('fino:cache:v1'),
    {
      clock: options.clock ?? defaultClock,
      maxEntries: options.maxEntries ?? Number.POSITIVE_INFINITY,
      recency: new Map(),
    },
    'root',
  );
}

/** Options for `responseCache()`. */
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
  body: Uint8Array;
};

function responseKey(req: Request, vary: string[]): string {
  const parts = [req.method.toUpperCase(), req.url];
  for (const name of vary) parts.push(`${name.toLowerCase()}:${req.headers.get(name) ?? ''}`);
  return parts.join('\n');
}

function cacheHeaderName(options: ResponseCacheOptions): string | null {
  if (options.header === false) return null;
  return options.header ?? 'x-fino-cache';
}

/**
 * Create HTTP response-cache middleware for `fino:net/http/app`.
 *
 * Requests whose method is in `methods` are keyed by method, URL, and selected
 * request headers. Cacheable responses retain their body as `Uint8Array` and
 * are replayed without base64 conversion. Responses with `Set-Cookie` or
 * `Cache-Control: no-store` bypass storage.
 */
export function responseCache(cache: Cache, options: ResponseCacheOptions): LayerMiddleware {
  const methods = new Set(
    (options.methods ?? ['GET', 'HEAD']).map((method) => method.toUpperCase()),
  );
  const statuses = new Set(options.statuses ?? [200]);
  const vary = options.vary ?? [];
  const header = cacheHeaderName(options);
  return defineMiddleware(async (ctx, next) => {
    const method = ctx.request.method.toUpperCase();
    if (!methods.has(method)) {
      const response = await next();
      if (response instanceof Response && header) response.headers.set(header, 'BYPASS');
      return response;
    }
    const key = responseKey(ctx.request, vary);
    const hit = await cache.get<CachedResponse>(key);
    if (hit) {
      const response = new Response(hit.body, { status: hit.status, headers: hit.headers });
      if (header) response.headers.set(header, 'HIT');
      return response;
    }
    const response = await next();
    if (!(response instanceof Response)) return response;
    const control = response.headers.get('cache-control') ?? '';
    const cacheable =
      statuses.has(response.status) &&
      !response.headers.has('set-cookie') &&
      !/\bno-store\b/i.test(control);
    if (!cacheable) {
      if (header) response.headers.set(header, 'BYPASS');
      return response;
    }
    const clone = response.clone();
    const headers = [...response.headers].filter(
      ([name]) => name.toLowerCase() !== (header ?? '').toLowerCase(),
    );
    await cache.set(
      key,
      {
        status: response.status,
        headers,
        body: new Uint8Array(await clone.arrayBuffer()),
      },
      { ttlMs: options.ttlMs },
    );
    if (header) response.headers.set(header, 'MISS');
    return response;
  });
}
