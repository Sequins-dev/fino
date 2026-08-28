/**
 * fino:jobs — durable background jobs and cron schedules over sqlite.
 *
 * Work is described by `fino:task` tasks and delivered by name: a job row
 * stores `{task, input}`, so anything pushed survives a restart and runs
 * wherever that task name is registered. Task instances are worker
 * definitions, registered separately from pushes — inline (`process()`) to
 * run on this realm's loop, or in reactor-pooled isolates (`workers()`) whose
 * entry module default-exports a `Task`.
 *
 * Delivery is **at-least-once**: a crash after side effects or an expired
 * lease reruns the job, so handlers must be idempotent. `fino:task/durable`
 * tasks are the built-in idempotency tool — a retried durable job resumes
 * its workflow run from the last checkpoint instead of starting over, and
 * its `ctx.sleep()` / `ctx.waitForSignal()` parks are woken by this module's
 * scheduler.
 *
 * ## Two homes, one behavior
 *
 * Under `fino run`, the orchestrator hosts the jobs service and this module
 * becomes a thin client over the injected `fino:jobs/control` facade — the
 * scheduler and its single database connection outlive the app realm. In
 * any other realm (tests, embedded library use), `Jobs.open()` hosts the
 * service locally. The sqlite file must have exactly one service per
 * process, and one process per file.
 *
 * Cron expressions evaluate in UTC (see `internal:jobs/cron`); `@daily`
 * means midnight UTC.
 *
 * @example
 * ```ts no_run
 * import { task } from 'fino:task';
 * import { Jobs } from 'fino:jobs';
 *
 * const greet = task({
 *   name: 'greet',
 *   run: async (input: { name: string }) => `hello ${input.name}`,
 * });
 *
 * await using jobs = await Jobs.open({ path: './.fino/jobs.db', tasks: [greet] });
 * const job = await jobs.push('greet', { name: 'Ada' });
 * const done = await jobs.wait(job.id);
 * console.log(done.result);
 * ```
 */
import type { Task } from './task.ts';
import type { JobsService } from './internal/jobs/service.ts';
import type { JobsWireCall, JobsWireResult } from './internal/jobs/runner.ts';
import { storeFromFacade, type StoreFacadeModule } from './internal/store/facade.ts';
import type { RealmOptions } from './realm/index.ts';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import { subscribeMatching } from 'fino:context/topic';

/**
 * Job lifecycle states stored in `JobRecord.status`.
 *
 * Terminal states are `done`, `error`, `dead`, and `cancelled`; `wait()`
 * resolves when a job reaches one of those states.
 */
export type JobStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'done'
  | 'error'
  | 'dead'
  | 'cancelled';

/**
 * Retry/backoff policy copied onto each job.
 *
 * Attempts are delayed by `baseMs * factor ** (attempt - 1)`, capped at
 * `maxMs`. When `jitter` is true, the computed delay is randomized between
 * zero and the capped delay to avoid retry bursts.
 *
 * Every field is required here; `JobsPushOptions.retry` and
 * `JobsScheduleOptions.retry` accept a `Partial<JobRetryPolicy>` and merge it
 * over the service defaults.
 *
 * ```ts no_run
 * import type { JobRetryPolicy } from 'fino:jobs';
 *
 * const policy: JobRetryPolicy = {
 *   maxAttempts: 5,
 *   baseMs: 1000,
 *   factor: 2,
 *   maxMs: 60_000,
 *   jitter: true,
 * };
 * ```
 */
export interface JobRetryPolicy {
  /** Total attempts before the job is dead-lettered, including the first run. */
  maxAttempts: number;
  /** Delay of the first retry, and the base of the exponential backoff. */
  baseMs: number;
  /** Multiplier applied per attempt: attempt `n` waits `baseMs * factor ** (n - 1)`. */
  factor: number;
  /** Ceiling on the computed delay so backoff does not grow without bound. */
  maxMs: number;
  /** When true, randomize each delay in `[0, computed]` to spread out retry bursts. */
  jitter: boolean;
}

