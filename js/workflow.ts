/**
 * fino:workflow — local-first durable workflows for ordinary TypeScript code.
 *
 * Workflows are async functions that can checkpoint named steps, call reusable
 * activities, wait for timers, and wait for external signals. Use this module
 * when an operation must survive process restarts or span request boundaries,
 * without adopting a distributed worker platform.
 *
 * ## Execution model
 *
 * Workflow code may run more than once. Put external side effects,
 * nondeterministic values, and expensive operations inside `ctx.step()` or
 * `ctx.call()` so their results are saved and reused on resume. Ordinary
 * TypeScript control flow (`if`, loops, `Promise.all`) remains the workflow
 * structure.
 *
 * ```ts no_run
 * import { SqliteWorkflowStore, activity, workflow } from 'fino:workflow';
 *
 * const createTicket = activity({
 *   id: 'create-ticket',
 *   async run(input: { title: string }) {
 *     return { id: `ticket:${input.title}` };
 *   },
 * });
 *
 * const routeTicket = workflow({
 *   id: 'route-ticket',
 *   async run(ctx, input: { title: string }) {
 *     const ticket = await ctx.call(createTicket, input);
 *     const approved = await ctx.waitForSignal<boolean>('approval');
 *     return { ticketId: ticket.id, approved };
 *   },
 * });
 *
 * const store = await SqliteWorkflowStore.open('./workflow.db');
 * const run = await routeTicket.start({ title: 'refund request' }, { store });
 * await routeTicket.signal({ store, runId: run.runId, name: 'approval', payload: true });
 * ```
 */

import { Database } from 'fino:database/sqlite';
import { compile } from 'fino:validate';

