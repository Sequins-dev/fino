/**
 * Differential and gradient-check harness.
 *
 * Two independent checks, deliberately separated. `gradCheck` compares
 * `backward()` against central finite differences computed on the reference
 * backend in f64, which validates the *tape* without trusting any kernel.
 * `differential` compares a backend's operations against the reference
 * implementation, which validates *kernels* without re-deriving their gradients.
 * Keeping them apart is what lets a failure name its own cause.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from './dtype.ts';
import { isFloat } from './dtype.ts';
import type { Device } from './backend.ts';
import { noGrad } from './autograd.ts';
import { Tensor } from './tensor.ts';
import { readTensor } from './readback.ts';

/** Accuracy bounds per dtype, from `docs/tensor-contract.md` §7. */
export const TOLERANCE: Readonly<Record<DType, { rtol: number; atol: number }>> = {
  f64: { rtol: 1e-12, atol: 1e-15 },
  f32: { rtol: 1e-5, atol: 1e-7 },
  f16: { rtol: 1e-2, atol: 1e-4 },
  bf16: { rtol: 8e-2, atol: 1e-3 },
  i64: { rtol: 0, atol: 0 },
  i32: { rtol: 0, atol: 0 },
  u8: { rtol: 0, atol: 0 },
  bool: { rtol: 0, atol: 0 },
};

/** One mismatch found by a comparison. */
export interface Mismatch {
  index: number;
  got: number;
  want: number;
  /** Absolute difference. */
  delta: number;
}

/** Result of comparing two value sequences. */
export interface Comparison {
  ok: boolean;
  /** Worst mismatch, or `null` when everything agreed. */
  worst: Mismatch | null;
  /** Number of positions that differed beyond tolerance. */
  failures: number;
  /** Largest absolute difference seen, even within tolerance. */
  maxDelta: number;
}

/**
 * Compare values against expectations at a dtype's tolerance.
 *
 * `reductionLength` scales the absolute tolerance by its square root, because
 * error accumulates over a reduction and a fixed bound would either fail long
 * reductions or wave through short ones.
 */
export function compareValues(
  got: ArrayLike<number>,
  want: ArrayLike<number>,
  dtype: DType,
  reductionLength = 1,
): Comparison {
  if (got.length !== want.length) {
    throw new Error(`length mismatch: got ${got.length}, want ${want.length}`);
  }
  const { rtol, atol } = TOLERANCE[dtype];
  const scaled = atol * Math.sqrt(Math.max(reductionLength, 1));
  let worst: Mismatch | null = null;
  let failures = 0;
  let maxDelta = 0;
  for (let i = 0; i < got.length; i++) {
    const a = got[i]!;
    const b = want[i]!;
    // NaN and infinities must match exactly; the contract forbids relaxing them.
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (Number.isNaN(a) !== Number.isNaN(b)) {
        failures++;
        worst ??= { index: i, got: a, want: b, delta: Infinity };
      }
      continue;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      if (a !== b) {
        failures++;
        worst ??= { index: i, got: a, want: b, delta: Infinity };
      }
      continue;
    }
    const delta = Math.abs(a - b);
    if (delta > maxDelta) maxDelta = delta;
    const allowed = scaled + rtol * Math.abs(b);
    if (delta > allowed) {
      failures++;
      if (!worst || delta > worst.delta) worst = { index: i, got: a, want: b, delta };
    }
  }
  return { ok: failures === 0, worst, failures, maxDelta };
}

/** Render a comparison for a test message. */
export function describeComparison(result: Comparison, label: string): string {
  if (result.ok) return `${label}: ${result.failures === 0 ? 'matches' : ''}`;
  const worst = result.worst!;
  return `${label}: ${result.failures} value(s) outside tolerance; worst at index ${worst.index}: got ${worst.got}, want ${worst.want} (delta ${worst.delta})`;
}

/** A function of one or more tensors, for {@link gradCheck}. */
export type ScalarFn = (...inputs: Tensor[]) => Tensor;

/** How {@link gradCheck} behaves. */
export interface GradCheckOptions {
  /**
   * Finite-difference step.
   *
   * The default balances truncation error, which grows with the step, against
   * cancellation error, which grows as it shrinks. Central differences make the
   * truncation term second order, which is why this can be as large as it is.
   */
  eps?: number;
  /** Relative tolerance for the comparison. */
  rtol?: number;
  /** Absolute tolerance for the comparison. */
  atol?: number;
}

/** One input's gradient check. */
export interface GradCheckResult {
  ok: boolean;
  /** Index of the input this covers. */
  input: number;
  /** Gradient `backward()` produced. */
  analytic: number[];
  /** Gradient central differences produced. */
  numeric: number[];
  worst: Mismatch | null;
}

/**
 * Compare `backward()` against central finite differences.
 *
 * Runs entirely on whichever device the inputs live on, but is only meaningful in
 * `f64`: in `f32` the difference quotient's cancellation error swamps the
 * gradient. That is the reason `f64` is in the dtype vocabulary at all.
 */