/**
 * Persisted job row returned by `push()`, `get()`, `list()`, `job()`, and
 * `wait()`.
 *
 * Timestamps are epoch milliseconds. `input`, `result`, `waitingOn`, and
 * `error` are JSON-compatible values stored in the jobs database. Active jobs
 * may have `claimedBy` / `claimedUntil` set while a worker owns their lease;
 * terminal jobs set `finishedAt`.
 *
 * ```ts no_run
 * import { Jobs } from 'fino:jobs';
 *
 * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
 * const record = await jobs.get('job-id');
 * if (record !== null && record.status === 'error') {
 *   console.error(`${record.task} failed after ${record.attempts} attempts:`, record.error?.message);
 * }
 * ```
 */
export interface JobRecord {
  /** Unique job id assigned at push time. */
  id: string;
  /** Queue the job belongs to; scopes dedupe and stats. */
  queue: string;
  /** Registered task name that will run this job. */
  task: string;
  /** JSON-compatible input passed to the task handler. */
  input: unknown;
  /** Current lifecycle state. */
  status: JobStatus;
  /** Sort priority among jobs due at the same time; higher runs first. */
  priority: number;
  /** Earliest epoch-ms time the job may be claimed. */
  runAt: number;
  /** Number of attempts made so far. */
  attempts: number;
  /** Maximum attempts before dead-lettering, copied from the retry policy. */
  maxAttempts: number;
  /** Retry/backoff policy for this job, or `null` to use service defaults. */
  backoff: JobRetryPolicy | null;
  /** Per-attempt timeout in milliseconds, or `null` for no timeout. */
  timeoutMs: number | null;
  /** Dedupe key that reserves the `(queue, key)` slot while active, or `null`. */
  dedupeKey: string | null;
  /** Worker id holding the current lease, or `null` when unclaimed. */
  claimedBy: string | null;
  /** Epoch-ms expiry of the current lease, or `null` when unclaimed. */
  claimedUntil: number | null;
  /** Durable workflow run id backing this job, or `null` for a plain job. */
  workflowRunId: string | null;
  /** Signal or condition a parked durable job is waiting on, if any. */
  waitingOn: unknown;
  /** Id of the schedule that enqueued this job, or `null` if pushed directly. */
  scheduleId: string | null;
  /** Return value of a `done` job; otherwise `null`/undefined. */
  result: unknown;
  /** Failure details for an `error` or `dead` job, or `null`. */
  error: {
    message: string;
    stack?: string;
  } | null;
  /** Epoch-ms creation time. */
  createdAt: number;
  /** Epoch-ms time of the last state change. */
  updatedAt: number;
  /** Epoch-ms time the job reached a terminal state, or `null` while active. */
  finishedAt: number | null;
}

/**
 * Aggregate counts for one queue or all queues.
 *
 * Returned by the live `Jobs.stats()` signal. `oldestPendingAt` is the oldest
 * due pending job timestamp, or `null` when there is no pending work.
 *
 * ```ts no_run
 * import { Jobs } from 'fino:jobs';
 *
 * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
 * const stats = jobs.stats('emails');
 * stats.subscribe((s) => {
 *   if (s.oldestPendingAt !== null && Date.now() - s.oldestPendingAt > 60_000) {
 *     console.warn(`emails queue is backing up: ${s.pending} pending`);
 *   }
 * });
 * ```
 */
export interface QueueStats {
  /** Jobs that are due and awaiting a claim. */
  pending: number;
  /** Jobs currently executing on a worker. */
  running: number;
  /** Durable jobs parked on a signal or sleep. */
  waiting: number;
  /** Jobs that completed successfully. */
  done: number;
  /** Jobs that failed their last attempt and may still retry. */
  error: number;
  /** Jobs that exhausted retries or were dead-lettered. */
  dead: number;
  /** Jobs cancelled before completion. */
  cancelled: number;
  /** Epoch-ms timestamp of the oldest due pending job, or `null` when idle. */
  oldestPendingAt: number | null;
}