let idCounter = 0;
function newId(): string {
  return `wf_${++idCounter}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Status persisted for a workflow run.
 */
export type WorkflowStatus = 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

/**
 * Retry policy used by `activity()` and `ctx.step()`.
 */
export interface WorkflowRetryOptions {
  readonly maxAttempts?: number;
}

/**
 * Durable wait recorded when a workflow pauses for time or an external signal.
 */
export type WorkflowWait =
  | { type: 'timer'; id: string; dueAt: number; stepIndex: number }
  | { type: 'signal'; id: string; name: string; stepIndex: number; timeoutAt?: number };

/**
 * One completed checkpointed call.
 */
export interface WorkflowStepState {
  readonly id: string;
  readonly status: 'done';
  readonly result?: unknown;
}

/**
 * Persisted workflow run state.
 */
export interface WorkflowState {
  runId: string;
  workflowId: string;
  status: WorkflowStatus;
  cursor: number;
  input: unknown;
  steps: WorkflowStepState[];
  state: Record<string, unknown>;
  signals: WorkflowSignal[];
  createdAt: number;
  updatedAt: number;
  key?: string;
  waitingOn?: WorkflowWait;
  result?: unknown;
  error?: { message: string; stack?: string };
}

/**
 * Signal delivered to a waiting workflow.
 */
export interface WorkflowSignal {
  name: string;
  payload: unknown;
  receivedAt: number;
}

/**
 * Store contract for durable workflow state.
 */
export interface WorkflowStore {
  save(state: WorkflowState): Promise<void>;
  load(runId: string): Promise<WorkflowState | null>;
  list(filter?: { workflowId?: string; status?: WorkflowStatus }): Promise<WorkflowState[]>;
  delete(runId: string): Promise<void>;
}

/**
 * In-memory store for tests and single-process prototypes.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  #runs = new Map<string, WorkflowState>();

  /**
   * Save or replace one workflow run state.
   */
  async save(state: WorkflowState): Promise<void> {
    this.#runs.set(state.runId, cloneState(state));
  }

  /**
   * Load a workflow run by id, or `null` when it is unknown.
   */
  async load(runId: string): Promise<WorkflowState | null> {
    const state = this.#runs.get(runId);
    return state ? cloneState(state) : null;
  }

  /**
   * List runs, newest first, optionally filtered by workflow id or status.
   */
  async list(filter: { workflowId?: string; status?: WorkflowStatus } = {}): Promise<WorkflowState[]> {
    const runs = [...this.#runs.values()]
      .filter((state) => filter.workflowId === undefined || state.workflowId === filter.workflowId)
      .filter((state) => filter.status === undefined || state.status === filter.status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return runs.map(cloneState);
  }

  /**
   * Delete one workflow run if it exists.
   */
  async delete(runId: string): Promise<void> {
    this.#runs.delete(runId);
  }
}

/**
 * SQLite-backed workflow store.
 */
export class SqliteWorkflowStore implements WorkflowStore {
  #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Open a SQLite workflow store and create the required tables.
   */
  static async open(path: string, opts?: { fs?: object }): Promise<SqliteWorkflowStore> {
    const db = await Database.open(path, { fs: opts?.fs as never });
    await db.exec(
      `CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`);
    return new SqliteWorkflowStore(db);
  }

  /**
   * Save or replace one workflow run state.
   */
  async save(state: WorkflowState): Promise<void> {
    const next = { ...state, updatedAt: Date.now() };
    const stmt = this.#db.prepare(
      `INSERT INTO workflow_runs(run_id, workflow_id, status, state, updated_at)
       VALUES(:run_id, :workflow_id, :status, :state, :updated_at)
       ON CONFLICT(run_id) DO UPDATE SET
         workflow_id = excluded.workflow_id,
         status = excluded.status,
         state = excluded.state,
         updated_at = excluded.updated_at`,
    );
    try {
      await stmt.run({
        run_id: next.runId,
        workflow_id: next.workflowId,
        status: next.status,
        state: JSON.stringify(next),
        updated_at: next.updatedAt,
      });
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Load a workflow run by id, or `null` when it is unknown.
   */
  async load(runId: string): Promise<WorkflowState | null> {
    const stmt = this.#db.prepare(`SELECT state FROM workflow_runs WHERE run_id = ?`);
    try {
      const row = await stmt.get(runId);
      return row ? JSON.parse(row.state as string) as WorkflowState : null;
    } finally {
      stmt.finalize();
    }
  }

  /**
   * List persisted runs, newest first, optionally filtered by workflow id or
   * status.
   */
  async list(filter: { workflowId?: string; status?: WorkflowStatus } = {}): Promise<WorkflowState[]> {
    let sql = `SELECT state FROM workflow_runs`;
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filter.workflowId !== undefined) {
      clauses.push(`workflow_id = ?`);
      params.push(filter.workflowId);
    }
    if (filter.status !== undefined) {
      clauses.push(`status = ?`);
      params.push(filter.status);
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ` ORDER BY updated_at DESC`;

    const stmt = this.#db.prepare(sql);
    try {
      const rows = await stmt.all(...params);
      return rows.map((row) => JSON.parse(row.state as string) as WorkflowState);
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Delete one workflow run if it exists.
   */
  async delete(runId: string): Promise<void> {
    const stmt = this.#db.prepare(`DELETE FROM workflow_runs WHERE run_id = ?`);
    try {
      await stmt.run(runId);
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Close the underlying SQLite database.
   */
  async close(): Promise<void> {
    await this.#db.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Error that prevents retries for a failed activity or step.
 */
export class NonRetryableWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableWorkflowError';
  }
}

/**
 * Error used when workflow execution fails.
 */
export class WorkflowError extends Error {
  readonly state: WorkflowState;

  constructor(message: string, state: WorkflowState) {
    super(message);
    this.name = 'WorkflowError';
    this.state = state;
  }
}

/**
 * Activity definition passed to `activity()`.
 */
export interface ActivityDef<In, Out> {
  readonly id: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly retry?: WorkflowRetryOptions;
  run(input: In, ctx: WorkflowContext): Promise<Out> | Out;
}

/**
 * Reusable effectful operation called from a workflow.
 */
export class Activity<In = unknown, Out = unknown> {
  readonly id: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly retry?: WorkflowRetryOptions;
  readonly run: (input: In, ctx: WorkflowContext) => Promise<Out> | Out;

  constructor(def: ActivityDef<In, Out>) {
    this.id = def.id;
    this.inputSchema = def.inputSchema;
    this.outputSchema = def.outputSchema;
    this.retry = def.retry;
    this.run = def.run;
  }
}

/**
 * Create a reusable workflow activity.
 */
export function activity<In = unknown, Out = unknown>(def: ActivityDef<In, Out>): Activity<In, Out> {
  return new Activity(def);
}

/**
 * Mutable durable state helper exposed on `WorkflowContext`.
 */
export interface WorkflowStateBag {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  clear(key: string): void;
  entries(): Record<string, unknown>;
}

/**
 * Context passed to a workflow body and activity.
 */
export interface WorkflowContext {
  readonly runId: string;
  readonly workflowId: string;
  readonly signal?: AbortSignal;
  readonly state: WorkflowStateBag;
  step<T>(id: string, fn: () => Promise<T> | T, opts?: { retry?: WorkflowRetryOptions }): Promise<T>;
  call<In, Out>(activity: Activity<In, Out>, input: In, opts?: { retry?: WorkflowRetryOptions }): Promise<Out>;
  sleep(id: string, duration: number | string | Date): Promise<void>;
  waitForSignal<T = unknown>(name: string, opts?: { timeout?: number | string | Date }): Promise<T>;
}

/**
 * Workflow definition passed to `workflow()`.
 */
export interface WorkflowDef<In, Out> {
  readonly id: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  run(ctx: WorkflowContext, input: In): Promise<Out> | Out;
}

/**
 * Options for starting a workflow run.
 */
export interface WorkflowStartOptions {
  readonly store: WorkflowStore;
  readonly runId?: string;
  readonly key?: string;
  readonly signal?: AbortSignal;
  readonly onCheckpoint?: (state: WorkflowState) => void;
}

/**
 * Options for resuming a workflow run.
 */
export interface WorkflowResumeOptions {
  readonly store: WorkflowStore;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly onCheckpoint?: (state: WorkflowState) => void;
}

/**
 * Signal delivery options.
 */
export interface WorkflowSignalOptions {
  readonly store: WorkflowStore;
  readonly runId: string;
  readonly name: string;
  readonly payload?: unknown;
}

/**
 * Result returned from start and resume.
 */
export interface WorkflowResult<Out = unknown> {
  runId: string;
  status: WorkflowStatus;
  state: WorkflowState;
  waitingOn?: WorkflowWait;
  result?: Out;
}

class WaitSignal extends Error {
  constructor() {
    super('Workflow is waiting');
    this.name = 'WaitSignal';
  }
}

/**
 * Durable workflow definition.
 */
export class Workflow<In = unknown, Out = unknown> {
  /**
   * Stable workflow definition id recorded in every run.
   */
  readonly id: string;
  /**
   * Optional schema used to validate `start()` input before the run is saved.
   */
  readonly inputSchema?: unknown;
  /**
   * Optional schema used to validate the final workflow result.
   */
  readonly outputSchema?: unknown;
  #run: (ctx: WorkflowContext, input: In) => Promise<Out> | Out;

  /**
   * Create a workflow definition from `WorkflowDef`.
   */
  constructor(def: WorkflowDef<In, Out>) {
    this.id = def.id;
    this.inputSchema = def.inputSchema;
    this.outputSchema = def.outputSchema;
    this.#run = def.run;
  }

  /**
   * Start a new durable run and drive it until it completes, fails, or waits.
   */
  start(input: In, opts: WorkflowStartOptions): Promise<WorkflowResult<Out>> {
    return new WorkflowRun(this, opts).start(input);
  }

  /**
   * Resume a persisted run from its last checkpoint.
   */
  resume(opts: WorkflowResumeOptions): Promise<WorkflowResult<Out>> {
    return new WorkflowRun(this, opts).resume();
  }

  /**
   * Deliver an external signal to a run waiting in `ctx.waitForSignal()`.
   */
  async signal(opts: WorkflowSignalOptions): Promise<void> {
    const state = await opts.store.load(opts.runId);
    if (!state) throw new Error(`Workflow run ${opts.runId} not found`);
    if (state.status !== 'waiting' || state.waitingOn?.type !== 'signal') {
      throw new Error(`Workflow run ${opts.runId} is not waiting for a signal`);
    }
    if (state.waitingOn.name !== opts.name) {
      throw new Error(`Workflow run ${opts.runId} is waiting for signal "${state.waitingOn.name}"`);
    }
    await opts.store.save({
      ...state,
      status: 'running',
      waitingOn: undefined,
      signals: [...state.signals, { name: opts.name, payload: opts.payload, receivedAt: Date.now() }],
    });
  }

  /**
   * Drive the user-supplied workflow body.
   *
   * @internal
   */
  async _execute(ctx: WorkflowContext, input: In): Promise<Out> {
    return this.#run(ctx, input);
  }
}

/**
 * Create a durable workflow.
 */
export function workflow<In = unknown, Out = unknown>(def: WorkflowDef<In, Out>): Workflow<In, Out> {
  return new Workflow(def);
}

/**
 * Stateful workflow run handle.
 */
export class WorkflowRun<In = unknown, Out = unknown> {
  #workflow: Workflow<In, Out>;
  #store: WorkflowStore;
  #runId?: string;
  #key?: string;
  #signal?: AbortSignal;
  #onCheckpoint?: (state: WorkflowState) => void;
  #state?: WorkflowState;

  /**
   * Create a handle for starting or resuming one workflow run.
   */
  constructor(workflow: Workflow<In, Out>, opts: WorkflowStartOptions | WorkflowResumeOptions) {
    this.#workflow = workflow;
    this.#store = opts.store;
    this.#runId = 'runId' in opts ? opts.runId : undefined;
    this.#key = 'key' in opts ? opts.key : undefined;
    this.#signal = opts.signal;
    this.#onCheckpoint = opts.onCheckpoint;
  }

  /**
   * Last loaded state for this handle, if it has started or resumed a run.
   */
  get state(): WorkflowState | undefined {
    return this.#state ? cloneState(this.#state) : undefined;
  }

  /**
   * Start this run with `input`.
   */
  async start(input: In): Promise<WorkflowResult<Out>> {
    validateValue(this.#workflow.inputSchema, input, 'Workflow input validation failed');
    const now = Date.now();
    const state: WorkflowState = {
      runId: this.#runId ?? newId(),
      workflowId: this.#workflow.id,
      status: 'running',
      cursor: 0,
      input,
      steps: [],
      state: {},
      signals: [],
      createdAt: now,
      updatedAt: now,
      ...(this.#key !== undefined ? { key: this.#key } : {}),
    };
    this.#state = state;
    await this.#save(state);
    return this.#drive(state);
  }

  /**
   * Resume this run from durable state.
   */
  async resume(): Promise<WorkflowResult<Out>> {
    if (!this.#runId) throw new Error('Workflow run id is required');
    const loaded = await this.#store.load(this.#runId);
    if (!loaded) throw new Error(`Workflow run ${this.#runId} not found`);
    if (loaded.status === 'cancelled') throw new Error(`Workflow run ${this.#runId} is cancelled`);
    if (loaded.status === 'done') {
      this.#state = loaded;
      return toResult<Out>(loaded);
    }
    this.#state = { ...loaded, status: 'running' };
    return this.#drive(this.#state);
  }

  /**
   * Mark this run as cancelled and clear any pending wait.
   */
  async cancel(): Promise<void> {
    const state = this.#state ?? (this.#runId ? await this.#store.load(this.#runId) : null);
    if (!state) return;
    const next = { ...state, status: 'cancelled' as const, waitingOn: undefined };
    this.#state = next;
    await this.#save(next);
  }

  async #drive(initial: WorkflowState): Promise<WorkflowResult<Out>> {
    let state = initial;
    if (state.workflowId !== this.#workflow.id) {
      throw new Error(`Workflow run ${state.runId} belongs to workflow "${state.workflowId}"`);
    }

    const runtime = new WorkflowRuntime(this.#workflow, this.#store, state, this.#signal, async (next) => {
      state = next;
      this.#state = next;
      await this.#save(next);
      this.#onCheckpoint?.(next);
    });

    try {
      const output = await this.#workflow._execute(runtime.context, state.input as In);
      validateValue(this.#workflow.outputSchema, output, 'Workflow output validation failed');
      state = { ...state, status: 'done', waitingOn: undefined, result: output, error: undefined };
      this.#state = state;
      await this.#save(state);
      return toResult<Out>(state);
    } catch (err) {
      const e = err as Error;
      if (e.name === 'WaitSignal') {
        state = runtime.state;
        this.#state = state;
        await this.#save(state);
        return toResult<Out>(state);
      }
      if (e.name === 'AbortError') {
        state = { ...runtime.state, status: 'cancelled', waitingOn: undefined };
        this.#state = state;
        await this.#save(state);
        throw err;
      }
      state = {
        ...runtime.state,
        status: 'error',
        waitingOn: undefined,
        error: { message: e.message, stack: e.stack },
      };
      this.#state = state;
      await this.#save(state);
      throw err;
    }
  }

  async #save(state: WorkflowState): Promise<void> {
    await this.#store.save({ ...state, updatedAt: Date.now() });
  }
}

