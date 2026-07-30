/**
 * fino:ai/cache — exact and semantic cache wrappers for chat models.
 *
 * `cachedModel()` wraps a provider-neutral `Model` and serves repeated
 * requests from a local cache before calling the underlying provider. Two
 * tiers are checked in order:
 *
 * - **Exact** — always on. The key is a stable serialization of the model
 *   identity (`id`, `name`, `provider`) plus the request with object keys
 *   sorted and `signal` excluded, so property order and abort signals do not
 *   affect matching.
 * - **Semantic** — opt-in via `semantic`. The user-facing request text
 *   (system prompt plus role-prefixed message text) is embedded, and a prior
 *   result is reused when its similarity score meets the configured
 *   threshold. Lookup is a brute-force cosine scan over an index kept in the
 *   semantic cache, or a sqlite-vec KNN query when a `path` is configured and
 *   vector support is available.
 *
 * Both `generate()` and `stream()` are cached. A streamed miss forwards
 * provider events unchanged while recording them; a hit replays an
 * equivalent coalesced stream (one text delta, tool-call event groups, then
 * usage and stop) rather than the original chunk boundaries.
 *
 * ## Caveats
 *
 * Semantic thresholds are domain-specific. Time-sensitive answers should pass
 * a `bypass` predicate, and tool-calling turns bypass semantic hits by default
 * because tool context usually needs exact matching.
 *
 * Cache hits report provider spend as zero and put avoided tokens in
 * `localCacheReadInputTokens` and `localCacheReadOutputTokens`. Every result
 * is stamped with `providerMetadata.finoCache` so callers can observe hit
 * rates: `{ hit: true, tier, score? }` on hits, `{ hit: false, tier: null }`
 * on misses.
 *
 * ```ts no_run
 * import { memoryCache } from 'fino:cache';
 * import { cachedModel } from 'fino:ai/cache';
 * import { openai } from 'fino:ai/model';
 *
 * const base = openai({ model: 'gpt-4o' });
 * const model = cachedModel(base, { cache: memoryCache(), ttlMs: 60_000 });
 * const result = await model.generate({ messages: [{ role: 'user', content: 'hello' }] });
 * ```
 */
import type { Cache } from 'fino:cache';
import { Database, vec } from 'fino:database/sqlite';
import type { FileSystem } from 'internal:file/provider';
import { ModelStreamImpl } from 'internal:ai/shared';
import { cosineSimilarity } from 'fino:ml/metrics';
import type {
  EmbeddingModel,
  GenerateRequest,
  GenerateResult,
  Model,
  ModelStream,
  StreamEvent,
  Usage,
} from 'fino:ai/model';

/**
 * Semantic cache configuration for `cachedModel()`.
 *
 * The semantic tier only runs when the exact tier misses, and it is skipped
 * entirely — for both lookup and writes — on requests with tool context
 * (declared `tools`, or `tool_use`/`tool_result` message parts).
 *
 * By default the index of embeddings and results lives in `cache` under a
 * reserved key and is scanned with brute-force cosine similarity, which suits
 * small working sets. Setting `path` adds a persistent SQLite store queried
 * via sqlite-vec KNN; when the sqlite-vec extension is unavailable or the
 * embedder reports zero `dimensions`, lookup silently falls back to the
 * in-cache index.
 *
 * ```ts no_run
 * import { memoryCache } from 'fino:cache';
 * import { cachedModel } from 'fino:ai/cache';
 * import { openai } from 'fino:ai/model';
 *
 * const embedder = openai({ model: 'gpt-4o' });
 * const model = cachedModel(openai({ model: 'gpt-4o' }), {
 *   cache: memoryCache(),
 *   semantic: {
 *     cache: memoryCache(),
 *     embedder,
 *     threshold: 0.9,
 *     path: './semantic-cache.db',
 *   },
 * });
 * ```
 */
export interface SemanticCacheOptions {
  /** Cache holding the semantic index of embeddings and cached results. */
  cache: Cache;
  /** Embedding model used to compare request text. */
  embedder: EmbeddingModel;
  /** Minimum similarity score for a semantic hit. Defaults to `0.92`. */
  threshold?: number;
  /** Optional SQLite database path for sqlite-vec backed semantic lookup. */
  path?: string;
  /** Optional filesystem provider for the semantic SQLite store. */
  fs?: FileSystem;
}

