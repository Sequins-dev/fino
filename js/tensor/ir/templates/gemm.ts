/**
 * Tiled GEMM kernel template.
 *
 * The hardest kernel in the engine, and the one that proves the IR is genuinely
 * dialect-neutral: it needs workgroup-shared memory, barriers, a real loop nest,
 * and mutable register accumulators all at once. An elementwise kernel exercises
 * none of that, so this template is the honesty test for the two-dialect design.
 *
 * Structure: each workgroup computes a `BM x BN` tile of C. The K dimension is
 * walked in `BK`-wide steps; each step cooperatively stages `A` and `B` tiles
 * into shared memory, then every thread accumulates a `TM x TN` block of C in
 * registers. Register blocking comes from unrolling in TypeScript, not from IR
 * arrays.
 *
 * Not here, deliberately: cooperative-matrix and simdgroup-matrix paths. Those
 * need an opaque matrix type in the IR and belong behind a capability flag once
 * the scalar path is correct and measured.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import { E, KernelBuilder, unroll, unroll2 } from '../builder.ts';
import { specKey } from '../key.ts';
import type { Expr, KernelIR, ScalarDType } from '../types.ts';
import { vt } from '../types.ts';

/** Tile geometry. Every field changes emitted code, so all are in the key. */
export interface GemmTiling {
  /** Rows of C per workgroup. */
  bm: number;
  /** Columns of C per workgroup. */
  bn: number;
  /** K-step width staged into shared memory. */
  bk: number;
  /** Rows of C per thread. */
  tm: number;
  /** Columns of C per thread. */
  tn: number;
}

/** The default tiling: 64x64 tiles, 8x8 threads, 4x4 register blocks. */
export const DEFAULT_TILING: GemmTiling = { bm: 64, bn: 64, bk: 16, tm: 4, tn: 4 };

/** A conservative tiling for small problems and software rasterizers. */
export const SMALL_TILING: GemmTiling = { bm: 32, bn: 32, bk: 16, tm: 2, tn: 2 };

/** Specialization of {@link gemmKernel}. */
export interface GemmSpec {
  /** Storage type of A, B, and C. */
  dtype: ScalarDType;
  /** Accumulator type; `f32` even for 16-bit storage, per the contract. */
  accumulate?: ScalarDType;
  /** Whether A is transposed (K-major). */
  transA?: boolean;
  /** Whether B is transposed (N-major). */
  transB?: boolean;
  /** Tile geometry. */
  tiling?: GemmTiling;
  /**
   * Omit bounds checks.
   *
   * Only sound when M, N, and K are exact multiples of the tile sizes. The
   * caller decides from the actual shapes, and the choice is in the cache key
   * because it changes the emitted code.
   */
  noEdgeGuards?: boolean;
  /** Include a `beta * C` term, for accumulating into an existing C. */
  withBeta?: boolean;
}

/**
 * Build a tiled GEMM kernel computing `C = A @ B` (optionally `+ beta * C`).
 *
 * Buffers are `a`, `b`, `c`; parameters are `M`, `N`, `K` plus `beta` when
 * requested. A and B are indexed with explicit leading dimensions so a
 * transposed operand needs no separate copy.
 */