/**
 * Persisted schedule row returned by `schedule()` and `schedules()`.
 *
 * `spec` is the normalized cron or interval expression. `nextRunAt` and
 * `lastRunAt` are epoch milliseconds; `lastJobId` links to the most recently
 * enqueued job when one exists.
 *
 * ```ts no_run
 * import { Jobs } from 'fino:jobs';
 *
 * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
 * for (const s of await jobs.schedules()) {
 *   console.log(`${s.id} (${s.spec}) next runs at ${new Date(s.nextRunAt).toISOString()}`);
 * }
 * ```
 */
export interface ScheduleRecord {
  /** Schedule name, unique per service; passed to `schedule()`/`unschedule()`. */
  id: string;
  /** Task name enqueued on each occurrence. */
  task: string;
  /** JSON-compatible input passed to every enqueued job. */
  input: unknown;
  /** Queue that jobs from this schedule are pushed to. */
  queue: string;
  /** Normalized cron or interval expression driving the cadence. */
  spec: string;
  /** Whether the schedule is currently active. */
  enabled: boolean;
  /** Overlap policy when a prior scheduled job is still active. */
  overlap: 'skip' | 'allow';
  /** Catch-up policy for occurrences missed during downtime. */
  catchup: 'skip' | 'one';
  /** Retry policy copied onto each enqueued job, or `null` for defaults. */
  retry: JobRetryPolicy | null;
  /** Epoch-ms time of the next due occurrence. */
  nextRunAt: number;
  /** Epoch-ms time the schedule last fired, or `null` if it never has. */
  lastRunAt: number | null;
  /** Id of the most recently enqueued job, or `null` if none exists. */
  lastJobId: string | null;
  /** Epoch-ms creation time. */
  createdAt: number;
  /** Epoch-ms time of the last modification. */
  updatedAt: number;
}

/**
 * A job that could not complete and should not be retried.
 *
 * Throw from a task handler to send the job straight to the dead-letter
 * state regardless of remaining attempts. Use it for failures that cannot
 * succeed on a retry — malformed input, a permanent 4xx from an upstream
 * service, or a business-rule rejection.
 *
 * ```ts no_run
 * import { task } from 'fino:task';
 * import { NonRetryableJobError } from 'fino:jobs';
 *
 * const charge = task({
 *   name: 'charge',
 *   run: async (input: { amount: number }) => {
 *     if (input.amount <= 0) {
 *       throw new NonRetryableJobError(`invalid amount: ${input.amount}`);
 *     }
 *     return input.amount;
 *   },
 * });
 * ```
 */
