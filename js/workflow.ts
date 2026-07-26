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
import { Database, sql, type DatabaseConnection, type SqlFragment } from 'fino:database';
import { compile } from 'fino:validate';
import { topic } from 'fino:context/topic';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
let idCounter = 0;
function newId(): string {
  return `wf_${++idCounter}_${Math.random().toString(36).slice(2)}`;
}
/**
 * Status persisted for a workflow run.
 *
 * `running` means the workflow can be driven immediately. `waiting` means it
 * paused on a timer or signal and records that wait in `WorkflowState.waitingOn`.
 * `done`, `error`, and `cancelled` are terminal states.
 */
export type WorkflowStatus = 'running' | 'waiting' | 'done' | 'error' | 'cancelled';
/**
 * Retry policy used by `activity()` and `ctx.step()`.
 *
 * ## Fields
 *
 * - `maxAttempts` caps the total number of attempts. Missing or invalid values
 *   below `1` behave as `1`.
 */
export interface WorkflowRetryOptions {
  /**
   * Maximum number of times to run the activity or step body before surfacing
   * the last error. Values below `1` are treated as `1`.
   *
   * A thrown `NonRetryableWorkflowError` stops retrying immediately.
   */
  readonly maxAttempts?: number;
}
/**
 * Durable wait recorded when a workflow pauses for time or an external signal.
 *
 * Timer waits record an absolute `dueAt` timestamp. Signal waits record the
 * signal `name` and optional absolute `timeoutAt` timestamp. `stepIndex` ties
 * either wait back to the checkpoint position that created it.
 */
export type WorkflowWait =
  | {
      /**
       * Timer waits resume when `Date.now()` reaches `dueAt`.
       */
      type: 'timer';
      /**
       * User-supplied checkpoint id passed to `ctx.sleep()`.
       */
      id: string;
      /**
       * Absolute Unix timestamp in milliseconds when the timer can complete.
       */
      dueAt: number;
      /**
       * Zero-based checkpoint position of the wait in the workflow body.
       */
      stepIndex: number;
    }
  | {
      /**
       * Signal waits resume after `Workflow.signal()` stores a matching signal.
       */
      type: 'signal';
      /**
       * Wait id. For signal waits this matches `name`.
       */
      id: string;
      /**
       * Signal name the run is currently waiting for.
       */
      name: string;
      /**
       * Zero-based checkpoint position of the wait in the workflow body.
       */
      stepIndex: number;
      /**
       * Optional absolute Unix timestamp in milliseconds after which resuming the
       * workflow throws a timeout error instead of waiting again.
       */
      timeoutAt?: number;
    };
/**
 * One completed checkpointed call.
 *
 * Each record stores the checkpoint `id`, the completed `status`, and the
 * optional serialized `result` that replay returns instead of rerunning the
 * step.
 */
export interface WorkflowStepState {
  /**
   * Stable step id supplied to `ctx.step()`, the called activity id, the sleep
   * id, or the signal name.
   */
  readonly id: string;
  /**
   * Step completion marker. Only completed steps are persisted.
   */
  readonly status: 'done';
  /**
   * JSON-serializable result reused when workflow code replays.
   */
  readonly result?: unknown;
}
/**
 * Persisted workflow run state.
 *
 * ## Fields
 *
 * - `runId` uniquely identifies the run.
 * - `workflowId` identifies the workflow definition that owns the run.
 * - `status` tracks lifecycle state.
 * - `cursor` is the first contiguous checkpoint index not yet complete.
 * - `input` is the original `start()` input.
 * - `steps` stores completed checkpoints in call order.
 * - `state` stores the durable `ctx.state` bag.
 * - `signals` queues delivered signals until `ctx.waitForSignal()` consumes
 *   them.
 * - `createdAt` and `updatedAt` are Unix timestamps in milliseconds.
 * - `key` is an optional caller-supplied lookup or idempotency key.
 * - `waitingOn` describes the current timer or signal wait.
 * - `result` holds the final output for `done` runs.
 * - `error` holds serialized failure details for `error` runs.
 */