export function gemmKernel(spec: GemmSpec): { ir: KernelIR; key: string } {
  const t = spec.tiling ?? DEFAULT_TILING;
  const dtype = spec.dtype;
  const acc = spec.accumulate ?? (dtype === 'f16' || dtype === 'bf16' ? 'f32' : dtype);
  const accT = vt(acc);
  const guards = !spec.noEdgeGuards;

  const threadsX = t.bn / t.tn;
  const threadsY = t.bm / t.tm;
  if (!Number.isInteger(threadsX) || !Number.isInteger(threadsY)) {
    throw new Error(`tiling ${t.bm}x${t.bn} does not divide into ${t.tm}x${t.tn} blocks`);
  }
  const threads = threadsX * threadsY;

  const name = [
    'gemm',
    dtype,
    spec.transA ? 'tA' : 'nA',
    spec.transB ? 'tB' : 'nB',
    `${t.bm}x${t.bn}x${t.bk}`,
    `${t.tm}x${t.tn}`,
    guards ? 'guard' : 'exact',
    spec.withBeta ? 'beta' : 'plain',
  ].join('_');

  const b = new KernelBuilder(name, [threadsX, threadsY, 1]);
  b.buffer('matA', vt(dtype), 'read');
  b.buffer('matB', vt(dtype), 'read');
  b.buffer('matC', vt(dtype), spec.withBeta ? 'readwrite' : 'write');

  const M = b.param('M');
  const N = b.param('N');
  const K = b.param('K');
  const beta = spec.withBeta ? b.param('beta', 'f32') : null;

  const tileA = b.shared('tileA', acc, t.bm * t.bk);
  const tileB = b.shared('tileB', acc, t.bk * t.bn);

  const lx = E.builtin('localId', 0);
  const ly = E.builtin('localId', 1);
  const gx = E.builtin('groupId', 0);
  const gy = E.builtin('groupId', 1);

  // Origin of this thread's register block within C.
  const row0 = b.let('row0', vt('u32'), E.add(E.mul(gy, E.u32(t.bm)), E.mul(ly, E.u32(t.tm))));
  const col0 = b.let('col0', vt('u32'), E.add(E.mul(gx, E.u32(t.bn)), E.mul(lx, E.u32(t.tn))));
  // Flat thread index, for cooperative staging.
  const tid = b.let('tid', vt('u32'), E.add(E.mul(ly, E.u32(threadsX)), lx));

  b.comment(`accumulators: ${t.tm}x${t.tn} per thread`);
  unroll2(t.tm, t.tn, (i, j) => {
    b.var(`acc${i}_${j}`, accT, E.const(accT, 0));
  });

  const zero = E.const(accT, 0);

  // Number of K tiles, rounded up so a partial tail tile is still staged.
  const kTiles = b.let(
    'kTiles',
    vt('u32'),
    E.div(E.add(K, E.u32(t.bk - 1)), E.u32(t.bk)),
  );

  b.for('kt', E.u32(0), kTiles, E.u32(1), (kt) => {
    const kBase = b.let('kBase', vt('u32'), E.mul(kt, E.u32(t.bk)));

    // -- stage A into shared memory ------------------------------------
    // Each thread loads a strided share of the tile so the loop count is
    // static regardless of workgroup size.
    b.comment('stage A tile');
    const aElems = t.bm * t.bk;
    unroll(Math.ceil(aElems / threads), (step) => {
      const flat = b.letTemp(vt('u32'), E.add(tid, E.u32(step * threads)), 'ai');
      const guardBody = () => {
        const r = b.letTemp(vt('u32'), E.div(flat, E.u32(t.bk)), 'ar');
        const kk = b.letTemp(vt('u32'), E.mod(flat, E.u32(t.bk)), 'ak');
        const globalRow = b.letTemp(
          vt('u32'),
          E.add(E.mul(gy, E.u32(t.bm)), r),
          'agr',
        );
        const globalK = b.letTemp(vt('u32'), E.add(kBase, kk), 'agk');
        // A is [M,K] normally, [K,M] transposed.
        const index = spec.transA
          ? E.add(E.mul(globalK, M), globalRow)
          : E.add(E.mul(globalRow, K), globalK);
        const inBounds = E.bin('logicalAnd', E.lt(globalRow, M), E.lt(globalK, K));
        const value = guards
          ? E.select(inBounds, E.cast(accT, E.load('matA', index)), zero)
          : E.cast(accT, E.load('matA', index));
        b.shstore(tileA, flat, value);
      };
      // The final partial step needs a guard even when shapes are exact.
      if (aElems % threads !== 0 && step === Math.ceil(aElems / threads) - 1) {
        b.if(E.lt(flat, E.u32(aElems)), guardBody);
      } else {
        guardBody();
      }
    });

    // -- stage B into shared memory ------------------------------------
    b.comment('stage B tile');
    const bElems = t.bk * t.bn;
    unroll(Math.ceil(bElems / threads), (step) => {
      const flat = b.letTemp(vt('u32'), E.add(tid, E.u32(step * threads)), 'bi');
      const guardBody = () => {
        const kk = b.letTemp(vt('u32'), E.div(flat, E.u32(t.bn)), 'bk');
        const c = b.letTemp(vt('u32'), E.mod(flat, E.u32(t.bn)), 'bc');
        const globalK = b.letTemp(vt('u32'), E.add(kBase, kk), 'bgk');
        const globalCol = b.letTemp(
          vt('u32'),
          E.add(E.mul(gx, E.u32(t.bn)), c),
          'bgc',
        );
        // B is [K,N] normally, [N,K] transposed.
        const index = spec.transB
          ? E.add(E.mul(globalCol, K), globalK)
          : E.add(E.mul(globalK, N), globalCol);
        const inBounds = E.bin('logicalAnd', E.lt(globalK, K), E.lt(globalCol, N));
        const value = guards
          ? E.select(inBounds, E.cast(accT, E.load('matB', index)), zero)
          : E.cast(accT, E.load('matB', index));
        b.shstore(tileB, flat, value);
      };
      if (bElems % threads !== 0 && step === Math.ceil(bElems / threads) - 1) {
        b.if(E.lt(flat, E.u32(bElems)), guardBody);
      } else {
        guardBody();
      }
    });

    b.barrier();

    // -- accumulate ----------------------------------------------------
    b.comment('multiply staged tiles');
    b.for('kk', E.u32(0), E.u32(t.bk), E.u32(1), (kk) => {
      // Hoist each operand once, then reuse across the register block: this is
      // what makes the inner loop arithmetic-bound rather than load-bound.
      const aVals: Expr[] = [];
      unroll(t.tm, (i) => {
        aVals.push(
          b.letTemp(
            accT,
            E.shload(
              tileA,
              E.add(E.mul(E.add(E.mul(ly, E.u32(t.tm)), E.u32(i)), E.u32(t.bk)), kk),
            ),
            'a',
          ),
        );
      });
      const bVals: Expr[] = [];
      unroll(t.tn, (j) => {
        bVals.push(
          b.letTemp(
            accT,
            E.shload(
              tileB,
              E.add(E.mul(kk, E.u32(t.bn)), E.add(E.mul(lx, E.u32(t.tn)), E.u32(j))),
            ),
            'b',
          ),
        );
      });
      unroll2(t.tm, t.tn, (i, j) => {
        b.assign(
          `acc${i}_${j}`,
          E.call('fma', aVals[i]!, bVals[j]!, E.var(`acc${i}_${j}`)),
        );
      });
    });

    // Barrier before the next iteration overwrites the staged tiles.
    b.barrier();
  });

  // -- write C -------------------------------------------------------------
  b.comment('write C');
  unroll2(t.tm, t.tn, (i, j) => {
    const r = b.letTemp(vt('u32'), E.add(row0, E.u32(i)), 'cr');
    const c = b.letTemp(vt('u32'), E.add(col0, E.u32(j)), 'cc');
    const index = E.add(E.mul(r, N), c);
    const write = () => {
      let value: Expr = E.var(`acc${i}_${j}`);
      if (beta) {
        value = E.add(value, E.mul(E.cast(accT, E.load('matC', index)), beta));
      }
      b.store('matC', index, E.cast(vt(dtype), value));
    };
    if (guards) {
      b.if(E.bin('logicalAnd', E.lt(r, M), E.lt(c, N)), write);
    } else {
      write();
    }
  });

  const key = specKey('gemm', {
    dtype,
    acc,
    transA: spec.transA ?? false,
    transB: spec.transB ?? false,
    tile: `${t.bm}x${t.bn}x${t.bk}`,
    reg: `${t.tm}x${t.tn}`,
    guards,
    beta: spec.withBeta ?? false,
  });

  return { ir: b.build(), key };
}

/**
 * Grid dimensions for a GEMM launch, in workgroups.
 */
export function gemmGrid(
  m: number,
  n: number,
  tiling: GemmTiling = DEFAULT_TILING,
): [number, number, number] {
  return [Math.ceil(n / tiling.bn), Math.ceil(m / tiling.bm), 1];
}

/**
 * Whether a problem size lets the edge guards be dropped.
 */
export function gemmIsExact(
  m: number,
  n: number,
  k: number,
  tiling: GemmTiling = DEFAULT_TILING,
): boolean {
  return m % tiling.bm === 0 && n % tiling.bn === 0 && k % tiling.bk === 0;
}
