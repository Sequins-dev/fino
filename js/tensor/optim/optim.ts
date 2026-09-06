/**
 * Optimizers.
 *
 * Updates run under `noGrad`: an optimizer step is not part of the model's
 * computation, and recording it would build a graph that grows every iteration.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/optim`; import from there.
 */
import type { Tensor } from '../tensor.ts';
import { keep, tidy } from '../tensor.ts';
import { noGrad } from '../autograd.ts';
import { currentGraph } from '../graph.ts';
import type { OpAttrs } from '../backend.ts';
import { computeStream } from '../dispatch.ts';

/** A parameter group with its own hyperparameters. */
export interface ParamGroup {
  params: Tensor[];
  lr?: number;
  weightDecay?: number;
}

/** Shared optimizer behaviour. */
export abstract class Optimizer {
  /**
   * Parameter groups, each with its own hyperparameters.
   *
   * @internal
   */
  protected groups: ParamGroup[];

  /** Steps taken so far, which the schedules and Adam's bias correction read. */
  #steps = 0;

  constructor(
    params: Tensor[] | ParamGroup[],
    protected defaults: { lr: number; weightDecay?: number },
  ) {
    const groups: ParamGroup[] =
      Array.isArray(params) && params.length > 0 && 'params' in (params[0] as object)
        ? (params as ParamGroup[])
        : [{ params: params as Tensor[] }];
    this.groups = groups;
  }

  /** Number of steps taken. */
  get steps(): number {
    return this.#steps;
  }

  /** Learning rate of the first group. */
  get lr(): number {
    return this.groups[0]?.lr ?? this.defaults.lr;
  }

  /** Set the learning rate on every group. */
  set lr(value: number) {
    for (const group of this.groups) group.lr = value;
  }

  /** Every parameter under this optimizer. */
  parameters(): Tensor[] {
    return this.groups.flatMap((group) => group.params);
  }

  /**
   * Apply one update.
   *
   * Marks a step boundary on the recording, which is what lets the graph drop
   * nodes from previous iterations and is the hash a future capture/replay pass
   * compares.
   */
  step(): void {
    this.#steps++;
    // An update allocates several intermediates per parameter and returns none of
    // them, so without a scope here every step would leak them. Optimizer state
    // that must survive is marked with `keep` by the subclass.
    tidy(() => {
      noGrad(() => {
        for (const group of this.groups) {
          const lr = group.lr ?? this.defaults.lr;
          const weightDecay = group.weightDecay ?? this.defaults.weightDecay ?? 0;
          for (const parameter of group.params) {
            if (!parameter.grad) continue;
            this.update(parameter, parameter.grad, lr, weightDecay);
          }
        }
      });
    });
    currentGraph().markStep();
  }

  /**
   * Run the backend's fused update, or report that it cannot.
   *
   * An update composed from elementwise operations costs a launch and a pass over
   * memory for each one — sixteen of each per parameter for Adam, which in a small
   * model is most of the work in a step. The backends expose the whole update as a
   * single primitive precisely so it can be one launch that reads and writes each
   * buffer once. Where a backend cannot, the composition below still answers.
   *
   * The tensors are updated in place, which is the only place this engine does that:
   * an optimiser step is not part of the differentiated graph, and allocating a new
   * parameter every step would defeat the point.
   *
   * @internal
   */
  protected fused(kind: 'sgd' | 'adam', tensors: readonly Tensor[], attrs: OpAttrs): boolean {
    const backend = tensors[0]!.backend;
    // A fresh descriptor per operand: the shared scratch that dispatch uses is reused
    // between operands, and these are all live at once.
    const descriptors = tensors.map((t) =>
      t.describe({ buffer: null as never, dtype: t.dtype, shape: [], strides: [], offset: 0 }),
    );
    if (!backend.supportsOp(kind === 'sgd' ? 'sgdStep' : 'adamStep', descriptors)) {
      return false;
    }
    for (const tensor of tensors) {
      // Every buffer is walked in lockstep by index, so a strided one would be read
      // through the wrong positions.
      if (!tensor.contiguous || tensor.size !== tensors[0]!.size) return false;
    }
    backend.optimizerStep(kind, descriptors, attrs, computeStream(backend));
    return true;
  }

  /** Update one parameter in place. */
  protected abstract update(parameter: Tensor, grad: Tensor, lr: number, weightDecay: number): void;