export class NonRetryableJobError extends Error {
  /** Construct the error with a human-readable failure reason. */
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

/**
 * Options for `Jobs.open()`.
 *
 * `path` is the only required field. Supplying `tasks` registers inline
 * workers in the same call, equivalent to a follow-up `process()`; the
 * remaining fields tune the locally-hosted service and are ignored when a
 * runtime orchestrator already hosts the jobs service.
 *
 * ```ts no_run
 * import { task } from 'fino:task';
 * import { Jobs } from 'fino:jobs';
 *
 * const resize = task({ name: 'resize', run: async () => null });
 *
 * await using jobs = await Jobs.open({
 *   path: './.fino/jobs.db',
 *   tasks: [resize],
 *   concurrency: 4,
 *   leaseMs: 30_000,
 * });
 * ```
 */
export interface JobsOptions {
  /** Path to the sqlite database file backing jobs, schedules, and durable runs. */
  path: string;
  /** Inline worker definitions: task trees this realm executes directly. */
  tasks?: Task[];
  /** Concurrency for the inline processor (default 1). */
  concurrency?: number;
  /** Worker lease duration; expired leases are requeued or dead-lettered. */
  leaseMs?: number;
  /** Fallback poll interval for work created outside this process. */
  pollIntervalMs?: number;
  /** How long `stop()` waits for in-flight jobs before letting leases recover them. */
  closeTimeout?: number;
}
/**
 * Options for `Jobs.push()`.
 *
 * All fields are optional; an empty object enqueues an immediately-due job on
 * the `default` queue. Combine `delay` with `key` to schedule debounced work,
 * or `priority` with `retry` to control ordering and failure handling.
 *
 * ```ts no_run
 * import { Jobs } from 'fino:jobs';
 *
 * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
 * await jobs.push('send-digest', { userId: 42 }, {
 *   queue: 'emails',
 *   delay: '1h',
 *   key: 'digest:42',
 *   priority: 10,
 *   retry: { maxAttempts: 3 },
 *   timeoutMs: 15_000,
 * });
 * ```
 */
export interface JobsPushOptions {
  /**
   * Queue name used for ordering, stats, and worker selection.
   *
   * Defaults to `'default'`. Jobs in different queues are independent for
   * dedupe and queue-level stats, but all queues share the same backing store.
   */
  queue?: string;
  /**
   * Delay before the job becomes claimable.
   *
   * A number is milliseconds from now, a string accepts `<n><ms|s|m|h|d>`, and
   * a `Date` is treated as an absolute run time. Omit it to make the job due
   * immediately.
   */
  delay?: number | string | Date;
  /**
   * Sort priority among jobs that are due at the same time.
   *
   * Higher numbers are claimed first. Defaults to `0`.
   */
  priority?: number;
  /**
   * Dedupe key for active work in this queue.
   *
   * When set, at most one non-terminal job may exist for `(queue, key)`.
   * Finished, dead, cancelled, or errored jobs release the key.
   */
  key?: string;
  /**
   * Retry policy overrides for this job.
   *
   * Values are merged with the service defaults. Throw
   * `NonRetryableJobError` from a handler to bypass retries and dead-letter
   * the job immediately.
   */
  retry?: Partial<JobRetryPolicy>;
  /**
   * Per-attempt timeout in milliseconds.
   *
   * When set, a running attempt that exceeds this duration is treated as a
   * failed attempt and follows the retry policy.
   */
  timeoutMs?: number;
}
/**
 * Options for `Jobs.schedule()`.
 *
 * Exactly one of `cron` or `every` sets the cadence; the rest tune overlap,
 * catch-up after downtime, the target queue, and the retry policy copied onto
 * each enqueued job. Cron cadences evaluate in UTC.
 *
 * ```ts no_run
 * import { Jobs } from 'fino:jobs';
 *
 * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
 * await jobs.schedule('nightly-report', 'report', {}, {
 *   cron: '0 3 * * *',
 *   queue: 'reports',
 *   overlap: 'skip',
 *   catchup: 'one',
 *   retry: { maxAttempts: 2 },
 * });
 * ```
 */
export interface JobsScheduleOptions {
  /**
   * Five-field UTC cron expression or supported alias such as `@daily`.
   *
   * Use either `cron` or `every`, not both. Cron schedules are evaluated in
   * UTC.
   */
  cron?: string;
  /**
   * Fixed interval schedule using `<n><ms|s|m|h|d>` syntax.
   *
   * Use either `every` or `cron`, not both.
   */
  every?: string;
  /**
   * Queue used for jobs created by this schedule.
   *
   * Defaults to `'default'`.
   */
  queue?: string;
  /**
   * Overlap behavior when a previous scheduled job is still active.
   *
   * `'skip'` avoids enqueueing another job while one from this schedule is
   * pending, running, waiting, claimed, or errored. `'allow'` always enqueues
   * the due occurrence.
   */
  overlap?: 'skip' | 'allow';
  /**
   * Catch-up behavior after downtime or delayed scheduler ticks.
   *
   * `'skip'` advances to the next future occurrence without backfilling.
   * `'one'` enqueues at most one missed occurrence.
   */
  catchup?: 'skip' | 'one';
  /**
   * Retry policy applied to jobs created by the schedule.
   *
   * Values are copied onto each enqueued job when it is created.
   */
  retry?: Partial<JobRetryPolicy>;
}

function emptyQueueStats(): QueueStats {
  return {
    pending: 0,
    running: 0,
    waiting: 0,
    done: 0,
    error: 0,
    dead: 0,
    cancelled: 0,
    oldestPendingAt: null,
  };
}

function isJobsRuntimeTopic(name: string): boolean {
  return name.startsWith('otel:runtime:jobs:');
}

interface JobsBackend {
  push(task: string, input: unknown, opts: JobsPushOptions): Promise<JobRecord>;
  schedule(
    name: string,
    task: string,
    input: unknown,
    opts: JobsScheduleOptions,
  ): Promise<ScheduleRecord>;
  unschedule(name: string): Promise<boolean>;
  get(id: string): Promise<JobRecord | null>;
  list(filter: unknown): Promise<JobRecord[]>;
  stats(queue?: string): Promise<QueueStats>;
  schedules(): Promise<ScheduleRecord[]>;
  cancel(id: string): Promise<boolean>;
  retry(id: string): Promise<boolean>;
  signal(id: string, name: string, payload?: unknown): Promise<void>;
  waitFor(
    id: string,
    opts: {
      timeoutMs?: number;
    },
  ): Promise<JobRecord>;
}

interface ControlModule extends JobsBackend {
  open(opts: Record<string, unknown>): Promise<boolean>;
  registerWorkers(opts: { entry: string; size?: number }): Promise<boolean>;
  registerInline(taskNames: string[], concurrency: number): Promise<number>;
  completeInline(relayIndex: number, jobId: string, result: JobsWireResult): Promise<void>;
  inlineCalls(relayIndex: number): AsyncIterable<JobsWireCall>;
}

/**
 * Handle to the jobs system: pushes, schedules, worker registration, and
 * job lifecycle operations. Create with `Jobs.open()`.
 */
export class Jobs {
  #backend: JobsBackend;
  #service: JobsService | null;
  #control: ControlModule | null;
  #stopped = false;
  private constructor(
    backend: JobsBackend,
    service: JobsService | null,
    control: ControlModule | null,
  ) {
    this.#backend = backend;
    this.#service = service;
    this.#control = control;
  }
  /**
   * Open the jobs system.
   *
   * Detects the orchestrator's `fino:jobs/control` facade and becomes a
   * client of the runtime-hosted service when present; otherwise hosts the
   * service in this realm.
   *
   * ```ts no_run
   * import { Jobs } from 'fino:jobs';
   *
   * await using jobs = await Jobs.open({ path: './.fino/jobs.db' });
   * ```
   */
  static async open(opts: JobsOptions): Promise<Jobs> {
    let control: ControlModule | null = null;
    try {
      control = (await import('fino:jobs/control')) as unknown as ControlModule;
    } catch {}
    let jobs: Jobs;
    if (control !== null) {
      await control.open({
        path: opts.path,
        ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
        ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
        ...(opts.closeTimeout !== undefined ? { closeTimeout: opts.closeTimeout } : {}),
      });
      jobs = new Jobs(control, null, control);
    } else {
      const { JobsService } = (await import('internal:jobs/service')) as {
        JobsService: typeof import('./internal/jobs/service.ts').JobsService;
      };
      const service = await JobsService.open({
        path: opts.path,
        ...(opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {}),
        ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
        ...(opts.closeTimeout !== undefined ? { closeTimeout: opts.closeTimeout } : {}),
      });
      service.start();
      jobs = new Jobs(service as unknown as JobsBackend, service, null);
    }
    if (opts.tasks !== undefined && opts.tasks.length > 0) {
      await jobs.process({
        tasks: opts.tasks,
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      });
    }
    return jobs;
  }
  /**
   * Enqueue a job by task name.
   *
   * Task instances are never pushed — a job row must be restorable from the
   * database alone, so work requests carry only the name and input.
   *
   * ```ts no_run
   * import { Jobs } from 'fino:jobs';
   *
   * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
   * await jobs.push('ingest', { url: 'https://example.com' }, { delay: '5s' });
   * ```
   */
  push(task: string, input: unknown, opts: JobsPushOptions = {}): Promise<JobRecord> {
    return this.#backend.push(task, input, opts);
  }
  /**
   * Create or replace a named schedule that enqueues `task` on a cron or
   * interval cadence (UTC).
   *
   * ```ts no_run
   * import { Jobs } from 'fino:jobs';
   *
   * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
   * await jobs.schedule('nightly-compact', 'compact', {}, { cron: '@daily' });
   * ```
   */
  schedule(
    name: string,
    task: string,
    input: unknown,
    opts: JobsScheduleOptions,
  ): Promise<ScheduleRecord> {
    return this.#backend.schedule(name, task, input, opts);
  }
  /**
   * Remove a named schedule. Returns whether it existed.
   */
  unschedule(name: string): Promise<boolean> {
    return this.#backend.unschedule(name);
  }
  /**
   * Load one job by id.
   */
  get(id: string): Promise<JobRecord | null> {
    return this.#backend.get(id);
  }
  /**
   * List jobs, newest first.
   */
  list(
    filter: {
      queue?: string;
      status?: JobStatus;
      task?: string;
      scheduleId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<JobRecord[]> {
    return this.#backend.list(filter);
  }
  /**
   * Watch one job by id.
   *
   * The signal is seeded from `get(id)` while subscribed and refreshes when
   * local jobs runtime events mention the same job. A periodic reconcile also
   * runs while hot so missed external writes eventually converge.
   */
  job(id: string): ReadonlySignal<JobRecord | null> {
    return lazy<JobRecord | null>(null, (set) => {
      let active = true;
      const refresh = () => {
        void this.get(id).then((job) => {
          if (active) set(job);
        });
      };
      refresh();
      const handle = subscribeMatching<Record<string, unknown>>(isJobsRuntimeTopic, (event) => {
        if (event.jobId === id) refresh();
      });
      const timer = setInterval(refresh, 5000);
      return () => {
        active = false;
        clearInterval(timer);
        handle.dispose();
      };
    });
  }
  /**
   * Watch aggregate queue statistics.
   *
   * The signal starts when subscribed, refreshes from the jobs store on runtime
   * job events, and reconciles every five seconds while hot.
   */
  stats(queue?: string): ReadonlySignal<QueueStats> {
    return lazy<QueueStats>(emptyQueueStats(), (set) => {
      let active = true;
      const refresh = () => {
        void this.#backend.stats(queue).then((stats) => {
          if (active) set(stats);
        });
      };
      refresh();
      const handle = subscribeMatching<Record<string, unknown>>(isJobsRuntimeTopic, (event) => {
        if (queue === undefined || event.queue === queue) refresh();
      });
      const timer = setInterval(refresh, 5000);
      return () => {
        active = false;
        clearInterval(timer);
        handle.dispose();
      };
    });
  }
  /**
   * List schedules.
   */
  schedules(): Promise<ScheduleRecord[]> {
    return this.#backend.schedules();
  }
  /**
   * Cancel a job. Pending and parked jobs cancel immediately; a running
   * job is marked cancelled but its in-flight execution is not interrupted.
   */
  cancel(id: string): Promise<boolean> {
    return this.#backend.cancel(id);
  }
  /**
   * Requeue a dead, errored, or cancelled job from attempt zero. Durable
   * jobs keep their workflow run and resume from the last checkpoint.
   */
  retry(id: string): Promise<boolean> {
    return this.#backend.retry(id);
  }
  /**
   * Deliver an external signal to a parked durable job and make it claimable.
   *
   * ```ts no_run
   * import { Jobs } from 'fino:jobs';
   *
   * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
   * await jobs.signal('job-id', 'approved', { by: 'ada' });
   * ```
   */
  signal(id: string, name: string, payload?: unknown): Promise<void> {
    return this.#backend.signal(id, name, payload);
  }
  /**
   * Wait for a job to reach a terminal state.
   */
  wait(
    id: string,
    opts: {
      timeoutMs?: number;
    } = {},
  ): Promise<JobRecord> {
    if (this.#control !== null) return this.#backend.waitFor(id, opts);
    const terminal = new Set<JobStatus>(['done', 'error', 'dead', 'cancelled']);
    const signal = this.job(id);
    return new Promise<JobRecord>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        dispose();
        fn();
      };
      const dispose = signal.subscribe((job) => {
        if (job === null) return;
        if (terminal.has(job.status)) finish(() => resolve(job));
      });
      timer = setTimeout(async () => {
        const job = await this.get(id);
        finish(() =>
          reject(
            new Error(`timed out waiting for job ${id}${job ? ` (status: ${job.status})` : ''}`),
          ),
        );
      }, opts.timeoutMs ?? 3e4);
    });
  }
  /**
   * Register this realm as an inline processor for `tasks`: claimed jobs for
   * those task names execute on this realm's event loop.
   *
   * ```ts no_run
   * import { task } from 'fino:task';
   * import { Jobs } from 'fino:jobs';
   *
   * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
   * await jobs.process({ tasks: [task({ name: 'noop', run: async () => null })] });
   * ```
   */
  async process(opts: { tasks: Task[]; concurrency?: number }): Promise<void> {
    if (this.#control !== null) {
      const { collectTasks, dispatchJob } =
        (await import('internal:jobs/runner')) as typeof import('./internal/jobs/runner.ts');
      const registry = collectTasks(opts.tasks);
      const control = this.#control;
      const checkpointModule =
        (await import('fino:jobs/checkpoints')) as unknown as StoreFacadeModule;
      const store = storeFromFacade(checkpointModule);
      const relayIndex = await control.registerInline([...registry.keys()], opts.concurrency ?? 1);
      void (async () => {
        try {
          for await (const call of control.inlineCalls(relayIndex)) {
            void dispatchJob(registry, call as JobsWireCall, store).then(
              (result) => control.completeInline(relayIndex, (call as JobsWireCall).jobId, result),
              (err) =>
                control.completeInline(relayIndex, (call as JobsWireCall).jobId, {
                  ok: false,
                  error: {
                    message: err instanceof Error ? err.message : String(err),
                    retryable: true,
                  },
                }),
            );
          }
        } catch {
          // Stream ends when the app realm or service shuts down.
        }
      })();
      return;
    }
    this.#requireService().processTasks(opts.tasks, {
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    });
  }
  /**
   * Register a reactor-isolate processor whose entry module default-exports a
   * `Task` (children included). Each job runs in a fresh Realm scheduled by
   * the process-wide reactor pool.
   *
   * ```ts no_run
   * import { Jobs } from 'fino:jobs';
   *
   * const jobs = await Jobs.open({ path: './.fino/jobs.db' });
   * await jobs.workers({ entry: './handlers/ingest.ts', size: 4 });
   * ```
   */
  async workers(opts: {
    entry: string;
    size?: number;
    realm?: Omit<RealmOptions, 'entry'>;
  }): Promise<void> {
    if (this.#control !== null) {
      await this.#control.registerWorkers({
        entry: opts.entry,
        ...(opts.size !== undefined ? { size: opts.size } : {}),
      });
      return;
    }
    await this.#requireService().workers(opts);
  }
  /**
   * Stop the locally-hosted service (drain, then close). In client mode the
   * runtime owns the service lifecycle and this is a no-op.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#service !== null) await this.#service.stop();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
  /**
   * Private method `#requireService` used by `Jobs`.
   *
   * @internal
   */
  #requireService(): JobsService {
    if (this.#service === null) throw new Error('fino:jobs is not open');
    return this.#service;
  }
}