export interface WorkflowState {
  /**
   * Unique id for this workflow run.
   */
  runId: string;
  /**
   * `Workflow.id` for the definition that owns the run.
   */
  workflowId: string;
  /**
   * Current lifecycle state. `waiting` runs have `waitingOn`; `done` runs have
   * `result`; `error` runs have `error`.
   */
  status: WorkflowStatus;
  /**
   * First checkpoint index that has not completed contiguously.
   */
  cursor: number;
  /**
   * Original input passed to `Workflow.start()`.
   */
  input: unknown;
  /**
   * Completed checkpoint records in call order. Sparse positions can appear
   * while parallel steps finish out of order.
   */
  steps: WorkflowStepState[];
  /**
   * Durable key/value bag behind `ctx.state`.
   */
  state: Record<string, unknown>;
  /**
   * Queued external signals that have been delivered but not yet consumed by a
   * matching `ctx.waitForSignal()` call.
   */
  signals: WorkflowSignal[];
  /**
   * Unix timestamp in milliseconds when the run was first saved.
   */
  createdAt: number;
  /**
   * Unix timestamp in milliseconds for the last saved update.
   */
  updatedAt: number;
  /**
   * Optional caller-supplied idempotency or lookup key.
   */
  key?: string;
  /**
   * Current timer or signal wait when `status` is `waiting`.
   */
  waitingOn?: WorkflowWait;
  /**
   * Final validated output when `status` is `done`.
   */
  result?: unknown;
  /**
   * Serialized failure details when `status` is `error`.
   */
  error?: {
    /**
     * Error message from the thrown value.
     */
    message: string;
    /**
     * Stack trace when the thrown value provided one.
     */
    stack?: string;
  };
}
/**
 * Signal delivered to a waiting workflow.
 *
 * `name` is matched against `ctx.waitForSignal(name)`, `payload` is returned
 * from that wait, and `receivedAt` records when `Workflow.signal()` stored it.
 */
export interface WorkflowSignal {
  /**
   * Signal name matched against `ctx.waitForSignal(name)`.
   */
  name: string;
  /**
   * Payload returned from `ctx.waitForSignal()`.
   */
  payload: unknown;
  /**
   * Unix timestamp in milliseconds when `Workflow.signal()` stored the signal.
   */
  receivedAt: number;
}
/**
 * Store contract for durable workflow state.
 *
 * Implementations persist full `WorkflowState` snapshots. `load()` returns
 * `null` for unknown run ids, `list()` may filter by `workflowId` and `status`,
 * and `delete()` may treat missing runs as a successful no-op.
 */
export interface WorkflowStore {
  /**
   * Persist a full workflow state snapshot.
   */
  save(state: WorkflowState): Promise<void>;
  /**
   * Load one workflow run by id, or `null` when the store has no matching run.
   */
  load(runId: string): Promise<WorkflowState | null>;
  /**
   * Return persisted runs, optionally filtered by workflow id or lifecycle
   * status.
   */
  list(filter?: {
    /**
     * Only include runs owned by this workflow definition id.
     */
    workflowId?: string;
    /**
     * Only include runs currently in this lifecycle state.
     */
    status?: WorkflowStatus;
  }): Promise<WorkflowState[]>;
  /**
   * Delete one run by id. Stores may treat unknown ids as a successful no-op.
   */
  delete(runId: string): Promise<void>;
}
function workflowRunTopic(runId: string) {
  return topic<{ runId: string; version: number; deleted?: boolean }>(`fino:workflow:run:${runId}`);
}
/**
 * Wrap a workflow store so every save and delete publishes a run update.
 *
 * The wrapped store remains the durable source of truth. Notifications only
 * tell local watchers to reload the run state.
 */
export function observableWorkflowStore(inner: WorkflowStore): WorkflowStore {
  return {
    async save(state: WorkflowState): Promise<void> {
      await inner.save(state);
      workflowRunTopic(state.runId).publish({
        runId: state.runId,
        version: state.updatedAt,
      });
    },
    load(runId: string): Promise<WorkflowState | null> {
      return inner.load(runId);
    },
    list(filter?: { workflowId?: string; status?: WorkflowStatus }): Promise<WorkflowState[]> {
      return inner.list(filter);
    },
    async delete(runId: string): Promise<void> {
      await inner.delete(runId);
      workflowRunTopic(runId).publish({
        runId,
        version: Date.now(),
        deleted: true,
      });
    },
  };
}
/**
 * Watch one workflow run in a store.
 *
 * The returned signal starts as `null`, loads the current state asynchronously,
 * and refreshes whenever an `observableWorkflowStore()` wrapper publishes a run
 * update for the same id.
 */
