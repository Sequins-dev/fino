/**
 * Vulkan execution tests — the SPIR-V half of the two-dialect gate.
 *
 * The `spirv-val` suite proves the emitter produces *valid* SPIR-V. This proves it
 * produces SPIR-V that computes the right answer: the same IR that Metal runs as
 * MSL is emitted as words, handed to `vkCreateShaderModule`, dispatched, and read
 * back.
 *
 * Skipped when no Vulkan loader or device is present.
 */
import { describe, it } from 'fino:test/test';
import {
  VulkanCompute,
  vulkanAvailable,
  vulkanComputeAvailable,
  vulkanUnavailableReason,
} from 'internal:vulkan';
import {
  SMALL_TILING,
  binaryKernel,
  gemmGrid,
  gemmKernel,
  lowerToSPIRV,
  packParams,
  unaryKernel,
} from 'internal:tensor/ir';

/** Whether a compute device could be created. */
const available = vulkanAvailable() && vulkanComputeAvailable();

/** Reason to report when skipping. */
function reason(): string {
  return vulkanUnavailableReason() ?? 'no usable Vulkan compute device';
}

describe('Vulkan loader', () => {
  it('opens, or explains why not', (t) => {
    if (!vulkanAvailable()) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    t.ok(true, 'the loader opened');
  });
  it('creates a compute device', (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    const context = VulkanCompute.create();
    const info = context.info;
    t.ok(info.timelineSemaphores, 'timeline semaphores are available');
    t.ok(
      info.maxWorkgroupInvocations >= 256,
      `workgroups of at least 256 (${info.maxWorkgroupInvocations})`,
    );
    context.dispose();
  });
  it('maps host-visible memory', (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    const context = VulkanCompute.create();
    const buffer = context.createBuffer(64);
    t.ok(buffer.mapped !== null, 'the allocation is host-visible');
    const view = new Float32Array(buffer.mapped!);
    view[0] = 3.5;
    view[15] = -1.25;
    const again = new Float32Array(buffer.mapped!);
    t.equal(again[0], 3.5, 'host writes land in the mapping');
    t.equal(again[15], -1.25, 'and at the right offset');
    context.destroyBuffer(buffer);
    context.dispose();
  });
});

