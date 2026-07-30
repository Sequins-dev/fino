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
 * `SqliteMemory` stores three kinds of state in one sqlite database: thread
 * messages in chronological order, working memory as a single JSON object per
 * thread, and ingested documents as text chunks with embeddings. Semantic
 * recall requires the sqlite vector extension (`vec0`) and a non-zero embedding
 * dimension; when either is missing the memory still works for chronological
 * history and working memory and reports `semanticAvailable: false`, with
 * `recall()` degrading to an empty `recalled` list.
 *
 * Memory is scoped by `threadId` for conversation state and by `resourceId`
 * for cross-thread resource ingestion. `thread(id)` creates another view over
 * the same database with a different thread scope; only the instance returned
 * by `memory()` / `SqliteMemory.open()` owns the database handle, so closing a
 * `thread()` view is a no-op. Close (or `await using`) the owning memory when
 * the application is done with it.
 *
 * `retriever()` wraps a memory in the narrow `Retriever` contract for RAG call
 * sites that only need semantic hits, not the full recalled context.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 * import { openai } from 'fino:ai/model';
 *
 * const embedder = openai({ dimensions: 1536 });
 * const mem = await memory({
 *   path: './agent-memory.db',
 *   embedder,
 *   threadId: 'support-thread',
 * });
 *
 * await mem.append({ role: 'user', content: 'Prefers concise answers.' });
 * await mem.ingest([{ text: 'Refund policy: refunds are available for 30 days.' }]);
 * const recalled = await mem.recall({ text: 'Can I get a refund?', topK: 3 });
 * await mem.close();
 * ```
 */
import { Database, vec, vecDecode } from 'fino:database/sqlite';
import type { ModelMessage } from 'fino:ai/model';
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import { DataLoader, IterableDataset, type DatasetSource } from 'fino:data/dataset';
/**
 * Embedding provider used by `SqliteMemory`.
 *
 * This is the minimal contract memory needs: batch-embed texts into vectors of
 * a fixed, known dimension. Any `EmbeddingModel` from `fino:ai/model` satisfies
 * it structurally, and hand-rolled embedders work too — useful for tests or
 * local models. `dimensions` sizes the sqlite vector table; a value of `0`
 * disables semantic recall entirely.
 *
 * `embed()` must return one vector per input text, in input order. `ingest()`
 * substitutes a zero vector for any missing entry rather than failing.
 *
 * ```ts no_run
 * import type { Embedder } from 'fino:ai/memory';
 *
 * const embedder: Embedder = {
 *   dimensions: 384,
 *   async embed(texts) {
 *     return texts.map((text) => localModel.encode(text));
 *   },
 * };
 * ```
 */
export type Embedder = {
  /**
   * Embed each text into a vector of exactly `dimensions` elements, preserving
   * input order.
   */
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * Width of the vectors produced by `embed()`. Used to size the vector table;
   * `0` disables semantic recall.
   */
  readonly dimensions: number;
};
/**
 * Message persisted in durable memory.
 *
 * Returned by `Memory.append()`, `Memory.history()`, and inside
 * `RecalledContext.messages`. The `id`, `threadId`, and `createdAt` fields are
 * assigned by the store at append time; callers only supply `role` and
 * `content`. Content round-trips through JSON, so structured multi-part
 * content is preserved exactly.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * const stored = await mem.append({ role: 'user', content: 'hello' });
 * console.log(stored.id, new Date(stored.createdAt).toISOString());
 * ```
 */
