/**
 * Does `simdgroup_matrix` actually beat the scalar GEMM on this hardware? (FIN-159)
 *
 * The tiled kernel this engine ships is a scalar register-blocked loop, and it has been
 * tuned about as far as that shape goes. The remaining gap to ggml is the shape itself:
 * ggml uses Metal's simdgroup matrix instructions, which change how operands reach the
 * ALUs rather than how many instructions issue.
 *
 * Adopting them is not a tweak — the kernel IR is dialect-neutral and lowers to both MSL
 * and SPIR-V, and there is no cooperative-matrix path that MoltenVK and lavapipe both
 * support, so it would need an IR concept behind a capability gate with the scalar
 * kernel kept as the fallback. That is a lot of machinery to build on an assumption, so
 * this measures the assumption first, against hand-written MSL that never enters the IR.
 *
 * It checks the two kernels agree and reports both rates. It deliberately asserts
 * nothing about which is faster: the answer is the point, and a threshold here would
 * turn a measurement into a flaky test on someone else's GPU.
 *
 * ## The answer, on an M5 Max
 *
 * MMA 890 GFLOP/s against the scalar kernel's 7528 — eight and a half times *slower*,
 * from a kernel verified to compute the same product.
 *
 * The first version of this spike used one simdgroup per threadgroup and measured 908.
 * Widening it to four simdgroups and a four-times-larger tile changed nothing, which is
 * the informative part: if occupancy or staging were the limit, quadrupling both would
 * have moved the number. It did not, so the limit is the instruction path itself.
 *
 * The reading is that `simdgroup_matrix` at `float` is not the lever on this hardware —
 * Apple's matrix units are aimed at 16-bit operands, and an f32 simdgroup multiply
 * appears to cost more than the scalar FMAs it replaces. Whatever ggml gains at f32, it
 * is not this. The next question is whether f16 operands with f32 accumulation change
 * the picture, which is where autocast would meet it; that has not been measured.
 */
import { describe, it } from 'fino:test/test';
import { createMetalApi, metalAvailable } from 'internal:metal';
import { DEFAULT_TILING, gemmGrid, gemmKernel, lowerToMSL, packParams } from 'internal:tensor/ir';

/**
 * A GEMM built from 8x8 simdgroup matrices.
 *
 * Four simdgroups per threadgroup in a 2x2 arrangement, computing a 64x64 tile of C,
 * walking K eight at a time. Not a tuned kernel — it has no double buffering and no
 * vectorised staging — but parallel enough that the comparison is about the
 * instructions rather than about occupancy. An earlier version of this spike used one
 * simdgroup per threadgroup and measured eight times slower than the scalar kernel,
 * which said nothing about MMA and everything about launching 32 threads at a time.
 */
const MMA_SOURCE = `
#include <metal_stdlib>
#include <metal_simdgroup_matrix>
using namespace metal;

// 128 threads = four simdgroups in a 2x2 arrangement, computing a 64x64 tile of C.
// Each simdgroup owns a 32x32 quadrant as sixteen 8x8 accumulators, and all 128 threads
// cooperate on staging, so the tile is four times the area of a one-simdgroup version
// with the same accumulator count per simdgroup.
kernel void mma_gemm(
    device const float* A [[buffer(0)]],
    device const float* B [[buffer(1)]],
    device float* C [[buffer(2)]],
    constant uint* dims [[buffer(3)]],
    uint3 tg [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_threadgroup]],
    uint sg [[simdgroup_index_in_threadgroup]])
{
  const uint N = dims[1];
  const uint K = dims[2];

  threadgroup float As[64 * 8];
  threadgroup float Bs[8 * 64];

  simdgroup_float8x8 acc[4][4];
  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 4; j++)
      acc[i][j] = make_filled_simdgroup_matrix<float, 8, 8>(0.0f);

  const uint row0 = tg.y * 64;
  const uint col0 = tg.x * 64;
  const uint sgRow = sg / 2;
  const uint sgCol = sg % 2;

  for (uint k0 = 0; k0 < K; k0 += 8) {
    for (uint idx = lane; idx < 64 * 8; idx += 128) {
      uint r = idx / 8;
      uint c = idx % 8;
      As[idx] = A[(row0 + r) * K + (k0 + c)];
    }
    for (uint idx = lane; idx < 8 * 64; idx += 128) {
      uint r = idx / 64;
      uint c = idx % 64;
      Bs[idx] = B[(k0 + r) * N + (col0 + c)];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    simdgroup_float8x8 a[4];
    simdgroup_float8x8 b[4];
    for (int i = 0; i < 4; i++) simdgroup_load(a[i], As + (sgRow * 32 + i * 8) * 8, 8);
    for (int j = 0; j < 4; j++) simdgroup_load(b[j], Bs + sgCol * 32 + j * 8, 64);
    for (int i = 0; i < 4; i++)
      for (int j = 0; j < 4; j++)
        simdgroup_multiply_accumulate(acc[i][j], a[i], b[j], acc[i][j]);

    threadgroup_barrier(mem_flags::mem_threadgroup);
  }

  for (int i = 0; i < 4; i++)
    for (int j = 0; j < 4; j++)
      simdgroup_store(
        acc[i][j],
        C + (row0 + sgRow * 32 + i * 8) * N + col0 + sgCol * 32 + j * 8,
        N);
}
`;

