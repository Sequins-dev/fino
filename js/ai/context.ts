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
 * Alongside the history substrate, the module carries the budget helpers that
 * strategies and agent loops share: `estimateTokens()` for cheap size checks,
 * the `PRICING` table and `costOf()` for converting reported usage into USD,
 * and the `maxTokens()` / `maxCost()` stop predicates for bounding agent runs.
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
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
// ── Interfaces ────────────────────────────────────────────────────────────────
/**
 * Optional metadata attached to a history entry.
 *
 * All fields are advisory: `MessageHistory` stores them verbatim and never
 * interprets them. Strategies and tooling typically use `labels` to tag
 * entries for later selection and `links` to relate an entry to external
 * records such as run ids or memory documents.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({
 *   message: { role: 'user', content: 'the deploy window is Friday' },
 *   meta: { turn: 3, labels: ['decision'], links: [{ rel: 'run', to: 'run-42' }] },
 * });
 * const decisions = history.refs().filter((e) => e.meta?.labels?.includes('decision'));
 * ```
 */
export interface MessageMeta {
  /** Conversation turn number the entry belongs to. */
  turn?: number;
  /** Creation time in milliseconds since the Unix epoch. */
  createdAt?: number;
  /** Free-form tags used to select or filter entries later. */
  labels?: string[];
  /** Typed references from this entry to related records. */
  links?: Array<{
    rel: string;
    to: string;
  }>;
}
/**
 * Read context passed to a `HistoryStrategy` before a model request.
 *
 * Strategies can use the active model, token budget, and abort signal to decide
 * whether to summarize, select a subset, or return the persisted view unchanged.
 *
 * ```ts no_run
 * import { appendOnlyHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const model = anthropic({ model: 'claude-sonnet-4-6' });
 * const strategy = appendOnlyHistoryStrategy();
 * const { messages } = await strategy.onRead({ model, budgetTokens: 100000 });
 * ```
 */
export interface HistoryReadContext {
  /** Model the upcoming request targets; strategies may also use it for summarization calls. */
  model: Model;
  /** Token budget the returned model-facing view should aim to fit within. */
  budgetTokens: number;
  /** Abort signal that cancels any model calls the strategy issues while curating. */
  signal?: AbortSignal;
}
/**
 * Append context passed when the runtime records a new inbound or generated
 * message.
 *
 * The run metadata is advisory. Strategies should update their own `history`
 * reference by assigning the immutable collection returned by `MessageHistory`.
 *
 * ```ts no_run
 * import { appendOnlyHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const model = anthropic({ model: 'claude-sonnet-4-6' });
 * const strategy = appendOnlyHistoryStrategy();
 * await strategy.onAppend(
 *   { role: 'user', content: 'hello' },
 *   { model, budgetTokens: 100000, runId: 'run-42', stepIndex: 0 },
 * );
 * ```
 */
export interface HistoryAppendContext extends HistoryReadContext {
  /** Identifier of the agent run recording the message. */
  runId?: string;
  /** Zero-based agent-loop step within the run. */
  stepIndex?: number;
}
/**
 * Owns the conversation history policy for an agent.
 *
 * The runtime only calls `onAppend` and `onRead`. It does not interpret why a
 * view was compacted, selected, summarized, or left unchanged. Because
 * `MessageHistory` is immutable, implementations advance state by reassigning
 * their `history` property with the collection returned from each operation;
 * the runtime treats that property as the strategy's current source of truth.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 * import type { HistoryStrategy } from 'fino:ai/context';
 *
 * const lastTen: HistoryStrategy = {
 *   history: new MessageHistory(),
 *   async onAppend(message) {
 *     this.history = await this.history.append(message);
 *   },
 *   async onRead() {
 *     const recent = this.history.refs().slice(-10).map((entry) => entry.id);
 *     return { history: this.history, messages: this.history.render(recent) };
 *   },
 * };
 * ```
 */
