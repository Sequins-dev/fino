import { describe, it } from 'fino:test/test';
import { workflow, step, WorkflowRun, SqliteCheckpointStore } from 'fino:ai/workflow';
import { v, compile } from 'fino:validate';
import { DiskFileSystem } from 'fino:file';

function tmpPath(): string {
  return `/tmp/fino-workflow-test-${Math.floor(Math.random() * 1_000_000_000)}.db`;
}

describe('Workflow', () => {
  it('.then chain threads outputs and checkpoints per node', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const checkpoints: number[] = [];

      const double = step({
        id: 'double',
        execute: async (ctx) => (ctx.input as number) * 2,
      });
      const addTen = step({
        id: 'addTen',
        execute: async (ctx) => (ctx.input as number) + 10,
      });

      const wf = workflow({ id: 'chain' })
        .then(double)
        .then(addTen)
        .commit();

      const result = await wf.run(5, {
        store,
        onCheckpoint: (s) => checkpoints.push(s.stepIndex),
      });

      t.equal(result.status, 'done', 'workflow completed');
      t.equal(result.result, 20, '5*2=10 then +10=20');
      t.ok(checkpoints.length >= 2, 'checkpointed at least twice');

      const loaded = await store.load(result.runId);
      t.equal(loaded?.status, 'done', 'final state in store');
      t.equal(loaded?.result, 20, 'result persisted');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('.branch runs the first matching arm', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const isPositive = (v: unknown) => (v as number) > 0;
      const isNegative = (v: unknown) => (v as number) < 0;

      const posStep = step({ id: 'pos', execute: async () => 'positive' });
      const negStep = step({ id: 'neg', execute: async () => 'negative' });
      const zeroStep = step({ id: 'zero', execute: async () => 'zero' });

      const wf = workflow({ id: 'branch-wf' })
        .branch([
          [isPositive, posStep],
          [isNegative, negStep],
          [() => true, zeroStep],
        ])
        .commit();

      const r1 = await wf.run(5, { store });
      t.equal(r1.result, 'positive', 'positive branch taken for 5');

      const r2 = await wf.run(-3, { store });
      t.equal(r2.result, 'negative', 'negative branch taken for -3');

      const r3 = await wf.run(0, { store });
      t.equal(r3.result, 'zero', 'zero branch taken for 0');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('.parallel fans out and aggregates all results', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const callOrder: string[] = [];

      const stepA = step({ id: 'A', execute: async () => { callOrder.push('A'); return 'a'; } });
      const stepB = step({ id: 'B', execute: async () => { callOrder.push('B'); return 'b'; } });
      const stepC = step({ id: 'C', execute: async () => { callOrder.push('C'); return 'c'; } });

      const wf = workflow({ id: 'parallel-wf' })
        .parallel([stepA, stepB, stepC])
        .commit();

      const result = await wf.run(null, { store });
      t.equal(result.status, 'done');
      const out = result.result as unknown[];
      t.equal(out.length, 3, 'three results');
      t.ok(out.includes('a') && out.includes('b') && out.includes('c'), 'all three results present');
      t.equal(callOrder.length, 3, 'all three steps called');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('.foreach maps over array and collects results in order', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const processItem = step({
        id: 'process',
        execute: async (ctx) => (ctx.input as number) * 10,
      });

      const result = await workflow({ id: 'foreach-wf' })
        .foreach(processItem, { concurrency: 2 })
        .commit()
        .run([1, 2, 3, 4], { store });

      t.equal(result.status, 'done');
      const out = result.result as number[];
      t.equal(out.length, 4, 'four results');
      t.deepEqual(out, [10, 20, 30, 40], 'all items processed in input order');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('.doUntil loops until predicate is satisfied', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const increment = step({
        id: 'increment',
        execute: async (ctx) => (ctx.input as number) + 1,
      });

      const wf = workflow({ id: 'loop-wf' })
        .doUntil(increment, (v) => (v as number) >= 5)
        .commit();

      const result = await wf.run(0, { store });
      t.equal(result.status, 'done');
      t.equal(result.result, 5, 'looped until >= 5');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('.map transforms the previous output', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const wf = workflow({ id: 'map-wf' })
        .map((v) => (v as number) * 3)
        .commit();

      const result = await wf.run(7, { store });
      t.equal(result.status, 'done');
      t.equal(result.result, 21, '7*3=21');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('input/output schema validation rejects bad payloads', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const wf = workflow({
        id: 'validated-wf',
        inputSchema: v.number(),
        outputSchema: v.string(),
      })
        .map((v) => v)
        .commit();

      await t.rejects(
        () => wf.run('not a number' as unknown as number, { store }),
        /validation/i,
        'rejects invalid input',
      );

      const badOutputWf = workflow({
        id: 'bad-output-wf',
        outputSchema: v.string(),
      })
        .map(() => 42)
        .commit();

      await t.rejects(
        () => badOutputWf.run(null, { store }),
        /validation/i,
        'rejects invalid output',
      );
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('crash/restart resume: re-drives from scratch.cursor without re-running completed nodes', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const callLog: string[] = [];

      const stepA = step({
        id: 'stepA',
        execute: async () => { callLog.push('A'); return 'result-A'; },
      });
      const stepB = step({
        id: 'stepB',
        execute: async () => { callLog.push('B'); return 'result-B'; },
      });

      const wf = workflow({ id: 'resume-wf' })
        .then(stepA)
        .then(stepB)
        .commit();

      const run = wf.createRun({ store });
      const runPromise = run.start(null);

      await runPromise;
      const firstResult = run.state!;
      t.equal(firstResult.status, 'done');
      t.deepEqual(callLog, ['A', 'B'], 'both steps ran first time');

      callLog.length = 0;

      const afterA = await store.load(firstResult.runId);
      t.ok(afterA, 'run persisted');

      const midState = {
        ...afterA!,
        status: 'running' as const,
        scratch: {
          ...afterA!.scratch,
          cursor: 1,
          lastOutput: 'result-A',
          completed: {},
        },
      };
      await store.save(midState);

      const resumed = await WorkflowRun.resume({ store, workflow: wf, runId: midState.runId });
      t.equal(resumed.status, 'done', 'resumed to done');
      t.equal(resumed.result, 'result-B', 'correct final output');
      t.deepEqual(callLog, ['B'], 'only stepB was re-executed (stepA skipped)');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('approval gate: suspend returns token; resume continues; token is single-use', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const waitStep = step({
        id: 'wait',
        execute: async (ctx) => {
          ctx.suspend({ reason: 'needs human approval', payload: { requestedBy: 'AI' } });
        },
      });
      const afterApproval = step({
        id: 'after',
        execute: async (ctx) => `approved: ${ctx.scratch['resumeValue']}`,
      });

      const wf = workflow({ id: 'approval-wf' })
        .then(waitStep)
        .then(afterApproval)
        .commit();

      const run = wf.createRun({ store });
      const r1 = await run.start('initial input');

      t.equal(r1.status, 'suspended', 'run suspended at wait step');
      t.ok(r1.state.suspendedOn?.token, 'resume token minted');
      const token = r1.state.suspendedOn!.token;

      const r2 = await run.resume(token, 'human said yes');
      t.equal(r2.status, 'done', 'resumed to done');
      t.equal(r2.result, 'approved: human said yes', 'resume value was available');

      await t.rejects(
        () => run.resume(token, 'try again'),
        /suspended|token/i,
        'second resume with same token rejects',
      );
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('suspend inside parallel nodes is rejected with a clear error', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const waits = step({
        id: 'waits',
        execute: async (ctx) => ctx.suspend({ reason: 'inside parallel' }),
      });
      const wf = workflow({ id: 'parallel-suspend' })
        .parallel([waits])
        .commit();

      await t.rejects(
        () => wf.run('input', { store }),
        /parallel.*suspend/i,
        'parallel suspend fails clearly',
      );
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });

  it('getStepResult() allows steps to read prior node outputs', async (t) => {
    const path = tmpPath();
    const fs = new DiskFileSystem();
    try { await fs.unlink(path); } catch {}
    const store = await SqliteCheckpointStore.open(path);
    try {
      const produce = step({ id: 'produce', execute: async () => 42 });
      const consume = step({
        id: 'consume',
        execute: async (ctx) => {
          const prior = ctx.getStepResult('produce') as number;
          return prior * 2;
        },
      });

      const wf = workflow({ id: 'cross-ref-wf' })
        .then(produce)
        .then(consume)
        .commit();

      const result = await wf.run(null, { store });
      t.equal(result.status, 'done');
      t.equal(result.result, 84, '42 * 2 = 84');
    } finally {
      await store.close();
      try { await fs.unlink(path); } catch {}
    }
  });
});
