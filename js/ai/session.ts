/**
 * fino:ai/session — durable agent runs with session-owned history persistence.
 *
 * `Session` runs an already-configured `Agent` against an `AtomicStore`.
 * Use it when an agent run must survive process restarts, pause for external
 * input, continue a thread across multiple requests, or fork from an existing
 * conversation state.
 *
 * ## Storage model
 *
 * `MessageHistory` is an immutable in-memory graph. The exported conversation
 * and run functions are thin record codecs over `fino:store`; ACP and ordinary
 * agent conversations use the same namespace and layout. Atomic commits store
 * new history graph nodes, the current run state, and the thread head together.
 *
 * `Session.start()` creates a new run in the session thread, `resume()` injects
 * external input into a suspended run, and `fork()` creates a new thread from
 * the current history revision. `Session.resume()` and `Session.resumeSuspended()`
 * are for stateless adapters that need to continue from persisted state.
 *
 * ## Suspension and approval
 *
 * A run pauses in two ways: code inside a step throws `SuspendSignal` (waiting
 * for arbitrary external input), or a tool marked `requiresApproval` produces a
 * tool-approval request. Both persist a single-use resume token in
 * `RunState.suspendedOn`. Plain suspensions continue through
 * `resume(token, value)`; approval suspensions continue through
 * `approveTool()` / `rejectTool()`, or their static `*Suspended` counterparts
 * after a process restart.
 *
 * Every step is committed through the store's atomic capability before the
 * next one begins, so a crash never loses more than the in-flight step. The
 * live run state is observable through `watch()` for reactive consumers, and
 * an optional `Memory` feeds recalled context into new runs and records every
 * appended message.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 * import { sqliteStore } from 'fino:store';
 * import { session } from 'fino:ai/session';
 *
 * const store = await sqliteStore({ path: './runs.db' });
 * const sess = session({
 *   store,
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 *   threadId: 'customer-123',
 * });
 *
 * const first = await sess.start('Start a support conversation.');
 * if (first.status === 'suspended') {
 *   await sess.resume(first.state.suspendedOn!.token, 'human input');
 * }
 * ```
 */
import type { AtomicStore } from 'fino:store';
import { SuspendSignal, runContext } from 'fino:ai/runtime';
import { createSignal } from 'fino:signals';
import type { AgentState, StepResult, ToolApprovalRequest } from 'fino:ai/runtime';
import type { Agent } from 'fino:ai/agent';
import type { ModelMessage, Usage } from 'fino:ai/model';
import type { Memory } from 'fino:ai/memory';
import { MessageHistory } from 'fino:ai/context';
import type {
  MessageHistoryEntry,
  MessageHistoryRevision,
  MessageHistorySnapshot,
} from 'fino:ai/context';
import type { ReadonlySignal } from 'fino:signals';
/**
 * Durable lifecycle state for a session run.
 *
 * `running` is what a checkpoint says while a step is in flight — reading it
 * back from a store after a crash means the process died mid-drive, and
 * `Session.resume()` can re-drive from there. Driving calls only ever *return*
 * `suspended` or `done` results; failures and aborts commit an `error` or
 * `cancelled` checkpoint and then throw. `suspended` runs carry a single-use
 * resume token in `RunState.suspendedOn`.
 */
export type RunStatus = 'running' | 'suspended' | 'done' | 'error' | 'cancelled';
/**
 * Suspension metadata persisted with a paused run.
 *
 * Minted whenever a run suspends, and cleared when the run continues. For
 * tool-approval suspensions `payload` is the pending `ToolApprovalRequest`
 * (tool name, call id, arguments, risk); for `SuspendSignal` suspensions it is
 * whatever payload the signal carried.
 *
 * ```ts no_run
 * const r = await sess.start('delete the account for acct_1');
 * if (r.status === 'suspended') {
 *   console.log(r.state.suspendedOn!.reason);
 *   notifyOperator(r.runId, r.state.suspendedOn!.token);
 * }
 * ```
 */
export interface SuspendReason {
  /**
   * Single-use resume token. Pass it to `resume()`, `approveTool()`, or
   * `rejectTool()`; it is invalidated as soon as the run continues.
   */
  token: string;
  /**
   * Human-readable explanation of why the run paused.
   */
  reason?: string;
  /**
   * Structured data describing what the run is waiting for.
   */
  payload?: unknown;
}
/**
 * Durable checkpoint state for one run.
 *
 * This is the record the session codec persists after every step. Conversation
 * content never lives here — `historyRevisionId` points into the immutable
 * history graph instead, which keeps checkpoints small and lets many runs
 * share one graph.
 *
 * ```ts no_run
 * const state = await store.loadRun(runId);
 * if (state?.status === 'suspended') {
 *   console.log(`step ${state.stepIndex}, waiting on: ${state.suspendedOn?.reason}`);
 * }
 * ```
 */
export interface RunState {
  /**
   * Unique identifier of this run.
   */
  runId: string;
  /**
   * Thread the run belongs to.
   */
  threadId: string;
  /**
   * Current lifecycle state of the run.
   */
  status: RunStatus;
  /**
   * Number of agent steps completed so far.
   */
  stepIndex: number;
  /**
   * Token usage accumulated across all steps of the run.
   */
  usage: Usage;
  /**
   * Accumulated cost reported by the agent, when the model prices requests.
   */
  cost?: number;
  /**
   * Head of the immutable history graph as of the last committed step.
   */
  historyRevisionId?: string;
  /**
   * Suspension metadata; present only while `status` is `'suspended'`.
   */
  suspendedOn?: SuspendReason;
  /**
   * JSON-serializable bag for application bookkeeping carried across
   * checkpoints and restarts.
   */
  scratch: Record<string, unknown>;
  /**
   * Final assistant text once the run reaches `'done'`.
   */
  result?: unknown;
  /**
   * Failure captured when the run reached `'error'`.
   */
  error?: {
    message: string;
    stack?: string;
  };
}
/**
 * Durable pointer for one conversation thread.
 *
 * A thread is a named line of conversation. Its `historyRevisionId` is the
 * head of the immutable history graph and advances with every committed step;
 * starting a new run on the same `threadId` continues from this head, which is
 * how a conversation spans multiple runs and process lifetimes.
 *
 * ```ts no_run
 * const thread = await loadConversationThread(store, 'customer-123');
 * if (thread?.historyRevisionId) {
 *   const history = await loadConversationHistory(store, thread.historyRevisionId);
 *   console.log(history?.render().length, 'messages so far');
 * }
 * ```
 */
