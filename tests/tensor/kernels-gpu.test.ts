/**
 * Every kernel template, executed on every available GPU.
 *
 * One table of cases, run through both backends. That is the point: the same IR,
 * the same expected values, two dialects, two drivers. A template that is subtly
 * dialect-dependent fails on one side and passes on the other, which is the failure
 * mode this file exists to catch.
 */
import { describe, it } from 'fino:test/test';
import {
  SMALL_TILING,
  arangeKernel,
  argReduceKernel,
  binaryKernel,
  fillKernel,
  gemmGrid,
  gemmKernel,
  indexSelectKernel,
  layerNormKernel,
  linearGrid,
  lowerToMSL,
  lowerToSPIRV,
  optimizerKernel,
  packParams,
  randomKernel,
  reduceKernel,
  rowGrid,
  scatterAddKernel,
  softmaxKernel,
  stridedCopyKernel,
  unaryKernel,
} from 'internal:tensor/ir';
import type { KernelIR } from 'internal:tensor/ir';
import { createMetalApi, metalAvailable } from 'internal:metal';
import { VulkanCompute, vulkanAvailable, vulkanComputeAvailable } from 'internal:vulkan';

/** One kernel to run, its inputs, and what it should produce. */
interface Case {
  name: string;
  ir: KernelIR;
  /** Buffers in binding order; `null` marks the output to check. */
  buffers: (Float32Array | Int32Array | null)[];
  params: Record<string, number>;
  /** Workgroups to launch. */
  groups: [number, number, number];
  /** Expected output values. */
  expect: number[];
  /** Absolute tolerance. */
  tolerance?: number;
  /** Read the output as integers. */
  integer?: boolean;
  /**
   * Which buffer holds the result.
   *
   * Defaults to the `null` placeholder. An in-place kernel such as an optimizer
   * step has no placeholder — it writes back into a buffer it also reads — so those
   * name their output explicitly.
   */
  output?: number;
}

/** Deterministic values, so a failure reproduces. */
function ramp(count: number, f: (i: number) => number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = f(i);
  return out;
}

