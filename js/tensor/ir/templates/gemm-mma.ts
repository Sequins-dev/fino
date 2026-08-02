/**
 * A matrix multiply built from cooperative matrices, for devices that have them.
 *
 * The scalar tiled GEMM stages tiles into shared memory and issues `tm*tn` fused
 * multiply-adds per thread. This does the same staging and then hands 8x8 blocks to the
 * hardware's matrix units instead. It exists because measurement said it was worth
 * having and only in half precision: on an M5 Max, f32 matrix instructions run at an
 * eighth of the scalar kernel's rate while f16 ones run at 1.3x it. `tests/tensor/
 * mma-spike.test.ts` holds the numbers and the hand-written MSL this was ported from.
 *
 * Not a replacement for {@link gemmKernel}. It requires `caps.matrix`, which SPIR-V
 * refuses to lower, so Vulkan and anything else without the capability keeps the scalar
 * kernel — and so does f32 everywhere, because there the scalar kernel is faster.
 *
 * ## Shape
 *
 * 128 threads, four subgroups in a 2x2 arrangement, computing a 64x64 tile of C. Each
 * subgroup owns a 32x32 quadrant as sixteen 8x8 accumulators. K is walked 32 at a time:
 * staging costs two barriers whatever it stages, so a wider step amortises them over
 * four times the arithmetic, and moving from 8 to 32 was most of the difference between
 * losing to the scalar kernel and beating it.
 *
 * Accumulation is in f32 regardless of operand type, which the contract requires and
 * which is also what the hardware wants.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import type { KernelIR, ScalarDType } from '../types.ts';
import { vt } from '../types.ts';
import { E, KernelBuilder, unroll, unroll2 } from '../builder.ts';

/** Rows and columns of C one workgroup computes. */
const TILE = 64;

/** Elements of K staged per pass. */
const STEP = 32;

/** Threads per workgroup: four subgroups of 32. */
const THREADS = 128;

/** Side of one cooperative matrix. */
const FRAGMENT = 8;

/** Accumulators per subgroup, per axis: a 32x32 quadrant in 8x8 blocks. */
const BLOCKS = 4;

/** What a matrix-unit GEMM needs to know. */
export interface GemmMmaSpec {
  /** Storage type of A, B, and C. Only `f16` is worth building; see the module note. */
  dtype: Extract<ScalarDType, 'f16' | 'f32'>;
}

/**
 * Whether a problem size suits the matrix path.
 *
 * Every extent has to divide the tile, because this kernel has no edge handling — the
 * scalar kernel covers ragged shapes, and duplicating its guards here would give back
 * the margin that justifies the kernel.
 */
export function gemmMmaFits(m: number, n: number, k: number): boolean {
  return m % TILE === 0 && n % TILE === 0 && k % STEP === 0;
}

/** Workgroups needed for an `m` by `n` output. */
export function gemmMmaGrid(m: number, n: number): [number, number, number] {
  return [n / TILE, m / TILE, 1];
}

/** Threads per workgroup this kernel launches. */
export const GEMM_MMA_THREADS = THREADS;

/**
 * Build a cooperative-matrix GEMM computing `C = A @ B`.
 */