class WorkflowRuntime<In, Out> {
  readonly context: WorkflowContext;
  #workflow: Workflow<In, Out>;
  #store: WorkflowStore;
  #callIndex = 0;
  #state: WorkflowState;
  #signal?: AbortSignal;
  #checkpoint: (state: WorkflowState) => Promise<void>;
  #completionQueue: Promise<void> = Promise.resolve();

  constructor(
    workflow: Workflow<In, Out>,
    store: WorkflowStore,
    state: WorkflowState,
    signal: AbortSignal | undefined,
    checkpoint: (state: WorkflowState) => Promise<void>,
  ) {
    this.#workflow = workflow;
    this.#store = store;
    this.#state = state;
    this.#signal = signal;
    this.#checkpoint = checkpoint;
    this.context = {
      runId: state.runId,
      workflowId: workflow.id,
      signal,
      state: this.#stateBag(),
      step: (id, fn, opts) => this.#step(id, fn, opts?.retry),
      call: (a, input, opts) => this.#call(a, input, opts?.retry),
      sleep: (id, duration) => this.#sleep(id, duration),
      waitForSignal: (name, opts) => this.#waitForSignal(name, opts),
    };
  }

  get state(): WorkflowState {
    return this.#state;
  }

  #stateBag(): WorkflowStateBag {
    return {
      get: (key) => this.#state.state[key] as never,
      set: (key, value) => {
        this.#state = { ...this.#state, state: { ...this.#state.state, [key]: value } };
      },
      clear: (key) => {
        const next = { ...this.#state.state };
        delete next[key];
        this.#state = { ...this.#state, state: next };
      },
      entries: () => ({ ...this.#state.state }),
    };
  }

  async #step<T>(id: string, fn: () => Promise<T> | T, retry?: WorkflowRetryOptions): Promise<T> {
    const index = this.#callIndex++;
    const completed = this.#state.steps[index];
    if (index < this.#state.cursor && completed?.id === id) return completed.result as T;
    if (index < this.#state.cursor && completed?.id !== id) {
      throw new Error(`Workflow step mismatch at index ${index}: expected "${completed?.id}", got "${id}"`);
    }

    const result = await runWithRetry(fn, retry);
    await this.#complete(index, id, result);
    return result;
  }

  async #call<In2, Out2>(
    activity: Activity<In2, Out2>,
    input: In2,
    retry?: WorkflowRetryOptions,
  ): Promise<Out2> {
    validateValue(activity.inputSchema, input, `Activity "${activity.id}" input validation failed`);
    return this.#step(activity.id, async () => {
      const output = await activity.run(input, this.context);
      validateValue(activity.outputSchema, output, `Activity "${activity.id}" output validation failed`);
      return output;
    }, retry ?? activity.retry);
  }

  async #sleep(id: string, duration: number | string | Date): Promise<void> {
    const index = this.#callIndex++;
    const completed = this.#state.steps[index];
    if (index < this.#state.cursor && completed?.id === id) return;

    const existing = this.#state.waitingOn;
    const dueAt = existing?.type === 'timer' && existing.stepIndex === index
      ? existing.dueAt
      : toDueAt(duration);
    if (Date.now() < dueAt) {
      this.#state = {
        ...this.#state,
        status: 'waiting',
        waitingOn: { type: 'timer', id, dueAt, stepIndex: index },
      };
      await this.#store.save(this.#state);
      throw new WaitSignal();
    }
    await this.#complete(index, id, undefined);
  }

  async #waitForSignal<T>(name: string, opts?: { timeout?: number | string | Date }): Promise<T> {
    const index = this.#callIndex++;
    const completed = this.#state.steps[index];
    if (index < this.#state.cursor && completed?.id === name) return completed.result as T;

    const signalIndex = this.#state.signals.findIndex((signal) => signal.name === name);
    if (signalIndex >= 0) {
      const signal = this.#state.signals[signalIndex]!;
      const signals = this.#state.signals.slice();
      signals.splice(signalIndex, 1);
      this.#state = { ...this.#state, signals };
      await this.#complete(index, name, signal.payload);
      return signal.payload as T;
    }

    const timeoutAt = opts?.timeout !== undefined ? toDueAt(opts.timeout) : undefined;
    if (timeoutAt !== undefined && Date.now() >= timeoutAt) {
      throw new Error(`Workflow signal "${name}" timed out`);
    }
    this.#state = {
      ...this.#state,
      status: 'waiting',
      waitingOn: { type: 'signal', id: name, name, stepIndex: index, ...(timeoutAt !== undefined ? { timeoutAt } : {}) },
    };
    await this.#store.save(this.#state);
    throw new WaitSignal();
  }

  async #complete(index: number, id: string, result: unknown): Promise<void> {
    const previous = this.#completionQueue.catch(() => {});
    this.#completionQueue = previous.then(async () => {
      const latest = await this.#store.load(this.#state.runId);
      const base = latest && latest.workflowId === this.#workflow.id ? latest : this.#state;
      const steps = base.steps.slice();
      steps[index] = { id, status: 'done', result };
      let cursor = base.cursor;
      while (steps[cursor]?.status === 'done') cursor++;
      this.#state = {
        ...base,
        status: 'running',
        cursor,
        steps,
        waitingOn: undefined,
        updatedAt: Date.now(),
      };
      await this.#checkpoint(this.#state);
    });
    await this.#completionQueue;
  }
}

async function runWithRetry<T>(fn: () => Promise<T> | T, retry: WorkflowRetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 1);
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if ((err as Error).name === 'NonRetryableWorkflowError') break;
      if (attempt >= maxAttempts) break;
    }
  }
  throw last;
}

function validateValue(schema: unknown, value: unknown, message: string): void {
  if (!schema) return;
  const validator = compile(schema);
  const result = validator.safeParse(value);
  if (!result.success) throw new Error(`${message}: ${result.error.message}`);
}

function cloneState(state: WorkflowState): WorkflowState {
  return JSON.parse(JSON.stringify(state)) as WorkflowState;
}

function toResult<Out>(state: WorkflowState): WorkflowResult<Out> {
  return {
    runId: state.runId,
    status: state.status,
    state,
    waitingOn: state.waitingOn,
    result: state.result as Out,
  };
}

function toDueAt(value: number | string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Date.now() + value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid workflow duration "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2];
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Date.now() + amount * scale;
}
