/**
 * fino:ai/memory — durable, cross-session semantic memory for agents.
 *
 * Memory stores embedding-backed facts and behaviours, not conversation
 * history. `SqliteMemory` supplies durable storage, uses sqlite-vec for scoped
 * cosine search when available, and falls back to an exact scan otherwise.
 * `agentMemory()` adds recall policy, labels, bounded utility evidence,
 * optional reinforcement, and optional forgetting. Controllers sharing a
 * namespace and store see the same committed memories, including from
 * concurrent sessions.
 *
 * ## Signals and storage
 *
 * Recall records exposure but does not assume a hit was useful. Applications
 * can complete a returned selection with an eval score, or set stronger
 * memory-specific manual feedback. The store keeps aggregates and bounded,
 * short-lived selection receipts rather than prompts or an evidence ledger.
 *
 * Conversation history and summarization remain in `fino:ai/context` and
 * `fino:ai/session`. See [Agent Memory](./ai/memory-design.md) for the full
 * design and lifecycle.
 *
 * ```ts no_run
 * import { agentMemory, memoryTool, SqliteMemory } from 'fino:ai/memory';
 *
 * const store = await SqliteMemory.open({ path: './memory.db', embedder });
 * const memory = agentMemory({ store, namespace: 'engineering' });
 * const remember = memoryTool(memory, { sessionId: 'debugging' });
 * await remember.run({ text: 'Prefer narrow root-cause fixes.', durability: 'shared' });
 * const selection = await memory.recall({ text: 'How should I fix this?' });
 * await memory.complete(selection.selectionId, { score: .9 });
 * ```
 */
import { Database, vec, vecDecode } from 'fino:database/sqlite';
import { Tool } from 'fino:ai/tool';

/** Minimal embedding provider required by semantic memory. */
export interface Embedder {
  /** Embed texts in input order. Every vector must have `dimensions` values. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Fixed width of vectors produced by `embed()`. Must be positive. */
  readonly dimensions: number;
}

/** A durable shared scope or a semi-ephemeral session scope. */
export type MemoryScope =
  | { type: 'shared'; namespace: string }
  | { type: 'session'; namespace: string; sessionId: string };

/** Bounded, normalized labels used for filtering, ranking, and utility context. */
export type MemoryLabels = Record<string, string[]>;

/** One compact utility aggregate for a label context. */
export interface ContextualMemoryUtility {
  /** Stable normalized representation of the context labels. */
  key: string;
  /** Number of eval outcomes aggregated into this context. */
  evalCount: number;
  /** Sum of conservatively distributed eval scores. */
  evalSum: number;
  /** Last update time in milliseconds since the Unix epoch. */
  updatedAt: number;
}

/** Compact evidence retained for one memory. No raw messages are stored. */
export interface MemoryUtility {
  /** Number of times this memory was returned by recall. */
  exposures: number;
  /** Last exposure time, or `null` before first recall. */
  lastExposedAt: number | null;
  /** Number of eval bundles contributing to this memory. */
  evalCount: number;
  /** Sum of conservatively distributed eval scores. */
  evalSum: number;
  /** Mutable manual value in `[-1, 1]`, or `null` when unset. */
  manual: number | null;
  /** Last manual feedback time, or `null`. */
  manualUpdatedAt: number | null;
  /** Last positive reinforcement time, or `null`. */
  reinforcedAt: number | null;
  /** Bounded utility summaries for relevant label contexts. */
  contexts: ContextualMemoryUtility[];
}

/** A stored semantic memory. */
export interface MemoryRecord {
  /** Stable store-assigned identifier. */
  id: string;
  /** Text embedded and returned to an agent when recalled. */
  text: string;
  /** Explicit access scope. */
  scope: MemoryScope;
  /** Normalized descriptive labels. */
  labels: MemoryLabels;
  /** Optional application metadata, not interpreted by memory policy. */
  metadata?: Record<string, unknown>;
  /** Base retention importance in `[0, 1]`. Defaults to `.5`. */
  importance: number;
  /** Creation time in milliseconds since the Unix epoch. */
  createdAt: number;
  /** Last mutation time in milliseconds since the Unix epoch. */
  updatedAt: number;
  /** Expiry time for semi-ephemeral entries, or `null`. */
  expiresAt: number | null;
  /** Compact mutable utility state. */
  utility: MemoryUtility;
}

/** Candidate returned by a `MemoryStore` before controller policy reranking. */
export interface MemoryCandidate extends MemoryRecord {
  /** Embedding similarity, where larger values are more relevant. */
  similarity: number;
}

/** Input accepted by the durable store. Controllers normally construct this. */
export interface MemoryStoreInput {
  text: string;
  scope: MemoryScope;
  labels: MemoryLabels;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: number;
  expiresAt: number | null;
  embedding: Float32Array;
}