export interface MemoryMessage {
  /**
   * Unique identifier assigned when the message was appended.
   */
  id: string;
  /**
   * Thread the message belongs to; stamped from the memory's active scope.
   */
  threadId: string;
  /**
   * Conversation role, matching the `ModelMessage` role union.
   */
  role: ModelMessage['role'];
  /**
   * Message content as appended — a string or structured content parts,
   * round-tripped through JSON.
   */
  content: ModelMessage['content'];
  /**
   * Append timestamp in milliseconds since the Unix epoch.
   */
  createdAt: number;
}
/**
 * Query used to recall memory for an agent turn.
 *
 * All fields are optional. Without `text`, `recall()` skips semantic search
 * and only returns conversation history and working memory. With `text`, the
 * query is embedded and matched against ingested chunks by vector distance.
 *
 * ```ts no_run
 * import type { MemoryQuery } from 'fino:ai/memory';
 *
 * const query: MemoryQuery = {
 *   text: 'what is the refund window?',
 *   topK: 3,
 *   last: 20,
 *   filter: { metadata: { topic: 'billing' } },
 * };
 * const ctx = await mem.recall(query);
 * ```
 */
export interface MemoryQuery {
  /**
   * Natural-language query for semantic recall. Omit to fetch only history and
   * working memory.
   */
  text?: string;
  /**
   * Maximum number of semantic hits to return. Defaults to 5.
   */
  topK?: number;
  /**
   * Limit the returned conversation history to the most recent N messages.
   * Passed through to `history()`.
   */
  last?: number;
  /**
   * Which chunk scope to search: `'thread'` (default) searches chunks ingested
   * under the current thread; `'resource'` searches the memory's resource
   * scope, which falls back to the thread id when no `resourceId` was
   * configured.
   */
  scope?: 'thread' | 'resource';
  /**
   * Post-search filter. `metadata` requires strict equality on every listed
   * top-level key of a chunk's metadata; chunks without metadata never match.
   */
  filter?: {
    metadata?: Record<string, unknown>;
  };
}
/**
 * Semantic recall hit returned from ingested memory chunks.
 *
 * Hits are ordered best-first. `score` is derived from vector distance as
 * `1 / (1 + distance)`, so it falls in `(0, 1]` with higher meaning closer.
 * The `citation` mirrors the hit's id and metadata so applications can carry
 * source attribution into model prompts or UI without reshaping the hit.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * const { recalled } = await mem.recall({ text: 'refund window' });
 * for (const hit of recalled) {
 *   console.log(hit.score.toFixed(3), hit.text, hit.citation?.id);
 * }
 * ```
 */
export interface RecallHit {
  /**
   * Identifier of the stored chunk that matched.
   */
  id?: string;
  /**
   * The chunk text to feed back into the model context.
   */
  text: string;
  /**
   * Similarity in `(0, 1]`; computed as `1 / (1 + distance)`, higher is closer.
   */
  score: number;
  /**
   * Metadata stored with the chunk at ingest time, if any.
   */
  metadata?: Record<string, unknown>;
  /**
   * Source attribution for the hit — the chunk id and its metadata — suitable
   * for citing recalled content in prompts or UI.
   */
  citation?: {
    id?: string;
    metadata?: Record<string, unknown>;
  };
}
/**
 * Combined memory context returned by `Memory.recall()`.
 *
 * Bundles everything a strategy typically needs to rebuild model context for a
 * turn: recent conversation history, semantically recalled chunks, and the
 * thread's working memory. `recalled` is empty when the query had no `text` or
 * when semantic recall is unavailable; `workingMemory` is `null` before the
 * first `setWorkingMemory()` write.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * const ctx = await mem.recall({ text: 'deployment steps', last: 10 });
 * const preamble = ctx.recalled.map((hit) => hit.text).join('\n');
 * const facts = ctx.workingMemory ?? {};
 * ```
 */
export interface RecalledContext {
  /**
   * Recent thread messages in chronological order, subject to the query's
   * `last` limit and the memory's history token budget.
   */
  messages: MemoryMessage[];
  /**
   * Semantic hits ordered best-first; empty without query text or when
   * semantic recall is unavailable.
   */
  recalled: RecallHit[];
  /**
   * The thread's working-memory object, or `null` if none has been written.
   */
  workingMemory: Record<string, unknown> | null;
}
/**
 * Retained progress for the most recent `Memory.ingest()` call.
 *
 * Published through the `Memory.ingestProgress` signal. Array inputs publish
 * document and chunk totals up front; lazy inputs increment those counts as
 * each loader batch is pulled. `embedded` and `stored` count completed work.
 * `active` flips back to `false` when the ingest call finishes, even if it
 * failed partway.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * const dispose = mem.ingestProgress.subscribe(({ stored, chunks, active }) => {
 *   if (active) console.log(`ingested ${stored}/${chunks} chunks`);
 * });
 * await mem.ingest([{ text: manualText }]);
 * dispose();
 * ```
 */
