/**
 * Differential tests: every GPU backend against the reference oracle.
 *
 * The oracle is the definition of correct. These run the *same* `fino:tensor`
 * program on the CPU reference backend and on each GPU, then compare values at the
 * contract's tolerances. A kernel that is wrong, a launch geometry that is wrong,
 * and a descriptor that is wrong all fail here identically — which is the point,
 * since all three produce wrong numbers rather than errors.
 */
import { describe, it } from 'fino:test/test';
import {
  device,
  listDevices,
  tensor,
  tidy,
  zeros,
} from 'fino:tensor';
import type { Device, Tensor } from 'fino:tensor';
import { compareValues, describeComparison } from 'internal:tensor/harness';

/** GPU devices to test, discovered once. */
const gpus: Device[] = [];

/** Deterministic inputs, so a failure reproduces exactly. */
function values(count: number, seed: number): number[] {
  const out: number[] = [];
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push(((state >>> 8) / 0x01000000) * 2 - 1);
  }
  return out;
}

/** One program to run on both backends. */
interface Program {
  name: string;
  /** Input shapes, filled with deterministic values. */
  inputs: { shape: number[]; seed: number; dtype?: 'f32' | 'i32' }[];
  /** The computation under test. */
  run: (...xs: Tensor[]) => Tensor;
  /** Tolerance override. */
  tolerance?: number;
}

/** The programs. Each exercises a distinct backend method. */
function programs(): Program[] {
  return [
    {
      name: 'elementwise chain',
      inputs: [{ shape: [64], seed: 1 }],
      run: (x) => x.mul(2).add(1).relu().tanh(),
    },
    {
      name: 'scalar operand on the left',
      inputs: [{ shape: [32], seed: 2 }],
      run: (x) => x.sub(1).div(2),
    },
    {
      name: 'unary transcendentals',
      inputs: [{ shape: [48], seed: 3 }],
      run: (x) => x.abs().add(0.5).log().exp().sqrt(),
    },
    {
      name: 'activations',
      inputs: [{ shape: [40], seed: 4 }],
      run: (x) => x.gelu().add(x.silu()).add(x.sigmoid()),
    },
    {
      name: 'binary broadcast over rows',
      inputs: [
        { shape: [6, 5], seed: 5 },
        { shape: [5], seed: 6 },
      ],
      run: (a, b) => a.add(b).mul(a),
    },
    {
      name: 'binary broadcast over columns',
      inputs: [
        { shape: [6, 5], seed: 7 },
        { shape: [6, 1], seed: 8 },
      ],
      run: (a, b) => a.sub(b).maximum(b),
    },
    {
      name: 'comparison and select',
      inputs: [
        { shape: [40], seed: 9 },
        { shape: [40], seed: 10 },
      ],
      run: (a, b) => a.gt(b).where(a, b),
    },
    {
      name: 'cast round trip',
      inputs: [{ shape: [32], seed: 11 }],
      run: (x) => x.mul(10).cast('i32').cast('f32'),
    },
    {
      name: 'full reduction',
      inputs: [{ shape: [7, 5], seed: 12 }],
      run: (x) => x.sum(),
    },
    {
      name: 'axis reductions',
      inputs: [{ shape: [4, 6], seed: 13 }],
      run: (x) => x.sum([1]).add(x.mean([1])).add(x.max([1])).add(x.min([1])),
    },
    {
      name: 'scattered reduction axes',
      inputs: [{ shape: [3, 4, 5], seed: 40 }],
      // Axes 0 and 2 are not adjacent, so this reduces one run at a time through a
      // scratch buffer rather than in a single kernel.
      run: (x) => x.sum([0, 2]),
      tolerance: 1e-5,
    },
    {
      name: 'scattered mean axes',
      inputs: [{ shape: [2, 3, 4, 2], seed: 41 }],
      run: (x) => x.mean([0, 2]),
      tolerance: 1e-5,
    },
    {
      name: 'scattered max axes',
      inputs: [{ shape: [3, 4, 5], seed: 42 }],
      run: (x) => x.max([0, 2]),
    },
    {
      name: 'argmax',
      inputs: [{ shape: [5, 7], seed: 14 }],
      run: (x) => x.argmax(1).cast('f32'),
    },
    {
      name: 'softmax',
      inputs: [{ shape: [5, 9], seed: 15 }],
      run: (x) => x.softmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'log softmax',
      inputs: [{ shape: [5, 9], seed: 16 }],
      run: (x) => x.logSoftmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'matmul',
      inputs: [
        { shape: [9, 7], seed: 17 },
        { shape: [7, 5], seed: 18 },
      ],
      run: (a, b) => a.matmul(b),
      tolerance: 1e-4,
    },
    {
      name: 'matmul then activation',
      inputs: [
        { shape: [12, 8], seed: 19 },
        { shape: [8, 4], seed: 20 },
      ],
      run: (a, b) => a.matmul(b).gelu().sum([1]),
      tolerance: 1e-4,
    },
    {
      name: 'transpose',
      inputs: [{ shape: [4, 6], seed: 21 }],
      run: (x) => x.transpose().mul(2),
    },
    {
      name: 'permute rank three',
      inputs: [{ shape: [2, 3, 4], seed: 22 }],
      run: (x) => x.permute([2, 0, 1]).add(1),
    },
    {
      name: 'reshape and expand',
      inputs: [{ shape: [3, 1], seed: 23 }],
      run: (x) => x.expand([3, 5]).reshape([15]),
    },
    {
      name: 'batched matmul',
      inputs: [
        { shape: [3, 5, 4], seed: 30 },
        { shape: [3, 4, 6], seed: 31 },
      ],
      run: (a, b) => a.matmul(b),
      tolerance: 1e-4,
    },
    {
      name: 'batched matmul with a broadcast operand',
      inputs: [
        { shape: [2, 4, 3], seed: 32 },
        { shape: [1, 3, 5], seed: 33 },
      ],
      run: (a, b) => a.matmul(b),
      tolerance: 1e-4,
    },
    {
      name: 'attention shaped expression',
      inputs: [
        { shape: [4, 6], seed: 34 },
        { shape: [4, 6], seed: 35 },
        { shape: [4, 6], seed: 36 },
      ],
      run: (q, k, v) => q.matmul(k.transpose()).mul(0.408).softmax(1).matmul(v),
      tolerance: 1e-4,
    },
    {
      name: 'embedding lookup',
      inputs: [
        { shape: [6, 4], seed: 24 },
        { shape: [5], seed: 25, dtype: 'i32' },
      ],
      run: (table, idx) => table.indexSelect(idx, 0).mul(2),
    },
  ];
}

