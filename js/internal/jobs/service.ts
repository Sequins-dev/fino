/**
* internal/jobs/service — the jobs service: store ownership, the scheduler
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
* exist only as a safety net.
*
* @internal
*/
import { JobsStore, backoffDelayMs, type JobRecord, type JobRetryPolicy, type JobStatus, type QueueStats, type ScheduleRecord } from './store.ts';
import { parseCron, nextOccurrence } from './cron.ts';
import { collectTasks, dispatchJob, type JobsWireCall, type JobsWireResult } from './runner.ts';
import { RealmPool } from '../../realm/pool.ts';
import { Facade, type ImportRule, type RealmOptions } from '../../realm/index.ts';
import type { Task } from '../../task.ts';
import type { WorkflowState, WorkflowStore, WorkflowWait } from '../../workflow.ts';
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
* This is also the cluster seam: a future remote processor implements the
* same interface over the cluster transport.
*
* @internal
*/
export interface JobProcessor {
  readonly kind: 'inline' | 'pool';
  readonly taskNames: string[];
  readonly capacity: number;
  run(call: JobsWireCall): Promise<JobsWireResult>;
  close(): Promise<void>;
}

/**
* Options accepted by `JobsService.open()`.
*
* @internal
*/
export interface JobsServiceOptions {
  path: string;
  id?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  closeTimeout?: number;
}
/**
* Options for pushing one job.
*
* @internal
*/
export interface PushOptions {
  queue?: string;
  delay?: number | string | Date;
  priority?: number;
  key?: string;
  retry?: Partial<JobRetryPolicy>;
  timeoutMs?: number;
}
/**
* Options for creating a named schedule.
*
* @internal
*/
export interface ScheduleOptions {
  cron?: string;
  every?: string;
  queue?: string;
  input?: unknown;
  overlap?: 'skip' | 'allow';
  catchup?: 'skip' | 'one';
  retry?: Partial<JobRetryPolicy>;
}

const MAX_RUN_AT = 8640000000000000;
const DEFAULT_RETRY: JobRetryPolicy = {
  maxAttempts: 3,
  baseMs: 1e3,
  factor: 2,
  maxMs: 6e4,
  jitter: true
};

function toRunAt(delay: number | string | Date | undefined): number {
  if (delay === undefined) return Date.now();
  if (delay instanceof Date) return delay.getTime();
  if (typeof delay === 'number') return Date.now() + delay;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(delay.trim());
  if (match === null) throw new Error(`delay "${delay}" must be a number, Date, or <n><ms|s|m|h|d>`);
  const scale = {
    ms: 1,
    s: 1e3,
    m: 6e4,
    h: 36e5,
    d: 864e5
  }[match[2]!]!;
  return Date.now() + Number(match[1]) * scale;
}

function retryPolicy(partial?: Partial<JobRetryPolicy>): JobRetryPolicy {
  return {
    ...DEFAULT_RETRY,
    ...partial
  };
}

function parkRunAt(waitingOn: WorkflowWait): number {
  if (waitingOn.type === 'timer') return waitingOn.dueAt;
  return waitingOn.timeoutAt ?? MAX_RUN_AT;
}

