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
  gpuUnavailableReasons,
  listDevices,
  poolStats,
  tensor,
  tidy,
  zeros,
} from 'fino:tensor';
import type { Device, Tensor } from 'fino:tensor';
import { layerNorm, rmsNorm } from 'fino:tensor/nn';
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
      run: (x) =>
        x
          .sum([1])
          .add(x.mean([1]))
          .add(x.max([1]))
          .add(x.min([1])),
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
    // Rows longer than one SIMD group take the workgroup-per-row tree reduction;
    // the short rows above take the row-per-thread kernel. Both need covering, since
    // the backend picks between them by row length and only one is the default for
    // any given shape.
    {
      // Enough rows to clear the occupancy bar, which is what selects the
      // row-per-thread kernel; every other row-wise case here is too small and takes
      // the workgroup-per-row tree reduction instead.
      name: 'softmax over many short rows',
      inputs: [{ shape: [20000, 6], seed: 58 }],
      run: (x) => x.softmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'layer norm over many short rows',
      inputs: [
        { shape: [20000, 6], seed: 59 },
        { shape: [6], seed: 60 },
        { shape: [6], seed: 61 },
      ],
      run: (x, w, b) => layerNorm(x, w, b),
      tolerance: 1e-5,
    },
    {
      name: 'softmax over a long row',
      inputs: [{ shape: [3, 300], seed: 43 }],
      run: (x) => x.softmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'log softmax over a long row',
      inputs: [{ shape: [2, 513], seed: 44 }],
      run: (x) => x.logSoftmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'softmax over a row exactly at the row-per-thread limit',
      inputs: [{ shape: [4, 64], seed: 45 }],
      run: (x) => x.softmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'softmax over a row just past the row-per-thread limit',
      inputs: [{ shape: [4, 65], seed: 46 }],
      run: (x) => x.softmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'softmax over a long interior axis',
      inputs: [{ shape: [2, 130, 3], seed: 47 }],
      run: (x) => x.softmax(1),
      tolerance: 1e-5,
    },
    {
      name: 'layer norm over a short row',
      inputs: [
        { shape: [6, 5], seed: 48 },
        { shape: [5], seed: 49 },
        { shape: [5], seed: 50 },
      ],
      run: (x, w, b) => layerNorm(x, w, b),
      tolerance: 1e-5,
    },
    {
      name: 'layer norm over a long row',
      inputs: [
        { shape: [3, 288], seed: 51 },
        { shape: [288], seed: 52 },
        { shape: [288], seed: 53 },
      ],
      run: (x, w, b) => layerNorm(x, w, b),
      tolerance: 1e-5,
    },
    {
      name: 'rms norm over both row lengths',
      inputs: [
        { shape: [4, 7], seed: 54 },
        { shape: [7], seed: 55 },
      ],
      run: (x, w) => rmsNorm(x, w),
      tolerance: 1e-5,
    },
    {
      name: 'rms norm over a long row',
      inputs: [
        { shape: [2, 200], seed: 56 },
        { shape: [200], seed: 57 },
      ],
      run: (x, w) => rmsNorm(x, w),
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
      name: 'contiguous slice',
      inputs: [{ shape: [5, 6], seed: 62 }],
      run: (x) => x.slice([{ start: 1, end: 4 }, { start: 2 }]).mul(2),
    },
    {
      // A start offset is folded into the source view rather than handled by its own
      // kernel, so this is also the check that a strided copy reads from the view's
      // beginning and not the buffer's.
      name: 'strided slice',
      inputs: [{ shape: [7, 8], seed: 63 }],
      run: (x) =>
        x.slice([
          { start: 1, step: 2 },
          { start: 3, step: 3 },
        ]),
    },
    {
      name: 'narrow on an interior axis',
      inputs: [{ shape: [2, 5, 3], seed: 64 }],
      run: (x) => x.narrow(1, 1, 3).add(1),
    },
    {
      name: 'slice of a slice',
      inputs: [{ shape: [8, 9], seed: 65 }],
      run: (x) => x.slice([{ start: 2 }]).slice([{ start: 1, step: 2 }, { end: 4 }]),
    },
    {
      name: 'slice feeding a matmul',
      inputs: [
        { shape: [6, 5], seed: 66 },
        { shape: [3, 4], seed: 67 },
      ],
      run: (a, b) => a.narrow(0, 2, 3).narrow(1, 1, 3).matmul(b),
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
      out.push(await tensor(values(count, spec.seed), { shape: spec.shape, device: on }));
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

describe('GPU discovery is self-consistent', () => {
  it('yields a device for every backend that reports itself available', async (t) => {
    // The invariant that keeps this whole suite honest. Every test here loops over the
    // GPUs it found, so a backend that quietly stops being discovered does not fail
    // anything — it just gets tested less, and the suite still reports success. This
    // caught exactly that: a Vulkan backend that threw during probing while its
    // availability check still claimed it was fine.
    const found = new Set((await listDevices()).map((d) => d.type));
    for (const [type, reason] of Object.entries(gpuUnavailableReasons())) {
      if (reason !== null) continue;
      t.ok(
        found.has(type),
        `${type} reports no reason for being unavailable, so it must yield a device`,
      );
    }
  });
});

describe('GPU dispatch backpressure', () => {
  it('stays flat over many launches when the loop yields', async (t) => {
    for (const dev of gpus) {
      const x = await zeros([4096], { device: dev });
      const before = poolStats(dev).liveBuffers;
      for (let batch = 0; batch < 4; batch++) {
        for (let i = 0; i < 2000; i++) tidy(() => void x.add(1));
        // One yield per batch is all a GPU needs: it lets queued work be submitted and
        // lets a first-seen kernel finish compiling.
        await Promise.resolve();
      }
      t.equal(
        poolStats(dev).liveBuffers,
        before,
        `nothing new stays live on ${dev.type} after 8000 launches`,
      );
      x.dispose();
    }
    if (gpus.length === 0) t.ok(true, 'no GPU to exercise');
  });

  it('names the cause when an uncompiled kernel is launched without yielding', async (t) => {
    // Compilation is asynchronous, so a loop that never yields cannot finish compiling
    // a kernel it has not seen before — and every launch behind it queues. That used to
    // end as an out-of-memory crash with nothing to point at.
    //
    // The rank-6 permute is what makes this deterministic: strided copy is specialised
    // per rank and nothing else in the suite goes past rank four, so the first
    // iteration is guaranteed to be a compile.
    for (const dev of gpus) {
      const x = await zeros([2, 1, 1, 1, 1, 2], { device: dev });
      t.throws(
        () => {
          for (let i = 0; i < 200_000; i++) tidy(() => void x.permute([5, 4, 3, 2, 1, 0]));
        },
        /without the event loop running/,
        `explains the stall on ${dev.type}`,
      );
      x.dispose();
      // Let the queue drain so the next device starts clean.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (gpus.length === 0) t.ok(true, 'no GPU to exercise');
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
        predictions[0]! < 0.5 &&
          predictions[1]! > 0.5 &&
          predictions[2]! > 0.5 &&
          predictions[3]! < 0.5,
        `${gpu.type}: XOR learned (${predictions.map((v) => v.toFixed(2)).join(', ')})`,
      );
      optimizer.dispose();
    }
  });
});