export async function gradCheck(
  fn: ScalarFn,
  inputs: readonly Tensor[],
  options: GradCheckOptions = {},
): Promise<GradCheckResult[]> {
  const eps = options.eps ?? 1e-6;
  const rtol = options.rtol ?? 1e-6;
  const atol = options.atol ?? 1e-8;

  for (const input of inputs) {
    if (input.dtype !== 'f64') {
      throw new Error(
        `gradCheck needs f64 inputs to be meaningful; got ${input.dtype}. ` +
          'Cancellation error in a difference quotient exceeds the gradient in f32.',
      );
    }
  }

  // Analytic gradients.
  for (const input of inputs) {
    input.requiresGrad = true;
    input.grad = null;
  }
  const output = fn(...(inputs as Tensor[]));
  if (output.size !== 1) {
    throw new Error('gradCheck needs a scalar-valued function');
  }
  output.backward();
  const analytic: number[][] = [];
  for (const input of inputs) {
    if (!input.grad) {
      throw new Error('gradCheck: backward() produced no gradient for an input');
    }
    analytic.push([...(await readTensor(input.grad))].map(Number));
  }

  // Numeric gradients, one perturbation per element.
  const results: GradCheckResult[] = [];
  for (let k = 0; k < inputs.length; k++) {
    const input = inputs[k]!;
    const original = [...(await readTensor(input))].map(Number);
    const numeric: number[] = [];
    for (let i = 0; i < original.length; i++) {
      const plus = await evaluateWith(fn, inputs, k, original, i, eps);
      const minus = await evaluateWith(fn, inputs, k, original, i, -eps);
      numeric.push((plus - minus) / (2 * eps));
    }
    await writeValues(input, original);

    let worst: Mismatch | null = null;
    let failures = 0;
    for (let i = 0; i < numeric.length; i++) {
      const a = analytic[k]![i]!;
      const b = numeric[i]!;
      const delta = Math.abs(a - b);
      if (delta > atol + rtol * Math.abs(b)) {
        failures++;
        if (!worst || delta > worst.delta) worst = { index: i, got: a, want: b, delta };
      }
    }
    results.push({
      ok: failures === 0,
      input: k,
      analytic: analytic[k]!,
      numeric,
      worst,
    });
  }
  return results;
}

/**
 * Evaluate `fn` with one element of one input perturbed.
 *
 * @internal
 */
async function evaluateWith(
  fn: ScalarFn,
  inputs: readonly Tensor[],
  which: number,
  original: readonly number[],
  index: number,
  delta: number,
): Promise<number> {
  const perturbed = [...original];
  perturbed[index] = original[index]! + delta;
  await writeValues(inputs[which]!, perturbed);
  return noGrad(() => fn(...(inputs as Tensor[]))).item();
}

/**
 * Overwrite a tensor's values in place.
 *
 * The engine has no in-place operations, so this reaches through to the storage
 * directly. That is acceptable only here: perturbing an input is exactly what a
 * finite-difference check is, and doing it through the graph would record
 * thousands of nodes per check.
 *
 * @internal
 */
async function writeValues(tensor: Tensor, values: readonly number[]): Promise<void> {
  const { DTYPE_BYTES } = await import('./dtype.ts');
  const bytes = new Uint8Array(values.length * DTYPE_BYTES[tensor.dtype]);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat64(i * 8, values[i]!, true);
  tensor.backend.copyH2D(
    tensor.storage.pooled.buffer,
    tensor.offset * DTYPE_BYTES[tensor.dtype],
    bytes,
    tensor.backend.createStream(),
  );
}

/** Render a gradient-check result for a test message. */
export function describeGradCheck(result: GradCheckResult): string {
  if (result.ok) return `input ${result.input}: analytic matches numeric`;
  const worst = result.worst!;
  return `input ${result.input}: element ${worst.index} analytic ${worst.got} vs numeric ${worst.want} (delta ${worst.delta})`;
}

/** Whether a dtype can carry a meaningful gradient. */
export function differentiable(dtype: DType): boolean {
  return isFloat(dtype);
}

/** Deterministic pseudo-random values, so failures reproduce. */
export function sampleValues(count: number, seed = 1): number[] {
  // A small xorshift, adequate for test inputs and stable across platforms.
  let state = (seed * 2654435761) >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    // Spread over roughly [-1, 1], avoiding exact zeros where gradients kink.
    const unit = (state >>> 8) / 0x01000000;
    const value = unit * 2 - 1;
    out.push(Math.abs(value) < 0.05 ? value + 0.3 : value);
  }
  return out;
}

/** Device-agnostic helper for building f64 inputs for a gradient check. */
export async function gradInput(
  values: readonly number[],
  shape: readonly number[],
  device: Device,
): Promise<Tensor> {
  const { tensor } = await import('./index.ts');
  return tensor([...values], { shape, dtype: 'f64', device, requiresGrad: true });
}
