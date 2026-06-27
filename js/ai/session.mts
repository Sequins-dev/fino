/**
 * Durable agent sessions with checkpointed history revisions.
 *
 * A `Session` runs an already-configured `Agent` against a `CheckpointStore`.
 * Checkpoints store run metadata and the current `MessageHistory` revision id;
 * message entries and revisions are persisted through the store's history
 * methods instead of being duplicated into each run state.
 */

import { Database } from 'fino:database/sqlite';
import { SuspendSignal, runContext } from 'fino:ai/runtime';
import type { AgentState, StepResult } from 'fino:ai/runtime';
import type { Agent } from 'fino:ai/agent';
import type { ModelMessage, Usage } from 'fino:ai/model';
import type { Memory } from 'fino:ai/memory';
import { MessageHistory } from 'fino:ai/context';
import type { HistoryStore, MessageHistoryEntry, MessageHistoryRevision, MessageHistorySnapshot } from 'fino:ai/context';

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
  error?: { message: string; stack?: string };
}

/**
 * Store for run checkpoints and immutable history revisions.
 */
export interface CheckpointStore extends HistoryStore {
  save(s: RunState): Promise<void>;
  load(runId: string): Promise<RunState | null>;
  list(filter?: { threadId?: string }): Promise<RunState[]>;
  delete(runId: string): Promise<void>;
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
 * Options for creating a `Session`.
 */
export interface SessionOptions {
  store: CheckpointStore;
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
      for (const part of c as Array<{ type: string; text?: string }>) {
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
      ctx.recalled.map((hit, i) => {
        const metadata = hit.metadata ? `\nmetadata: ${JSON.stringify(hit.metadata)}` : '';
        return `${i + 1}. ${hit.text}${metadata}`;
      }).join('\n\n'),
    );
  }
  if (sections.length === 0) return null;
  return {
    role: 'system',
    content: `[Memory context]\n${sections.join('\n\n')}`,
  };
}

async function historyFromMessages(messages: ModelMessage[], store?: HistoryStore): Promise<MessageHistory> {
  let history = new MessageHistory({ store });
  for (const msg of messages) history = await history.append(msg);
  return history;
}

async function forkHistoryFromState(state: RunState, store: HistoryStore): Promise<MessageHistory> {
  if (!state.historyRevisionId) throw new Error(`Run ${state.runId} has no history revision`);
  return (await MessageHistory.load(store, state.historyRevisionId)).fork();
}

async function driveHistoryFromState(state: RunState, store: HistoryStore): Promise<MessageHistory> {
  if (!state.historyRevisionId) throw new Error(`Run ${state.runId} has no history revision`);
  return MessageHistory.load(store, state.historyRevisionId);
}

/**
 * Sqlite-backed checkpoint and history store.
 */
