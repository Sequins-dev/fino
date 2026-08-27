/**
 * internal:jobs/service — the jobs service: store ownership, the scheduler
 * loop, and processor management.
 *
 * One `JobsService` owns the single database connection for its file and the
 * absolute-deadline poller that fires cron schedules, recovers leases,
 * claims due jobs, and dispatches them to processors. It runs in the
 * orchestrator realm when jobs is used as runtime infrastructure, and
 * directly inside an application realm in local mode — same code, two homes.
 *
 * The sqlite `jobs` table is the real queue: the scheduler claims at most
 * the processors' free capacity, so processor-side queues stay ~empty and
 * exist only as a safety net. Each tick sweeps expired leases (recovering
 * work abandoned by dead workers), fires any due cron schedules, heartbeats
 * in-flight leases, then claims and dispatches. The poller re-arms to the
 * nearest absolute deadline across all pending work rather than polling on a
 * fixed interval, so an idle service is genuinely idle.
 *
 * This is the shared engine behind the public `fino:jobs` module. Application
 * code should use `Jobs` from `fino:jobs` rather than opening a service
 * directly; this module is imported by the runtime orchestrator and by
 * `fino:jobs`'s local-mode host.
 *
 * ```ts no_run
 * import { JobsService } from 'internal:jobs/service';
 * import { task } from 'fino:task';
 *
 * const greet = task({ name: 'greet', run: async (i: { who: string }) => `hi ${i.who}` });
 *
 * const svc = await JobsService.open({ path: './.fino/jobs.db' });
 * svc.processTasks([greet], { concurrency: 4 });
 * svc.start();
 *
 * const job = await svc.push('greet', { who: 'Ada' });
 * const done = await svc.waitFor(job.id);
 * console.log(done.status, done.result);
 * await svc.stop();
 * ```
 *
 * @internal
 */
import {
  JobsStore,
  backoffDelayMs,
  type JobRecord,
  type JobRetryPolicy,
  type JobStatus,
  type QueueStats,
  type ScheduleRecord,
} from './store.ts';
import { parseCron, nextOccurrence } from './cron.ts';
import { collectTasks, dispatchJob, type JobsWireCall, type JobsWireResult } from './runner.ts';
import { Realm, type ImportRule, type RealmOptions } from '../../realm/index.ts';
import { createStoreFacade } from '../store/facade.ts';
import type { Task } from '../../task.ts';
import {
  loadWorkflowRun,
  saveWorkflowRun,
  type WorkflowState,
  type WorkflowWait,
} from '../../workflow.ts';
import type { Store } from '../../store.ts';
import { topic, otelRuntimeTopic, otelRuntimeEvent } from '../opentelemetry/common.ts';

const _topicEnqueue = topic(otelRuntimeTopic('jobs', 'job', 'enqueue'));
const _topicStart = topic(otelRuntimeTopic('jobs', 'job', 'start'));
const _topicEnd = topic(otelRuntimeTopic('jobs', 'job', 'end'));
const _topicRetry = topic(otelRuntimeTopic('jobs', 'job', 'retry'));
const _topicDead = topic(otelRuntimeTopic('jobs', 'job', 'dead'));
const _topicPark = topic(otelRuntimeTopic('jobs', 'job', 'park'));
const _topicScheduleFire = topic(otelRuntimeTopic('jobs', 'schedule', 'fire'));
const _topicLeaseExpire = topic(otelRuntimeTopic('jobs', 'lease', 'expire'));

/**
 * A destination the scheduler can dispatch claimed jobs to.
 *
 * A processor advertises the task names it can execute and how many jobs it
 * can run concurrently; the scheduler never claims more than the summed free
 * capacity of its processors, so the sqlite table — not a processor-side
 * buffer — remains the queue of record. Each task name may be handled by at
 * most one registered processor (`processTasks`, `workers`, or
 * `_addExternalProcessor` throw on overlap).
 *
 * This is also the cluster seam: a future remote processor implements the
 * same interface over the cluster transport.
 *
 * ```ts no_run
 * import type { JobProcessor } from 'internal:jobs/service';
 * import { taskWorker } from 'internal:jobs/runner';
 *
 * const run = taskWorker(myTask);
 * const processor: JobProcessor = {
 *   kind: 'inline',
 *   taskNames: ['resize-image'],
 *   capacity: 8,
 *   run: (call) => run(call) as ReturnType<JobProcessor['run']>,
 *   close: async () => {},
 * };
 * ```
 *
 * @internal
 */
export interface JobProcessor {
  /** Whether jobs run on this realm's loop (`inline`) or in reactor-pooled Realm isolates (`realm`). */
  readonly kind: 'inline' | 'realm';
  /** The task names this processor can execute; each must be unique across all registered processors. */
  readonly taskNames: string[];
  /** Maximum jobs this processor runs at once — the scheduler claims no more than the free portion of this. */
  readonly capacity: number;
  /** Execute one claimed job envelope and resolve with its outcome (done, retryable/fatal error, or parked). */
  run(call: JobsWireCall): Promise<JobsWireResult>;
  /** Release processor resources. Called during `JobsService.stop()`. */
  close(): Promise<void>;
}