  /** Clear every gradient. */
  zeroGrad(options: { setToNull?: boolean } = {}): void {
    const setToNull = options.setToNull ?? true;
    for (const parameter of this.parameters()) {
      if (!parameter.grad) continue;
      if (setToNull) {
        parameter.grad.dispose();
        parameter.grad = null;
      } else {
        const zeroed = noGrad(() => parameter.grad!.mul(0));
        parameter.grad.dispose();
        parameter.grad = zeroed;
      }
    }
  }

  /**
   * Replace a parameter's values with those of `next`, then release `next`.
   *
   * Parameters are identity-stable: a module and any schedule hold references to
   * them, so an update must not swap in a new tensor.
   *
   * @internal
   */
  protected assign(parameter: Tensor, next: Tensor): void {
    const bytes = parameter.byteLength;
    const stream = parameter.backend.createStream();
    parameter.backend.copyD2D(
      parameter.storage.pooled.buffer,
      0,
      next.storage.pooled.buffer,
      0,
      bytes,
      stream,
    );
    next.dispose();
  }

  /** Release any state the optimizer holds. */
  dispose(): void {}
}

/**
 * Stochastic gradient descent, optionally with momentum.
 */
export class SGD extends Optimizer {
  #momentum: number;
  #nesterov: boolean;
  /**
   * Velocity per parameter, allocated on first use so a parameter that never
   * receives a gradient costs nothing.
   *
   * @internal
   */
  #velocity = new Map<Tensor, Tensor>();

  constructor(
    params: Tensor[] | ParamGroup[],
    options: { lr?: number; momentum?: number; weightDecay?: number; nesterov?: boolean } = {},
  ) {
    super(params, { lr: options.lr ?? 0.01, weightDecay: options.weightDecay });
    this.#momentum = options.momentum ?? 0;
    this.#nesterov = options.nesterov ?? false;
    if (this.#nesterov && this.#momentum === 0) {
      throw new Error('Nesterov momentum needs a non-zero momentum');
    }
  }