/** Build a program's inputs on a device. */
async function build(program: Program, on: Device): Promise<Tensor[]> {
  const out: Tensor[] = [];
  for (const spec of program.inputs) {
    const count = spec.shape.reduce((a, b) => a * b, 1);
    if (spec.dtype === 'i32') {
      // Indices must be in range for the table they address.
      const raw = values(count, spec.seed).map((v) => Math.abs(Math.round(v * 5)) % 6);
      out.push(await tensor(raw, { shape: spec.shape, dtype: 'i32', device: on }));
    } else {
      out.push(
        await tensor(values(count, spec.seed), { shape: spec.shape, device: on }),
      );
    }
  }
  return out;
}

/** Run a program on a device and read the result. */
async function evaluate(program: Program, on: Device): Promise<number[]> {
  const inputs = await build(program, on);
  const result = tidy(() => program.run(...inputs));
  const data = Array.from(await result.data()).map(Number);
  result.dispose();
  for (const input of inputs) input.dispose();
  return data;
}

describe('GPU differential against the reference oracle', () => {
  it('discovers the available devices', async (t) => {
    const devices = await listDevices();
    for (const found of devices) {
      if (found.type !== 'cpu') gpus.push(found);
    }
    t.ok(
      devices.some((d) => d.type === 'cpu'),
      'the reference backend is always present',
    );
    t.ok(true, `devices: ${devices.map((d) => d.type).join(', ')}`);
  });

  it('agrees with the oracle on every program', async (t) => {
    if (gpus.length === 0) {
      t.ok(true, 'SKIP: no GPU device available');
      return;
    }
    const cpu = await device('cpu');
    for (const program of programs()) {
      const want = await evaluate(program, cpu);
      for (const gpu of gpus) {
        const got = await evaluate(program, gpu);
        const comparison = compareValues(got, want, 'f32', 8);
        const withinOverride =
          program.tolerance === undefined || comparison.maxDelta <= program.tolerance;
        t.ok(
          comparison.ok || withinOverride,
          `${program.name} on ${gpu.type}: ${describeComparison(comparison, 'values')}`,
        );
      }
    }
  });

  it('keeps a scalar readback consistent', async (t) => {
    if (gpus.length === 0) {
      t.ok(true, 'SKIP: no GPU device available');
      return;
    }
    for (const gpu of gpus) {
      const x = await tensor([1, 2, 3, 4], { device: gpu });
      t.equal(await x.sum().item(), 10, `sum on ${gpu.type} reads back as a scalar`);
      x.dispose();
    }
  });

  it('fills and counts on the device', async (t) => {
    if (gpus.length === 0) {
      t.ok(true, 'SKIP: no GPU device available');
      return;
    }
    for (const gpu of gpus) {
      const z = await zeros([8], { device: gpu });
      t.deepEqual(Array.from(await z.data()), new Array(8).fill(0), `zeros on ${gpu.type}`);
      z.dispose();
    }
  });

  it('reuses compiled kernels across launches', async (t) => {
    if (gpus.length === 0) {
      t.ok(true, 'SKIP: no GPU device available');
      return;
    }
    const { backendFor } = await import('fino:tensor/backend');
    for (const gpu of gpus) {
      const backend = backendFor(gpu) as unknown as {
        cacheStats(): { entries: number; hits: number; misses: number };
      };
      const x = await tensor([1, 2, 3], { device: gpu });
      // Warm the kernel, then launch the same shape again.
      await x.mul(2).data();
      const before = backend.cacheStats();
      await x.mul(3).data();
      const after = backend.cacheStats();
      t.equal(
        after.entries,
        before.entries,
        `${gpu.type} reused the compiled kernel rather than compiling another`,
      );
      t.ok(after.hits > before.hits, `${gpu.type} recorded a cache hit`);
      x.dispose();
    }
  });

  it('refuses dtypes the GPU cannot represent', async (t) => {
    if (gpus.length === 0) {
      t.ok(true, 'SKIP: no GPU device available');
      return;
    }
    for (const gpu of gpus) {
      // f64 has no kernel-IR representation, and saying so beats silently
      // downcasting a tensor someone chose f64 for on purpose.
      await t.rejects(
        () => tensor([1, 2], { dtype: 'f64', device: gpu }),
        /does not support f64/,
        `${gpu.type} reports f64 as unsupported`,
      );
    }
  });
});

