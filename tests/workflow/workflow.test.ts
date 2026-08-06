import { describe, it } from 'fino:test/test';
import {
  InMemoryWorkflowStore,
  NonRetryableWorkflowError,
  SqliteWorkflowStore,
  WorkflowRun,
  activity,
  observableWorkflowStore,
  watchRun,
  workflow,
} from 'fino:workflow';
import { v } from 'fino:validate';
import { DiskFileSystem } from 'fino:file';
function tmpPath(): string {
  return `/tmp/fino-workflow-test-${Math.floor(Math.random() * 1e9)}.db`;
}
describe('fino:workflow', () => {
  it('watchRun refreshes when an observable store saves a run', async (t) => {
    const store = observableWorkflowStore(new InMemoryWorkflowStore());
    const run = watchRun(store, 'observed-run');
    const statuses: string[] = [];
    run.subscribe((state) => statuses.push(state?.status ?? 'missing'));
    await store.save({
      runId: 'observed-run',
      workflowId: 'observed',
      status: 'running',
      cursor: 0,
      input: null,
      steps: [],
      state: {},
      signals: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    t.equal(run.get()?.status, 'running', 'watch retains saved state');
    t.deepEqual(statuses, ['running'], 'subscriber saw store update');
  });
  it('runs checkpointed steps and skips completed steps on resume', async (t) => {
    const store = new InMemoryWorkflowStore();
    const calls: string[] = [];
    const wf = workflow({
      id: 'checkpointed',
      async run(ctx, input: number) {
        const a = await ctx.step('double', async () => {
          calls.push('double');
          return input * 2;
        });
        return ctx.step('add', async () => {
          calls.push('add');
          return a + 10;
        });
      },
    });
    const first = await wf.start(5, { store });
    t.equal(first.status, 'done');
    t.equal(first.result, 20);
    t.deepEqual(calls, ['double', 'add']);
    const loaded = await store.load(first.runId);
    await store.save({
      ...loaded!,
      status: 'running',
      result: undefined,
      cursor: 1,
      steps: loaded!.steps.slice(0, 1),
    });
    calls.length = 0;
    const resumed = await wf.resume({
      store,
      runId: first.runId,
    });
    t.equal(resumed.status, 'done');
    t.equal(resumed.result, 20);
    t.deepEqual(calls, ['add']);
  });
  it('uses ordinary JavaScript branches, loops, foreach, and Promise.all', async (t) => {
    const store = new InMemoryWorkflowStore();
    const wf = workflow({
      id: 'js-control-flow',
      async run(
        ctx,
        input: {
          items: number[];
          positive: boolean;
        },
      ) {
        const sign = input.positive ? 1 : -1;
        let total = 0;
        for (const item of input.items) {
          total += await ctx.step('sum-item', async () => item * sign);
        }
        const doubled = await Promise.all(
          input.items.map((item) => ctx.step('double-item', async () => item * 2)),
        );
        return {
          total,
          doubled,
        };
      },
    });
    const result = await wf.start(
      {
        items: [1, 2, 3],
        positive: false,
      },
      { store },
    );
    t.deepEqual(result.result, {
      total: -6,
      doubled: [2, 4, 6],
    });
  });
  it('keeps Promise.all checkpoints when steps finish out of order', async (t) => {
    const store = new InMemoryWorkflowStore();
    const calls: string[] = [];
    const wf = workflow({
      id: 'out-of-order',
      async run(ctx) {
        const slow = ctx.step('slow', async () => {
          calls.push('slow');
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 'slow';
        });
        const fast = ctx.step('fast', async () => {
          calls.push('fast');
          return 'fast';
        });
        return Promise.all([slow, fast]);
      },
    });
    const result = await wf.start(null, { store });
    t.deepEqual(result.result, ['slow', 'fast']);
    const loaded = await store.load(result.runId);
    t.equal(loaded?.cursor, 2, 'cursor advances only through contiguous completed steps');
    t.deepEqual(
      loaded?.steps.map((step) => step.id),
      ['slow', 'fast'],
    );
    calls.length = 0;
    await store.save({
      ...loaded!,
      status: 'running',
      result: undefined,
    });
    const resumed = await wf.resume({
      store,
      runId: result.runId,
    });
    t.deepEqual(resumed.result, ['slow', 'fast']);
    t.deepEqual(calls, [], 'resume reuses both completed parallel step results');
  });
  it('validates workflow and activity input/output schemas', async (t) => {
    const store = new InMemoryWorkflowStore();
    const stringify = activity({
      id: 'stringify',
      inputSchema: v.number(),
      outputSchema: v.string(),
      async run(input: number) {
        return String(input);
      },
    });
    const wf = workflow({
      id: 'validated',
      inputSchema: v.number(),
      outputSchema: v.string(),
      async run(ctx, input: number) {
        return ctx.call(stringify, input);
      },
    });
    t.equal((await wf.start(42, { store })).result, '42');
    await t.rejects(() => wf.start('nope' as unknown as number, { store }), /validation/i);
  });
  it('retries activities and stops on non-retryable errors', async (t) => {
    const store = new InMemoryWorkflowStore();
    let attempts = 0;
    const flaky = activity({
      id: 'flaky',
      retry: { maxAttempts: 3 },
      async run() {
        attempts++;
        if (attempts < 3) throw new Error('try again');
        return 'ok';
      },
    });
    const wf = workflow({
      id: 'retry',
      async run(ctx) {
        return ctx.call(flaky, null);
      },
    });
    t.equal((await wf.start(null, { store })).result, 'ok');
    t.equal(attempts, 3);
    const blocked = activity({
      id: 'blocked',
      retry: { maxAttempts: 3 },
      async run() {
        throw new NonRetryableWorkflowError('do not retry');
      },
    });
    const bad = workflow({
      id: 'non-retryable',
      async run(ctx) {
        return ctx.call(blocked, null);
      },
    });
    await t.rejects(() => bad.start(null, { store }), /do not retry/);
    const failed = (await store.list()).find((s) => s.workflowId === 'non-retryable');
    t.equal(failed?.status, 'error');
  });
  it('waits for a signal and resumes exactly once', async (t) => {
    const store = new InMemoryWorkflowStore();
    const wf = workflow({
      id: 'approval',
      async run(ctx, input: string) {
        const approved = await ctx.waitForSignal<boolean>('approval');
        return `${input}:${approved}`;
      },
    });
    const first = await wf.start('deploy', { store });
    t.equal(first.status, 'waiting');
    t.equal(first.waitingOn?.type, 'signal');
    await wf.signal({
      store,
      runId: first.runId,
      name: 'approval',
      payload: true,
    });
    const resumed = await wf.resume({
      store,
      runId: first.runId,
    });
    t.equal(resumed.status, 'done');
    t.equal(resumed.result, 'deploy:true');
    await t.rejects(
      () =>
        wf.signal({
          store,
          runId: first.runId,
          name: 'approval',
          payload: false,
        }),
      /not waiting|already/i,
    );
  });
  it('waits for a timer until it is due', async (t) => {
    const store = new InMemoryWorkflowStore();
    const wf = workflow({
      id: 'timer',
      async run(ctx) {
        await ctx.sleep('delay', 50);
        return 'done';
      },
    });
    const first = await wf.start(null, { store });
    t.equal(first.status, 'waiting');
    t.equal(first.waitingOn?.type, 'timer');
    const early = await wf.resume({
      store,
      runId: first.runId,
    });
    t.equal(early.status, 'waiting');
    const state = await store.load(first.runId);
    await store.save({
      ...state!,
      waitingOn: {
        ...state!.waitingOn!,
        dueAt: Date.now() - 1,
      },
    });
    const done = await wf.resume({
      store,
      runId: first.runId,
    });
    t.equal(done.status, 'done');
    t.equal(done.result, 'done');
  });
  it('cancels a run and prevents further resume', async (t) => {
    const store = new InMemoryWorkflowStore();
    const wf = workflow({
      id: 'cancel',
      async run(ctx) {
        await ctx.waitForSignal('continue');
        return 'done';
      },
    });
    const first = await wf.start(null, { store });
    const run = new WorkflowRun(wf, {
      store,
      runId: first.runId,
    });
    await run.cancel();
    const loaded = await store.load(first.runId);
    t.equal(loaded?.status, 'cancelled');
    await t.rejects(
      () =>
        wf.resume({
          store,
          runId: first.runId,
        }),
      /cancelled/i,
    );
  });
  it('persists runs in sqlite workflow storage', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await SqliteWorkflowStore.open(`sqlite://${path}`);
    try {
      const wf = workflow({
        id: 'sqlite',
        async run(ctx, input: number) {
          return ctx.step('double', async () => input * 2);
        },
      });
      const result = await wf.start(7, { store });
      const loaded = await store.load(result.runId);
      t.equal(loaded?.result, 14);
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
  it('exposes only the runtime-level workflow specifier', async (t) => {
    const mod = await import('fino:workflow');
    t.equal('workflow' in mod, true);
    await t.rejects(
      () => import('fino:ai/workflow'),
      /Cannot resolve builtin module/,
    );
  });
});
