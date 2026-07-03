/**
* internal/jobs/store — sqlite persistence for fino:jobs.
*
* Owns the `jobs`, `schedules`, and `workflow_runs` tables. Claims are
* atomic (`UPDATE ... RETURNING` over an ordered subquery), leases recover
* work from dead workers, and a partial unique index enforces at most one
* *active* job per `(queue, dedupe_key)` — terminal jobs never block a
* re-push.
*
* ## One connection by design
*
* The VFS provides real advisory locking (flock-backed), so multiple
* connections to one file are safe — but this store still keeps a single
* connection per service on purpose: workflow checkpoints for durable jobs
* share it (see `workflowStore()`), and worker realms reach the store
* through the jobs control facade, so the common path never contends on
* file locks. WAL journaling needs VFS shared-memory support that does not
* exist yet, so the journal mode is TRUNCATE.
*
* All timestamps are epoch milliseconds stored as INTEGER columns and
* converted back to `number` at this boundary (`safeIntegers` is on, so raw
* reads yield `bigint`).
*
* @internal
*/
import { Database, type SqlValue } from 'fino:database/sqlite';
import { v7 as uuidv7 } from 'fino:uuid';
import type { WorkflowState, WorkflowStatus, WorkflowStore } from 'fino:workflow';

/**
* Job lifecycle states.
*
* @internal
*/
export type JobStatus = 'pending' | 'claimed' | 'running' | 'waiting' | 'done' | 'error' | 'dead' | 'cancelled';
/**
* Retry/backoff policy stored per job.
*
* @internal
*/
export interface JobRetryPolicy {
  maxAttempts: number;
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: boolean;
}
/**
* One persisted job row.
*
* @internal
*/
export interface JobRecord {
  id: string;
  queue: string;
  task: string;
  input: unknown;
  status: JobStatus;
  priority: number;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  backoff: JobRetryPolicy | null;
  timeoutMs: number | null;
  dedupeKey: string | null;
  claimedBy: string | null;
  claimedUntil: number | null;
  workflowRunId: string | null;
  waitingOn: unknown;
  scheduleId: string | null;
  result: unknown;
  error: {
    message: string;
    stack?: string;
  } | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}
/**
* One persisted schedule row.
*
* @internal
*/
export interface ScheduleRecord {
  id: string;
  task: string;
  input: unknown;
  queue: string;
  spec: string;
  enabled: boolean;
  overlap: 'skip' | 'allow';
  catchup: 'skip' | 'one';
  retry: JobRetryPolicy | null;
  nextRunAt: number;
  lastRunAt: number | null;
  lastJobId: string | null;
  createdAt: number;
  updatedAt: number;
}
/**
* Fields accepted when inserting a job.
*
* @internal
*/
export interface InsertJob {
  queue: string;
  task: string;
  input: unknown;
  runAt: number;
  priority?: number;
  maxAttempts?: number;
  backoff?: JobRetryPolicy | null;
  timeoutMs?: number | null;
  dedupeKey?: string | null;
  scheduleId?: string | null;
}

function toNum(v: SqlValue): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  throw new Error(`expected numeric column, got ${typeof v}`);
}
function toNumOrNull(v: SqlValue): number | null {
  if (v === null || v === undefined) return null;
  return toNum(v);
}
function toStrOrNull(v: SqlValue): string | null {
  return v === null || v === undefined ? null : String(v);
}
function parseJsonOrNull(v: SqlValue): unknown {
  const text = toStrOrNull(v);
  return text === null ? null : JSON.parse(text);
}