export class SqliteCheckpointStore implements CheckpointStore {
  #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static async open(path: string, opts?: { fs?: object }): Promise<SqliteCheckpointStore> {
    const db = await Database.open(path, { fs: opts?.fs as never });
    await db.exec(
      `CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id)`);
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
    return new SqliteCheckpointStore(db);
  }

  async saveEntry(entry: MessageHistoryEntry): Promise<void> {
    const stmt = this.#db.prepare(`INSERT OR IGNORE INTO history_entries(id, entry) VALUES(?, ?)`);
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

  async save(s: RunState): Promise<void> {
    await this.#db.transaction(async () => {
      const stmt = this.#db.prepare(
        `INSERT INTO runs(run_id, thread_id, status, step_index, state, updated_at)
         VALUES(:run_id, :thread_id, :status, :step_index, :state, :updated_at)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           step_index = excluded.step_index,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      );
      try {
        await stmt.run({
          run_id: s.runId,
          thread_id: s.threadId,
          status: s.status,
          step_index: s.stepIndex,
          state: JSON.stringify(s),
          updated_at: Date.now(),
        });
      } finally {
        stmt.finalize();
      }
    });
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

  async list(filter: { threadId?: string } = {}): Promise<RunState[]> {
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

  private constructor(opts: SessionOptions, loaded?: RunState) {
    this.#opts = opts;
    this.#threadId = loaded?.threadId ?? opts.threadId ?? newId();
    this.#state = loaded;
  }

  get state(): RunState | undefined {
    return this.#state;
  }

  /**
   * Resume a non-suspended run from its persisted checkpoint.
   */
  static async resume(opts: SessionOptions & { runId: string }): Promise<RunResult> {
    const loaded = await opts.store.load(opts.runId);
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
    return sess.#drive({ ...loaded, status: 'running' });
  }

  /**
   * Resume a suspended run from durable state.
   *
   * Use this from stateless adapters such as HTTP channels where the original
   * `Session` instance may no longer be in memory. The token is checked against
   * the stored run and remains single-use.
   */
  static async resumeSuspended(
    opts: SessionOptions & { runId: string; resumeToken: string; value: unknown; signal?: AbortSignal },
  ): Promise<RunResult> {
    const loaded = await opts.store.load(opts.runId);
    if (!loaded) throw new Error(`Run ${opts.runId} not found`);
    const sess = new Session(opts, loaded);
    return sess.resume(opts.resumeToken, opts.value, { signal: opts.signal });
  }

  /**
   * Start a new run in this session thread.
   */
  async start(
    input: string | { messages: ModelMessage[] },
    opts?: { runId?: string; signal?: AbortSignal },
  ): Promise<RunResult> {
    const runId = opts?.runId ?? newId();
    const signal = opts?.signal;
    const inputMessages: ModelMessage[] =
      typeof input === 'string' ? [{ role: 'user', content: input }] : input.messages;

    let messages: ModelMessage[] = inputMessages;
    if (this.#opts.memory) {
      const ctx = await this.#opts.memory.recall({ text: inputText(inputMessages) });
      const historyMsgs = ctx.messages.map((m) => ({
        role: m.role as ModelMessage['role'],
        content: m.content as ModelMessage['content'],
      }));
      const memoryContext = memoryContextMessage(ctx);
      messages = [...historyMsgs, ...(memoryContext ? [memoryContext] : []), ...inputMessages];
      for (const msg of inputMessages) {
        await this.#opts.memory.append({
          role: msg.role,
          content: msg.content,
        });
      }
    } else {
      const priorRuns = await this.#opts.store.list({ threadId: this.#threadId });
      const lastDone = priorRuns.find((r) => r.status === 'done');
      if (lastDone?.historyRevisionId) {
        const priorHistory = await MessageHistory.load(this.#opts.store, lastDone.historyRevisionId);
        messages = [...priorHistory.render(), ...inputMessages];
      }
    }

    const history = await historyFromMessages(messages, this.#opts.store);

    const state: RunState = {
      runId,
      threadId: this.#threadId,
      status: 'running',
      stepIndex: 0,
      historyRevisionId: history.revisionId,
      usage: { inputTokens: 0, outputTokens: 0 },
      scratch: {},
    };

    this.#state = state;
    await this.#opts.store.save(state);
    return this.#drive(state, signal);
  }

  /**
   * Resume the current suspended run with external input.
   */
  async resume(
    resumeToken: string,
    value: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<RunResult> {
    if (!this.#state) throw new Error('No state; call start() first');
    if (this.#state.status !== 'suspended') {
      throw new Error(`Run is not suspended (currently: ${this.#state.status})`);
    }
    if (this.#state.suspendedOn?.token !== resumeToken) {
      throw new Error('Invalid or expired resume token');
    }

    const injected: ModelMessage = {
      role: 'user',
      content: typeof value === 'string' ? value : JSON.stringify(value),
    };
    const history = await (await driveHistoryFromState(this.#state, this.#opts.store)).append(injected);

    const state: RunState = {
      ...this.#state,
      status: 'running',
      suspendedOn: undefined,
      historyRevisionId: history.revisionId,
    };

    return this.#drive(state, opts?.signal);
  }

  /**
   * Suspend execution from inside workflow or application code.
   */
  suspend(opts?: { reason?: string; payload?: unknown }): never {
    throw new SuspendSignal(opts?.reason, opts?.payload);
  }

  /**
   * Fork the current history into a new thread and start a new run.
   */
  async fork(
    input: string | { messages: ModelMessage[] },
    opts?: { runId?: string; signal?: AbortSignal },
  ): Promise<RunResult> {
    if (!this.#state) throw new Error('No state; call start() first');

    let history = await forkHistoryFromState(this.#state, this.#opts.store);

    const inputMessages: ModelMessage[] =
      typeof input === 'string' ? [{ role: 'user', content: input }] : input.messages;

    for (const msg of inputMessages) {
      history = await history.append(msg);
    }

    const forkedRunId = opts?.runId ?? newId();
    const forkedState: RunState = {
      runId: forkedRunId,
      threadId: newId(),
      status: 'running',
      stepIndex: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      historyRevisionId: history.revisionId,
      scratch: {},
    };

    const forkedSession = new Session(this.#opts, forkedState);
    await this.#opts.store.save(forkedState);
    return forkedSession.#drive(forkedState, opts?.signal);
  }

  /**
   * Mark the current run as cancelled.
   */
  async cancel(): Promise<void> {
    if (!this.#state) return;
    const state: RunState = { ...this.#state, status: 'cancelled' };
    this.#state = state;
    await this.#opts.store.save(state);
  }

  async #drive(state: RunState, signal?: AbortSignal): Promise<RunResult> {
    const runCtxValue = { runId: state.runId, stepIndex: state.stepIndex, signal };
    return runContext.runWithValue(runCtxValue, async () => {
      let stepsThisCall = 0;
      let history = await driveHistoryFromState(state, this.#opts.store);

      while (true) {
        runCtxValue.stepIndex = state.stepIndex;

        if (stepsThisCall++ >= MAX_DRIVE_STEPS) {
          state = {
            ...state,
            status: 'error',
            error: { message: 'Session exceeded maximum step count' },
          };
          this.#state = state;
          await this.#opts.store.save(state);
          throw new Error('Session exceeded maximum step count');
        }

        const hState: AgentState = {
          messages: history.render(),
          stepIndex: state.stepIndex,
          usage: state.usage,
          cost: state.cost,
          history,
          signal,
        };

        let r: StepResult;
        try {
          r = await this.#opts.agent.step(hState);
        } catch (err) {
          const e = err as Error;
          if (e.name === 'AbortError') {
            state = { ...state, status: 'cancelled' };
            this.#state = state;
            await this.#opts.store.save(state);
            throw err;
          }
          state = {
            ...state,
            status: 'error',
            error: { message: e.message, stack: e.stack },
          };
          this.#state = state;
          await this.#opts.store.save(state);
          throw err;
        }

        const prevLen = history.render().length;
        history = r.state.history ?? history;
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
            await this.#opts.memory.append({ role: msg.role, content: msg.content });
          }
        }

        this.#state = state;
        await this.#opts.store.save(state);
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
          this.#state = state;
          await this.#opts.store.save(state);
          return { runId: state.runId, status: 'suspended', state };
        }

        if (r.done) {
          const text = extractText(history.render());
          state = { ...state, status: 'done', result: text };
          this.#state = state;
          await this.#opts.store.save(state);
          return { runId: state.runId, status: 'done', state, text };
        }
      }
    });
  }
}

/**
 * Create a durable `Session`.
 */
export function session(opts: SessionOptions): Session {
  return new Session(opts);
}