/** Build the case table. */
function cases(): Case[] {
  const list: Case[] = [];

  // Reductions over a [2, 4, 3] view reduced along the middle axis.
  {
    const outer = 2;
    const reduce = 4;
    const inner = 3;
    const n = outer * inner;
    const input = ramp(outer * reduce * inner, (i) => ((i % 5) - 2) / 2);
    const read = (o: number, r: number, k: number) => input[(o * reduce + r) * inner + k]!;
    for (const [op, fold] of [
      ['sum', (vs: number[]) => vs.reduce((a, b) => a + b, 0)],
      ['mean', (vs: number[]) => vs.reduce((a, b) => a + b, 0) / vs.length],
      ['max', (vs: number[]) => Math.max(...vs)],
      ['min', (vs: number[]) => Math.min(...vs)],
      ['prod', (vs: number[]) => vs.reduce((a, b) => a * b, 1)],
    ] as const) {
      const expect: number[] = [];
      for (let o = 0; o < outer; o++) {
        for (let k = 0; k < inner; k++) {
          expect.push(fold(Array.from({ length: reduce }, (_, r) => read(o, r, k))));
        }
      }
      list.push({
        name: `reduce ${op}`,
        ir: reduceKernel({ op, dtype: 'f32' }).ir,
        buffers: [input, null],
        params: { n, reduceSize: reduce, innerSize: inner },
        groups: linearGrid(n),
        expect,
      });
    }
    // argmax returns positions along the reduced axis.
    const argExpect: number[] = [];
    for (let o = 0; o < outer; o++) {
      for (let k = 0; k < inner; k++) {
        const values = Array.from({ length: reduce }, (_, r) => read(o, r, k));
        argExpect.push(values.indexOf(Math.max(...values)));
      }
    }
    list.push({
      name: 'argmax',
      ir: argReduceKernel({ op: 'argmax', dtype: 'f32' }).ir,
      buffers: [input, null],
      params: { n, reduceSize: reduce, innerSize: inner },
      groups: linearGrid(n),
      expect: argExpect,
      integer: true,
    });
  }

  // Softmax over rows, including a row of large logits that would overflow without
  // the maximum subtraction.
  {
    const rows = 3;
    const cols = 5;
    const input = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        input[r * cols + c] = r === 2 ? 1000 + c : (c - 2) / 2;
      }
    }
    for (const log of [false, true]) {
      const expect: number[] = [];
      for (let r = 0; r < rows; r++) {
        const row = Array.from({ length: cols }, (_, c) => input[r * cols + c]!);
        const peak = Math.max(...row);
        const exps = row.map((v) => Math.exp(v - peak));
        const total = exps.reduce((a, b) => a + b, 0);
        for (let c = 0; c < cols; c++) {
          expect.push(log ? row[c]! - peak - Math.log(total) : exps[c]! / total);
        }
      }
      list.push({
        name: log ? 'logSoftmax' : 'softmax',
        ir: softmaxKernel({ dtype: 'f32', log, wg: 64 }).ir,
        buffers: [input, null],
        params: { cols, inner: 1 },
        groups: rowGrid(rows),
        expect,
        // The deliberately extreme row sits at f32's precision floor: the host
        // reference accumulates in f64, so a few ulps of disagreement is correct
        // behaviour rather than a kernel fault.
        tolerance: 5e-5,
      });
    }
  }

  // Softmax over an interior axis of a [2, 3, 4] tensor, reducing the middle one.
  // This is what the stride form buys: no transpose, one kernel.
  {
    const outer = 2;
    const axisSize = 3;
    const inner = 4;
    const input = ramp(outer * axisSize * inner, (i) => ((i % 5) - 2) / 2);
    const expect = new Array(outer * axisSize * inner).fill(0);
    for (let o = 0; o < outer; o++) {
      for (let k = 0; k < inner; k++) {
        const base = o * axisSize * inner + k;
        const row = Array.from({ length: axisSize }, (_, a) => input[base + a * inner]!);
        const peak = Math.max(...row);
        const exps = row.map((v) => Math.exp(v - peak));
        const total = exps.reduce((a, b) => a + b, 0);
        for (let a = 0; a < axisSize; a++) expect[base + a * inner] = exps[a]! / total;
      }
    }
    list.push({
      name: 'softmax over an interior axis',
      ir: softmaxKernel({ dtype: 'f32', wg: 2 }).ir,
      buffers: [input, null],
      params: { cols: axisSize, inner },
      groups: rowGrid(outer * inner),
      expect,
      tolerance: 1e-6,
    });
  }

  // Gather along an interior axis of a [2, 4, 3] table.
  {
    const outer = 2;
    const axisSize = 4;
    const inner = 3;
    const table = ramp(outer * axisSize * inner, (i) => i);
    const idx = new Int32Array([3, 1]);
    const expect: number[] = [];
    for (let o = 0; o < outer; o++) {
      for (const raw of idx) {
        for (let k = 0; k < inner; k++) {
          expect.push(table[(o * axisSize + raw) * inner + k]!);
        }
      }
    }
    list.push({
      name: 'indexSelect over an interior axis',
      ir: indexSelectKernel({ dtype: 'f32' }).ir,
      buffers: [table, idx, null, new Uint32Array(1)],
      params: {
        n: outer * idx.length * inner,
        count: idx.length,
        inner,
        axisSize,
      },
      groups: linearGrid(outer * idx.length * inner),
      expect,
    });
  }

  // Layer norm with an affine transform, and the rms variant without.
  {
    const rows = 3;
    const cols = 8;
    const input = ramp(rows * cols, (i) => ((i % 7) - 3) / 2);
    const weight = ramp(cols, (i) => 1 + i / 10);
    const bias = ramp(cols, (i) => -i / 20);
    const epsilon = 1e-5;

    const affine: number[] = [];
    for (let r = 0; r < rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => input[r * cols + c]!);
      const mean = row.reduce((a, b) => a + b, 0) / cols;
      const variance = row.reduce((a, b) => a + (b - mean) ** 2, 0) / cols;
      const scale = 1 / Math.sqrt(variance + epsilon);
      for (let c = 0; c < cols; c++) {
        affine.push((row[c]! - mean) * scale * weight[c]! + bias[c]!);
      }
    }
    list.push({
      name: 'layerNorm affine',
      ir: layerNormKernel({ dtype: 'f32', weight: true, bias: true, wg: 64 }).ir,
      buffers: [input, weight, bias, null],
      params: { cols, epsilon },
      groups: rowGrid(rows),
      expect: affine,
      tolerance: 1e-5,
    });

    const rms: number[] = [];
    for (let r = 0; r < rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => input[r * cols + c]!);
      const meanSquare = row.reduce((a, b) => a + b * b, 0) / cols;
      const scale = 1 / Math.sqrt(meanSquare + epsilon);
      for (let c = 0; c < cols; c++) rms.push(row[c]! * scale);
    }
    list.push({
      name: 'rmsNorm',
      ir: layerNormKernel({ dtype: 'f32', rms: true, wg: 64 }).ir,
      buffers: [input, null],
      params: { cols, epsilon },
      groups: rowGrid(rows),
      expect: rms,
      tolerance: 1e-5,
    });
  }

  // Fill and arange.
  list.push({
    name: 'fill',
    ir: fillKernel({ dtype: 'f32' }).ir,
    buffers: [null],
    params: { n: 16, value: -2.5 },
    groups: linearGrid(16),
    expect: new Array(16).fill(-2.5),
  });
  list.push({
    name: 'arange',
    ir: arangeKernel({ dtype: 'f32' }).ir,
    buffers: [null],
    params: { n: 8, start: 3, step: 2.5 },
    groups: linearGrid(8),
    expect: Array.from({ length: 8 }, (_, i) => 3 + i * 2.5),
  });

  // Strided copy expressing a transpose: read [3,4] with swapped strides.
  {
    const rows = 3;
    const cols = 4;
    const input = ramp(rows * cols, (i) => i);
    const expect: number[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) expect.push(input[r * cols + c]!);
    }
    list.push({
      name: 'stridedCopy transpose',
      ir: stridedCopyKernel({ rank: 2, from: 'f32' }).ir,
      buffers: [input, null],
      // Output shape is [cols, rows]; strides read the source transposed.
      params: { n: rows * cols, base: 0, shape0: cols, shape1: rows, stride0: 1, stride1: cols },
      groups: linearGrid(rows * cols),
      expect,
    });
  }

  // Strided copy expressing a broadcast: a zero stride repeats a row.
  {
    const input = new Float32Array([5, 6, 7]);
    list.push({
      name: 'stridedCopy broadcast',
      ir: stridedCopyKernel({ rank: 2, from: 'f32' }).ir,
      buffers: [input, null],
      params: { n: 6, base: 0, shape0: 2, shape1: 3, stride0: 0, stride1: 1 },
      groups: linearGrid(6),
      expect: [5, 6, 7, 5, 6, 7],
    });
  }

  // Strided copy from an offset view: what a slice lowers to. The base skips the
  // first row and the strides step every other column, so a wrong base reads plausible
  // values from the wrong place rather than failing.
  {
    const input = ramp(3 * 4, (i) => i + 1);
    list.push({
      name: 'stridedCopy from an offset',
      ir: stridedCopyKernel({ rank: 2, from: 'f32' }).ir,
      buffers: [input, null],
      params: { n: 4, base: 4, shape0: 2, shape1: 2, stride0: 4, stride1: 2 },
      groups: linearGrid(4),
      expect: [5, 7, 9, 11],
    });
  }

  // Embedding forward: gather rows, including a repeated index.
  {
    const table = ramp(4 * 3, (i) => i);
    const idx = new Int32Array([2, 0, 2, -1]);
    const expect: number[] = [];
    for (const raw of idx) {
      const row = raw < 0 ? raw + 4 : raw;
      for (let k = 0; k < 3; k++) expect.push(table[row * 3 + k]!);
    }
    list.push({
      name: 'indexSelect',
      ir: indexSelectKernel({ dtype: 'f32' }).ir,
      buffers: [table, idx, null, new Uint32Array(1)],
      params: { n: idx.length * 3, count: idx.length, inner: 3, axisSize: 4 },
      groups: linearGrid(idx.length * 3),
      expect,
    });
  }

  // Embedding backward: repeated indices must accumulate, not race.
  {
    const idx = new Int32Array([1, 1, 3]);
    const src = ramp(idx.length * 2, (i) => i + 1);
    const zeros = new Float32Array(4 * 2);
    const expect = new Array(8).fill(0);
    for (let i = 0; i < idx.length; i++) {
      for (let k = 0; k < 2; k++) expect[idx[i]! * 2 + k] += src[i * 2 + k]!;
    }
    list.push({
      name: 'scatterAdd',
      ir: scatterAddKernel({ dtype: 'f32' }).ir,
      buffers: [idx, src, zeros, new Uint32Array(1)],
      params: { n: idx.length * 2, count: idx.length, inner: 2, axisSize: 4 },
      groups: linearGrid(idx.length * 2),
      expect,
      output: 2,
    });
  }

  // Optimizer steps against a hand-computed update.
  {
    const param = new Float32Array([1, -2, 0.5]);
    const grad = new Float32Array([0.1, 0.2, -0.3]);
    const lr = 0.1;
    list.push({
      name: 'sgd step',
      ir: optimizerKernel({ kind: 'sgd', dtype: 'f32' }).ir,
      buffers: [param, grad],
      params: { n: 3, lr, decay: 0 },
      groups: linearGrid(3),
      expect: [1 - lr * 0.1, -2 - lr * 0.2, 0.5 - lr * -0.3],
      tolerance: 1e-6,
      output: 0,
    });

    const adamParam = new Float32Array([1, -2, 0.5]);
    const m = new Float32Array(3);
    const v = new Float32Array(3);
    const beta1 = 0.9;
    const beta2 = 0.999;
    const epsilon = 1e-8;
    // A single step from zeroed moments, with the bias corrections for step one.
    const corr1 = 1 - beta1;
    const corr2 = 1 - beta2;
    const adamExpect = [0, 1, 2].map((i) => {
      const g = grad[i]!;
      const mn = (1 - beta1) * g;
      const vn = (1 - beta2) * g * g;
      return adamParam[i]! - (lr * (mn / corr1)) / (Math.sqrt(vn / corr2) + epsilon);
    });
    list.push({
      name: 'adam step',
      ir: optimizerKernel({ kind: 'adam', dtype: 'f32' }).ir,
      buffers: [adamParam, grad, m, v],
      params: { n: 3, lr, decay: 0, beta1, beta2, epsilon, corr1, corr2 },
      groups: linearGrid(3),
      expect: adamExpect,
      tolerance: 1e-5,
      output: 0,
    });
  }

  // Elementwise and GEMM, so the whole library is covered in one place.
  {
    const a = ramp(64, (i) => (i % 9) - 4);
    list.push({
      name: 'relu',
      ir: unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32').ir,
      buffers: [a, null],
      params: { n: 64 },
      groups: linearGrid(64),
      expect: Array.from(a, (v) => Math.max(v, 0)),
    });
    const b = ramp(64, (i) => i / 8);
    list.push({
      name: 'add',
      ir: binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'cont' },
        ],
        'f32',
      ).ir,
      buffers: [a, b, null],
      params: { n: 64 },
      groups: linearGrid(64),
      expect: Array.from(a, (v, i) => v + b[i]!),
    });
  }
  {
    const m = 17;
    const k = 9;
    const n = 13;
    const a = ramp(m * k, (i) => ((i % 7) - 3) / 4);
    const b = ramp(k * n, (i) => ((i % 5) - 2) / 3);
    const expect: number[] = [];
    for (let row = 0; row < m; row++) {
      for (let col = 0; col < n; col++) {
        let total = 0;
        for (let i = 0; i < k; i++) total += a[row * k + i]! * b[i * n + col]!;
        expect.push(total);
      }
    }
    list.push({
      name: 'gemm',
      ir: gemmKernel({ dtype: 'f32', tiling: SMALL_TILING }).ir,
      buffers: [a, b, null],
      params: { M: m, N: n, K: k },
      groups: gemmGrid(m, n, SMALL_TILING),
      expect,
      tolerance: 1e-5,
    });
  }

  return list;
}

