/**
 * Attention and the transformer block built from it.
 *
 * Composed entirely from primitives the backends already have — matmul, softmax,
 * layer norm, and the elementwise set — rather than added as new operations. That is
 * the point of the exercise: if a transformer needs a kernel the engine does not have,
 * the op set is wrong, and it turns out it does not.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/nn`; import from there.
 */
import type { Tensor } from '../tensor.ts';
import type { Device } from '../backend.ts';
import type { DType } from '../dtype.ts';
import { noGrad } from '../autograd.ts';
import { arangeOf, castTo, reshape, permute, transpose } from '../ops/index.ts';
import { Module } from './module.ts';
import { Dropout, Linear, LayerNorm } from './layers.ts';
import type { LayerOptions } from './layers.ts';
import { gelu } from './functional.ts';

/** How an attention layer is built. */
export interface AttentionOptions extends LayerOptions {
  /** Whether the projections carry a bias. Defaults to true. */
  bias?: boolean;
  /**
   * Whether a position may attend only to itself and earlier ones.
   *
   * What makes a decoder a decoder: without it a language model can read the token it
   * is being asked to predict. Defaults to true.
   */
  causal?: boolean;
  /** Dropout applied to the attention weights. Defaults to none. */
  dropout?: number;
}

/**
 * Multi-head self-attention.
 *
 * Takes `[batch, tokens, channels]` and returns the same shape. Heads are expressed by
 * reshaping the channel axis and folding the head axis into the batch, so every matrix
 * multiply is one batched GEMM rather than a loop over heads.
 */
export class MultiHeadAttention extends Module {
  readonly dim: number;
  readonly heads: number;
  readonly headDim: number;
  readonly causal: boolean;

  /**
   * Additive masks by sequence length.
   *
   * A mask depends only on the length, so a training loop builds one and reuses it.
   * Held rather than recomputed because building it is several dispatches, which is
   * more than the attention it guards for a short sequence.
   *
   * @internal
   */
  #masks = new Map<number, Tensor>();

  /**
   * @internal
   */
  #dropout: Dropout | null;

  constructor(dim: number, heads: number, options: AttentionOptions = {}) {
    super();
    if (dim % heads !== 0) {
      throw new Error(`${dim} channels do not divide evenly into ${heads} heads`);
    }
    this.dim = dim;
    this.heads = heads;
    this.headDim = dim / heads;
    this.causal = options.causal ?? true;
    const bias = options.bias ?? true;
    this.registerModule('query', new Linear(dim, dim, { ...options, bias }));
    this.registerModule('key', new Linear(dim, dim, { ...options, bias }));
    this.registerModule('value', new Linear(dim, dim, { ...options, bias }));
    this.registerModule('out', new Linear(dim, dim, { ...options, bias }));
    this.#dropout = options.dropout ? new Dropout(options.dropout) : null;
    if (this.#dropout) this.registerModule('dropout', this.#dropout);
  }

  /**
   * Split the channel axis into heads and fold them into the batch.
   *
   * @internal
   */
  #split(x: Tensor, batch: number, tokens: number): Tensor {
    const perHead = reshape(x, [batch, tokens, this.heads, this.headDim]);
    // Heads move next to the batch so that folding them together leaves each head's
    // tokens contiguous, which is what makes the batched multiply correct.
    const ordered = permute(perHead, [0, 2, 1, 3]);
    return reshape(ordered, [batch * this.heads, tokens, this.headDim]);
  }

  /**
   * The additive mask for a sequence length, built once.
   *
   * Additive rather than a `where`: adding a large negative number before the softmax
   * needs no third operand to broadcast, and the softmax's own maximum subtraction
   * keeps it from becoming a NaN.
   *
   * @internal
   */
  #mask(tokens: number, dtype: DType, device: Device): Tensor {
    const existing = this.#masks.get(tokens);
    if (existing && !existing.disposed) return existing;
    const mask = noGrad(() => {
      const positions = arangeOf(tokens, 'i32', device);
      const rows = reshape(positions, [tokens, 1]);
      const columns = reshape(positions, [1, tokens]);
      // 1 where a position may be read, 0 where it may not.
      const allowed = castTo(rows.ge(columns), dtype);
      return allowed.sub(1).mul(1e9);
    });
    this.#masks.set(tokens, mask);
    return mask;
  }

  /** Apply attention to `[batch, tokens, channels]`. */
  forward(x: Tensor): Tensor {
    if (x.rank !== 3) {
      throw new Error(`attention expects [batch, tokens, channels], got rank ${x.rank}`);
    }
    const [batch, tokens, channels] = x.shape as [number, number, number];
    if (channels !== this.dim) {
      throw new Error(`attention was built for ${this.dim} channels, got ${channels}`);
    }

    const query = this.#split((this.child('query') as Linear).forward(x), batch, tokens);
    const key = this.#split((this.child('key') as Linear).forward(x), batch, tokens);
    const value = this.#split((this.child('value') as Linear).forward(x), batch, tokens);

    // Scaling before the softmax rather than after keeps the logits in a range where
    // the exponential does not saturate, which is the whole reason for the 1/sqrt(d).
    let scores = query.matmul(transpose(key)).mul(1 / Math.sqrt(this.headDim));
    if (this.causal) scores = scores.add(this.#mask(tokens, scores.dtype, scores.device));

    let weights = scores.softmax(-1);
    if (this.#dropout) weights = this.#dropout.forward(weights);

    const attended = weights.matmul(value);
    // Back to [batch, tokens, channels], undoing the split exactly.
    const heads = reshape(attended, [batch, this.heads, tokens, this.headDim]);
    const merged = reshape(permute(heads, [0, 2, 1, 3]), [batch, tokens, this.dim]);
    return (this.child('out') as Linear).forward(merged);
  }

  /** Release the cached masks along with the parameters. */
  dispose(): void {
    for (const mask of this.#masks.values()) mask.dispose();
    this.#masks.clear();
    super.dispose();
  }
}

/** How a transformer block is built. */
export interface TransformerBlockOptions extends AttentionOptions {
  /** Hidden width of the feed-forward network, as a multiple of `dim`. Defaults to 4. */
  mlpRatio?: number;
}

/**
 * One pre-norm transformer block.
 *
 * Normalisation sits before each sub-layer rather than after, which is what lets a
 * deep stack train without a warmup schedule: the residual path stays an identity all
 * the way through, so the gradient reaches the first block undiminished.
 */
export class TransformerBlock extends Module {
  readonly dim: number;

  constructor(dim: number, heads: number, options: TransformerBlockOptions = {}) {
    super();
    this.dim = dim;
    const hidden = Math.round(dim * (options.mlpRatio ?? 4));
    this.registerModule('norm1', new LayerNorm(dim, options));
    this.registerModule('attention', new MultiHeadAttention(dim, heads, options));
    this.registerModule('norm2', new LayerNorm(dim, options));
    this.registerModule('fc1', new Linear(dim, hidden, options));
    this.registerModule('fc2', new Linear(hidden, dim, options));
  }

  /** Apply the block to `[batch, tokens, channels]`. */
  forward(x: Tensor): Tensor {
    const attention = (this.child('attention') as MultiHeadAttention).forward(
      (this.child('norm1') as LayerNorm).forward(x),
    );
    const residual = x.add(attention);
    const hidden = gelu(
      (this.child('fc1') as Linear).forward((this.child('norm2') as LayerNorm).forward(residual)),
    );
    return residual.add((this.child('fc2') as Linear).forward(hidden));
  }
}