export interface ThreadState {
  /**
   * Unique identifier of the thread.
   */
  threadId: string;
  /**
   * Current head revision of the thread's history graph; absent until the
   * first commit.
   */
  historyRevisionId?: string;
  /**
   * Creation time in milliseconds since the epoch.
   */
  createdAt: number;
  /**
   * Time of the last commit in milliseconds since the epoch.
   */
  updatedAt: number;
  /**
   * Opaque backing-store version assigned after every successful commit. It
   * is absent only on a thread value that has not been persisted yet.
   */
  storeVersion?: string;
  /**
   * JSON-serializable conversation metadata owned by the caller.
   *
   * The store treats this as opaque data and commits it atomically with the
   * history head. Protocol adapters can therefore retain their own session
   * state without introducing a parallel persistence abstraction.
   */
  metadata?: Record<string, unknown>;
}
/** Raised when a conversation thread changes after a caller loads it. */
export class ConversationConflictError extends Error {
  /** Thread whose optimistic store version changed. */
  threadId: string;
  /** Store version observed by the caller, or `null` for creation. */
  expectedVersion: string | null;
  /** Current store version, or `null` when the thread does not exist. */
  actualVersion: string | null;
  /** Create a typed conversation-store conflict. */
  constructor(threadId: string, expectedVersion: string | null, actualVersion: string | null) {
    super(
      `Thread ${threadId} changed from store version ${expectedVersion ?? '<new>'} to ${actualVersion ?? '<new>'}`,
    );
    this.name = 'ConversationConflictError';
    this.threadId = threadId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
/**
 * Raised when a durable thread advances after a caller read its head.
 *
 * The failed commit writes nothing. Callers may reload and retry, reject the
 * overlapping turn, or explicitly fork from the revision they originally read.
 */
export class SessionConflictError extends Error {
  /** Thread whose optimistic concurrency check failed. */
  threadId: string;
  /** Revision the caller expected, or `null` for a new thread. */
  expectedRevisionId: string | null;
  /** Revision currently stored, or `null` when the thread does not exist. */
  actualRevisionId: string | null;
  /** Create a typed thread-head conflict. */
  constructor(
    threadId: string,
    expectedRevisionId: string | null,
    actualRevisionId: string | null,
  ) {
    super(
      `Thread ${threadId} changed from ${expectedRevisionId ?? '<new>'} to ${actualRevisionId ?? '<new>'}`,
    );
    this.name = 'SessionConflictError';
    this.threadId = threadId;
    this.expectedRevisionId = expectedRevisionId;
    this.actualRevisionId = actualRevisionId;
  }
}
/** Values atomically committed by `commitConversationThread()`. */
export interface ConversationCommitOptions {
  /** New thread head and caller-owned metadata. */
  thread: ThreadState;
  /** Immutable history graph whose head the thread references. */
  history: MessageHistory;
  /** Store version returned by `loadConversationThread()`, or `null` for creation. */
  expectedStoreVersion: string | null;
  /** Existing graph head; only later history nodes are written when supplied. */
  baseRevisionId?: string;
}

/** Values atomically committed by `commitAgentSession()`. */
export interface AgentSessionCommitOptions {
  /** Run checkpoint written with the thread head. */
  run: RunState;
  /** New thread head. */
  thread: ThreadState;
  /** Immutable history graph referenced by both records. */
  history: MessageHistory;
  /** History head observed before this commit, or `null` for a new thread. */
  expectedThreadRevisionId: string | null;
  /** Existing graph head; only later history nodes are written when supplied. */
  baseRevisionId?: string;
}
/**
 * Result returned by session start, resume, and fork operations.
 *
 * Driving calls resolve with `'suspended'` (the run paused; the resume token
 * is in `state.suspendedOn`) or `'done'` (the agent finished; `text` carries
 * the last assistant text). They never resolve with `'error'` — failures
 * commit an error checkpoint and then throw. `'done'` and `'cancelled'` also
 * appear when `Session.resume()` is pointed at an already-terminal run.
 *
 * ```ts no_run
 * const r = await sess.start('What changed in the last release?');
 * if (r.status === 'done') console.log(r.text);
 * else console.log('paused:', r.state.suspendedOn?.reason);
 * ```
 */
export interface RunResult {
  /**
   * Identifier of the run; use it with the static `Session.resume*` helpers.
   */
  runId: string;
  /**
   * Lifecycle state the run settled in for this call.
   */
  status: RunStatus;
  /**
   * The run's checkpoint as of the returned status.
   */
  state: RunState;
  /**
   * Last assistant text, present when the run completed.
   */
  text?: string;
}
/**
 * Decision supplied when resuming a tool approval suspension.
 *
 * An approved decision may carry an `approval` value that is forwarded to the
 * tool's execution context. A rejection skips the tool entirely and records
 * `reason` (defaulting to `'not approved'`) as an error tool result visible to
 * the model, which then continues the conversation.
 */
export type ToolApprovalDecision =
  | {
      approved: true;
      approval?: unknown;
    }
  | {
      approved: false;
      reason?: string;
    };
/**
 * Options for creating a `Session`.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 * import { memoryStore } from 'fino:store';
 * import { session } from 'fino:ai/session';
 *
 * const sess = session({
 *   store: memoryStore(),
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 *   threadId: 'customer-123',
 *   onCheckpoint: (s) => console.log(s.status, 'at step', s.stepIndex),
 * });
 * ```
 */
export interface SessionOptions {
  /**
   * Durable store that receives every checkpoint.
   */
  store: AtomicStore;
  /**
   * Configured agent whose step loop the session drives.
   */
  agent: Agent;
  /**
   * Optional long-term memory. On `start()` its recalled context (prior
   * messages, semantic hits, working memory) is folded in ahead of the input,
   * and every new message produced by the run is appended to it.
   */
  memory?: Memory;
  /**
   * Thread to continue. Defaults to a freshly generated id, i.e. a new
   * conversation.
   */
  threadId?: string;
  /**
   * Called after each committed step with the new run state.
   */
  onCheckpoint?: (s: RunState) => void;
}
let idCounter = 0;
function newId(): string {
  return `${++idCounter}-${Math.random().toString(36).slice(2)}`;
}
function extractText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const c = msg.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      for (const part of c as Array<{
        type: string;
        text?: string;
      }>) {
        if (part.type === 'text' && part.text) return part.text;
      }
    }
  }
  return '';
}
function inputText(messages: ModelMessage[]): string | undefined {
  const parts: string[] = [];
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      parts.push(content);
    } else {
      for (const part of content) {
        if (part.type === 'text') parts.push(part.text);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}
function memoryContextMessage(ctx: Awaited<ReturnType<Memory['recall']>>): ModelMessage | null {
  const sections: string[] = [];
  if (ctx.workingMemory) {
    sections.push(`Working memory:\n${JSON.stringify(ctx.workingMemory)}`);
  }
  if (ctx.recalled.length > 0) {
    sections.push(
      'Semantic recall:\n' +
        ctx.recalled
          .map((hit, i) => {
            const metadata = hit.metadata ? `\nmetadata: ${JSON.stringify(hit.metadata)}` : '';
            return `${i + 1}. ${hit.text}${metadata}`;
          })
          .join('\n\n'),
    );
  }
  if (sections.length === 0) return null;
  return {
    role: 'system',
    content: `[Memory context]\n${sections.join('\n\n')}`,
  };
}
async function historyFromMessages(messages: ModelMessage[]): Promise<MessageHistory> {
  let history = new MessageHistory();
  for (const msg of messages) history = await history.append(msg);
  return history;
}
async function forkHistoryFromState(state: RunState, store: AtomicStore): Promise<MessageHistory> {
  if (!state.historyRevisionId) throw new Error(`Run ${state.runId} has no history revision`);
  const history = await loadConversationHistory(store, state.historyRevisionId);
  if (!history) throw new Error(`History revision ${state.historyRevisionId} not found`);
  return history.fork();
}
async function driveHistoryFromState(state: RunState, store: AtomicStore): Promise<MessageHistory> {
  if (!state.historyRevisionId) throw new Error(`Run ${state.runId} has no history revision`);
  const history = await loadConversationHistory(store, state.historyRevisionId);
  if (!history) throw new Error(`History revision ${state.historyRevisionId} not found`);
  return history;
}
function cloneRunState(state: RunState): RunState {
  return JSON.parse(JSON.stringify(state)) as RunState;
}
function cloneThreadState(thread: ThreadState): ThreadState {
  return JSON.parse(JSON.stringify(thread)) as ThreadState;
}
function isToolApprovalRequest(value: unknown): value is ToolApprovalRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (
      value as {
        type?: unknown;
      }
    ).type === 'tool_approval' &&
    typeof (
      value as {
        toolCallId?: unknown;
      }
    ).toolCallId === 'string' &&
    typeof (
      value as {
        toolName?: unknown;
      }
    ).toolName === 'string'
  );
}
function validateCommit(args: {
  run?: RunState;
  thread: ThreadState;
  history: MessageHistory;
}): void {
  if (
    args.run?.historyRevisionId !== undefined &&
    args.run.historyRevisionId !== args.history.revisionId
  ) {
    throw new Error(
      `Run ${args.run.runId} points at history revision ${args.run.historyRevisionId}, not committed revision ${args.history.revisionId}`,
    );
  }
  if (
    args.thread.historyRevisionId !== undefined &&
    args.thread.historyRevisionId !== args.history.revisionId
  ) {
    throw new Error(
      `Thread ${args.thread.threadId} points at history revision ${args.thread.historyRevisionId}, not committed revision ${args.history.revisionId}`,
    );
  }
}
const RUN_PREFIX = 'run/';
const THREAD_PREFIX = 'thread/';
const ENTRY_PREFIX = 'history-entry/';
const REVISION_PREFIX = 'history-revision/';