/** Cases whose values must match the host generator exactly. */
function randomCases(): Case[] {
  // The counter-based scheme means the GPU must produce the *same* stream as the
  // host, not merely a similar distribution. These compare against the host
  // sampler element by element.
  const count = 64;
  const keyLo = 0x12345678;
  const keyHi = 0x9abcdef0;
  const list: Case[] = [];
  for (const kind of ['uniform', 'bernoulli'] as const) {
    const ir = randomKernel({ kind, dtype: 'f32' }).ir;
    list.push({
      name: `random ${kind}`,
      ir,
      buffers: [null],
      params:
        kind === 'uniform'
          ? { n: count, keyLo, keyHi, counter: 0, low: 0, high: 1 }
          : { n: count, keyLo, keyHi, counter: 0, p: 0.5 },
      groups: linearGrid(count),
      // Filled in by the caller from the host sampler.
      expect: [],
      tolerance: 1e-6,
    });
  }
  return list;
}

/** Run one case on Metal and compare. */
async function runMetal(testCase: Case): Promise<number[]> {
  const api = createMetalApi();
  const device = api.createDevice();
  const queue = api.createQueue(device);
  const event = api.createSharedEvent(device);
  const library = await api.compileLibrary(device, lowerToMSL(testCase.ir, { fastMath: false }));
  const pipeline = api.createPipeline(device, library, testCase.ir.name);

  const outputIndex = testCase.buffers.findIndex((b) => b === null);
  const outputCount = testCase.expect.length;
  const handles = testCase.buffers.map((source, index) => {
    const bytes = source ? source.byteLength : outputCount * 4;
    const buffer = api.createBuffer(device, Math.max(bytes, 4));
    if (source) {
      const view = api.bufferContents(buffer, Math.max(bytes, 4));
      if (source instanceof Int32Array) new Int32Array(view).set(source);
      else new Float32Array(view).set(source);
    }
    void index;
    return { buffer, bytes: Math.max(bytes, 4) };
  });
  // A case with no explicit null writes into its last buffer in place.
  const resultIndex = testCase.output ?? (outputIndex >= 0 ? outputIndex : handles.length - 1);

  const batch = api.beginBatch(queue);
  api.encode(batch, {
    pipeline,
    buffers: handles.map((h) => ({ buffer: h.buffer, offset: 0 })),
    params: packParams(testCase.ir.params, testCase.params),
    grid: testCase.groups,
    threadgroup: testCase.ir.wg,
  });
  api.commitBatch(batch, event, 1n);
  if (!(await api.waitForEvent(event, 1n, 20000))) {
    throw new Error(`${testCase.name}: Metal dispatch timed out`);
  }
  const target = handles[resultIndex]!;
  const view = api.bufferContents(target.buffer, target.bytes);
  const values = testCase.integer
    ? Array.from(new Int32Array(view).subarray(0, outputCount))
    : Array.from(new Float32Array(view).subarray(0, outputCount));

  for (const h of handles) api.destroy(h.buffer);
  api.destroy(pipeline.state);
  api.destroy(library);
  api.destroy(event);
  api.destroy(queue);
  api.destroy(device);
  return values;
}

