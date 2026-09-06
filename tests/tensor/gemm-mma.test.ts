/**
 * The cooperative-matrix GEMM, built from the IR rather than by hand.
 *
 * `mma-spike.test.ts` established that the instructions are worth using in half
 * precision and wrote the kernel in MSL directly. This checks the port: that the same
 * shape expressed through the IR still computes the right product and still beats the
 * scalar kernel, since a template that lowered to something slower would be a
 * regression nothing else would notice.
 */
import { describe, it } from 'fino:test/test';
import { createMetalApi, metalAvailable } from 'internal:metal';
import {
  DEFAULT_TILING,
  GEMM_MMA_THREADS,
  gemmGrid,
  gemmKernel,
  gemmMmaFits,
  gemmMmaGrid,
  gemmMmaKernel,
  lowerToMSL,
  packParams,
} from 'internal:tensor/ir';

describe('cooperative matrix gemm', () => {
  it('accepts only shapes that divide its tile', (t) => {
    t.ok(gemmMmaFits(1024, 1024, 1024), 'a square power of two fits');
    t.ok(gemmMmaFits(128, 640, 32), 'so does any multiple of the tile and step');
    t.ok(!gemmMmaFits(100, 1024, 1024), 'a ragged M does not');
    t.ok(!gemmMmaFits(1024, 100, 1024), 'nor a ragged N');
    t.ok(!gemmMmaFits(1024, 1024, 48), 'nor a K that is not a multiple of the step');
  });

  it('computes the same product as the scalar kernel, faster', async (t) => {
    if (!metalAvailable()) {
      t.ok(true, 'SKIP: no Metal device');
      return;
    }
    const api = createMetalApi();
    const device = api.createDevice();
    const queue = api.createQueue(device);
    const event = api.createSharedEvent(device);

    const n = 1024;
    const bytes = n * n * 2;
    const a = api.createBuffer(device, bytes);
    const b = api.createBuffer(device, bytes);
    const outMma = api.createBuffer(device, bytes);
    const outScalar = api.createBuffer(device, bytes);
    const av = new Float16Array(api.bufferContents(a, bytes));
    const bv = new Float16Array(api.bufferContents(b, bytes));
    for (let i = 0; i < av.length; i++) {
      av[i] = (((i * 3) % 17) - 8) / 32;
      bv[i] = (((i * 7) % 17) - 8) / 32;
    }

    const mma = gemmMmaKernel({ dtype: 'f16' });
    t.equal(mma.ir.caps?.matrix, true, 'the kernel declares that it needs matrices');
    const mmaLib = await api.compileLibrary(device, lowerToMSL(mma.ir, { fastMath: false }));
    const mmaPipe = api.createPipeline(device, mmaLib, mma.ir.name);

    const scalar = gemmKernel({ dtype: 'f16', tiling: DEFAULT_TILING, noEdgeGuards: true });
    const scalarLib = await api.compileLibrary(device, lowerToMSL(scalar.ir, { fastMath: false }));
    const scalarPipe = api.createPipeline(device, scalarLib, scalar.ir.name);

    let signal = 0n;
    const run = async (
      pipeline: unknown,
      out: unknown,
      params: Uint8Array,
      grid: readonly number[],
      threads: readonly number[],
      iterations: number,
    ): Promise<number> => {
      const start = performance.now();
      const batch = api.beginBatch(queue);
      for (let i = 0; i < iterations; i++) {
        api.encode(batch as never, {
          pipeline: pipeline as never,
          buffers: [
            { buffer: a, offset: 0 },
            { buffer: b, offset: 0 },
            { buffer: out as never, offset: 0 },
          ],
          params,
          grid: grid as never,
          threadgroup: threads as never,
        });
      }
      signal += 1n;
      api.commitBatch(batch, event, signal);
      await api.waitForEvent(event, signal, 30000);
      return (performance.now() - start) / 1000 / iterations;
    };

    const mmaParams = packParams(mma.ir.params, { M: n, N: n, K: n });
    const scalarParams = packParams(scalar.ir.params, { M: n, N: n, K: n });
    const runMma = () =>
      run(mmaPipe, outMma, mmaParams, gemmMmaGrid(n, n), [GEMM_MMA_THREADS, 1, 1], 20);
    const runScalar = () =>
      run(scalarPipe, outScalar, scalarParams, gemmGrid(n, n, DEFAULT_TILING, 1), scalar.ir.wg, 20);

    await runMma();
    await runScalar();
    let bestMma = Infinity;
    let bestScalar = Infinity;
    for (let pass = 0; pass < 4; pass++) {
      bestMma = Math.min(bestMma, await runMma());
      bestScalar = Math.min(bestScalar, await runScalar());
    }

    const mmaView = new Float16Array(api.bufferContents(outMma, bytes));
    const scalarView = new Float16Array(api.bufferContents(outScalar, bytes));
    let worst = 0;
    let scale = 1;
    for (let i = 0; i < mmaView.length; i++) {
      worst = Math.max(worst, Math.abs(mmaView[i]! - scalarView[i]!));
      scale = Math.max(scale, Math.abs(scalarView[i]!));
    }
    t.ok(worst / scale < 5e-3, `agrees with the scalar kernel (worst ${worst})`);

    const flops = 2 * n ** 3;
    const mmaRate = flops / bestMma / 1e9;
    const scalarRate = flops / bestScalar / 1e9;
    // The reason this kernel exists. A generous threshold: the measured margin is 1.3x
    // and the point is to catch a port that lost the benefit, not to pin a ratio that
    // will differ on other hardware.
    t.ok(
      mmaRate > scalarRate,
      `is faster than the scalar kernel (${mmaRate.toFixed(0)} vs ${scalarRate.toFixed(0)} GFLOP/s)`,
    );

    for (const buffer of [a, b, outMma, outScalar]) api.destroy(buffer);
  });
});
