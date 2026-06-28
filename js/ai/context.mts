/**
 * fino:ai/context — immutable message history and history strategies.
 *
 * This module contains the low-level history substrate used by agents and
 * sessions. `MessageHistory` is a persistent, revisioned sequence of model
 * messages: append, edit, fork, restore, and view operations return new
 * history objects while retaining immutable entries and revision lineage.
 * `HistoryStrategy` is the policy boundary between runtime code and history
 * curation.
 *
 * ## Design
 *
 * The runtime does not compact, retrieve, or summarize by itself. It calls
 * `strategy.onAppend()` whenever a user, assistant, or tool-result message is
 * recorded, and `strategy.onRead()` before each model request. Strategies may
 * update their own `history` reference, return a temporary model-facing view
 * without changing the active history, or emit memory through their own
 * dependencies.
 *
 * `MessageHistory` never writes durable storage. Sessions own persistence by
 * committing `toSnapshot()` or `changesSince()` output into a `SessionStore`.
 * That keeps the immutable graph model separate from run/thread lifecycle
 * concerns such as checkpoints, suspension, cancellation, and atomic commits.
 *
 * ```ts no_run
 * import { MessageHistory, appendOnlyHistoryStrategy } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'remember this' });
 * history = await history.edit({
 *   op: 'summary',
 *   sourceIds: history.refs().map((entry) => entry.id),
 *   entry: { message: { role: 'system', content: 'User asked us to remember a fact.' } },
 *   replace: true,
 * });
 *
 * const strategy = appendOnlyHistoryStrategy(history);
 * ```
 */

import type { ModelMessage, Usage, Model } from 'fino:ai/model';

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
  operation?: MessageHistoryOperation;
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
 * Incremental immutable graph payload produced by `changesSince()`.
 */
export interface MessageHistoryDelta extends MessageHistorySnapshot {
  base?: string;
}

/**
 * Metadata describing why a history revision exists.
 */
export type MessageHistoryOperation =
  | { type: 'append'; entryIds: string[] }
  | { type: 'edit'; patches: MessageHistoryPatch[] }
  | { type: 'fork' }
  | { type: 'view'; entryIds: string[] };

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
    ...(revision.operation !== undefined ? { operation: JSON.parse(JSON.stringify(revision.operation)) as MessageHistoryOperation } : {}),
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
 * Immutable persistent sequence of model messages.
 *
 * Every operation returns a new collection pointing at a new revision. Original
 * entries remain available for restore, fork, and lineage inspection.
 */
export class MessageHistory {
  #entries: Map<string, MessageHistoryEntry>;
  #revisions: Map<string, MessageHistoryRevision>;
  #head: string;

  constructor(data?: {
    entries?: Iterable<MessageHistoryEntry>;
    revisions?: Iterable<MessageHistoryRevision>;
    head?: string;
  }) {
    this.#entries = new Map();
    this.#revisions = new Map();
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

  /** Number of entries in the active sequence. */
  get size(): number {
    return this.#activeEntryIds().length;
  }

  /** Return a new history with `entry` appended to the active sequence. */
  async append(entry: MessageHistoryEntryInput): Promise<MessageHistory> {
    const normalized = normalizeHistoryEntry(entry);
    return this.#commit(this.#activeEntryIds().concat(normalized.id), [normalized], {
      type: 'append',
      entryIds: [normalized.id],
    });
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

    return this.#commit(sequence, newEntries, { type: 'edit', patches: patchList });
  }

  /** Return a new revision with the same active sequence for branch isolation. */
  async fork(): Promise<MessageHistory> {
    return this.#commit(this.#activeEntryIds(), [], { type: 'fork' });
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
      });
    }
    const revision: MessageHistoryRevision = {
      id: newId(),
      parent: this.#head,
      entryIds: [...view],
      createdAt: Date.now(),
      operation: { type: 'view', entryIds: [...view] },
    };
    return new MessageHistory({
      entries: this.#entries.values(),
      revisions: [...this.#revisions.values(), revision],
      head: revision.id,
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

  /** Export entries, revisions, and active head for durable persistence. */
  toSnapshot(): MessageHistorySnapshot {
    return {
      entries: Array.from(this.#entries.values()).map(cloneEntry),
      revisions: Array.from(this.#revisions.values()).map(cloneRevision),
      head: this.#head,
    };
  }

  /**
   * Export graph entries and revisions added after `baseRevisionId`.
   *
   * The delta includes the head revision and each ancestor until, but not
   * including, the base revision. Entry payloads are limited to ids introduced
   * by those revisions compared with the base lineage.
   */
  changesSince(baseRevisionId?: string): MessageHistoryDelta {
    if (baseRevisionId === this.#head) {
      return { entries: [], revisions: [], head: this.#head, base: baseRevisionId };
    }

    const changedRevisions: MessageHistoryRevision[] = [];
    let current = this.#revisions.get(this.#head);
    while (current && current.id !== baseRevisionId) {
      changedRevisions.push(cloneRevision(current));
      current = current.parent ? this.#revisions.get(current.parent) : undefined;
    }
    if (baseRevisionId !== undefined && !current) {
      throw new Error(`Base history revision ${baseRevisionId} is not in the current lineage`);
    }

    const baseEntryIds = new Set<string>();
    if (baseRevisionId !== undefined) {
      let base = this.#revisions.get(baseRevisionId);
      while (base) {
        for (const id of base.entryIds) baseEntryIds.add(id);
        base = base.parent ? this.#revisions.get(base.parent) : undefined;
      }
    }

    const changedEntryIds = new Set<string>();
    for (const rev of changedRevisions) {
      for (const id of rev.entryIds) {
        if (!baseEntryIds.has(id)) changedEntryIds.add(id);
      }
    }

    return {
      entries: [...changedEntryIds]
        .map((id) => this.#entries.get(id))
        .filter((entry): entry is MessageHistoryEntry => entry !== undefined)
        .map(cloneEntry),
      revisions: changedRevisions,
      head: this.#head,
      ...(baseRevisionId !== undefined ? { base: baseRevisionId } : {}),
    };
  }

  /** Serialize entries, revisions, and active head for in-memory transfer. */
  toJSON(): MessageHistorySnapshot {
    return this.toSnapshot();
  }

  /** Reconstruct a history snapshot. */
  static fromSnapshot(snapshot: MessageHistorySnapshot): MessageHistory {
    return new MessageHistory({
      entries: snapshot.entries,
      revisions: snapshot.revisions,
      head: snapshot.head,
    });
  }

  /** Reconstruct a history snapshot. */
  static fromJSON(j: unknown): MessageHistory {
    return MessageHistory.fromSnapshot(j as MessageHistorySnapshot);
  }

  #activeEntryIds(): string[] {
    return [...(this.#revisions.get(this.#head)?.entryIds ?? [])];
  }

  async #commit(entryIds: string[], entries: MessageHistoryEntry[], operation: MessageHistoryOperation): Promise<MessageHistory> {
    const revision: MessageHistoryRevision = {
      id: newId(),
      parent: this.#head,
      entryIds,
      createdAt: Date.now(),
      operation,
    };
    return new MessageHistory({
      entries: [...this.#entries.values(), ...entries],
      revisions: [...this.#revisions.values(), revision],
      head: revision.id,
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
export function appendOnlyHistoryStrategy(history?: MessageHistory): HistoryStrategy {
  return {
    history: history ?? new MessageHistory(),
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
  const strategy = appendOnlyHistoryStrategy(opts.history);
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
  const strategy = appendOnlyHistoryStrategy(opts.history);
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