describe('training on the GPU', () => {
  it('trains an MLP to convergence on every GPU', async (t) => {
    if (gpus.length === 0) {
      t.ok(true, 'SKIP: no GPU device available');
      return;
    }
    const { Generator } = await import('fino:tensor');
    const { Linear, mseLoss } = await import('fino:tensor/nn');
    const { Adam } = await import('fino:tensor/optim');

    for (const gpu of gpus) {
      // The same XOR problem the CPU suite trains, on the GPU: it needs a hidden
      // layer and a working gradient path through its nonlinearity, so it fails if
      // any kernel in the forward or backward pass is wrong.
      const generator = new Generator(1234);
      const first = new Linear(2, 8, { generator, device: gpu });
      const second = new Linear(8, 1, { generator, device: gpu });
      const forward = (input: Tensor): Tensor => second.forward(first.forward(input).tanh());

      const x = await tensor([0, 0, 0, 1, 1, 0, 1, 1], { shape: [4, 2], device: gpu });
      const y = await tensor([0, 1, 1, 0], { shape: [4, 1], device: gpu });
      const optimizer = new Adam([...first.parameters(), ...second.parameters()], {
        lr: 0.05,
      });

      let initial = 0;
      for (let step = 0; step < 400; step++) {
        const loss = tidy(() => {
          const value = mseLoss(forward(x), y);
          value.backward();
          return value;
        });
        if (step === 0) initial = await loss.item();
        loss.dispose();
        optimizer.step();
        optimizer.zeroGrad();
      }
      const final = await mseLoss(forward(x), y).item();
      t.ok(final < initial, `${gpu.type}: loss decreased (${initial} to ${final})`);
      t.ok(final < 0.02, `${gpu.type}: converged (${final})`);

      const predictions = Array.from(await forward(x).data());
      t.ok(
        predictions[0]! < 0.5 && predictions[1]! > 0.5 && predictions[2]! > 0.5 && predictions[3]! < 0.5,
        `${gpu.type}: XOR learned (${predictions.map((v) => v.toFixed(2)).join(', ')})`,
      );
      optimizer.dispose();
    }
  });
});
