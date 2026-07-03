/**
* Tests for fino:task/durable — durable tasks over fino:workflow.
*/
import { describe, it } from 'fino:test/test';
import { durableTask } from 'fino:task/durable';
import { InMemoryWorkflowStore, SqliteWorkflowStore, type WorkflowState, type WorkflowStore } from 'fino:workflow';
import { sqliteAvailable } from 'fino:database/sqlite';
import * as loop from 'internal:runtime/loop';

class CountingStore implements WorkflowStore {
  inner = new InMemoryWorkflowStore();
  saves = 0;
  async save(state: WorkflowState): Promise<void> {
    this.saves++;
    await this.inner.save(state);
  }
  load(runId: string): Promise<WorkflowState | null> {
    return this.inner.load(runId);
  }
  list(filter?: {
    workflowId?: string;
    status?: WorkflowState['status'];
  }): Promise<WorkflowState[]> {
    return this.inner.list(filter);
  }
  delete(runId: string): Promise<void> {
    return this.inner.delete(runId);
  }
}

describe('DurableTask', () => {
  it('runs to completion and checkpoints steps', async (t) => {
    const store = new CountingStore();
    let stepRuns = 0;
    const task = durableTask({
      name: 'steps',
      store,
      run: async (_input: undefined, ctx) => {
        const a = await ctx.step('a', () => {
          stepRuns++;
          return 20;
        });
        const b = await ctx.step('b', () => {
          stepRuns++;
          return 22;
        });
        return a + b;
      }
    });
    const result = await task.run(undefined);
    t.equal(result, 42, 'handler result propagates through the task surface');
    t.equal(stepRuns, 2, 'each step ran exactly once');
    t.ok(store.saves >= 2, 'steps checkpointed to the store');
  });
  it('parks on sleep and auto-resumes in run()', async (t) => {
    let handlerEntries = 0;
    const task = durableTask({
      name: 'sleepy',
      run: async (_input: undefined, ctx) => {
        handlerEntries++;
        await ctx.sleep('nap', 60);
        return 'woke';
      }
    });
    const before = Date.now();
    const result = await task.run(undefined);
    const elapsed = Date.now() - before;
    t.equal(result, 'woke', 'run completed after the park');
    t.ok(elapsed >= 50, `sleep parked and resumed after the due time (${elapsed}ms)`);
    t.ok(handlerEntries >= 2, 'handler re-executed from the top on resume (replay model)');
  });
  it('resumes across instances without re-running completed steps', async (t) => {
    if (!sqliteAvailable) {
      t.ok(true, 'skipped: sqlite unavailable');
      return;
    }
    const path = `/tmp/fino-durable-test-${Math.floor(Math.random() * 1e9)}.db`;
    const sideEffects: string[] = [];
    const makeTask = () => durableTask({
      name: 'restartable',
      store: () => SqliteWorkflowStore.open(path),
      run: async (_input: undefined, ctx) => {
        await ctx.step('first', () => {
          sideEffects.push('first');
          return 1;
        });
        await ctx.waitForSignal('approve');
        await ctx.step('second', () => {
          sideEffects.push('second');
          return 2;
        });
        return sideEffects.length;
      }
    });
    const before = makeTask();
    const parked = await before.start(undefined, { runId: 'restart-run' });
    t.equal(parked.status, 'waiting', 'run parked on the signal');
    t.equal(parked.waitingOn?.type, 'signal', 'waitingOn records the signal park');
    t.equal(sideEffects.join(','), 'first', 'first step ran before parking');
    // Simulate a restart: a brand-new task instance with a fresh store handle.
    const after = makeTask();
    await after.signalRun('restart-run', 'approve', undefined);
    const finished = await after.resume('restart-run');
    t.equal(finished.status, 'done', 'resumed run completed');
    t.equal(sideEffects.join(','), 'first,second', 'completed step did not re-run after restart');
  });
  it('run() waits for signalRun() deliveries', async (t) => {
    const task = durableTask({
      name: 'gated',
      run: async (_input: undefined, ctx) => {
        const payload = await ctx.waitForSignal<{ ok: boolean }>('go');
        return payload.ok;
      }
    });
    const running = task.run(undefined, { runId: 'gate-1' });
    await loop.timeout(30);
    await task.signalRun('gate-1', 'go', { ok: true });
    t.equal(await running, true, 'signal payload reached the handler');
  });
  it('same runId returns the stored result without re-executing', async (t) => {
    let runs = 0;
    const task = durableTask({
      name: 'idempotent',
      run: async (_input: undefined, ctx) => {
        return await ctx.step('only', () => ++runs);
      }
    });
    const first = await task.run(undefined, { runId: 'idem-1' });
    const second = await task.run(undefined, { runId: 'idem-1' });
    t.equal(first, 1, 'first run executed');
    t.equal(second, 1, 'second run replayed the stored result');
    t.equal(runs, 1, 'handler step body ran once');
  });
  it('surfaces determinism violations', async (t) => {
    let attempt = 0;
    const task = durableTask({
      name: 'nondeterministic',
      run: async (_input: undefined, ctx) => {
        attempt++;
        await ctx.step(attempt === 1 ? 'a' : 'changed', () => 1);
        await ctx.waitForSignal('never');
        return null;
      }
    });
    const parked = await task.start(undefined, { runId: 'det-1' });
    t.equal(parked.status, 'waiting', 'first drive parked');
    const resumed = await task.resume('det-1');
    t.equal(resumed.status, 'error', 'replay with mismatched step id fails');
    t.ok(/determinism|mismatch|expected/i.test(resumed.error?.message ?? ''), `error explains the mismatch: ${resumed.error?.message}`);
  });
  it('suspend() throws an explanatory error', async (t) => {
    const task = durableTask({
      name: 'no-suspend',
      run: async (_input: undefined, ctx) => {
        ctx.suspend();
      }
    });
    await t.rejects(() => task.run(undefined), /suspend\(\) is not available in durable tasks/, 'suspend is rejected with guidance');
  });
  it('works through the CLI parse() surface', async (t) => {
    const task = durableTask({
      name: 'cli-durable',
      outputMode: 'text',
      cli: {
        positionals: [{
          name: 'word',
          type: 'string',
          required: true
        }]
      },
      run: async (input: { word: string }, ctx) => {
        return await ctx.step('shout', () => input.word.toUpperCase());
      }
    });
    const result = await task.parse(['hello']);
    t.equal(result, 'HELLO', 'CLI-parsed durable task ran through the workflow driver');
  });
  it('start() reports parked timers without waiting them out', async (t) => {
    const task = durableTask({
      name: 'long-nap',
      run: async (_input: undefined, ctx) => {
        await ctx.sleep('nap', '1h');
        return 'woke';
      }
    });
    const handle = await task.start(undefined, { runId: 'nap-1' });
    t.equal(handle.status, 'waiting', 'one drive returned immediately');
    t.equal(handle.waitingOn?.type, 'timer', 'park is a timer wait');
    t.ok((handle.waitingOn as { dueAt: number }).dueAt > Date.now() + 30 * 60 * 1000, 'due time is in the far future');
  });
});
