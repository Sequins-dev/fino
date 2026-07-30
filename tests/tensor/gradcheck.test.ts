/**
 * Gradient checks against central finite differences.
 *
 * This validates the tape independently of any kernel: if `backward()` and a
 * difference quotient of the same forward function agree, the gradient rules are
 * right regardless of how the forward pass was computed. Runs in f64, because in
 * f32 the quotient's cancellation error exceeds the gradient it is measuring.
 */
import { describe, it } from 'fino:test/test';
import { device, tensor } from 'fino:tensor';
import type { Tensor } from 'fino:tensor';
import { describeGradCheck, gradCheck, sampleValues } from 'internal:tensor/harness';
import { differentiableOps } from 'internal:tensor/ops/registry';

/**
 * Build an f64 input with reproducible values.
 *
 * Pinned to the reference backend rather than the default device. That is not a
 * workaround: gradient checking needs f64 to be meaningful at all, since in f32 the
 * difference quotient's cancellation error exceeds the gradient it measures — and
 * f64 has no kernel-IR representation, because no GPU this engine targets supports
 * it. The oracle is where this check belongs.
 */
async function input(shape: readonly number[], seed: number): Promise<Tensor> {
  const count = shape.reduce((a, b) => a * b, 1);
  return tensor(sampleValues(count, seed), {
    shape,
    dtype: 'f64',
    device: await device('cpu'),
    requiresGrad: true,
  });
}

/** Assert every input's gradient matches finite differences. */
async function check(
  t: { ok(value: unknown, message: string): void },
  label: string,
  fn: (...xs: Tensor[]) => Tensor,
  inputs: Tensor[],
  options?: { eps?: number; rtol?: number; atol?: number },
): Promise<void> {
  const results = await gradCheck(fn, inputs, options);
  for (const result of results) {
    t.ok(result.ok, `${label}: ${describeGradCheck(result)}`);
  }
}

describe('gradcheck: unary operations', () => {
  it('checks smooth elementwise functions', async (t) => {
    const cases: [string, (x: Tensor) => Tensor][] = [
      ['neg', (x) => x.neg().sum()],
      ['exp', (x) => x.exp().sum()],
      ['tanh', (x) => x.tanh().sum()],
      ['sigmoid', (x) => x.sigmoid().sum()],
      ['gelu', (x) => x.gelu().sum()],
      ['silu', (x) => x.silu().sum()],
      ['erf', (x) => x.erf().sum()],
      ['sin', (x) => x.sin().sum()],
      ['cos', (x) => x.cos().sum()],
    ];
    for (const [name, fn] of cases) {
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [await input([6], 7)]);
    }
  });
  it('checks functions needing positive inputs', async (t) => {
    // log, sqrt, and rsqrt are undefined at or below zero, so the input is shifted
    // rather than the check being skipped.
    const positive = async () => {
      const x = await input([5], 11);
      return x.abs().add(0.5).detach() as Tensor;
    };
    for (const [name, fn] of [
      ['log', (x: Tensor) => x.log().sum()],
      ['sqrt', (x: Tensor) => x.sqrt().sum()],
      ['rsqrt', (x: Tensor) => x.rsqrt().sum()],
    ] as const) {
      const x = await positive();
      x.requiresGrad = true;
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [x]);
    }
  });
  it('checks relu away from its kink', async (t) => {
    // The gradient at exactly zero is not defined; sampled values avoid it.
    await check(t, 'relu', (x) => x.relu().sum(), [await input([8], 13)]);
  });
  it('checks abs away from zero', async (t) => {
    await check(t, 'abs', (x) => x.abs().sum(), [await input([8], 17)]);
  });
});

