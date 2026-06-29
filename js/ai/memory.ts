/**
 * fino:ai/memory — durable thread memory, working memory, and vector recall.
 *
 * This module stores information that should outlive a single model context.
 * It is deliberately separate from `MessageHistory`: history is the current
 * model-facing sequence owned by a `HistoryStrategy`, while memory stores
 * durable conversation messages, resource chunks, embeddings, and structured
 * working-memory patches that sessions or strategies may recall.
 *
 * ## Storage model
 *
 * `SqliteMemory` stores thread messages chronologically, working memory as a
 * JSON object, and ingested documents as chunks with embeddings. Semantic recall
 * is available when the sqlite vector extension is available; otherwise the
 * memory still works for chronological history and working memory and reports
 * `semanticAvailable: false`.
 *
 * Memory is scoped by `threadId` for conversation state and by `resourceId` for
 * resource ingestion. `thread(id)` creates another view over the same database
 * with a different thread scope. Close the memory when the application owns the
 * database handle.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 * import { openai } from 'fino:ai/model';
 *
 * const model = openai({ model: 'gpt-4o' });
 * const mem = await memory({
 *   path: './agent-memory.db',
 *   embedder: model,
 *   threadId: 'support-thread',
 * });
 *
 * await mem.append({ role: 'user', content: 'Prefers concise answers.' });
 * await mem.ingest([{ text: 'Refund policy: refunds are available for 30 days.' }]);
 * const recalled = await mem.recall({ text: 'Can I get a refund?', topK: 3 });
 * ```
 */

import { Database, vec, vecDecode } from 'fino:database/sqlite';
import type { ModelMessage } from 'fino:ai/model';

/**
 * Embedding provider used by `SqliteMemory`.
 */
export type Embedder = {
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
};

/**
 * Message persisted in durable memory.
 */
export interface MemoryMessage {
  id: string;
  threadId: string;
  role: ModelMessage['role'];
  content: ModelMessage['content'];
  createdAt: number;
}

/**
 * Query used to recall memory for an agent turn.
 */
export interface MemoryQuery {
  text?: string;
  topK?: number;
  last?: number;
  scope?: 'thread' | 'resource';
  filter?: {
    metadata?: Record<string, unknown>;
  };
}

/**
 * Semantic recall hit returned from ingested memory chunks.
 */
export interface RecallHit {
  id?: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
  citation?: {
    id?: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Combined memory context returned by `Memory.recall()`.
 */
export interface RecalledContext {
  messages: MemoryMessage[];
  recalled: RecallHit[];
  workingMemory: Record<string, unknown> | null;
}

/**
 * Query helper over `Memory.recall()`.
 */
export interface Retriever {
  retrieve(text: string, opts?: Omit<MemoryQuery, 'text'>): Promise<RecallHit[]>;
}

/**
 * Text chunking options for `Memory.ingest()`.
 */
export interface ChunkOptions {
  size?: number;
  overlap?: number;
}

/**
 * Durable memory interface used by sessions and strategies.
 */
export interface Memory {
  readonly threadId: string;
  readonly semanticAvailable: boolean;
  append(msg: Omit<MemoryMessage, 'id' | 'createdAt' | 'threadId'>): Promise<MemoryMessage>;
  history(opts?: { last?: number; before?: number }): Promise<MemoryMessage[]>;
  recall(query?: MemoryQuery): Promise<RecalledContext>;
  ingest(
    docs: { text: string; metadata?: Record<string, unknown> }[],
    opts?: { scope?: 'thread' | 'resource'; chunk?: ChunkOptions },
  ): Promise<void>;
  getWorkingMemory(): Promise<Record<string, unknown> | null>;
  setWorkingMemory(patch: Record<string, unknown>, mode?: 'merge' | 'replace'): Promise<void>;
  thread(id: string): Memory;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Create a retriever over a `Memory` instance.
 *
 * The helper keeps RAG call sites concise when an application only needs
 * semantic hits rather than the full recalled conversation and working-memory
 * context.
 */
export function retriever(memory: Memory, defaults: Omit<MemoryQuery, 'text'> = {}): Retriever {
  return {
    async retrieve(text: string, opts: Omit<MemoryQuery, 'text'> = {}): Promise<RecallHit[]> {
      const ctx = await memory.recall({ ...defaults, ...opts, text });
      return ctx.recalled;
    },
  };
}

/**
 * Options for opening sqlite-backed memory.
 */
export interface SqliteMemoryOptions {
  path: string;
  embedder: Embedder;
  threadId?: string;
  resourceId?: string;
  dimensions?: number;
  historyTokenBudget?: number;
  fs?: object;
}

let idCounter = 0;
function newId(): string {
  return `${++idCounter}-${Math.random().toString(36).slice(2)}`;
}

function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? 1000;
  const overlap = Math.min(opts.overlap ?? 100, size - 1);
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}

function parseRow(r: Record<string, unknown>): MemoryMessage {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as ModelMessage['role'],
    content: JSON.parse(r.content as string),
    createdAt: Number(r.created_at),
  };
}

function metadataMatches(metadata: Record<string, unknown> | undefined, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  if (!metadata) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}

/**
 * Sqlite-backed memory implementation with optional vector recall.
 */
export class SqliteMemory implements Memory {
  #db: Database;
  #ownsDb: boolean;
  #threadId: string;
  #resourceId: string | undefined;
  #embedder: Embedder;
  #dim: number;
  #semantic: boolean;
  #historyTokenBudget: number | undefined;

