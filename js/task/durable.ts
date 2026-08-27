/**
 * fino:task/durable — durable tasks: `fino:task` executables whose runs
 * execute inside a `fino:workflow` run.
 *
 * A `DurableTask` is a `Task` in every consumer-facing way — it validates
 * input, parses CLI argv, mounts as an AI tool, honors `timeoutMs` — but its
 * handler runs inside a durable workflow execution: `ctx.step()` checkpoints
 * results, `ctx.sleep()` and `ctx.waitForSignal()` park the run durably, and
 * a resumed run replays from its last checkpoint instead of starting over.
 *
 * ## Execution model
 *
 * The handler re-executes from the top on every resume. Completed steps are
 * replayed from the store by call order and id — they return their recorded
 * results without re-running — so all side effects (including writer output
 * that must not repeat) belong inside `ctx.step()`. Changing the sequence of
 * step ids between runs of the same `runId` is a determinism error and the
 * workflow runtime rejects it. `ctx.env`, `ctx.cwd`, `ctx.prompt`, and
 * `ctx.writer` are per-drive values, not durable state.
 *
 * `run()` drives a run to completion, waiting out timer parks in-process and
 * honoring `signalRun()` deliveries. The `start()` / `resume()` / `signalRun()`
 * surface performs exactly one drive per call and reports the parked state —
 * schedulers (e.g. `fino:jobs`) own the timers in that mode.
 *
 * Task-level `suspend()` is not available inside a durable handler: the
 * AI-loop suspension signal would unwind through the workflow driver and
 * persist the run as failed. Durable pauses use `ctx.waitForSignal()`.
 *
 * Without a `store`, runs checkpoint into a fresh in-memory store: replay
 * semantics apply within the process, but nothing survives a restart.
 *
 * @example
 * ```ts no_run
 * import { durableTask } from 'fino:task/durable';
 * import { sqliteStore } from 'fino:store';
 *
 * const ingest = durableTask({
 *   name: 'ingest',
 *   store: () => sqliteStore({ path: '/data/jobs.db' }),
 *   run: async (input: { url: string }, ctx) => {
 *     const doc = await ctx.step('fetch', () => fetch(input.url).then((r) => r.text()));
 *     await ctx.sleep('cooldown', '5s');
 *     return await ctx.step('summarize', () => doc.slice(0, 100));
 *   },
 * });
 *
 * await ingest.run({ url: 'https://example.com' }, { runId: 'ingest-42' });
 * ```
 */
import {
  Task,
  type TaskContext,
  type TaskOptions,
  type TaskOutputWriter,
  type TaskRunOptions,
} from '../task.ts';
import {
  loadWorkflowRun,
  workflow,
  type Activity,
  type Workflow,
  type WorkflowContext,
  type WorkflowResult,
  type WorkflowRetryOptions,
  type WorkflowStateBag,
  type WorkflowStatus,
  type WorkflowWait,
} from '../workflow.ts';
import { Context } from 'fino:context';
import { memoryStore, type Store } from 'fino:store';

/**
 * Context passed to a durable task handler.
 *
 * Extends the task context with the workflow's durable operations. The
 * numeric AI-loop step index moves to `aiStep` so `step()` can be the
 * workflow checkpoint method, and `suspend()` always throws — durable pauses
 * use `waitForSignal()`.
 */
export interface DurableTaskContext extends Omit<TaskContext, 'step' | 'suspend'> {
  /** AI-loop step index (the plain TaskContext `step` number). */
  readonly aiStep?: number;
  /** Durable workflow run id backing this execution. */
  readonly workflowRunId: string;
  /** Durable key/value state persisted with every checkpoint. */
  readonly state: WorkflowStateBag;
  /** Run `fn` once and checkpoint its result under `id`. */
  step<T>(
    id: string,
    fn: () => Promise<T> | T,
    opts?: {
      retry?: WorkflowRetryOptions;
    },
  ): Promise<T>;
  /** Invoke a workflow activity with validated input/output, checkpointed. */
  call<In, Out>(
    activity: Activity<In, Out>,
    input: In,
    opts?: {
      retry?: WorkflowRetryOptions;
    },
  ): Promise<Out>;
  /** Park the run durably until `duration` elapses. */
  sleep(id: string, duration: number | string | Date): Promise<void>;
  /** Park the run durably until `signalRun()` delivers `name`. */
  waitForSignal<T = unknown>(
    name: string,
    opts?: {
      timeout?: number | string | Date;
    },
  ): Promise<T>;
  /** Always throws — durable pauses use `waitForSignal()`. */
  suspend(opts?: { reason?: string; payload?: unknown }): never;
}
/**
 * Function that performs a durable task.
 */