describe('gradcheck: binary operations', () => {
  it('checks arithmetic', async (t) => {
    for (const [name, fn] of [
      ['add', (a: Tensor, b: Tensor) => a.add(b).sum()],
      ['sub', (a: Tensor, b: Tensor) => a.sub(b).sum()],
      ['mul', (a: Tensor, b: Tensor) => a.mul(b).sum()],
    ] as const) {
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [
        await input([4], 19),
        await input([4], 23),
      ]);
    }
  });
  it('checks division with a bounded denominator', async (t) => {
    const a = await input([4], 29);
    const raw = await input([4], 31);
    const b = raw.abs().add(0.8).detach();
    b.requiresGrad = true;
    await check(t, 'div', (x, y) => x.div(y).sum(), [a, b]);
  });
  it('checks scalar operands', async (t) => {
    for (const [name, fn] of [
      ['add scalar', (x: Tensor) => x.add(3).sum()],
      ['mul scalar', (x: Tensor) => x.mul(2.5).sum()],
      ['sub scalar', (x: Tensor) => x.sub(1.5).sum()],
      ['div scalar', (x: Tensor) => x.div(2).sum()],
    ] as const) {
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [await input([5], 37)]);
    }
  });
  it('checks maximum and minimum', async (t) => {
    for (const [name, fn] of [
      ['maximum', (a: Tensor, b: Tensor) => a.maximum(b).sum()],
      ['minimum', (a: Tensor, b: Tensor) => a.minimum(b).sum()],
    ] as const) {
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [
        await input([5], 41),
        await input([5], 43),
      ]);
    }
  });
  it('checks broadcasting gradients', async (t) => {
    // The operand shapes differ, so each gradient must be summed back down.
    await check(
      t,
      'broadcast add',
      (a, b) => a.add(b).sum(),
      [await input([3, 4], 47), await input([4], 53)],
    );
    await check(
      t,
      'broadcast mul',
      (a, b) => a.mul(b).sum(),
      [await input([3, 4], 59), await input([3, 1], 61)],
    );
  });
});

describe('gradcheck: reductions', () => {
  it('checks sum and mean', async (t) => {
    for (const [name, fn] of [
      ['sum', (x: Tensor) => x.sum()],
      ['mean', (x: Tensor) => x.mean()],
      ['axis sum', (x: Tensor) => x.sum([1]).sum()],
      ['axis mean', (x: Tensor) => x.mean([0]).sum()],
    ] as const) {
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [await input([3, 4], 67)]);
    }
  });
  it('checks max and min', async (t) => {
    for (const [name, fn] of [
      ['max', (x: Tensor) => x.max().sum()],
      ['min', (x: Tensor) => x.min().sum()],
      ['axis max', (x: Tensor) => x.max([1]).sum()],
    ] as const) {
      await check(t, name, fn as (...xs: Tensor[]) => Tensor, [await input([3, 4], 71)]);
    }
  });
  it('checks prod', async (t) => {
    await check(t, 'prod', (x) => x.prod([1]).sum(), [await input([2, 3], 73)]);
  });
  it('checks softmax and log-softmax', async (t) => {
    await check(t, 'softmax', (x) => x.softmax(1).sum(), [await input([3, 4], 79)]);
    // Summing log-softmax directly is degenerate; weight it so the gradient bites.
    await check(
      t,
      'logSoftmax',
      (x) => x.logSoftmax(1).mul(x).sum(),
      [await input([3, 4], 83)],
    );
  });
});

describe('gradcheck: matmul and movement', () => {
  it('checks matmul', async (t) => {
    await check(
      t,
      'matmul',
      (a, b) => a.matmul(b).sum(),
      [await input([3, 4], 89), await input([4, 2], 97)],
    );
  });
  it('checks batched matmul', async (t) => {
    await check(
      t,
      'batched matmul',
      (a, b) => a.matmul(b).sum(),
      [await input([2, 3, 4], 101), await input([2, 4, 3], 103)],
    );
  });
  it('checks reshape, transpose, and permute', async (t) => {
    await check(t, 'reshape', (x) => x.reshape([4, 3]).sum(), [await input([3, 4], 107)]);
    await check(t, 'transpose', (x) => x.transpose().mul(2).sum(), [await input([3, 4], 109)]);
    await check(
      t,
      'permute',
      (x) => x.permute([1, 2, 0]).sum(),
      [await input([2, 3, 4], 113)],
    );
  });
  it('checks expand', async (t) => {
    await check(t, 'expand', (x) => x.expand([3, 4]).sum(), [await input([3, 1], 127)]);
  });
  it('checks indexSelect', async (t) => {
    const table = await input([4, 3], 131);
    const idx = await tensor([2, 0, 2], { dtype: 'i32', device: await device('cpu') });
    // Index 2 appears twice, so its gradient must accumulate rather than overwrite.
    await check(t, 'indexSelect', (x) => x.indexSelect(idx, 0).sum(), [table]);
  });
});