  private constructor(
    db: Database,
    ownsDb: boolean,
    opts: {
      threadId: string;
      resourceId?: string;
      embedder: Embedder;
      dim: number;
      semantic: boolean;
      historyTokenBudget?: number;
    },
  ) {
    this.#db = db;
    this.#ownsDb = ownsDb;
    this.#threadId = opts.threadId;
    this.#resourceId = opts.resourceId;
    this.#embedder = opts.embedder;
    this.#dim = opts.dim;
    this.#semantic = opts.semantic;
    this.#historyTokenBudget = opts.historyTokenBudget;
  }

  get threadId(): string {
    return this.#threadId;
  }

  get semanticAvailable(): boolean {
    return this.#semantic;
  }

  static async open(opts: SqliteMemoryOptions): Promise<SqliteMemory> {
    const db = await Database.open(opts.path, { fs: opts.fs as never });
    const dim = opts.dimensions ?? opts.embedder.dimensions;
    await db.exec(
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)`,
    );
    await db.exec(
      `CREATE TABLE IF NOT EXISTS working_memory (
        thread_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )`,
    );
    await db.exec(
      `CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT,
        embedding BLOB
      )`,
    );
    let semantic = dim > 0 && db.vectorsAvailable;
    if (semantic) {
      try {
        await db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[${dim}])`,
        );
      } catch {
        semantic = false;
      }
    }
    return new SqliteMemory(db, true, {
      threadId: opts.threadId ?? newId(),
      resourceId: opts.resourceId,
      embedder: opts.embedder,
      dim,
      semantic,
      historyTokenBudget: opts.historyTokenBudget,
    });
  }

  async append(
    msg: Omit<MemoryMessage, 'id' | 'createdAt' | 'threadId'>,
  ): Promise<MemoryMessage> {
    const id = newId();
    const createdAt = Date.now();
    const stmt = this.#db.prepare(
      `INSERT INTO messages(id, thread_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)`,
    );
    try {
      await stmt.run(id, this.#threadId, msg.role, JSON.stringify(msg.content), createdAt);
    } finally {
      stmt.finalize();
    }
    return { id, threadId: this.#threadId, role: msg.role, content: msg.content, createdAt };
  }

  async history(opts: { last?: number; before?: number } = {}): Promise<MemoryMessage[]> {
    let sql =
      `SELECT id, thread_id, role, content, created_at FROM messages WHERE thread_id = ?`;
    const params: unknown[] = [this.#threadId];
    if (opts.before !== undefined) {
      sql += ` AND created_at < ?`;
      params.push(opts.before);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.last ?? 1000);

    const stmt = this.#db.prepare(sql);
    let rows: Record<string, unknown>[];
    try {
      rows = await stmt.all(...params);
    } finally {
      stmt.finalize();
    }

    const msgs = rows.map(parseRow).reverse();

    if (opts.last === undefined && this.#historyTokenBudget !== undefined) {
      let tokens = 0;
      const kept: MemoryMessage[] = [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const c = msgs[i].content;
        tokens += (typeof c === 'string' ? c : JSON.stringify(c)).length / 4;
        if (tokens > this.#historyTokenBudget) break;
        kept.unshift(msgs[i]);
      }
      return kept;
    }

    return msgs;
  }

  async recall(query: MemoryQuery = {}): Promise<RecalledContext> {
    const messages = await this.history({ last: query.last });
    const workingMemory = await this.getWorkingMemory();

    if (!this.#semantic || !query.text) {
      return { messages, recalled: [], workingMemory };
    }

    const topK = query.topK ?? 5;
    const queryEmbs = await this.#embedder.embed([query.text]);
    const queryEmb = queryEmbs[0];
    if (!queryEmb || queryEmb.length === 0) {
      return { messages, recalled: [], workingMemory };
    }

    const scopeId =
      query.scope === 'resource' ? (this.#resourceId ?? this.#threadId) : this.#threadId;

    const knnStmt = this.#db.prepare(
      `SELECT rowid, distance FROM chunk_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    );
    let knnRows: Record<string, unknown>[];
    try {
      knnRows = await knnStmt.all(vec(queryEmb), topK * 3);
    } finally {
      knnStmt.finalize();
    }

    if (knnRows.length === 0) {
      return { messages, recalled: [], workingMemory };
    }

    const rowids = knnRows.map((r) => r.rowid as bigint);
    const placeholders = rowids.map(() => '?').join(',');
    const chunksStmt = this.#db.prepare(
      `SELECT rowid, id, text, metadata, scope_id FROM chunks WHERE rowid IN (${placeholders})`,
    );
    let chunkRows: Record<string, unknown>[];
    try {
      chunkRows = await chunksStmt.all(...rowids);
    } finally {
      chunksStmt.finalize();
    }

    const distByRowid = new Map<bigint, number>(
      knnRows.map((r) => [r.rowid as bigint, r.distance as number]),
    );

    const recalled: RecallHit[] = chunkRows
      .filter((r) => r.scope_id === scopeId)
      .map((r) => ({
        row: r,
        metadata: r.metadata !== null ? JSON.parse(r.metadata as string) as Record<string, unknown> : undefined,
      }))
      .filter(({ metadata }) => metadataMatches(metadata, query.filter?.metadata))
      .sort((a, b) => {
        const da = distByRowid.get(a.row.rowid as bigint) ?? Infinity;
        const db = distByRowid.get(b.row.rowid as bigint) ?? Infinity;
        return da - db;
      })
      .slice(0, topK)
      .map(({ row, metadata }) => ({
        id: row.id as string,
        text: row.text as string,
        score: 1 / (1 + (distByRowid.get(row.rowid as bigint) ?? Infinity)),
        ...(metadata !== undefined ? { metadata } : {}),
        citation: {
          id: row.id as string,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      }));

    return { messages, recalled, workingMemory };
  }

  async ingest(
    docs: { text: string; metadata?: Record<string, unknown> }[],
    opts?: { scope?: 'thread' | 'resource'; chunk?: ChunkOptions },
  ): Promise<void> {
    const { scope = 'thread', chunk: chunkOpts } = opts ?? {};
    const scopeId =
      scope === 'resource' ? (this.#resourceId ?? this.#threadId) : this.#threadId;

    const insertChunk = this.#db.prepare(
      `INSERT OR IGNORE INTO chunks(id, scope_id, text, metadata, embedding) VALUES(?, ?, ?, ?, ?)`,
    );
    const insertVec = this.#semantic
      ? this.#db.prepare(`INSERT INTO chunk_vectors(rowid, embedding) VALUES(?, ?)`)
      : null;

    try {
      for (const doc of docs) {
        const chunks = chunkText(doc.text, chunkOpts);
        const embeddings = await this.#embedder.embed(chunks);
        for (let i = 0; i < chunks.length; i++) {
          const id = newId();
          const embedding = embeddings[i] ?? new Float32Array(this.#dim);
          const blob = new Uint8Array(embedding.buffer);
          const result = await insertChunk.run(
            id,
            scopeId,
            chunks[i],
            doc.metadata !== undefined ? JSON.stringify(doc.metadata) : null,
            blob,
          );
          if (insertVec && result.changes > 0) {
            await insertVec.run(result.lastInsertRowid, vec(embedding));
          }
        }
      }
    } finally {
      insertChunk.finalize();
      insertVec?.finalize();
    }
  }

  async getWorkingMemory(): Promise<Record<string, unknown> | null> {
    const stmt = this.#db.prepare(
      `SELECT data FROM working_memory WHERE thread_id = ?`,
    );
    try {
      const row = await stmt.get(this.#threadId);
      if (!row) return null;
      return JSON.parse(row.data as string);
    } finally {
      stmt.finalize();
    }
  }

  async setWorkingMemory(
    patch: Record<string, unknown>,
    mode: 'merge' | 'replace' = 'merge',
  ): Promise<void> {
    let data: Record<string, unknown>;
    if (mode === 'merge') {
      const existing = await this.getWorkingMemory();
      data = existing ? { ...existing, ...patch } : patch;
    } else {
      data = patch;
    }
    const stmt = this.#db.prepare(
      `INSERT INTO working_memory(thread_id, data) VALUES(?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET data = excluded.data`,
    );
    try {
      await stmt.run(this.#threadId, JSON.stringify(data));
    } finally {
      stmt.finalize();
    }
  }

  thread(id: string): SqliteMemory {
    return new SqliteMemory(this.#db, false, {
      threadId: id,
      resourceId: this.#resourceId,
      embedder: this.#embedder,
      dim: this.#dim,
      semantic: this.#semantic,
      historyTokenBudget: this.#historyTokenBudget,
    });
  }

  async close(): Promise<void> {
    if (this.#ownsDb) await this.#db.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Open sqlite-backed memory.
 *
 * This is the factory-first equivalent of `SqliteMemory.open()`.
 */
export function memory(opts: SqliteMemoryOptions): Promise<Memory> {
  return SqliteMemory.open(opts);
}
