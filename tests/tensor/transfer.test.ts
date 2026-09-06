/**
 * Moving tensors and modules between devices.
 */
import { describe, it } from 'fino:test/test';
import { device, listDevices, tensor, zeros } from 'fino:tensor';
import type { Device } from 'fino:tensor';
import { Linear, Sequential } from 'fino:tensor/nn';
import { SGD } from 'fino:tensor/optim';

/** Devices to move between, discovered once. */
async function devices(): Promise<Device[]> {
  const found = await listDevices();
  return found;
}

describe('device transfer', () => {
  it('is the identity for the device a tensor already lives on', async (t) => {
    const cpu = await device('cpu');
    const x = await tensor([1, 2, 3], { device: cpu });
    const same = await x.to(cpu);
    t.equal(same, x, 'moving to the current device returns the same handle');
    t.equal(same.device.type, 'cpu', 'and stays where it was');
    x.dispose();
  });

  it('round trips values through every available device', async (t) => {
    const cpu = await device('cpu');
    const source = [1.5, -2.25, 3.75, 0, 100.5, -0.125];
    for (const target of await devices()) {
      const x = await tensor(source, { device: cpu });
      const moved = await x.to(target);
      t.deepEqual(
        [...(await moved.data())],
        source,
        `values survive the move to ${target.type}:${target.index}`,
      );
      const back = await moved.to(cpu);
      t.deepEqual(
        [...(await back.data())],
        source,
        `values survive the return from ${target.type}:${target.index}`,
      );
      x.dispose();
      if (moved !== x) moved.dispose();
      if (back !== moved) back.dispose();
    }
  });

  it('preserves the exact bits of a half-precision tensor', async (t) => {
    // A transfer moves bytes, not values. Going through `data()` would widen f16 to
    // f32 and re-round on the way back, which is a different operation.
    const cpu = await device('cpu');
    for (const target of await devices()) {
      if (target.type === 'cpu') continue;
      const x = await tensor([0.1, 0.2, 65504, -0.0004], { dtype: 'f16', device: cpu });
      const before = [...(await x.data())];
      const moved = await x.to(target);
      t.deepEqual([...(await moved.data())], before, `f16 bits survive ${target.type}`);
      x.dispose();
      moved.dispose();
    }
  });

  it('keeps requiresGrad and drops the old gradient', async (t) => {
    const cpu = await device('cpu');
    for (const target of await devices()) {
      if (target.type === 'cpu') continue;
      const x = await tensor([1, 2, 3], { device: cpu, requiresGrad: true });
      const moved = await x.to(target);
      t.ok(moved.requiresGrad, 'the moved tensor is still trainable');
      t.equal(moved.grad, null, 'and starts without a gradient');
      x.dispose();
      moved.dispose();
    }
  });

  it('refuses a dtype the target device cannot represent', async (t) => {
    const cpu = await device('cpu');
    for (const target of await devices()) {
      if (target.type === 'cpu') continue;
      const x = await tensor([1, 2], { dtype: 'f64', device: cpu });
      await t.rejects(
        () => x.to(target),
        /f64/,
        `f64 is refused on ${target.type} rather than narrowed`,
      );
      x.dispose();
    }
  });

  it('moves a whole module and trains it where it landed', async (t) => {
    for (const target of await devices()) {
      const model = new Sequential(new Linear(4, 3), new Linear(3, 1));
      await model.to(target);
      for (const parameter of model.parameters()) {
        t.equal(
          parameter.device.type,
          target.type,
          `every parameter is on ${target.type} after the move`,
        );
      }
      // The optimiser must be built after the move, since it holds the tensors it is
      // given — this is the ordering the method's documentation requires.
      const optimizer = new SGD(model.parameters(), { lr: 0.01 });
      const x = await tensor([1, 2, 3, 4], { shape: [1, 4], device: target });
      const y = await zeros([1, 1], { device: target });
      const objective = () => {
        const residual = model.forward(x).sub(y);
        return residual.mul(residual).sum();
      };
      const before = await objective().item();
      for (let step = 0; step < 20; step++) {
        const loss = objective();
        loss.backward();
        optimizer.step();
        optimizer.zeroGrad();
        loss.dispose();
      }
      const after = await objective().item();
      t.ok(after < before, `training reduces the loss on ${target.type} (${before} -> ${after})`);
      model.dispose();
      x.dispose();
      y.dispose();
    }
  });
});
