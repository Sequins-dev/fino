/**
 * Tests for durable tasks running as jobs: parking, scheduler-driven
 * resumption, signals, and restart recovery.
 */
import { describe, it } from 'fino:test/test';
import { Jobs } from 'fino:jobs';
import { durableTask } from 'fino:task/durable';
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

describe('fino:jobs durable tasks', () => {
  it('parks on sleep and the scheduler resumes it', async (t) => {
    const phases: string[] = [];
    const napper = durableTask({
      name: 'napper',
      run: async (_input: null, ctx) => {
        await ctx.step('before', () => {
          phases.push('before');
          return null;
        });
        await ctx.sleep('nap', 150);
        await ctx.step('after', () => {
          phases.push('after');
          return null;
        });
        return phases.length;
      },
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [napper],
      pollIntervalMs: 50,
    });
    const job = await jobs.push('napper', null);
    const deadline = Date.now() + 3_000;
    let sawWaiting = false;
    while (Date.now() < deadline) {
      const current = (await jobs.get(job.id))!;
      if (current.status === 'waiting') {
        sawWaiting = true;
        break;
      }
      if (current.status === 'done') break;
      await loop.timeout(10);
    }
    const done = await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.ok(sawWaiting, 'job parked while sleeping');
    t.equal(done.status, 'done', 'scheduler resumed and completed the job');
    t.equal(phases.join(','), 'before,after', 'steps did not re-run across the park');
  });
  it('signal() wakes a signal-parked job', async (t) => {
    const gate = durableTask({
      name: 'gate',
      run: async (_input: null, ctx) => {
        const approval = await ctx.waitForSignal<{ by: string }>('approve');
        return approval.by;
      },
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [gate],
      pollIntervalMs: 50,
    });
    const job = await jobs.push('gate', null);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = (await jobs.get(job.id))!;
      if (current.status === 'waiting') break;
      await loop.timeout(10);
    }
    await jobs.signal(job.id, 'approve', { by: 'ada' });
    const done = await jobs.wait(job.id, { timeoutMs: 10_000 });
    t.equal(done.status, 'done', 'signalled job completed');
    t.equal(done.result, 'ada', 'signal payload reached the handler');
  });
  it('recovers a parked job across a restart without re-running steps', async (t) => {
    const path = tempPath();
    const sideEffects: string[] = [];
    const makeTask = () =>
      durableTask({
        name: 'restartable-job',
        run: async (_input: null, ctx) => {
          await ctx.step('first', () => {
            sideEffects.push('first');
            return null;
          });
          await ctx.sleep('nap', 200);
          await ctx.step('second', () => {
            sideEffects.push('second');
            return null;
          });
          return sideEffects.join(',');
        },
      });
    const first = await Jobs.open({
      path,
      tasks: [makeTask()],
      pollIntervalMs: 50,
    });
    const job = await first.push('restartable-job', null);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const current = (await first.get(job.id))!;
      if (current.status === 'waiting') break;
      await loop.timeout(10);
    }
    // Simulate a process restart mid-park: stop everything, reopen on the
    // same file with a fresh task instance.
    await first.stop();
    await using second = await Jobs.open({
      path,
      tasks: [makeTask()],
      pollIntervalMs: 50,
    });
    const done = await second.wait(job.id, { timeoutMs: 10_000 });
    t.equal(done.status, 'done', 'parked job completed after restart');
    t.equal(sideEffects.join(','), 'first,second', 'completed step did not re-run');
    t.equal(done.result, 'first,second', 'result reflects the resumed run');
  });
  it('waiting claims do not consume attempts across many parks', async (t) => {
    const multiNap = durableTask({
      name: 'multi-nap',
      run: async (_input: null, ctx) => {
        for (let i = 0; i < 4; i++) {
          await ctx.sleep(`nap-${i}`, 40);
        }
        return 'rested';
      },
    });
    await using jobs = await Jobs.open({
      path: tempPath(),
      tasks: [multiNap],
      pollIntervalMs: 25,
    });
    const job = await jobs.push('multi-nap', null, {
      retry: { maxAttempts: 2 },
    });
    const done = await jobs.wait(job.id, { timeoutMs: 15_000 });
    t.equal(done.status, 'done', 'four parks resumed despite maxAttempts of 2');
    t.ok(done.attempts <= 2, `parking never consumed attempts (attempts: ${done.attempts})`);
  });
});
