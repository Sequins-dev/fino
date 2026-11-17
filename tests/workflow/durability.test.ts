import { describe, it } from 'fino:test/test';
import { memoryStore } from 'fino:store';
import { workflow, WorkflowRun, loadWorkflowRun } from 'fino:workflow';

describe('workflow durability regressions', () => {
  it('retains state mutations across checkpoints, waits and final completion', async (t) => {
    const store = memoryStore();
    const wf = workflow({
      id: 'state',
      async run(ctx) {
        ctx.state.set('before', 1);
        ctx.state.set('removed', true);
        await ctx.step('first', () => {
          ctx.state.set('inside', 2);
        });
        t.equal(ctx.state.get('before'), 1);
        ctx.state.clear('removed');
        await Promise.all([ctx.step('a', () => 1), ctx.step('b', () => 2)]);
        await ctx.waitForSignal('go');
        ctx.state.set('final', 3);
        return ctx.state.entries();
      },
    });
    const parked = await wf.start(null, { store });
    t.deepEqual(parked.state.state, { before: 1, inside: 2 });
    await wf.signal({ store, runId: parked.runId, name: 'go' });
    const done = await wf.resume({ store, runId: parked.runId });
    t.deepEqual(done.state.state, { before: 1, inside: 2, final: 3 });
    t.deepEqual((await wf.resume({ store, runId: parked.runId })).state.state, done.state.state);
    const only = workflow({
      id: 'only',
      run(ctx) {
        ctx.state.set('value', 4);
      },
    });
    t.deepEqual((await only.start(null, { store })).state.state, { value: 4 });
  });
  it('retains the original relative signal deadline through early and late resumes', async (t) => {
    const store = memoryStore();
    const original = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const wf = workflow({
        id: 'deadline',
        run: (ctx) => ctx.waitForSignal('go', { timeout: '5s' }),
      });
      const first = await wf.start(null, { store });
      now = 3000;
      const early = await wf.resume({ store, runId: first.runId });
      t.equal(early.waitingOn?.type === 'signal' && early.waitingOn.timeoutAt, 6000);
      now = 6001;
      await t.rejects(() => wf.resume({ store, runId: first.runId }), /timed out/);
    } finally {
      Date.now = original;
    }
  });
  for (const parallel of [false, true])
    for (const fail of [false, true]) {
      it(`cancellation survives late ${fail ? 'failure' : 'success'} (parallel=${parallel})`, async (t) => {
        const store = memoryStore();
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const wf = workflow({
          id: 'cancel',
          async run(ctx) {
            const work = ctx.step('active', async () => {
              entered();
              await gate;
              if (fail) throw new Error('late');
              return 1;
            });
            return parallel
              ? Promise.all([
                  work,
                  ctx.step('other', async () => {
                    await gate;
                    return 2;
                  }),
                ])
              : work;
          },
        });
        const handle = new WorkflowRun(wf, { store, runId: 'cancel' });
        const driving = handle.start(null).then(
          () => null,
          (error) => error,
        );
        await ready;
        await new WorkflowRun(wf, { store, runId: 'cancel' }).cancel();
        release();
        await driving;
        t.equal((await loadWorkflowRun(store, 'cancel'))?.status, 'cancelled');
      });
    }
});

describe('durable replay identity', () => {
  for (const operation of ['step', 'sleep', 'signal']) {
    it(`rejects replacing a completed step with ${operation}`, async (t) => {
      const store = memoryStore();
      const first = workflow({
        id: 'identity',
        async run(ctx) {
          await ctx.step('original', () => 1);
          await ctx.waitForSignal('park');
        },
      });
      const parked = await first.start(null, { store });
      const changed = workflow({
        id: 'identity',
        async run(ctx) {
          if (operation === 'step') await ctx.step('renamed', () => 2);
          else if (operation === 'sleep') await ctx.sleep('original', 0);
          else await ctx.waitForSignal('original');
        },
      });
      await t.rejects(() => changed.resume({ store, runId: parked.runId }), /mismatch/);
    });
  }
});

