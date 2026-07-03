/**
* Tests for fino:jobs in local mode with an inline processor.
*/
import { describe, it } from 'fino:test/test';
import { Jobs, NonRetryableJobError } from 'fino:jobs';
import { task } from 'fino:task';
import { sqliteAvailable } from 'fino:database/sqlite';
import { env, exit } from 'fino:process';
import * as loop from 'internal:runtime/loop';

if (!sqliteAvailable) {
  if (env.FINO_REQUIRE_SQLITE === '1') throw new Error('sqlite required but unavailable');
  console.log('SKIP: sqlite unavailable');
  exit(0);
}

function tempPath(): string {
  return `/tmp/fino-jobs-test-${Math.floor(Math.random() * 1e9)}.db`;
}

describe('fino:jobs local mode', () => {
  it('pushes a job and runs it to completion', async (t) => {
    const echo = task({
      name: 'echo',
      run: async (input: { value: number }) => input.value * 2
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [echo]
    });
    const job = await jobs.push('echo', { value: 21 });
    const done = await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.equal(done.status, 'done', 'job completed');
    t.equal(done.result, 42, 'handler result persisted');
  });
  it('honors delay before running', async (t) => {
    const stamps: number[] = [];
    const stamp = task({
      name: 'stamp',
      run: async () => {
        stamps.push(Date.now());
        return null;
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [stamp]
    });
    const before = Date.now();
    const job = await jobs.push('stamp', null, { delay: 120 });
    await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.ok(stamps[0]! - before >= 100, `job waited for its delay (${stamps[0]! - before}ms)`);
  });
  it('retries with backoff then dead-letters', async (t) => {
    let attempts = 0;
    const flaky = task({
      name: 'flaky',
      run: async () => {
        attempts++;
        throw new Error(`attempt ${attempts} failed`);
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [flaky]
    });
    const job = await jobs.push('flaky', null, {
      retry: {
        maxAttempts: 3,
        baseMs: 20,
        maxMs: 40,
        jitter: false
      }
    });
    const dead = await jobs.wait(job.id, { timeoutMs: 15_000 });
    t.equal(dead.status, 'dead', 'exhausted job dead-letters');
    t.equal(attempts, 3, 'ran exactly maxAttempts times');
    t.ok(/attempt 3 failed/.test(dead.error?.message ?? ''), 'last error recorded');
  });
  it('NonRetryableJobError skips remaining attempts', async (t) => {
    let attempts = 0;
    const hopeless = task({
      name: 'hopeless',
      run: async () => {
        attempts++;
        throw new NonRetryableJobError('bad input');
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [hopeless]
    });
    const job = await jobs.push('hopeless', null, {
      retry: { maxAttempts: 5, baseMs: 10 }
    });
    const dead = await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.equal(dead.status, 'dead', 'non-retryable error dead-letters immediately');
    t.equal(attempts, 1, 'no retries were attempted');
  });
  it('retry() requeues a dead job', async (t) => {
    let failFirst = true;
    const flaky = task({
      name: 'second-chance',
      run: async () => {
        if (failFirst) {
          failFirst = false;
          throw new NonRetryableJobError('first time fails');
        }
        return 'recovered';
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [flaky]
    });
    const job = await jobs.push('second-chance', null);
    const dead = await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.equal(dead.status, 'dead', 'first run dead-lettered');
    t.equal(await jobs.retry(job.id), true, 'retry requeued');
    const done = await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.equal(done.status, 'done', 'requeued job completed');
    t.equal(done.result, 'recovered', 'second run result recorded');
  });
  it('cancels a pending job', async (t) => {
    const never = task({
      name: 'never-runs',
      run: async () => null
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [never]
    });
    const job = await jobs.push('never-runs', null, { delay: '1h' });
    t.equal(await jobs.cancel(job.id), true, 'pending job cancelled');
    const cancelled = await jobs.wait(job.id, { timeoutMs: 1_000 });
    t.equal(cancelled.status, 'cancelled', 'terminal state is cancelled');
  });
  it('dedupes active pushes by key', async (t) => {
    const slow = task({
      name: 'slow-dedupe',
      run: async () => {
        await loop.timeout(100);
        return 'done';
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [slow]
    });
    const first = await jobs.push('slow-dedupe', null, { key: 'once' });
    const second = await jobs.push('slow-dedupe', null, { key: 'once' });
    t.equal(second.id, first.id, 'active dedupe returns the existing job');
    await jobs.wait(first.id, { timeoutMs: 10_000 });
  });
  it('interval schedules fire repeatedly', async (t) => {
    let fired = 0;
    const tickTask = task({
      name: 'tick',
      run: async () => {
        fired++;
        return fired;
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [tickTask],
      pollIntervalMs: 50
    });
    await jobs.schedule('ticker', 'tick', null, { every: '150ms' });
    const deadline = Date.now() + 10_000;
    while (fired < 2 && Date.now() < deadline) await loop.timeout(50);
    t.ok(fired >= 2, `schedule fired repeatedly (${fired} times)`);
    await jobs.unschedule('ticker');
  });
  it('overlap: skip does not stack runs of a slow task', async (t) => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const slow = task({
      name: 'slow-cron',
      run: async () => {
        runs++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await loop.timeout(400);
        concurrent--;
        return null;
      }
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [slow],
      concurrency: 4,
      pollIntervalMs: 50
    });
    await jobs.schedule('slow-cron', 'slow-cron', null, {
      every: '100ms',
      overlap: 'skip'
    });
    const deadline = Date.now() + 5_000;
    while (runs < 2 && Date.now() < deadline) await loop.timeout(50);
    t.ok(runs >= 1, 'schedule fired');
    t.equal(maxConcurrent, 1, 'overlapping firings were skipped');
    await jobs.unschedule('slow-cron');
  });
  it('rejects duplicate task names across processors', async (t) => {
    const a = task({
      name: 'dupe',
      run: async () => null
    });
    const b = task({
      name: 'dupe',
      run: async () => null
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [a]
    });
    let threw = false;
    try {
      await jobs.process({ tasks: [b] });
    } catch (err) {
      threw = true;
      t.ok(/already handled/.test(err instanceof Error ? err.message : ''), 'duplicate registration explains itself');
    }
    t.ok(threw, 'duplicate task name rejected');
  });
});