/** Run one case on Vulkan and compare. */
async function runVulkan(testCase: Case): Promise<number[]> {
  const context = VulkanCompute.create();
  const pipeline = context.createPipeline(lowerToSPIRV(testCase.ir), testCase.ir.name);

  const outputIndex = testCase.buffers.findIndex((b) => b === null);
  const outputCount = testCase.expect.length;
  const handles = testCase.buffers.map((source) => {
    const bytes = Math.max(source ? source.byteLength : outputCount * 4, 4);
    const buffer = context.createBuffer(bytes);
    if (source) {
      if (source instanceof Int32Array) new Int32Array(buffer.mapped!).set(source);
      else new Float32Array(buffer.mapped!).set(source);
    }
    return buffer;
  });
  const resultIndex = testCase.output ?? (outputIndex >= 0 ? outputIndex : handles.length - 1);

  const value = context.dispatch({
    pipeline,
    buffers: handles,
    params: packParams(testCase.ir.params, testCase.params),
    groups: testCase.groups,
  });
  await context.waitFor(value);

  const target = handles[resultIndex]!;
  const values = testCase.integer
    ? Array.from(new Int32Array(target.mapped!).subarray(0, outputCount))
    : Array.from(new Float32Array(target.mapped!).subarray(0, outputCount));

  for (const h of handles) context.destroyBuffer(h);
  context.destroyPipeline(pipeline);
  context.dispose();
  return values;
}