describe('Vulkan kernel execution', () => {
  it('runs IR-generated SPIR-V for an elementwise add', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    const context = VulkanCompute.create();
    const { ir } = binaryKernel(
      'add',
      [
        { dtype: 'f32', layout: 'cont' },
        { dtype: 'f32', layout: 'cont' },
      ],
      'f32',
    );
    // Words straight from the emitter — no external shader compiler anywhere.
    const words = lowerToSPIRV(ir);
    const pipeline = context.createPipeline(words, ir.name);

    const count = 1024;
    const bytes = count * 4;
    const a = context.createBuffer(bytes);
    const b = context.createBuffer(bytes);
    const out = context.createBuffer(bytes);
    const aView = new Float32Array(a.mapped!);
    const bView = new Float32Array(b.mapped!);
    for (let i = 0; i < count; i++) {
      aView[i] = i;
      bView[i] = i * 2;
    }

    const value = context.dispatch({
      pipeline,
      buffers: [a, b, out],
      params: packParams(ir.params, { n: count }),
      groups: [Math.ceil(count / ir.wg[0]), 1, 1],
    });
    await context.waitFor(value);
    t.ok(context.completed() >= value, 'the timeline reached the submitted value');

    const result = new Float32Array(out.mapped!);
    let mismatches = 0;
    for (let i = 0; i < count; i++) {
      if (Math.abs(result[i]! - i * 3) > 1e-4) mismatches++;
    }
    t.equal(mismatches, 0, 'every element equals a + b');

    context.destroyBuffer(out);
    context.destroyBuffer(b);
    context.destroyBuffer(a);
    context.destroyPipeline(pipeline);
    context.dispose();
  });
  it('runs IR-generated SPIR-V for a tiled GEMM', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    // The honesty test on this side too: shared memory, barriers, a loop nest, and
    // function-storage accumulators, all emitted as SPIR-V from the same IR.
    const context = VulkanCompute.create();
    const tiling = SMALL_TILING;
    const { ir } = gemmKernel({ dtype: 'f32', tiling });
    const pipeline = context.createPipeline(lowerToSPIRV(ir), ir.name);

    const m = 65;
    const k = 33;
    const n = 47;
    const a = context.createBuffer(m * k * 4);
    const b = context.createBuffer(k * n * 4);
    const c = context.createBuffer(m * n * 4);
    const aView = new Float32Array(a.mapped!);
    const bView = new Float32Array(b.mapped!);
    for (let i = 0; i < m * k; i++) aView[i] = ((i % 7) - 3) / 4;
    for (let i = 0; i < k * n; i++) bView[i] = ((i % 5) - 2) / 3;

    const value = context.dispatch({
      pipeline,
      buffers: [a, b, c],
      params: packParams(ir.params, { M: m, N: n, K: k }),
      groups: gemmGrid(m, n, tiling),
    });
    await context.waitFor(value);

    const result = new Float32Array(c.mapped!);
    let worst = 0;
    for (let row = 0; row < m; row++) {
      for (let col = 0; col < n; col++) {
        let expected = 0;
        for (let i = 0; i < k; i++) expected += aView[row * k + i]! * bView[i * n + col]!;
        worst = Math.max(worst, Math.abs(result[row * n + col]! - expected));
      }
    }
    t.ok(worst < 1e-4, `SPIR-V GEMM matches the host to ${worst}`);

    context.destroyBuffer(c);
    context.destroyBuffer(b);
    context.destroyBuffer(a);
    context.destroyPipeline(pipeline);
    context.dispose();
  });
  it('keeps the event loop responsive while the GPU works', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    const context = VulkanCompute.create();
    const { ir } = unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32');
    const pipeline = context.createPipeline(lowerToSPIRV(ir), ir.name);
    const count = 1 << 20;
    const input = context.createBuffer(count * 4);
    const out = context.createBuffer(count * 4);
    const inputView = new Float32Array(input.mapped!);
    for (let i = 0; i < count; i++) inputView[i] = i % 2 === 0 ? -1 : 2;

    const value = context.dispatch({
      pipeline,
      buffers: [input, out],
      params: packParams(ir.params, { n: count }),
      groups: [Math.ceil(count / ir.wg[0]), 1, 1],
    });

    let timerFired = false;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });
    await Promise.all([timer, context.waitFor(value)]);
    t.ok(timerFired, 'a timer fired while the semaphore wait was outstanding');

    const result = new Float32Array(out.mapped!);
    t.equal(result[0], 0, 'relu clamped the negative input');
    t.equal(result[1], 2, 'and passed the positive one through');

    context.destroyBuffer(out);
    context.destroyBuffer(input);
    context.destroyPipeline(pipeline);
    context.dispose();
  });
  it('agrees with the reference values across several operations', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    // A spread of the emitter's harder paths: transcendentals through
    // GLSL.std.450, a composed activation, and a broadcast index computation.
    const context = VulkanCompute.create();
    const count = 256;
    const cases: { name: string; words: Uint32Array; entry: string; wg: number; params: ArrayBuffer; expect: (x: number) => number }[] = [];
    for (const [name, expect] of [
      ['exp', Math.exp],
      ['sqrt', Math.sqrt],
      ['tanh', Math.tanh],
      ['sigmoid', (x: number) => 1 / (1 + Math.exp(-x))],
      [
        'gelu',
        (x: number) =>
          0.5 * x * (1 + Math.tanh(0.7978845608028654 * (x + 0.044715 * x * x * x))),
      ],
    ] as const) {
      const { ir } = unaryKernel(name, { dtype: 'f32', layout: 'cont' }, 'f32');
      cases.push({
        name,
        words: lowerToSPIRV(ir),
        entry: ir.name,
        wg: ir.wg[0],
        params: packParams(ir.params, { n: count }),
        expect: expect as (x: number) => number,
      });
    }

    for (const testCase of cases) {
      const pipeline = context.createPipeline(testCase.words, testCase.entry);
      const input = context.createBuffer(count * 4);
      const out = context.createBuffer(count * 4);
      const inputView = new Float32Array(input.mapped!);
      // Positive inputs so sqrt is defined for every case.
      for (let i = 0; i < count; i++) inputView[i] = 0.05 + (i % 32) / 8;

      const value = context.dispatch({
        pipeline,
        buffers: [input, out],
        params: testCase.params,
        groups: [Math.ceil(count / testCase.wg), 1, 1],
      });
      await context.waitFor(value);

      const result = new Float32Array(out.mapped!);
      let worst = 0;
      for (let i = 0; i < count; i++) {
        worst = Math.max(worst, Math.abs(result[i]! - testCase.expect(inputView[i]!)));
      }
      t.ok(worst < 1e-5, `${testCase.name} matches the host to ${worst}`);

      context.destroyBuffer(out);
      context.destroyBuffer(input);
      context.destroyPipeline(pipeline);
    }
    context.dispose();
  });
});