/**
 * Options accepted by `JobsService.open()`.
 *
 * `path` is the only required field: the sqlite file backing this service.
 * Exactly one service may own a given file per process. The remaining fields
 * tune the scheduler and default to production-safe values.
 *
 * ```ts no_run
 * import { JobsService } from 'internal:jobs/service';
 *
 * const svc = await JobsService.open({
 *   path: './.fino/jobs.db',
 *   id: 'worker-1',      // owner tag written onto claimed leases
 *   leaseMs: 30_000,     // how long a claim is held before the sweep recovers it
 *   pollIntervalMs: 30_000,
 *   closeTimeout: 5_000, // grace period for in-flight jobs during stop()
 * });
 * ```
 *
 * @internal
 */
export interface JobsServiceOptions {
  /** Path to the sqlite file backing this service; one service per file per process. */
  path: string;
  /** Owner tag stamped onto claimed leases; defaults to a random `jobs-<suffix>`. Identifies which service holds a lease. */
  id?: string;
  /** Lease duration in milliseconds (default 30000). A claim not heartbeated within this window is swept and requeued. */
  leaseMs?: number;
  /** Upper bound between scheduler ticks in milliseconds (default 30000); the poller re-arms sooner when work is due. */
  pollIntervalMs?: number;
  /** Grace period in milliseconds (default 5000) that `stop()` waits for in-flight dispatches to drain. */
  closeTimeout?: number;
}
/**
 * Options for pushing one job.
 *
 * All fields are optional; an empty options object enqueues onto the
 * `default` queue to run immediately with the default retry policy.
 *
 * ```ts no_run
 * await svc.push('send-email', { to: 'ada@example.com' }, {
 *   queue: 'mail',
 *   delay: '5m',          // run five minutes from now
 *   priority: 10,         // higher runs before lower at the same run time
 *   key: 'welcome:ada',   // dedupe: one active job per (queue, key)
 *   retry: { maxAttempts: 5 },
 *   timeoutMs: 30_000,
 * });
 * ```
 *
 * @internal
 */
export interface PushOptions {
  /** Target queue name; defaults to `default`. */
  queue?: string;
  /** When to run: a delay in ms, a duration string like `"5m"` (`ms|s|m|h|d`), or an absolute `Date`. Defaults to now. */
  delay?: number | string | Date;
  /** Claim ordering weight; higher-priority jobs at the same run time are claimed first. Defaults to 0. */
  priority?: number;
  /** Dedupe key: at most one active (non-terminal) job may exist per `(queue, key)`; a duplicate push is folded onto the existing job. */
  key?: string;
  /** Per-job overrides merged onto the default retry/backoff policy. */
  retry?: Partial<JobRetryPolicy>;
  /** Wall-clock budget for one attempt, in milliseconds; passed through to the processor. */
  timeoutMs?: number;
}
/**
 * Options for creating a named schedule.
 *
 * Exactly one of `cron` or `every` must be provided — `schedule()` throws
 * otherwise. `cron` is a five/six-field cron expression evaluated in UTC;
 * `every` is a duration string (e.g. `"30s"`, `"1h"`) for fixed-interval
 * firing.
 *
 * ```ts no_run
 * // Nightly cleanup at 02:00 UTC, skipping a run if the previous one still runs.
 * await svc.schedule('nightly-cleanup', 'cleanup', { scope: 'temp' }, {
 *   cron: '0 2 * * *',
 *   overlap: 'skip',
 *   catchup: 'skip',
 * });
 * ```
 *
 * @internal
 */
export interface ScheduleOptions {
  /** Cron expression (UTC) for the firing schedule; mutually exclusive with `every`. */
  cron?: string;
  /** Fixed interval as a duration string (e.g. `"30s"`); mutually exclusive with `cron`. */
  every?: string;
  /** Queue for jobs this schedule enqueues; defaults to `default`. */
  queue?: string;
  /** Input passed to each fired job. Falls back to the `input` argument of `schedule()` when omitted. */
  input?: unknown;
  /** `skip` (default) suppresses a firing while the schedule's previous job is still active; `allow` fires regardless. */
  overlap?: 'skip' | 'allow';
  /** Missed-firing policy after downtime: `skip` (default) drops overdue runs; `one` fires a single make-up job. */
  catchup?: 'skip' | 'one';
  /** Retry/backoff overrides for jobs this schedule enqueues. */
  retry?: Partial<JobRetryPolicy>;
}

const MAX_RUN_AT = 8640000000000000;
const DEFAULT_RETRY: JobRetryPolicy = {
  maxAttempts: 3,
  baseMs: 1e3,
  factor: 2,
  maxMs: 6e4,
  jitter: true,
};