export type DurableTaskHandler<Input, Output = unknown> = (
  input: Input,
  ctx: DurableTaskContext,
) => Output | Promise<Output>;
/**
 * Options used to create a durable task.
 */
export interface DurableTaskOptions<Input = unknown, Output = unknown> extends Omit<
  TaskOptions<Input, Output>,
  'run'
> {
  /**
   * Workflow store backing this task's runs — a store instance or a lazy
   * factory resolved once on first use. Defaults to a per-task
   * `memoryStore()` (checkpointing without persistence).
   */
  store?: Store | (() => Store | Promise<Store>);
  run: DurableTaskHandler<Input, Output>;
}
/**
 * Options for direct durable execution — `TaskRunOptions` plus per-run
 * durability overrides.
 */
export interface DurableTaskRunOptions extends TaskRunOptions {
  /** Store override for this run (wins over the task-level store). */
  store?: Store;
  /** Idempotency key recorded on the workflow run state. */
  key?: string;
}
/**
 * Options for the one-drive control surface (`start`, `resume`, `signalRun`).
 */
export interface DurableRunOptions {
  store?: Store;
  key?: string;
  signal?: AbortSignal;
  writer?: TaskOutputWriter;
}
/**
 * JSON-serializable snapshot of a durable run after one drive.
 */
export interface DurableRunHandle {
  runId: string;
  status: WorkflowStatus;
  waitingOn?: WorkflowWait;
  result?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
}

const _durableRunExtras = new Context<{
  store?: Store;
  key?: string;
}>('durableRunExtras');

let _nextDurableRunId = 0;

function _noopWriter(): TaskOutputWriter {
  return {
    mode: 'text',
    writeText: () => undefined,
  };
}

function _composeContext(taskCtx: TaskContext, wctx: WorkflowContext): DurableTaskContext {
  return {
    signal: taskCtx.signal,
    runId: taskCtx.runId,
    writer: taskCtx.writer,
    env: taskCtx.env,
    cwd: taskCtx.cwd,
    prompt: taskCtx.prompt,
    providedOptions: taskCtx.providedOptions,
    ...(taskCtx.optionProvided !== undefined
      ? { optionProvided: taskCtx.optionProvided.bind(taskCtx) }
      : {}),
    toolCallId: taskCtx.toolCallId,
    aiStep: taskCtx.step,
    messages: taskCtx.messages,
    history: taskCtx.history,
    workflowRunId: wctx.runId,
    state: wctx.state,
    step: (id, fn, opts) => wctx.step(id, fn, opts),
    call: (activity, input, opts) => wctx.call(activity, input, opts),
    sleep: (id, duration) => wctx.sleep(id, duration),
    waitForSignal: (name, opts) => wctx.waitForSignal(name, opts),
    suspend: () => {
      throw new Error(
        'suspend() is not available in durable tasks; use ctx.waitForSignal() for durable pauses',
      );
    },
  };
}

function _errorFromUnknown(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return {
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err) };
}

/**
 * A `Task` whose handler runs inside a durable `fino:workflow` execution.
 *
 * Construct via `durableTask()`. All `Task` surfaces (direct `run()`, CLI
 * `parse()`, AI `invoke()`) work unchanged; durability is added underneath by
 * a synthetic task handler that drives the workflow run.
 */
