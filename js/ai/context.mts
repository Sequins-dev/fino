/**
 * Agent history primitives and built-in history strategies.
 *
 * `MessageHistory` is an immutable, revisioned sequence for model messages.
 * Runtime code appends messages through a `HistoryStrategy` and asks that
 * strategy for a model-facing view before each request. Strategies own all
 * curation policy: compaction, selection, memory emission, and temporary views.
 */

import type { ModelMessage, Usage, Model } from 'fino:ai/model';
import { Database } from 'fino:database/sqlite';

// ── Interfaces ────────────────────────────────────────────────────────────────

/**
 * Optional metadata attached to a history entry.
 */
export interface MessageMeta {
  turn?: number;
  createdAt?: number;
  labels?: string[];
  links?: Array<{ rel: string; to: string }>;
}

/**
 * Read context passed to a `HistoryStrategy` before a model request.
 *
 * Strategies can use the active model, token budget, and abort signal to decide
 * whether to summarize, select a subset, or return the persisted view unchanged.
 */
export interface HistoryReadContext {
  model: Model;
  budgetTokens: number;
  signal?: AbortSignal;
}

/**
 * Append context passed when the runtime records a new inbound or generated
 * message.
 *
 * The run metadata is advisory. Strategies should update their own `history`
 * reference by assigning the immutable collection returned by `MessageHistory`.
 */
export interface HistoryAppendContext extends HistoryReadContext {
  runId?: string;
  stepIndex?: number;
}

/**
 * Owns the conversation history policy for an agent.
 *
 * The runtime only calls `onAppend` and `onRead`. It does not interpret why a
 * view was compacted, selected, summarized, or left unchanged.
 */
export interface HistoryStrategy {
  history: MessageHistory;
  onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void>;
  onRead(ctx: HistoryReadContext): Promise<{ history: MessageHistory; messages: ModelMessage[] }>;
}

/**
 * Storage backend for immutable history entries and sequence revisions.
 *
 * A store persists individual entries once and saves each sequence revision as
 * an immutable list of entry ids. Reloading by revision id reconstructs the
 * active sequence and its lineage.
 */
export interface HistoryStore {
  saveEntry(entry: MessageHistoryEntry): Promise<void>;
  saveRevision(revision: MessageHistoryRevision): Promise<void>;
  loadRevision(id: string): Promise<MessageHistorySnapshot | null>;
}

/**
 * Immutable message entry stored by `MessageHistory`.
 *
 * Summary entries can point at source entry ids so `restore()` can expand a
 * compacted view back to the original messages.
 */
export interface MessageHistoryEntry {
  id: string;
  message: ModelMessage;
  kind: 'turn' | 'summary';
  meta?: MessageMeta;
  sources?: string[];
}

/**
 * Immutable ordered sequence of active entry ids.
 *
 * Revisions form a parent chain so forks and rewritten views keep lineage while
 * retaining the original entries.
 */
export interface MessageHistoryRevision {
  id: string;
  entryIds: string[];
  parent?: string;
  createdAt: number;
}

/**
 * Serializable history payload used by in-process tests and store reloads.
 */
export interface MessageHistorySnapshot {
  entries: MessageHistoryEntry[];
  revisions: MessageHistoryRevision[];
  head: string;
}

/**
 * Rewrite operation applied to a `MessageHistory`.
 *
 * Patches can remove entries, replace an entry with one or more entries, insert
 * around an entry, move entries, split one message into extracted entries, or add
 * a summary linked to source ids.
 */
export type MessageHistoryPatch =
  | { op: 'remove'; id: string }
  | { op: 'replace'; id: string; entries: MessageHistoryEntryInput[] }
  | { op: 'insertBefore' | 'insertAfter'; id: string; entries: MessageHistoryEntryInput[] }
  | { op: 'move'; ids: string[]; before?: string; after?: string }
  | { op: 'split'; id: string; entries: MessageHistoryEntryInput[] }
  | { op: 'summary'; sourceIds: string[]; entry: MessageHistoryEntryInput; replace?: boolean };

/**
 * Input accepted by `MessageHistory.append()` and rewrite operations.
 */
export type MessageHistoryEntryInput =
  | ModelMessage
  | {
      id?: string;
      message: ModelMessage;
      kind?: 'turn' | 'summary';
      meta?: MessageMeta;
      sources?: string[];
    };

// ── ID generation ─────────────────────────────────────────────────────────────

let idCounter = 0;
function newId(): string {
  return `${++idCounter}-${Math.random().toString(36).slice(2, 9)}`;
}