function rowToJob(row: Record<string, SqlValue>): JobRecord {
  return {
    id: String(row.id),
    queue: String(row.queue),
    task: String(row.task),
    input: parseJsonOrNull(row.input),
    status: String(row.status) as JobStatus,
    priority: toNum(row.priority!),
    runAt: toNum(row.run_at!),
    attempts: toNum(row.attempts!),
    maxAttempts: toNum(row.max_attempts!),
    backoff: parseJsonOrNull(row.backoff) as JobRetryPolicy | null,
    timeoutMs: toNumOrNull(row.timeout_ms),
    dedupeKey: toStrOrNull(row.dedupe_key),
    claimedBy: toStrOrNull(row.claimed_by),
    claimedUntil: toNumOrNull(row.claimed_until),
    workflowRunId: toStrOrNull(row.workflow_run_id),
    waitingOn: parseJsonOrNull(row.waiting_on),
    scheduleId: toStrOrNull(row.schedule_id),
    result: parseJsonOrNull(row.result),
    error: parseJsonOrNull(row.error) as JobRecord['error'],
    createdAt: toNum(row.created_at!),
    updatedAt: toNum(row.updated_at!),
    finishedAt: toNumOrNull(row.finished_at)
  };
}
function rowToSchedule(row: Record<string, SqlValue>): ScheduleRecord {
  return {
    id: String(row.id),
    task: String(row.task),
    input: parseJsonOrNull(row.input),
    queue: String(row.queue),
    spec: String(row.spec),
    enabled: toNum(row.enabled!) === 1,
    overlap: String(row.overlap) as 'skip' | 'allow',
    catchup: String(row.catchup) as 'skip' | 'one',
    retry: parseJsonOrNull(row.retry) as JobRetryPolicy | null,
    nextRunAt: toNum(row.next_run_at!),
    lastRunAt: toNumOrNull(row.last_run_at),
    lastJobId: toStrOrNull(row.last_job_id),
    createdAt: toNum(row.created_at!),
    updatedAt: toNum(row.updated_at!)
  };
}

const ACTIVE_STATUSES = "('pending','claimed','running','waiting')";

