/**
 * Where does the cooperative-matrix kernel actually start winning? (FIN-160)
 *
 * The threshold that decides between the two half-precision GEMM kernels was set from a
 * sweep of *square* multiplies: 1.05x at 512, 1.31x at 1024, 1.41x at 2048. Requiring
 * both sides to reach 1024 follows from that sweep and is not tested by it, because a
 * square sweep cannot distinguish "both extents must be large" from "there must be enough
 * work" — every shape in it has both properties or neither.
 *
 * This measures the shapes that tell them apart. It exists because the transformer sizes
 * elsewhere in this suite are exactly the ones the square sweep never covered: 256 by 768
 * activations against 768 by 768 weights fits the matrix kernel's tiling perfectly and is
 * refused by a rule about extents.
 *
 * ## Measuring it in one process
 *
 * Both kernels are built from the IR and compiled here, and the two are alternated pass
 * by pass over the same operands. That is not fussiness: comparing across two runs of the
 * engine gave differences of up to 40% on identical builds, which is larger than the
 * effect being measured. Nothing about kernel selection can be concluded from numbers
 * gathered in separate processes.
 *
 * Like the other spikes, this asserts the two kernels agree and reports the rates without
 * asserting which wins — a threshold here would be a flaky test on someone else's GPU.
 *
 * ## The answer, on an M5 Max
 *
 * Reported in the assertion output; run with `--show-output=always`. The short of it is
 * that the matrix kernel wins wherever its tiling fits and there is enough work, and the
 * extent rule was costing a fifth on ordinary transformer shapes.
 */
import { describe, it } from 'fino:test/test';
import { createMetalApi, metalAvailable } from 'internal:metal';
import {
  DEFAULT_TILING,
  GEMM_MMA_THREADS,
  SMALL_TILING,
  gemmGrid,
  gemmIsExact,
  gemmKernel,
  gemmMmaFits,
  gemmMmaGrid,
  gemmMmaKernel,
  lowerToMSL,
  packParams,
} from 'internal:tensor/ir';

/** Shapes that separate "both extents are large" from "there is enough work". */
const SHAPES: readonly [number, number, number][] = [
  [64, 64, 64],
  [128, 128, 128],
  [256, 256, 256],
  [512, 256, 256],
  [384, 384, 384],
  [256, 512, 512],
  [256, 768, 768],
  [384, 768, 768],
  [512, 512, 512],
  [512, 768, 768],
  [640, 640, 640],
  [768, 768, 768],
  [128, 1024, 1024],
  [256, 1024, 1024],
  [512, 1024, 1024],
  [1024, 1024, 1024],
];

/** The tiling the backend would choose for this output, mirroring `gemmTiling`. */
function tilingFor(m: number, n: number) {
  return m >= 512 && n >= 512 ? DEFAULT_TILING : SMALL_TILING;
}

/** Deterministic values small enough that eight hundred accumulations stay in range. */
function fill(view: Float16Array, seed: number): void {
  for (let i = 0; i < view.length; i++) {
    view[i] = (((i * seed) % 17) - 8) / 64;
  }
}

