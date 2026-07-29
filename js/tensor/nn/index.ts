/**
 * `fino:tensor/nn` — layers, losses, and initialisers.
 *
 * A deliberately small surface: `Module`, the handful of layers a transformer
 * needs, the standard losses, and initialisers. It exists to validate the
 * substrate and to support real models, not to mirror PyTorch's catalogue.
 *
 * ```ts no_run
 * import { Linear, Sequential, relu, mseLoss } from 'fino:tensor/nn';
 * import { Generator } from 'fino:tensor';
 *
 * const generator = new Generator(42);
 * const model = new Sequential(
 *   new Linear(4, 8, { generator }),
 *   new Linear(8, 1, { generator }),
 * );
 * ```
 *
 * **Experimental**, alongside the rest of the tensor engine.
 */
import type { DType } from '../dtype.ts';
import type { Device } from '../backend.ts';
import { resolveDevice } from '../backend.ts';
import type { Tensor } from '../tensor.ts';
import type { Generator } from '../generator.ts';
import { arangeOf, castTo, fillOf, reshape } from '../ops/index.ts';
import { installInitHooks } from './init.ts';
import { installLayerHooks } from './layers.ts';
import { installFunctionalHooks } from './functional.ts';
import { fromHostValues, defaultDevice } from '../create.ts';

installInitHooks({ fromValues: fromHostValues, fillOf, defaultDevice });
installLayerHooks({ fillOf, defaultDevice });
installFunctionalHooks({
  bernoulli: (like, keepProbability, generator) => {
    // Sampled on the host and uploaded. A device-side kernel using the same
    // counter-based scheme is the eventual path; the values are identical either
    // way, which is the point of making the scheme counter-based.
    const values = generator.uniform(like.size).map((u) => (u < keepProbability ? 1 : 0));
    return fromHostValues(values, like.shape, like.dtype, like.device);
  },
  oneHot: (indices, classes, like) => {
    // Compare each index against a row of class numbers, which turns a gather
    // into an elementwise expression the existing primitives already cover.
    const row = arangeOf(classes, 'i32', like.device);
    const column = reshape(indices, [...indices.shape, 1]);
    return castTo(column.eq(row.cast(column.dtype)), like.dtype);
  },
});

export { Module } from './module.ts';
export type { NamedTensor } from './module.ts';
export { Linear, Embedding, LayerNorm, Dropout, Sequential } from './layers.ts';
export type { LayerOptions } from './layers.ts';
export {
  relu,
  gelu,
  silu,
  softmax,
  logSoftmax,
  layerNorm,
  rmsNorm,
  dropout,
  mseLoss,
  crossEntropy,
  nllLoss,
} from './functional.ts';
export * as init from './init.ts';
export type { InitOptions } from './init.ts';