function runKey(runId: string): string {
  return `${RUN_PREFIX}${runId}`;
}

function threadKey(threadId: string): string {
  return `${THREAD_PREFIX}${threadId}`;
}

function entryKey(entryId: string): string {
  return `${ENTRY_PREFIX}${entryId}`;
}

function revisionKey(revisionId: string): string {
  return `${REVISION_PREFIX}${revisionId}`;
}

function threadValue(thread: ThreadState): ThreadState {
  const copy = cloneThreadState(thread);
  delete copy.storeVersion;
  return copy;
}

function historyWrites(history: MessageHistory, baseRevisionId?: string) {
  const delta = history.changesSince(baseRevisionId);
  return [
    ...delta.entries.map((entry) => ({
      key: entryKey(entry.id),
      value: JSON.parse(JSON.stringify(entry)) as MessageHistoryEntry,
    })),
    ...delta.revisions.map((revision) => ({
      key: revisionKey(revision.id),
      value: JSON.parse(JSON.stringify(revision)) as MessageHistoryRevision,
    })),
  ];
}

function sessionValues(store: AtomicStore): AtomicStore {
  return store.namespace('fino:ai/session:v1');
}

/** Load a detached agent run checkpoint, or `null`. */
export async function loadAgentRun(store: AtomicStore, runId: string): Promise<RunState | null> {
  const state = await sessionValues(store).get<RunState>(runKey(runId));
  return state ? cloneRunState(state) : null;
}