function toRunAt(delay: number | string | Date | undefined): number {
  if (delay === undefined) return Date.now();
  if (delay instanceof Date) return delay.getTime();
  if (typeof delay === 'number') return Date.now() + delay;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(delay.trim());
  if (match === null)
    throw new Error(`delay "${delay}" must be a number, Date, or <n><ms|s|m|h|d>`);
  const scale = {
    ms: 1,
    s: 1e3,
    m: 6e4,
    h: 36e5,
    d: 864e5,
  }[match[2]!]!;
  return Date.now() + Number(match[1]) * scale;
}

function retryPolicy(partial?: Partial<JobRetryPolicy>): JobRetryPolicy {
  return {
    ...DEFAULT_RETRY,
    ...partial,
  };
}

function parkRunAt(waitingOn: WorkflowWait): number {
  if (waitingOn.type === 'timer') return waitingOn.dueAt;
  return waitingOn.timeoutAt ?? MAX_RUN_AT;
}

/**
 * The jobs service: owns the store connection, the scheduler poller, and the
 * set of registered processors.
 *
 * Construct with the async `JobsService.open()` factory (the constructor is
 * private). A freshly opened service is not running: register processors with
 * `processTasks`/`workers`, then call `start()` to arm the poller. `push()`
 * and `schedule()` may be called before `start()` — the work simply waits for
 * the loop to begin. Always `stop()` (or use `await using`) to drain in-flight
 * jobs and close the store.
 *
 * Delivery is at-least-once: a crash or expired lease reruns a job, so task
 * handlers must be idempotent. Durable (`fino:task/durable`) jobs park on
 * `ctx.sleep()` / `ctx.waitForSignal()` and are resumed from their last
 * checkpoint by this scheduler.
 *
 * ```ts no_run
 * import { JobsService } from 'internal:jobs/service';
 * import { task } from 'fino:task';
 *
 * const resize = task({ name: 'resize', run: async (i: { id: string }) => i.id });
 *
 * await using svc = await JobsService.open({ path: './.fino/jobs.db' });
 * svc.processTasks([resize], { concurrency: 4 });
 * svc.schedule('hourly-sweep', 'resize', { id: 'batch' }, { every: '1h' });
 * svc.start();
 *
 * const job = await svc.push('resize', { id: 'photo-1' }, { priority: 5 });
 * await svc.waitFor(job.id);
 * // `await using` calls stop() on scope exit.
 * ```
 *
 * @internal
 */
