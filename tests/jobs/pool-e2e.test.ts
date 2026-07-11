/**
* End-to-end tests for pool processors: Task files as worker definitions,
* exclusive-pool execution, facade-proxied durable checkpoints, and generic
* Task-as-worker pools outside fino:jobs.
*/
import { describe, it } from 'fino:test/test';
import { Jobs } from 'fino:jobs';
import { Realm } from 'fino:realm';
import { sqliteAvailable } from 'fino:database/sqlite';
import { env, exit } from 'fino:process';
import type { JobsWireResult } from 'internal:jobs/runner';

if (!sqliteAvailable) {
  if (env.FINO_REQUIRE_SQLITE === '1') throw new Error('sqlite required but unavailable');
  console.log('SKIP: sqlite unavailable');
  exit(0);
}

function tempPath(suffix = 'db'): string {
  return `/tmp/fino-jobs-e2e-${Math.floor(Math.random() * 1e9)}.${suffix}`;
}
const workerEntry = new URL('./fixtures/worker-task.ts', import.meta.url).pathname;

describe('fino:jobs pool processors', () => {
  it('runs jobs in an exclusive pool from a Task-file entry', async (t) => {
    await using jobs = await Jobs.open({
      path: tempPath(),
      pollIntervalMs: 50
    });
    await jobs.workers({
      entry: workerEntry,
      size: 1
    });
    const job = await jobs.push('pool-double', { v: 8 });
    const done = await jobs.wait(job.id, { timeoutMs: 30_000 });
    t.equal(done.status, 'done', 'pool job completed');
    t.equal(done.result, 16, 'worker result persisted');
    const root = await jobs.push('pool-root', null);
    const rootDone = await jobs.wait(root.id, { timeoutMs: 30_000 });
    t.equal(rootDone.result, 'root-ok', 'task-tree root is registered too');
  });
  it('durable job in a pool worker checkpoints through the facade', async (t) => {
    await using jobs = await Jobs.open({
      path: tempPath(),
      pollIntervalMs: 40
    });
    await jobs.workers({
      entry: workerEntry,
      size: 1
    });
    const job = await jobs.push('pool-durable-nap', null);
    const done = await jobs.wait(job.id, { timeoutMs: 30_000 });
    t.equal(done.status, 'done', 'durable pool job resumed across the park');
    t.equal(done.result, 'first,second', 'steps checkpointed via the facade store');
    t.ok(done.workflowRunId !== null, 'workflow linkage recorded on the job');
  });
  it('retries across fresh worker realms', async (t) => {
    await using jobs = await Jobs.open({
      path: tempPath(),
      pollIntervalMs: 40
    });
    await jobs.workers({
      entry: workerEntry,
      size: 1
    });
    const marker = tempPath('marker');
    const job = await jobs.push('pool-marker-flaky', { marker }, {
      retry: {
        maxAttempts: 3,
        baseMs: 20,
        jitter: false
      }
    });
    const done = await jobs.wait(job.id, { timeoutMs: 30_000 });
    t.equal(done.status, 'done', 'second attempt succeeded');
    t.equal(done.result, 'second-try', 'retry ran in a fresh realm and saw the marker');
    t.equal(done.attempts, 2, 'exactly two attempts consumed');
  });
  it('a logical Realm accepts a Task-file entry directly', async (t) => {
    const realm = new Realm({
      entry: workerEntry,
      scaling: { mode: 'bound' }
    });
    try {
      const names = await realm.call({ kind: 'tasks' }) as string[];
      t.ok(names.includes('pool-double'), 'worker reports its task registry');
      const result = await realm.call({
        kind: 'run',
        jobId: 'adhoc-1',
        task: 'pool-double',
        input: { v: 5 },
        attempt: 1
      }) as JobsWireResult;
      t.ok('ok' in result && result.ok, 'dispatcher executed the task');
      t.equal((result as { output: unknown }).output, 10, 'result came back over the pool wire');
    } finally {
      realm.terminate();
    }
  });
});