export function watchRun(
  store: WorkflowStore,
  runId: string,
): ReadonlySignal<WorkflowState | null> {
  return lazy<WorkflowState | null>(null, (set) => {
    let active = true;
    const refresh = () => {
      void store.load(runId).then((next) => {
        if (active) set(next ? cloneState(next) : null);
      });
    };
    refresh();
    const handle = workflowRunTopic(runId).subscribe(refresh);
    return () => {
      active = false;
      handle.dispose();
    };
  });
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
  async list(
    filter: {
      workflowId?: string;
      status?: WorkflowStatus;
    } = {},
  ): Promise<WorkflowState[]> {
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
 * Database-backed workflow store.
 *
 * The class name is retained for compatibility. Pass a `sqlite://` path or a
 * `postgres://` URL to choose the storage engine through `fino:database`.
 */
export class SqliteWorkflowStore implements WorkflowStore {
  #db: DatabaseConnection;
  private constructor(db: DatabaseConnection) {
    this.#db = db;
  }
  /**
   * Open a workflow store and create the required tables.
   */
  static async open(
    path: string,
    opts?: {
      fs?: object;
    },
  ): Promise<SqliteWorkflowStore> {
    const db = await Database.open(path, { fs: opts?.fs as never });
    await db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id)`,
    );
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`);
    return new SqliteWorkflowStore(db);
  }
  /**
   * Save or replace one workflow run state.
   */
  async save(state: WorkflowState): Promise<void> {
    const next = {
      ...state,
      updatedAt: Date.now(),
    };
    const stmt = this.#db
      .prepare(sql`INSERT INTO workflow_runs(run_id, workflow_id, status, state, updated_at)
       VALUES(${next.runId}, ${next.workflowId}, ${next.status}, ${JSON.stringify(next)}, ${next.updatedAt})
       ON CONFLICT(run_id) DO UPDATE SET
         workflow_id = excluded.workflow_id,
         status = excluded.status,
         state = excluded.state,
         updated_at = excluded.updated_at`);
    try {
      await stmt.run();
    } finally {
      stmt.finalize();
    }
  }
  /**
   * Load a workflow run by id, or `null` when it is unknown.
   */
  async load(runId: string): Promise<WorkflowState | null> {
    const stmt = this.#db.prepare(sql`SELECT state FROM workflow_runs WHERE run_id = ${runId}`);
    try {
      const row = await stmt.get();
      return row ? (JSON.parse(row.state as string) as WorkflowState) : null;
    } finally {
      stmt.finalize();
    }
  }
  /**
   * List persisted runs, newest first, optionally filtered by workflow id or
   * status.
   */
  async list(
    filter: {
      workflowId?: string;
      status?: WorkflowStatus;
    } = {},
  ): Promise<WorkflowState[]> {
    let query: SqlFragment = sql`SELECT state FROM workflow_runs`;
    const clauses: SqlFragment[] = [];
    if (filter.workflowId !== undefined) {
      clauses.push(sql`workflow_id = ${filter.workflowId}`);
    }
    if (filter.status !== undefined) {
      clauses.push(sql`status = ${filter.status}`);
    }
    if (clauses.length > 0) query = sql`${query} WHERE ${sql.join(clauses, ' AND ')}`;
    query = sql`${query} ORDER BY updated_at DESC`;
    const stmt = this.#db.prepare(query);
    try {
      const rows = await stmt.all();
      return rows.map((row) => JSON.parse(row.state as string) as WorkflowState);
    } finally {
      stmt.finalize();
    }
  }
  /**
   * Delete one workflow run if it exists.
   */
  async delete(runId: string): Promise<void> {
    const stmt = this.#db.prepare(sql`DELETE FROM workflow_runs WHERE run_id = ${runId}`);
    try {
      await stmt.run();
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
  /**
   * Dispose the underlying database connection when used with `await using`.
   */
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
  /**
   * Durable state associated with the failed workflow.
   */
  readonly state: WorkflowState;
  constructor(message: string, state: WorkflowState) {
    super(message);
    this.name = 'WorkflowError';
    this.state = state;
  }
}
/**
 * Activity definition passed to `activity()`.
 *
 * ## Fields
 *
 * - `id` is the stable checkpoint id used by `ctx.call()`.
 * - `inputSchema` and `outputSchema` optionally validate activity boundaries.
 * - `retry` supplies the default retry policy.
 * - `run` performs the side effect or expensive work that should not repeat on
 *   workflow replay.
 */
export interface ActivityDef<In, Out> {
  /**
   * Stable activity id used as the checkpoint id for `ctx.call()`.
   */
  readonly id: string;
  /**
   * Optional validation schema for activity inputs.
   */
  readonly inputSchema?: unknown;
  /**
   * Optional validation schema for activity outputs.
   */
  readonly outputSchema?: unknown;
  /**
   * Default retry policy for calls to this activity.
   */
  readonly retry?: WorkflowRetryOptions;
  /**
   * Activity body. Put external side effects here so workflow replay reuses the
   * persisted result instead of repeating the effect.
   */
  run(input: In, ctx: WorkflowContext): Promise<Out> | Out;
}
/**
 * Reusable effectful operation called from a workflow.
 */
export class Activity<In = unknown, Out = unknown> {
  /**
   * Stable activity id used as the checkpoint id for `ctx.call()`.
   */
  readonly id: string;
  /**
   * Optional validation schema checked before `run()` is called.
   */
  readonly inputSchema?: unknown;
  /**
   * Optional validation schema checked after `run()` resolves.
   */
  readonly outputSchema?: unknown;
  /**
   * Default retry policy used when `ctx.call()` does not provide one.
   */
  readonly retry?: WorkflowRetryOptions;
  /**
   * Activity body supplied to `activity()`.
   */
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
export function activity<In = unknown, Out = unknown>(
  def: ActivityDef<In, Out>,
): Activity<In, Out> {
  return new Activity(def);
}
/**
 * Mutable durable state helper exposed on `WorkflowContext`.
 *
 * `get()`, `set()`, and `clear()` update the run's persisted `state` object.
 * `entries()` returns a shallow copy so callers can inspect the bag without
 * mutating it directly.
 */
export interface WorkflowStateBag {
  /**
   * Read a durable value by key, returning `undefined` when the key is absent.
   */
  get<T = unknown>(key: string): T | undefined;
  /**
   * Set or replace a durable value by key.
   */
  set(key: string, value: unknown): void;
  /**
   * Remove a durable value by key.
   */
  clear(key: string): void;
  /**
   * Return a shallow copy of all durable state entries.
   */
  entries(): Record<string, unknown>;
}
/**
 * Context passed to a workflow body and activity.
 *
 * ## Properties
 *
 * - `runId` and `workflowId` identify the current execution.
 * - `signal` is the optional abort signal passed to `start()` or `resume()`.
 * - `state` is the run-scoped durable key/value bag.
 *
 * ## Checkpoints
 *
 * `step()` and `call()` persist results and reuse them on replay. `sleep()` and
 * `waitForSignal()` persist waits and return a `waiting` run result until the
 * wait can complete.
 */
export interface WorkflowContext {
  /**
   * Id of the run currently being executed.
   */
  readonly runId: string;
  /**
   * Id of the workflow definition currently being executed.
   */
  readonly workflowId: string;
  /**
   * Optional abort signal passed through start or resume options.
   */
  readonly signal?: AbortSignal;
  /**
   * Durable key/value state scoped to this run.
   */
  readonly state: WorkflowStateBag;
  /**
   * Execute a named checkpoint. On replay, a completed checkpoint with the same
   * id returns its persisted result without calling `fn`.
   */
  step<T>(
    id: string,
    fn: () => Promise<T> | T,
    opts?: {
      /**
       * Retry policy for this step execution.
       */
      retry?: WorkflowRetryOptions;
    },
  ): Promise<T>;
  /**
   * Call a reusable activity as a checkpointed operation.
   */
  call<In, Out>(
    activity: Activity<In, Out>,
    input: In,
    opts?: {
      /**
       * Retry policy for this call. Overrides the activity default.
       */
      retry?: WorkflowRetryOptions;
    },
  ): Promise<Out>;
  /**
   * Pause until a relative duration, duration string, or absolute date is due.
   *
   * Numeric durations are milliseconds. String durations accept `ms`, `s`, `m`,
   * `h`, and `d` units.
   */
  sleep(id: string, duration: number | string | Date): Promise<void>;
  /**
   * Pause until a matching external signal is delivered.
   *
   * The resolved value is the signal payload. When `timeout` is provided and is
   * already expired during resume, the workflow throws a timeout error.
   */
  waitForSignal<T = unknown>(
    name: string,
    opts?: {
      /**
       * Relative duration, duration string, or absolute date after which the wait
       * times out.
       */
      timeout?: number | string | Date;
    },
  ): Promise<T>;
}
/**
 * Workflow definition passed to `workflow()`.
 *
 * ## Fields
 *
 * - `id` is the stable workflow definition id persisted with every run.
 * - `inputSchema` and `outputSchema` optionally validate run boundaries.
 * - `run` contains the workflow body. Use `ctx.step()` and `ctx.call()` around
 *   nondeterministic work so resume can replay deterministically.
 */
export interface WorkflowDef<In, Out> {
  /**
   * Stable workflow definition id recorded in each run.
   */
  readonly id: string;
  /**
   * Optional validation schema checked before the run is first saved.
   */
  readonly inputSchema?: unknown;
  /**
   * Optional validation schema checked before a run completes as `done`.
   */
  readonly outputSchema?: unknown;
  /**
   * Workflow body. Keep nondeterministic work inside `ctx.step()` or
   * `ctx.call()` so replay can reuse durable checkpoints.
   */
  run(ctx: WorkflowContext, input: In): Promise<Out> | Out;
}
/**
 * Options for starting a workflow run.
 *
 * `store` is required. `runId` and `key` let callers supply identifiers,
 * `signal` is exposed on `ctx.signal`, and `onCheckpoint` runs after each
 * checkpoint snapshot is persisted.
 */
export interface WorkflowStartOptions {
  /**
   * Durable store that owns the run state.
   */
  readonly store: WorkflowStore;
  /**
   * Optional caller-supplied run id. When omitted, Fino generates one.
   */
  readonly runId?: string;
  /**
   * Optional idempotency or lookup key persisted on `WorkflowState.key`.
   */
  readonly key?: string;
  /**
   * Abort signal observed by workflow code through `ctx.signal`.
   */
  readonly signal?: AbortSignal;
  /**
   * Called after each checkpoint is persisted.
   */
  readonly onCheckpoint?: (state: WorkflowState) => void;
}
/**
 * Options for resuming a workflow run.
 *
 * `store` and `runId` select the persisted run. `signal` is exposed on
 * `ctx.signal`, and `onCheckpoint` runs after each new checkpoint snapshot is
 * persisted.
 */
export interface WorkflowResumeOptions {
  /**
   * Durable store that owns the run state.
   */
  readonly store: WorkflowStore;
  /**
   * Existing run id to load and resume.
   */
  readonly runId: string;
  /**
   * Abort signal observed by workflow code through `ctx.signal`.
   */
  readonly signal?: AbortSignal;
  /**
   * Called after each checkpoint is persisted.
   */
  readonly onCheckpoint?: (state: WorkflowState) => void;
}
/**
 * Signal delivery options.
 *
 * `store` and `runId` select a waiting run. `name` must match the run's current
 * signal wait, and `payload` becomes the value returned by
 * `ctx.waitForSignal()`.
 */
export interface WorkflowSignalOptions {
  /**
   * Durable store that owns the target run state.
   */
  readonly store: WorkflowStore;
  /**
   * Existing waiting run id.
   */
  readonly runId: string;
  /**
   * Signal name that must match the run's current `waitingOn.name`.
   */
  readonly name: string;
  /**
   * Optional payload returned by `ctx.waitForSignal()`.
   */
  readonly payload?: unknown;
}
/**
 * Result returned from start and resume.
 *
 * `runId`, `status`, and `state` are always present. `waitingOn` is present for
 * waits, and `result` is populated when the workflow reaches `done`.
 */
export interface WorkflowResult<Out = unknown> {
  /**
   * Run id that was started or resumed.
   */
  runId: string;
  /**
   * Lifecycle state after driving the workflow.
   */
  status: WorkflowStatus;
  /**
   * Full durable state snapshot after driving the workflow.
   */
  state: WorkflowState;
  /**
   * Current wait details when `status` is `waiting`.
   */
  waitingOn?: WorkflowWait;
  /**
   * Final workflow output when `status` is `done`.
   */
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
      signals: [
        ...state.signals,
        {
          name: opts.name,
          payload: opts.payload,
          receivedAt: Date.now(),
        },
      ],
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
export function workflow<In = unknown, Out = unknown>(
  def: WorkflowDef<In, Out>,
): Workflow<In, Out> {
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
    this.#state = {
      ...loaded,
      status: 'running',
    };
    return this.#drive(this.#state);
  }
  /**
   * Mark this run as cancelled and clear any pending wait.
   */
  async cancel(): Promise<void> {
    const state = this.#state ?? (this.#runId ? await this.#store.load(this.#runId) : null);
    if (!state) return;
    const next = {
      ...state,
      status: 'cancelled' as const,
      waitingOn: undefined,
    };
    this.#state = next;
    await this.#save(next);
  }
  async #drive(initial: WorkflowState): Promise<WorkflowResult<Out>> {
    let state = initial;
    if (state.workflowId !== this.#workflow.id) {
      throw new Error(`Workflow run ${state.runId} belongs to workflow "${state.workflowId}"`);
    }
    const runtime = new WorkflowRuntime(
      this.#workflow,
      this.#store,
      state,
      this.#signal,
      async (next) => {
        state = next;
        this.#state = next;
        await this.#save(next);
        this.#onCheckpoint?.(next);
      },
    );
    try {
      const output = await this.#workflow._execute(runtime.context, state.input as In);
      validateValue(this.#workflow.outputSchema, output, 'Workflow output validation failed');
      state = {
        ...state,
        status: 'done',
        waitingOn: undefined,
        result: output,
        error: undefined,
      };
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
        state = {
          ...runtime.state,
          status: 'cancelled',
          waitingOn: undefined,
        };
        this.#state = state;
        await this.#save(state);
        throw err;
      }
      state = {
        ...runtime.state,
        status: 'error',
        waitingOn: undefined,
        error: {
          message: e.message,
          stack: e.stack,
        },
      };
      this.#state = state;
      await this.#save(state);
      throw err;
    }
  }
  async #save(state: WorkflowState): Promise<void> {
    await this.#store.save({
      ...state,
      updatedAt: Date.now(),
    });
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
        this.#state = {
          ...this.#state,
          state: {
            ...this.#state.state,
            [key]: value,
          },
        };
      },
      clear: (key) => {
        const next = { ...this.#state.state };
        delete next[key];
        this.#state = {
          ...this.#state,
          state: next,
        };
      },
      entries: () => ({ ...this.#state.state }),
    };
  }
  async #step<T>(id: string, fn: () => Promise<T> | T, retry?: WorkflowRetryOptions): Promise<T> {
    const index = this.#callIndex++;
    const completed = this.#state.steps[index];
    if (index < this.#state.cursor && completed?.id === id) return completed.result as T;
    if (index < this.#state.cursor && completed?.id !== id) {
      throw new Error(
        `Workflow step mismatch at index ${index}: expected "${completed?.id}", got "${id}"`,
      );
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
    return this.#step(
      activity.id,
      async () => {
        const output = await activity.run(input, this.context);
        validateValue(
          activity.outputSchema,
          output,
          `Activity "${activity.id}" output validation failed`,
        );
        return output;
      },
      retry ?? activity.retry,
    );
  }
  async #sleep(id: string, duration: number | string | Date): Promise<void> {
    const index = this.#callIndex++;
    const completed = this.#state.steps[index];
    if (index < this.#state.cursor && completed?.id === id) return;
    const existing = this.#state.waitingOn;
    const dueAt =
      existing?.type === 'timer' && existing.stepIndex === index
        ? existing.dueAt
        : toDueAt(duration);
    if (Date.now() < dueAt) {
      this.#state = {
        ...this.#state,
        status: 'waiting',
        waitingOn: {
          type: 'timer',
          id,
          dueAt,
          stepIndex: index,
        },
      };
      await this.#store.save(this.#state);
      throw new WaitSignal();
    }
    await this.#complete(index, id, undefined);
  }
  async #waitForSignal<T>(
    name: string,
    opts?: {
      timeout?: number | string | Date;
    },
  ): Promise<T> {
    const index = this.#callIndex++;
    const completed = this.#state.steps[index];
    if (index < this.#state.cursor && completed?.id === name) return completed.result as T;
    const signalIndex = this.#state.signals.findIndex((signal) => signal.name === name);
    if (signalIndex >= 0) {
      const signal = this.#state.signals[signalIndex]!;
      const signals = this.#state.signals.slice();
      signals.splice(signalIndex, 1);
      this.#state = {
        ...this.#state,
        signals,
      };
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
      waitingOn: {
        type: 'signal',
        id: name,
        name,
        stepIndex: index,
        ...(timeoutAt !== undefined ? { timeoutAt } : {}),
      },
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
      steps[index] = {
        id,
        status: 'done',
        result,
      };
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
async function runWithRetry<T>(
  fn: () => Promise<T> | T,
  retry: WorkflowRetryOptions = {},
): Promise<T> {
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
  const scale =
    unit === 'ms' ? 1 : unit === 's' ? 1e3 : unit === 'm' ? 6e4 : unit === 'h' ? 36e5 : 864e5;
  return Date.now() + amount * scale;
}
