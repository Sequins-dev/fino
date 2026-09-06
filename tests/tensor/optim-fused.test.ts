/**
 * The fused optimizer update, against arithmetic written out here.
 *
 * Every backend implements the whole update as one primitive rather than a chain of
 * elementwise operations, which is worth an order of magnitude — and means the update
 * is no longer expressed in terms of operations that are themselves tested. Nothing
 * else checks this arithmetic, so these compare against a step computed in plain
 * JavaScript, on every device.
 *
 * The coefficients are deliberately distinct and awkward. A momentum of 0.9 against a
 * weight decay of 0.9 would not have caught the kernel multiplying velocity by the
 * decay, which is what it did before anything called it.
 */
import { describe, it } from 'fino:test/test';
import { listDevices, tensor } from 'fino:tensor';
import type { Tensor } from 'fino:tensor';
import { Adam, AdamW, SGD } from 'fino:tensor/optim';

const START = [0.5, -1.25, 2, -0.75, 0.125, 3.5];
const GRAD = [0.25, 0.5, -1.5, 2, -0.0625, 1];

/** A parameter carrying a gradient, on one device. */
async function parameter(dev: Parameters<typeof tensor>[1] extends never ? never : unknown) {
  const p = await tensor(START, { device: dev as never, requiresGrad: true });
  p.grad = await tensor(GRAD, { device: dev as never });
  return p;
}

/** Compare against values computed here, at f32 tolerance. */
function agrees(
  t: { ok(value: unknown, message: string): void },
  label: string,
  got: ArrayLike<number>,
  want: readonly number[],
  relative = 0,
): void {
  let worst = 0;
  let allowed = 2e-6;
  let at = -1;
  for (let i = 0; i < want.length; i++) {
    const delta = Math.abs(Number(got[i]) - want[i]!);
    if (delta > worst) {
      worst = delta;
      at = i;
      allowed = 2e-6 + relative * Math.abs(want[i]!);
    }
  }
  t.ok(
    worst <= allowed,
    worst <= allowed
      ? `${label}: matches within ${worst.toExponential(1)}`
      : `${label}: element ${at} is off by ${worst.toExponential(2)}, allowed ${allowed.toExponential(2)}`,
  );
}