export interface HistoryStrategy {
  /** Current immutable history; reassigned after every history operation. */
  history: MessageHistory;
  /** Record an inbound user, assistant, or tool-result message. */
  onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void>;
  /** Produce the model-facing view for the next request, optionally compacting first. */
  onRead(ctx: HistoryReadContext): Promise<{
    history: MessageHistory;
    messages: ModelMessage[];
  }>;
}
/**
 * Wrap a history strategy with a retained signal of its current history.
 *
 * The wrapper delegates all behavior to `inner` and publishes after `onAppend`,
 * after `onRead`, and after direct assignments to `strategy.history`. Use it to
 * observe history evolution — UI live views, persistence triggers, metrics —
 * without teaching the strategy itself about subscribers.
 *
 * ```ts no_run
 * import { appendOnlyHistoryStrategy, signalHistoryStrategy } from 'fino:ai/context';
 * import { agent } from 'fino:ai/agent';
 * import { anthropic } from 'fino:ai/model';
 *
 * const { strategy, history } = signalHistoryStrategy(appendOnlyHistoryStrategy());
 * history.subscribe((h) => console.log('history entries:', h.size));
 *
 * const bot = agent({
 *   model: anthropic({ model: 'claude-sonnet-4-6' }),
 *   history: () => strategy,
 * });
 * await bot.generate('hello');
 * ```
 */
export function signalHistoryStrategy(inner: HistoryStrategy): {
  strategy: HistoryStrategy;
  history: ReadonlySignal<MessageHistory>;
} {
  const history = createSignal(inner.history);
  const publish = () => history.set(inner.history);
  const strategy: HistoryStrategy = {
    get history() {
      return inner.history;
    },
    set history(value: MessageHistory) {
      inner.history = value;
      publish();
    },
    async onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void> {
      await inner.onAppend(message, ctx);
      publish();
    },
    async onRead(ctx: HistoryReadContext): Promise<{
      history: MessageHistory;
      messages: ModelMessage[];
    }> {
      const result = await inner.onRead(ctx);
      publish();
      return result;
    },
  };
  return { strategy, history };
}
/**
 * Immutable message entry stored by `MessageHistory`.
 *
 * Summary entries can point at source entry ids so `restore()` can expand a
 * compacted view back to the original messages. Entries are never mutated in
 * place; `refs()` and `toSnapshot()` return defensive clones.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'hi' });
 * const [entry] = history.refs();
 * console.log(entry.id, entry.kind); // '1-abc1234' 'turn'
 * ```
 */
export interface MessageHistoryEntry {
  /** Stable unique id referenced by revisions, patches, and summaries. */
  id: string;
  /** The stored model message. */
  message: ModelMessage;
  /** `turn` for recorded conversation messages, `summary` for entries that condense others. */
  kind: 'turn' | 'summary';
  /** Advisory metadata supplied when the entry was created. */
  meta?: MessageMeta;
  /** Entry ids a summary condenses; consumed by `restore()`. */
  sources?: string[];
}
/**
 * Immutable ordered sequence of active entry ids.
 *
 * Revisions form a parent chain so forks and rewritten views keep lineage while
 * retaining the original entries.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'hi' });
 * const { revisions, head } = history.toSnapshot();
 * const current = revisions.find((rev) => rev.id === head);
 * console.log(current?.operation); // { type: 'append', entryIds: ['…'] }
 * ```
 */
export interface MessageHistoryRevision {
  /** Unique revision id; the history's `revisionId` when this revision is active. */
  id: string;
  /** Active entry ids in render order. */
  entryIds: string[];
  /** Id of the revision this one was derived from; absent on the root. */
  parent?: string;
  /** Creation time in milliseconds since the Unix epoch. */
  createdAt: number;
  /** The operation that produced this revision; absent on the root. */
  operation?: MessageHistoryOperation;
}
/**
 * Serializable history payload used by in-process tests and store reloads.
 *
 * A snapshot carries the full immutable graph — every entry and revision ever
 * created, not just the active view — so a reload preserves forks, summary
 * sources, and lineage exactly.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'persist me' });
 *
 * const snapshot = history.toSnapshot();
 * const loaded = MessageHistory.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
 * ```
 */
