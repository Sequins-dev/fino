/**
* fino:jobs — durable background jobs and cron schedules over sqlite.
*
* Work is described by `fino:task` tasks and delivered by name: a job row
* stores `{task, input}`, so anything pushed survives a restart and runs
* wherever that task name is registered. Task instances are worker
* definitions, registered separately from pushes — inline (`process()`) to
* run on this realm's loop, or as an exclusive worker pool (`workers()`)
* whose entry module default-exports a `Task`.
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
import type { JobRecord, JobRetryPolicy, JobStatus, QueueStats, ScheduleRecord } from './internal/jobs/store.ts';
import type { JobsService } from './internal/jobs/service.ts';
import type { JobsWireCall, JobsWireResult } from './internal/jobs/runner.ts';
import type { WorkflowState, WorkflowStore } from './workflow.ts';
import type { RealmOptions } from './realm/index.ts';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import { subscribeMatching } from 'fino:context/topic';

/**
* A job that could not complete and should not be retried.
*
* Throw from a task handler to send the job straight to the dead-letter
* state regardless of remaining attempts.
*/
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

/**
* Options for `Jobs.open()`.
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
*/
export interface JobsPushOptions {
  queue?: string;
  /** Delay before the job becomes due: ms, `<n><ms|s|m|h|d>`, or absolute Date. */
  delay?: number | string | Date;
  priority?: number;
  /** Dedupe key: at most one active job per (queue, key). */
  key?: string;
  retry?: Partial<JobRetryPolicy>;
  timeoutMs?: number;
}
/**
* Options for `Jobs.schedule()`.
*/
export interface JobsScheduleOptions {
  /** 5-field UTC cron expression or `@alias`. */
  cron?: string;
  /** Interval sugar: `<n><ms|s|m|h|d>`. */
  every?: string;
  queue?: string;
  overlap?: 'skip' | 'allow';
  catchup?: 'skip' | 'one';
  retry?: Partial<JobRetryPolicy>;
}
export type { JobRecord, JobRetryPolicy, JobStatus, QueueStats, ScheduleRecord };

function emptyQueueStats(): QueueStats {
  return {
    pending: 0,
    running: 0,
    waiting: 0,
    done: 0,
    error: 0,
    dead: 0,
    cancelled: 0,
    oldestPendingAt: null
  };
}

function isJobsRuntimeTopic(name: string): boolean {
  return name.startsWith('otel:runtime:jobs:');
}

interface ControlModule {
  open(opts: Record<string, unknown>): Promise<boolean>;
  push(task: string, input: unknown, opts: JobsPushOptions): Promise<JobRecord>;
  schedule(name: string, task: string, input: unknown, opts: JobsScheduleOptions): Promise<ScheduleRecord>;
  unschedule(name: string): Promise<boolean>;
  get(id: string): Promise<JobRecord | null>;
  list(filter: unknown): Promise<JobRecord[]>;
  stats(queue?: string): Promise<QueueStats>;
  schedules(): Promise<ScheduleRecord[]>;
  cancel(id: string): Promise<boolean>;
  retry(id: string): Promise<boolean>;
  signal(id: string, name: string, payload?: unknown): Promise<void>;
  waitFor(id: string, opts: {
    timeoutMs?: number;
  }): Promise<JobRecord>;
  registerWorkers(opts: {
    entry: string;
    size?: number;
  }): Promise<boolean>;
  registerInline(taskNames: string[], concurrency: number): Promise<number>;
  completeInline(relayIndex: number, jobId: string, result: JobsWireResult): Promise<void>;
  wfSave(state: WorkflowState): Promise<void>;
  wfLoad(runId: string): Promise<WorkflowState | null>;
  wfList(filter?: unknown): Promise<WorkflowState[]>;
  wfRemove(runId: string): Promise<void>;
  inlineCalls(relayIndex: number): AsyncIterable<JobsWireCall>;
}