function cloneMessage<T extends ModelMessage>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

function cloneEntry(entry: MessageHistoryEntry): MessageHistoryEntry {
  return {
    id: entry.id,
    message: cloneMessage(entry.message),
    kind: entry.kind,
    ...(entry.meta !== undefined ? { meta: JSON.parse(JSON.stringify(entry.meta)) as MessageMeta } : {}),
    ...(entry.sources !== undefined ? { sources: [...entry.sources] } : {}),
  };
}

function cloneRevision(revision: MessageHistoryRevision): MessageHistoryRevision {
  return {
    id: revision.id,
    entryIds: [...revision.entryIds],
    ...(revision.parent !== undefined ? { parent: revision.parent } : {}),
    createdAt: revision.createdAt,
  };
}

function normalizeHistoryEntry(input: MessageHistoryEntryInput): MessageHistoryEntry {
  if ('message' in input) {
    return {
      id: input.id ?? newId(),
      message: cloneMessage(input.message),
      kind: input.kind ?? 'turn',
      ...(input.meta !== undefined ? { meta: JSON.parse(JSON.stringify(input.meta)) as MessageMeta } : {}),
      ...(input.sources !== undefined ? { sources: [...input.sources] } : {}),
    };
  }
  return {
    id: newId(),
    message: cloneMessage(input),
    kind: 'turn',
  };
}

/**
 * In-memory history store for tests and stateless agents.
 */
export class InMemoryHistoryStore implements HistoryStore {
  #entries = new Map<string, MessageHistoryEntry>();
  #revisions = new Map<string, MessageHistoryRevision>();

  async saveEntry(entry: MessageHistoryEntry): Promise<void> {
    if (!this.#entries.has(entry.id)) this.#entries.set(entry.id, cloneEntry(entry));
  }

  async saveRevision(revision: MessageHistoryRevision): Promise<void> {
    if (!this.#revisions.has(revision.id)) this.#revisions.set(revision.id, cloneRevision(revision));
  }

  async loadRevision(id: string): Promise<MessageHistorySnapshot | null> {
    const revision = this.#revisions.get(id);
    if (!revision) return null;

    const revisions: MessageHistoryRevision[] = [];
    let current: MessageHistoryRevision | undefined = revision;
    while (current) {
      revisions.push(cloneRevision(current));
      current = current.parent ? this.#revisions.get(current.parent) : undefined;
    }

    const needed = new Set<string>();
    for (const rev of revisions) {
      for (const entryId of rev.entryIds) needed.add(entryId);
    }

    const entries: MessageHistoryEntry[] = [];
    for (const id of needed) {
      const entry = this.#entries.get(id);
      if (entry) entries.push(cloneEntry(entry));
    }

    return { entries, revisions, head: id };
  }
}

/**
 * SQLite-backed history store.
 *
 * This store records immutable entries and immutable revisions. It is suitable
 * for session checkpoint stores that persist only a current history revision id.
 */
export class SqliteHistoryStore implements HistoryStore {
  #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static async open(path: string, opts?: { fs?: object }): Promise<SqliteHistoryStore> {
    const db = await Database.open(path, { fs: opts?.fs as never });
    await db.exec(
      `CREATE TABLE IF NOT EXISTS history_entries (
        id TEXT PRIMARY KEY,
        entry TEXT NOT NULL
      )`,
    );
    await db.exec(
      `CREATE TABLE IF NOT EXISTS history_revisions (
        id TEXT PRIMARY KEY,
        parent TEXT,
        entry_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_history_revisions_parent ON history_revisions(parent)`);
    return new SqliteHistoryStore(db);
  }

  async saveEntry(entry: MessageHistoryEntry): Promise<void> {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO history_entries(id, entry) VALUES(?, ?)`,
    );
    try {
      await stmt.run(entry.id, JSON.stringify(entry));
    } finally {
      stmt.finalize();
    }
  }

  async saveRevision(revision: MessageHistoryRevision): Promise<void> {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO history_revisions(id, parent, entry_ids, created_at)
       VALUES(?, ?, ?, ?)`,
    );
    try {
      await stmt.run(
        revision.id,
        revision.parent ?? null,
        JSON.stringify(revision.entryIds),
        revision.createdAt,
      );
    } finally {
      stmt.finalize();
    }
  }