export interface MessageHistorySnapshot {
  /** Every entry in the graph, including entries only reachable from older revisions. */
  entries: MessageHistoryEntry[];
  /** The full revision graph, parents included. */
  revisions: MessageHistoryRevision[];
  /** Id of the active revision. */
  head: string;
}
/**
 * Incremental immutable graph payload produced by `changesSince()`.
 *
 * Contains only the entries and revisions added after the base revision, so a
 * store can commit deltas instead of rewriting the whole snapshot.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'committed' });
 * const checkpoint = history.revisionId;
 *
 * history = await history.append({ role: 'assistant', content: 'new since checkpoint' });
 * const delta = history.changesSince(checkpoint);
 * console.log(delta.base === checkpoint, delta.entries.length); // true 1
 * ```
 */
export interface MessageHistoryDelta extends MessageHistorySnapshot {
  /** Revision id the delta was computed against; absent when the delta is a full export. */
  base?: string;
}
/**
 * Metadata describing why a history revision exists.
 *
 * Each variant mirrors the `MessageHistory` operation that produced the
 * revision: `append` records the added entry ids, `edit` records the applied
 * patch list, `fork` marks a branch point, and `view` records a temporary
 * entry-id selection created by `withView()`.
 */
export type MessageHistoryOperation =
  | {
      type: 'append';
      entryIds: string[];
    }
  | {
      type: 'edit';
      patches: MessageHistoryPatch[];
    }
  | {
      type: 'fork';
    }
  | {
      type: 'view';
      entryIds: string[];
    };
/**
 * Rewrite operation applied to a `MessageHistory`.
 *
 * Patches can remove entries, replace an entry with one or more entries, insert
 * around an entry, move entries, split one message into extracted entries, or add
 * a summary linked to source ids.
 *
 * `edit()` applies patches in order against the evolving sequence; a patch that
 * targets an id absent from the active sequence is silently skipped. A `move`
 * with no matching `before`/`after` anchor moves the entries to the end. A
 * `summary` patch with `replace: true` swaps the source entries for the summary
 * at the position of the first source; without `replace` the summary is
 * appended and the sources stay active.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'keep' });
 * history = await history.append({ role: 'user', content: 'drop' });
 * const [, drop] = history.refs();
 * history = await history.edit({ op: 'remove', id: drop.id });
 * ```
 */
export type MessageHistoryPatch =
  | {
      op: 'remove';
      id: string;
    }
  | {
      op: 'replace';
      id: string;
      entries: MessageHistoryEntryInput[];
    }
  | {
      op: 'insertBefore' | 'insertAfter';
      id: string;
      entries: MessageHistoryEntryInput[];
    }
  | {
      op: 'move';
      ids: string[];
      before?: string;
      after?: string;
    }
  | {
      op: 'split';
      id: string;
      entries: MessageHistoryEntryInput[];
    }
  | {
      op: 'summary';
      sourceIds: string[];
      entry: MessageHistoryEntryInput;
      replace?: boolean;
    };
/**
 * Input accepted by `MessageHistory.append()` and rewrite operations.
 *
 * A bare `ModelMessage` becomes a `turn` entry with a generated id. The object
 * form controls the id, kind, metadata, and summary sources; omitted fields
 * fall back to the same defaults. Messages are deep-cloned on intake, so later
 * mutation of the input does not affect stored entries.
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
    ...(entry.meta !== undefined
      ? { meta: JSON.parse(JSON.stringify(entry.meta)) as MessageMeta }
      : {}),
    ...(entry.sources !== undefined ? { sources: [...entry.sources] } : {}),
  };
}
function cloneRevision(revision: MessageHistoryRevision): MessageHistoryRevision {
  return {
    id: revision.id,
    entryIds: [...revision.entryIds],
    ...(revision.parent !== undefined ? { parent: revision.parent } : {}),
    createdAt: revision.createdAt,
    ...(revision.operation !== undefined
      ? { operation: JSON.parse(JSON.stringify(revision.operation)) as MessageHistoryOperation }
      : {}),
  };
}
function normalizeHistoryEntry(input: MessageHistoryEntryInput): MessageHistoryEntry {
  if ('message' in input) {
    return {
      id: input.id ?? newId(),
      message: cloneMessage(input.message),
      kind: input.kind ?? 'turn',
      ...(input.meta !== undefined
        ? { meta: JSON.parse(JSON.stringify(input.meta)) as MessageMeta }
        : {}),
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
 * entries remain available for restore, fork, and lineage inspection. Because
 * instances never change, callers hold the latest history by reassigning a
 * variable (or a `HistoryStrategy.history` property) after each operation —
 * older references keep working and still see their own revision.
 *
 * ```ts no_run
 * import { MessageHistory } from 'fino:ai/context';
 *
 * let history = new MessageHistory();
 * history = await history.append({ role: 'user', content: 'question' });
 * history = await history.append({ role: 'assistant', content: 'answer' });
 *
 * const branch = await (await history.fork()).append({ role: 'user', content: 'what if?' });
 * console.log(history.size); // 2 — the original is untouched
 * console.log(branch.size);  // 3
 * ```
 */