/** Deterministic operands, small enough that f32 sums stay comparable. */
function fill(view: Float32Array, seed: number): void {
  for (let i = 0; i < view.length; i++) {
    view[i] = (((i * seed) % 17) - 8) / 32;
  }
}

describe('simdgroup matrix spike', () => {
  it('measures MMA against the scalar kernel at 1024', async (t) => {
    if (!metalAvailable()) {
      t.ok(true, 'SKIP: no Metal device');
      return;
    }
    const api = createMetalApi();
    const device = api.createDevice();
    const queue = api.createQueue(device);
    const event = api.createSharedEvent(device);

    const n = 1024;
    const bytes = n * n * 4;
    const a = api.createBuffer(device, bytes);
    const b = api.createBuffer(device, bytes);
    const outMma = api.createBuffer(device, bytes);
    const outScalar = api.createBuffer(device, bytes);
    fill(new Float32Array(api.bufferContents(a, bytes)), 3);
    fill(new Float32Array(api.bufferContents(b, bytes)), 7);

    const mmaLibrary = await api.compileLibrary(device, MMA_SOURCE);
    const mmaPipeline = api.createPipeline(device, mmaLibrary, 'mma_gemm');

    const { ir } = gemmKernel({
      dtype: 'f32',
      tiling: DEFAULT_TILING,
      noEdgeGuards: true,
    });
    const scalarLibrary = await api.compileLibrary(device, lowerToMSL(ir, { fastMath: false }));
    const scalarPipeline = api.createPipeline(device, scalarLibrary, ir.name);

    let signal = 0n;
    /** Run `iterations` dispatches and return seconds per dispatch. */
    const time = (encode: (batch: unknown) => void, iterations: number): number => {
      const start = performance.now();
      const batch = api.beginBatch(queue);
      for (let i = 0; i < iterations; i++) encode(batch);
      signal += 1n;
      api.commitBatch(batch, event, signal);
      return { start, value: signal } as never;
    };
    const finish = async (handle: never, iterations: number): Promise<number> => {
      const { start, value } = handle as unknown as { start: number; value: bigint };
      await api.waitForEvent(event, value, 20000);
      return (performance.now() - start) / 1000 / iterations;
    };

    const dims = new Uint32Array([n, n, n]);
    const mmaEncode = (batch: unknown) =>
      api.encode(batch as never, {
        pipeline: mmaPipeline,
        buffers: [
          { buffer: a, offset: 0 },
          { buffer: b, offset: 0 },
          { buffer: outMma, offset: 0 },
        ],
        params: new Uint8Array(dims.buffer),
        grid: [n / 64, n / 64, 1],
        threadgroup: [128, 1, 1],
      });
    const scalarParams = packParams(ir.params, { M: n, N: n, K: n });
    const scalarGrid = gemmGrid(n, n, DEFAULT_TILING, 1);
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
        threadgroup: ir.wg,
      });

    // Warm both, then alternate: measuring one after the other lets the clock drift
    // between them, which has reversed a result in this repository before.
    await finish(time(mmaEncode, 1) as never, 1);
    await finish(time(scalarEncode, 1) as never, 1);

    const iterations = 20;
    let bestMma = Infinity;
    let bestScalar = Infinity;
    for (let pass = 0; pass < 5; pass++) {
      bestMma = Math.min(bestMma, await finish(time(mmaEncode, iterations) as never, iterations));
      bestScalar = Math.min(
        bestScalar,
        await finish(time(scalarEncode, iterations) as never, iterations),
      );
    }

    const flops = 2 * n ** 3;
    const rate = (seconds: number) => flops / seconds / 1e9;
    const mmaRate = rate(bestMma);
    const scalarRate = rate(bestScalar);

    // Same product from the same operands, so a timing difference is about speed.
    const mmaView = new Float32Array(api.bufferContents(outMma, bytes));
    const scalarView = new Float32Array(api.bufferContents(outScalar, bytes));
    let worst = 0;
    let scale = 1;
    for (let i = 0; i < mmaView.length; i++) {
      worst = Math.max(worst, Math.abs(mmaView[i]! - scalarView[i]!));
      scale = Math.max(scale, Math.abs(scalarView[i]!));
    }
    t.ok(worst / scale < 1e-4, `both kernels compute the same product (worst ${worst})`);
    t.ok(
      true,
      `MMA ${mmaRate.toFixed(0)} GFLOP/s vs scalar ${scalarRate.toFixed(0)} GFLOP/s ` +
        `(${(mmaRate / scalarRate).toFixed(2)}x)`,
    );

    for (const buffer of [a, b, outMma, outScalar]) api.destroy(buffer);
  });
});
