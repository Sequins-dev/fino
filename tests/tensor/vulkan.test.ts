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
import { env } from 'fino:process';
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

// Every case here skips when there is no device, which is right on a machine that has
// none and useless where one was meant to be installed: a driver that failed to install
// leaves the whole Vulkan suite passing vacuously, and that is precisely how three
// SPIR-V defects reached the tree. Somewhere that means to test Vulkan sets this and
// finds out instead.
if (!available && env.FINO_REQUIRE_VULKAN === '1') {
  throw new Error(`FINO_REQUIRE_VULKAN=1 but there is no Vulkan compute device: ${reason()}`);
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

describe('Vulkan staged transfers', () => {
  it('round-trips through device-local memory', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    // A discrete GPU's device-local memory is not host-visible, so transfers go
    // through a staging buffer and an explicit copy. This exercises that path
    // directly by asking for non-host-visible memory, which works on an integrated
    // GPU too — otherwise the discrete path would ship untested.
    const context = VulkanCompute.create();
    const deviceLocal = context.createBuffer(64, { hostVisible: false });
    const stage = context.createBuffer(64, { hostVisible: true });
    t.ok(stage.mapped !== null, 'the staging buffer is host-visible');

    const source = new Float32Array(stage.mapped!);
    for (let i = 0; i < 16; i++) source[i] = i * 1.5;
    const up = context.copyBuffer(deviceLocal, 0, stage, 0, 64);
    await context.waitFor(up);

    // Clear the staging buffer so the read cannot pass by reading its own input.
    source.fill(0);
    const down = context.copyBuffer(stage, 0, deviceLocal, 0, 64);
    await context.waitFor(down);
    const result = Array.from(new Float32Array(stage.mapped!));
    t.deepEqual(
      result,
      Array.from({ length: 16 }, (_, i) => i * 1.5),
      'values survived the round trip through device-local memory',
    );

    context.destroyBuffer(stage);
    context.destroyBuffer(deviceLocal);
    context.dispose();
  });
  it('computes on device-local memory', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    // A kernel reading and writing memory the host cannot address, with the inputs
    // staged in and the results staged out.
    const context = VulkanCompute.create();
    const { ir } = unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32');
    const pipeline = context.createPipeline(lowerToSPIRV(ir), ir.name);
    const count = 32;
    const bytes = count * 4;
    const input = context.createBuffer(bytes, { hostVisible: false });
    const out = context.createBuffer(bytes, { hostVisible: false });
    const stage = context.createBuffer(bytes, { hostVisible: true });

    const staged = new Float32Array(stage.mapped!);
    for (let i = 0; i < count; i++) staged[i] = i % 2 === 0 ? -1 : i;
    await context.waitFor(context.copyBuffer(input, 0, stage, 0, bytes));

    const token = context.dispatch({
      pipeline,
      buffers: [input, out],
      params: packParams(ir.params, { n: count }),
      groups: [Math.ceil(count / ir.wg[0]), 1, 1],
    });
    await context.waitFor(token);
    await context.waitFor(context.copyBuffer(stage, 0, out, 0, bytes));

    const result = Array.from(new Float32Array(stage.mapped!));
    const expect = Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 0 : i));
    t.deepEqual(result, expect, 'relu ran on memory the host cannot address');

    context.destroyBuffer(stage);
    context.destroyBuffer(out);
    context.destroyBuffer(input);
    context.destroyPipeline(pipeline);
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

describe('Vulkan ordering', () => {
  /**
   * Dispatching while a wait is outstanding used to lose the work.
   *
   * The wait is asynchronous so the event loop keeps running across it, which is the
   * whole point — and this engine dispatches eagerly, so work arriving mid-wait is the
   * normal case. Reclaiming the command pool when the wait returned freed the buffer
   * that work had been recorded into and dropped it, while its timeline value had
   * already been handed out. Anything that later waited for that value waited forever,
   * which is a hang rather than a wrong answer, and only when the timing lined up.
   */
  it('keeps work dispatched while a wait is outstanding', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    const context = VulkanCompute.create();
    const { ir } = unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32');
    const pipeline = context.createPipeline(lowerToSPIRV(ir), ir.name);
    const count = 32;
    const input = context.createBuffer(count * 4);
    const out = context.createBuffer(count * 4);
    new Float32Array(input.mapped!).fill(-1);

    const launch = () =>
      context.dispatch({
        pipeline,
        buffers: [input, out],
        params: packParams(ir.params, { n: count }),
        groups: [Math.ceil(count / ir.wg[0]), 1, 1],
      });

    const first = context.waitFor(launch());
    // Recorded after the wait was issued, so it lands in a command buffer the wait's
    // cleanup used to free. Its value is the one that could then never be signalled,
    // and awaiting it hung rather than returning something wrong.
    const second = launch();
    await first;
    await context.waitFor(second);

    t.equal(new Float32Array(out.mapped!)[0], 0, 'the second dispatch ran');
    context.destroyBuffer(out);
    context.destroyBuffer(input);
    context.destroyPipeline(pipeline);
    context.dispose();
  });
});