export interface MemoryIngestProgress {
  /**
   * True while an `ingest()` call is running.
   */
  active: boolean;
  /**
   * Number of known documents in the current or most recent ingest call.
   * This is the total immediately for arrays and grows as lazy sources are
   * pulled.
   */
  documents: number;
  /**
   * Number of known chunks produced from those documents. This grows as lazy
   * sources are pulled and is final when `active` becomes false.
   */
  chunks: number;
  /**
   * Chunks whose embeddings have been computed so far.
   */
  embedded: number;
  /**
   * Chunks written to the database so far.
   */
  stored: number;
}
/**
 * Query helper over `Memory.recall()`.
 *
 * A retriever is the narrow interface RAG call sites depend on when they only
 * need semantic hits — not conversation history or working memory. Create one
 * with `retriever()`.
 *
 * ```ts no_run
 * import { memory, retriever } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * const docs = retriever(mem, { topK: 3 });
 * const hits = await docs.retrieve('how do I rotate credentials?');
 * ```
 */
export interface Retriever {
  /**
   * Recall semantic hits for `text`. Per-call `opts` override the defaults the
   * retriever was created with.
   */
  retrieve(text: string, opts?: Omit<MemoryQuery, 'text'>): Promise<RecallHit[]>;
}
/**
 * Text chunking options for `Memory.ingest()`.
 *
 * Documents are split into fixed-size character windows before embedding.
 * Consecutive chunks overlap so that sentences spanning a boundary remain
 * recallable from either side.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * await mem.ingest([{ text: longDocument }], {
 *   chunk: { size: 800, overlap: 200 },
 * });
 * ```
 */
export interface ChunkOptions {
  /**
   * Maximum chunk length in characters. Defaults to 1000. Text at or under
   * this length is stored as a single chunk.
   */
  size?: number;
  /**
   * Characters shared between consecutive chunks. Defaults to 100 and is
   * clamped to `size - 1`.
   */
  overlap?: number;
}
/**
 * One document accepted by `Memory.ingest()`.
 */
export interface MemoryDocument {
  /** Text split into chunks, embedded, and stored for recall. */
  text: string;
  /** Optional metadata copied to every chunk produced from this document. */
  metadata?: Record<string, unknown>;
}
/**
 * Controls one pull-driven memory ingestion traversal.
 */
export interface MemoryIngestOptions {
  /** Store under the active thread or shared resource namespace. */
  scope?: 'thread' | 'resource';
  /** Text splitting policy applied before embedding. */
  chunk?: ChunkOptions;
  /**
   * Number of documents chunked and embedded per loader pull. Defaults to `1`.
   */
  batchSize?: number;
  /**
   * Cancels the next source pull and closes the upstream iterator.
   */
  signal?: AbortSignal;
}
/**
 * Durable memory interface used by sessions and strategies.
 *
 * Application code should depend on this interface rather than the concrete
 * `SqliteMemory` so stores can be swapped in tests or future backends. All
 * operations are scoped to the memory's current `threadId`; `thread(id)`
 * produces a re-scoped view over the same underlying store.
 *
 * Memory implements async disposal, so `await using` closes it automatically
 * at scope exit.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 * import type { Memory } from 'fino:ai/memory';
 *
 * async function rememberTurn(mem: Memory, user: string, reply: string) {
 *   await mem.append({ role: 'user', content: user });
 *   await mem.append({ role: 'assistant', content: reply });
 * }
 *
 * await using mem = await memory({ path: './memory.db', embedder });
 * await rememberTurn(mem, 'What is fino?', 'A JS runtime built on V8.');
 * ```
 */