/**
 * Options for `cachedModel()`.
 *
 * Only `cache` is required; it backs the always-on exact tier. Add `semantic`
 * for similarity-based reuse and `bypass` to exempt requests that must always
 * reach the provider (time-sensitive prompts, per-user answers, and so on).
 *
 * ```ts no_run
 * import { memoryCache } from 'fino:cache';
 * import { cachedModel } from 'fino:ai/cache';
 * import { openai } from 'fino:ai/model';
 *
 * const model = cachedModel(openai({ model: 'gpt-4o' }), {
 *   cache: memoryCache(),
 *   ttlMs: 5 * 60_000,
 *   bypass: (req) => req.messages.some(
 *     (m) => typeof m.content === 'string' && m.content.includes('today'),
 *   ),
 * });
 * ```
 */
export interface CachedModelOptions {
  /** Exact cache backend. */
  cache: Cache;
  /**
   * TTL applied to stored exact entries and to the in-cache semantic index.
   * Rows in a `path`-backed semantic SQLite store are not expired.
   */
  ttlMs?: number;
  /** Optional semantic tier. */
  semantic?: SemanticCacheOptions;
  /**
   * Return true to bypass all cache lookup and writes for a request. Bypassed
   * requests always hit the provider and are never stored.
   */
  bypass?: (req: GenerateRequest) => boolean;
}

type CacheTier = 'exact' | 'semantic';

type CachedRecord = {
  result: GenerateResult;
  events: StreamEvent[];
  requestText: string;
  embedding?: number[];
};

type SemanticIndex = Array<{
  key: string;
  requestText: string;
  embedding: number[];
  result: GenerateResult;
  events: StreamEvent[];
}>;

type SemanticDbState = {
  db: Database;
  available: boolean;
};

const semanticIndexKey = '__fino_ai_semantic_index__';
const semanticDbs = new WeakMap<SemanticCacheOptions, Promise<SemanticDbState>>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => key !== 'signal')
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function modelIdentity(model: Model): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
  };
}

function cacheKey(model: Model, req: GenerateRequest): string {
  return `model:${stableStringify({ model: modelIdentity(model), req })}`;
}

function contentText(content: GenerateRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'tool_result')
        return typeof part.content === 'string' ? part.content : stableStringify(part.content);
      return stableStringify(part);
    })
    .join('\n');
}