export function gemmMmaKernel(spec: GemmMmaSpec): { ir: KernelIR; key: string } {
  const dtype = spec.dtype;
  const name = `gemm_mma_${dtype}_${TILE}x${TILE}x${STEP}`;

  const b = new KernelBuilder(name, [THREADS, 1, 1]);
  b.buffer('matA', vt(dtype), 'read');
  b.buffer('matB', vt(dtype), 'read');
  b.buffer('matC', vt(dtype), 'write');

  const N = b.param('N');
  const K = b.param('K');

  const As = b.shared('tileA', dtype, TILE * STEP);
  const Bs = b.shared('tileB', dtype, STEP * TILE);
  // The accumulators come back through shared memory because a float matrix cannot be
  // narrowed to a half one in registers. The whole workgroup converts on the way out,
  // which a half-precision kernel has to do however it is written.
  const Cs = b.shared('tileC', 'f32', TILE * TILE);

  const lane = b.let('lane', vt('u32'), E.builtin('localId', 0));
  const sg = b.let('sg', vt('u32'), E.builtin('subgroupId', 0));
  const sgRow = b.let('sgRow', vt('u32'), E.div(sg, E.u32(2)));
  const sgCol = b.let('sgCol', vt('u32'), E.mod(sg, E.u32(2)));
  const row0 = b.let('row0', vt('u32'), E.mul(E.builtin('groupId', 1), E.u32(TILE)));
  const col0 = b.let('col0', vt('u32'), E.mul(E.builtin('groupId', 0), E.u32(TILE)));

  const accName = (i: number, j: number) => `acc${i}_${j}`;
  unroll2(BLOCKS, BLOCKS, (i, j) => {
    b.matDecl(accName(i, j), 'f32');
    b.matFill(accName(i, j), 0);
  });
  unroll(BLOCKS, (i) => b.matDecl(`fragA${i}`, dtype));
  unroll(BLOCKS, (j) => b.matDecl(`fragB${j}`, dtype));

  b.for('k0', E.u32(0), K, E.u32(STEP), (k0) => {
    // Each thread stages a fixed share, so the loop count is static.
    b.comment('stage A');
    unroll((TILE * STEP) / THREADS, (step) => {
      const idx = b.letTemp(vt('u32'), E.add(lane, E.u32(step * THREADS)), 'ai');
      const r = b.letTemp(vt('u32'), E.div(idx, E.u32(STEP)), 'ar');
      const c = b.letTemp(vt('u32'), E.mod(idx, E.u32(STEP)), 'ac');
      const source = E.add(E.mul(E.add(row0, r), K), E.add(k0, c));
      b.shstore(As, idx, E.load('matA', source));
    });

    b.comment('stage B');
    unroll((STEP * TILE) / THREADS, (step) => {
      const idx = b.letTemp(vt('u32'), E.add(lane, E.u32(step * THREADS)), 'bi');
      const r = b.letTemp(vt('u32'), E.div(idx, E.u32(TILE)), 'br');
      const c = b.letTemp(vt('u32'), E.mod(idx, E.u32(TILE)), 'bc');
      const source = E.add(E.mul(E.add(k0, r), N), E.add(col0, c));
      b.shstore(Bs, idx, E.load('matB', source));
    });

    b.barrier();

    b.comment('multiply staged tiles');
    unroll(STEP / FRAGMENT, (block) => {
      const kk = block * FRAGMENT;
      unroll(BLOCKS, (i) =>
        b.matLoad(
          `fragA${i}`,
          As,
          E.add(E.mul(E.add(E.mul(sgRow, E.u32(32)), E.u32(i * FRAGMENT)), E.u32(STEP)), E.u32(kk)),
          E.u32(STEP),
        ),
      );
      unroll(BLOCKS, (j) =>
        b.matLoad(
          `fragB${j}`,
          Bs,
          E.add(
            E.u32(kk * TILE),
            E.add(E.mul(sgCol, E.u32(32)), E.u32(j * FRAGMENT)),
          ),
          E.u32(TILE),
        ),
      );
      unroll2(BLOCKS, BLOCKS, (i, j) => b.matMulAdd(accName(i, j), `fragA${i}`, `fragB${j}`));
    });

    b.barrier();
  });

  b.comment('narrow the accumulators through shared memory');
  unroll2(BLOCKS, BLOCKS, (i, j) => {
    b.matStore(
      accName(i, j),
      Cs,
      E.add(
        E.mul(E.add(E.mul(sgRow, E.u32(32)), E.u32(i * FRAGMENT)), E.u32(TILE)),
        E.add(E.mul(sgCol, E.u32(32)), E.u32(j * FRAGMENT)),
      ),
      E.u32(TILE),
    );
  });
  b.barrier();

  unroll((TILE * TILE) / THREADS, (step) => {
    const idx = b.letTemp(vt('u32'), E.add(lane, E.u32(step * THREADS)), 'ci');
    const r = b.letTemp(vt('u32'), E.div(idx, E.u32(TILE)), 'cr');
    const c = b.letTemp(vt('u32'), E.mod(idx, E.u32(TILE)), 'cc');
    const target = E.add(E.mul(E.add(row0, r), N), E.add(col0, c));
    b.store('matC', target, E.cast(vt(dtype), E.shload(Cs, idx)));
  });

  return { ir: b.build(), key: name };
}