/** Short-lived receipt connecting an eval outcome to an exact recall bundle. */
export interface MemorySelectionReceipt {
  id: string;
  namespace: string;
  memoryIds: string[];
  contextKey: string;
  createdAt: number;
}

/**
 * Durable mechanism used by `AgentMemoryController`.
 *
 * Implementations must make `consumeSelection()` single-use and atomically
 * apply its aggregate updates. Store values are plain structured data so the
 * interface can be adapted across Realm boundaries.
 */
export interface MemoryStore {
  /** Whether embeddings can be searched. */
  readonly semanticAvailable: boolean;
  /** Embed query or entry text using the store's compatible embedding model. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Persist one fully-scoped entry. */
  put(input: MemoryStoreInput): Promise<MemoryRecord>;
  /** Replace labels after best-effort automatic classification. */
  setLabels(id: string, labels: MemoryLabels, updatedAt: number): Promise<MemoryRecord | null>;
  /** Return one memory by id, including currently suppressed entries. */
  get(id: string): Promise<MemoryRecord | null>;
  /** Search shared and optionally matching session entries by embedding. */
  search(input: {
    namespace: string;
    sessionId?: string;
    embedding: Float32Array;
    limit: number;
  }): Promise<MemoryCandidate[]>;
  /** Record exposures and a bounded selection receipt. */
  recordSelection(receipt: MemorySelectionReceipt, maxSelections: number): Promise<void>;
  /** Consume one receipt and apply an eval contribution exactly once. */
  consumeSelection(input: {
    selectionId: string;
    score: number;
    now: number;
    maxContexts: number;
    reinforce: boolean;
  }): Promise<boolean>;
  /** Replace or clear memory-specific manual feedback. */
  setManual(
    id: string,
    value: number | null,
    now: number,
    reinforce: boolean,
  ): Promise<MemoryRecord | null>;
  /** Release owned storage resources. Repeated calls are harmless. */
  close(): Promise<void>;
}

/** Input supplied to a configurable lightweight label classifier. */
export interface MemoryLabelInput {
  /** Text or summary being classified. */
  text: string;
  /** Classification moment, allowing different prompts or rules. */
  source: 'memory' | 'message' | 'session';
}

/** Optional classifier used to infer bounded labels. */
export interface MemoryLabeler {
  /** Return proposed labels. Errors are treated as best-effort failures. */
  label(input: MemoryLabelInput): Promise<MemoryLabels>;
}

/** Rules controlling automatic and explicit label cardinality. */
export interface MemoryLabelRules {
  /** Allowed keys and, when non-empty, allowed values for each key. */
  allowed?: Record<string, string[]>;
  /** Maximum retained values per key. Defaults to `3`. */
  maxPerKey?: number;
}

/** Caller-facing scope. Namespace authority is bound by the controller. */
export type MemoryRememberScope = { type: 'shared' } | { type: 'session'; sessionId: string };

/** Input for creating a memory directly or through the creation tool. */
export interface RememberMemoryInput {
  /** Text to embed and remember. */
  text: string;
  /** Shared by default; session scope requires an explicit session id. */
  scope?: MemoryRememberScope;
  /** Explicit labels committed with the entry. */
  labels?: MemoryLabels;
  /** Application metadata copied to the entry. */
  metadata?: Record<string, unknown>;
  /** Base importance in `[0, 1]`. Defaults to `.5`. */
  importance?: number;
  /** Optional expiry time in milliseconds since the Unix epoch. */
  expiresAt?: number;
}

/** Query for semantic recall. */
export interface MemoryQuery {
  /** Natural-language text to embed. */
  text: string;
  /** Maximum returned hits. Defaults to `5`. */
  topK?: number;
  /** Include session-scoped memories for this session in addition to shared memories. */
  sessionId?: string;
  /** Optional run identifier retained only by the caller, not as evidence. */
  runId?: string;
  /** Message or session labels used for boosts and contextual utility. */
  labels?: MemoryLabels;
  /** Explicit hard filters. */
  filter?: { labels?: MemoryLabels; metadata?: Record<string, unknown> };
}

/** A recalled entry with semantic and policy ranking details. */
export interface RecallHit extends MemoryRecord {
  /** Raw embedding similarity. */
  similarity: number;
  /** Final controller score after bounded boosts and optional utility. */
  score: number;
  /** Current retention multiplier; `1` when forgetting is disabled. */
  retention: number;
  /** Source attribution suitable for model context or UI. */
  citation: { id: string; metadata?: Record<string, unknown> };
}

/** Immutable result of one recall operation. */
export interface MemorySelection {
  /** Single-use id accepted by `complete()`. */
  selectionId: string;
  /** Normalized labels describing this work chunk. */
  labels: MemoryLabels;
  /** Ranked semantic hits. */
  hits: RecallHit[];
}

/** Optional exponential retention policy. */
export interface MemoryForgettingOptions {
  /** Base half-life in milliseconds before importance and utility adjustments. */
  halfLifeMs: number;
  /** Suppress hits below this retention multiplier. Defaults to `.05`. */
  suppressBelow?: number;
}