describe('Vulkan capture and replay', () => {
  /**
   * A captured run is fixed work over fixed memory.
   *
   * The command buffer records buffer addresses rather than values, so replaying does
   * the same arithmetic again over whatever those buffers now hold. That is what makes
   * it useful for a training step — the parameters are updated in place, so the same
   * recorded work applied twice advances two steps — and it is also the whole of the
   * contract: a caller who allocates fresh tensors per iteration cannot replay.
   */
  it('runs recorded work again over the same buffers', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason()}`);
      return;
    }
    const context = VulkanCompute.create();
    // In-place doubling: x + x written back over x, so each run advances the values
    // rather than recomputing them. That is what proves a replay ran, where an
    // idempotent kernel would look identical either way.
    const { ir } = binaryKernel(
      'add',
      [
        { dtype: 'f32', layout: 'cont' },
        { dtype: 'f32', layout: 'cont' },
      ],
      'f32',
    );
    const pipeline = context.createPipeline(lowerToSPIRV(ir), ir.name);
    const count = 64;
    const buffer = context.createBuffer(count * 4);
    new Float32Array(buffer.mapped!).fill(1);

    context.captureBegin();
    t.ok(context.capturing, 'the device reports it is capturing');
    const value = context.dispatch({
      pipeline,
      buffers: [buffer, buffer, buffer],
      params: packParams(ir.params, { n: count }),
      groups: [Math.ceil(count / ir.wg[0]), 1, 1],
    });
    t.equal(value, 0n, 'a captured dispatch signals nothing, because it queued nothing');
    const executable = context.captureEnd();
    t.ok(!context.capturing, 'and the capture is closed');

    t.equal(new Float32Array(buffer.mapped!)[0], 1, 'capturing alone runs nothing');

    await context.waitFor(context.replay(executable));
    t.equal(new Float32Array(buffer.mapped!)[0], 2, 'the first replay ran the work');

    await context.waitFor(context.replay(executable));
    t.equal(new Float32Array(buffer.mapped!)[0], 4, 'and it can be replayed again');

    context.destroyExecutable(executable);
    context.destroyBuffer(buffer);
    context.destroyPipeline(pipeline);
    context.dispose();
  });

  it('keeps replayed work ordered against ordinary dispatches', async (t) => {
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
    const pipeline = context.createPipeline(lowerToSPIRV(ir), ir.name);
    const count = 64;
    const buffer = context.createBuffer(count * 4);
    new Float32Array(buffer.mapped!).fill(1);
    const launch = () =>
      context.dispatch({
        pipeline,
        buffers: [buffer, buffer, buffer],
        params: packParams(ir.params, { n: count }),
        groups: [Math.ceil(count / ir.wg[0]), 1, 1],
      });

    context.captureBegin();
    launch();
    const executable = context.captureEnd();

    // An ordinary dispatch is batched rather than submitted, so a replay that did not
    // flush first would reach the queue ahead of work that was issued before it.
    launch();
    const after = context.replay(executable);
    await context.waitFor(after);
    t.equal(new Float32Array(buffer.mapped!)[0], 4, 'both the batched dispatch and the replay ran');

    context.destroyExecutable(executable);
    context.destroyBuffer(buffer);
    context.destroyPipeline(pipeline);
    context.dispose();
  });
});
