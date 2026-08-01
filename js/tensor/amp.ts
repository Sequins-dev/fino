/**
 * Mixed precision: running the expensive part in half the width.
 *
 * Half precision is worth roughly twice the arithmetic throughput and half the memory
 * traffic, and costs about three decimal digits of mantissa. Which of those matters
 * depends entirely on the operation, so mixed precision is not a dtype you pick — it is
 * a policy about where the loss of precision is affordable.
 *
 * Two pieces, and they are independent. {@link autocast} decides which operations run
 * narrow. {@link GradScaler} keeps gradients inside the range half precision can
 * represent at all. A model can use either alone, but training usually needs both:
 * autocast without scaling silently flushes small gradients to zero, and scaling
 * without autocast costs a multiply for nothing.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from './dtype.ts';
import type { Tensor } from './tensor.ts';

/**
 * Operations autocast runs in reduced precision.
 *
 * Deliberately just the matrix multiply. It is where the throughput is, it accumulates
 * in `f32` regardless of what it reads, and its error is averaged over a reduction
 * rather than compounded through one. Everything else keeps the dtype it was given.
 *
 * The temptation is a longer list — every framework has one — but each entry is a claim
 * about numerical behaviour that has to be justified per operation, and a wrong entry
 * is a model that trains to a worse answer without failing. Additions belong here with
 * evidence, not by analogy.
 */
const REDUCED_PRECISION = new Set(['gemm']);

/**
 * The dtype operations should narrow to, or null outside an autocast scope.
 *
 * @internal
 */
let active: DType | null = null;

/** The dtype autocast is currently narrowing to, or null. */
export function autocastDType(): DType | null {
  return active;
}

/** Whether an operation runs in reduced precision under the current scope. */
export function autocastsOp(name: string): boolean {
  return active !== null && REDUCED_PRECISION.has(name);
}

/**
 * Casts an operand, installed by the operation modules to avoid a cycle.
 *
 * @internal
 */
let castTo: ((tensor: Tensor, dtype: DType) => Tensor) | null = null;

/** Install the cast autocast narrows with. */
export function installAutocastHooks(cast: (tensor: Tensor, dtype: DType) => Tensor): void {
  castTo = cast;
}

/**
 * Narrow an operation's operands, or hand them back untouched.
 *
 * Returns the same array when nothing changes, so the ordinary path costs one set
 * lookup and no allocation.
 */
export function narrowOperands(name: string, inputs: readonly Tensor[]): readonly Tensor[] {
  const dtype = active;
  if (dtype === null || !REDUCED_PRECISION.has(name)) return inputs;
  if (!castTo) throw new Error('autocast hooks are not installed');
  let changed = false;
  const narrowed = inputs.map((input) => {
    // Only float operands, and only ones that are actually wider. Narrowing an index
    // tensor would corrupt it, and widening defeats the purpose.
    if (input.dtype === dtype || !FLOAT_DTYPES.has(input.dtype)) return input;
    if (RANK_OF[input.dtype]! <= RANK_OF[dtype]!) return input;
    changed = true;
    return castTo!(input, dtype);
  });
  return changed ? narrowed : inputs;
}

/**
 * @internal
 */
const FLOAT_DTYPES = new Set<DType>(['f64', 'f32', 'f16', 'bf16']);

/**
 * Width order, so narrowing never accidentally widens.
 *
 * @internal
 */
const RANK_OF: Partial<Record<DType, number>> = { bf16: 1, f16: 1, f32: 2, f64: 3 };

/**
 * Run `fn` with matrix multiplies narrowed to `dtype`.
 *
 * Scopes nest and restore, so a region can opt back out with `autocast(null, ...)`.
 * The narrowing happens at dispatch, which means gradients flow through the casts like
 * any other operation and the backward pass narrows in the same places the forward one
 * did.
 *
 * ```ts no_run
 * const loss = autocast('f16', () => model.forward(x).sub(y).pow(2).mean());
 * ```
 */
export function autocast<T>(dtype: DType | null, fn: () => T): T {
  const previous = active;
  active = dtype;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

/** How a {@link GradScaler} adapts its scale. */
export interface GradScalerOptions {
  /** Starting scale. The default is deliberately large; it comes down quickly. */
  initial?: number;
  /** Multiplier applied after a run of finite steps. */
  growth?: number;
  /** Multiplier applied the moment a gradient overflows. */
  backoff?: number;
  /** Finite steps required before the scale grows. */
  interval?: number;
}

/**
 * Keeps gradients inside the range half precision can represent.
 *
 * Half precision underflows below about 6e-8, and gradients are routinely smaller than
 * that — they vanish silently, which looks like a model that has stopped learning
 * rather than like a bug. Multiplying the loss by a large constant moves the whole
 * backward pass into range; dividing the gradients by the same constant before the
 * optimizer sees them takes it back out, exactly, since scaling is linear.
 *
 * The scale cannot be fixed: too small and gradients still vanish, too large and they
 * overflow to infinity. So it adapts — halving the moment anything overflows, and
 * creeping up after a run of steps that did not. A step whose gradients overflowed is
 * *skipped* rather than applied, because those gradients are not merely imprecise, they
 * are infinite.
 */
export class GradScaler {
  #scale: number;
  #growth: number;
  #backoff: number;
  #interval: number;
  #healthy = 0;
  #skipped = 0;

  constructor(options: GradScalerOptions = {}) {
    this.#scale = options.initial ?? 65536;
    this.#growth = options.growth ?? 2;
    this.#backoff = options.backoff ?? 0.5;
    this.#interval = options.interval ?? 2000;
  }

  /** The current scale. */
  get scale(): number {
    return this.#scale;
  }

  /** Steps skipped because their gradients overflowed. */
  get skipped(): number {
    return this.#skipped;
  }

  /** Multiply a loss so its gradients land in range. */
  scale_(loss: Tensor): Tensor {
    return loss.mul(this.#scale);
  }

  /**
   * Divide gradients back down, and report whether they are usable.
   *
   * Reads one boolean back from the device, which is a synchronisation point — but a
   * training loop reads its loss anyway, and applying an infinite gradient is not
   * something to discover later.
   */
  async unscale(parameters: readonly Tensor[]): Promise<boolean> {
    const inverse = 1 / this.#scale;
    let finite = true;
    for (const parameter of parameters) {
      const gradient = parameter.grad;
      if (!gradient) continue;
      // `g - g == 0` is true exactly when g is finite: an infinity minus itself is a
      // NaN, and a NaN compares false against everything. That catches both failure
      // modes with operations the engine already has, rather than adding a predicate
      // every backend would then have to implement.
      const ok = await gradient.sub(gradient).eq(0).all().item();
      if (!ok) finite = false;
      const scaled = gradient.mul(inverse);
      gradient.dispose();
      parameter.grad = scaled;
    }
    if (!finite) this.#skipped++;
    return finite;
  }

  /**
   * Adapt the scale after a step.
   *
   * Called with whatever {@link unscale} reported.
   */
  update(finite: boolean): void {
    if (!finite) {
      this.#scale = Math.max(this.#scale * this.#backoff, 1);
      this.#healthy = 0;
      return;
    }
    this.#healthy++;
    if (this.#healthy >= this.#interval) {
      this.#healthy = 0;
      this.#scale *= this.#growth;
    }
  }
}
