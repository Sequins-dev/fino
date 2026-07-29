/**
 * Stateless neural-network functions.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/nn`; import from there.
 */
import type { Tensor } from '../tensor.ts';
import type { Generator } from '../generator.ts';
import { noGrad } from '../autograd.ts';
import { dispatch } from '../dispatch.ts';
import { RED } from '../ops/reduce.ts';
import { mulScalar } from '../ops/elementwise.ts';

/** Rectified linear unit. */
export function relu(x: Tensor): Tensor {
  return x.relu();
}

/** Gaussian error linear unit. */
export function gelu(x: Tensor): Tensor {
  return x.gelu();
}

/** Sigmoid-weighted linear unit. */
export function silu(x: Tensor): Tensor {
  return x.silu();
}

/** Softmax along an axis. */
export function softmax(x: Tensor, axis = -1): Tensor {
  return x.softmax(axis);
}

/** Log-softmax along an axis. */
export function logSoftmax(x: Tensor, axis = -1): Tensor {
  return x.logSoftmax(axis);
}

/**
 * Layer normalisation over the last axis.
 */
export function layerNorm(
  x: Tensor,
  weight: Tensor | null = null,
  bias: Tensor | null = null,
  epsilon = 1e-5,
): Tensor {
  const inputs: Tensor[] = [x];
  if (weight) inputs.push(weight);
  if (bias) inputs.push(bias);
  return dispatch(RED.layerNorm!, inputs, {
    axisSize: x.shape[x.rank - 1]!,
    epsilon,
    rms: false,
    hasWeight: weight !== null,
    hasBias: bias !== null,
  });
}

/**
 * Root-mean-square normalisation, which omits mean subtraction.
 */
export function rmsNorm(x: Tensor, weight: Tensor | null = null, epsilon = 1e-6): Tensor {
  const inputs: Tensor[] = [x];
  if (weight) inputs.push(weight);
  return dispatch(RED.layerNorm!, inputs, {
    axisSize: x.shape[x.rank - 1]!,
    epsilon,
    rms: true,
    hasWeight: weight !== null,
    hasBias: false,
  });
}

/**
 * Randomly zero elements and scale the survivors by `1 / (1 - p)`.
 *
 * Scaling here — inverted dropout — is what lets evaluation be a plain no-op
 * rather than needing its own scaling pass.
 *
 * The mask is built without recording gradients: it is a constant of this forward
 * pass, and the gradient flows through the multiply.
 */
export function dropout(x: Tensor, p: number, generator: Generator): Tensor {
  if (p === 0) return x;
  const mask = noGrad(() => bernoulliLike(x, 1 - p, generator));
  return mulScalar(x.mul(mask), 1 / (1 - p));
}

/** Mean squared error between predictions and targets. */
export function mseLoss(
  prediction: Tensor,
  target: Tensor,
  reduction: 'mean' | 'sum' = 'mean',
): Tensor {
  const difference = prediction.sub(target);
  const squared = difference.mul(difference);
  return reduction === 'mean' ? squared.mean() : squared.sum();
}

/**
 * Cross-entropy between logits and integer class targets.
 *
 * Computed through log-softmax rather than by taking the log of a softmax: the
 * former is stable for large logits, the latter is not.
 */
export function crossEntropy(
  logits: Tensor,
  targets: Tensor,
  reduction: 'mean' | 'sum' = 'mean',
): Tensor {
  if (logits.rank !== 2) {
    throw new Error(`crossEntropy expects [batch, classes] logits, got rank ${logits.rank}`);
  }
  const logProbabilities = logits.logSoftmax(1);
  // Select each row's target class with a one-hot mask, which keeps the whole
  // expression differentiable with the primitives already registered.
  const oneHot = noGrad(() => oneHotLike(targets, logits.shape[1]!, logits));
  const picked = logProbabilities.mul(oneHot).sum([1]);
  const total = picked.neg();
  return reduction === 'mean' ? total.mean() : total.sum();
}

/** Negative log-likelihood from log-probabilities and integer targets. */
export function nllLoss(
  logProbabilities: Tensor,
  targets: Tensor,
  reduction: 'mean' | 'sum' = 'mean',
): Tensor {
  const oneHot = noGrad(() =>
    oneHotLike(targets, logProbabilities.shape[logProbabilities.rank - 1]!, logProbabilities),
  );
  const picked = logProbabilities.mul(oneHot).sum([logProbabilities.rank - 1]);
  const total = picked.neg();
  return reduction === 'mean' ? total.mean() : total.sum();
}

/**
 * Hooks installed by the `fino:tensor/nn` barrel, avoiding an import cycle.
 *
 * @internal
 */
let hooks: {
  bernoulli(like: Tensor, keepProbability: number, generator: Generator): Tensor;
  oneHot(indices: Tensor, classes: number, like: Tensor): Tensor;
} | null = null;

/** Install the operations these functions need. */
export function installFunctionalHooks(value: NonNullable<typeof hooks>): void {
  hooks = value;
}

/**
 * @internal
 */
function bernoulliLike(x: Tensor, keepProbability: number, generator: Generator): Tensor {
  if (!hooks) throw new Error('functional hooks are not installed');
  return hooks.bernoulli(x, keepProbability, generator);
}

/**
 * @internal
 */
function oneHotLike(indices: Tensor, classes: number, like: Tensor): Tensor {
  if (!hooks) throw new Error('functional hooks are not installed');
  return hooks.oneHot(indices, classes, like);
}
