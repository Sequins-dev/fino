/**
 * End-to-end tests for reactor-pooled job processors: Task files as worker
 * definitions, fresh Realm execution, and facade-proxied checkpoints.
 */
import { describe, it } from 'fino:test/test';
import { Jobs } from 'fino:jobs';
import { sqliteAvailable } from 'fino:database/sqlite';
import { env, exit } from 'fino:process';

if (!sqliteAvailable) {
  if (env.FINO_REQUIRE_SQLITE === '1') throw new Error('sqlite required but unavailable');
  console.log('SKIP: sqlite unavailable');
  exit(0);
}

function tempPath(suffix = 'db'): string {
  return `/tmp/fino-jobs-e2e-${Math.floor(Math.random() * 1e9)}.${suffix}`;
}
const workerEntry = new URL('./fixtures/worker-task.ts', import.meta.url).pathname;

describe('fino:jobs Realm processors', () => {
  it('runs jobs in fresh pooled Realms from a Task-file entry', async (t) => {
    await using jobs = await Jobs.open({
      path: tempPath(),
      pollIntervalMs: 50,
    });
    await jobs.workers({
      entry: workerEntry,
      size: 1,
    });
    const job = await jobs.push('pool-double', { v: 8 });
    const done = await jobs.wait(job.id, { timeoutMs: 30_000 });
    t.equal(done.status, 'done', 'pool job completed');
    t.equal(done.result, 16, 'worker result persisted');
    const root = await jobs.push('pool-root', null);
    const rootDone = await jobs.wait(root.id, { timeoutMs: 30_000 });
    t.equal(rootDone.result, 'root-ok', 'task-tree root is registered too');
  });
  it('durable job in a Realm worker checkpoints through the facade', async (t) => {
    await using jobs = await Jobs.open({
      path: tempPath(),
      pollIntervalMs: 40,
    });
    await jobs.workers({
      entry: workerEntry,
      size: 1,
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
      pollIntervalMs: 40,
    });
    await jobs.workers({
      entry: workerEntry,
      size: 1,
    });
    const marker = tempPath('marker');
    const job = await jobs.push(
      'pool-marker-flaky',
      { marker },
      {
        retry: {
          maxAttempts: 3,
          baseMs: 20,
          jitter: false,
        },
      },
    );
    const done = await jobs.wait(job.id, { timeoutMs: 30_000 });
    t.equal(done.status, 'done', 'second attempt succeeded');
    t.equal(done.result, 'second-try', 'retry ran in a fresh realm and saw the marker');
    t.equal(done.attempts, 2, 'exactly two attempts consumed');
  });
});