export class MessageHistory {
  #entries: Map<string, MessageHistoryEntry>;
  #revisions: Map<string, MessageHistoryRevision>;
  #head: string;
  /**
   * Create a history, optionally rehydrating entries, revisions, and head.
   *
   * All inputs are defensively cloned. When `head` is omitted, or names a
   * revision that was not supplied, an empty revision with that id is created —
   * so `new MessageHistory()` starts blank.
   */
  constructor(data?: {
    entries?: Iterable<MessageHistoryEntry>;
    revisions?: Iterable<MessageHistoryRevision>;
    head?: string;
  }) {
    this.#entries = new Map();
    this.#revisions = new Map();
    for (const entry of data?.entries ?? []) this.#entries.set(entry.id, cloneEntry(entry));
    for (const revision of data?.revisions ?? [])
      this.#revisions.set(revision.id, cloneRevision(revision));
    this.#head = data?.head ?? newId();
    if (!this.#revisions.has(this.#head)) {
      this.#revisions.set(this.#head, {
        id: this.#head,
        entryIds: [],
        createdAt: Date.now(),
      });
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
  /**
   * Apply one or more sequence rewrites and return the resulting history.
   *
   * Patches apply in order against the evolving sequence; patches that target
   * ids absent from the active sequence are skipped. The resulting revision
   * records the full patch list as its operation.
   *
   * ```ts no_run
   * import { MessageHistory } from 'fino:ai/context';
   *
   * let history = new MessageHistory();
   * history = await history.append({ role: 'user', content: 'a' });
   * history = await history.append({ role: 'assistant', content: 'b' });
   * const [a] = history.refs();
   * history = await history.edit([
   *   { op: 'insertAfter', id: a.id, entries: [{ role: 'user', content: 'a2' }] },
   *   { op: 'remove', id: a.id },
   * ]);
   * ```
   */
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
    return this.#commit(sequence, newEntries, {
      type: 'edit',
      patches: patchList,
    });
  }
  /**
   * Return a new revision with the same active sequence for branch isolation.
   *
   * Appends and edits on the fork never affect the original history, but both
   * branches share the same underlying entries and lineage.
   */
  async fork(): Promise<MessageHistory> {
    return this.#commit(this.#activeEntryIds(), [], { type: 'fork' });
  }
  /**
   * Return a history focused on a revision id or temporary entry-id view.
   *
   * With a revision id, the returned history points its head at that revision —
   * useful for time travel over persisted lineage. With an entry-id array, a
   * temporary `view` revision is minted in the returned history only; the
   * original history is unaffected.
   *
   * Throws if a revision id is given that does not exist in the graph.
   *
   * ```ts no_run
   * import { MessageHistory } from 'fino:ai/context';
   *
   * let history = new MessageHistory();
   * history = await history.append({ role: 'user', content: 'first' });
   * const checkpoint = history.revisionId;
   * history = await history.append({ role: 'assistant', content: 'second' });
   *
   * const past = history.withView(checkpoint);
   * console.log(past.render().length); // 1
   * ```
   */
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
      operation: {
        type: 'view',
        entryIds: [...view],
      },
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
  /**
   * Expand summaries in the active sequence or selected ids to original messages.
   *
   * Summary entries are replaced by their `sources`, recursively, so nested
   * compactions unwind all the way back to the original turns. Ids that no
   * longer resolve to an entry are skipped.
   */
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
  /**
   * Return immutable entry references for the active sequence or selected view.
   *
   * Accepts a revision id or an entry-id array like `render()`. Entries are
   * defensive clones; unknown ids are dropped from the result.
   */
  refs(view?: string | string[]): MessageHistoryEntry[] {
    const ids = Array.isArray(view)
      ? view
      : typeof view === 'string'
        ? (this.#revisions.get(view)?.entryIds ?? [])
        : this.#activeEntryIds();
    return ids
      .map((id) => this.#entries.get(id))
      .filter((entry): entry is MessageHistoryEntry => !!entry)
      .map(cloneEntry);
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
   * by those revisions compared with the base lineage. Omitting
   * `baseRevisionId` exports the full lineage as a delta with no `base`.
   *
   * Throws if `baseRevisionId` is not an ancestor of the current head — a
   * delta across divergent branches would be ambiguous.
   */
  changesSince(baseRevisionId?: string): MessageHistoryDelta {
    if (baseRevisionId === this.#head) {
      return {
        entries: [],
        revisions: [],
        head: this.#head,
        base: baseRevisionId,
      };
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
  /** Reconstruct a history from `toSnapshot()` output, restoring full lineage. */
  static fromSnapshot(snapshot: MessageHistorySnapshot): MessageHistory {
    return new MessageHistory({
      entries: snapshot.entries,
      revisions: snapshot.revisions,
      head: snapshot.head,
    });
  }
  /** Reconstruct a history from parsed `toJSON()` output. */
  static fromJSON(j: unknown): MessageHistory {
    return MessageHistory.fromSnapshot(j as MessageHistorySnapshot);
  }
  #activeEntryIds(): string[] {
    return [...(this.#revisions.get(this.#head)?.entryIds ?? [])];
  }
  async #commit(
    entryIds: string[],
    entries: MessageHistoryEntry[],
    operation: MessageHistoryOperation,
  ): Promise<MessageHistory> {
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
 *
 * ```ts no_run
 * import { estimateTokens } from 'fino:ai/context';
 *
 * const tokens = estimateTokens([{ role: 'user', content: 'four chars per token, roughly' }]);
 * ```
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
 *
 * Cache rates are optional; when omitted, cache traffic contributes nothing to
 * the computed cost even if the usage reports it.
 *
 * ```ts no_run
 * import { costOf } from 'fino:ai/context';
 * import type { Pricing } from 'fino:ai/context';
 *
 * const pricing: Record<string, Pricing> = {
 *   'my-local-model': { inputPer1M: 0.2, outputPer1M: 0.8 },
 * };
 * const usd = costOf({ inputTokens: 1000000, outputTokens: 250000 }, 'my-local-model', pricing);
 * ```
 */
export interface Pricing {
  /** USD per million input tokens. */
  inputPer1M: number;
  /** USD per million output tokens. */
  outputPer1M: number;
  /** USD per million cache-read input tokens, when the provider bills them. */
  cacheReadPer1M?: number;
  /** USD per million cache-write input tokens, when the provider bills them. */
  cacheWritePer1M?: number;
}
/**
 * Built-in pricing table for bundled provider model ids.
 *
 * Keyed by model name as reported in usage accounting. Pass a custom table to
 * `costOf()` to extend or override these rates — the built-in table is a
 * fallback, not a registry.
 */
export const PRICING: Record<string, Pricing> = {
  'claude-fable-5': {
    inputPer1M: 10,
    outputPer1M: 50,
    cacheReadPer1M: 1,
    cacheWritePer1M: 12.5,
  },
  'claude-opus-4-8': {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: .5,
    cacheWritePer1M: 6.25,
  },
  'claude-opus-4-7': {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: .5,
    cacheWritePer1M: 6.25,
  },
  'claude-opus-4-6': {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: .5,
    cacheWritePer1M: 6.25,
  },
  'claude-sonnet-4-6': {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: .3,
    cacheWritePer1M: 3.75,
  },
  'claude-haiku-4-5': {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: .1,
    cacheWritePer1M: 1.25,
  },
};
/**
 * Calculate approximate USD cost for reported usage.
 *
 * Unknown models return `0` unless a custom pricing table contains `modelName`.
 * Cache read/write tokens are billed only when both the pricing entry defines
 * a cache rate and the usage reports the corresponding token count.
 *
 * ```ts no_run
 * import { costOf } from 'fino:ai/context';
 *
 * const usd = costOf(
 *   { inputTokens: 1200000, outputTokens: 80000, cacheReadInputTokens: 400000 },
 *   'claude-sonnet-4-6',
 * );
 * ```
 */
export function costOf(usage: Usage, modelName: string, pricing?: Record<string, Pricing>): number {
  const p = (pricing ?? PRICING)[modelName];
  if (!p) return 0;
  const inputCost = (usage.inputTokens / 1e6) * p.inputPer1M;
  const outputCost = (usage.outputTokens / 1e6) * p.outputPer1M;
  const cacheReadCost =
    p.cacheReadPer1M != null && usage.cacheReadInputTokens != null
      ? (usage.cacheReadInputTokens / 1e6) * p.cacheReadPer1M
      : 0;
  const cacheWriteCost =
    p.cacheWritePer1M != null && usage.cacheCreationInputTokens != null
      ? (usage.cacheCreationInputTokens / 1e6) * p.cacheWritePer1M
      : 0;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
// ── Stop conditions ───────────────────────────────────────────────────────────
/**
 * Create a stop predicate that triggers once total tokens reach `n`.
 *
 * The predicate sums accumulated input and output tokens from the run state.
 * Wire it into an agent's `stopWhen` to bound loop size.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { maxTokens } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const bot = agent({
 *   model: anthropic({ model: 'claude-sonnet-4-6' }),
 *   stopWhen: maxTokens(50000),
 * });
 * ```
 */
export function maxTokens(n: number): (
  state: {
    usage: Usage;
  },
  info: unknown,
) => boolean {
  return (state) => state.usage.inputTokens + state.usage.outputTokens >= n;
}
/**
 * Create a stop predicate that triggers once estimated cost reaches `usd`.
 *
 * Cost comes from the run state's accumulated `cost`, which is populated when
 * the model id is present in the pricing table. A missing cost is treated as
 * `0`, so runs against unpriced models never stop on this condition.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { maxCost } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const bot = agent({
 *   model: anthropic({ model: 'claude-sonnet-4-6' }),
 *   stopWhen: maxCost(2.50),
 * });
 * ```
 */
export function maxCost(usd: number): (
  state: {
    cost?: number;
  },
  info: unknown,
) => boolean {
  return (state) => (state.cost ?? 0) >= usd;
}
// ── Built-in strategy ─────────────────────────────────────────────────────────
function lastSafeSplitIndex(
  messages: ReadonlyArray<{
    message: ModelMessage;
  }>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.message.role === 'assistant') {
      const content = m.message.content;
      const hasToolUse =
        Array.isArray(content) &&
        (
          content as Array<{
            type: string;
          }>
        ).some((p) => p.type === 'tool_use');
      if (!hasToolUse) return i + 1;
    }
  }
  return 0;
}
/**
 * Create a strategy that appends every message and reads the full active view.
 *
 * This is the default strategy for simple agents and a useful base for custom
 * strategies that want to layer policy on top of append-only persistence. Pass
 * an existing `MessageHistory` to resume a conversation from a snapshot.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { appendOnlyHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const strategy = appendOnlyHistoryStrategy();
 * const bot = agent({
 *   model: anthropic({ model: 'claude-sonnet-4-6' }),
 *   history: () => strategy,
 * });
 * await bot.generate('hello');
 * console.log(strategy.history.render()); // full transcript so far
 * ```
 */
export function appendOnlyHistoryStrategy(history?: MessageHistory): HistoryStrategy {
  return {
    history: history ?? new MessageHistory(),
    async onAppend(message: ModelMessage): Promise<void> {
      this.history = await this.history.append(message);
    },
    async onRead(_ctx: HistoryReadContext): Promise<{
      history: MessageHistory;
      messages: ModelMessage[];
    }> {
      return {
        history: this.history,
        messages: this.history.render(),
      };
    },
  };
}
/**
 * Options for `summarizingHistoryStrategy()`.
 *
 * ```ts no_run
 * import { summarizingHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const strategy = summarizingHistoryStrategy({
 *   model: anthropic({ model: 'claude-haiku-4-5' }),
 *   triggerTokens: 50000,
 *   keepRecent: 20,
 * });
 * ```
 */
export interface SummarizingHistoryStrategyOptions {
  /** Model used for the summarization call; may differ from the conversation model. */
  model: Model;
  /** Estimated token count at which `onRead` compacts older entries. */
  triggerTokens: number;
  /** Number of most-recent entries always kept verbatim. */
  keepRecent: number;
  /** Optional sink that receives each summary text, e.g. a `fino:ai/memory` store. */
  memoryStore?: {
    ingest(
      docs: {
        text: string;
        metadata?: Record<string, unknown>;
      }[],
    ): Promise<void>;
  };
  /** Initial history; defaults to a new empty `MessageHistory`. */
  history?: MessageHistory;
}
/**
 * Create a strategy that lazily summarizes older entries during `onRead`.
 *
 * Appends are policy-free. When the active history reaches `triggerTokens`, the
 * strategy summarizes older safe entries and keeps the most recent
 * `keepRecent` entries verbatim. The summary replaces the compacted span as a
 * single `summary` entry with `sources` links, so `history.restore()` can
 * still recover the original messages.
 *
 * Compaction only cuts at safe boundaries: the summarized span ends after the
 * last assistant message that carries no tool use, so `tool_use`/`tool_result`
 * pairs are never split. If no safe boundary exists, the read returns the
 * history unchanged. When `memoryStore` is provided, each summary text is also
 * ingested with `kind: 'conversation_summary'` metadata.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { summarizingHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const model = anthropic({ model: 'claude-sonnet-4-6' });
 * const bot = agent({
 *   model,
 *   history: (history) => summarizingHistoryStrategy({
 *     model, triggerTokens: 60000, keepRecent: 10, history,
 *   }),
 * });
 * ```
 */
export function summarizingHistoryStrategy(
  opts: SummarizingHistoryStrategyOptions,
): HistoryStrategy {
  const strategy = appendOnlyHistoryStrategy(opts.history);
  return {
    get history() {
      return strategy.history;
    },
    set history(value: MessageHistory) {
      strategy.history = value;
    },
    async onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void> {
      await strategy.onAppend(message, ctx);
    },
    async onRead(ctx: HistoryReadContext): Promise<{
      history: MessageHistory;
      messages: ModelMessage[];
    }> {
      const tokens = this.history.estimateTokens();
      if (tokens < opts.triggerTokens) {
        return {
          history: this.history,
          messages: this.history.render(),
        };
      }
      const refs = this.history.refs();
      const keepFrom = Math.max(0, refs.length - opts.keepRecent);
      const toSummarize = refs.slice(0, keepFrom);
      if (toSummarize.length === 0) {
        return {
          history: this.history,
          messages: this.history.render(),
        };
      }
      const safeSplit = lastSafeSplitIndex(toSummarize);
      if (safeSplit === 0) {
        return {
          history: this.history,
          messages: this.history.render(),
        };
      }
      const summarySpan = toSummarize.slice(0, safeSplit);
      const result = await opts.model.generate({
        system:
          'Summarize the following conversation history concisely. Preserve all key decisions, facts, context, and important details needed to continue the conversation.',
        messages: [
          ...summarySpan.map((entry) => entry.message),
          {
            role: 'user',
            content: 'Summarize the above conversation.',
          },
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
        entry: {
          message: summary,
          kind: 'summary',
        },
        replace: true,
      });
      if (opts.memoryStore) {
        await opts.memoryStore.ingest([
          {
            text: result.text,
            metadata: { kind: 'conversation_summary' },
          },
        ]);
      }
      return {
        history: this.history,
        messages: this.history.render(),
      };
    },
  };
}
/**
 * Options for `selectiveSummaryHistoryStrategy()`.
 *
 * ```ts no_run
 * import { selectiveSummaryHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const strategy = selectiveSummaryHistoryStrategy({
 *   model: anthropic({ model: 'claude-haiku-4-5' }),
 *   summaryPrompt: 'Condense these tool results into key facts.',
 *   selector: (history) => history.refs()
 *     .filter((entry) => entry.meta?.labels?.includes('tool-noise'))
 *     .map((entry) => entry.id),
 * });
 * ```
 */
export interface SelectiveSummaryHistoryStrategyOptions {
  /** Model used for the summarization call. */
  model: Model;
  /** Chooses entry ids to compact on each read; return `[]` to leave the history unchanged. */
  selector: (history: MessageHistory, ctx: HistoryReadContext) => string[] | Promise<string[]>;
  /** System prompt for the summarization call. */
  summaryPrompt: string;
  /** Optional sink that receives each summary text, e.g. a `fino:ai/memory` store. */
  memoryStore?: {
    ingest(
      docs: {
        text: string;
        metadata?: Record<string, unknown>;
      }[],
    ): Promise<void>;
  };
  /** Initial history; defaults to a new empty `MessageHistory`. */
  history?: MessageHistory;
}
/**
 * Create a strategy that summarizes a selector-chosen subset during `onRead`.
 *
 * The selector receives the current history and returns entry ids. Selected
 * entries are summarized in one model call and replaced by a single `summary`
 * entry at the position of the first selected entry, while unselected entries
 * keep their positions. An empty selection leaves the history unchanged.
 *
 * Unlike `summarizingHistoryStrategy()`, which compacts a chronological prefix
 * on a token trigger, this strategy compacts an arbitrary subset every read —
 * use it to fold away noisy tool output or stale side threads while keeping
 * the live conversation verbatim. Summary `sources` links preserve the
 * originals for `history.restore()`; `memoryStore`, when provided, receives
 * each summary text with `kind: 'selected_history_summary'` metadata.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { selectiveSummaryHistoryStrategy } from 'fino:ai/context';
 * import { anthropic } from 'fino:ai/model';
 *
 * const model = anthropic({ model: 'claude-sonnet-4-6' });
 * const bot = agent({
 *   model,
 *   history: (history) => selectiveSummaryHistoryStrategy({
 *     model,
 *     history,
 *     summaryPrompt: 'Condense the older conversation into key facts and decisions.',
 *     selector: (history) => history.refs().slice(0, -5).map((entry) => entry.id),
 *   }),
 * });
 * ```
 */
export function selectiveSummaryHistoryStrategy(
  opts: SelectiveSummaryHistoryStrategyOptions,
): HistoryStrategy {
  const strategy = appendOnlyHistoryStrategy(opts.history);
  return {
    get history() {
      return strategy.history;
    },
    set history(value: MessageHistory) {
      strategy.history = value;
    },
    async onAppend(message: ModelMessage, ctx: HistoryAppendContext): Promise<void> {
      await strategy.onAppend(message, ctx);
    },
    async onRead(ctx: HistoryReadContext): Promise<{
      history: MessageHistory;
      messages: ModelMessage[];
    }> {
      const selectedIds = await opts.selector(this.history, ctx);
      if (selectedIds.length === 0) {
        return {
          history: this.history,
          messages: this.history.render(),
        };
      }
      const selected = this.history.refs(selectedIds);
      const result = await opts.model.generate({
        system: opts.summaryPrompt,
        messages: [
          ...selected.map((entry) => entry.message),
          {
            role: 'user',
            content: 'Summarize the selected conversation history.',
          },
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
        entry: {
          message: summary,
          kind: 'summary',
        },
        replace: true,
      });
      if (opts.memoryStore) {
        await opts.memoryStore.ingest([
          {
            text: result.text,
            metadata: { kind: 'selected_history_summary' },
          },
        ]);
      }
      return {
        history: this.history,
        messages: this.history.render(),
      };
    },
  };
}