/** List detached agent run checkpoints, optionally restricted to one thread. */
export async function listAgentRuns(
  store: AtomicStore,
  filter: { threadId?: string } = {},
): Promise<RunState[]> {
  return (await sessionValues(store).list<RunState>({ prefix: RUN_PREFIX }))
    .map((entry) => cloneRunState(entry.value))
    .filter((run) => filter.threadId === undefined || run.threadId === filter.threadId);
}

/** Delete a run checkpoint while retaining its thread and shared history. */
export async function deleteAgentRun(store: AtomicStore, runId: string): Promise<void> {
  await sessionValues(store).delete(runKey(runId));
}

/** Load a detached conversation thread with its current store version. */
export async function loadConversationThread(
  store: AtomicStore,
  threadId: string,
): Promise<ThreadState | null> {
  const entry = await sessionValues(store).atomic.getEntry<ThreadState>(threadKey(threadId));
  return entry ? { ...cloneThreadState(entry.value), storeVersion: entry.version } : null;
}

/** List detached conversation threads newest first. */
export async function listConversationThreads(store: AtomicStore): Promise<ThreadState[]> {
  const values = sessionValues(store);
  const threads = await values.list<ThreadState>({ prefix: THREAD_PREFIX });
  const loaded = await Promise.all(
    threads.map((thread) => values.atomic.getEntry<ThreadState>(thread.key)),
  );
  return loaded
    .filter((entry) => entry !== null)
    .map((entry) => ({ ...cloneThreadState(entry!.value), storeVersion: entry!.version }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
}

/** Delete one thread head while retaining runs and shared history nodes. */
export async function deleteConversationThread(
  store: AtomicStore,
  threadId: string,
): Promise<boolean> {
  const values = sessionValues(store);
  const key = threadKey(threadId);
  for (;;) {
    const current = await values.atomic.getEntry(key);
    if (!current) return false;
    const removed = await values.atomic.commit({
      checks: [{ key, ifVersion: current.version }],
      deletes: [key],
    });
    if (removed) return true;
  }
}

/** Reconstruct an immutable conversation history from one graph revision. */
export async function loadConversationHistory(
  store: AtomicStore,
  revisionId: string,
): Promise<MessageHistory | null> {
  const values = sessionValues(store);
  const revisions: MessageHistoryRevision[] = [];
  let currentId: string | undefined = revisionId;
  while (currentId) {
    const revision = await values.get<MessageHistoryRevision>(revisionKey(currentId));
    if (!revision) {
      if (revisions.length === 0) return null;
      break;
    }
    revisions.push(JSON.parse(JSON.stringify(revision)) as MessageHistoryRevision);
    currentId = revision.parent;
  }
  const needed = new Set(revisions.flatMap((revision) => revision.entryIds));
  const entries: MessageHistoryEntry[] = [];
  for (const id of needed) {
    const entry = await values.get<MessageHistoryEntry>(entryKey(id));
    if (!entry) throw new Error(`History entry ${id} not found`);
    entries.push(JSON.parse(JSON.stringify(entry)) as MessageHistoryEntry);
  }
  const snapshot: MessageHistorySnapshot = { entries, revisions, head: revisionId };
  return MessageHistory.fromSnapshot(snapshot);
}

/** Atomically commit a conversation history delta, thread head, and metadata. */
export async function commitConversationThread(
  store: AtomicStore,
  args: ConversationCommitOptions,
): Promise<ThreadState> {
  const values = sessionValues(store);
  const thread = cloneThreadState(args.thread);
  validateCommit({ thread, history: args.history });
  const key = threadKey(thread.threadId);
  const current = await values.atomic.getEntry<ThreadState>(key);
  const actualVersion = current?.version ?? null;
  if (actualVersion !== args.expectedStoreVersion) {
    throw new ConversationConflictError(thread.threadId, args.expectedStoreVersion, actualVersion);
  }
  if (thread.metadata === undefined && current?.value.metadata !== undefined)
    thread.metadata = cloneThreadState(current.value).metadata;
  const result = await values.atomic.commit({
    checks: [{ key, ifVersion: args.expectedStoreVersion }],
    writes: [
      ...historyWrites(args.history, args.baseRevisionId),
      { key, value: threadValue(thread) },
    ],
  });
  if (!result) {
    const actual = await values.atomic.getEntry(key);
    throw new ConversationConflictError(
      thread.threadId,
      args.expectedStoreVersion,
      actual?.version ?? null,
    );
  }
  const saved = result.writes[result.writes.length - 1]!;
  return { ...cloneThreadState(saved.value as ThreadState), storeVersion: saved.version };
}

/** Atomically commit a run checkpoint with its history and thread head. */
export async function commitAgentSession(
  store: AtomicStore,
  args: AgentSessionCommitOptions,
): Promise<void> {
  const values = sessionValues(store);
  const run = cloneRunState(args.run);
  const thread = cloneThreadState(args.thread);
  validateCommit({ run, thread, history: args.history });
  const key = threadKey(thread.threadId);
  for (;;) {
    const current = await values.atomic.getEntry<ThreadState>(key);
    const actualHistoryRevision = current?.value.historyRevisionId ?? null;
    if (actualHistoryRevision !== args.expectedThreadRevisionId) {
      throw new SessionConflictError(
        thread.threadId,
        args.expectedThreadRevisionId,
        actualHistoryRevision,
      );
    }
    const nextThread =
      thread.metadata === undefined && current?.value.metadata !== undefined
        ? { ...thread, metadata: cloneThreadState(current.value).metadata }
        : thread;
    const result = await values.atomic.commit({
      checks: [{ key, ifVersion: current?.version ?? null }],
      writes: [
        ...historyWrites(args.history, args.baseRevisionId),
        { key: runKey(run.runId), value: run },
        { key, value: threadValue(nextThread) },
      ],
    });
    if (result) return;
  }
}
const MAX_DRIVE_STEPS = 100;
/**
 * Durable runner for an agent thread.
 *
 * A `Session` binds an `Agent` to an `AtomicStore` and one conversation
 * thread. Each `start()` creates a run; the session drives the agent one step
 * at a time, committing a checkpoint after every step, and returns when the
 * run completes or suspends. A single driving call may take at most 100 steps
 * before failing with a step-count error.
 *
 * Instances hold the latest `RunState` in memory (`state`, `watch()`), but a
 * run does not depend on its instance surviving: the static `resume()`,
 * `resumeSuspended()`, `approveSuspended()`, and `rejectSuspended()` helpers
 * rebuild everything from the store, which is what stateless adapters such as
 * HTTP handlers should use.
 *
 * Construct sessions with the `session()` factory — the constructor is
 * private.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 * import { sqliteStore } from 'fino:store';
 * import { session } from 'fino:ai/session';
 *
 * const store = await sqliteStore({ path: './runs.db' });
 * const sess = session({
 *   store,
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 *   threadId: 'ticket-42',
 * });
 *
 * const r = await sess.start('Summarize the open issue.');
 * if (r.status === 'suspended') {
 *   const token = r.state.suspendedOn!.token;
 *   const finished = await sess.resume(token, 'here is the missing detail');
 *   console.log(finished.text);
 * } else {
 *   console.log(r.text);
 * }
 * ```
 */
export class Session {
  #opts: SessionOptions;
  #threadId: string;
  #state: RunState | undefined;
  #stateSignal;
  private constructor(opts: SessionOptions, loaded?: RunState) {
    this.#opts = opts;
    this.#threadId = loaded?.threadId ?? opts.threadId ?? newId();
    this.#state = loaded;
    this.#stateSignal = createSignal<RunState | undefined>(
      loaded ? cloneRunState(loaded) : undefined,
    );
  }
  /**
   * Latest run state held by this instance, or `undefined` before a run has
   * been started or loaded.
   */
  get state(): RunState | undefined {
    return this.#state;
  }
  /**
   * Watch the latest run state held by this session instance.
   *
   * The signal is `undefined` until a run is started or loaded. Once a run
   * exists, it retains the latest checkpoint or terminal state for reactive UI
   * consumers in this realm.
   *
   * ```ts no_run
   * sess.watch().subscribe((state) => {
   *   if (state) render(`${state.status} — step ${state.stepIndex}`);
   * });
   * await sess.start('go');
   * ```
   */
  watch(): ReadonlySignal<RunState | undefined> {
    return this.#stateSignal;
  }
  #setState(state: RunState): void {
    this.#state = state;
    this.#stateSignal.set(cloneRunState(state));
  }
  /**
   * Resume a non-suspended run from its persisted checkpoint.
   *
   * Intended for crash recovery: a run whose last checkpoint is `running`
   * (the process died mid-drive) or `error` is re-driven from its committed
   * history revision. Already-terminal runs (`done`, `cancelled`) return
   * their stored result without invoking the agent.
   *
   * Throws if the run id is unknown, or if the run is `suspended` —
   * suspended runs need their resume token, via the instance `resume()` or
   * `Session.resumeSuspended()`.
   *
   * ```ts no_run
   * import { Session } from 'fino:ai/session';
   *
   * const result = await Session.resume({ store, agent: bot, runId });
   * console.log(result.status, result.text);
   * ```
   */
  static async resume(
    opts: SessionOptions & {
      runId: string;
    },
  ): Promise<RunResult> {
    const loaded = await loadAgentRun(opts.store, opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    if (loaded.status === 'done' || loaded.status === 'cancelled') {
      return {
        runId: loaded.runId,
        status: loaded.status,
        state: loaded,
        text: typeof loaded.result === 'string' ? loaded.result : undefined,
      };
    }
    if (loaded.status === 'suspended') {
      throw new Error(
        `Run ${opts.runId} is suspended; use session instance resume(token, value) instead`,
      );
    }
    const sess = new Session(opts, loaded);
    return sess.#drive({
      ...loaded,
      status: 'running',
    });
  }
  /**
   * Resume a suspended run from durable state.
   *
   * Use this from stateless adapters such as HTTP channels where the original
   * `Session` instance may no longer be in memory. The token is checked against
   * the stored run and remains single-use. Throws if the run id is unknown,
   * the run is not suspended, the token does not match, or the suspension is
   * a tool approval — those go through `approveSuspended()` /
   * `rejectSuspended()` instead.
   *
   * ```ts no_run
   * import { Session } from 'fino:ai/session';
   *
   * app.post('/runs/:runId/resume', async (req) => {
   *   const { token, value } = await req.json();
   *   return Session.resumeSuspended({
   *     store, agent: bot,
   *     runId: req.params.runId,
   *     resumeToken: token,
   *     value,
   *   });
   * });
   * ```
   */
  static async resumeSuspended(
    opts: SessionOptions & {
      runId: string;
      resumeToken: string;
      value: unknown;
      signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    const loaded = await loadAgentRun(opts.store, opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.resume(opts.resumeToken, opts.value, { signal: opts.signal });
  }
  /**
   * Approve a persisted tool approval suspension after process restart.
   *
   * Loads the run from the store and continues it as `approveTool()` would:
   * the pending tool executes (exactly once), `opts.approval` is forwarded to
   * its execution context, and the agent loop runs on to completion or the
   * next suspension. Throws if the run id is unknown, the token does not
   * match, or the run is not suspended for tool approval.
   *
   * ```ts no_run
   * import { Session } from 'fino:ai/session';
   *
   * const resumed = await Session.approveSuspended({
   *   store, agent: bot,
   *   runId: pending.runId,
   *   resumeToken: pending.state.suspendedOn!.token,
   * });
   * ```
   */
  static async approveSuspended(
    opts: SessionOptions & {
      runId: string;
      resumeToken: string;
      approval?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    const loaded = await loadAgentRun(opts.store, opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.approveTool(opts.resumeToken, {
      approval: opts.approval,
      signal: opts.signal,
    });
  }
  /**
   * Reject a persisted tool approval suspension after process restart.
   *
   * The pending tool never executes; `opts.reason` (default `'not approved'`)
   * is recorded as an error tool result and the model continues from there.
   * Throws under the same conditions as `approveSuspended()`. Tokens are
   * single-use across both decisions: once a suspension is approved it can no
   * longer be rejected, and vice versa.
   */
  static async rejectSuspended(
    opts: SessionOptions & {
      runId: string;
      resumeToken: string;
      reason?: string;
      signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    const loaded = await loadAgentRun(opts.store, opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.rejectTool(opts.resumeToken, opts.reason, { signal: opts.signal });
  }
  /**
   * Start a new run in this session thread.
   *
   * Input is a plain user string or pre-built messages. If the thread already
   * has committed history, the new run continues from its head — this is how
   * a conversation carries across runs, restarts, and requests. When the
   * session has a `Memory`, recalled context (prior messages, semantic hits,
   * working memory) is folded in ahead of the input and the input is appended
   * to memory.
   *
   * Resolves with a `'done'` or `'suspended'` result. Agent errors, aborts
   * via `opts.signal`, and exceeding the 100-step budget commit the matching
   * `error`/`cancelled` checkpoint and then throw.
   *
   * ```ts no_run
   * const r = await sess.start('What did we decide about the rollout?');
   * console.log(r.status === 'done' ? r.text : r.state.suspendedOn?.reason);
   * ```
   */
  async start(
    input:
      | string
      | {
          messages: ModelMessage[];
        },
    opts?: {
      runId?: string;
      signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    const runId = opts?.runId ?? newId();
    const signal = opts?.signal;
    const inputMessages: ModelMessage[] =
      typeof input === 'string'
        ? [
            {
              role: 'user',
              content: input,
            },
          ]
        : input.messages;
    const thread = await this.#loadThread();
    let history = thread.historyRevisionId
      ? await this.#loadHistory(thread.historyRevisionId)
      : new MessageHistory();
    const baseRevisionId = thread.historyRevisionId;
    let messages: ModelMessage[] = [...history.render(), ...inputMessages];
    if (this.#opts.memory) {
      const ctx = await this.#opts.memory.recall({ text: inputText(inputMessages) });
      const historyMsgs = ctx.messages.map((m) => ({
        role: m.role as ModelMessage['role'],
        content: m.content as ModelMessage['content'],
      }));
      const memoryContext = memoryContextMessage(ctx);
      for (const msg of [...historyMsgs, ...(memoryContext ? [memoryContext] : [])]) {
        history = await history.append(msg);
      }
      messages = [...history.render(), ...inputMessages];
      for (const msg of inputMessages) {
        await this.#opts.memory.append({
          role: msg.role,
          content: msg.content,
        });
      }
    }
    const state: RunState = {
      runId,
      threadId: this.#threadId,
      status: 'running',
      stepIndex: 0,
      historyRevisionId: history.revisionId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      scratch: {},
    };
    this.#setState(state);
    return this.#drive(state, signal, history, messages, baseRevisionId, thread);
  }
  /**
   * Resume the current suspended run with external input.
   *
   * `value` is injected as a user message (strings verbatim, anything else
   * JSON-stringified) and the agent loop continues from the persisted history
   * revision. Throws if no run has started, the run is not suspended, the
   * token does not match (tokens are single-use), or the suspension is a
   * tool approval — those must go through `approveTool()` / `rejectTool()`.
   *
   * ```ts no_run
   * const r = await sess.start('book the trip');
   * if (r.status === 'suspended') {
   *   const done = await sess.resume(r.state.suspendedOn!.token, {
   *     departure: '2026-08-01',
   *   });
   * }
   * ```
   */
  async resume(
    resumeToken: string,
    value: unknown,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    if (!this.#state) throw new Error('No state; call start() first');
    if (this.#state.status !== 'suspended') {
      throw new Error(`Run is not suspended (currently: ${this.#state.status})`);
    }
    if (this.#state.suspendedOn?.token !== resumeToken) {
      throw new Error('Invalid or expired resume token');
    }
    if (isToolApprovalRequest(this.#state.suspendedOn?.payload)) {
      throw new Error('Run is suspended for tool approval; use approveTool() or rejectTool()');
    }
    const history = await driveHistoryFromState(this.#state, this.#opts.store);
    const baseRevisionId = history.revisionId;
    const thread = await this.#loadExpectedThread(baseRevisionId);
    const state: RunState = {
      ...this.#state,
      status: 'running',
      suspendedOn: undefined,
      historyRevisionId: history.revisionId,
    };
    const injected: ModelMessage = {
      role: 'user',
      content: typeof value === 'string' ? value : JSON.stringify(value),
    };
    return this.#drive(
      state,
      opts?.signal,
      history,
      [...history.render(), injected],
      baseRevisionId,
      thread,
    );
  }
  /**
   * Approve a pending approval-required tool call and continue the run.
   *
   * The tool executes exactly once, with `opts.approval` forwarded to its
   * execution context, then the agent loop continues from the resulting tool
   * message. Throws if no run has started, the run is not suspended, the
   * token does not match, or the suspension is not a tool approval (use
   * `resume()` for those).
   *
   * ```ts no_run
   * const r = await sess.start('delete acct_1');
   * if (r.status === 'suspended') {
   *   const done = await sess.approveTool(r.state.suspendedOn!.token, {
   *     approval: { approvedBy: 'ops@example.com' },
   *   });
   * }
   * ```
   */
  approveTool(
    resumeToken: string,
    opts: {
      approval?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<RunResult> {
    return this.#decideTool(
      resumeToken,
      {
        approved: true,
        approval: opts.approval,
      },
      opts.signal,
    );
  }
  /**
   * Reject a pending approval-required tool call and continue the run with an
   * error tool result visible to the model.
   *
   * The tool never executes. `reason` (default `'not approved'`) becomes the
   * error tool result, so the model can explain or try another approach.
   * Throws under the same conditions as `approveTool()`.
   */
  rejectTool(
    resumeToken: string,
    reason?: string,
    opts: {
      signal?: AbortSignal;
    } = {},
  ): Promise<RunResult> {
    return this.#decideTool(
      resumeToken,
      {
        approved: false,
        reason,
      },
      opts.signal,
    );
  }
  async #decideTool(
    resumeToken: string,
    decision: ToolApprovalDecision,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (!this.#state) throw new Error('No state; call start() first');
    if (this.#state.status !== 'suspended') {
      throw new Error(`Run is not suspended (currently: ${this.#state.status})`);
    }
    if (this.#state.suspendedOn?.token !== resumeToken) {
      throw new Error('Invalid or expired resume token');
    }
    const request = this.#state.suspendedOn.payload;
    if (!isToolApprovalRequest(request)) {
      throw new Error('Run is not suspended for tool approval; use resume()');
    }
    const history = await driveHistoryFromState(this.#state, this.#opts.store);
    const baseRevisionId = history.revisionId;
    const thread = await this.#loadExpectedThread(baseRevisionId);
    const state: RunState = {
      ...this.#state,
      status: 'running',
      suspendedOn: undefined,
      historyRevisionId: history.revisionId,
    };
    const approvalValue = decision.approved
      ? {
          approved: true,
          approval: decision.approval,
        }
      : {
          approved: false,
          reason: decision.reason ?? 'not approved',
        };
    const execution = this.#opts.agent.createSession({ history });
    let approval: StepResult;
    try {
      approval = await execution.approveTool(
        {
          messages: history.render(),
          stepIndex: state.stepIndex,
          usage: state.usage,
          cost: state.cost,
          history,
          signal,
        },
        request,
        approvalValue,
      );
    } finally {
      execution.close();
    }
    const approvedHistory = approval.state.history ?? history;
    const approvedState: RunState = {
      ...state,
      stepIndex: approval.state.stepIndex,
      usage: approval.state.usage,
      cost: approval.state.cost,
      historyRevisionId: approvedHistory.revisionId,
    };
    this.#setState(approvedState);
    const committedThread = await this.#commit(
      approvedState,
      approvedHistory,
      baseRevisionId,
      thread,
    );
    return this.#drive(
      approvedState,
      signal,
      approvedHistory,
      approvedHistory.render(),
      approvedHistory.revisionId,
      committedThread,
    );
  }
  /**
   * Suspend execution from inside workflow or application code.
   *
   * Throws `SuspendSignal` and never returns. Call it from code running
   * within a driven step (for example a tool body) to pause the run: the
   * session checkpoints a `suspended` state with a fresh single-use resume
   * token, and `reason`/`payload` surface on `RunState.suspendedOn`.
   */
  suspend(opts?: { reason?: string; payload?: unknown }): never {
    throw new SuspendSignal(opts?.reason, opts?.payload);
  }
  /**
   * Fork the current history into a new thread and start a new run.
   *
   * The fork shares the committed history up to the current revision and then
   * diverges: it gets a freshly generated `threadId` and its own run state,
   * and subsequent steps in either thread never affect the other. Because the
   * history graph is immutable and shared, the fork costs only new revisions,
   * not a copy of the conversation. Throws if no run has started or the
   * current run has no committed history revision.
   *
   * ```ts no_run
   * await sess.start('Draft the launch plan.');
   * const alt = await sess.fork('Now redo it assuming a two-week delay.');
   * console.log(alt.state.threadId !== sess.state!.threadId); // true
   * ```
   */
  async fork(
    input:
      | string
      | {
          messages: ModelMessage[];
        },
    opts?: {
      runId?: string;
      signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    if (!this.#state) throw new Error('No state; call start() first');
    const parentRevisionId = this.#state.historyRevisionId;
    let history = await forkHistoryFromState(this.#state, this.#opts.store);
    const inputMessages: ModelMessage[] =
      typeof input === 'string'
        ? [
            {
              role: 'user',
              content: input,
            },
          ]
        : input.messages;
    const forkedRunId = opts?.runId ?? newId();
    const now = Date.now();
    const forkedState: RunState = {
      runId: forkedRunId,
      threadId: newId(),
      status: 'running',
      stepIndex: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
      historyRevisionId: history.revisionId,
      scratch: {},
    };
    const forkedSession = new Session(this.#opts, forkedState);
    forkedSession.#threadId = forkedState.threadId;
    return forkedSession.#drive(
      forkedState,
      opts?.signal,
      history,
      [...history.render(), ...inputMessages],
      parentRevisionId,
      {
        threadId: forkedState.threadId,
        createdAt: now,
        updatedAt: now,
      },
    );
  }
  /**
   * Mark the current run as cancelled.
   *
   * Commits a `cancelled` checkpoint for the current run. This does not
   * interrupt an in-flight `start()`/`resume()` — pass an `AbortSignal` to
   * those calls to stop work in progress. No-op when no run has started.
   */
  async cancel(): Promise<void> {
    if (!this.#state) return;
    const state: RunState = {
      ...this.#state,
      status: 'cancelled',
    };
    this.#setState(state);
    const history = state.historyRevisionId
      ? await loadConversationHistory(this.#opts.store, state.historyRevisionId)
      : null;
    if (history) {
      const thread = await this.#loadExpectedThread(state.historyRevisionId);
      await this.#commit(state, history, state.historyRevisionId, thread);
    }
  }
  async #drive(
    state: RunState,
    signal?: AbortSignal,
    initialHistory?: MessageHistory,
    initialMessages?: ModelMessage[],
    initialBaseRevisionId?: string,
    initialThread?: Partial<ThreadState> & {
      threadId: string;
    },
  ): Promise<RunResult> {
    const runCtxValue = {
      runId: state.runId,
      stepIndex: state.stepIndex,
      signal,
    };
    return runContext.runWithValue(runCtxValue, async () => {
      let stepsThisCall = 0;
      let history = initialHistory ?? (await driveHistoryFromState(state, this.#opts.store));
      let pendingMessages = initialMessages;
      let baseRevisionId = initialBaseRevisionId ?? state.historyRevisionId;
      let thread = initialThread
        ? {
            threadId: initialThread.threadId,
            createdAt: initialThread.createdAt ?? Date.now(),
            updatedAt: initialThread.updatedAt ?? Date.now(),
            ...(initialThread.historyRevisionId
              ? { historyRevisionId: initialThread.historyRevisionId }
              : {}),
          }
        : await this.#loadExpectedThread(state.historyRevisionId);
      const execution = this.#opts.agent.createSession({ history });
      try {
        while (true) {
          runCtxValue.stepIndex = state.stepIndex;
          if (stepsThisCall++ >= MAX_DRIVE_STEPS) {
            state = {
              ...state,
              status: 'error',
              error: { message: 'Session exceeded maximum step count' },
            };
            this.#setState(state);
            await this.#commit(state, history, baseRevisionId, thread);
            throw new Error('Session exceeded maximum step count');
          }
          const hState: AgentState = {
            messages: pendingMessages ?? history.render(),
            stepIndex: state.stepIndex,
            usage: state.usage,
            cost: state.cost,
            history,
            signal,
          };
          let r: StepResult;
          try {
            r = await execution.step(hState);
          } catch (err) {
            const e = err as Error;
            if (e.name === 'AbortError') {
              state = {
                ...state,
                status: 'cancelled',
              };
              this.#setState(state);
              await this.#commit(state, history, baseRevisionId, thread);
              throw err;
            }
            state = {
              ...state,
              status: 'error',
              error: {
                message: e.message,
                stack: e.stack,
              },
            };
            this.#setState(state);
            await this.#commit(state, history, baseRevisionId, thread);
            throw err;
          }
          const prevLen = history.render().length;
          history = r.state.history ?? history;
          pendingMessages = undefined;
          state = {
            ...state,
            stepIndex: r.state.stepIndex,
            usage: r.state.usage,
            cost: r.state.cost,
            historyRevisionId: history.revisionId,
          };
          if (this.#opts.memory) {
            const newMsgs = history.render().slice(prevLen);
            for (const msg of newMsgs) {
              await this.#opts.memory.append({
                role: msg.role,
                content: msg.content,
              });
            }
          }
          this.#setState(state);
          thread = await this.#commit(state, history, baseRevisionId, thread);
          baseRevisionId = history.revisionId;
          this.#opts.onCheckpoint?.(state);
          if (r.suspend) {
            const token = newId();
            state = {
              ...state,
              status: 'suspended',
              suspendedOn: {
                token,
                reason: r.suspend.message,
                payload: r.suspend.payload,
              },
            };
            this.#setState(state);
            thread = await this.#commit(state, history, baseRevisionId, thread);
            baseRevisionId = history.revisionId;
            return {
              runId: state.runId,
              status: 'suspended',
              state,
            };
          }
          if (r.done) {
            const text = extractText(history.render());
            state = {
              ...state,
              status: 'done',
              result: text,
            };
            this.#setState(state);
            await this.#commit(state, history, baseRevisionId, thread);
            return {
              runId: state.runId,
              status: 'done',
              state,
              text,
            };
          }
        }
      } finally {
        execution.close();
      }
    });
  }
  async #loadHistory(revisionId: string): Promise<MessageHistory> {
    const history = await loadConversationHistory(this.#opts.store, revisionId);
    if (!history) throw new Error(`History revision ${revisionId} not found`);
    return history;
  }
  async #loadThread(): Promise<ThreadState> {
    const loaded = await loadConversationThread(this.#opts.store, this.#threadId);
    if (loaded) return loaded;
    const now = Date.now();
    return {
      threadId: this.#threadId,
      createdAt: now,
      updatedAt: now,
    };
  }
  async #loadExpectedThread(expectedRevisionId?: string): Promise<ThreadState> {
    const thread = await this.#loadThread();
    const expected = expectedRevisionId ?? null;
    const actual = thread.historyRevisionId ?? null;
    if (actual !== expected) {
      throw new SessionConflictError(thread.threadId, expected, actual);
    }
    return thread;
  }
  async #commit(
    state: RunState,
    history: MessageHistory,
    baseRevisionId?: string,
    thread?: ThreadState,
  ): Promise<ThreadState> {
    const now = Date.now();
    const nextThread: ThreadState = {
      threadId: thread?.threadId ?? state.threadId,
      createdAt: thread?.createdAt ?? now,
      updatedAt: now,
      historyRevisionId: history.revisionId,
    };
    const nextState = {
      ...state,
      historyRevisionId: history.revisionId,
    };
    this.#setState(nextState);
    await commitAgentSession(this.#opts.store, {
      run: nextState,
      thread: nextThread,
      history,
      expectedThreadRevisionId: thread?.historyRevisionId ?? null,
      ...(baseRevisionId !== undefined ? { baseRevisionId } : {}),
    });
    return nextThread;
  }
}
/**
 * Create a durable `Session`.
 *
 * The factory for the `Session` class, whose constructor is private. Pass a
 * `threadId` to continue an existing conversation thread; omit it to start a
 * fresh one.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 * import { sqliteStore } from 'fino:store';
 * import { session } from 'fino:ai/session';
 *
 * const store = await sqliteStore({ path: './runs.db' });
 * const sess = session({
 *   store,
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 *   threadId: 'customer-123',
 * });
 * const r = await sess.start('Where did we leave off?');
 * ```
 */
export function session(opts: SessionOptions): Session {
  return new Session(opts);
}