export class JobsService {
  #store: JobsStore;
  #workflowStore: Store;
  #id: string;
  #leaseMs: number;
  #pollIntervalMs: number;
  #closeTimeout: number;
  #closed = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticking = false;
  #tickAgain = false;
  #processors: JobProcessor[] = [];
  #inFlight = new Map<string, Promise<void>>();
  #inFlightByProcessor = new Map<JobProcessor, number>();
  private constructor(store: JobsStore, opts: JobsServiceOptions) {
    this.#store = store;
    this.#workflowStore = store.workflowStore();
    this.#id = opts.id ?? `jobs-${Math.random().toString(36).slice(2, 10)}`;
    this.#leaseMs = opts.leaseMs ?? 3e4;
    this.#pollIntervalMs = opts.pollIntervalMs ?? 3e4;
    this.#closeTimeout = opts.closeTimeout ?? 5e3;
  }
  /**
   * Open the backing sqlite store and construct the service.
   *
   * The returned service is idle — no poller is armed and no processors are
   * registered. Register processors and call `start()` to begin scheduling.
   * This is the only way to obtain a `JobsService`; the constructor is
   * private because opening the store is asynchronous.
   *
   * ```ts no_run
   * const svc = await JobsService.open({ path: './.fino/jobs.db', leaseMs: 60_000 });
   * ```
   *
   * @internal
   */
  static async open(opts: JobsServiceOptions): Promise<JobsService> {
    const store = await JobsStore.open(opts.path);
    return new JobsService(store, opts);
  }
  /**
   * The workflow-checkpoint store sharing this service's single database
   * connection.
   *
   * Durable jobs persist their run state through this view; it is exposed so
   * the jobs control facade and the `fino:jobs/checkpoints` worker facade can
   * proxy checkpoint reads and writes for realms that do not hold the
   * connection themselves.
   *
   * @internal
   */
  get workflowStore(): Store {
    return this.#workflowStore;
  }
  /**
   * Enqueue a job by task name and wake the scheduler.
   *
   * The job is persisted immediately and runs wherever a processor advertises
   * `task` — the name need not be registered on this service. When `opts.key`
   * is set and an active job already exists for `(queue, key)`, the push is
   * deduplicated onto that job rather than inserting a new row. Publishes a
   * `jobs.job.enqueue` telemetry event when subscribers are present.
   *
   * Throws if the service is closed, or if `opts.delay` is a malformed
   * duration string.
   *
   * ```ts no_run
   * const job = await svc.push('send-email', { to: 'ada@example.com' }, {
   *   queue: 'mail',
   *   delay: '30s',
   *   key: 'welcome:ada',
   * });
   * console.log(job.id, job.status); // 'pending'
   * ```
   *
   * @internal
   */
  async push(task: string, input: unknown, opts: PushOptions = {}): Promise<JobRecord> {
    if (this.#closed) throw new Error('jobs service is closed');
    const retry = retryPolicy(opts.retry);
    const { job, deduped } = await this.#store.insertJob({
      queue: opts.queue ?? 'default',
      task,
      input,
      runAt: toRunAt(opts.delay),
      priority: opts.priority ?? 0,
      maxAttempts: retry.maxAttempts,
      backoff: retry,
      timeoutMs: opts.timeoutMs ?? null,
      dedupeKey: opts.key ?? null,
    });
    if (_topicEnqueue.hasSubscribers) {
      _topicEnqueue.publish(
        otelRuntimeEvent('jobs', 'job', 'enqueue', {
          jobId: job.id,
          task: job.task,
          queue: job.queue,
          runAt: job.runAt,
          deduped,
        }),
      );
    }
    this.#wake();
    return job;
  }
  /**
   * Create or replace a named schedule that enqueues jobs over time.
   *
   * `name` is the schedule's stable identity: calling `schedule()` again with
   * the same name upserts (replaces) the existing schedule rather than adding
   * a second one. The cron/every spec is parsed and validated eagerly, and the
   * schedule's first firing is computed from now. The scheduler enqueues a job
   * each time the schedule comes due, honoring its `overlap` and `catchup`
   * policies.
   *
   * Throws if the service is closed, if neither `cron` nor `every` is given,
   * or if the spec fails to parse.
   *
   * ```ts no_run
   * await svc.schedule('report', 'daily-report', { format: 'pdf' }, {
   *   cron: '0 6 * * *',   // 06:00 UTC daily
   *   overlap: 'skip',
   * });
   * ```
   *
   * @internal
   */
  async schedule(
    name: string,
    task: string,
    input: unknown,
    opts: ScheduleOptions,
  ): Promise<ScheduleRecord> {
    if (this.#closed) throw new Error('jobs service is closed');
    const specText = opts.cron ?? (opts.every !== undefined ? `every:${opts.every}` : undefined);
    if (specText === undefined) throw new Error('schedule requires either cron or every');
    const spec = parseCron(specText);
    const record = await this.#store.upsertSchedule({
      id: name,
      task,
      input: input ?? opts.input ?? null,
      queue: opts.queue ?? 'default',
      spec: specText,
      overlap: opts.overlap ?? 'skip',
      catchup: opts.catchup ?? 'skip',
      retry: opts.retry !== undefined ? retryPolicy(opts.retry) : null,
      nextRunAt: nextOccurrence(spec, Date.now()),
    });
    this.#wake();
    return record;
  }
  /**
   * Remove a named schedule so it stops enqueuing new jobs.
   *
   * Resolves `true` if a schedule with that name existed and was deleted,
   * `false` if none matched. Jobs already enqueued by the schedule are not
   * affected.
   *
   * @internal
   */
  unschedule(name: string): Promise<boolean> {
    return this.#store.deleteSchedule(name);
  }
  /**
   * Load one job by id, or `null` if no such job exists.
   *
   * @internal
   */
  get(id: string): Promise<JobRecord | null> {
    return this.#store.getJob(id);
  }
  /**
   * List jobs, optionally filtered by queue, status, task, or originating
   * schedule, with `limit`/`offset` paging.
   *
   * With no filter, returns recent jobs across all queues.
   *
   * ```ts no_run
   * const failing = await svc.list({ status: 'error', queue: 'mail', limit: 50 });
   * ```
   *
   * @internal
   */
  list(filter?: {
    queue?: string;
    status?: JobStatus;
    task?: string;
    scheduleId?: string;
    limit?: number;
    offset?: number;
  }): Promise<JobRecord[]> {
    return this.#store.listJobs(filter ?? {});
  }
  /**
   * Aggregate per-status counts for one queue, or across all queues when
   * `queue` is omitted.
   *
   * Intended for dashboards and reactive read models; the result includes the
   * timestamp of the oldest pending job (or `null` when the queue is drained).
   *
   * @internal
   */
  stats(queue?: string): Promise<QueueStats> {
    return this.#store.queueStats(queue);
  }
  /**
   * List all named schedules and their next firing times.
   *
   * @internal
   */
  schedules(): Promise<ScheduleRecord[]> {
    return this.#store.listSchedules();
  }
  /**
   * Cancel a job, resolving `true` if its state changed.
   *
   * Pending and waiting jobs are moved to the terminal `cancelled` state so
   * the scheduler never claims them. A job already running is marked
   * cancelled but not forcibly interrupted (mark-only) — its current attempt
   * runs to completion.
   *
   * @internal
   */
  cancel(id: string): Promise<boolean> {
    return this.#store.cancel(id);
  }
  /**
   * Requeue a terminal job for another attempt and wake the scheduler.
   *
   * Resets a `done`, `error`, `dead`, or `cancelled` job back to pending so it
   * is claimed again. Resolves `true` when the job was requeued, `false` if it
   * was not in a terminal state (or does not exist).
   *
   * @internal
   */
  async retry(id: string): Promise<boolean> {
    const changed = await this.#store.retry(id);
    if (changed) this.#wake();
    return changed;
  }
  /**
   * Deliver an external signal to a parked durable job and wake it.
   *
   * Appends `{name, payload}` to the job's durable workflow run, flips the run
   * from `waiting` back to `running`, clears its wait, and re-arms the job so
   * the scheduler reclaims it. Used to satisfy a `ctx.waitForSignal(name)`
   * park in a durable task.
   *
   * Throws if the job does not exist, has no durable run, its run cannot be
   * loaded, it is not currently waiting for a signal, or it is waiting for a
   * signal of a different name.
   *
   * ```ts no_run
   * // A durable task parked on ctx.waitForSignal('approved'):
   * await svc.signal(jobId, 'approved', { by: 'admin' });
   * ```
   *
   * @internal
   */
  async signal(id: string, name: string, payload?: unknown): Promise<void> {
    const job = await this.#store.getJob(id);
    if (job === null) throw new Error(`job ${id} not found`);
    if (job.workflowRunId === null) throw new Error(`job ${id} has no durable run to signal`);
    const state = await loadWorkflowRun(this.#workflowStore, job.workflowRunId);
    if (state === null) throw new Error(`workflow run ${job.workflowRunId} not found`);
    if (state.status !== 'waiting' || state.waitingOn?.type !== 'signal') {
      throw new Error(`job ${id} is not waiting for a signal`);
    }
    if (state.waitingOn.name !== name) {
      throw new Error(`job ${id} is waiting for signal "${state.waitingOn.name}", not "${name}"`);
    }
    const next = {
      ...state,
      status: 'running',
      waitingOn: undefined,
      signals: [
        ...state.signals,
        {
          name,
          payload,
          receivedAt: Date.now(),
        },
      ],
    };
    await saveWorkflowRun(this.#workflowStore, next);
    await this.#store.wake(id);
    this.#wake();
  }
  /**
   * Poll until a job reaches a terminal state and resolve with its final
   * record.
   *
   * Terminal states are `done`, `error`, `dead`, and `cancelled`. This is a
   * convenience for scripts and tests; it polls with exponential backoff
   * (starting at 10ms, capped at 250ms) rather than subscribing to events.
   *
   * Throws if the job disappears while polling, or if `timeoutMs` (default
   * 30000) elapses before the job finishes.
   *
   * ```ts no_run
   * const job = await svc.push('resize', { id: 'photo-1' });
   * const done = await svc.waitFor(job.id, { timeoutMs: 60_000 });
   * if (done.status === 'done') console.log(done.result);
   * ```
   *
   * @internal
   */
  async waitFor(
    id: string,
    opts: {
      timeoutMs?: number;
    } = {},
  ): Promise<JobRecord> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3e4);
    let interval = 10;
    while (true) {
      const job = await this.#store.getJob(id);
      if (job === null) throw new Error(`job ${id} not found`);
      if (
        job.status === 'done' ||
        job.status === 'error' ||
        job.status === 'dead' ||
        job.status === 'cancelled'
      ) {
        return job;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for job ${id} (status: ${job.status})`);
      }
      await new Promise<void>((res) => setTimeout(res, interval));
      interval = Math.min(interval * 2, 250);
    }
  }
  /**
   * Register an inline processor that executes the given tasks on this realm's
   * event loop.
   *
   * Every task name reachable from `tasks` (including nested task
   * dependencies) becomes claimable, up to `opts.concurrency` jobs at once
   * (default 1). Inline processors share the current realm — cheap and simple,
   * but CPU-bound handlers block the loop; use `workers()` for isolation.
   * Returns the registered processor and wakes the scheduler.
   *
   * Throws if any task name is already handled by another registered
   * processor.
   *
   * ```ts no_run
   * import { task } from 'fino:task';
   * const resize = task({ name: 'resize', run: async (i) => i });
   * svc.processTasks([resize], { concurrency: 8 });
   * ```
   *
   * @internal
   */
  processTasks(
    tasks: Task[],
    opts: {
      concurrency?: number;
    } = {},
  ): JobProcessor {
    const registry = collectTasks(tasks);
    const workflowStore = this.#workflowStore;
    const processor: JobProcessor = {
      kind: 'inline',
      taskNames: [...registry.keys()],
      capacity: opts.concurrency ?? 1,
      run: (call) => dispatchJob(registry, call, workflowStore),
      close: async () => {},
    };
    this.#addProcessor(processor);
    return processor;
  }
  /**
   * Register a processor that dispatches each job into a reactor-pooled Realm.
   *
   * The `entry` module must default-export a `Task`; a Realm is queried for its
   * task names on startup and rejects if the entry does not report them.
   * `size` (default 1) sets how many jobs the service may dispatch concurrently.
   * Each job gets a fresh Realm isolate, and the process reactor pool places
   * those isolates across its worker threads. Workers reach this service's durable
   * checkpoint store through an injected `fino:jobs/checkpoints` facade, so
   * durable jobs resume correctly even though the workers do not own the
   * database connection. Any `realm.overrides` supplied by the caller are
   * preserved and the checkpoints facade is layered on top.
   *
   * Use this instead of `processTasks()` for CPU-heavy or isolation-sensitive
   * work. The returned promise rejects if the entry cannot be loaded or does
   * not export a `Task`.
   *
   * ```ts no_run
   * const processor = await svc.workers({
   *   entry: new URL('./workers/resize.ts', import.meta.url).pathname,
   *   size: 4,
   * });
   * console.log(processor.taskNames, processor.capacity);
   * ```
   *
   * @internal
   */
  async workers(opts: {
    entry: string;
    size?: number;
    realm?: Omit<RealmOptions, 'entry'>;
  }): Promise<JobProcessor> {
    const workflowStore = this.#workflowStore;
    const baseOverrides = opts.realm?.overrides;
    const createWorker = (): Realm => {
      const facade = createStoreFacade('fino:jobs/checkpoints', workflowStore);
      const rules: ImportRule[] = [
        ...(baseOverrides === undefined
          ? []
          : Array.isArray(baseOverrides)
            ? baseOverrides
            : baseOverrides.toRules()),
        {
          pattern: 'fino:jobs/checkpoints',
          directive: facade,
        },
      ];
      return new Realm({
        ...(opts.realm ?? {}),
        entry: opts.entry,
        overrides: rules,
      });
    };
    const callWorker = (
      call:
        | JobsWireCall
        | {
            kind: 'tasks';
          },
    ): Promise<unknown> => createWorker().call(call);
    let taskNames: string[];
    taskNames = (await callWorker({ kind: 'tasks' })) as string[];
    if (!Array.isArray(taskNames) || taskNames.some((n) => typeof n !== 'string')) {
      throw new Error(
        `worker entry "${opts.entry}" did not report its task names — it must default-export a Task`,
      );
    }
    const processor: JobProcessor = {
      kind: 'realm',
      taskNames,
      capacity: opts.size ?? 1,
      run: (call) => callWorker(call) as Promise<JobsWireResult>,
      close: async () => {},
    };
    this.#addProcessor(processor);
    return processor;
  }
  /**
   * Register a processor whose execution lives outside this service.
   *
   * The escape hatch for wiring in a `JobProcessor` implemented elsewhere —
   * for example an inline relay that forwards `run` calls to a client realm
   * over the jobs control facade, or a future remote/cluster processor. Same
   * uniqueness rule as the other registration methods: throws if any of the
   * processor's task names are already handled.
   *
   * @internal
   */
  _addExternalProcessor(processor: JobProcessor): void {
    this.#addProcessor(processor);
  }
  /**
   * Register a processor and initialize its in-flight counter, rejecting any
   * task name already claimed by another processor.
   *
   * @internal
   */
  #addProcessor(processor: JobProcessor): void {
    for (const name of processor.taskNames) {
      if (this.#processorFor(name) !== undefined) {
        throw new Error(`task "${name}" is already handled by another processor`);
      }
    }
    this.#processors.push(processor);
    this.#inFlightByProcessor.set(processor, 0);
    this.#wake();
  }
  /**
   * Find the registered processor that handles a given task name, or
   * `undefined` if none does.
   *
   * @internal
   */
  #processorFor(task: string): JobProcessor | undefined {
    return this.#processors.find((p) => p.taskNames.includes(task));
  }
  /**
   * Arm the scheduler poller so the service begins claiming and dispatching
   * jobs.
   *
   * Idempotent and a no-op once the service is closed; calling it a second
   * time does nothing. Jobs and schedules created before `start()` are picked
   * up on the first tick.
   *
   * @internal
   */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#wake();
  }
  /**
   * Schedule a scheduler tick to run as soon as possible, coalescing repeated
   * wakes.
   *
   * If a tick is already in progress, a re-tick is requested for when it
   * finishes; otherwise a zero-delay timer is armed (replacing any pending
   * re-arm). No-op until the service is started and while it is closed.
   *
   * @internal
   */
  #wake(): void {
    if (!this.#started || this.#closed) return;
    if (this.#ticking) {
      this.#tickAgain = true;
      return;
    }
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, 0);
  }
  /**
   * Run one scheduler pass, then re-arm to the next absolute deadline.
   *
   * A pass sweeps expired leases (emitting `jobs.lease.expire` events), fires
   * due cron schedules, heartbeats the leases of in-flight jobs, then claims
   * and dispatches ready work. Guarded so at most one tick runs at a time;
   * errors are logged rather than thrown so the loop survives a bad pass. If a
   * wake arrived mid-tick, another tick is scheduled immediately; otherwise it
   * re-arms via `#rearm()`.
   *
   * @internal
   */
  async #tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = Date.now();
      const swept = await this.#store.sweepLeases(now);
      if (_topicLeaseExpire.hasSubscribers) {
        for (const job of swept) {
          _topicLeaseExpire.publish(
            otelRuntimeEvent('jobs', 'lease', 'expire', {
              jobId: job.id,
              attempt: job.attempts,
              outcome: job.status === 'dead' ? 'dead' : 'requeued',
            }),
          );
        }
      }
      await this.#fireDueSchedules(now);
      if (this.#inFlight.size > 0) {
        await this.#store.heartbeat(this.#id, [...this.#inFlight.keys()], this.#leaseMs, now);
      }
      await this.#claimAndDispatch(now);
    } catch (err) {
      console.error(
        `fino:jobs scheduler tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    } finally {
      this.#ticking = false;
    }
    if (this.#closed) return;
    if (this.#tickAgain) {
      this.#tickAgain = false;
      this.#wake();
      return;
    }
    await this.#rearm();
  }
  /**
   * Re-arm the poller timer to the nearest future deadline.
   *
   * Wakes at the earliest of: the store's next due work, `pollIntervalMs` from
   * now (a ceiling so the loop never sleeps indefinitely), and — while jobs
   * are in flight — half the lease interval, so leases are heartbeated before
   * they expire. No-op if the service is closed or a timer is already armed.
   *
   * @internal
   */
  async #rearm(): Promise<void> {
    const now = Date.now();
    let wake = await this.#store.nextWakeAt();
    if (wake === null || wake > now + this.#pollIntervalMs) wake = now + this.#pollIntervalMs;
    if (this.#inFlight.size > 0) wake = Math.min(wake, now + this.#leaseMs / 2);
    if (this.#closed || this.#timer !== null) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        void this.#tick();
      },
      Math.max(0, wake - now),
    );
  }
  /**
   * Enqueue jobs for every schedule due at `now`, then advance each to its
   * next occurrence.
   *
   * Applies each schedule's policies before inserting: under `catchup: 'skip'`
   * a firing more than a minute overdue (missed during downtime) is dropped;
   * under `overlap: 'skip'` a firing is dropped while the schedule's previous
   * job is still active. Every due schedule advances its `nextRunAt`
   * regardless, and a `jobs.schedule.fire` event records whether the firing
   * produced a job or was skipped.
   *
   * @internal
   */
  async #fireDueSchedules(now: number): Promise<void> {
    for (const schedule of await this.#store.dueSchedules(now)) {
      const spec = parseCron(schedule.spec);
      const nextRunAt = nextOccurrence(spec, now);
      let skipped: string | null = null;
      // Catch-up policy: a schedule that is long overdue (missed while the
      // process was down) fires at most one make-up job under 'one' and
      // none under 'skip'.
      const overdueMs = now - schedule.nextRunAt;
      if (schedule.catchup === 'skip' && overdueMs > 6e4) {
        skipped = 'catchup';
      } else if (schedule.overlap === 'skip' && schedule.lastJobId !== null) {
        const last = await this.#store.getJob(schedule.lastJobId);
        if (
          last !== null &&
          (last.status === 'pending' ||
            last.status === 'claimed' ||
            last.status === 'running' ||
            last.status === 'waiting')
        ) {
          skipped = 'overlap';
        }
      }
      let jobId: string | null = null;
      if (skipped === null) {
        const retry = schedule.retry ?? DEFAULT_RETRY;
        const { job } = await this.#store.insertJob({
          queue: schedule.queue,
          task: schedule.task,
          input: schedule.input,
          runAt: now,
          maxAttempts: retry.maxAttempts,
          backoff: retry,
          scheduleId: schedule.id,
        });
        jobId = job.id;
      }
      await this.#store.advanceSchedule(
        schedule.id,
        nextRunAt,
        skipped === null
          ? {
              lastRunAt: now,
              lastJobId: jobId,
            }
          : undefined,
      );
      if (_topicScheduleFire.hasSubscribers) {
        _topicScheduleFire.publish(
          otelRuntimeEvent('jobs', 'schedule', 'fire', {
            scheduleId: schedule.id,
            jobId,
            skipped,
          }),
        );
      }
    }
  }
  /**
   * Claim up to the processors' combined free capacity and dispatch each
   * claimed job.
   *
   * Sums the spare capacity of every processor and collects the task names
   * they can serve, then claims at most that many ready jobs restricted to
   * those tasks. This capacity-bounded claim is what keeps the sqlite table
   * the queue of record — the service never pulls more work than it can
   * immediately run. No-op when nothing has free capacity.
   *
   * @internal
   */
  async #claimAndDispatch(now: number): Promise<void> {
    const eligible: string[] = [];
    let free = 0;
    for (const processor of this.#processors) {
      const processorFree = processor.capacity - (this.#inFlightByProcessor.get(processor) ?? 0);
      if (processorFree > 0) {
        free += processorFree;
        eligible.push(...processor.taskNames);
      }
    }
    if (free <= 0 || eligible.length === 0) return;
    const claimed = await this.#store.claimReady(this.#id, this.#leaseMs, free, now, eligible);
    for (const job of claimed) {
      const promise = this.#dispatch(job).catch(() => undefined);
      this.#inFlight.set(job.id, promise);
    }
  }
  /**
   * Run one claimed job through its processor and persist the outcome.
   *
   * Marks the job running, invokes the processor, and records the result: a
   * parked durable run moves to `waiting` (re-armed for its wake deadline); a
   * success moves to `done`; a retryable failure with attempts remaining is
   * rescheduled with backoff; anything else moves to `dead`. Maintains the
   * per-processor in-flight counter and emits `jobs.job.start`/`.end` plus the
   * matching outcome event. Always frees capacity and wakes the scheduler in
   * `finally`, even if the processor throws.
   *
   * @internal
   */
  async #dispatch(job: JobRecord): Promise<void> {
    const processor = this.#processorFor(job.task)!;
    this.#inFlightByProcessor.set(processor, (this.#inFlightByProcessor.get(processor) ?? 0) + 1);
    const startedAt = Date.now();
    const startPublished = _topicStart.hasSubscribers;
    if (startPublished) {
      _topicStart.publish(
        otelRuntimeEvent('jobs', 'job', 'start', {
          jobId: job.id,
          task: job.task,
          queue: job.queue,
          attempt: job.attempts,
        }),
      );
    }
    try {
      await this.#store.markRunning(job.id);
      const result = await processor.run({
        kind: 'run',
        jobId: job.id,
        task: job.task,
        input: job.input,
        attempt: job.attempts,
        ...(job.workflowRunId !== null ? { workflowRunId: job.workflowRunId } : {}),
        ...(job.timeoutMs !== null ? { timeoutMs: job.timeoutMs } : {}),
      });
      if ('parked' in result) {
        await this.#store.markWaiting(
          job.id,
          result.workflowRunId,
          result.waitingOn,
          parkRunAt(result.waitingOn),
        );
        if (_topicPark.hasSubscribers) {
          _topicPark.publish(
            otelRuntimeEvent('jobs', 'job', 'park', {
              jobId: job.id,
              workflowRunId: result.workflowRunId,
              waitingOn: result.waitingOn,
            }),
          );
        }
      } else if (result.ok) {
        await this.#store.markDone(job.id, result.output);
      } else if (result.error.retryable && job.attempts < job.maxAttempts) {
        const delay = backoffDelayMs(job.backoff, job.attempts);
        await this.#store.markRetry(job.id, Date.now() + delay, result.error);
        if (_topicRetry.hasSubscribers) {
          _topicRetry.publish(
            otelRuntimeEvent('jobs', 'job', 'retry', {
              jobId: job.id,
              attempt: job.attempts,
              message: result.error.message,
              nextRunAt: Date.now() + delay,
            }),
          );
        }
      } else {
        await this.#store.markDead(job.id, result.error);
        if (_topicDead.hasSubscribers) {
          _topicDead.publish(
            otelRuntimeEvent('jobs', 'job', 'dead', {
              jobId: job.id,
              attempt: job.attempts,
              message: result.error.message,
            }),
          );
        }
      }
      if (startPublished || _topicEnd.hasSubscribers) {
        _topicEnd.publish(
          otelRuntimeEvent('jobs', 'job', 'end', {
            jobId: job.id,
            task: job.task,
            queue: job.queue,
            attempt: job.attempts,
            durationMs: Date.now() - startedAt,
            status: 'parked' in result ? 'waiting' : result.ok ? 'done' : 'failed',
          }),
        );
      }
    } finally {
      this.#inFlight.delete(job.id);
      this.#inFlightByProcessor.set(
        processor,
        Math.max(0, (this.#inFlightByProcessor.get(processor) ?? 1) - 1),
      );
      this.#wake();
    }
  }
  /**
   * Stop the scheduler, drain in-flight dispatches, and close processors and
   * the store. In-flight work that outlives `closeTimeout` stays claimed and
   * is recovered by the lease sweep on the next start.
   *
   * Idempotent: a second call resolves immediately. After `stop()` the service
   * is permanently closed — `push()` and `schedule()` throw, and `start()` is
   * a no-op.
   *
   * ```ts no_run
   * const svc = await JobsService.open({ path: './.fino/jobs.db' });
   * svc.start();
   * // ... later, during shutdown:
   * await svc.stop();
   * ```
   *
   * @internal
   */
  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const drain = Promise.allSettled([...this.#inFlight.values()]);
    await Promise.race([drain, new Promise<void>((res) => setTimeout(res, this.#closeTimeout))]);
    for (const processor of this.#processors) {
      try {
        await processor.close();
      } catch {}
    }
    await this.#store.close();
  }
  /**
   * Async-dispose hook (`await using`) that calls `stop()` when the service
   * leaves scope.
   *
   * @internal
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
