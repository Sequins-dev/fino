/**
 * Mixed precision: autocast and loss scaling.
 *
 * The scaler's arithmetic is exact — scaling and unscaling are multiplication by
 * reciprocal constants — so these check exact values rather than tolerances, except
 * where half precision is genuinely involved.
 */
import { describe, it } from 'fino:test/test';
import { GradScaler, autocast, autocastDType, device, listDevices, tensor } from 'fino:tensor';

describe('autocast', () => {
  it('narrows a matrix multiply and nothing else', async (t) => {
    for (const dev of await listDevices()) {
      if (dev.type === 'cpu') continue;
      const a = await tensor([1, 2, 3, 4], { shape: [2, 2], device: dev });
      const b = await tensor([1, 0, 0, 1], { shape: [2, 2], device: dev });
      t.equal(a.matmul(b).dtype, 'f32', `${dev.type} leaves matmul alone outside a scope`);
      autocast('f16', () => {
        t.equal(a.matmul(b).dtype, 'f16', `${dev.type} narrows the matmul`);
        // An elementwise operation is not on the list: its error compounds through a
        // chain rather than averaging over a reduction.
        t.equal(a.mul(2).dtype, 'f32', `${dev.type} leaves elementwise work alone`);
      });
      a.dispose();
      b.dispose();
    }
  });

  it('computes the same answer narrowed', async (t) => {
    // Values chosen to be exact in half precision, so the only thing under test is
    // that narrowing happened rather than how it rounds.
    for (const dev of await listDevices()) {
      if (dev.type === 'cpu') continue;
      const a = await tensor([1, 2, 3, 4], { shape: [2, 2], device: dev });
      const b = await tensor([2, 0, 0, 2], { shape: [2, 2], device: dev });
      const narrow = autocast('f16', () => a.matmul(b));
      t.deepEqual(
        [...(await narrow.data())].map(Number),
        [2, 4, 6, 8],
        `${dev.type} matches the wide answer`,
      );
      a.dispose();
      b.dispose();
      narrow.dispose();
    }
  });

  it('nests and restores', (t) => {
    t.equal(autocastDType(), null, 'off by default');
    autocast('f16', () => {
      t.equal(autocastDType(), 'f16', 'on inside a scope');
      autocast(null, () => t.equal(autocastDType(), null, 'a region can opt back out'));
      t.equal(autocastDType(), 'f16', 'and the outer scope resumes');
    });
    t.equal(autocastDType(), null, 'off again afterwards');
  });

  it('never widens', async (t) => {
    // Narrowing to f32 what is already f16 would undo the point of holding it narrow.
    const dev = await device('auto');
    const a = await tensor([1, 2, 3, 4], { shape: [2, 2], dtype: 'f16', device: dev });
    const out = autocast('f32', () => a.matmul(a));
    t.equal(out.dtype, 'f16', 'an f16 operand stays f16 under an f32 scope');
    a.dispose();
    out.dispose();
  });
});

describe('loss scaling', () => {
  it('unscales exactly', async (t) => {
    const dev = await device('auto');
    const x = await tensor([1, 2, 3, 4], { device: dev, requiresGrad: true });
    const scaler = new GradScaler({ initial: 1024 });
    scaler.scale_(x.mul(3).sum()).backward();
    const finite = await scaler.unscale([x]);
    t.ok(finite, 'gradients are usable');
    // The gradient of 3x summed is 3 everywhere, scaled by 1024 and back again.
    t.deepEqual([...(await x.grad!.data())].map(Number), [3, 3, 3, 3], 'scaling cancels exactly');
    x.dispose();
  });

  it('detects an overflow and backs the scale off', async (t) => {
    const dev = await device('auto');
    const x = await tensor([1, 2], { device: dev, requiresGrad: true });
    const scaler = new GradScaler({ initial: 2 ** 120, backoff: 0.5 });
    // A scale this large sends an f32 gradient to infinity.
    scaler.scale_(x.mul(2 ** 120).sum()).backward();
    const finite = await scaler.unscale([x]);
    t.ok(!finite, 'the overflow is noticed');
    t.equal(scaler.skipped, 1, 'and the step is counted as skipped');
    const before = scaler.scale;
    scaler.update(finite);
    t.equal(scaler.scale, before * 0.5, 'the scale halves');
    x.dispose();
  });

  it('grows the scale after a run of healthy steps', (t) => {
    const scaler = new GradScaler({ initial: 4, growth: 2, interval: 3 });
    scaler.update(true);
    scaler.update(true);
    t.equal(scaler.scale, 4, 'not yet');
    scaler.update(true);
    t.equal(scaler.scale, 8, 'after the interval');
  });

  it('never lets the scale reach zero', (t) => {
    const scaler = new GradScaler({ initial: 2, backoff: 0.5 });
    for (let i = 0; i < 20; i++) scaler.update(false);
    t.ok(scaler.scale >= 1, `the floor holds at ${scaler.scale}`);
  });
});