export interface Memory {
  /**
   * Identifier of the conversation thread this view reads and writes.
   */
  readonly threadId: string;
  /**
   * Whether semantic (vector) recall is available. When false, `ingest()`
   * still stores chunk text but `recall()` returns no semantic hits.
   */
  readonly semanticAvailable: boolean;
  /**
   * Retained signal of the working-memory object as written through this
   * instance. Starts as `null`; it is not preloaded from storage, so use
   * `getWorkingMemory()` to read state persisted by earlier processes.
   */
  readonly workingMemory: ReadonlySignal<Record<string, unknown> | null>;
  /**
   * Retained signal reporting progress of the current or most recent
   * `ingest()` call.
   */
  readonly ingestProgress: ReadonlySignal<MemoryIngestProgress>;
  /**
   * Persist a message to the thread, assigning its id and timestamp, and
   * return the stored `MemoryMessage`.
   */
  append(msg: Omit<MemoryMessage, 'id' | 'createdAt' | 'threadId'>): Promise<MemoryMessage>;
  /**
   * Fetch thread messages in chronological order. `last` caps the count from
   * the newest end; `before` excludes messages at or after the given
   * millisecond timestamp. Implementations may additionally trim to a token
   * budget when `last` is omitted.
   */
  history(opts?: { last?: number; before?: number }): Promise<MemoryMessage[]>;
  /**
   * Assemble the combined context for a turn: recent history, semantic hits
   * for `query.text` (when available), and working memory.
   */
  recall(query?: MemoryQuery): Promise<RecalledContext>;
  /**
   * Chunk, embed, and store documents for later semantic recall. `scope`
   * selects the thread (default) or resource chunk namespace; `chunk`
   * controls splitting. Progress is published on `ingestProgress`.
   */
  ingest(docs: DatasetSource<MemoryDocument>, opts?: MemoryIngestOptions): Promise<void>;
  /**
   * Read the thread's persisted working-memory object, or `null` if none has
   * been written.
   */
  getWorkingMemory(): Promise<Record<string, unknown> | null>;
  /**
   * Write working memory. `'merge'` (default) shallow-merges `patch` over the
   * existing object; `'replace'` discards prior state entirely.
   */
  setWorkingMemory(patch: Record<string, unknown>, mode?: 'merge' | 'replace'): Promise<void>;
  /**
   * Return a view over the same store scoped to a different thread id.
   */
  thread(id: string): Memory;
  /**
   * Release the underlying store if this instance owns it.
   */
  close(): Promise<void>;
  /**
   * Async-disposal hook equivalent to `close()`, enabling `await using`.
   */
  [Symbol.asyncDispose](): Promise<void>;
}
/**
 * Create a retriever over a `Memory` instance.
 *
 * The helper keeps RAG call sites concise when an application only needs
 * semantic hits rather than the full recalled conversation and working-memory
 * context. `defaults` are merged into every query, with per-call options
 * overriding them; each `retrieve()` call delegates to `memory.recall()` and
 * returns only the `recalled` hits.
 *
 * ```ts no_run
 * import { memory, retriever } from 'fino:ai/memory';
 *
 * const mem = await memory({ path: './memory.db', embedder });
 * const billingDocs = retriever(mem, {
 *   topK: 3,
 *   filter: { metadata: { topic: 'billing' } },
 * });
 * const hits = await billingDocs.retrieve('refund window');
 * const context = hits.map((hit) => hit.text).join('\n');
 * ```
 */
export function retriever(memory: Memory, defaults: Omit<MemoryQuery, 'text'> = {}): Retriever {
  return {
    async retrieve(text: string, opts: Omit<MemoryQuery, 'text'> = {}): Promise<RecallHit[]> {
      const ctx = await memory.recall({
        ...defaults,
        ...opts,
        text,
      });
      return ctx.recalled;
    },
  };
}
/**
 * Options for opening sqlite-backed memory.
 *
 * Only `path` and `embedder` are required. Semantic recall activates when the
 * effective embedding dimension is greater than zero and the sqlite build has
 * the vector extension; check `semanticAvailable` on the opened memory.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * const mem = await memory({
 *   path: '/var/data/agent.db',
 *   embedder,
 *   threadId: 'ticket-4821',
 *   resourceId: 'kb-articles',
 *   historyTokenBudget: 4000,
 * });
 * ```
 */