describe('gradcheck: composed expressions', () => {
  it('checks a two-layer network', async (t) => {
    const x = await input([2, 3], 137);
    const w1 = await input([3, 4], 139);
    const w2 = await input([4, 1], 149);
    await check(
      t,
      'mlp',
      (xx, a, b) => xx.matmul(a).tanh().matmul(b).sum(),
      [x, w1, w2],
    );
  });
  it('checks a softmax cross-entropy loss', async (t) => {
    const logits = await input([3, 4], 151);
    const dev = await device('cpu');
    // A one-hot target matrix, so the loss picks each row's target class. Built
    // once outside the checked function since it carries no gradient.
    const oneHot = await tensor(
      [
        [0, 1, 0, 0],
        [1, 0, 0, 0],
        [0, 0, 0, 1],
      ],
      { dtype: 'f64', device: dev },
    );
    await check(
      t,
      'cross entropy',
      (l) => l.logSoftmax(1).mul(oneHot).sum().neg(),
      [logits],
    );
  });
  it('checks an attention-shaped expression', async (t) => {
    const q = await input([2, 3], 157);
    const k = await input([2, 3], 163);
    const v = await input([2, 3], 167);
    await check(
      t,
      'attention',
      (qq, kk, vv) => qq.matmul(kk.transpose()).mul(0.577).softmax(1).matmul(vv).sum(),
      [q, k, v],
    );
  });
  it('checks layer norm over one and two trailing axes', async (t) => {
    const { layerNorm } = await import('fino:tensor/nn');
    // The gradient rule views the tensor as [rows, n] using the recorded extent, so
    // both spans have to be checked rather than assuming the last axis.
    await check(
      t,
      'layerNorm one axis',
      (x) => layerNorm(x, null, null, 1e-5, 1).mul(x).sum(),
      [await input([3, 4], 181)],
    );
    await check(
      t,
      'layerNorm two axes',
      (x) => layerNorm(x, null, null, 1e-5, 2).mul(x).sum(),
      [await input([2, 3, 4], 191)],
    );
  });
  it('checks affine layer norm', async (t) => {
    const { layerNorm } = await import('fino:tensor/nn');
    const x = await input([3, 4], 193);
    const weight = await input([4], 197);
    const bias = await input([4], 199);
    await check(
      t,
      'affine layerNorm',
      (xx, w, b) => layerNorm(xx, w, b, 1e-5, 1).sum(),
      [x, weight, bias],
    );
  });
  it('checks a residual and normalisation chain', async (t) => {
    const x = await input([2, 4], 173);
    await check(
      t,
      'residual',
      (xx) => {
        const mean = xx.mean([1], true);
        const centred = xx.sub(mean);
        const variance = centred.mul(centred).mean([1], true);
        const normalized = centred.div(variance.add(1e-5).sqrt());
        return normalized.add(xx).gelu().sum();
      },
      [x],
    );
  });
});

describe('gradcheck coverage', () => {
  it('names every differentiable operation', (t) => {
    const covered = new Set([
      'neg',
      'abs',
      'exp',
      'log',
      'sqrt',
      'rsqrt',
      'sin',
      'cos',
      'tanh',
      'sigmoid',
      'relu',
      'silu',
      'gelu',
      'erf',
      'add',
      'sub',
      'mul',
      'div',
      'pow',
      'maximum',
      'minimum',
      'where',
      'cast',
      'sum',
      'mean',
      'prod',
      'max',
      'min',
      'softmax',
      'logSoftmax',
      'layerNorm',
      'gemm',
      'reshape',
      'permute',
      'expand',
      'indexSelect',
      'scatterAdd',
    ]);
    const uncovered = differentiableOps()
      .map((op) => op.name)
      .filter((name) => !covered.has(name));
    t.deepEqual(
      uncovered,
      [],
      'every operation with a gradient rule is listed in this suite',
    );
  });
});