function requestText(req: GenerateRequest): string {
  const system =
    req.system === undefined
      ? ''
      : typeof req.system === 'string'
        ? req.system
        : contentText(req.system as never);
  return [
    system,
    ...req.messages.map((message) => `${message.role}: ${contentText(message.content)}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function hasToolContext(req: GenerateRequest): boolean {
  if (req.tools && req.tools.length > 0) return true;
  for (const message of req.messages) {
    if (
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'tool_result' || part.type === 'tool_use')
    )
      return true;
  }
  return false;
}

function savedUsage(usage: Usage): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    ...(usage.inputTokens ? { localCacheReadInputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens ? { localCacheReadOutputTokens: usage.outputTokens } : {}),
  };
}

function cachedResult(
  record: CachedRecord | SemanticIndex[number],
  tier: CacheTier,
  score?: number,
): GenerateResult {
  return {
    ...record.result,
    usage: savedUsage(record.result.usage),
    providerMetadata: {
      ...(record.result.providerMetadata ?? {}),
      finoCache: score === undefined ? { hit: true, tier } : { hit: true, tier, score },
    },
  };
}

function cachedEvents(
  record: CachedRecord | SemanticIndex[number],
  tier: CacheTier,
  score?: number,
): StreamEvent[] {
  const result = cachedResult(record, tier, score);
  const out: StreamEvent[] = [];
  if (result.text) out.push({ type: 'text_delta', index: 0, text: result.text });
  for (const [index, call] of result.toolCalls.entries()) {
    out.push({ type: 'tool_call_start', index, id: call.id, name: call.name });
    out.push({ type: 'tool_call_delta', index, json: stableStringify(call.args) });
    out.push({ type: 'tool_call_end', index });
  }
  out.push({ type: 'usage', usage: result.usage });
  out.push({ type: 'stop', reason: result.stopReason });
  return out;
}

function streamFromEvents(events: StreamEvent[]): ModelStream {
  async function* gen() {
    yield* events;
  }
  return new ModelStreamImpl(gen());
}

async function semanticLookup(
  opts: SemanticCacheOptions | undefined,
  req: GenerateRequest,
): Promise<{ record: SemanticIndex[number]; score: number } | null> {
  if (!opts || hasToolContext(req)) return null;
  const sqliteHit = await semanticSqliteLookup(opts, req);
  if (sqliteHit) return sqliteHit;
  const index = (await opts.cache.get<SemanticIndex>(semanticIndexKey)) ?? [];
  if (index.length === 0) return null;
  const [embedding] = await opts.embedder.embed([requestText(req)]);
  if (!embedding) return null;
  const query = [...embedding];
  let best: SemanticIndex[number] | null = null;
  let bestScore = -1;
  for (const item of index) {
    if (item.embedding.length !== query.length) continue;
    const score = cosineSimilarity(query, item.embedding);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  const threshold = opts.threshold ?? 0.92;
  return best && bestScore >= threshold ? { record: best, score: bestScore } : null;
}

async function rememberSemantic(
  opts: SemanticCacheOptions | undefined,
  key: string,
  req: GenerateRequest,
  record: CachedRecord,
  ttlMs: number | undefined,
): Promise<void> {
  if (!opts || hasToolContext(req)) return;
  const [embedding] = await opts.embedder.embed([record.requestText]);
  if (!embedding) return;
  await rememberSemanticSqlite(opts, key, record, embedding);
  const index = ((await opts.cache.get<SemanticIndex>(semanticIndexKey)) ?? []).filter(
    (item) => item.key !== key,
  );
  index.push({
    key,
    requestText: record.requestText,
    embedding: [...embedding],
    result: record.result,
    events: record.events,
  });
  await opts.cache.set(semanticIndexKey, index, { ttlMs });
}

async function semanticDb(opts: SemanticCacheOptions): Promise<SemanticDbState | null> {
  if (!opts.path) return null;
  let promise = semanticDbs.get(opts);
  if (!promise) {
    promise = (async () => {
      const db = await Database.open(opts.path!, { fs: opts.fs });
      await db.exec(`CREATE TABLE IF NOT EXISTS fino_ai_cache_semantic (
        key TEXT PRIMARY KEY,
        request_text TEXT NOT NULL,
        result TEXT NOT NULL,
        events TEXT NOT NULL,
        embedding BLOB NOT NULL
      )`);
      let available = opts.embedder.dimensions > 0 && db.vectorsAvailable;
      if (available) {
        try {
          await db.exec(
            `CREATE VIRTUAL TABLE IF NOT EXISTS fino_ai_cache_semantic_vec USING vec0(embedding float[${opts.embedder.dimensions}])`,
          );
        } catch {
          available = false;
        }
      }
      return { db, available };
    })();
    semanticDbs.set(opts, promise);
  }
  return promise;
}

async function semanticSqliteLookup(
  opts: SemanticCacheOptions,
  req: GenerateRequest,
): Promise<{ record: SemanticIndex[number]; score: number } | null> {
  const state = await semanticDb(opts);
  if (!state?.available) return null;
  const [embedding] = await opts.embedder.embed([requestText(req)]);
  if (!embedding) return null;
  const knn = state.db.prepare(
    `SELECT rowid, distance FROM fino_ai_cache_semantic_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
  );
  let rows: Record<string, unknown>[];
  try {
    rows = await knn.all(vec(embedding), 10);
  } finally {
    knn.finalize();
  }
  const threshold = opts.threshold ?? 0.92;
  for (const row of rows) {
    const score = 1 / (1 + Number(row.distance));
    if (score < threshold) continue;
    const found = await state.db
      .prepare(
        `SELECT key, request_text, result, events, embedding FROM fino_ai_cache_semantic WHERE rowid = ?`,
      )
      .get(row.rowid as bigint);
    if (!found) continue;
    return {
      score,
      record: {
        key: found.key as string,
        requestText: found.request_text as string,
        embedding: [...embedding],
        result: JSON.parse(found.result as string) as GenerateResult,
        events: JSON.parse(found.events as string) as StreamEvent[],
      },
    };
  }
  return null;
}

async function rememberSemanticSqlite(
  opts: SemanticCacheOptions,
  key: string,
  record: CachedRecord,
  embedding: Float32Array,
): Promise<void> {
  const state = await semanticDb(opts);
  if (!state?.available) return;
  await state.db
    .prepare(
      `INSERT OR REPLACE INTO fino_ai_cache_semantic(key, request_text, result, events, embedding) VALUES(?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      record.requestText,
      JSON.stringify(record.result),
      JSON.stringify(record.events),
      new Uint8Array(embedding.buffer.slice(0)),
    );
  const row = await state.db
    .prepare(`SELECT rowid FROM fino_ai_cache_semantic WHERE key = ?`)
    .get(key);
  if (!row) return;
  try {
    await state.db
      .prepare(`DELETE FROM fino_ai_cache_semantic_vec WHERE rowid = ?`)
      .run(row.rowid as bigint);
  } catch {}
  await state.db
    .prepare(`INSERT INTO fino_ai_cache_semantic_vec(rowid, embedding) VALUES(?, ?)`)
    .run(row.rowid as bigint, vec(embedding));
}

function withCacheMetadata(result: GenerateResult, hit: boolean): GenerateResult {
  return {
    ...result,
    providerMetadata: {
      ...(result.providerMetadata ?? {}),
      finoCache: { hit, tier: null },
    },
  };
}

/**
 * Wrap a chat model with exact and optional semantic local caching.
 *
 * The returned model preserves the identity of `base` (`id`, `name`,
 * `provider`, `capabilities`) and caches both `generate()` and `stream()`.
 * Each request first checks the exact tier, then the semantic tier when
 * configured; a hit returns the stored result with usage zeroed and avoided
 * tokens reported as `localCacheReadInputTokens` /
 * `localCacheReadOutputTokens`. On a miss the provider result is stored and
 * returned stamped with `providerMetadata.finoCache = { hit: false, tier:
 * null }`, so the same conversation replayed later — even with request
 * properties in a different order — is served locally.
 *
 * Streamed hits replay a coalesced event stream synthesized from the cached
 * result: a single text delta, start/delta/end groups per tool call, then
 * usage and stop events. Streamed misses forward the provider's events
 * unmodified while recording the final result for future hits.
 *
 * Because the cache key includes the model identity, wrappers around
 * different models can safely share one `Cache` instance.
 *
 * ```ts no_run
 * import { memoryCache } from 'fino:cache';
 * import { cachedModel } from 'fino:ai/cache';
 * import { openai } from 'fino:ai/model';
 *
 * const model = cachedModel(openai({ model: 'gpt-4o' }), {
 *   cache: memoryCache(),
 *   ttlMs: 60_000,
 * });
 *
 * const req = { messages: [{ role: 'user' as const, content: 'What is TAP output?' }] };
 * const first = await model.generate(req);   // calls the provider
 * const second = await model.generate(req);  // served locally
 * console.log(second.providerMetadata?.finoCache); // { hit: true, tier: 'exact' }
 * console.log(second.usage.localCacheReadOutputTokens); // tokens avoided
 * ```
 */
export function cachedModel(base: Model, opts: CachedModelOptions): Model {
  async function read(
    req: GenerateRequest,
  ): Promise<{ result: GenerateResult; tier: CacheTier; score?: number } | null> {
    if (opts.bypass?.(req)) return null;
    const exact = await opts.cache.get<CachedRecord>(cacheKey(base, req));
    if (exact) return { result: cachedResult(exact, 'exact'), tier: 'exact' };
    const semantic = await semanticLookup(opts.semantic, req);
    if (semantic)
      return {
        result: cachedResult(semantic.record, 'semantic', semantic.score),
        tier: 'semantic',
        score: semantic.score,
      };
    return null;
  }

  async function write(
    req: GenerateRequest,
    result: GenerateResult,
    events: StreamEvent[],
  ): Promise<void> {
    if (opts.bypass?.(req)) return;
    const key = cacheKey(base, req);
    const record: CachedRecord = {
      result,
      events,
      requestText: requestText(req),
    };
    await opts.cache.set(key, record, { ttlMs: opts.ttlMs });
    await rememberSemantic(opts.semantic, key, req, record, opts.ttlMs);
  }

  return {
    id: base.id,
    name: base.name,
    provider: base.provider,
    capabilities: base.capabilities,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const hit = await read(req);
      if (hit) return hit.result;
      const result = await base.generate(req);
      const stored = withCacheMetadata(result, false);
      await write(
        req,
        stored,
        cachedEvents({ result: stored, events: [], requestText: requestText(req) }, 'exact'),
      );
      return stored;
    },
    stream(req: GenerateRequest): ModelStream {
      async function* gen() {
        if (!opts.bypass?.(req)) {
          const exact = await opts.cache.get<CachedRecord>(cacheKey(base, req));
          if (exact) {
            yield* cachedEvents(exact, 'exact');
            return;
          }
          const semantic = await semanticLookup(opts.semantic, req);
          if (semantic) {
            yield* cachedEvents(semantic.record, 'semantic', semantic.score);
            return;
          }
        }
        const events: StreamEvent[] = [];
        for await (const event of base.stream(req)) {
          events.push(event);
          yield event;
        }
        const result = await streamFromEvents(events).result();
        await write(req, withCacheMetadata(result, false), events);
      }
      return new ModelStreamImpl(gen());
    },
  };
}
