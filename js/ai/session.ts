/**
* fino:ai/session — durable agent runs with session-owned history persistence.
*
* `Session` runs an already-configured `Agent` against a `SessionStore`.
* Use it when an agent run must survive process restarts, pause for external
* input, continue a thread across multiple requests, or fork from an existing
* conversation state.
*
* ## Storage model
*
* `MessageHistory` is an immutable in-memory graph. A `SessionStore` is the
* durable boundary: it commits new history graph nodes, the current run state,
* and the thread head revision atomically. `RunState` and `ThreadState` store
* only revision ids, never rendered message arrays or snapshot blobs.
*
* `Session.start()` creates a new run in the session thread, `resume()` injects
* external input into a suspended run, and `fork()` creates a new thread from
* the current history revision. `Session.resume()` and `Session.resumeSuspended()`
* are for stateless adapters that need to continue from persisted state.
*
* ```ts no_run
* import { agent } from 'fino:ai/agent';
* import { openai } from 'fino:ai/model';
* import { session, SqliteSessionStore } from 'fino:ai/session';
*
* const store = await SqliteSessionStore.open('./runs.db');
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
import { Database } from 'fino:database/sqlite';
import { SuspendSignal, runContext } from 'fino:ai/runtime';
import { createSignal } from 'fino:signals';
import type { AgentState, StepResult, ToolApprovalRequest } from 'fino:ai/runtime';
import type { Agent } from 'fino:ai/agent';
import type { ModelMessage, Usage } from 'fino:ai/model';
import type { Memory } from 'fino:ai/memory';
import { MessageHistory } from 'fino:ai/context';
import type { MessageHistoryEntry, MessageHistoryRevision, MessageHistorySnapshot } from 'fino:ai/context';
import type { ReadonlySignal } from 'fino:signals';
/**
* Durable lifecycle state for a session run.
*/
export type RunStatus = 'running' | 'suspended' | 'done' | 'error' | 'cancelled';
/**
* Suspension metadata persisted with a paused run.
*/
export interface SuspendReason {
  token: string;
  reason?: string;
  payload?: unknown;
}
/**
* Durable checkpoint state for one run.
*/
export interface RunState {
  runId: string;
  threadId: string;
  status: RunStatus;
  stepIndex: number;
  usage: Usage;
  cost?: number;
  historyRevisionId?: string;
  suspendedOn?: SuspendReason;
  scratch: Record<string, unknown>;
  result?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
}
/**
* Durable pointer for one conversation thread.
*/
export interface ThreadState {
  threadId: string;
  historyRevisionId?: string;
  createdAt: number;
  updatedAt: number;
}
/**
* Durable session boundary for runs, threads, and immutable history graphs.
*/
export interface SessionStore {
  loadRun(runId: string): Promise<RunState | null>;
  listRuns(filter?: {
    threadId?: string;
  }): Promise<RunState[]>;
  deleteRun(runId: string): Promise<void>;
  loadThread(threadId: string): Promise<ThreadState | null>;
  loadHistory(revisionId: string): Promise<MessageHistory | null>;
  commitSession(args: {
    run: RunState;
    thread: ThreadState;
    history: MessageHistory;
    baseRevisionId?: string;
  }): Promise<void>;
}
/**
* Result returned by session start, resume, and fork operations.
*/
export interface RunResult {
  runId: string;
  status: RunStatus;
  state: RunState;
  text?: string;
}
/**
* Decision supplied when resuming a tool approval suspension.
*/
export type ToolApprovalDecision = {
  approved: true;
  approval?: unknown;
} | {
  approved: false;
  reason?: string;
};
/**
* Options for creating a `Session`.
*/
export interface SessionOptions {
  store: SessionStore;
  agent: Agent;
  memory?: Memory;
  threadId?: string;
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
    sections.push('Semantic recall:\n' + ctx.recalled.map((hit, i) => {
      const metadata = hit.metadata ? `\nmetadata: ${JSON.stringify(hit.metadata)}` : '';
      return `${i + 1}. ${hit.text}${metadata}`;
    }).join('\n\n'));
  }
  if (sections.length === 0) return null;
  return {
    role: 'system',
    content: `[Memory context]\n${sections.join('\n\n')}`
  };
}
async function historyFromMessages(messages: ModelMessage[]): Promise<MessageHistory> {
  let history = new MessageHistory();
  for (const msg of messages) history = await history.append(msg);
  return history;
}
async function forkHistoryFromState(state: RunState, store: SessionStore): Promise<MessageHistory> {
  if (!state.historyRevisionId) throw new Error(`Run ${state.runId} has no history revision`);
  const history = await store.loadHistory(state.historyRevisionId);
  if (!history) throw new Error(`History revision ${state.historyRevisionId} not found`);
  return history.fork();
}
async function driveHistoryFromState(state: RunState, store: SessionStore): Promise<MessageHistory> {
  if (!state.historyRevisionId) throw new Error(`Run ${state.runId} has no history revision`);
  const history = await store.loadHistory(state.historyRevisionId);
  if (!history) throw new Error(`History revision ${state.historyRevisionId} not found`);
  return history;
}
function cloneRunState(state: RunState): RunState {
  return JSON.parse(JSON.stringify(state)) as RunState;
}
function cloneThreadState(thread: ThreadState): ThreadState {
  return { ...thread };
}
function isToolApprovalRequest(value: unknown): value is ToolApprovalRequest {
  return typeof value === 'object' && value !== null && (value as {
    type?: unknown;
  }).type === 'tool_approval' && typeof (value as {
    toolCallId?: unknown;
  }).toolCallId === 'string' && typeof (value as {
    toolName?: unknown;
  }).toolName === 'string';
}
function validateCommit(args: {
  run: RunState;
  thread: ThreadState;
  history: MessageHistory;
}): void {
  if (args.run.historyRevisionId !== undefined && args.run.historyRevisionId !== args.history.revisionId) {
    throw new Error(`Run ${args.run.runId} points at history revision ${args.run.historyRevisionId}, not committed revision ${args.history.revisionId}`);
  }
  if (args.thread.historyRevisionId !== undefined && args.thread.historyRevisionId !== args.history.revisionId) {
    throw new Error(`Thread ${args.thread.threadId} points at history revision ${args.thread.historyRevisionId}, not committed revision ${args.history.revisionId}`);
  }
}
/**
* In-memory session store for tests and simple single-process agents.
*/
export class InMemorySessionStore implements SessionStore {
  #runs = new Map<string, RunState>();
  #threads = new Map<string, ThreadState>();
  #entries = new Map<string, MessageHistoryEntry>();
  #revisions = new Map<string, MessageHistoryRevision>();
  async loadRun(runId: string): Promise<RunState | null> {
    const run = this.#runs.get(runId);
    return run ? cloneRunState(run) : null;
  }
  async listRuns(filter: {
    threadId?: string;
  } = {}): Promise<RunState[]> {
    return [...this.#runs.values()].filter((run) => filter.threadId === undefined || run.threadId === filter.threadId).map(cloneRunState);
  }
  async deleteRun(runId: string): Promise<void> {
    this.#runs.delete(runId);
  }
  async loadThread(threadId: string): Promise<ThreadState | null> {
    const thread = this.#threads.get(threadId);
    return thread ? cloneThreadState(thread) : null;
  }
  async loadHistory(revisionId: string): Promise<MessageHistory | null> {
    const revision = this.#revisions.get(revisionId);
    if (!revision) return null;
    const revisions: MessageHistoryRevision[] = [];
    let current: MessageHistoryRevision | undefined = revision;
    while (current) {
      revisions.push({
        ...current,
        entryIds: [...current.entryIds]
      });
      current = current.parent ? this.#revisions.get(current.parent) : undefined;
    }
    const needed = new Set<string>();
    for (const rev of revisions) {
      for (const entryId of rev.entryIds) needed.add(entryId);
    }
    const entries = [...needed].map((entryId) => this.#entries.get(entryId)).filter((entry): entry is MessageHistoryEntry => entry !== undefined).map((entry) => JSON.parse(JSON.stringify(entry)) as MessageHistoryEntry);
    return MessageHistory.fromSnapshot({
      entries,
      revisions,
      head: revisionId
    });
  }
  async commitSession(args: {
    run: RunState;
    thread: ThreadState;
    history: MessageHistory;
    baseRevisionId?: string;
  }): Promise<void> {
    validateCommit(args);
    const delta = args.history.changesSince(args.baseRevisionId);
    for (const entry of delta.entries) {
      if (!this.#entries.has(entry.id)) this.#entries.set(entry.id, JSON.parse(JSON.stringify(entry)) as MessageHistoryEntry);
    }
    for (const revision of delta.revisions) {
      if (!this.#revisions.has(revision.id)) this.#revisions.set(revision.id, {
        ...revision,
        entryIds: [...revision.entryIds]
      });
    }
    this.#runs.set(args.run.runId, cloneRunState(args.run));
    this.#threads.set(args.thread.threadId, cloneThreadState(args.thread));
  }
  async save(s: RunState): Promise<void> {
    this.#runs.set(s.runId, cloneRunState(s));
  }
  async load(runId: string): Promise<RunState | null> {
    return this.loadRun(runId);
  }
  async list(filter: {
    threadId?: string;
  } = {}): Promise<RunState[]> {
    return this.listRuns(filter);
  }
  async delete(runId: string): Promise<void> {
    return this.deleteRun(runId);
  }
}
/**
* SQLite-backed session store.
*/
export class SqliteSessionStore implements SessionStore {
  #db: Database;
  private constructor(db: Database) {
    this.#db = db;
  }
  static async open(path: string, opts?: {
    fs?: object;
  }): Promise<SqliteSessionStore> {
    const db = await Database.open(path, { fs: opts?.fs as never });
    await db.exec(`CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        history_revision_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS history_entries (
        id TEXT PRIMARY KEY,
        entry TEXT NOT NULL
      )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS history_revisions (
        id TEXT PRIMARY KEY,
        parent TEXT,
        entry_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        operation TEXT
      )`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_history_revisions_parent ON history_revisions(parent)`);
    return new SqliteSessionStore(db);
  }
  async #saveEntry(entry: MessageHistoryEntry): Promise<void> {
    const stmt = this.#db.prepare(`INSERT OR IGNORE INTO history_entries(id, entry) VALUES(?, ?)`);
    try {
      await stmt.run(entry.id, JSON.stringify(entry));
    } finally {
      stmt.finalize();
    }
  }
  async #saveRevision(revision: MessageHistoryRevision): Promise<void> {
    const stmt = this.#db.prepare(`INSERT OR IGNORE INTO history_revisions(id, parent, entry_ids, created_at, operation)
       VALUES(?, ?, ?, ?, ?)`);
    try {
      await stmt.run(revision.id, revision.parent ?? null, JSON.stringify(revision.entryIds), revision.createdAt, revision.operation !== undefined ? JSON.stringify(revision.operation) : null);
    } finally {
      stmt.finalize();
    }
  }
  async #loadSnapshot(id: string): Promise<MessageHistorySnapshot | null> {
    const revStmt = this.#db.prepare(`WITH RECURSIVE lineage(id, parent, entry_ids, created_at, operation) AS (
         SELECT id, parent, entry_ids, created_at, operation FROM history_revisions WHERE id = ?
         UNION ALL
         SELECT r.id, r.parent, r.entry_ids, r.created_at, r.operation
         FROM history_revisions r JOIN lineage l ON r.id = l.parent
       )
       SELECT id, parent, entry_ids, created_at, operation FROM lineage`);
    try {
      const rows = await revStmt.all(id);
      if (rows.length === 0) return null;
      const revisions = rows.map((row) => ({
        id: row.id as string,
        ...row.parent !== null ? { parent: row.parent as string } : {},
        entryIds: JSON.parse(row.entry_ids as string) as string[],
        createdAt: row.created_at as number,
        ...row.operation !== null ? { operation: JSON.parse(row.operation as string) } : {}
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
      return {
        entries,
        revisions,
        head: id
      };
    } finally {
      revStmt.finalize();
    }
  }
  async loadHistory(revisionId: string): Promise<MessageHistory | null> {
    const snapshot = await this.#loadSnapshot(revisionId);
    return snapshot ? MessageHistory.fromSnapshot(snapshot) : null;
  }
  async loadThread(threadId: string): Promise<ThreadState | null> {
    const stmt = this.#db.prepare(`SELECT thread_id, history_revision_id, created_at, updated_at FROM threads WHERE thread_id = ?`);
    try {
      const row = await stmt.get(threadId);
      if (!row) return null;
      return {
        threadId: row.thread_id as string,
        ...row.history_revision_id !== null ? { historyRevisionId: row.history_revision_id as string } : {},
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number
      };
    } finally {
      stmt.finalize();
    }
  }
  async commitSession(args: {
    run: RunState;
    thread: ThreadState;
    history: MessageHistory;
    baseRevisionId?: string;
  }): Promise<void> {
    validateCommit(args);
    await this.#db.transaction(async () => {
      const delta = args.history.changesSince(args.baseRevisionId);
      for (const entry of delta.entries) await this.#saveEntry(entry);
      for (const revision of delta.revisions) await this.#saveRevision(revision);
      const runStmt = this.#db.prepare(`INSERT INTO runs(run_id, thread_id, status, step_index, state, updated_at)
         VALUES(:run_id, :thread_id, :status, :step_index, :state, :updated_at)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           step_index = excluded.step_index,
           state = excluded.state,
           updated_at = excluded.updated_at`);
      try {
        await runStmt.run({
          run_id: args.run.runId,
          thread_id: args.run.threadId,
          status: args.run.status,
          step_index: args.run.stepIndex,
          state: JSON.stringify(args.run),
          updated_at: Date.now()
        });
      } finally {
        runStmt.finalize();
      }
      const threadStmt = this.#db.prepare(`INSERT INTO threads(thread_id, history_revision_id, created_at, updated_at)
         VALUES(:thread_id, :history_revision_id, :created_at, :updated_at)
         ON CONFLICT(thread_id) DO UPDATE SET
           history_revision_id = excluded.history_revision_id,
           updated_at = excluded.updated_at`);
      try {
        await threadStmt.run({
          thread_id: args.thread.threadId,
          history_revision_id: args.thread.historyRevisionId ?? null,
          created_at: args.thread.createdAt,
          updated_at: args.thread.updatedAt
        });
      } finally {
        threadStmt.finalize();
      }
    });
  }
  async save(s: RunState): Promise<void> {
    await this.#db.transaction(async () => {
      const stmt = this.#db.prepare(`INSERT INTO runs(run_id, thread_id, status, step_index, state, updated_at)
         VALUES(:run_id, :thread_id, :status, :step_index, :state, :updated_at)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           step_index = excluded.step_index,
           state = excluded.state,
           updated_at = excluded.updated_at`);
      try {
        await stmt.run({
          run_id: s.runId,
          thread_id: s.threadId,
          status: s.status,
          step_index: s.stepIndex,
          state: JSON.stringify(s),
          updated_at: Date.now()
        });
      } finally {
        stmt.finalize();
      }
    });
  }
  async loadRun(runId: string): Promise<RunState | null> {
    return this.load(runId);
  }
  async load(runId: string): Promise<RunState | null> {
    const stmt = this.#db.prepare(`SELECT state FROM runs WHERE run_id = ?`);
    try {
      const row = await stmt.get(runId);
      if (!row) return null;
      return JSON.parse(row.state as string) as RunState;
    } finally {
      stmt.finalize();
    }
  }
  async listRuns(filter: {
    threadId?: string;
  } = {}): Promise<RunState[]> {
    return this.list(filter);
  }
  async list(filter: {
    threadId?: string;
  } = {}): Promise<RunState[]> {
    let sql = `SELECT state FROM runs`;
    const params: unknown[] = [];
    if (filter.threadId !== undefined) {
      sql += ` WHERE thread_id = ?`;
      params.push(filter.threadId);
    }
    sql += ` ORDER BY updated_at DESC`;
    const stmt = this.#db.prepare(sql);
    try {
      const rows = await stmt.all(...params);
      return rows.map((r) => JSON.parse(r.state as string) as RunState);
    } finally {
      stmt.finalize();
    }
  }
  async deleteRun(runId: string): Promise<void> {
    return this.delete(runId);
  }
  async delete(runId: string): Promise<void> {
    const stmt = this.#db.prepare(`DELETE FROM runs WHERE run_id = ?`);
    try {
      await stmt.run(runId);
    } finally {
      stmt.finalize();
    }
  }
  async close(): Promise<void> {
    await this.#db.close();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
const MAX_DRIVE_STEPS = 100;
/**
* Durable runner for an agent thread.
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
    this.#stateSignal = createSignal<RunState | undefined>(loaded ? cloneRunState(loaded) : undefined);
  }
  get state(): RunState | undefined {
    return this.#state;
  }
  /**
  * Watch the latest run state held by this session instance.
  *
  * The signal is `undefined` until a run is started or loaded. Once a run
  * exists, it retains the latest checkpoint or terminal state for reactive UI
  * consumers in this realm.
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
  */
  static async resume(opts: SessionOptions & {
    runId: string;
  }): Promise<RunResult> {
    const loaded = await opts.store.loadRun(opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    if (loaded.status === 'done' || loaded.status === 'cancelled') {
      return {
        runId: loaded.runId,
        status: loaded.status,
        state: loaded,
        text: typeof loaded.result === 'string' ? loaded.result : undefined
      };
    }
    if (loaded.status === 'suspended') {
      throw new Error(`Run ${opts.runId} is suspended; use session instance resume(token, value) instead`);
    }
    const sess = new Session(opts, loaded);
    return sess.#drive({
      ...loaded,
      status: 'running'
    });
  }
  /**
  * Resume a suspended run from durable state.
  *
  * Use this from stateless adapters such as HTTP channels where the original
  * `Session` instance may no longer be in memory. The token is checked against
  * the stored run and remains single-use.
  */
  static async resumeSuspended(opts: SessionOptions & {
    runId: string;
    resumeToken: string;
    value: unknown;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const loaded = await opts.store.loadRun(opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.resume(opts.resumeToken, opts.value, { signal: opts.signal });
  }
  /**
  * Approve a persisted tool approval suspension after process restart.
  */
  static async approveSuspended(opts: SessionOptions & {
    runId: string;
    resumeToken: string;
    approval?: unknown;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const loaded = await opts.store.loadRun(opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.approveTool(opts.resumeToken, {
      approval: opts.approval,
      signal: opts.signal
    });
  }
  /**
  * Reject a persisted tool approval suspension after process restart.
  */
  static async rejectSuspended(opts: SessionOptions & {
    runId: string;
    resumeToken: string;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const loaded = await opts.store.loadRun(opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.rejectTool(opts.resumeToken, opts.reason, { signal: opts.signal });
  }
  /**
  * Start a new run in this session thread.
  */
  async start(input: string | {
    messages: ModelMessage[];
  }, opts?: {
    runId?: string;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const runId = opts?.runId ?? newId();
    const signal = opts?.signal;
    const inputMessages: ModelMessage[] = typeof input === 'string' ? [{
      role: 'user',
      content: input
    }] : input.messages;
    const thread = await this.#loadThread();
    let history = thread.historyRevisionId ? await this.#loadHistory(thread.historyRevisionId) : new MessageHistory();
    const baseRevisionId = thread.historyRevisionId;
    let messages: ModelMessage[] = [...history.render(), ...inputMessages];
    if (this.#opts.memory) {
      const ctx = await this.#opts.memory.recall({ text: inputText(inputMessages) });
      const historyMsgs = ctx.messages.map((m) => ({
        role: m.role as ModelMessage['role'],
        content: m.content as ModelMessage['content']
      }));
      const memoryContext = memoryContextMessage(ctx);
      for (const msg of [...historyMsgs, ...memoryContext ? [memoryContext] : []]) {
        history = await history.append(msg);
      }
      messages = [...history.render(), ...inputMessages];
      for (const msg of inputMessages) {
        await this.#opts.memory.append({
          role: msg.role,
          content: msg.content
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
        outputTokens: 0
      },
      scratch: {}
    };
    this.#setState(state);
    return this.#drive(state, signal, history, messages, baseRevisionId);
  }
  /**
  * Resume the current suspended run with external input.
  */
  async resume(resumeToken: string, value: unknown, opts?: {
    signal?: AbortSignal;
  }): Promise<RunResult> {
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
    const state: RunState = {
      ...this.#state,
      status: 'running',
      suspendedOn: undefined,
      historyRevisionId: history.revisionId
    };
    const injected: ModelMessage = {
      role: 'user',
      content: typeof value === 'string' ? value : JSON.stringify(value)
    };
    return this.#drive(state, opts?.signal, history, [...history.render(), injected], baseRevisionId);
  }
  /**
  * Approve a pending approval-required tool call and continue the run.
  */
  approveTool(resumeToken: string, opts: {
    approval?: unknown;
    signal?: AbortSignal;
  } = {}): Promise<RunResult> {
    return this.#decideTool(resumeToken, {
      approved: true,
      approval: opts.approval
    }, opts.signal);
  }
  /**
  * Reject a pending approval-required tool call and continue the run with an
  * error tool result visible to the model.
  */
  rejectTool(resumeToken: string, reason?: string, opts: {
    signal?: AbortSignal;
  } = {}): Promise<RunResult> {
    return this.#decideTool(resumeToken, {
      approved: false,
      reason
    }, opts.signal);
  }
  async #decideTool(resumeToken: string, decision: ToolApprovalDecision, signal?: AbortSignal): Promise<RunResult> {
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
    const state: RunState = {
      ...this.#state,
      status: 'running',
      suspendedOn: undefined,
      historyRevisionId: history.revisionId
    };
    const approvalValue = decision.approved ? {
      approved: true,
      approval: decision.approval
    } : {
      approved: false,
      reason: decision.reason ?? 'not approved'
    };
    const approval = await this.#opts.agent.approveTool({
      messages: history.render(),
      stepIndex: state.stepIndex,
      usage: state.usage,
      cost: state.cost,
      history,
      signal
    }, request, approvalValue);
    const approvedHistory = approval.state.history ?? history;
    const approvedState: RunState = {
      ...state,
      stepIndex: approval.state.stepIndex,
      usage: approval.state.usage,
      cost: approval.state.cost,
      historyRevisionId: approvedHistory.revisionId
    };
    this.#setState(approvedState);
    const thread = await this.#commit(approvedState, approvedHistory, baseRevisionId);
    return this.#drive(approvedState, signal, approvedHistory, approvedHistory.render(), approvedHistory.revisionId, thread);
  }
  /**
  * Suspend execution from inside workflow or application code.
  */
  suspend(opts?: {
    reason?: string;
    payload?: unknown;
  }): never {
    throw new SuspendSignal(opts?.reason, opts?.payload);
  }
  /**
  * Fork the current history into a new thread and start a new run.
  */
  async fork(input: string | {
    messages: ModelMessage[];
  }, opts?: {
    runId?: string;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    if (!this.#state) throw new Error('No state; call start() first');
    const parentRevisionId = this.#state.historyRevisionId;
    let history = await forkHistoryFromState(this.#state, this.#opts.store);
    const inputMessages: ModelMessage[] = typeof input === 'string' ? [{
      role: 'user',
      content: input
    }] : input.messages;
    const forkedRunId = opts?.runId ?? newId();
    const now = Date.now();
    const forkedState: RunState = {
      runId: forkedRunId,
      threadId: newId(),
      status: 'running',
      stepIndex: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0
      },
      historyRevisionId: history.revisionId,
      scratch: {}
    };
    const forkedSession = new Session(this.#opts, forkedState);
    forkedSession.#threadId = forkedState.threadId;
    return forkedSession.#drive(forkedState, opts?.signal, history, [...history.render(), ...inputMessages], parentRevisionId, {
      threadId: forkedState.threadId,
      createdAt: now,
      updatedAt: now
    });
  }
  /**
  * Mark the current run as cancelled.
  */
  async cancel(): Promise<void> {
    if (!this.#state) return;
    const state: RunState = {
      ...this.#state,
      status: 'cancelled'
    };
    this.#setState(state);
    const history = state.historyRevisionId ? await this.#opts.store.loadHistory(state.historyRevisionId) : null;
    if (history) {
      await this.#commit(state, history, state.historyRevisionId);
    }
  }
  async #drive(state: RunState, signal?: AbortSignal, initialHistory?: MessageHistory, initialMessages?: ModelMessage[], initialBaseRevisionId?: string, initialThread?: Partial<ThreadState> & {
    threadId: string;
  }): Promise<RunResult> {
    const runCtxValue = {
      runId: state.runId,
      stepIndex: state.stepIndex,
      signal
    };
    return runContext.runWithValue(runCtxValue, async () => {
      let stepsThisCall = 0;
      let history = initialHistory ?? await driveHistoryFromState(state, this.#opts.store);
      let pendingMessages = initialMessages;
      let baseRevisionId = initialBaseRevisionId ?? state.historyRevisionId;
      let thread = initialThread ? {
        threadId: initialThread.threadId,
        createdAt: initialThread.createdAt ?? Date.now(),
        updatedAt: initialThread.updatedAt ?? Date.now(),
        ...initialThread.historyRevisionId ? { historyRevisionId: initialThread.historyRevisionId } : {}
      } : await this.#loadThread();
      while (true) {
        runCtxValue.stepIndex = state.stepIndex;
        if (stepsThisCall++ >= MAX_DRIVE_STEPS) {
          state = {
            ...state,
            status: 'error',
            error: { message: 'Session exceeded maximum step count' }
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
          signal
        };
        let r: StepResult;
        try {
          r = await this.#opts.agent.step(hState);
        } catch (err) {
          const e = err as Error;
          if (e.name === 'AbortError') {
            state = {
              ...state,
              status: 'cancelled'
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
              stack: e.stack
            }
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
          historyRevisionId: history.revisionId
        };
        if (this.#opts.memory) {
          const newMsgs = history.render().slice(prevLen);
          for (const msg of newMsgs) {
            await this.#opts.memory.append({
              role: msg.role,
              content: msg.content
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
              payload: r.suspend.payload
            }
          };
          this.#setState(state);
          thread = await this.#commit(state, history, baseRevisionId, thread);
          baseRevisionId = history.revisionId;
          return {
            runId: state.runId,
            status: 'suspended',
            state
          };
        }
        if (r.done) {
          const text = extractText(history.render());
          state = {
            ...state,
            status: 'done',
            result: text
          };
          this.#setState(state);
          await this.#commit(state, history, baseRevisionId, thread);
          return {
            runId: state.runId,
            status: 'done',
            state,
            text
          };
        }
      }
    });
  }
  async #loadHistory(revisionId: string): Promise<MessageHistory> {
    const history = await this.#opts.store.loadHistory(revisionId);
    if (!history) throw new Error(`History revision ${revisionId} not found`);
    return history;
  }
  async #loadThread(): Promise<ThreadState> {
    const loaded = await this.#opts.store.loadThread(this.#threadId);
    if (loaded) return loaded;
    const now = Date.now();
    return {
      threadId: this.#threadId,
      createdAt: now,
      updatedAt: now
    };
  }
  async #commit(state: RunState, history: MessageHistory, baseRevisionId?: string, thread?: ThreadState): Promise<ThreadState> {
    const now = Date.now();
    const nextThread: ThreadState = {
      threadId: thread?.threadId ?? state.threadId,
      createdAt: thread?.createdAt ?? now,
      updatedAt: now,
      historyRevisionId: history.revisionId
    };
    const nextState = {
      ...state,
      historyRevisionId: history.revisionId
    };
    this.#setState(nextState);
    await this.#opts.store.commitSession({
      run: nextState,
      thread: nextThread,
      history,
      baseRevisionId
    });
    return nextThread;
  }
}
/**
* Create a durable `Session`.
*/
export function session(opts: SessionOptions): Session {
  return new Session(opts);
}