export interface SqliteMemoryOptions {
  /**
   * Filesystem path of the sqlite database. Created if it does not exist.
   */
  path: string;
  /**
   * Embedding provider used for `ingest()` and semantic `recall()`.
   */
  embedder: Embedder;
  /**
   * Initial thread scope. A random id is generated when omitted, so pass a
   * stable id to resume an existing conversation.
   */
  threadId?: string;
  /**
   * Scope id used for chunks ingested or recalled with `scope: 'resource'`.
   * Falls back to the thread id when omitted.
   */
  resourceId?: string;
  /**
   * Embedding dimension override. Defaults to `embedder.dimensions`; the
   * effective value sizes the vector table, and `0` disables semantic recall.
   */
  dimensions?: number;
  /**
   * Approximate token budget applied to `history()` calls that do not pass
   * `last`. Oldest messages are dropped once the estimate (about four
   * characters per token) exceeds the budget.
   */
  historyTokenBudget?: number;
  /**
   * Filesystem provider forwarded to `Database.open()`, for virtual or
   * sandboxed storage backends.
   */
  fs?: object;
}
let idCounter = 0;
function newId(): string {
  return `${++idCounter}-${Math.random().toString(36).slice(2)}`;
}
function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? 1e3;
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
function metadataMatches(
  metadata: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) return true;
  if (!metadata) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) return false;
  }
  return true;
}
/**
 * Sqlite-backed memory implementation with optional vector recall.
 *
 * One database file holds every thread's messages, working memory, and
 * ingested chunks; instances are cheap views scoped by thread id. Construct
 * with the static `open()` (or the module-level `memory()` factory) — the
 * constructor is private.
 *
 * Vector search uses the sqlite `vec0` virtual table when the database build
 * supports it and the embedding dimension is non-zero. When unavailable the
 * instance still provides chronological history and working memory, and
 * `semanticAvailable` reports `false`.
 *
 * ```ts no_run
 * import { SqliteMemory } from 'fino:ai/memory';
 *
 * const mem = await SqliteMemory.open({
 *   path: './agent.db',
 *   embedder,
 *   threadId: 'onboarding',
 * });
 * await mem.append({ role: 'user', content: 'My name is Ada.' });
 * await mem.setWorkingMemory({ userName: 'Ada' });
 * if (mem.semanticAvailable) {
 *   await mem.ingest([{ text: handbook, metadata: { source: 'handbook' } }]);
 * }
 * await mem.close();
 * ```
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
  #workingMemorySignal = createSignal<Record<string, unknown> | null>(null);
  #ingestProgress = createSignal<MemoryIngestProgress>({
    active: false,
    documents: 0,
    chunks: 0,
    embedded: 0,
    stored: 0,
  });
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
  /**
   * Identifier of the conversation thread this instance reads and writes.
   */
  get threadId(): string {
    return this.#threadId;
  }
  /**
   * Whether vector recall is active — requires the sqlite vector extension
   * and a non-zero embedding dimension, and that the vector table could be
   * created at open time.
   */
  get semanticAvailable(): boolean {
    return this.#semantic;
  }
  /**
   * Retained signal of working memory as written through this instance.
   * Starts as `null` even when the database already holds working memory;
   * read persisted state with `getWorkingMemory()`.
   */
  get workingMemory(): ReadonlySignal<Record<string, unknown> | null> {
    return this.#workingMemorySignal;
  }
  /**
   * Retained signal reporting progress of the current or most recent
   * `ingest()` call.
   */
  get ingestProgress(): ReadonlySignal<MemoryIngestProgress> {
    return this.#ingestProgress;
  }
  /**
   * Open (creating if necessary) a sqlite database and return a memory view
   * over it.
   *
   * The schema — message, working-memory, and chunk tables — is created
   * idempotently, so reopening an existing database preserves all prior
   * state. When vector support is present a `vec0` virtual table sized to the
   * embedding dimension is also created; failure to create it silently
   * disables semantic recall rather than failing the open.
   *
   * The returned instance owns the database handle: `close()` it when done,
   * or bind it with `await using`.
   *
   * ```ts no_run
   * import { SqliteMemory } from 'fino:ai/memory';
   *
   * await using mem = await SqliteMemory.open({
   *   path: './agent.db',
   *   embedder,
   *   threadId: 'support-thread',
   * });
   * ```
   */
  static async open(opts: SqliteMemoryOptions): Promise<SqliteMemory> {
    const db = await Database.open(opts.path, { fs: opts.fs as never });
    const dim = opts.dimensions ?? opts.embedder.dimensions;
    await db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)`,
    );
    await db.exec(`CREATE TABLE IF NOT EXISTS working_memory (
        thread_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT,
        embedding BLOB
      )`);
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
  /**
   * Persist a message to the current thread.
   *
   * Assigns a unique id and a `Date.now()` timestamp, serializes the content
   * as JSON, and returns the complete stored `MemoryMessage`.
   */
  async append(msg: Omit<MemoryMessage, 'id' | 'createdAt' | 'threadId'>): Promise<MemoryMessage> {
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
    return {
      id,
      threadId: this.#threadId,
      role: msg.role,
      content: msg.content,
      createdAt,
    };
  }
  /**
   * Fetch the thread's messages in chronological order.
   *
   * `last` caps the result to the most recent N messages (default 1000);
   * `before` excludes messages created at or after the given millisecond
   * timestamp, which supports paging backwards through long threads.
   *
   * When `last` is omitted and the memory was opened with
   * `historyTokenBudget`, older messages are dropped once the running
   * estimate (about four characters per token, newest first) exceeds the
   * budget — so the most recent messages always survive trimming.
   */
  async history(
    opts: {
      last?: number;
      before?: number;
    } = {},
  ): Promise<MemoryMessage[]> {
    let sql = `SELECT id, thread_id, role, content, created_at FROM messages WHERE thread_id = ?`;
    const params: unknown[] = [this.#threadId];
    if (opts.before !== undefined) {
      sql += ` AND created_at < ?`;
      params.push(opts.before);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.last ?? 1e3);
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
  /**
   * Assemble the combined memory context for a turn.
   *
   * Always returns recent history (honouring `query.last`) and the thread's
   * working memory. When `query.text` is set and semantic recall is
   * available, the text is embedded and matched against stored chunks by
   * vector distance: the search over-fetches (`topK * 3` nearest neighbours),
   * filters to the requested scope and metadata, then returns the best `topK`
   * hits (default 5). Without query text, without vector support, or when the
   * embedder returns an empty vector, `recalled` is an empty array.
   *
   * ```ts no_run
   * const ctx = await mem.recall({
   *   text: 'what did we decide about caching?',
   *   topK: 3,
   *   last: 20,
   * });
   * ```
   */
  async recall(query: MemoryQuery = {}): Promise<RecalledContext> {
    const messages = await this.history({ last: query.last });
    const workingMemory = await this.getWorkingMemory();
    if (!this.#semantic || !query.text) {
      return {
        messages,
        recalled: [],
        workingMemory,
      };
    }
    const topK = query.topK ?? 5;
    const queryEmbs = await this.#embedder.embed([query.text]);
    const queryEmb = queryEmbs[0];
    if (!queryEmb || queryEmb.length === 0) {
      return {
        messages,
        recalled: [],
        workingMemory,
      };
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
      return {
        messages,
        recalled: [],
        workingMemory,
      };
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
        metadata:
          r.metadata !== null
            ? (JSON.parse(r.metadata as string) as Record<string, unknown>)
            : undefined,
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
    return {
      messages,
      recalled,
      workingMemory,
    };
  }
  /**
   * Chunk, embed, and store documents for semantic recall.
   *
   * Documents are pulled through the shared `DataLoader`, split per
   * `opts.chunk` (1000-character chunks with 100-character overlap by
   * default), embedded in bounded document batches, and written under the
   * thread scope or — with `scope: 'resource'` — the memory's resource scope.
   * Chunk text and metadata are stored even when vector search is unavailable;
   * vectors are additionally indexed only when `semanticAvailable` is true. A
   * missing embedding falls back to a zero vector rather than failing the
   * ingest.
   *
   * Arrays, normal iterables, async iterables, `Dataset`, and
   * `IterableDataset` sources share this path. Pull-driven batches preserve
   * backpressure, and `opts.signal` cancels the traversal and closes upstream.
   * Progress is published throughout, and `active` is reset to `false` even
   * if cancellation, embedding, or storage throws.
   *
   * ```ts no_run
   * await mem.ingest(
   *   [
   *     { text: policyDoc, metadata: { source: 'policy', topic: 'billing' } },
   *     { text: runbookDoc, metadata: { source: 'runbook', topic: 'ops' } },
   *   ],
   *   { scope: 'resource', chunk: { size: 800, overlap: 150 }, batchSize: 8 },
   * );
   * ```
   */
  async ingest(docs: DatasetSource<MemoryDocument>, opts?: MemoryIngestOptions): Promise<void> {
    const { scope = 'thread', chunk: chunkOpts, batchSize = 1, signal } = opts ?? {};
    const scopeId = scope === 'resource' ? (this.#resourceId ?? this.#threadId) : this.#threadId;
    const knownDocuments = Array.isArray(docs) ? docs : null;
    const knownChunks = knownDocuments?.reduce(
      (total, doc) => total + chunkText(doc.text, chunkOpts).length,
      0,
    );
    this.#ingestProgress.set({
      active: true,
      documents: knownDocuments?.length ?? 0,
      chunks: knownChunks ?? 0,
      embedded: 0,
      stored: 0,
    });
    const source = docs instanceof IterableDataset ? docs : IterableDataset.from(docs);
    const loader = new DataLoader<
      MemoryDocument,
      {
        documents: number;
        chunks: Array<{ text: string; metadata?: Record<string, unknown> }>;
      }
    >(source, {
      batchSize,
      collate(documents) {
        return {
          documents: documents.length,
          chunks: documents.flatMap((doc) =>
            chunkText(doc.text, chunkOpts).map((text) => ({
              text,
              ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
            })),
          ),
        };
      },
    });
    const insertChunk = this.#db.prepare(
      `INSERT OR IGNORE INTO chunks(id, scope_id, text, metadata, embedding) VALUES(?, ?, ?, ?, ?)`,
    );
    const insertVec = this.#semantic
      ? this.#db.prepare(`INSERT INTO chunk_vectors(rowid, embedding) VALUES(?, ?)`)
      : null;
    try {
      for await (const batch of loader.iterate(signal ? { signal } : {})) {
        if (!knownDocuments) {
          this.#ingestProgress.set((progress) => ({
            ...progress,
            documents: progress.documents + batch.documents,
            chunks: progress.chunks + batch.chunks.length,
          }));
        }
        const embeddings = await this.#embedder.embed(batch.chunks.map((chunk) => chunk.text));
        this.#ingestProgress.set((progress) => ({
          ...progress,
          embedded: progress.embedded + embeddings.length,
        }));
        for (let i = 0; i < batch.chunks.length; i++) {
          const chunk = batch.chunks[i]!;
          const id = newId();
          const embedding = embeddings[i] ?? new Float32Array(this.#dim);
          const blob = new Uint8Array(embedding.buffer);
          const result = await insertChunk.run(
            id,
            scopeId,
            chunk.text,
            chunk.metadata !== undefined ? JSON.stringify(chunk.metadata) : null,
            blob,
          );
          if (insertVec && result.changes > 0) {
            await insertVec.run(result.lastInsertRowid, vec(embedding));
          }
          this.#ingestProgress.set((progress) => ({
            ...progress,
            stored: progress.stored + (result.changes > 0 ? 1 : 0),
          }));
        }
      }
    } finally {
      insertChunk.finalize();
      insertVec?.finalize();
      this.#ingestProgress.set((progress) => ({
        ...progress,
        active: false,
      }));
    }
  }
  /**
   * Read the thread's persisted working-memory object.
   *
   * Returns `null` before the first `setWorkingMemory()` write. Unlike the
   * `workingMemory` signal, this always reflects the database, including
   * state written by earlier processes.
   */
  async getWorkingMemory(): Promise<Record<string, unknown> | null> {
    const stmt = this.#db.prepare(`SELECT data FROM working_memory WHERE thread_id = ?`);
    try {
      const row = await stmt.get(this.#threadId);
      if (!row) return null;
      return JSON.parse(row.data as string);
    } finally {
      stmt.finalize();
    }
  }
  /**
   * Write working memory for the thread and publish it on the
   * `workingMemory` signal.
   *
   * In `'merge'` mode (the default) `patch` is shallow-merged over the
   * existing object — top-level keys in the patch win, other keys are
   * preserved. `'replace'` discards prior state and stores `patch` as-is.
   *
   * ```ts no_run
   * await mem.setWorkingMemory({ userName: 'Ada', plan: 'pro' });
   * await mem.setWorkingMemory({ plan: 'enterprise' });          // merge keeps userName
   * await mem.setWorkingMemory({ reset: true }, 'replace');      // drops everything else
   * ```
   */
  async setWorkingMemory(
    patch: Record<string, unknown>,
    mode: 'merge' | 'replace' = 'merge',
  ): Promise<void> {
    let data: Record<string, unknown>;
    if (mode === 'merge') {
      const existing = await this.getWorkingMemory();
      data = existing
        ? {
            ...existing,
            ...patch,
          }
        : patch;
    } else {
      data = patch;
    }
    const stmt = this.#db.prepare(`INSERT INTO working_memory(thread_id, data) VALUES(?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET data = excluded.data`);
    try {
      await stmt.run(this.#threadId, JSON.stringify(data));
      this.#workingMemorySignal.set(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
    } finally {
      stmt.finalize();
    }
  }
  /**
   * Create a view over the same database scoped to a different thread.
   *
   * The view shares the connection, embedder, and configuration but has its
   * own signals and does not own the database handle — closing it is a no-op,
   * and it becomes unusable once the original owning memory is closed.
   *
   * ```ts no_run
   * const support = await memory({ path: './agent.db', embedder });
   * const ticketA = support.thread('ticket-1001');
   * const ticketB = support.thread('ticket-1002');
   * await ticketA.append({ role: 'user', content: 'Printer is on fire.' });
   * ```
   */
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
  /**
   * Close the underlying database if this instance owns it.
   *
   * Views created with `thread()` do not own the handle, so calling `close()`
   * on them does nothing; close the instance returned by `open()` instead.
   */
  async close(): Promise<void> {
    if (this.#ownsDb) await this.#db.close();
  }
  /**
   * Async-disposal hook equivalent to `close()`, enabling `await using`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
/**
 * Open sqlite-backed memory.
 *
 * This is the factory-first equivalent of `SqliteMemory.open()` and the usual
 * entry point: it returns the `Memory` interface so callers stay decoupled
 * from the concrete store. The returned instance owns the database handle —
 * close it when done, or bind it with `await using`.
 *
 * ```ts no_run
 * import { memory } from 'fino:ai/memory';
 *
 * await using mem = await memory({
 *   path: './agent.db',
 *   embedder,
 *   threadId: 'daily-standup',
 *   historyTokenBudget: 4000,
 * });
 * const ctx = await mem.recall({ text: 'open action items' });
 * ```
 */
export function memory(opts: SqliteMemoryOptions): Promise<Memory> {
  return SqliteMemory.open(opts);
}