/** Compare and report the worst deviation. */
function worstError(got: readonly number[], want: readonly number[]): number {
  let worst = 0;
  for (let i = 0; i < want.length; i++) {
    worst = Math.max(worst, Math.abs((got[i] ?? NaN) - want[i]!));
  }
  return worst;
}

const metalReady = metalAvailable();
const vulkanReady = vulkanAvailable() && vulkanComputeAvailable();

describe('kernel library on Metal', () => {
  it('matches host reference values for every template', async (t) => {
    if (!metalReady) {
      t.ok(true, 'SKIP: no Metal device');
      return;
    }
    for (const testCase of cases()) {
      const got = await runMetal(testCase);
      const worst = worstError(got, testCase.expect);
      t.ok(worst <= (testCase.tolerance ?? 1e-6), `${testCase.name}: worst deviation ${worst}`);
    }
  });
});

describe('kernel library on Vulkan', () => {
  it('matches host reference values for every template', async (t) => {
    if (!vulkanReady) {
      t.ok(true, 'SKIP: no Vulkan compute device');
      return;
    }
    for (const testCase of cases()) {
      let got: number[];
      try {
        got = await runVulkan(testCase);
      } catch (cause) {
        t.ok(false, `${testCase.name}: ${cause instanceof Error ? cause.message : cause}`);
        continue;
      }
      const worst = worstError(got, testCase.expect);
      t.ok(worst <= (testCase.tolerance ?? 1e-6), `${testCase.name}: worst deviation ${worst}`);
    }
  });
});

