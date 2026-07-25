import { describe, it } from 'fino:test/test';
import { DeploymentController } from 'internal:orchestrator/deployment';

describe('DeploymentController orchestration capacity', () => {
  it('rejects an explicit maximum above eligible cluster capacity', (t) => {
    t.throws(() => new DeploymentController({
      scaling: { min: 1, max: 2 },
      capacity: () => 1,
      create: () => ({ id: 1 }),
      dispose: () => {}
    }), /maximum exceeds.*capacity/i);
  });

  it('uses current eligible capacity when maximum is omitted', async (t) => {
    let nextId = 0;
    const controller = new DeploymentController({
      scaling: { min: 1, scaleUpWindowMs: 0 },
      capacity: () => 2,
      create: () => ({ id: ++nextId }),
      dispose: () => {}
    });
    await controller.ready;
    const first = await controller.acquire();
    const second = await controller.acquire();
    t.notEqual(first.value.id, second.value.id);
    first.release();
    second.release();
    controller.terminate();
  });

  it('drains an idle above-minimum replica after the scale-down window', async (t) => {
    let nextId = 0;
    const disposed: number[] = [];
    const controller = new DeploymentController({
      scaling: { min: 1, max: 2, scaleUpWindowMs: 0, scaleDownWindowMs: 20 },
      capacity: () => 2,
      create: () => ({ id: ++nextId }),
      dispose: (value) => { disposed.push(value.id); }
    });
    await controller.ready;
    // Force the second replica into existence, then let both go idle.
    const first = await controller.acquire();
    const second = await controller.acquire();
    t.equal(controller.values().length, 2, 'scaled up to two replicas');
    first.release();
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 120));
    t.equal(controller.values().length, 1, 'the excess idle replica drained');
    t.equal(disposed.length, 1, 'exactly one replica was disposed');
    controller.terminate();
  });

  it('disposes an earlier minimum replica when later creation fails', async (t) => {
    let created = 0;
    const disposed: number[] = [];
    const controller = new DeploymentController({
      scaling: { min: 2, max: 2 },
      capacity: () => 2,
      create: () => ++created === 1
        ? { id: created }
        : Promise.reject(new Error('creation failed')),
      dispose: (value) => { disposed.push(value.id); }
    });
    await t.rejects(() => controller.ready, /creation failed/);
    t.deepEqual(disposed, [1]);
    controller.terminate();
    t.deepEqual(disposed, [1], 'termination remains idempotent');
  });

  it('settles queued admission and an in-flight spawn during termination', async (t) => {
    let finishCreate!: (value: { id: number }) => void;
    const disposed: number[] = [];
    const controller = new DeploymentController({
      scaling: { min: 1, max: 2, scaleUpWindowMs: 0 },
      capacity: () => 2,
      create: () => new Promise<{ id: number }>((resolve) => { finishCreate = resolve; }),
      dispose: (value) => disposed.push(value.id)
    });
    controller.terminate();
    finishCreate({ id: 1 });
    await t.rejects(() => controller.ready, /terminated/);
    await t.rejects(() => controller.acquire(), /terminated/);
    t.deepEqual(disposed, [1]);
  });
});