/** Controller construction options. */
export interface AgentMemoryOptions {
  /** Durable shared store. */
  store: MemoryStore;
  /** Access namespace bound to this controller. */
  namespace: string;
  /** Optional lightweight automatic classifier. */
  labeler?: MemoryLabeler;
  /** Label normalization and vocabulary rules. */
  labelRules?: MemoryLabelRules;
  /** Whether utility affects ranking and retention. Defaults to `false`. */
  reinforcement?: boolean;
  /** Exponential forgetting policy, or `false` to disable it. Defaults to `false`. */
  forgetting?: false | MemoryForgettingOptions;
  /** Maximum contextual summaries retained per memory. Defaults to `8`. */
  maxContexts?: number;
  /** Maximum outstanding selection receipts per namespace. Defaults to `256`. */
  maxSelections?: number;
  /** Semantic candidates considered per requested hit. Defaults to `4`. */
  overfetch?: number;
  /** Minimum semantic similarity admitted to policy ranking. Defaults to `.01`. */
  minSimilarity?: number;
  /** Injected clock used by all lifecycle policy. Defaults to `Date.now`. */
  now?: () => number;
}

/** Narrow semantic retrieval adapter for RAG call sites. */
export interface Retriever {
  /** Return recalled hits for `text`, with call options overriding defaults. */
  retrieve(text: string, opts?: Omit<MemoryQuery, 'text'>): Promise<RecallHit[]>;
}

const EMPTY_UTILITY: MemoryUtility = {
  exposures: 0,
  lastExposedAt: null,
  evalCount: 0,
  evalSum: 0,
  manual: null,
  manualUpdatedAt: null,
  reinforcedAt: null,
  contexts: [],
};