  protected update(parameter: Tensor, grad: Tensor, lr: number, weightDecay: number): void {
    if (this.#momentum !== 0 && !this.#velocity.has(parameter)) {
      // Allocated before the fused path can run, since it updates the buffer rather
      // than producing one.
      this.#velocity.set(parameter, keep(noGrad(() => grad.mul(0))));
    }
    const velocity = this.#velocity.get(parameter) ?? null;
    const tensors = velocity ? [parameter, grad, velocity] : [parameter, grad];
    if (
      this.fused('sgd', tensors, {
        lr,
        decay: weightDecay,
        decoupled: false,
        momentum: this.#momentum,
        nesterov: this.#nesterov,
      })
    ) {
      return;
    }

    let direction = weightDecay !== 0 ? grad.add(parameter.mul(weightDecay)) : grad;
    if (this.#momentum !== 0) {
      const previous = this.#velocity.get(parameter);
      const velocity = previous ? previous.mul(this.#momentum).add(direction) : direction.mul(1);
      previous?.dispose();
      keep(velocity);
      this.#velocity.set(parameter, velocity);
      direction = this.#nesterov ? direction.add(velocity.mul(this.#momentum)) : velocity;
    }
    this.assign(parameter, parameter.sub(direction.mul(lr)));
  }

  dispose(): void {
    for (const velocity of this.#velocity.values()) velocity.dispose();
    this.#velocity.clear();
  }
}

/** State Adam keeps per parameter. */
interface AdamState {
  /** First moment. */
  m: Tensor;
  /** Second moment. */
  v: Tensor;
}

/**
 * Adam, and AdamW when `decoupledWeightDecay` is set.
 *
 * The difference matters: Adam folds weight decay into the gradient, so the
 * adaptive scaling shrinks it, while AdamW applies it directly to the parameter.
 * The latter is what makes decay behave consistently across parameters.
 */
export class Adam extends Optimizer {
  #beta1: number;
  #beta2: number;
  #epsilon: number;
  #decoupled: boolean;
  /**
   * @internal
   */
  #state = new Map<Tensor, AdamState>();

  constructor(
    params: Tensor[] | ParamGroup[],
    options: {
      lr?: number;
      betas?: readonly [number, number];
      epsilon?: number;
      weightDecay?: number;
      decoupledWeightDecay?: boolean;
    } = {},
  ) {
    super(params, { lr: options.lr ?? 0.001, weightDecay: options.weightDecay });
    const [beta1, beta2] = options.betas ?? [0.9, 0.999];
    this.#beta1 = beta1;
    this.#beta2 = beta2;
    this.#epsilon = options.epsilon ?? 1e-8;
    this.#decoupled = options.decoupledWeightDecay ?? false;
  }

  protected update(parameter: Tensor, grad: Tensor, lr: number, weightDecay: number): void {
    let direction = grad;
    let decayed = parameter;
    if (weightDecay !== 0) {
      if (this.#decoupled) {
        // AdamW: decay the parameter, outside the adaptive step.
        decayed = parameter.sub(parameter.mul(lr * weightDecay));
      } else {
        direction = grad.add(parameter.mul(weightDecay));
      }
    }

    let state = this.#state.get(parameter);
    if (!state) {
      state = { m: keep(grad.mul(0)), v: keep(grad.mul(0)) };
      this.#state.set(parameter, state);
    }

    if (
      this.fused('adam', [parameter, grad, state.m, state.v], {
        lr,
        decay: weightDecay,
        decoupled: this.#decoupled,
        beta1: this.#beta1,
        beta2: this.#beta2,
        epsilon: this.#epsilon,
        corr1: 1 - this.#beta1 ** this.steps,
        corr2: 1 - this.#beta2 ** this.steps,
      })
    ) {
      return;
    }

    const m = state.m.mul(this.#beta1).add(direction.mul(1 - this.#beta1));
    const v = state.v.mul(this.#beta2).add(direction.mul(direction).mul(1 - this.#beta2));
    state.m.dispose();
    state.v.dispose();
    state.m = keep(m);
    state.v = keep(v);

    // Bias correction, because both moments start at zero and are therefore
    // biased towards it for the first several steps.
    const correction1 = 1 - this.#beta1 ** this.steps;
    const correction2 = 1 - this.#beta2 ** this.steps;
    const mHat = m.mul(1 / correction1);
    const vHat = v.mul(1 / correction2);
    const update = mHat.div(vHat.sqrt().add(this.#epsilon)).mul(lr);
    const next = decayed.sub(update);
    if (decayed !== parameter) decayed.dispose();
    this.assign(parameter, next);
  }

  dispose(): void {
    for (const state of this.#state.values()) {
      state.m.dispose();
      state.v.dispose();
    }
    this.#state.clear();
  }
}

/**
 * AdamW: Adam with decoupled weight decay.
 */
export class AdamW extends Adam {
  constructor(
    params: Tensor[] | ParamGroup[],
    options: {
      lr?: number;
      betas?: readonly [number, number];
      epsilon?: number;
      weightDecay?: number;
    } = {},
  ) {
    super(params, {
      ...options,
      weightDecay: options.weightDecay ?? 0.01,
      decoupledWeightDecay: true,
    });
  }
}

/**
 * Scale gradients so their global L2 norm does not exceed `maxNorm`.
 *
 * Returns the norm measured before clipping, which is worth logging: a norm that
 * spikes is usually the first visible sign of a diverging run.
 *
 * Asynchronous because deciding *whether* to scale needs the norm as a number,
 * and reading a value off a device is a synchronisation point. There is no way
 * around that for norm-based clipping; a training loop that cannot afford a fence
 * here should clip by a fixed scale instead.
 */
export async function clipGradNorm(params: readonly Tensor[], maxNorm: number): Promise<number> {
  const totalSquares = noGrad(() => {
    let total: Tensor | null = null;
    for (const parameter of params) {
      if (!parameter.grad) continue;
      const squares = parameter.grad.mul(parameter.grad).sum();
      total = total ? total.add(squares) : squares;
    }
    return total;
  });
  if (!totalSquares) return 0;
  const norm = Math.sqrt(await totalSquares.item());
  totalSquares.dispose();
  if (norm > maxNorm && norm > 0) {
    const scale = maxNorm / norm;
    noGrad(() => {
      for (const parameter of params) {
        if (!parameter.grad) continue;
        const scaled = parameter.grad.mul(scale);
        parameter.grad.dispose();
        parameter.grad = scaled;
      }
    });
  }
  return norm;
}