/**
* SQLite-backed job and schedule persistence for `fino:jobs`.
*
* @internal
*/
export class JobsStore {
  #db: Database;
  /**
  * Private property `#last` — tail of the internal operation queue. The
  * sqlite bindings cannot interleave statement execution across await
  * points on one connection (it segfaults), so every store operation runs
  * strictly after the previous one.
  *
  * @internal
  */
  #last: Promise<unknown> = Promise.resolve();
  private constructor(db: Database) {
    this.#db = db;
  }
  /**
  * Private method `#op` — serialize an operation onto the store queue.
  *
  * @internal
  */
  #op<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#last.then(fn, fn);
    this.#last = next.then(() => undefined, () => undefined);
    return next;
  }
  /**
  * Open (and create/migrate) a jobs store at `path`.
  *
  * ```ts no_run
  * import { JobsStore } from 'internal:jobs/store';
  * const store = await JobsStore.open('/tmp/jobs.db');
  * await store.close();
  * ```
  *
  * @internal
  */
  static async open(path: string, opts?: {
    fs?: object;
  }): Promise<JobsStore> {
    const db = await Database.open(path, { fs: opts?.fs as never });
    // No WAL: multi-connection WAL needs VFS shared memory (xShm*), which the
    // JS VFS does not provide.
    await db.exec('PRAGMA journal_mode=TRUNCATE');
    await db.exec('PRAGMA busy_timeout=5000');
    await db.exec('PRAGMA synchronous=NORMAL');
    await db.exec(`CREATE TABLE IF NOT EXISTS jobs (
        id              TEXT PRIMARY KEY,
        queue           TEXT NOT NULL DEFAULT 'default',
        task            TEXT NOT NULL,
        input           TEXT,
        status          TEXT NOT NULL,
        priority        INTEGER NOT NULL DEFAULT 0,
        run_at          INTEGER NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        max_attempts    INTEGER NOT NULL DEFAULT 3,
        backoff         TEXT,
        timeout_ms      INTEGER,
        dedupe_key      TEXT,
        claimed_by      TEXT,
        claimed_until   INTEGER,
        workflow_run_id TEXT,
        waiting_on      TEXT,
        schedule_id     TEXT,
        result          TEXT,
        error           TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        finished_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_at, priority);
      CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status, claimed_until);
      CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(queue, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
        ON jobs(queue, dedupe_key)
        WHERE dedupe_key IS NOT NULL
          AND status IN ${ACTIVE_STATUSES};
      CREATE TABLE IF NOT EXISTS schedules (
        id          TEXT PRIMARY KEY,
        task        TEXT NOT NULL,
        input       TEXT,
        queue       TEXT NOT NULL DEFAULT 'default',
        spec        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        overlap     TEXT NOT NULL DEFAULT 'skip',
        catchup     TEXT NOT NULL DEFAULT 'skip',
        retry       TEXT,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_job_id TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);`);
    return new JobsStore(db);
  }
  /**
  * A `WorkflowStore` view over this store's `workflow_runs` table, sharing
  * the single database connection (schema-compatible with
  * `SqliteWorkflowStore`). Durable jobs checkpoint through this.
  *
  * @internal
  */
  workflowStore(): WorkflowStore {
    const db = this.#db;
    return {
      save: (state: WorkflowState): Promise<void> => this.#op(async () => {
        const next = {
          ...state,
          updatedAt: Date.now()
        };
        const stmt = db.prepare(`INSERT INTO workflow_runs(run_id, workflow_id, status, state, updated_at)
           VALUES(:run_id, :workflow_id, :status, :state, :updated_at)
           ON CONFLICT(run_id) DO UPDATE SET
             workflow_id = excluded.workflow_id,
             status = excluded.status,
             state = excluded.state,
             updated_at = excluded.updated_at`);
        try {
          await stmt.run({
            run_id: next.runId,
            workflow_id: next.workflowId,
            status: next.status,
            state: JSON.stringify(next),
            updated_at: next.updatedAt
          });
        } finally {
          stmt.finalize();
        }
      }),
      load: (runId: string): Promise<WorkflowState | null> => this.#op(async () => {
        const stmt = db.prepare('SELECT state FROM workflow_runs WHERE run_id = ?');
        try {
          const row = await stmt.get(runId);
          return row ? JSON.parse(row.state as string) as WorkflowState : null;
        } finally {
          stmt.finalize();
        }
      }),
      list: (filter: {
        workflowId?: string;
        status?: WorkflowStatus;
      } = {}): Promise<WorkflowState[]> => this.#op(async () => {
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (filter.workflowId !== undefined) {
          clauses.push('workflow_id = ?');
          params.push(filter.workflowId);
        }
        if (filter.status !== undefined) {
          clauses.push('status = ?');
          params.push(filter.status);
        }
        const stmt = db.prepare(`SELECT state FROM workflow_runs ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`);
        try {
          const rows = await stmt.all(...params as SqlValue[]);
          return rows.map((row) => JSON.parse(row.state as string) as WorkflowState);
        } finally {
          stmt.finalize();
        }
      }),
      delete: (runId: string): Promise<void> => this.#op(async () => {
        const stmt = db.prepare('DELETE FROM workflow_runs WHERE run_id = ?');
        try {
          await stmt.run(runId);
        } finally {
          stmt.finalize();
        }
      })
    };
  }
  /**
  * Insert a job. When `dedupeKey` collides with an active job in the same
  * queue, no row is inserted and the existing active job is returned with
  * `deduped: true`.
  *
  * @internal
  */
  insertJob(job: InsertJob): Promise<{
    job: JobRecord;
    deduped: boolean;
  }> {
    return this.#op(() => this.#insertJobRaw(job));
  }
  /**
  * Private method `#insertJobRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #insertJobRaw(job: InsertJob): Promise<{
    job: JobRecord;
    deduped: boolean;
  }> {
    const now = Date.now();
    const id = String(uuidv7());
    const stmt = this.#db.prepare(`INSERT INTO jobs (id, queue, task, input, status, priority, run_at, attempts, max_attempts, backoff, timeout_ms, dedupe_key, schedule_id, created_at, updated_at)
      VALUES (:id, :queue, :task, :input, 'pending', :priority, :run_at, 0, :max_attempts, :backoff, :timeout_ms, :dedupe_key, :schedule_id, :created_at, :updated_at)
      ON CONFLICT(queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ${ACTIVE_STATUSES} DO NOTHING`);
    let changes: number;
    try {
      changes = (await stmt.run({
        id,
        queue: job.queue,
        task: job.task,
        input: JSON.stringify(job.input ?? null),
        priority: job.priority ?? 0,
        run_at: job.runAt,
        max_attempts: job.maxAttempts ?? 3,
        backoff: job.backoff === null || job.backoff === undefined ? null : JSON.stringify(job.backoff),
        timeout_ms: job.timeoutMs ?? null,
        dedupe_key: job.dedupeKey ?? null,
        schedule_id: job.scheduleId ?? null,
        created_at: now,
        updated_at: now
      })).changes;
    } finally {
      stmt.finalize();
    }
    if (changes === 0) {
      const existing = await this.#findActiveByDedupeRaw(job.queue, job.dedupeKey!);
      if (existing === null) {
        throw new Error(`jobs insert conflicted but no active job found for key "${job.dedupeKey}"`);
      }
      return {
        job: existing,
        deduped: true
      };
    }
    return {
      job: (await this.#getJobRaw(id))!,
      deduped: false
    };
  }
  /**
  * Find the active job holding a dedupe key.
  *
  * @internal
  */
  findActiveByDedupe(queue: string, dedupeKey: string): Promise<JobRecord | null> {
    return this.#op(() => this.#findActiveByDedupeRaw(queue, dedupeKey));
  }
  /**
  * Private method `#findActiveByDedupeRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #findActiveByDedupeRaw(queue: string, dedupeKey: string): Promise<JobRecord | null> {
    const stmt = this.#db.prepare(`SELECT * FROM jobs WHERE queue = :queue AND dedupe_key = :dedupe_key AND status IN ${ACTIVE_STATUSES} LIMIT 1`);
    try {
      const row = await stmt.get({
        queue,
        dedupe_key: dedupeKey
      });
      return row === undefined ? null : rowToJob(row);
    } finally {
      stmt.finalize();
    }
  }
  /**
  * Atomically claim up to `limit` due jobs for `claimedBy`.
  *
  * Claiming from `pending` consumes an attempt; claiming from `waiting`
  * (resuming a parked durable job) does not.
  *
  * @internal
  */
  claimReady(claimedBy: string, leaseMs: number, limit: number, now = Date.now(), tasks?: string[]): Promise<JobRecord[]> {
    if (limit <= 0 || tasks !== undefined && tasks.length === 0) return Promise.resolve([]);
    return this.#op(() => this.#claimReadyRaw(claimedBy, leaseMs, limit, now, tasks));
  }
  /**
  * Private method `#claimReadyRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #claimReadyRaw(claimedBy: string, leaseMs: number, limit: number, now: number, tasks?: string[]): Promise<JobRecord[]> {
    const taskFilter = tasks === undefined ? '' : ` AND task IN (${tasks.map(() => '?').join(',')})`;
    const stmt = this.#db.prepare(`UPDATE jobs SET
        status = 'claimed',
        claimed_by = ?,
        claimed_until = ?,
        attempts = attempts + (status = 'pending'),
        updated_at = ?
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status IN ('pending','waiting') AND run_at <= ?${taskFilter}
        ORDER BY priority DESC, run_at ASC, id ASC
        LIMIT ?
      ) AND status IN ('pending','waiting')
      RETURNING *`);
    try {
      const rows = await stmt.all(claimedBy, now + leaseMs, now, now, ...tasks ?? [], limit);
      // RETURNING does not preserve the subquery's ORDER BY; restore it.
      return rows.map(rowToJob).sort((a, b) => b.priority - a.priority || a.runAt - b.runAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } finally {
      stmt.finalize();
    }
  }
  /**
  * Recover expired leases: requeue with backoff when attempts remain,
  * dead-letter otherwise. Returns the affected jobs (post-update).
  *
  * @internal
  */
  sweepLeases(now = Date.now()): Promise<JobRecord[]> {
    return this.#op(() => this.#sweepLeasesRaw(now));
  }
  /**
  * Private method `#sweepLeasesRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #sweepLeasesRaw(now: number): Promise<JobRecord[]> {
    await this.#db.exec('BEGIN IMMEDIATE');
    try {
      const expired = this.#db.prepare(`SELECT * FROM jobs WHERE status IN ('claimed','running') AND claimed_until IS NOT NULL AND claimed_until <= :now`);
      let rows: Record<string, SqlValue>[];
      try {
        rows = await expired.all({ now });
      } finally {
        expired.finalize();
      }
      const affected: JobRecord[] = [];
      for (const row of rows) {
        const job = rowToJob(row);
        if (job.attempts >= job.maxAttempts) {
          await this.#update(job.id, {
            status: 'dead',
            claimed_by: null,
            claimed_until: null,
            error: JSON.stringify({ message: `lease expired after attempt ${job.attempts}/${job.maxAttempts}` }),
            finished_at: now
          }, now);
        } else {
          await this.#update(job.id, {
            status: 'pending',
            claimed_by: null,
            claimed_until: null,
            run_at: now + backoffDelayMs(job.backoff, job.attempts)
          }, now);
        }
        affected.push((await this.#getJobRaw(job.id))!);
      }
      await this.#db.exec('COMMIT');
      return affected;
    } catch (err) {
      try {
        await this.#db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }
  /**
  * Extend the lease for in-flight jobs owned by `claimedBy`.
  *
  * @internal
  */
  heartbeat(claimedBy: string, ids: string[], leaseMs: number, now = Date.now()): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.#op(() => this.#heartbeatRaw(claimedBy, ids, leaseMs, now));
  }
  /**
  * Private method `#heartbeatRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #heartbeatRaw(claimedBy: string, ids: string[], leaseMs: number, now: number): Promise<void> {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.#db.prepare(`UPDATE jobs SET claimed_until = ?, updated_at = ? WHERE claimed_by = ? AND status IN ('claimed','running') AND id IN (${placeholders})`);
    try {
      await stmt.run(now + leaseMs, now, claimedBy, ...ids);
    } finally {
      stmt.finalize();
    }
  }
  /**
  * Private method `#update` — patch columns on one job row.
  *
  * @internal
  */
  async #update(id: string, patch: Record<string, SqlValue>, now = Date.now()): Promise<void> {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = :${k}`).join(', ');
    const stmt = this.#db.prepare(`UPDATE jobs SET ${sets}, updated_at = :__now WHERE id = :__id`);
    try {
      await stmt.run({
        ...patch,
        __now: now,
        __id: id
      });
    } finally {
      stmt.finalize();
    }
  }
  /**
  * Transition a claimed job to `running`.
  *
  * @internal
  */
  markRunning(id: string): Promise<void> {
    return this.#op(() => this.#update(id, { status: 'running' }));
  }
  /**
  * Record successful completion.
  *
  * @internal
  */
  markDone(id: string, result: unknown): Promise<void> {
    return this.#op(() => this.#update(id, {
      status: 'done',
      result: JSON.stringify(result ?? null),
      claimed_by: null,
      claimed_until: null,
      finished_at: Date.now()
    }));
  }
  /**
  * Park a durable job until `runAt` (its timer due time, signal timeout, or
  * effectively-forever for pure signal waits).
  *
  * @internal
  */
  markWaiting(id: string, workflowRunId: string, waitingOn: unknown, runAt: number): Promise<void> {
    return this.#op(() => this.#update(id, {
      status: 'waiting',
      workflow_run_id: workflowRunId,
      waiting_on: JSON.stringify(waitingOn ?? null),
      run_at: runAt,
      claimed_by: null,
      claimed_until: null
    }));
  }
  /**
  * Requeue a failed job for a later attempt.
  *
  * @internal
  */
  markRetry(id: string, runAt: number, error: {
    message: string;
    stack?: string;
  }): Promise<void> {
    return this.#op(() => this.#update(id, {
      status: 'pending',
      run_at: runAt,
      error: JSON.stringify(error),
      claimed_by: null,
      claimed_until: null
    }));
  }
  /**
  * Dead-letter a job that exhausted its attempts (or failed non-retryably).
  *
  * @internal
  */
  markDead(id: string, error: {
    message: string;
    stack?: string;
  }): Promise<void> {
    return this.#op(() => this.#update(id, {
      status: 'dead',
      error: JSON.stringify(error),
      claimed_by: null,
      claimed_until: null,
      finished_at: Date.now()
    }));
  }
  /**
  * Cancel a job. Only non-terminal states change; running jobs are marked
  * but their in-flight work is not interrupted (v1).
  *
  * @internal
  */
  cancel(id: string): Promise<boolean> {
    return this.#op(async () => {
      const stmt = this.#db.prepare(`UPDATE jobs SET status = 'cancelled', claimed_by = NULL, claimed_until = NULL, finished_at = :now, updated_at = :now WHERE id = :id AND status IN ${ACTIVE_STATUSES}`);
      try {
        const { changes } = await stmt.run({
          id,
          now: Date.now()
        });
        return changes > 0;
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Requeue a terminal job (dead/error/cancelled) from scratch, keeping its
  * workflow linkage so a durable job resumes rather than restarts.
  *
  * @internal
  */
  retry(id: string): Promise<boolean> {
    return this.#op(async () => {
      const stmt = this.#db.prepare(`UPDATE jobs SET status = 'pending', attempts = 0, run_at = :now, error = NULL, finished_at = NULL, updated_at = :now WHERE id = :id AND status IN ('dead','error','cancelled')`);
      try {
        const { changes } = await stmt.run({
          id,
          now: Date.now()
        });
        return changes > 0;
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Make a parked (waiting) job immediately claimable — used after an
  * external signal is delivered to its workflow run.
  *
  * @internal
  */
  wake(id: string): Promise<boolean> {
    return this.#op(async () => {
      const stmt = this.#db.prepare(`UPDATE jobs SET status = 'pending', run_at = :now, updated_at = :now WHERE id = :id AND status = 'waiting'`);
      try {
        const { changes } = await stmt.run({
          id,
          now: Date.now()
        });
        return changes > 0;
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Load one job by id.
  *
  * @internal
  */
  getJob(id: string): Promise<JobRecord | null> {
    return this.#op(() => this.#getJobRaw(id));
  }
  /**
  * Private method `#getJobRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #getJobRaw(id: string): Promise<JobRecord | null> {
    const stmt = this.#db.prepare('SELECT * FROM jobs WHERE id = :id');
    try {
      const row = await stmt.get({ id });
      return row === undefined ? null : rowToJob(row);
    } finally {
      stmt.finalize();
    }
  }
  /**
  * List jobs by optional filters, newest first.
  *
  * @internal
  */
  listJobs(filter: {
    queue?: string;
    status?: JobStatus;
    task?: string;
    scheduleId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<JobRecord[]> {
    return this.#op(() => this.#listJobsRaw(filter));
  }
  /**
  * Private method `#listJobsRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #listJobsRaw(filter: {
    queue?: string;
    status?: JobStatus;
    task?: string;
    scheduleId?: string;
    limit?: number;
    offset?: number;
  }): Promise<JobRecord[]> {
    const where: string[] = [];
    const params: Record<string, SqlValue> = {};
    if (filter.queue !== undefined) {
      where.push('queue = :queue');
      params.queue = filter.queue;
    }
    if (filter.status !== undefined) {
      where.push('status = :status');
      params.status = filter.status;
    }
    if (filter.task !== undefined) {
      where.push('task = :task');
      params.task = filter.task;
    }
    if (filter.scheduleId !== undefined) {
      where.push('schedule_id = :schedule_id');
      params.schedule_id = filter.scheduleId;
    }
    params.limit = filter.limit ?? 100;
    params.offset = filter.offset ?? 0;
    const stmt = this.#db.prepare(`SELECT * FROM jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset`);
    try {
      return (await stmt.all(params)).map(rowToJob);
    } finally {
      stmt.finalize();
    }
  }
  /**
  * Create or replace a named schedule.
  *
  * @internal
  */
  async upsertSchedule(schedule: {
    id: string;
    task: string;
    input: unknown;
    queue: string;
    spec: string;
    overlap: 'skip' | 'allow';
    catchup: 'skip' | 'one';
    retry: JobRetryPolicy | null;
    nextRunAt: number;
  }): Promise<ScheduleRecord> {
    return this.#op(() => this.#upsertScheduleRaw(schedule));
  }
  /**
  * Private method `#upsertScheduleRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #upsertScheduleRaw(schedule: {
    id: string;
    task: string;
    input: unknown;
    queue: string;
    spec: string;
    overlap: 'skip' | 'allow';
    catchup: 'skip' | 'one';
    retry: JobRetryPolicy | null;
    nextRunAt: number;
  }): Promise<ScheduleRecord> {
    const now = Date.now();
    const stmt = this.#db.prepare(`INSERT INTO schedules (id, task, input, queue, spec, enabled, overlap, catchup, retry, next_run_at, created_at, updated_at)
      VALUES (:id, :task, :input, :queue, :spec, 1, :overlap, :catchup, :retry, :next_run_at, :now, :now)
      ON CONFLICT(id) DO UPDATE SET
        task = excluded.task,
        input = excluded.input,
        queue = excluded.queue,
        spec = excluded.spec,
        enabled = 1,
        overlap = excluded.overlap,
        catchup = excluded.catchup,
        retry = excluded.retry,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at`);
    try {
      await stmt.run({
        id: schedule.id,
        task: schedule.task,
        input: JSON.stringify(schedule.input ?? null),
        queue: schedule.queue,
        spec: schedule.spec,
        overlap: schedule.overlap,
        catchup: schedule.catchup,
        retry: schedule.retry === null ? null : JSON.stringify(schedule.retry),
        next_run_at: schedule.nextRunAt,
        now
      });
    } finally {
      stmt.finalize();
    }
    return (await this.#getScheduleRaw(schedule.id))!;
  }
  /**
  * Delete a schedule by name. Returns whether it existed.
  *
  * @internal
  */
  deleteSchedule(id: string): Promise<boolean> {
    return this.#op(async () => {
      const stmt = this.#db.prepare('DELETE FROM schedules WHERE id = :id');
      try {
        const { changes } = await stmt.run({ id });
        return changes > 0;
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Load one schedule by name.
  *
  * @internal
  */
  getSchedule(id: string): Promise<ScheduleRecord | null> {
    return this.#op(() => this.#getScheduleRaw(id));
  }
  /**
  * Private method `#getScheduleRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #getScheduleRaw(id: string): Promise<ScheduleRecord | null> {
    const stmt = this.#db.prepare('SELECT * FROM schedules WHERE id = :id');
    try {
      const row = await stmt.get({ id });
      return row === undefined ? null : rowToSchedule(row);
    } finally {
      stmt.finalize();
    }
  }
  /**
  * List all schedules.
  *
  * @internal
  */
  listSchedules(): Promise<ScheduleRecord[]> {
    return this.#op(async () => {
      const stmt = this.#db.prepare('SELECT * FROM schedules ORDER BY id');
      try {
        return (await stmt.all()).map(rowToSchedule);
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Schedules due at or before `now`.
  *
  * @internal
  */
  dueSchedules(now = Date.now()): Promise<ScheduleRecord[]> {
    return this.#op(async () => {
      const stmt = this.#db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= :now ORDER BY next_run_at ASC');
      try {
        return (await stmt.all({ now })).map(rowToSchedule);
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Advance a schedule after a firing decision.
  *
  * @internal
  */
  advanceSchedule(id: string, nextRunAt: number, firing?: {
    lastRunAt: number;
    lastJobId: string | null;
  }): Promise<void> {
    return this.#op(() => this.#advanceScheduleRaw(id, nextRunAt, firing));
  }
  /**
  * Private method `#advanceScheduleRaw` used by `JobsStore`.
  *
  * @internal
  */
  async #advanceScheduleRaw(id: string, nextRunAt: number, firing?: {
    lastRunAt: number;
    lastJobId: string | null;
  }): Promise<void> {
    const now = Date.now();
    const stmt = firing !== undefined ? this.#db.prepare('UPDATE schedules SET next_run_at = :next_run_at, last_run_at = :last_run_at, last_job_id = :last_job_id, updated_at = :now WHERE id = :id') : this.#db.prepare('UPDATE schedules SET next_run_at = :next_run_at, updated_at = :now WHERE id = :id');
    try {
      await stmt.run(firing !== undefined ? {
        id,
        next_run_at: nextRunAt,
        last_run_at: firing.lastRunAt,
        last_job_id: firing.lastJobId,
        now
      } : {
        id,
        next_run_at: nextRunAt,
        now
      });
    } finally {
      stmt.finalize();
    }
  }
  /**
  * Earliest moment any persisted work becomes due: pending/waiting jobs,
  * active leases, or enabled schedules. `null` when nothing is scheduled.
  *
  * @internal
  */
  nextWakeAt(): Promise<number | null> {
    return this.#op(async () => {
      const stmt = this.#db.prepare(`SELECT MIN(t) AS wake FROM (
          SELECT MIN(run_at) AS t FROM jobs WHERE status IN ('pending','waiting')
          UNION ALL SELECT MIN(claimed_until) FROM jobs WHERE status IN ('claimed','running')
          UNION ALL SELECT MIN(next_run_at) FROM schedules WHERE enabled = 1
        )`);
      try {
        const row = await stmt.get();
        return row === undefined ? null : toNumOrNull(row.wake);
      } finally {
        stmt.finalize();
      }
    });
  }
  /**
  * Close the underlying database.
  *
  * @internal
  */
  close(): Promise<void> {
    return this.#op(() => this.#db.close());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
* Delay before the next attempt after `attempts` completed tries.
*
* Exponential with a cap; half-jitter keeps a floor of cap/2 so tests can
* assert bounds.
*
* @internal
*/
export function backoffDelayMs(policy: JobRetryPolicy | null, attempts: number): number {
  const base = policy?.baseMs ?? 1e3;
  const factor = policy?.factor ?? 2;
  const maxMs = policy?.maxMs ?? 6e4;
  const jitter = policy?.jitter ?? true;
  const cap = Math.min(maxMs, base * Math.pow(factor, Math.max(0, attempts - 1)));
  if (!jitter) return cap;
  return cap / 2 + Math.random() * (cap / 2);
}
