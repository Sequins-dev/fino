/**
 * BLAS behind the CPU backend's matrix multiply.
 *
 * A scalar TypeScript triple loop is the right *reference* — it is obvious, it
 * accumulates in f64, and it is what every kernel is checked against — but it is two
 * orders of magnitude off what the hardware can do, and matrix multiply is where
 * nearly all of a model's arithmetic lives. Every platform already ships a tuned
 * implementation; this loads whichever one is there rather than trying to compete
 * with it.
 *
 * Unavailability is not an error. When no library is found the caller keeps using the
 * reference loop, which is why this module reports rather than throws.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/cpu`; import from there.
 */
import { env } from 'internal:process';
import { dlopen } from 'fino:ffi';
import type { DynamicLibrary } from 'fino:ffi';

/**
 * Row-major vs column-major, from `cblas.h`.
 *
 * This engine is row-major everywhere, so only one value is ever passed — but naming
 * it is what makes the call sites readable.
 */
const CBLAS_ROW_MAJOR = 101;

/** No transpose / transpose, from `cblas.h`. */
const CBLAS_NO_TRANS = 111;
const CBLAS_TRANS = 112;

/**
 * Libraries to try, in order of preference.
 *
 * Accelerate first on macOS: it is always present and is tuned for the specific
 * chip, including the AMX-style matrix units that no portable build reaches. On Linux
 * the ordering prefers OpenBLAS, then BLIS, then a generic `libblas`, which is the
 * order of decreasing likelihood of being a tuned build rather than a reference one.
 */
const CANDIDATES: readonly string[] = [
  // macOS. The versioned path is the one that survives the framework being
  // reorganised, which it has been.
  '/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate',
  '/System/Library/Frameworks/Accelerate.framework/Accelerate',
  // Linux, by distribution convention.
  'libopenblas.so.0',
  'libopenblas.so',
  '/usr/lib/x86_64-linux-gnu/libopenblas.so.0',
  '/usr/lib/aarch64-linux-gnu/libopenblas.so.0',
  'libblis.so.4',
  'libblis.so',
  'libblas.so.3',
  'libblas.so',
];

/** The symbols this needs, and their signatures. */
const SYMBOLS = {
  cblas_sgemm: {
    parameters: [
      'i32', // order
      'i32', // transA
      'i32', // transB
      'i32', // m
      'i32', // n
      'i32', // k
      'f32', // alpha
      'buffer', // a
      'i32', // lda
      'buffer', // b
      'i32', // ldb
      'f32', // beta
      'buffer', // c
      'i32', // ldc
    ],
    result: 'void',
  },
  cblas_dgemm: {
    parameters: [
      'i32',
      'i32',
      'i32',
      'i32',
      'i32',
      'i32',
      'f64',
      'buffer',
      'i32',
      'buffer',
      'i32',
      'f64',
      'buffer',
      'i32',
    ],
    result: 'void',
  },
} as const;

/** One matrix multiply, in the shape `cblas_?gemm` takes. */
export interface BlasGemm {
  transA: boolean;
  transB: boolean;
  m: number;
  n: number;
  k: number;
  alpha: number;
  beta: number;
  /** Left operand, positioned at its first element. */
  a: Float32Array | Float64Array;
  lda: number;
  b: Float32Array | Float64Array;
  ldb: number;
  c: Float32Array | Float64Array;
  ldc: number;
}

/**
 * Resolution state, computed once.
 *
 * @internal
 */
let resolved:
  | { library: DynamicLibrary; path: string }
  | { error: string }
  | null = null;

/**
 * Find a BLAS, or record why there is none.
 *
 * @internal
 */
function load(): typeof resolved {
  if (resolved) return resolved;
  const override = env.FINO_BLAS_LIBRARY ?? null;
  const paths = override ? [override] : CANDIDATES;
  const failures: string[] = [];
  for (const path of paths) {
    try {
      const library = dlopen(path, SYMBOLS as never);
      // Opening can succeed for a library that lacks the CBLAS interface — the
      // Fortran-only builds do — so the symbol is what proves it usable.
      if (typeof library.symbols.cblas_sgemm !== 'function') {
        library.close();
        failures.push(`${path}: no cblas_sgemm`);
        continue;
      }
      resolved = { library, path };
      return resolved;
    } catch (cause) {
      failures.push(`${path}: ${(cause as Error).message}`);
    }
  }
  resolved = {
    error: override
      ? `FINO_BLAS_LIBRARY=${override} could not be loaded (${failures[0]})`
      : `no BLAS library found; tried ${paths.length} candidates`,
  };
  return resolved;
}

/** Whether a BLAS is available for `gemm`. */
export function blasAvailable(): boolean {
  const state = load();
  return state !== null && 'library' in state;
}

/** Which library was loaded, or null. */
export function blasPath(): string | null {
  const state = load();
  return state && 'library' in state ? state.path : null;
}

/** Why no BLAS is available, or null when one is. */
export function blasUnavailableReason(): string | null {
  const state = load();
  return state && 'error' in state ? state.error : null;
}

/**
 * Multiply through BLAS, returning whether it happened.
 *
 * False means the caller must fall back; it is not an error. The only dtypes here are
 * the two BLAS has — `f32` and `f64` — because a half-precision GEMM through a
 * widening copy would cost more than the reference loop it replaced.
 */
export function blasGemm(op: BlasGemm): boolean {
  const state = load();
  if (!state || !('library' in state)) return false;
  const double = op.c instanceof Float64Array;
  const fn = double ? state.library.symbols.cblas_dgemm : state.library.symbols.cblas_sgemm;
  if (typeof fn !== 'function') return false;
  (fn as (...args: unknown[]) => void)(
    CBLAS_ROW_MAJOR,
    op.transA ? CBLAS_TRANS : CBLAS_NO_TRANS,
    op.transB ? CBLAS_TRANS : CBLAS_NO_TRANS,
    op.m,
    op.n,
    op.k,
    op.alpha,
    op.a,
    op.lda,
    op.b,
    op.ldb,
    op.beta,
    op.c,
    op.ldc,
  );
  return true;
}