/**
* Handle to the jobs system: pushes, schedules, worker registration, and
* job lifecycle operations. Create with `Jobs.open()`.
*/
export class Jobs {
  #service: JobsService | null;
  #control: ControlModule | null;
  #stopped = false;
  private constructor(service: JobsService | null, control: ControlModule | null) {
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
      control = await import('fino:jobs/control') as unknown as ControlModule;
    } catch {}
    let jobs: Jobs;
    if (control !== null) {
      await control.open({
        path: opts.path,
        ...opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {},
        ...opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {},
        ...opts.closeTimeout !== undefined ? { closeTimeout: opts.closeTimeout } : {}
      });
      jobs = new Jobs(null, control);
    } else {
      const { JobsService } = await import('internal:jobs/service') as {
        JobsService: typeof import('./internal/jobs/service.ts').JobsService;
      };
      const service = await JobsService.open({
        path: opts.path,
        ...opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {},
        ...opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {},
        ...opts.closeTimeout !== undefined ? { closeTimeout: opts.closeTimeout } : {}
      });
      service.start();
      jobs = new Jobs(service, null);
    }
    if (opts.tasks !== undefined && opts.tasks.length > 0) {
      await jobs.process({
        tasks: opts.tasks,
        ...opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}
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
    if (this.#control !== null) return this.#control.push(task, input, opts);
    return this.#requireService().push(task, input, opts);
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
  schedule(name: string, task: string, input: unknown, opts: JobsScheduleOptions): Promise<ScheduleRecord> {
    if (this.#control !== null) return this.#control.schedule(name, task, input, opts);
    return this.#requireService().schedule(name, task, input, opts);
  }
  /**
  * Remove a named schedule. Returns whether it existed.
  */
  unschedule(name: string): Promise<boolean> {
    if (this.#control !== null) return this.#control.unschedule(name);
    return this.#requireService().unschedule(name);
  }
  /**
  * Load one job by id.
  */
  get(id: string): Promise<JobRecord | null> {
    if (this.#control !== null) return this.#control.get(id);
    return this.#requireService().get(id);
  }
  /**
  * List jobs, newest first.
  */
  list(filter: {
    queue?: string;
    status?: JobStatus;
    task?: string;
    scheduleId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<JobRecord[]> {
    if (this.#control !== null) return this.#control.list(filter);
    return this.#requireService().list(filter);
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
        const source = this.#control !== null ? this.#control.stats(queue) : this.#requireService().stats(queue);
        void source.then((stats) => {
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
    if (this.#control !== null) return this.#control.schedules();
    return this.#requireService().schedules();
  }
  /**
  * Cancel a job. Pending and parked jobs cancel immediately; a running
  * job is marked cancelled but its in-flight execution is not interrupted.
  */
  cancel(id: string): Promise<boolean> {
    if (this.#control !== null) return this.#control.cancel(id);
    return this.#requireService().cancel(id);
  }
  /**
  * Requeue a dead, errored, or cancelled job from attempt zero. Durable
  * jobs keep their workflow run and resume from the last checkpoint.
  */
  retry(id: string): Promise<boolean> {
    if (this.#control !== null) return this.#control.retry(id);
    return this.#requireService().retry(id);
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
    if (this.#control !== null) return this.#control.signal(id, name, payload);
    return this.#requireService().signal(id, name, payload);
  }
  /**
  * Wait for a job to reach a terminal state.
  */
  wait(id: string, opts: {
    timeoutMs?: number;
  } = {}): Promise<JobRecord> {
    if (this.#control !== null) return this.#control.waitFor(id, opts);
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
        finish(() => reject(new Error(`timed out waiting for job ${id}${job ? ` (status: ${job.status})` : ''}`)));
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
  async process(opts: {
    tasks: Task[];
    concurrency?: number;
  }): Promise<void> {
    if (this.#control !== null) {
      const { collectTasks, dispatchJob } = await import('internal:jobs/runner') as typeof import('./internal/jobs/runner.ts');
      const registry = collectTasks(opts.tasks);
      const control = this.#control;
      const store: WorkflowStore = {
        save: (state) => control.wfSave(state),
        load: (runId) => control.wfLoad(runId),
        list: (filter) => control.wfList(filter as never),
        delete: (runId) => control.wfRemove(runId)
      };
      const relayIndex = await control.registerInline([...registry.keys()], opts.concurrency ?? 1);
      void (async () => {
        try {
          for await (const call of control.inlineCalls(relayIndex)) {
            void dispatchJob(registry, call as JobsWireCall, store).then((result) => control.completeInline(relayIndex, (call as JobsWireCall).jobId, result), (err) => control.completeInline(relayIndex, (call as JobsWireCall).jobId, {
              ok: false,
              error: {
                message: err instanceof Error ? err.message : String(err),
                retryable: true
              }
            }));
          }
        } catch {
          // Stream ends when the app realm or service shuts down.
        }
      })();
      return;
    }
    this.#requireService().processTasks(opts.tasks, {
      ...opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}
    });
  }
  /**
  * Register a pool processor: an exclusive worker pool whose entry module
  * default-exports a `Task` (children included). Each job runs in a fresh
  * worker realm.
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
    realm?: Omit<RealmOptions, 'entry' | 'thread'>;
  }): Promise<void> {
    if (this.#control !== null) {
      await this.#control.registerWorkers({
        entry: opts.entry,
        ...opts.size !== undefined ? { size: opts.size } : {}
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