  async loadRevision(id: string): Promise<MessageHistorySnapshot | null> {
    const revStmt = this.#db.prepare(
      `WITH RECURSIVE lineage(id, parent, entry_ids, created_at) AS (
         SELECT id, parent, entry_ids, created_at FROM history_revisions WHERE id = ?
         UNION ALL
         SELECT r.id, r.parent, r.entry_ids, r.created_at
         FROM history_revisions r JOIN lineage l ON r.id = l.parent
       )
       SELECT id, parent, entry_ids, created_at FROM lineage`,
    );
    try {
      const rows = await revStmt.all(id);
      if (rows.length === 0) return null;
      const revisions = rows.map((row) => ({
        id: row.id as string,
        ...(row.parent !== null ? { parent: row.parent as string } : {}),
        entryIds: JSON.parse(row.entry_ids as string) as string[],
        createdAt: row.created_at as number,
      }));
      const needed = new Set<string>();
      for (const rev of revisions) {
        for (const entryId of rev.entryIds) needed.add(entryId);
      }
      const entries: MessageHistoryEntry[] = [];
      for (const entryId of needed) {
        const entryStmt = this.#db.prepare(`SELECT entry FROM history_entries WHERE id = ?`);
        try {
          const row = await entryStmt.get(entryId);
          if (row) entries.push(JSON.parse(row.entry as string) as MessageHistoryEntry);
        } finally {
          entryStmt.finalize();
        }
      }
      return { entries, revisions, head: id };
    } finally {
      revStmt.finalize();
    }
  }

  async close(): Promise<void> {
    await this.#db.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Immutable persistent sequence of model messages.
 *
 * Every operation returns a new collection pointing at a new revision. Original
 * entries remain available for restore, fork, and lineage inspection.
 */
export class MessageHistory {
  #entries: Map<string, MessageHistoryEntry>;
  #revisions: Map<string, MessageHistoryRevision>;
  #head: string;
  #store?: HistoryStore;

  constructor(data?: {
    entries?: Iterable<MessageHistoryEntry>;
    revisions?: Iterable<MessageHistoryRevision>;
    head?: string;
    store?: HistoryStore;
  }) {
    this.#entries = new Map();
    this.#revisions = new Map();
    this.#store = data?.store;
    for (const entry of data?.entries ?? []) this.#entries.set(entry.id, cloneEntry(entry));
    for (const revision of data?.revisions ?? []) this.#revisions.set(revision.id, cloneRevision(revision));
    this.#head = data?.head ?? newId();
    if (!this.#revisions.has(this.#head)) {
      this.#revisions.set(this.#head, { id: this.#head, entryIds: [], createdAt: Date.now() });
    }
  }

  /** Current active sequence revision id. */
  get revisionId(): string {
    return this.#head;
  }

  /** Bound store used to persist future entries and revisions, if any. */
  get store(): HistoryStore | undefined {
    return this.#store;
  }

  /** Number of entries in the active sequence. */
  get size(): number {
    return this.#activeEntryIds().length;
  }

  /** Return a new history with `entry` appended to the active sequence. */
  async append(entry: MessageHistoryEntryInput): Promise<MessageHistory> {
    const normalized = normalizeHistoryEntry(entry);
    return this.#commit(this.#activeEntryIds().concat(normalized.id), [normalized]);
  }

  /** Apply one or more sequence rewrites and return the resulting history. */
  async edit(patches: MessageHistoryPatch | MessageHistoryPatch[]): Promise<MessageHistory> {
    let sequence = this.#activeEntryIds();
    const newEntries: MessageHistoryEntry[] = [];
    const patchList = Array.isArray(patches) ? patches : [patches];

    for (const patch of patchList) {
      if (patch.op === 'remove') {
        sequence = sequence.filter((id) => id !== patch.id);
        continue;
      }
      if (patch.op === 'replace' || patch.op === 'split') {
        const idx = sequence.indexOf(patch.id);
        if (idx < 0) continue;
        const replacements = patch.entries.map(normalizeHistoryEntry);
        newEntries.push(...replacements);
        sequence = [
          ...sequence.slice(0, idx),
          ...replacements.map((entry) => entry.id),
          ...sequence.slice(idx + 1),
        ];
        continue;
      }
      if (patch.op === 'insertBefore' || patch.op === 'insertAfter') {
        const idx = sequence.indexOf(patch.id);
        if (idx < 0) continue;
        const entries = patch.entries.map(normalizeHistoryEntry);
        newEntries.push(...entries);
        const insertAt = patch.op === 'insertBefore' ? idx : idx + 1;
        sequence = [
          ...sequence.slice(0, insertAt),
          ...entries.map((entry) => entry.id),
          ...sequence.slice(insertAt),
        ];
        continue;
      }
      if (patch.op === 'move') {
        const moving = sequence.filter((id) => patch.ids.includes(id));
        sequence = sequence.filter((id) => !patch.ids.includes(id));
        let insertAt = sequence.length;
        if (patch.before) {
          const idx = sequence.indexOf(patch.before);
          if (idx >= 0) insertAt = idx;
        } else if (patch.after) {
          const idx = sequence.indexOf(patch.after);
          if (idx >= 0) insertAt = idx + 1;
        }
        sequence = [...sequence.slice(0, insertAt), ...moving, ...sequence.slice(insertAt)];
        continue;
      }
      if (patch.op === 'summary') {
        const summary = normalizeHistoryEntry({
          ...patch.entry,
          kind: 'summary',
          sources: patch.sourceIds,
        });
        newEntries.push(summary);
        if (patch.replace) {
          const firstIdx = sequence.findIndex((id) => patch.sourceIds.includes(id));
          sequence = sequence.filter((id) => !patch.sourceIds.includes(id));
          const insertAt = firstIdx < 0 ? sequence.length : firstIdx;
          sequence = [...sequence.slice(0, insertAt), summary.id, ...sequence.slice(insertAt)];
        } else {
          sequence = [...sequence, summary.id];
        }
      }
    }

    return this.#commit(sequence, newEntries);
  }

  /** Return a new revision with the same active sequence for branch isolation. */
  async fork(): Promise<MessageHistory> {
    return this.#commit(this.#activeEntryIds(), []);
  }

  /** Return a history focused on a revision id or temporary entry-id view. */
  withView(view: string | string[]): MessageHistory {
    if (typeof view === 'string') {
      const revision = this.#revisions.get(view);
      if (!revision) throw new Error(`Unknown history revision: ${view}`);
      return new MessageHistory({
        entries: this.#entries.values(),
        revisions: this.#revisions.values(),
        head: revision.id,
        store: this.#store,
      });
    }
    const revision: MessageHistoryRevision = {
      id: newId(),
      parent: this.#head,
      entryIds: [...view],
      createdAt: Date.now(),
    };
    return new MessageHistory({
      entries: this.#entries.values(),
      revisions: [...this.#revisions.values(), revision],
      head: revision.id,
      store: this.#store,
    });
  }

  /** Render the active sequence, revision id, or entry-id view as model messages. */
  render(view?: string | string[]): ModelMessage[] {
    return this.refs(view).map((entry) => cloneMessage(entry.message));
  }

  /** Expand summaries in the active sequence or selected ids to original messages. */
  restore(entryIds?: string[]): ModelMessage[] {
    const ids = entryIds ?? this.#activeEntryIds();
    const restored: ModelMessage[] = [];
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      if (entry.kind === 'summary' && entry.sources && entry.sources.length > 0) {
        restored.push(...this.restore(entry.sources));
      } else {
        restored.push(cloneMessage(entry.message));
      }
    }
    return restored;
  }

  /** Return immutable entry references for the active sequence or selected view. */
  refs(view?: string | string[]): MessageHistoryEntry[] {
    const ids = Array.isArray(view)
      ? view
      : typeof view === 'string'
        ? (this.#revisions.get(view)?.entryIds ?? [])
        : this.#activeEntryIds();
    return ids.map((id) => this.#entries.get(id)).filter((entry): entry is MessageHistoryEntry => !!entry).map(cloneEntry);
  }

  /** Estimate tokens for the active rendered view using the local heuristic. */
  estimateTokens(): number {
    return estimateTokens(this.render());
  }

  /** Serialize entries, revisions, and active head for in-memory transfer. */
  toJSON(): MessageHistorySnapshot {
    return {
      entries: Array.from(this.#entries.values()).map(cloneEntry),
      revisions: Array.from(this.#revisions.values()).map(cloneRevision),
      head: this.#head,
    };
  }

  /** Reconstruct a history snapshot and optionally bind it to a store. */
  static fromJSON(j: unknown, store?: HistoryStore): MessageHistory {
    const snapshot = j as MessageHistorySnapshot;
    return new MessageHistory({
      entries: snapshot.entries,
      revisions: snapshot.revisions,
      head: snapshot.head,
      store,
    });
  }

  /** Load a history by revision id from a bound store. */
  static async load(store: HistoryStore, revisionId: string): Promise<MessageHistory> {
    const snapshot = await store.loadRevision(revisionId);
    if (!snapshot) throw new Error(`History revision ${revisionId} not found`);
    return MessageHistory.fromJSON(snapshot, store);
  }

  #activeEntryIds(): string[] {
    return [...(this.#revisions.get(this.#head)?.entryIds ?? [])];
  }

  async #commit(entryIds: string[], entries: MessageHistoryEntry[]): Promise<MessageHistory> {
    const revision: MessageHistoryRevision = {
      id: newId(),
      parent: this.#head,
      entryIds,
      createdAt: Date.now(),
    };
    if (this.#store) {
      for (const entry of entries) await this.#store.saveEntry(entry);
      await this.#store.saveRevision(revision);
    }
    return new MessageHistory({
      entries: [...this.#entries.values(), ...entries],
      revisions: [...this.#revisions.values(), revision],
      head: revision.id,
      store: this.#store,
    });
  }
}

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Estimate tokens for a set of messages.
 *
 * This helper is intentionally approximate and uses serialized character count
 * divided by four. Strategies should use model-native tokenizers when exact
 * accounting is required.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    const c = msg.content;
    chars += (typeof c === 'string' ? c : JSON.stringify(c)).length;
  }
  return Math.ceil(chars / 4);
}

// ── Pricing & cost ────────────────────────────────────────────────────────────

/**
 * Per-million-token pricing used by `costOf()`.
 */
export interface Pricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

/**
 * Built-in pricing table for bundled provider model ids.
 */
export const PRICING: Record<string, Pricing> = {
  'claude-fable-5': { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1.0, cacheWritePer1M: 12.5 },
  'claude-opus-4-8': { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
};

/**
 * Calculate approximate USD cost for reported usage.
 *
 * Unknown models return `0` unless a custom pricing table contains `modelName`.
 */
export function costOf(usage: Usage, modelName: string, pricing?: Record<string, Pricing>): number {
  const p = (pricing ?? PRICING)[modelName];
  if (!p) return 0;
  const inputCost = (usage.inputTokens / 1_000_000) * p.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * p.outputPer1M;
  const cacheReadCost = p.cacheReadPer1M != null && usage.cacheReadInputTokens != null
    ? (usage.cacheReadInputTokens / 1_000_000) * p.cacheReadPer1M
    : 0;
  const cacheWriteCost = p.cacheWritePer1M != null && usage.cacheCreationInputTokens != null
    ? (usage.cacheCreationInputTokens / 1_000_000) * p.cacheWritePer1M
    : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

// ── Stop conditions ───────────────────────────────────────────────────────────

/**
 * Create a stop predicate that triggers once total tokens reach `n`.
 */
export function maxTokens(n: number): (state: { usage: Usage }, info: unknown) => boolean {
  return (state) => (state.usage.inputTokens + state.usage.outputTokens) >= n;
}

/**
 * Create a stop predicate that triggers once estimated cost reaches `usd`.
 */
export function maxCost(usd: number): (state: { cost?: number }, info: unknown) => boolean {
  return (state) => (state.cost ?? 0) >= usd;
}

// ── Built-in strategy ─────────────────────────────────────────────────────────

function lastSafeSplitIndex(messages: ReadonlyArray<{ message: ModelMessage }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.message.role === 'assistant') {
      const content = m.message.content;
      const hasToolUse = Array.isArray(content) &&
        (content as Array<{ type: string }>).some((p) => p.type === 'tool_use');
      if (!hasToolUse) return i + 1;
    }
  }
  return 0;
}

/**
 * Create a strategy that appends every message and reads the full active view.
 *
 * This is the default strategy for simple agents and a useful base for custom
 * strategies that want to layer policy on top of append-only persistence.
 */
export function appendOnlyHistoryStrategy(store?: HistoryStore, history?: MessageHistory): HistoryStrategy {
  return {
    history: history ?? new MessageHistory({ store }),
    async onAppend(message: ModelMessage): Promise<void> {
      this.history = await this.history.append(message);
    },
    async onRead(_ctx: HistoryReadContext): Promise<{ history: MessageHistory; messages: ModelMessage[] }> {
      return { history: this.history, messages: this.history.render() };
    },
  };
}

/**
 * Options for `summarizingHistoryStrategy()`.
 */
export interface SummarizingHistoryStrategyOptions {
  model: Model;
  triggerTokens: number;
  keepRecent: number;
  store?: HistoryStore;
  memoryStore?: { ingest(docs: { text: string; metadata?: Record<string, unknown> }[]): Promise<void> };
  history?: MessageHistory;
}

/**
 * Create a strategy that lazily summarizes older entries during `onRead`.
 *
 * Appends are policy-free. When the active history reaches `triggerTokens`, the
 * strategy summarizes older safe entries and keeps the most recent
 * `keepRecent` entries verbatim.
 */
export function summarizingHistoryStrategy(opts: SummarizingHistoryStrategyOptions): HistoryStrategy {
  const strategy = appendOnlyHistoryStrategy(opts.store, opts.history);
  return {
    get history() { return strategy.history; },
    set history(value: MessageHistory) { strategy.history = value; },
    async onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void> {
      await strategy.onAppend(message, ctx);
    },
    async onRead(ctx: HistoryReadContext): Promise<{ history: MessageHistory; messages: ModelMessage[] }> {
      const tokens = this.history.estimateTokens();
      if (tokens < opts.triggerTokens) {
        return { history: this.history, messages: this.history.render() };
      }

      const refs = this.history.refs();
      const keepFrom = Math.max(0, refs.length - opts.keepRecent);
      const toSummarize = refs.slice(0, keepFrom);
      if (toSummarize.length === 0) {
        return { history: this.history, messages: this.history.render() };
      }

      const safeSplit = lastSafeSplitIndex(toSummarize);
      if (safeSplit === 0) {
        return { history: this.history, messages: this.history.render() };
      }

      const summarySpan = toSummarize.slice(0, safeSplit);
      const result = await opts.model.generate({
        system: 'Summarize the following conversation history concisely. Preserve all key decisions, facts, context, and important details needed to continue the conversation.',
        messages: [
          ...summarySpan.map((entry) => entry.message),
          { role: 'user', content: 'Summarize the above conversation.' },
        ],
        signal: ctx.signal,
      });

      const summary: ModelMessage = {
        role: 'user',
        content: `[Conversation summary]\n${result.text}`,
      };
      this.history = await this.history.edit({
        op: 'summary',
        sourceIds: summarySpan.map((entry) => entry.id),
        entry: { message: summary, kind: 'summary' },
        replace: true,
      });
      if (opts.memoryStore) {
        await opts.memoryStore.ingest([{ text: result.text, metadata: { kind: 'conversation_summary' } }]);
      }
      return { history: this.history, messages: this.history.render() };
    },
  };
}

/**
 * Options for `selectiveSummaryHistoryStrategy()`.
 */
export interface SelectiveSummaryHistoryStrategyOptions {
  model: Model;
  selector: (history: MessageHistory, ctx: HistoryReadContext) => string[] | Promise<string[]>;
  summaryPrompt: string;
  store?: HistoryStore;
  memoryStore?: { ingest(docs: { text: string; metadata?: Record<string, unknown> }[]): Promise<void> };
  history?: MessageHistory;
}

/**
 * Create a strategy that summarizes a selector-chosen subset during `onRead`.
 *
 * The selector receives the current history and returns entry ids. Selected
 * entries are summarized and replaced while unselected entries remain active.
 */
export function selectiveSummaryHistoryStrategy(opts: SelectiveSummaryHistoryStrategyOptions): HistoryStrategy {
  const strategy = appendOnlyHistoryStrategy(opts.store, opts.history);
  return {
    get history() { return strategy.history; },
    set history(value: MessageHistory) { strategy.history = value; },
    async onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void> {
      await strategy.onAppend(message, ctx);
    },
    async onRead(ctx: HistoryReadContext): Promise<{ history: MessageHistory; messages: ModelMessage[] }> {
      const selectedIds = await opts.selector(this.history, ctx);
      if (selectedIds.length === 0) {
        return { history: this.history, messages: this.history.render() };
      }
      const selected = this.history.refs(selectedIds);
      const result = await opts.model.generate({
        system: opts.summaryPrompt,
        messages: [
          ...selected.map((entry) => entry.message),
          { role: 'user', content: 'Summarize the selected conversation history.' },
        ],
        signal: ctx.signal,
      });
      const summary: ModelMessage = {
        role: 'user',
        content: `[Selected history summary]\n${result.text}`,
      };
      this.history = await this.history.edit({
        op: 'summary',
        sourceIds: selectedIds,
        entry: { message: summary, kind: 'summary' },
        replace: true,
      });
      if (opts.memoryStore) {
        await opts.memoryStore.ingest([{ text: result.text, metadata: { kind: 'selected_history_summary' } }]);
      }
      return { history: this.history, messages: this.history.render() };
    },
  };
}