describe('workflow cancellation ownership', () => {
  it('aborts the active handle context and preserves a finished run on cancel', async (t) => {
    const store = memoryStore();
    let release!: () => void;
    let signal!: AbortSignal;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wf = workflow({
      id: 'cooperative',
      async run(ctx) {
        signal = ctx.signal!;
        entered();
        await gate;
        return 1;
      },
    });
    const handle = new WorkflowRun(wf, { store });
    const driving = handle.start(null);
    await ready;
    await handle.cancel();
    t.equal(signal.aborted, true);
    release();
    t.equal((await driving).status, 'cancelled');
    const done = workflow({ id: 'done', run: () => 2 });
    const completed = new WorkflowRun(done, { store });
    await completed.start(null);
    await completed.cancel();
    t.equal(completed.state?.status, 'done');
  });
});

describe('workflow concurrent checkpoint merging', () => {
  it('retains a signal delivered by another handle before a parallel step settles', async (t) => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active!: Promise<unknown>;
    const wf = workflow({
      id: 'parallel-signal',
      async run(ctx) {
        active = ctx.step('active', async () => {
          await gate;
          return 1;
        });
        await Promise.all([active, ctx.waitForSignal('go')]);
      },
    });
    const parked = await wf.start(null, { store });
    await wf.signal({ store, runId: parked.runId, name: 'go', payload: 42 });
    release();
    await active;
    t.equal((await loadWorkflowRun(store, parked.runId))?.signals[0]?.payload, 42);
    await wf.resume({ store, runId: parked.runId });
    t.deepEqual((await loadWorkflowRun(store, parked.runId))?.signals, []);
  });
});

describe('workflow deadline and state restart boundaries', () => {
  it('persists state before sleep and after the last checkpoint', async (t) => {
    const store = memoryStore();
    const original = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const wf = workflow({
        id: 'sleep-state',
        async run(ctx) {
          await ctx.step('seed', () => {
            ctx.state.set('remove', true);
          });
          ctx.state.clear('remove');
          ctx.state.set('sleep', true);
          await ctx.sleep('pause', 50);
          ctx.state.set('final', true);
        },
      });
      const first = await wf.start(null, { store });
      t.deepEqual(first.state.state, { sleep: true });
      now = 1051;
      const done = await wf.resume({ store, runId: first.runId });
      t.deepEqual(done.state.state, { sleep: true, final: true });
    } finally {
      Date.now = original;
    }
  });
  it('keeps an absolute deadline and consumes delivered signals before timeout', async (t) => {
    const store = memoryStore();
    const original = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const wf = workflow({
        id: 'absolute',
        run: (ctx) => ctx.waitForSignal('go', { timeout: new Date(2000) }),
      });
      const first = await wf.start(null, { store });
      now = 1500;
      const early = await wf.resume({ store, runId: first.runId });
      t.equal(early.waitingOn?.type === 'signal' && early.waitingOn.timeoutAt, 2000);
      now = 2001;
      await wf.signal({ store, runId: first.runId, name: 'go', payload: 42 });
      t.equal((await wf.resume({ store, runId: first.runId })).result, 42);
    } finally {
      Date.now = original;
    }
  });
});

describe('workflow parallel wait deadline', () => {
  it('retains a pending signal deadline when an earlier parallel step checkpoints', async (t) => {
    const store = memoryStore();
    const original = Date.now;
    let now = 1000;
    Date.now = () => now;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active!: Promise<unknown>;
    try {
      const wf = workflow({
        id: 'parallel-deadline',
        async run(ctx) {
          active = ctx.step('active', () => gate);
          await Promise.all([active, ctx.waitForSignal('go', { timeout: 5000 })]);
        },
      });
      const first = await wf.start(null, { store });
      release();
      await active;
      now = 3000;
      const early = await wf.resume({ store, runId: first.runId });
      t.equal(early.waitingOn?.type === 'signal' && early.waitingOn.timeoutAt, 6000);
    } finally {
      release();
      Date.now = original;
    }
  });
});
