/**
* Tests for internal:jobs/store — claims, leases, dedupe, and wake math.
*
* The first test gates the UPDATE...RETURNING claim strategy; if it fails,
* the store must fall back to a manual BEGIN IMMEDIATE claim.
*/
import { describe, it } from 'fino:test/test';
import { JobsStore, backoffDelayMs } from 'internal:jobs/store';
import { sqliteAvailable } from 'fino:database/sqlite';
import { env, exit } from 'fino:process';

if (!sqliteAvailable) {
  if (env.FINO_REQUIRE_SQLITE === '1') throw new Error('sqlite required but unavailable');
  console.log('SKIP: sqlite unavailable');
  exit(0);
}

function tempPath(): string {
  return `/tmp/fino-jobs-test-${Math.floor(Math.random() * 1e9)}.db`;
}

describe('JobsStore', () => {
  it('claims atomically via UPDATE...RETURNING (strategy gate)', async (t) => {
    await using store = await JobsStore.open(tempPath());
    await store.insertJob({ queue: 'default', task: 'a', input: 1, runAt: Date.now() - 10 });
    await store.insertJob({ queue: 'default', task: 'b', input: 2, runAt: Date.now() - 5 });
    const claimed = await store.claimReady('me', 30_000, 5);
    t.equal(claimed.length, 2, 'RETURNING claim returned both due jobs');
    t.equal(claimed[0]!.status, 'claimed', 'claimed status applied');
    t.equal(claimed[0]!.attempts, 1, 'claim from pending consumed an attempt');
    t.equal((await store.claimReady('me', 30_000, 5)).length, 0, 'no double-claim');
  });
  it('two connections claim disjoint sets', async (t) => {
    const path = tempPath();
    await using a = await JobsStore.open(path);
    await using b = await JobsStore.open(path);
    for (let i = 0; i < 10; i++) {
      await a.insertJob({ queue: 'default', task: `t${i}`, input: i, runAt: Date.now() - 1 });
    }
    const fromA: Awaited<ReturnType<typeof a.claimReady>> = [];
    const fromB: typeof fromA = [];
    // Interleave claims until the queue drains; flock contention surfaces as
    // busy errors that a claimer simply retries.
    for (let round = 0; round < 40 && fromA.length + fromB.length < 10; round++) {
      const [ra, rb] = await Promise.allSettled([a.claimReady('worker-a', 30_000, 2), b.claimReady('worker-b', 30_000, 2)]);
      if (ra.status === 'fulfilled') fromA.push(...ra.value);
      if (rb.status === 'fulfilled') fromB.push(...rb.value);
    }
    const ids = new Set([...fromA.map((j) => j.id), ...fromB.map((j) => j.id)]);
    t.equal(fromA.length + fromB.length, 10, 'every job claimed exactly once across connections');
    t.equal(ids.size, 10, 'no job claimed twice');
  });
  it('concurrent claimants on one connection get disjoint sets', async (t) => {
    await using store = await JobsStore.open(tempPath());
    for (let i = 0; i < 10; i++) {
      await store.insertJob({ queue: 'default', task: `t${i}`, input: i, runAt: Date.now() - 1 });
    }
    const [fromA, fromB] = await Promise.all([store.claimReady('worker-a', 30_000, 6), store.claimReady('worker-b', 30_000, 6)]);
    const ids = new Set([...fromA.map((j) => j.id), ...fromB.map((j) => j.id)]);
    t.equal(fromA.length + fromB.length, 10, 'every job claimed exactly once across claimants');
    t.equal(ids.size, 10, 'no job claimed twice');
  });
  it('exposes a workflow store on the same connection', async (t) => {
    await using store = await JobsStore.open(tempPath());
    const wf = store.workflowStore();
    const state = {
      runId: 'wf-1',
      workflowId: 'demo',
      status: 'waiting' as const,
      cursor: 0,
      input: null,
      steps: [],
      state: {},
      signals: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await wf.save(state);
    const loaded = await wf.load('wf-1');
    t.equal(loaded?.workflowId, 'demo', 'round-trips workflow state');
    t.equal((await wf.list({ status: 'waiting' })).length, 1, 'list filters by status');
    await wf.delete('wf-1');
    t.equal(await wf.load('wf-1'), null, 'delete removes the run');
  });
  it('dedupes active jobs per (queue, key) and frees the key on completion', async (t) => {
    await using store = await JobsStore.open(tempPath());
    const first = await store.insertJob({ queue: 'q', task: 'send', input: 1, runAt: Date.now(), dedupeKey: 'k1' });
    t.equal(first.deduped, false, 'first push inserts');
    const dup = await store.insertJob({ queue: 'q', task: 'send', input: 2, runAt: Date.now(), dedupeKey: 'k1' });
    t.equal(dup.deduped, true, 'second push dedupes');
    t.equal(dup.job.id, first.job.id, 'existing active job returned');
    const other = await store.insertJob({ queue: 'other', task: 'send', input: 3, runAt: Date.now(), dedupeKey: 'k1' });
    t.equal(other.deduped, false, 'same key in another queue is distinct');
    await store.markDone(first.job.id, null);
    const again = await store.insertJob({ queue: 'q', task: 'send', input: 4, runAt: Date.now(), dedupeKey: 'k1' });
    t.equal(again.deduped, false, 'terminal job frees the dedupe key');
  });
  it('sweeps expired leases: requeue with backoff, dead-letter when exhausted', async (t) => {
    await using store = await JobsStore.open(tempPath());
    const fresh = await store.insertJob({ queue: 'default', task: 'retryable', input: null, runAt: Date.now() - 1, maxAttempts: 3 });
    const doomed = await store.insertJob({ queue: 'default', task: 'doomed', input: null, runAt: Date.now() - 1, maxAttempts: 1 });
    const claimed = await store.claimReady('me', 50, 10);
    t.equal(claimed.length, 2, 'both jobs claimed');
    const swept = await store.sweepLeases(Date.now() + 100);
    t.equal(swept.length, 2, 'both leases expired');
    const requeued = (await store.getJob(fresh.job.id))!;
    t.equal(requeued.status, 'pending', 'attempts remaining → requeued');
    t.ok(requeued.runAt > Date.now(), 'requeue applied backoff delay');
    const dead = (await store.getJob(doomed.job.id))!;
    t.equal(dead.status, 'dead', 'attempts exhausted → dead-lettered');
    t.ok(/lease expired/.test(dead.error?.message ?? ''), 'dead-letter reason recorded');
  });
  it('claiming a waiting job does not consume an attempt', async (t) => {
    await using store = await JobsStore.open(tempPath());
    const { job } = await store.insertJob({ queue: 'default', task: 'durable', input: null, runAt: Date.now() - 1, maxAttempts: 2 });
    const [first] = await store.claimReady('me', 30_000, 1);
    t.equal(first!.attempts, 1, 'pending claim consumed attempt');
    await store.markWaiting(job.id, 'wf-run-1', { type: 'timer', dueAt: Date.now() - 1 }, Date.now() - 1);
    const [resumed] = await store.claimReady('me', 30_000, 1);
    t.equal(resumed!.id, job.id, 'waiting job reclaimed when due');
    t.equal(resumed!.attempts, 1, 'waiting claim did not consume an attempt');
    t.equal(resumed!.workflowRunId, 'wf-run-1', 'workflow linkage preserved');
  });
  it('orders claims by priority then run_at', async (t) => {
    await using store = await JobsStore.open(tempPath());
    const now = Date.now();
    await store.insertJob({ queue: 'default', task: 'low-old', input: null, runAt: now - 100, priority: 0 });
    await store.insertJob({ queue: 'default', task: 'high-new', input: null, runAt: now - 10, priority: 5 });
    const claimed = await store.claimReady('me', 30_000, 2);
    t.equal(claimed[0]!.task, 'high-new', 'higher priority first');
    t.equal(claimed[1]!.task, 'low-old', 'then older run_at');
  });
  it('computes nextWakeAt across jobs, leases, and schedules', async (t) => {
    await using store = await JobsStore.open(tempPath());
    t.equal(await store.nextWakeAt(), null, 'empty store has no wake');
    const soon = Date.now() + 5_000;
    await store.insertJob({ queue: 'default', task: 'later', input: null, runAt: soon });
    t.equal(await store.nextWakeAt(), soon, 'pending job run_at drives wake');
    await store.upsertSchedule({
      id: 'nightly',
      task: 'later',
      input: null,
      queue: 'default',
      spec: '@daily',
      overlap: 'skip',
      catchup: 'skip',
      retry: null,
      nextRunAt: soon - 1_000
    });
    t.equal(await store.nextWakeAt(), soon - 1_000, 'earlier schedule wins');
  });
  it('cancel and retry transitions', async (t) => {
    await using store = await JobsStore.open(tempPath());
    const { job } = await store.insertJob({ queue: 'default', task: 'x', input: null, runAt: Date.now() });
    t.equal(await store.cancel(job.id), true, 'pending job cancels');
    t.equal(await store.cancel(job.id), false, 'terminal job does not cancel again');
    t.equal(await store.retry(job.id), true, 'cancelled job can be retried');
    const retried = (await store.getJob(job.id))!;
    t.equal(retried.status, 'pending', 'retry requeues');
    t.equal(retried.attempts, 0, 'retry resets attempts');
  });
  it('backoff delay stays within half-jitter bounds', (t) => {
    const policy = { maxAttempts: 5, baseMs: 1000, factor: 2, maxMs: 60_000, jitter: true };
    for (let attempt = 1; attempt <= 4; attempt++) {
      const cap = Math.min(60_000, 1000 * Math.pow(2, attempt - 1));
      for (let i = 0; i < 20; i++) {
        const d = backoffDelayMs(policy, attempt);
        if (d < cap / 2 || d > cap) {
          t.ok(false, `delay ${d} outside [${cap / 2}, ${cap}] for attempt ${attempt}`);
          return;
        }
      }
    }
    t.ok(true, 'all sampled delays within bounds');
    t.equal(backoffDelayMs({ ...policy, jitter: false }, 3), 4000, 'no-jitter delay is exact');
  });
  it('DDL is idempotent across opens', async (t) => {
    const path = tempPath();
    const first = await JobsStore.open(path);
    await first.insertJob({ queue: 'default', task: 'persist', input: null, runAt: Date.now() });
    await first.close();
    await using second = await JobsStore.open(path);
    const jobs = await second.listJobs({});
    t.equal(jobs.length, 1, 'existing rows survive a reopen');
  });
});