/**
* The jobs service. Construct with `JobsService.open()`.
*
* @internal
*/
export class JobsService {
  #store: JobsStore;
  #workflowStore: WorkflowStore;
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
  * Open the backing store and construct the service (not yet started).
  *
  * @internal
  */
  static async open(opts: JobsServiceOptions): Promise<JobsService> {
    const store = await JobsStore.open(opts.path);
    return new JobsService(store, opts);
  }
  /**
  * The workflow store view sharing this service's connection — exposed so
  * facades can proxy durable checkpoints for worker realms.
  *
  * @internal
  */
  get workflowStore(): WorkflowStore {
    return this.#workflowStore;
  }
  /**
  * Enqueue a job by task name.
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
      dedupeKey: opts.key ?? null
    });
    if (_topicEnqueue.hasSubscribers) {
      _topicEnqueue.publish(otelRuntimeEvent('jobs', 'job', 'enqueue', {
        jobId: job.id,
        task: job.task,
        queue: job.queue,
        runAt: job.runAt,
        deduped
      }));
    }
    this.#wake();
    return job;
  }
  /**
  * Create or replace a named schedule.
  *
  * @internal
  */
  async schedule(name: string, task: string, input: unknown, opts: ScheduleOptions): Promise<ScheduleRecord> {
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
      nextRunAt: nextOccurrence(spec, Date.now())
    });
    this.#wake();
    return record;
  }
  /**
  * Remove a named schedule.
  *
  * @internal
  */
  unschedule(name: string): Promise<boolean> {
    return this.#store.deleteSchedule(name);
  }
  /**
  * Load one job.
  *
  * @internal
  */
  get(id: string): Promise<JobRecord | null> {
    return this.#store.getJob(id);
  }
  /**
  * List jobs.
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
  * Aggregate queue counts for dashboards and reactive read models.
  *
  * @internal
  */
  stats(queue?: string): Promise<QueueStats> {
    return this.#store.queueStats(queue);
  }
  /**
  * List schedules.
  *
  * @internal
  */
  schedules(): Promise<ScheduleRecord[]> {
    return this.#store.listSchedules();
  }
  /**
  * Cancel a job (mark-only for running jobs in v1).
  *
  * @internal
  */
  cancel(id: string): Promise<boolean> {
    return this.#store.cancel(id);
  }
  /**
  * Requeue a terminal job.
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
  * @internal
  */
  async signal(id: string, name: string, payload?: unknown): Promise<void> {
    const job = await this.#store.getJob(id);
    if (job === null) throw new Error(`job ${id} not found`);
    if (job.workflowRunId === null) throw new Error(`job ${id} has no durable run to signal`);
    const state = await this.#workflowStore.load(job.workflowRunId) as WorkflowState | null;
    if (state === null) throw new Error(`workflow run ${job.workflowRunId} not found`);
    if (state.status !== 'waiting' || state.waitingOn?.type !== 'signal') {
      throw new Error(`job ${id} is not waiting for a signal`);
    }
    if (state.waitingOn.name !== name) {
      throw new Error(`job ${id} is waiting for signal "${state.waitingOn.name}", not "${name}"`);
    }
    await this.#workflowStore.save({
      ...state,
      status: 'running',
      waitingOn: undefined,
      signals: [...state.signals, {
        name,
        payload,
        receivedAt: Date.now()
      }]
    });
    await this.#store.wake(id);
    this.#wake();
  }
  /**
  * Wait for a job to reach a terminal state (polling helper for scripts and
  * tests).
  *
  * @internal
  */
  async waitFor(id: string, opts: {
    timeoutMs?: number;
  } = {}): Promise<JobRecord> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3e4);
    let interval = 10;
    while (true) {
      const job = await this.#store.getJob(id);
      if (job === null) throw new Error(`job ${id} not found`);
      if (job.status === 'done' || job.status === 'error' || job.status === 'dead' || job.status === 'cancelled') {
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
  * Register an inline processor executing tasks on this realm's loop.
  *
  * @internal
  */
  processTasks(tasks: Task[], opts: {
    concurrency?: number;
  } = {}): JobProcessor {
    const registry = collectTasks(tasks);
    const workflowStore = this.#workflowStore;
    const processor: JobProcessor = {
      kind: 'inline',
      taskNames: [...registry.keys()],
      capacity: opts.concurrency ?? 1,
      run: (call) => dispatchJob(registry, call, workflowStore),
      close: async () => {}
    };
    this.#addProcessor(processor);
    return processor;
  }
  /**
  * Register a pool processor: an exclusive `RealmPool` whose entry
  * default-exports a `Task`. The pool workers receive durable checkpoints
  * through a `fino:jobs/checkpoints` facade bound to this service's store.
  *
  * @internal
  */
  async workers(opts: {
    entry: string;
    size?: number;
    realm?: Omit<RealmOptions, 'entry' | 'thread'>;
  }): Promise<JobProcessor> {
    const workflowStore = this.#workflowStore;
    const facade = new Facade('fino:jobs/checkpoints', ['save', 'load', 'list', 'remove'])
      .handle('save', (state) => workflowStore.save(state as WorkflowState))
      .handle('load', (runId) => workflowStore.load(runId as string))
      .handle('list', (filter) => workflowStore.list(filter as never))
      .handle('remove', (runId) => workflowStore.delete(runId as string));
    const baseOverrides = opts.realm?.overrides;
    const rules: ImportRule[] = [
      ...baseOverrides === undefined ? [] : Array.isArray(baseOverrides) ? baseOverrides : baseOverrides.toRules(),
      {
        pattern: 'fino:jobs/checkpoints',
        directive: facade
      }
    ];
    const pool = new RealmPool({
      entry: opts.entry,
      size: opts.size ?? 1,
      exclusive: true,
      timeout: 0,
      realm: {
        ...opts.realm ?? {},
        overrides: rules
      }
    });
    let taskNames: string[];
    try {
      taskNames = await pool.call({ kind: 'tasks' }) as string[];
      if (!Array.isArray(taskNames) || taskNames.some((n) => typeof n !== 'string')) {
        throw new Error(`worker entry "${opts.entry}" did not report its task names — it must default-export a Task`);
      }
    } catch (err) {
      await pool.close();
      throw err;
    }
    const processor: JobProcessor = {
      kind: 'pool',
      taskNames,
      capacity: pool.size,
      run: (call) => pool.call(call) as Promise<JobsWireResult>,
      close: () => pool.close()
    };
    this.#addProcessor(processor);
    return processor;
  }
  /**
  * Register a processor implemented elsewhere (e.g. an inline relay whose
  * execution lives in a client realm).
  *
  * @internal
  */
  _addExternalProcessor(processor: JobProcessor): void {
    this.#addProcessor(processor);
  }
  /**
  * Private method `#addProcessor` used by `JobsService`.
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
  * Private method `#processorFor` used by `JobsService`.
  *
  * @internal
  */
  #processorFor(task: string): JobProcessor | undefined {
    return this.#processors.find((p) => p.taskNames.includes(task));
  }
  /**
  * Start the scheduler loop.
  *
  * @internal
  */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#wake();
  }
  /**
  * Private method `#wake` — run a tick soon (coalesced).
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
  * Private method `#tick` — one scheduler pass, then re-arm to the next
  * absolute deadline.
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
          _topicLeaseExpire.publish(otelRuntimeEvent('jobs', 'lease', 'expire', {
            jobId: job.id,
            attempt: job.attempts,
            outcome: job.status === 'dead' ? 'dead' : 'requeued'
          }));
        }
      }
      await this.#fireDueSchedules(now);
      if (this.#inFlight.size > 0) {
        await this.#store.heartbeat(this.#id, [...this.#inFlight.keys()], this.#leaseMs, now);
      }
      await this.#claimAndDispatch(now);
    } catch (err) {
      console.error(`fino:jobs scheduler tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
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
  * Private method `#rearm` used by `JobsService`.
  *
  * @internal
  */
  async #rearm(): Promise<void> {
    const now = Date.now();
    let wake = await this.#store.nextWakeAt();
    if (wake === null || wake > now + this.#pollIntervalMs) wake = now + this.#pollIntervalMs;
    if (this.#inFlight.size > 0) wake = Math.min(wake, now + this.#leaseMs / 2);
    if (this.#closed || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, Math.max(0, wake - now));
  }
  /**
  * Private method `#fireDueSchedules` used by `JobsService`.
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
        if (last !== null && (last.status === 'pending' || last.status === 'claimed' || last.status === 'running' || last.status === 'waiting')) {
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
          scheduleId: schedule.id
        });
        jobId = job.id;
      }
      await this.#store.advanceSchedule(schedule.id, nextRunAt, skipped === null ? {
        lastRunAt: now,
        lastJobId: jobId
      } : undefined);
      if (_topicScheduleFire.hasSubscribers) {
        _topicScheduleFire.publish(otelRuntimeEvent('jobs', 'schedule', 'fire', {
          scheduleId: schedule.id,
          jobId,
          skipped
        }));
      }
    }
  }
  /**
  * Private method `#claimAndDispatch` used by `JobsService`.
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
  * Private method `#dispatch` — run one claimed job through its processor
  * and record the outcome.
  *
  * @internal
  */
  async #dispatch(job: JobRecord): Promise<void> {
    const processor = this.#processorFor(job.task)!;
    this.#inFlightByProcessor.set(processor, (this.#inFlightByProcessor.get(processor) ?? 0) + 1);
    const startedAt = Date.now();
    const startPublished = _topicStart.hasSubscribers;
    if (startPublished) {
      _topicStart.publish(otelRuntimeEvent('jobs', 'job', 'start', {
        jobId: job.id,
        task: job.task,
        queue: job.queue,
        attempt: job.attempts
      }));
    }
    try {
      await this.#store.markRunning(job.id);
      const result = await processor.run({
        kind: 'run',
        jobId: job.id,
        task: job.task,
        input: job.input,
        attempt: job.attempts,
        ...job.workflowRunId !== null ? { workflowRunId: job.workflowRunId } : {},
        ...job.timeoutMs !== null ? { timeoutMs: job.timeoutMs } : {}
      });
      if ('parked' in result) {
        await this.#store.markWaiting(job.id, result.workflowRunId, result.waitingOn, parkRunAt(result.waitingOn));
        if (_topicPark.hasSubscribers) {
          _topicPark.publish(otelRuntimeEvent('jobs', 'job', 'park', {
            jobId: job.id,
            workflowRunId: result.workflowRunId,
            waitingOn: result.waitingOn
          }));
        }
      } else if (result.ok) {
        await this.#store.markDone(job.id, result.output);
      } else if (result.error.retryable && job.attempts < job.maxAttempts) {
        const delay = backoffDelayMs(job.backoff, job.attempts);
        await this.#store.markRetry(job.id, Date.now() + delay, result.error);
        if (_topicRetry.hasSubscribers) {
          _topicRetry.publish(otelRuntimeEvent('jobs', 'job', 'retry', {
            jobId: job.id,
            attempt: job.attempts,
            message: result.error.message,
            nextRunAt: Date.now() + delay
          }));
        }
      } else {
        await this.#store.markDead(job.id, result.error);
        if (_topicDead.hasSubscribers) {
          _topicDead.publish(otelRuntimeEvent('jobs', 'job', 'dead', {
            jobId: job.id,
            attempt: job.attempts,
            message: result.error.message
          }));
        }
      }
      if (startPublished || _topicEnd.hasSubscribers) {
        _topicEnd.publish(otelRuntimeEvent('jobs', 'job', 'end', {
          jobId: job.id,
          task: job.task,
          queue: job.queue,
          attempt: job.attempts,
          durationMs: Date.now() - startedAt,
          status: 'parked' in result ? 'waiting' : result.ok ? 'done' : 'failed'
        }));
      }
    } finally {
      this.#inFlight.delete(job.id);
      this.#inFlightByProcessor.set(processor, Math.max(0, (this.#inFlightByProcessor.get(processor) ?? 1) - 1));
      this.#wake();
    }
  }
  /**
  * Stop the scheduler, drain in-flight dispatches, and close processors and
  * the store. In-flight work that outlives `closeTimeout` stays claimed and
  * is recovered by the lease sweep on the next start.
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
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