describe('the fused optimizer update', () => {
  it('takes a plain SGD step', async (t) => {
    const lr = 0.1;
    const want = START.map((p, i) => p - GRAD[i]! * lr);
    for (const dev of await listDevices()) {
      const p = await parameter(dev);
      new SGD([p], { lr }).step();
      agrees(t, `sgd on ${dev.type}`, await p.data(), want);
      p.dispose();
    }
  });

  it('accumulates momentum over two steps', async (t) => {
    // Velocity starts at zero, so the first step is v = g and the second is
    // v = momentum * g + g. Two steps are what distinguish momentum from a plain step
    // at all, and what would catch the wrong coefficient being used.
    const lr = 0.1;
    const momentum = 0.75;
    const first = START.map((p, i) => p - GRAD[i]! * lr);
    const want = first.map((p, i) => p - (GRAD[i]! * momentum + GRAD[i]!) * lr);
    for (const dev of await listDevices()) {
      const p = await parameter(dev);
      const optimizer = new SGD([p], { lr, momentum });
      optimizer.step();
      optimizer.step();
      agrees(t, `momentum on ${dev.type}`, await p.data(), want);
      p.dispose();
    }
  });

  it('looks ahead with Nesterov momentum', async (t) => {
    const lr = 0.1;
    const momentum = 0.75;
    // Step one: v = g, and the direction is g + v * momentum.
    const first = START.map((p, i) => p - (GRAD[i]! + GRAD[i]! * momentum) * lr);
    const velocity = GRAD.map((g) => g * momentum + g);
    const want = first.map((p, i) => p - (GRAD[i]! + velocity[i]! * momentum) * lr);
    for (const dev of await listDevices()) {
      const p = await parameter(dev);
      const optimizer = new SGD([p], { lr, momentum, nesterov: true });
      optimizer.step();
      optimizer.step();
      agrees(t, `nesterov on ${dev.type}`, await p.data(), want);
      p.dispose();
    }
  });

  it('folds coupled weight decay into the gradient', async (t) => {
    const lr = 0.1;
    const decay = 0.05;
    const want = START.map((p, i) => p - (GRAD[i]! + p * decay) * lr);
    for (const dev of await listDevices()) {
      const p = await parameter(dev);
      new SGD([p], { lr, weightDecay: decay }).step();
      agrees(t, `sgd decay on ${dev.type}`, await p.data(), want);
      p.dispose();
    }
  });

  it('takes an Adam step', async (t) => {
    const lr = 0.1;
    const [beta1, beta2, epsilon] = [0.9, 0.999, 1e-8];
    const want = START.map((p, i) => {
      const g = GRAD[i]!;
      const m = g * (1 - beta1);
      const v = g * g * (1 - beta2);
      // First step, so the bias correction is 1 - beta.
      return p - (m / (1 - beta1) / (Math.sqrt(v / (1 - beta2)) + epsilon)) * lr;
    });
    for (const dev of await listDevices()) {
      const p = await parameter(dev);
      new Adam([p], { lr }).step();
      agrees(t, `adam on ${dev.type}`, await p.data(), want);
      p.dispose();
    }
  });

  it('separates Adam and AdamW weight decay', async (t) => {
    // The whole difference between them: Adam shrinks the gradient, so the adaptive
    // scaling divides the decay back out again; AdamW shrinks the parameter, outside
    // it. They must not agree.
    const lr = 0.1;
    const decay = 0.05;
    const [beta1, beta2, epsilon] = [0.9, 0.999, 1e-8];
    const adam = START.map((p, i) => {
      const g = GRAD[i]! + p * decay;
      const m = g * (1 - beta1);
      const v = g * g * (1 - beta2);
      return p - (m / (1 - beta1) / (Math.sqrt(v / (1 - beta2)) + epsilon)) * lr;
    });
    const adamW = START.map((p, i) => {
      const g = GRAD[i]!;
      const m = g * (1 - beta1);
      const v = g * g * (1 - beta2);
      const base = p - p * lr * decay;
      return base - (m / (1 - beta1) / (Math.sqrt(v / (1 - beta2)) + epsilon)) * lr;
    });
    t.ok(
      adam.some((value, i) => Math.abs(value - adamW[i]!) > 1e-4),
      'the two forms genuinely differ, so this test can tell them apart',
    );
    for (const dev of await listDevices()) {
      const a = await parameter(dev);
      new Adam([a], { lr, weightDecay: decay }).step();
      agrees(t, `adam decay on ${dev.type}`, await a.data(), adam);
      a.dispose();

      const w = await parameter(dev);
      new AdamW([w], { lr, weightDecay: decay }).step();
      agrees(t, `adamW decay on ${dev.type}`, await w.data(), adamW);
      w.dispose();
    }
  });

  it('keeps its moments across steps rather than restarting', async (t) => {
    // Ten steps of a constant gradient. If the moment buffers were not being carried
    // forward — the failure mode of updating them in place incorrectly — every step
    // would be identical and the total would be ten times one step.
    const lr = 0.01;
    for (const dev of await listDevices()) {
      const p = await parameter(dev);
      const optimizer = new AdamW([p], { lr });
      for (let step = 0; step < 10; step++) optimizer.step();
      const moved = [...(await p.data())].map((v, i) => Math.abs(Number(v) - START[i]!));
      const single = lr;
      t.ok(
        moved.every((d) => d > single * 5 && d < single * 11),
        `${dev.type} moved by roughly ten adaptive steps, not one or a hundred`,
      );
      p.dispose();
    }
  });

  it('agrees across every device', async (t) => {
    // The optimizer is where a backend disagreement compounds instead of averaging
    // out, since each step feeds the next.
    const devices = await listDevices();
    const trajectories = new Map<string, number[]>();
    for (const dev of devices) {
      const p = await parameter(dev);
      const optimizer = new AdamW([p], { lr: 0.05, weightDecay: 0.01 });
      for (let step = 0; step < 25; step++) optimizer.step();
      trajectories.set(dev.type, [...(await p.data())].map(Number));
      p.dispose();
    }
    const reference = trajectories.get('cpu')!;
    for (const [type, values] of trajectories) {
      if (type === 'cpu') continue;
      // Relative, and looser than the single-step checks above. Each step feeds the
      // next, so f32 rounding on the GPU compounds against the reference backend's f64
      // accumulation; what matters here is that it stays rounding rather than drift.
      agrees(t, `${type} after 25 steps`, values as unknown as ArrayLike<number>, reference, 1e-5);
    }
  });
});