describe('random sampling agrees across host and GPU', () => {
  it('produces the host stream element for element', async (t) => {
    if (!metalReady && !vulkanReady) {
      t.ok(true, 'SKIP: no GPU device');
      return;
    }
    const { philox4x32, uniformFromBits } = await import('internal:tensor/generator');
    const count = 64;
    const keyLo = 0x12345678;
    const keyHi = 0x9abcdef0;
    // The host derivation, which the kernel must reproduce exactly.
    const expectUniform: number[] = [];
    for (let i = 0; i < count; i++) {
      const words = philox4x32(keyLo, keyHi, i >> 2, 0);
      expectUniform.push(uniformFromBits(words[i & 3]!));
    }

    for (const testCase of randomCases()) {
      const expect =
        testCase.name === 'random uniform'
          ? expectUniform
          : expectUniform.map((u) => (u < 0.5 ? 1 : 0));
      const prepared: Case = { ...testCase, expect };
      if (metalReady) {
        const got = await runMetal(prepared);
        t.ok(
          worstError(got, expect) < 1e-6,
          `${testCase.name} on Metal matches the host stream (${worstError(got, expect)})`,
        );
      }
      if (vulkanReady) {
        const got = await runVulkan(prepared);
        t.ok(
          worstError(got, expect) < 1e-6,
          `${testCase.name} on Vulkan matches the host stream (${worstError(got, expect)})`,
        );
      }
    }
  });
});