let idCounter = 0;
function newId(): string {
  return `${Date.now().toString(36)}-${++idCounter}-${Math.random().toString(36).slice(2)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseJson<T>(value: unknown, fallback: T): T {
  return value === null || value === undefined ? fallback : (JSON.parse(value as string) as T);
}

function parseScope(row: Record<string, unknown>): MemoryScope {
  const namespace = row.namespace as string;
  return row.scope_type === 'session'
    ? { type: 'session', namespace, sessionId: row.session_id as string }
    : { type: 'shared', namespace };
}

function parseRecord(row: Record<string, unknown>): MemoryRecord {
  const metadata = parseJson<Record<string, unknown> | undefined>(row.metadata, undefined);
  return {
    id: row.id as string,
    text: row.text as string,
    scope: parseScope(row),
    labels: parseJson(row.labels, {}),
    ...(metadata !== undefined ? { metadata } : {}),
    importance: Number(row.importance),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    utility: parseJson(row.utility, structuredClone(EMPTY_UTILITY)),
  };
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

function vectorScopeKey(scope: MemoryScope): string {
  return scope.type === 'shared' ? 'shared' : `session:${scope.sessionId}`;
}

/** Options for opening the sqlite-backed durable memory store. */
export interface SqliteMemoryOptions {
  /** Filesystem path of the database, created when absent. */
  path: string;
  /** Embedding model defining the store's vector space. */
  embedder: Embedder;
  /** Optional filesystem provider forwarded to sqlite. */
  fs?: object;
}

/** Sqlite implementation of the durable `MemoryStore` contract. */
export class SqliteMemory implements MemoryStore {
  #db: Database;
  #embedder: Embedder;
  #vectorSearch: boolean;
  #closed = false;
  #writes: Promise<unknown> = Promise.resolve();

  private constructor(db: Database, embedder: Embedder, vectorSearch: boolean) {
    this.#db = db;
    this.#embedder = embedder;
    this.#vectorSearch = vectorSearch;
  }

  /** Embedding search is available whenever the configured dimension is positive. */
  get semanticAvailable(): boolean {
    return this.#embedder.dimensions > 0;
  }

  /** Embed text with the model that defines this store's vector space. */
  embed(texts: string[]): Promise<Float32Array[]> {
    return this.#embedder.embed(texts);
  }

  /**
   * Open a sqlite memory store, creating its versioned schema when needed.
   * The optional `fs` is forwarded to `Database.open()`.
   */
  static async open(opts: SqliteMemoryOptions): Promise<SqliteMemory> {
    if (opts.embedder.dimensions <= 0)
      throw new RangeError('Memory embedder dimensions must be positive');
    const db = await Database.open(opts.path, { fs: opts.fs as never });
    await db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      session_id TEXT,
      text TEXT NOT NULL,
      labels TEXT NOT NULL,
      metadata TEXT,
      importance REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      utility TEXT NOT NULL,
      embedding BLOB NOT NULL
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_scope
      ON memory_entries(namespace, scope_type, session_id)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS memory_selections (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      memory_ids TEXT NOT NULL,
      context_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_selections
      ON memory_selections(namespace, created_at)`);
    let vectorSearch = db.vectorsAvailable;
    if (vectorSearch) {
      try {
        await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
          namespace TEXT partition key,
          scope_key TEXT,
          embedding float[${opts.embedder.dimensions}] distance_metric=cosine
        )`);
        const missing = db.prepare(`SELECT rowid, namespace, scope_type, session_id, embedding
          FROM memory_entries WHERE rowid NOT IN (SELECT rowid FROM memory_vectors)`);
        const insert = db.prepare(
          `INSERT INTO memory_vectors(rowid, namespace, scope_key, embedding) VALUES(?, ?, ?, ?)`,
        );
        try {
          const rows = await missing.all();
          await db.transaction(async () => {
            for (const row of rows) {
              const scope = parseScope(row);
              await insert.run(
                row.rowid as bigint,
                scope.namespace,
                vectorScopeKey(scope),
                vec(vecDecode(row.embedding as Uint8Array)),
              );
            }
          });
        } finally {
          missing.finalize();
          insert.finalize();
        }
      } catch {
        vectorSearch = false;
      }
    }
    return new SqliteMemory(db, opts.embedder, vectorSearch);
  }

  #write<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#writes.then(operation, operation);
    this.#writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Persist one memory after validating its embedding width. */
  put(input: MemoryStoreInput): Promise<MemoryRecord> {
    return this.#write(async () => {
      if (input.embedding.length !== this.#embedder.dimensions) {
        throw new RangeError(`Expected ${this.#embedder.dimensions} embedding values`);
      }
      const id = newId();
      const utility = structuredClone(EMPTY_UTILITY);
      const entry = this.#db.prepare(`INSERT INTO memory_entries(
        id, namespace, scope_type, session_id, text, labels, metadata, importance,
        created_at, updated_at, expires_at, utility, embedding
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const vector = this.#vectorSearch
        ? this.#db.prepare(
            `INSERT INTO memory_vectors(rowid, namespace, scope_key, embedding)
              VALUES(?, ?, ?, ?)`,
          )
        : null;
      try {
        await this.#db.transaction(async () => {
          const result = await entry.run(
            id,
            input.scope.namespace,
            input.scope.type,
            input.scope.type === 'session' ? input.scope.sessionId : null,
            input.text,
            JSON.stringify(input.labels),
            input.metadata === undefined ? null : JSON.stringify(input.metadata),
            input.importance,
            input.createdAt,
            input.createdAt,
            input.expiresAt,
            JSON.stringify(utility),
            new Uint8Array(
              input.embedding.buffer,
              input.embedding.byteOffset,
              input.embedding.byteLength,
            ),
          );
          await vector?.run(
            result.lastInsertRowid,
            input.scope.namespace,
            vectorScopeKey(input.scope),
            vec(input.embedding),
          );
        });
      } finally {
        entry.finalize();
        vector?.finalize();
      }
      return {
        id,
        text: input.text,
        scope: structuredClone(input.scope),
        labels: structuredClone(input.labels),
        ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}),
        importance: input.importance,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        expiresAt: input.expiresAt,
        utility,
      };
    });
  }

  /** Replace labels for an existing memory. */
  setLabels(id: string, labels: MemoryLabels, updatedAt: number): Promise<MemoryRecord | null> {
    return this.#write(async () => {
      const stmt = this.#db.prepare(
        `UPDATE memory_entries SET labels = ?, updated_at = ? WHERE id = ?`,
      );
      try {
        const result = await stmt.run(JSON.stringify(labels), updatedAt, id);
        if (result.changes === 0) return null;
      } finally {
        stmt.finalize();
      }
      return this.get(id);
    });
  }

  /** Load a memory by id. */
  async get(id: string): Promise<MemoryRecord | null> {
    const stmt = this.#db.prepare(`SELECT * FROM memory_entries WHERE id = ?`);
    try {
      const row = await stmt.get(id);
      return row ? parseRecord(row) : null;
    } finally {
      stmt.finalize();
    }
  }

  /** Search embeddings in the shared namespace and one optional session scope. */
  async search(input: {
    namespace: string;
    sessionId?: string;
    embedding: Float32Array;
    limit: number;
  }): Promise<MemoryCandidate[]> {
    if (input.limit <= 0) return [];
    if (this.#vectorSearch) return this.#searchVectors(input);
    const sql = input.sessionId
      ? `SELECT * FROM memory_entries WHERE namespace = ? AND
          (scope_type = 'shared' OR (scope_type = 'session' AND session_id = ?))`
      : `SELECT * FROM memory_entries WHERE namespace = ? AND scope_type = 'shared'`;
    const stmt = this.#db.prepare(sql);
    try {
      const rows = input.sessionId
        ? await stmt.all(input.namespace, input.sessionId)
        : await stmt.all(input.namespace);
      return rows
        .map((row) => ({
          ...parseRecord(row),
          similarity: cosine(input.embedding, vecDecode(row.embedding as Uint8Array)),
        }))
        .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
        .slice(0, input.limit);
    } finally {
      stmt.finalize();
    }
  }

  async #searchVectors(input: {
    namespace: string;
    sessionId?: string;
    embedding: Float32Array;
    limit: number;
  }): Promise<MemoryCandidate[]> {
    const knn = this.#db.prepare(`SELECT rowid, distance FROM memory_vectors
      WHERE embedding MATCH ? AND k = ? AND namespace = ? AND scope_key = ?
      ORDER BY distance`);
    try {
      const scopes = ['shared'];
      if (input.sessionId) scopes.push(`session:${input.sessionId}`);
      const nearest = new Map<string, { rowid: bigint | number; similarity: number }>();
      for (const scope of scopes) {
        const rows = await knn.all(vec(input.embedding), input.limit, input.namespace, scope);
        for (const row of rows) {
          const rowid = row.rowid as bigint | number;
          const key = String(rowid);
          const similarity = 1 - Number(row.distance);
          const previous = nearest.get(key);
          if (!previous || similarity > previous.similarity) {
            nearest.set(key, { rowid, similarity });
          }
        }
      }
      const hits = [...nearest.values()];
      if (hits.length === 0) return [];
      const load = this.#db.prepare(
        `SELECT rowid AS vector_rowid, * FROM memory_entries WHERE rowid IN (${hits
          .map(() => '?')
          .join(', ')})`,
      );
      try {
        const rows = await load.all(...hits.map((hit) => hit.rowid));
        const similarities = new Map(hits.map((hit) => [String(hit.rowid), hit.similarity]));
        return rows
          .map((row) => ({
            ...parseRecord(row),
            similarity: similarities.get(String(row.vector_rowid))!,
          }))
          .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
          .slice(0, input.limit);
      } finally {
        load.finalize();
      }
    } finally {
      knn.finalize();
    }
  }

  /** Atomically record aggregate exposure and retain a bounded selection receipt. */
  recordSelection(receipt: MemorySelectionReceipt, maxSelections: number): Promise<void> {
    return this.#write(() =>
      this.#db.transaction(async () => {
        const select = this.#db.prepare(`INSERT INTO memory_selections VALUES(?, ?, ?, ?, ?)`);
        const load = this.#db.prepare(`SELECT utility FROM memory_entries WHERE id = ?`);
        const update = this.#db.prepare(
          `UPDATE memory_entries SET utility = ?, updated_at = ? WHERE id = ?`,
        );
        const prune = this.#db
          .prepare(`DELETE FROM memory_selections WHERE namespace = ? AND id NOT IN (
          SELECT id FROM memory_selections WHERE namespace = ? ORDER BY created_at DESC, id DESC LIMIT ?
        )`);
        try {
          await select.run(
            receipt.id,
            receipt.namespace,
            JSON.stringify(receipt.memoryIds),
            receipt.contextKey,
            receipt.createdAt,
          );
          for (const id of receipt.memoryIds) {
            const row = await load.get(id);
            if (!row) continue;
            const utility = parseJson<MemoryUtility>(row.utility, structuredClone(EMPTY_UTILITY));
            utility.exposures++;
            utility.lastExposedAt = receipt.createdAt;
            await update.run(JSON.stringify(utility), receipt.createdAt, id);
          }
          await prune.run(receipt.namespace, receipt.namespace, maxSelections);
        } finally {
          select.finalize();
          load.finalize();
          update.finalize();
          prune.finalize();
        }
      }),
    );
  }

  /** Consume a selection once and aggregate its observational eval score. */
  consumeSelection(input: {
    selectionId: string;
    score: number;
    now: number;
    maxContexts: number;
    reinforce: boolean;
  }): Promise<boolean> {
    return this.#write(() =>
      this.#db.transaction(async () => {
        const consume = this.#db.prepare(
          `DELETE FROM memory_selections WHERE id = ? RETURNING memory_ids, context_key`,
        );
        const load = this.#db.prepare(`SELECT utility FROM memory_entries WHERE id = ?`);
        const update = this.#db.prepare(
          `UPDATE memory_entries SET utility = ?, updated_at = ? WHERE id = ?`,
        );
        try {
          const receipt = await consume.get(input.selectionId);
          if (!receipt) return false;
          const ids = parseJson<string[]>(receipt.memory_ids, []);
          const contribution = .5 + (input.score - .5) / Math.max(1, ids.length);
          for (const id of ids) {
            const row = await load.get(id);
            if (!row) continue;
            const utility = parseJson<MemoryUtility>(row.utility, structuredClone(EMPTY_UTILITY));
            utility.evalCount++;
            utility.evalSum += contribution;
            if (input.reinforce && input.score > .5) utility.reinforcedAt = input.now;
            const contextKey = receipt.context_key as string;
            if (contextKey) {
              const existing = utility.contexts.find((context) => context.key === contextKey);
              if (existing) {
                existing.evalCount++;
                existing.evalSum += contribution;
                existing.updatedAt = input.now;
              } else {
                utility.contexts.push({
                  key: contextKey,
                  evalCount: 1,
                  evalSum: contribution,
                  updatedAt: input.now,
                });
              }
              utility.contexts.sort(
                (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
              );
              utility.contexts.length = Math.min(utility.contexts.length, input.maxContexts);
            }
            await update.run(JSON.stringify(utility), input.now, id);
          }
          return true;
        } finally {
          consume.finalize();
          load.finalize();
          update.finalize();
        }
      }),
    );
  }

  /** Replace or clear the compact manual value for one memory. */
  setManual(
    id: string,
    value: number | null,
    now: number,
    reinforce: boolean,
  ): Promise<MemoryRecord | null> {
    return this.#write(async () => {
      const record = await this.get(id);
      if (!record) return null;
      record.utility.manual = value;
      record.utility.manualUpdatedAt = value === null ? null : now;
      if (reinforce && value !== null && value > 0) record.utility.reinforcedAt = now;
      const stmt = this.#db.prepare(
        `UPDATE memory_entries SET utility = ?, updated_at = ? WHERE id = ?`,
      );
      try {
        await stmt.run(JSON.stringify(record.utility), now, id);
      } finally {
        stmt.finalize();
      }
      return { ...record, updatedAt: now };
    });
  }

  /** Close the sqlite connection. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writes;
    await this.#db.close();
  }

  /** Async-disposal hook equivalent to `close()`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

const DEFAULT_ALLOWED_LABELS: Record<string, string[]> = {
  topic: [],
  kind: [],
  project: [],
  task: [],
  tool: [],
};

function normalizeLabels(labels: MemoryLabels | undefined, rules: MemoryLabelRules): MemoryLabels {
  if (!labels) return {};
  const allowed = rules.allowed ?? DEFAULT_ALLOWED_LABELS;
  const max = Math.max(0, Math.floor(rules.maxPerKey ?? 3));
  const result: MemoryLabels = {};
  for (const key of Object.keys(labels).sort()) {
    if (!(key in allowed)) continue;
    const allowedValues = new Set(allowed[key]!.map((value) => value.trim().toLowerCase()));
    const values = [
      ...new Set(labels[key]!.map((value) => value.trim().toLowerCase()).filter(Boolean)),
    ]
      .filter((value) => allowedValues.size === 0 || allowedValues.has(value))
      .slice(0, max);
    if (values.length > 0) result[key] = values;
  }
  return result;
}

function mergeLabels(
  left: MemoryLabels,
  right: MemoryLabels,
  rules: MemoryLabelRules,
): MemoryLabels {
  const merged: MemoryLabels = structuredClone(left);
  for (const [key, values] of Object.entries(right))
    merged[key] = [...(merged[key] ?? []), ...values];
  return normalizeLabels(merged, rules);
}

function contextKey(labels: MemoryLabels): string {
  return Object.keys(labels).length === 0 ? '' : JSON.stringify(labels);
}

function labelsMatch(actual: MemoryLabels, expected: MemoryLabels | undefined): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, values]) =>
    values.every((value) => actual[key]?.includes(value)),
  );
}

function metadataMatch(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function labelOverlap(left: MemoryLabels, right: MemoryLabels): number {
  let matches = 0;
  let total = 0;
  for (const [key, values] of Object.entries(right)) {
    for (const value of values) {
      total++;
      if (left[key]?.includes(value)) matches++;
    }
  }
  return total === 0 ? 0 : matches / total;
}

/**
 * Stateful policy coordinator over a durable, concurrently shared store.
 *
 * The controller has no ambient current-session slot. Every session-specific
 * operation carries an explicit session id, so one controller can safely be
 * shared by simultaneous agent sessions.
 */
export class AgentMemoryController {
  #opts: Required<
    Pick<
      AgentMemoryOptions,
      | 'namespace'
      | 'reinforcement'
      | 'maxContexts'
      | 'maxSelections'
      | 'overfetch'
      | 'minSimilarity'
      | 'now'
    >
  > &
    AgentMemoryOptions;

  /** Create a controller. Prefer the `agentMemory()` factory. */
  constructor(opts: AgentMemoryOptions) {
    if (!opts.namespace) throw new TypeError('Memory namespace must not be empty');
    this.#opts = {
      ...opts,
      reinforcement: opts.reinforcement ?? false,
      forgetting: opts.forgetting ?? false,
      maxContexts: Math.max(0, Math.floor(opts.maxContexts ?? 8)),
      maxSelections: Math.max(1, Math.floor(opts.maxSelections ?? 256)),
      overfetch: Math.max(1, Math.floor(opts.overfetch ?? 4)),
      minSimilarity: opts.minSimilarity ?? .01,
      now: opts.now ?? Date.now,
    };
  }

  /** Namespace bound to this controller. */
  get namespace(): string {
    return this.#opts.namespace;
  }

  async #automaticLabels(text: string, source: MemoryLabelInput['source']): Promise<MemoryLabels> {
    if (!this.#opts.labeler) return {};
    try {
      return normalizeLabels(
        await this.#opts.labeler.label({ text, source }),
        this.#opts.labelRules ?? {},
      );
    } catch {
      return {};
    }
  }

  /**
   * Classify a message, memory candidate, or session summary with the
   * configured bounded label rules. Returns an empty object on classifier
   * failure or when no labeler is configured.
   */
  labels(input: MemoryLabelInput): Promise<MemoryLabels> {
    return this.#automaticLabels(input.text, input.source);
  }

  /** Embed, commit, and optionally auto-label one durable memory. */
  async remember(input: RememberMemoryInput): Promise<MemoryRecord> {
    if (!input.text.trim()) throw new TypeError('Memory text must not be empty');
    const importance = clamp(input.importance ?? .5, 0, 1);
    const now = this.#opts.now();
    const store = this.#opts.store;
    const vectors = await store.embed([input.text]);
    const vector = vectors[0];
    if (!vector) throw new Error('Memory embedder returned no vector');
    const scope: MemoryScope =
      input.scope?.type === 'session'
        ? { type: 'session', namespace: this.namespace, sessionId: input.scope.sessionId }
        : { type: 'shared', namespace: this.namespace };
    let record = await store.put({
      text: input.text,
      scope,
      labels: normalizeLabels(input.labels, this.#opts.labelRules ?? {}),
      ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}),
      importance,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
      embedding: vector,
    });
    if (!input.labels && this.#opts.labeler) {
      const labels = await this.#automaticLabels(input.text, 'memory');
      record = (await store.setLabels(record.id, labels, this.#opts.now())) ?? record;
    }
    return record;
  }

  /** Recall semantic memories and record bounded exposure evidence. */
  async recall(query: MemoryQuery): Promise<MemorySelection> {
    if (!query.text.trim()) throw new TypeError('Memory query text must not be empty');
    const explicitLabels = normalizeLabels(query.labels, this.#opts.labelRules ?? {});
    const inferred = query.labels ? {} : await this.#automaticLabels(query.text, 'message');
    const labels = mergeLabels(explicitLabels, inferred, this.#opts.labelRules ?? {});
    const store = this.#opts.store;
    const vectors = await store.embed([query.text]);
    const embedding = vectors[0];
    if (!embedding) throw new Error('Memory embedder returned no vector');
    const topK = Math.max(0, Math.floor(query.topK ?? 5));
    const now = this.#opts.now();
    const candidates = await store.search({
      namespace: this.namespace,
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      embedding,
      limit: Math.max(topK, topK * this.#opts.overfetch),
    });
    const filterLabels = normalizeLabels(query.filter?.labels, this.#opts.labelRules ?? {});
    const hits = candidates
      .filter((candidate) => candidate.similarity >= this.#opts.minSimilarity)
      .filter((candidate) => candidate.expiresAt === null || candidate.expiresAt > now)
      .filter((candidate) => labelsMatch(candidate.labels, filterLabels))
      .filter((candidate) => metadataMatch(candidate.metadata, query.filter?.metadata))
      .map((candidate) => this.#rank(candidate, labels, now))
      .filter((hit) => hit !== null)
      .sort((a, b) => b.score - a.score || b.similarity - a.similarity || a.id.localeCompare(b.id))
      .slice(0, topK);
    const selectionId = newId();
    await store.recordSelection(
      {
        id: selectionId,
        namespace: this.namespace,
        memoryIds: hits.map((hit) => hit.id),
        contextKey: contextKey(labels),
        createdAt: now,
      },
      this.#opts.maxSelections,
    );
    return { selectionId, labels, hits };
  }

  #rank(candidate: MemoryCandidate, labels: MemoryLabels, now: number): RecallHit | null {
    let utility = 0;
    if (this.#opts.reinforcement) {
      const evalUtility =
        candidate.utility.evalCount === 0
          ? 0
          : (candidate.utility.evalSum / candidate.utility.evalCount) * 2 - 1;
      const manual = candidate.utility.manual ?? 0;
      const contextual = candidate.utility.contexts.find(
        (context) => context.key === contextKey(labels),
      );
      const contextUtility =
        !contextual || contextual.evalCount === 0
          ? 0
          : (contextual.evalSum / contextual.evalCount) * 2 - 1;
      utility = clamp(evalUtility * .3 + manual * .6 + contextUtility * .1, -1, 1);
    }
    let retention = 1;
    if (this.#opts.forgetting) {
      const origin = candidate.utility.reinforcedAt ?? candidate.createdAt;
      const halfLife =
        this.#opts.forgetting.halfLifeMs *
        (.5 + candidate.importance) *
        (1 + Math.max(0, utility));
      retention = halfLife <= 0 ? 0 : Math.exp(-(now - origin) / halfLife);
      if (retention < (this.#opts.forgetting.suppressBelow ?? .05)) return null;
    }
    const boost = labelOverlap(candidate.labels, labels) * .05;
    const score = candidate.similarity * retention + boost + utility * .1;
    return {
      ...candidate,
      score,
      retention,
      citation: {
        id: candidate.id,
        ...(candidate.metadata !== undefined
          ? { metadata: structuredClone(candidate.metadata) }
          : {}),
      },
    };
  }

  /** Apply one observational eval score to a returned selection. */
  complete(selectionId: string, outcome: { score: number }): Promise<boolean> {
    if (outcome.score < 0 || outcome.score > 1 || !Number.isFinite(outcome.score)) {
      throw new RangeError('Memory eval score must be between 0 and 1');
    }
    return this.#opts.store.consumeSelection({
      selectionId,
      score: outcome.score,
      now: this.#opts.now(),
      maxContexts: this.#opts.maxContexts,
      reinforce: this.#opts.reinforcement,
    });
  }

  /** Set, replace, or clear the strongest memory-specific utility signal. */
  async feedback(
    memoryId: string,
    feedback: { value: number | null },
  ): Promise<MemoryRecord | null> {
    if (
      feedback.value !== null &&
      (feedback.value < -1 || feedback.value > 1 || !Number.isFinite(feedback.value))
    ) {
      throw new RangeError('Manual memory feedback must be between -1 and 1');
    }
    return this.#opts.store.setManual(
      memoryId,
      feedback.value,
      this.#opts.now(),
      this.#opts.reinforcement,
    );
  }

  /** Inspect one entry without applying recall policy or exposure. */
  get(memoryId: string): Promise<MemoryRecord | null> {
    return this.#opts.store.get(memoryId);
  }

  /** Close the owned or injected store. Repeated calls are delegated safely. */
  close(): Promise<void> {
    return this.#opts.store.close();
  }

  /** Async-disposal hook equivalent to `close()`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Create a policy controller over a shared durable memory store. */
export function agentMemory(opts: AgentMemoryOptions): AgentMemoryController {
  return new AgentMemoryController(opts);
}

/** Create a narrow semantic retriever over an agent-memory controller. */
export function retriever(
  memory: AgentMemoryController,
  defaults: Omit<MemoryQuery, 'text'> = {},
): Retriever {
  return {
    async retrieve(text, opts = {}) {
      return (await memory.recall({ ...defaults, ...opts, text })).hits;
    },
  };
}

/** Options binding namespace-safe authority into `memoryTool()`. */
export interface MemoryToolOptions {
  /** Session id allowed for session-durability writes. */
  sessionId?: string;
  /** Model-visible tool name. Defaults to `remember`. */
  name?: string;
}

/** Options for opening sqlite storage and constructing a controller at once. */
export type MemoryOptions = Omit<AgentMemoryOptions, 'store'> & SqliteMemoryOptions;

/**
 * Create an opt-in validated tool for memory creation.
 *
 * Namespace is always bound by the controller. A session write is rejected
 * unless the tool factory was given a session id, preventing model arguments
 * from selecting arbitrary scopes.
 */
export function memoryTool(
  memory: AgentMemoryController,
  opts: MemoryToolOptions = {},
): Tool<
  {
    text: string;
    durability?: 'shared' | 'session';
    labels?: MemoryLabels;
    importance?: number;
    expiresAt?: number;
  },
  { content: string }
> {
  return new Tool({
    name: opts.name ?? 'remember',
    description: 'Store a durable fact, decision, preference, or behaviour for semantic recall.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        durability: { type: 'string', enum: ['shared', 'session'] },
        labels: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        expiresAt: { type: 'number' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    sideEffects: true,
    execute: async (args: {
      text: string;
      durability?: 'shared' | 'session';
      labels?: MemoryLabels;
      importance?: number;
      expiresAt?: number;
    }) => {
      if (args.durability === 'session' && !opts.sessionId) {
        return { content: 'Cannot create session memory without a bound session id.' };
      }
      const record = await memory.remember({
        text: args.text,
        ...(args.durability === 'session'
          ? { scope: { type: 'session' as const, sessionId: opts.sessionId! } }
          : {}),
        ...(args.labels !== undefined ? { labels: args.labels } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
      });
      return { content: `Remembered ${record.id}.` };
    },
  });
}

/** Convenience factory that opens a sqlite store and binds a controller. */
export async function memory(opts: MemoryOptions): Promise<AgentMemoryController> {
  const store = await SqliteMemory.open({
    path: opts.path,
    embedder: opts.embedder,
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
  });
  return agentMemory({ ...opts, store });
}
