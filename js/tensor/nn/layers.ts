/**
 * Layers.
 *
 * Intentionally a small set: enough to build and validate a transformer block,
 * not a catalogue. Each layer is a thin composition of registered primitives, so
 * a layer never needs a backend to know about it.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/nn`; import from there.
 */
import type { DType } from '../dtype.ts';
import type { Device } from '../backend.ts';
import type { Tensor } from '../tensor.ts';
import { Generator } from '../generator.ts';
import { Module } from './module.ts';
import { kaimingUniform, normal, zeros as zerosInit } from './init.ts';
import { dropout, layerNorm } from './functional.ts';

/** Options shared by the layers. */
export interface LayerOptions {
  dtype?: DType;
  device?: Device;
  /** Source of initial values. Supply one for reproducible initialisation. */
  generator?: Generator;
}

/**
 * A fully connected layer computing `x @ w + b`.
 *
 * The weight is stored as `[inFeatures, outFeatures]` so the forward pass is a
 * plain matmul with no transpose.
 */
export class Linear extends Module {
  readonly inFeatures: number;
  readonly outFeatures: number;
  readonly hasBias: boolean;

  constructor(
    inFeatures: number,
    outFeatures: number,
    options: LayerOptions & { bias?: boolean } = {},
  ) {
    super();
    this.inFeatures = inFeatures;
    this.outFeatures = outFeatures;
    this.hasBias = options.bias ?? true;
    const generator = options.generator ?? new Generator(0);
    this.registerParameter(
      'weight',
      kaimingUniform([inFeatures, outFeatures], inFeatures, generator, options),
    );
    if (this.hasBias) {
      // Matching the weight's scale keeps the initial output centred; a zero bias
      // would be defensible too, and this follows PyTorch.
      const bound = 1 / Math.sqrt(inFeatures);
      this.registerParameter(
        'bias',
        normal([outFeatures], 0, bound, generator, options),
      );
    }
  }

  /** Apply the layer. */
  forward(x: Tensor): Tensor {
    const out = x.matmul(this.parameter('weight'));
    return this.hasBias ? out.add(this.parameter('bias')) : out;
  }
}

/**
 * A lookup table mapping integer ids to vectors.
 */
export class Embedding extends Module {
  readonly numEmbeddings: number;
  readonly dim: number;

  constructor(numEmbeddings: number, dim: number, options: LayerOptions = {}) {
    super();
    this.numEmbeddings = numEmbeddings;
    this.dim = dim;
    const generator = options.generator ?? new Generator(0);
    this.registerParameter(
      'weight',
      normal([numEmbeddings, dim], 0, 1, generator, options),
    );
  }

  /**
   * Look up `ids`.
   *
   * The gradient is a scatter-add, so a repeated id accumulates rather than
   * overwrites — which is what makes training on batches with repeated tokens
   * correct.
   */
  forward(ids: Tensor): Tensor {
    return this.parameter('weight').indexSelect(ids, 0);
  }
}

/**
 * Layer normalisation over the last axis.
 */
export class LayerNorm extends Module {
  readonly size: number;
  readonly epsilon: number;
  readonly affine: boolean;

  constructor(
    size: number,
    options: LayerOptions & { epsilon?: number; affine?: boolean } = {},
  ) {
    super();
    this.size = size;
    this.epsilon = options.epsilon ?? 1e-5;
    this.affine = options.affine ?? true;
    if (this.affine) {
      this.registerParameter('weight', onesFor([size], options));
      this.registerParameter('bias', zerosInit([size], options));
    }
  }

  /** Apply the layer. */
  forward(x: Tensor): Tensor {
    return layerNorm(
      x,
      this.affine ? this.parameter('weight') : null,
      this.affine ? this.parameter('bias') : null,
      this.epsilon,
    );
  }
}

/**
 * Randomly zeroes elements during training and scales the rest.
 *
 * A no-op in evaluation mode, which is why `Module.eval()` exists.
 */
export class Dropout extends Module {
  readonly p: number;

  /**
   * Substream for mask sampling, so each layer's masks are independent and the
   * whole model stays reproducible from one seed.
   *
   * @internal
   */
  #generator: Generator;

  constructor(p = 0.5, options: LayerOptions = {}) {
    super();
    if (p < 0 || p >= 1) throw new Error(`dropout probability must be in [0, 1), got ${p}`);
    this.p = p;
    this.#generator = options.generator ?? new Generator(0);
  }

  /** Apply the layer. */
  forward(x: Tensor): Tensor {
    if (!this.training || this.p === 0) return x;
    return dropout(x, this.p, this.#generator);
  }
}

/**
 * Applies a list of layers in order.
 */
export class Sequential extends Module {
  /**
   * @internal
   */
  #layers: { forward(x: Tensor): Tensor }[] = [];

  constructor(...layers: (Module & { forward(x: Tensor): Tensor })[]) {
    super();
    layers.forEach((layer, index) => {
      this.registerModule(String(index), layer);
      this.#layers.push(layer);
    });
  }

  /** Apply every layer in order. */
  forward(x: Tensor): Tensor {
    let value = x;
    for (const layer of this.#layers) value = layer.forward(value);
    return value;
  }
}

/**
 * A tensor of ones, for an affine scale.
 *
 * @internal
 */
function onesFor(shape: readonly number[], options: LayerOptions): Tensor {
  const { fillOf } = requireOps();
  return fillOf(shape, options.dtype ?? 'f32', requireDevice(options), 1);
}

/**
 * Hooks installed by `fino:tensor/nn`'s barrel so this module does not import the
 * operation registry directly and create a cycle.
 *
 * @internal
 */
let hooks: {
  fillOf(shape: readonly number[], dtype: DType, device: Device, value: number): Tensor;
  defaultDevice(): Device;
} | null = null;

/** Install the operations the layers need. */
export function installLayerHooks(value: NonNullable<typeof hooks>): void {
  hooks = value;
}

/**
 * @internal
 */
function requireOps(): NonNullable<typeof hooks> {
  if (!hooks) throw new Error('layer hooks are not installed');
  return hooks;
}

/**
 * @internal
 */
function requireDevice(options: LayerOptions): Device {
  return options.device ?? requireOps().defaultDevice();
}