export class DurableTask<Input = unknown, Output = unknown> extends Task<Input, Output> {
  /**
   * Private property `#handler` — the user's durable handler.
   *
   * @internal
   */
  #handler: DurableTaskHandler<Input, Output>;
  /**
   * Private property `#storeSource` — store instance or lazy factory.
   *
   * @internal
   */
  #storeSource?: Store | (() => Store | Promise<Store>);
  /**
   * Private property `#storeInstance` — resolved task-level store.
   *
   * @internal
   */
  #storeInstance?: Promise<Store>;
  /**
   * Private property `#inputSchemaRaw` — schema forwarded to the workflow so
   * the one-drive surface validates input like `Task.run()` does.
   *
   * @internal
   */
  #inputSchemaRaw?: unknown;
  /**
   * Private property `#signalWakers` — in-process wakers per parked run, so
   * `signalRun()` can unblock a `run()` waiting on a signal park.
   *
   * @internal
   */
  #signalWakers = new Map<string, Set<() => void>>();
  /**
   * Create a durable task. Prefer the `durableTask()` factory.
   */
  constructor(opts: DurableTaskOptions<Input, Output>) {
    super({
      ...opts,
      run: (input, taskCtx) => this.#driveToCompletion(input, taskCtx),
    } as TaskOptions<Input, Output>);
    this.#handler = opts.run;
    this.#storeSource = opts.store;
    this.#inputSchemaRaw = opts.inputSchema;
  }
  /**
   * Run to completion, waiting out durable parks in-process.
   *
   * Timer parks self-resume at their due time; signal parks wait for a
   * matching `signalRun()` (or the park's own timeout). The workflow state is
   * checkpointed at every transition, so a run interrupted here can still be
   * resumed later from its store.
   *
   * ```ts no_run
   * import { durableTask } from 'fino:task/durable';
   *
   * const t = durableTask({ name: 'noop', run: async () => 'ok' });
   * await t.run(undefined, { runId: 'once' });
   * ```
   */
  override run(rawInput: Input, options: DurableTaskRunOptions = {}): Promise<Output> {
    const { store, key, ...base } = options;
    return _durableRunExtras.runWithValue(
      {
        ...(store !== undefined ? { store } : {}),
        ...(key !== undefined ? { key } : {}),
      },
      () => super.run(rawInput, base),
    );
  }
  /**
   * Drive a run once: start it (or resume it when `runId` exists in the
   * store) and return a serializable snapshot instead of waiting out parks.
   *
   * ```ts no_run
   * import { durableTask } from 'fino:task/durable';
   *
   * const t = durableTask({ name: 'nap', run: async (_i, ctx) => ctx.sleep('z', '1h') });
   * const handle = await t.start(undefined, {});
   * console.log(handle.status, handle.waitingOn?.type);
   * ```
   */
  async start(
    rawInput: Input,
    opts: DurableRunOptions & {
      runId?: string;
    } = {},
  ): Promise<DurableRunHandle> {
    const store = await this.#resolveStore(opts.store);
    const runId =
      opts.runId ?? `${this.name}-run-${Date.now().toString(36)}-${_nextDurableRunId++}`;
    return this.#driveOnce(store, runId, rawInput, opts, true);
  }
  /**
   * Resume a persisted run by one drive and return its snapshot.
   *
   * ```ts no_run
   * import { durableTask } from 'fino:task/durable';
   *
   * const t = durableTask({ name: 'nap', run: async (_i, ctx) => ctx.sleep('z', '1s') });
   * const handle = await t.resume('nap-run-1');
   * console.log(handle.status);
   * ```
   */
  async resume(runId: string, opts: DurableRunOptions = {}): Promise<DurableRunHandle> {
    const store = await this.#resolveStore(opts.store);
    return this.#driveOnce(store, runId, undefined, opts, false);
  }
  /**
   * Deliver an external signal to a parked run and wake any in-process
   * `run()` waiting on it. Does not drive the run — call `resume()` (or let
   * the waiting `run()` continue) to process the delivery.
   *
   * ```ts no_run
   * import { durableTask } from 'fino:task/durable';
   *
   * const t = durableTask({ name: 'gate', run: async (_i, ctx) => ctx.waitForSignal('go') });
   * await t.signalRun('gate-run-1', 'go', { ok: true });
   * ```
   */
  async signalRun(
    runId: string,
    name: string,
    payload?: unknown,
    opts: {
      store?: Store;
    } = {},
  ): Promise<void> {
    const store = await this.#resolveStore(opts.store);
    await this.#workflowFor().signal({
      store,
      runId,
      name,
      payload,
    });
    const wakers = this.#signalWakers.get(runId);
    if (wakers !== undefined) {
      for (const wake of [...wakers]) wake();
    }
  }
  /**
   * Private method `#workflowFor` — build the workflow definition around a
   * task context (a fresh cheap wrapper per drive; durable state lives in the
   * store, keyed by runId).
   *
   * @internal
   */
  #workflowFor(taskCtx?: TaskContext): Workflow<Input, Output> {
    const handler = this.#handler;
    const ctx: TaskContext = taskCtx ?? {
      signal: new AbortController().signal,
      writer: _noopWriter(),
    };
    return workflow<Input, Output>({
      id: this.name,
      ...(this.#inputSchemaRaw !== undefined ? { inputSchema: this.#inputSchemaRaw } : {}),
      run: (wctx, input) => handler(input, _composeContext(ctx, wctx)),
    });
  }
  /**
   * Private method `#resolveStore` used by `DurableTask`.
   *
   * @internal
   */
  #resolveStore(override?: Store): Promise<Store> {
    if (override !== undefined) return Promise.resolve(override);
    if (this.#storeInstance === undefined) {
      const source = this.#storeSource;
      this.#storeInstance = Promise.resolve(
        typeof source === 'function' ? source() : (source ?? memoryStore()),
      );
    }
    return this.#storeInstance;
  }
  /**
   * Private method `#startOrResume` — start a new run, or resume when state
   * for `runId` already exists (idempotent re-entry).
   *
   * @internal
   */
  async #startOrResume(
    wf: Workflow<Input, Output>,
    store: Store,
    runId: string | undefined,
    input: Input,
    key: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WorkflowResult<Output>> {
    if (runId !== undefined) {
      const existing = await loadWorkflowRun(store, runId);
      if (existing !== null) {
        return wf.resume({
          store,
          runId,
          ...(signal !== undefined ? { signal } : {}),
        });
      }
    }
    return wf.start(input, {
      store,
      ...(runId !== undefined ? { runId } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  }
  /**
   * Private method `#driveToCompletion` — the synthetic `Task` handler.
   *
   * @internal
   */
  async #driveToCompletion(input: Input, taskCtx: TaskContext): Promise<Output> {
    const extras = _durableRunExtras.get();
    const store = await this.#resolveStore(extras?.store);
    const wf = this.#workflowFor(taskCtx);
    let result = await this.#startOrResume(
      wf,
      store,
      taskCtx.runId,
      input,
      extras?.key,
      taskCtx.signal,
    );
    while (result.status === 'waiting') {
      const waiting = result.waitingOn!;
      if (waiting.type === 'timer') {
        await this.#delayUntil(waiting.dueAt, taskCtx.signal);
      } else {
        await this.#awaitSignalDelivery(result.runId, waiting.timeoutAt, taskCtx.signal);
      }
      result = await wf.resume({
        store,
        runId: result.runId,
        ...(taskCtx.signal !== undefined ? { signal: taskCtx.signal } : {}),
      });
    }
    if (result.status === 'cancelled') {
      throw new Error(`Durable task "${this.name}" run ${result.runId} was cancelled`);
    }
    return result.result as Output;
  }
  /**
   * Private method `#driveOnce` — one drive for the control surface, with
   * errors captured into the returned handle instead of thrown.
   *
   * @internal
   */
  async #driveOnce(
    store: Store,
    runId: string,
    input: unknown,
    opts: DurableRunOptions,
    allowStart: boolean,
  ): Promise<DurableRunHandle> {
    const taskCtx: TaskContext = {
      signal: opts.signal ?? new AbortController().signal,
      runId,
      writer: opts.writer ?? _noopWriter(),
    };
    const wf = this.#workflowFor(taskCtx);
    try {
      let result: WorkflowResult<Output>;
      if (allowStart) {
        result = await this.#startOrResume(wf, store, runId, input as Input, opts.key, opts.signal);
      } else {
        const existing = await loadWorkflowRun(store, runId);
        if (existing === null) {
          throw new Error(`Durable task "${this.name}" run ${runId} not found`);
        }
        result = await wf.resume({
          store,
          runId,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
      }
      return {
        runId: result.runId,
        status: result.status,
        ...(result.waitingOn !== undefined ? { waitingOn: result.waitingOn } : {}),
        ...(result.status === 'done' ? { result: result.result } : {}),
      };
    } catch (err) {
      const persisted = await loadWorkflowRun(store, runId);
      return {
        runId,
        status: persisted?.status === 'cancelled' ? 'cancelled' : 'error',
        error: persisted?.error ?? _errorFromUnknown(err),
      };
    }
  }
  /**
   * Private method `#delayUntil` — abortable absolute-deadline sleep.
   *
   * @internal
   */
  #delayUntil(dueAt: number, signal?: AbortSignal): Promise<void> {
    const ms = Math.max(0, dueAt - Date.now());
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Durable task run aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error('Durable task run aborted'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  /**
   * Private method `#awaitSignalDelivery` — wait for `signalRun()` (or the
   * park's timeout deadline) while a `run()` drive is parked on a signal.
   *
   * @internal
   */
  #awaitSignalDelivery(
    runId: string,
    timeoutAt: number | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Durable task run aborted'));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wakers = this.#signalWakers.get(runId) ?? new Set<() => void>();
      this.#signalWakers.set(runId, wakers);
      const settle = (err?: Error) => {
        wakers.delete(wake);
        if (wakers.size === 0) this.#signalWakers.delete(runId);
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err !== undefined) reject(err);
        else resolve();
      };
      const wake = () => settle();
      function onAbort() {
        settle(new Error('Durable task run aborted'));
      }
      wakers.add(wake);
      if (timeoutAt !== undefined) {
        timer = setTimeout(() => settle(), Math.max(0, timeoutAt - Date.now()));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
/**
 * Create a durable task.
 *
 * ```ts no_run
 * import { durableTask } from 'fino:task/durable';
 *
 * const t = durableTask({
 *   name: 'compact',
 *   run: async (_input, ctx) => ctx.step('work', () => 42),
 * });
 * ```
 */
export function durableTask<Input = unknown, Output = unknown>(
  opts: DurableTaskOptions<Input, Output>,
): DurableTask<Input, Output> {
  return new DurableTask(opts);
}