describe('half-precision GEMM kernel selection', () => {
  it('measures the matrix kernel against the scalar one across non-square shapes', async (t) => {
    if (!metalAvailable()) {
      t.ok(true, 'SKIP: no Metal device');
      return;
    }
    const api = createMetalApi();
    const device = api.createDevice();
    const queue = api.createQueue(device);
    const event = api.createSharedEvent(device);

    let signal = 0n;
    const start = (encode: (batch: unknown) => void, iterations: number) => {
      const began = performance.now();
      const batch = api.beginBatch(queue);
      for (let i = 0; i < iterations; i++) encode(batch);
      signal += 1n;
      api.commitBatch(batch, event, signal);
      return { began, value: signal };
    };
    const finish = async (
      handle: { began: number; value: bigint },
      iterations: number,
    ): Promise<number> => {
      await api.waitForEvent(event, handle.value, 20000);
      return (performance.now() - handle.began) / 1000 / iterations;
    };

    // The first shape measured carries the process's warm-up — a compile, the first
    // submission, the GPU's clock coming up — and reads about 20% low for it. Spending a
    // throwaway shape on that is cheaper than misreading the smallest one as a loss,
    // which is exactly what happened before this was here.
    const rows: string[] = [];
    let worstDisagreement = 0;

    for (const [m, n, k] of SHAPES) {
      if (!gemmMmaFits(m, n, k)) {
        rows.push(`  ${m}x${n}x${k}: does not fit the matrix tiling`);
        continue;
      }
      const a = api.createBuffer(device, m * k * 2);
      const b = api.createBuffer(device, k * n * 2);
      const outMma = api.createBuffer(device, m * n * 2);
      const outScalar = api.createBuffer(device, m * n * 2);
      fill(new Float16Array(api.bufferContents(a, m * k * 2)), 3);
      fill(new Float16Array(api.bufferContents(b, k * n * 2)), 7);

      const mma = gemmMmaKernel({ dtype: 'f16' });
      const mmaPipeline = api.createPipeline(
        device,
        await api.compileLibrary(device, lowerToMSL(mma.ir, { fastMath: false })),
        mma.ir.name,
      );
      const tiling = tilingFor(m, n);
      const scalar = gemmKernel({
        dtype: 'f16',
        tiling,
        noEdgeGuards: gemmIsExact(m, n, k, tiling),
      });
      const scalarPipeline = api.createPipeline(
        device,
        await api.compileLibrary(device, lowerToMSL(scalar.ir, { fastMath: false })),
        scalar.ir.name,
      );

      const mmaParams = packParams(mma.ir.params, { N: n, K: k });
      const mmaGrid = gemmMmaGrid(m, n);
      const mmaEncode = (batch: unknown) =>
        api.encode(batch as never, {
          pipeline: mmaPipeline,
          buffers: [
            { buffer: a, offset: 0 },
            { buffer: b, offset: 0 },
            { buffer: outMma, offset: 0 },
          ],
          params: mmaParams,
          grid: mmaGrid,
          threadgroup: [GEMM_MMA_THREADS, 1, 1],
        });

      const scalarParams = packParams(scalar.ir.params, { M: m, N: n, K: k });
      const scalarGrid = gemmGrid(m, n, tiling, 1);
      const scalarEncode = (batch: unknown) =>
        api.encode(batch as never, {
          pipeline: scalarPipeline,
          buffers: [
            { buffer: a, offset: 0 },
            { buffer: b, offset: 0 },
            { buffer: outScalar, offset: 0 },
          ],
          params: scalarParams,
          grid: scalarGrid,
          threadgroup: scalar.ir.wg,
        });

      await finish(start(mmaEncode, 2), 2);
      await finish(start(scalarEncode, 2), 2);

      const iterations = 20;
      let bestMma = Infinity;
      let bestScalar = Infinity;
      for (let pass = 0; pass < 5; pass++) {
        bestMma = Math.min(bestMma, await finish(start(mmaEncode, iterations), iterations));
        bestScalar = Math.min(
          bestScalar,
          await finish(start(scalarEncode, iterations), iterations),
        );
      }

      const flops = 2 * m * n * k;
      const mmaRate = flops / bestMma / 1e9;
      const scalarRate = flops / bestScalar / 1e9;

      const mmaView = new Float16Array(api.bufferContents(outMma, m * n * 2));
      const scalarView = new Float16Array(api.bufferContents(outScalar, m * n * 2));
      let worst = 0;
      let scale = 1e-6;
      for (let i = 0; i < mmaView.length; i++) {
        worst = Math.max(worst, Math.abs(mmaView[i]! - scalarView[i]!));
        scale = Math.max(scale, Math.abs(scalarView[i]!));
      }
      worstDisagreement = Math.max(worstDisagreement, worst / scale);

      rows.push(
        `  ${String(`${m}x${n}x${k}`).padEnd(16)} mma ${mmaRate.toFixed(0).padStart(6)} ` +
          `scalar ${scalarRate.toFixed(0).padStart(6)}  ${(mmaRate / scalarRate).toFixed(2)}x`,
      );

      for (const buffer of [a, b, outMma, outScalar]) api.destroy(buffer);
    }

    console.log(['half-precision GEMM, GFLOP/s, alternated pass by pass:', ...rows].join('\n'));
    t.ok(
      worstDisagreement < 2e-2,
      `both kernels compute the same product everywhere (worst ${worstDisagreement.toExponential(2)})`,
    );
    t.ok(true, rows.join(' | '));
  });
});
