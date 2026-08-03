/**
 * Structural, indexing, optimizer, and random kernels.
 *
 * These are the remainder of the primitive set: the operations that move data
 * rather than compute over it, plus the fused optimizer step and the counter-based
 * random samplers.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import { E, KernelBuilder, unroll } from '../builder.ts';
import { specKey } from '../key.ts';
import type { Expr, KernelIR, ScalarDType } from '../types.ts';
import { vt } from '../types.ts';
import { computeTypeFor } from './elementwise.ts';

/** Fill an output with a constant supplied as a parameter. */
export function fillKernel(spec: { dtype: ScalarDType; wg?: number }): {
  ir: KernelIR;
  key: string;
} {
  const wg = spec.wg ?? 256;
  const b = new KernelBuilder(`fill_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('out0', vt(spec.dtype), 'write');
  const n = b.param('n');
  const value = b.param('value', 'f32');
  b.gridStride(n, (i) => {
    b.store('out0', i, E.cast(vt(spec.dtype), value));
  });
  return { ir: b.build(), key: specKey('fill', { dtype: spec.dtype, wg }) };
}

/** Fill an output with an arithmetic sequence. */
export function arangeKernel(spec: { dtype: ScalarDType; wg?: number }): {
  ir: KernelIR;
  key: string;
} {
  const wg = spec.wg ?? 256;
  const b = new KernelBuilder(`arange_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('out0', vt(spec.dtype), 'write');
  const n = b.param('n');
  const start = b.param('start', 'f32');
  const step = b.param('step', 'f32');
  b.gridStride(n, (i) => {
    const value = E.add(start, E.mul(step, E.cast(vt('f32'), i)));
    b.store('out0', i, E.cast(vt(spec.dtype), value));
  });
  return { ir: b.build(), key: specKey('arange', { dtype: spec.dtype, wg }) };
}

/**
 * Copy through per-axis strides.
 *
 * Backs reshape, permute, expand, and slice. The output is contiguous; the input
 * is read through explicit strides, so a permutation is a reordering of stride
 * parameters rather than a distinct kernel, and a broadcast is a zero stride.
 *
 * Rank is baked so the index arithmetic unrolls. Shape and strides arrive as
 * parameters `shape0..`, `stride0..`, which keeps one compiled kernel serving
 * every shape of that rank.
 */
export function stridedCopyKernel(spec: {
  rank: number;
  from: ScalarDType;
  to?: ScalarDType;
  wg?: number;
}): { ir: KernelIR; key: string } {
  const wg = spec.wg ?? 256;
  const to = spec.to ?? spec.from;
  const rank = spec.rank;
  if (rank < 1 || rank > 8) throw new Error(`stridedCopy supports rank 1 to 8, got ${rank}`);

  const b = new KernelBuilder(`stridedcopy_r${rank}_${spec.from}_to_${to}`, [wg, 1, 1]);
  b.buffer('in0', vt(spec.from), 'read');
  b.buffer('out0', vt(to), 'write');
  const n = b.param('n');
  // Where the source view starts. A slice folds its per-axis start positions into
  // this, so taking a sub-region needs no kernel of its own — and any tensor that is
  // an alias into a larger buffer is read from the right place rather than from the
  // buffer's beginning.
  const base = b.param('base');
  const shape: Expr[] = [];
  const strides: Expr[] = [];
  for (let axis = 0; axis < rank; axis++) shape.push(b.param(`shape${axis}`));
  for (let axis = 0; axis < rank; axis++) strides.push(b.param(`stride${axis}`));

  b.gridStride(n, (i) => {
    // Unravel the flat output index from the innermost axis outwards, folding each
    // coordinate into the source offset as it is produced.
    b.var('rest', vt('u32'), i);
    b.var('src', vt('u32'), base);
    unroll(rank, (step) => {
      const axis = rank - 1 - step;
      const coord = b.letTemp(vt('u32'), E.mod(E.var('rest'), shape[axis]!), 'c');
      b.assign('rest', E.div(E.var('rest'), shape[axis]!));
      b.assign('src', E.add(E.var('src'), E.mul(coord, strides[axis]!)));
    });
    const loaded = E.load('in0', E.var('src'));
    const value =
      spec.from === to ? loaded : E.cast(vt(to), E.cast(vt(computeTypeFor(to)), loaded));
    b.store('out0', i, value);
  });

  return {
    ir: b.build(),
    key: specKey('stridedcopy', { rank, from: spec.from, to, wg }),
  };
}

/**
 * Gather slices by index; the embedding forward pass.
 *
 * Works along any axis. The output is `[outer, count, inner]` over an input of
 * `[outer, axisSize, inner]`, so `inner = 1` is the axis-0 case and a larger value
 * addresses an interior axis without a transpose.
 *
 * An out-of-range index writes a fault code into `status` and reads zero rather
 * than wandering off the buffer. A kernel cannot throw, so the framework checks
 * that flag at the next synchronisation point — which is exactly how the contract
 * says device errors surface.
 *
 * Buffers are `in0` (the table), `idx`, `out0`, and `status`. Parameters are `n`
 * (output element count), `count`, `inner`, and `axisSize`.
 */
export function indexSelectKernel(spec: { dtype: ScalarDType; wg?: number }): {
  ir: KernelIR;
  key: string;
} {
  const wg = spec.wg ?? 256;
  const b = new KernelBuilder(`indexselect_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('in0', vt(spec.dtype), 'read');
  b.buffer('idx', vt('i32'), 'read');
  b.buffer('out0', vt(spec.dtype), 'write');
  b.buffer('status', vt('u32'), 'readwrite');
  const n = b.param('n');
  const count = b.param('count');
  const inner = b.param('inner');
  const axisSize = b.param('axisSize');

  b.gridStride(n, (i) => {
    const span = b.letTemp(vt('u32'), E.mul(count, inner), 'span');
    const outer = b.letTemp(vt('u32'), E.div(i, span), 'o');
    const rest = b.letTemp(vt('u32'), E.mod(i, span), 'rest');
    const which = b.letTemp(vt('u32'), E.div(rest, inner), 'w');
    const offset = b.letTemp(vt('u32'), E.mod(rest, inner), 'off');
    const raw = b.letTemp(vt('i32'), E.load('idx', which), 'r');
    // Negative indices count from the end, matching the reference implementation.
    const wrapped = b.letTemp(
      vt('u32'),
      E.select(
        E.lt(raw, E.i32(0)),
        E.cast(vt('u32'), E.add(raw, E.cast(vt('i32'), axisSize))),
        E.cast(vt('u32'), raw),
      ),
      'ix',
    );
    b.if(
      E.lt(wrapped, axisSize),
      () => {
        const src = E.add(
          E.mul(E.add(E.mul(outer, axisSize), wrapped), inner),
          offset,
        );
        b.store('out0', i, E.load('in0', src));
      },
      () => {
        // Recording the offending value makes the eventual error specific. Racing
        // threads all write a valid offender, so any of them is informative.
        b.store('status', E.u32(0), E.add(wrapped, E.u32(1)));
        b.store('out0', i, E.const(vt(spec.dtype), 0));
      },
    );
  });

  return { ir: b.build(), key: specKey('indexselect', { dtype: spec.dtype, wg }) };
}

/**
 * Accumulate rows into a destination by index; the embedding backward pass.
 *
 * Uses an atomic add because repeated indices must accumulate rather than race.
 * The float atomic degrades to a compare-and-swap loop where the extension is
 * absent, which the SPIR-V lowering handles.
 *
 * Works along any axis, with the same `[outer, count, inner]` addressing as
 * {@link indexSelectKernel}, and reports an out-of-range index the same way.
 *
 * Buffers are `idx`, `src`, `out0`, and `status`. Parameters are `n` (source
 * element count), `count`, `inner`, and `axisSize`.
 */
/**
 * Take one element per output position along an axis.
 *
 * Nearly the index-select kernel, and the one difference is the whole distinction between
 * them: this reads the index at the output position rather than at the slice, so every
 * output element chooses independently instead of a whole slice moving together.
 *
 * Shapes agree off the gathered axis, so both sides flatten to outer-by-axis-by-inner and
 * only the axis extent differs between them.
 */
export function gatherKernel(spec: { dtype: ScalarDType; wg?: number }): {
  ir: KernelIR;
  key: string;
} {
  const wg = spec.wg ?? 256;
  const b = new KernelBuilder(`gather_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('src', vt(spec.dtype), 'read');
  b.buffer('idx', vt('i32'), 'read');
  b.buffer('out0', vt(spec.dtype), 'write');
  b.buffer('status', vt('u32'), 'readwrite');
  const n = b.param('n');
  const inner = b.param('inner');
  const axisSize = b.param('axisSize');
  const outAxis = b.param('outAxis');

  b.gridStride(n, (i) => {
    const span = b.letTemp(vt('u32'), E.mul(outAxis, inner), 'span');
    const outer = b.letTemp(vt('u32'), E.div(i, span), 'o');
    const rest = b.letTemp(vt('u32'), E.mod(i, span), 'rest');
    const offset = b.letTemp(vt('u32'), E.mod(rest, inner), 'off');
    const raw = b.letTemp(vt('i32'), E.load('idx', i), 'r');
    const wrapped = b.letTemp(
      vt('u32'),
      E.select(
        E.lt(raw, E.i32(0)),
        E.cast(vt('u32'), E.add(raw, E.cast(vt('i32'), axisSize))),
        E.cast(vt('u32'), raw),
      ),
      'ix',
    );
    b.if(
      E.lt(wrapped, axisSize),
      () => {
        const source = E.add(E.mul(E.add(E.mul(outer, axisSize), wrapped), inner), offset);
        b.store('out0', i, E.load('src', source));
      },
      () => {
        b.store('status', E.u32(0), E.add(wrapped, E.u32(1)));
      },
    );
  });

  return { ir: b.build(), key: specKey('gather', { dtype: spec.dtype, wg }) };
}

export function scatterAddKernel(spec: { dtype: ScalarDType; wg?: number }): {
  ir: KernelIR;
  key: string;
} {
  const wg = spec.wg ?? 256;
  const b = new KernelBuilder(`scatteradd_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('idx', vt('i32'), 'read');
  b.buffer('src', vt(spec.dtype), 'read');
  b.buffer('out0', vt(spec.dtype), 'readwrite');
  b.buffer('status', vt('u32'), 'readwrite');
  const n = b.param('n');
  const count = b.param('count');
  const inner = b.param('inner');
  const axisSize = b.param('axisSize');

  b.gridStride(n, (i) => {
    const span = b.letTemp(vt('u32'), E.mul(count, inner), 'span');
    const outer = b.letTemp(vt('u32'), E.div(i, span), 'o');
    const rest = b.letTemp(vt('u32'), E.mod(i, span), 'rest');
    const which = b.letTemp(vt('u32'), E.div(rest, inner), 'w');
    const offset = b.letTemp(vt('u32'), E.mod(rest, inner), 'off');
    const raw = b.letTemp(vt('i32'), E.load('idx', which), 'r');
    const wrapped = b.letTemp(
      vt('u32'),
      E.select(
        E.lt(raw, E.i32(0)),
        E.cast(vt('u32'), E.add(raw, E.cast(vt('i32'), axisSize))),
        E.cast(vt('u32'), raw),
      ),
      'ix',
    );
    b.if(
      E.lt(wrapped, axisSize),
      () => {
        const dst = E.add(
          E.mul(E.add(E.mul(outer, axisSize), wrapped), inner),
          offset,
        );
        b.atomicAdd('out0', dst, E.load('src', i));
      },
      () => {
        b.store('status', E.u32(0), E.add(wrapped, E.u32(1)));
      },
    );
  });

  return { ir: b.build(), key: specKey('scatteradd', { dtype: spec.dtype, wg }) };
}

/** Specialization of {@link optimizerKernel}. */
export interface OptimizerSpec {
  kind: 'sgd' | 'adam';
  dtype: ScalarDType;
  /** SGD only: maintain a velocity buffer. */
  momentum?: boolean;
  /** SGD only: look ahead along the velocity before stepping. */
  nesterov?: boolean;
  /** Adam only: decay the parameter directly rather than the gradient. */
  decoupled?: boolean;
  /** Apply weight decay at all. */
  weightDecay?: boolean;
  wg?: number;
}

/**
 * Fused optimizer update.
 *
 * A primitive rather than a composition so one launch covers the whole update
 * instead of a dozen elementwise kernels per parameter, which is most of an
 * optimizer's cost at small tensor sizes.
 *
 * Buffers are `param`, `grad`, then `velocity` (SGD with momentum) or `m` and `v`
 * (Adam). Parameters are `n`, `lr`, `decay`, and for Adam `beta1`, `beta2`,
 * `epsilon`, `corr1`, `corr2` — the bias corrections are computed on the host,
 * since they depend only on the step count.
 */
export function optimizerKernel(spec: OptimizerSpec): { ir: KernelIR; key: string } {
  const wg = spec.wg ?? 256;
  const compute = vt('f32');
  const name = [
    spec.kind,
    spec.dtype,
    spec.momentum ? 'mom' : 'plain',
    spec.weightDecay ? (spec.decoupled ? 'decoupled' : 'coupled') : 'nodecay',
  ].join('_');
  const b = new KernelBuilder(name, [wg, 1, 1]);
  b.buffer('param', vt(spec.dtype), 'readwrite');
  b.buffer('grad', vt(spec.dtype), 'read');
  if (spec.kind === 'sgd' && spec.momentum) b.buffer('velocity', vt(spec.dtype), 'readwrite');
  if (spec.kind === 'adam') {
    b.buffer('m', vt(spec.dtype), 'readwrite');
    b.buffer('v', vt(spec.dtype), 'readwrite');
  }
  const n = b.param('n');
  const lr = b.param('lr', 'f32');
  const decay = b.param('decay', 'f32');
  const momentum =
    spec.kind === 'sgd' && spec.momentum ? b.param('momentum', 'f32') : null;
  const beta1 = spec.kind === 'adam' ? b.param('beta1', 'f32') : null;
  const beta2 = spec.kind === 'adam' ? b.param('beta2', 'f32') : null;
  const epsilon = spec.kind === 'adam' ? b.param('epsilon', 'f32') : null;
  const corr1 = spec.kind === 'adam' ? b.param('corr1', 'f32') : null;
  const corr2 = spec.kind === 'adam' ? b.param('corr2', 'f32') : null;

  b.gridStride(n, (i) => {
    const p = b.letTemp(compute, E.cast(compute, E.load('param', i)), 'p');
    b.var('g', compute, E.cast(compute, E.load('grad', i)));
    b.var('base', compute, p);
    if (spec.weightDecay) {
      if (spec.decoupled) {
        // Decoupled: shrink the parameter outside the adaptive step, so decay
        // behaves the same for every parameter regardless of gradient scale.
        b.assign('base', E.sub(p, E.mul(p, E.mul(lr, decay))));
      } else {
        b.assign('g', E.add(E.var('g'), E.mul(p, decay)));
      }
    }

    if (spec.kind === 'sgd') {
      if (spec.momentum) {
        // Momentum, not weight decay. These are different coefficients that happened
        // to be interchangeable while nothing called this kernel.
        const velocity = b.letTemp(
          compute,
          E.add(
            E.mul(E.cast(compute, E.load('velocity', i)), momentum!),
            E.var('g'),
          ),
          'vel',
        );
        b.store('velocity', i, E.cast(vt(spec.dtype), velocity));
        // Nesterov steps along the gradient *plus* the look-ahead velocity, which is
        // what makes it anticipate the next position rather than the current one.
        const direction = spec.nesterov
          ? E.add(E.var('g'), E.mul(velocity, momentum!))
          : velocity;
        b.store(
          'param',
          i,
          E.cast(vt(spec.dtype), E.sub(E.var('base'), E.mul(direction, lr))),
        );
      } else {
        b.store(
          'param',
          i,
          E.cast(vt(spec.dtype), E.sub(E.var('base'), E.mul(E.var('g'), lr))),
        );
      }
      return;
    }

    const mNext = b.letTemp(
      compute,
      E.add(
        E.mul(E.cast(compute, E.load('m', i)), beta1!),
        E.mul(E.var('g'), E.sub(E.const(compute, 1), beta1!)),
      ),
      'mn',
    );
    const vNext = b.letTemp(
      compute,
      E.add(
        E.mul(E.cast(compute, E.load('v', i)), beta2!),
        E.mul(E.mul(E.var('g'), E.var('g')), E.sub(E.const(compute, 1), beta2!)),
      ),
      'vn',
    );
    b.store('m', i, E.cast(vt(spec.dtype), mNext));
    b.store('v', i, E.cast(vt(spec.dtype), vNext));
    const mHat = b.letTemp(compute, E.div(mNext, corr1!), 'mh');
    const vHat = b.letTemp(compute, E.div(vNext, corr2!), 'vh');
    const step = E.mul(E.div(mHat, E.add(E.call('sqrt', vHat), epsilon!)), lr);
    b.store('param', i, E.cast(vt(spec.dtype), E.sub(E.var('base'), step)));
  });

  return {
    ir: b.build(),
    key: specKey('optim', {
      kind: spec.kind,
      dtype: spec.dtype,
      momentum: spec.momentum ?? false,
      nesterov: spec.nesterov ?? false,
      decoupled: spec.decoupled ?? false,
      decay: spec.weightDecay ?? false,
      wg,
    }),
  };
}

/** Random distributions the sampler can produce. */
export type RandomKind = 'uniform' | 'normal' | 'bernoulli' | 'randint';

/**
 * Emit Philox4x32-10 into four `u32` registers.
 *
 * The same permutation the host implementation runs, so a value sampled on the GPU
 * equals the value the reference backend computes for the same position. That
 * equality is the whole reason the scheme is counter-based rather than sequential.
 *
 * @internal
 */
function philox(b: KernelBuilder, key0: Expr, key1: Expr, counter: Expr): Expr[] {
  const u32 = vt('u32');
  b.var('c0', u32, counter);
  b.var('c1', u32, E.u32(0));
  b.var('c2', u32, E.u32(0));
  b.var('c3', u32, E.u32(0));
  b.var('k0', u32, key0);
  b.var('k1', u32, key1);
  const M0 = E.u32(0xd2511f53);
  const M1 = E.u32(0xcd9e8d57);

  unroll(10, (round) => {
    // The high and low halves of each 32x32 product; `mulhi` is the one operator
    // in the IR that exists solely for this.
    const hi0 = b.letTemp(u32, E.bin('mulhi', E.var('c0'), M0), 'hi');
    const lo0 = b.letTemp(u32, E.mul(E.var('c0'), M0), 'lo');
    const hi1 = b.letTemp(u32, E.bin('mulhi', E.var('c2'), M1), 'hi');
    const lo1 = b.letTemp(u32, E.mul(E.var('c2'), M1), 'lo');
    const n0 = b.letTemp(u32, E.bin('xor', E.bin('xor', hi1, E.var('c1')), E.var('k0')), 'n');
    const n2 = b.letTemp(u32, E.bin('xor', E.bin('xor', hi0, E.var('c3')), E.var('k1')), 'n');
    b.assign('c0', n0);
    b.assign('c1', lo1);
    b.assign('c2', n2);
    b.assign('c3', lo0);
    if (round < 9) {
      b.assign('k0', E.add(E.var('k0'), E.u32(0x9e3779b9)));
      b.assign('k1', E.add(E.var('k1'), E.u32(0xbb67ae85)));
    }
  });
  return [E.var('c0'), E.var('c1'), E.var('c2'), E.var('c3')];
}

/** A `u32` word turned into a float in `[0, 1)`, matching the host derivation. */
function uniformFrom(word: Expr): Expr {
  return E.mul(
    E.cast(vt('f32'), E.bin('shr', word, E.u32(8))),
    E.const(vt('f32'), 2 ** -24),
  );
}

/**
 * Build a random sampler.
 *
 * Buffers are `out0`. Parameters are `n`, `keyLo`, `keyHi`, `counter`, and the
 * distribution's own — `low`/`high` for uniform and randint, `mean`/`stddev` for
 * normal, `p` for bernoulli.
 */
export function randomKernel(spec: {
  kind: RandomKind;
  dtype: ScalarDType;
  wg?: number;
}): { ir: KernelIR; key: string } {
  const wg = spec.wg ?? 256;
  const f32 = vt('f32');
  const b = new KernelBuilder(`random_${spec.kind}_${spec.dtype}`, [wg, 1, 1]);
  b.buffer('out0', vt(spec.dtype), 'write');
  const n = b.param('n');
  const keyLo = b.param('keyLo');
  const keyHi = b.param('keyHi');
  const counter = b.param('counter');
  const low = spec.kind === 'uniform' || spec.kind === 'randint' ? b.param('low', 'f32') : null;
  const high = spec.kind === 'uniform' || spec.kind === 'randint' ? b.param('high', 'f32') : null;
  const mean = spec.kind === 'normal' ? b.param('mean', 'f32') : null;
  const stddev = spec.kind === 'normal' ? b.param('stddev', 'f32') : null;
  const p = spec.kind === 'bernoulli' ? b.param('p', 'f32') : null;

  b.gridStride(n, (i) => {
    // Four elements come from each counter block, matching Philox's four outputs.
    const block = b.letTemp(vt('u32'), E.add(counter, E.bin('shr', i, E.u32(2))), 'blk');
    const lane = b.letTemp(vt('u32'), E.bin('and', i, E.u32(3)), 'lane');
    const words = philox(b, keyLo, keyHi, block);
    // Select this element's lane. A chain of selects rather than an indexed array,
    // since the IR has no register arrays by design.
    const word = b.letTemp(
      vt('u32'),
      E.select(
        E.eq(lane, E.u32(0)),
        words[0]!,
        E.select(
          E.eq(lane, E.u32(1)),
          words[1]!,
          E.select(E.eq(lane, E.u32(2)), words[2]!, words[3]!),
        ),
      ),
      'w',
    );

    let value: Expr;
    switch (spec.kind) {
      case 'uniform':
        value = E.add(low!, E.mul(uniformFrom(word), E.sub(high!, low!)));
        break;
      case 'bernoulli':
        value = E.select(
          E.lt(uniformFrom(word), p!),
          E.const(f32, 1),
          E.const(f32, 0),
        );
        break;
      case 'randint': {
        // Multiply-shift over the range: the high word of the 64-bit product is
        // uniform, with none of modulo's bias.
        const range = b.letTemp(vt('u32'), E.cast(vt('u32'), E.sub(high!, low!)), 'rng');
        const scaled = b.letTemp(vt('u32'), E.bin('mulhi', word, range), 'sc');
        value = E.add(low!, E.cast(f32, scaled));
        break;
      }
      case 'normal': {
        // Box-Muller over the lane's pair, nudged away from zero because log(0) is
        // negative infinity.
        const first = b.letTemp(
          f32,
          E.select(E.lt(lane, E.u32(2)), uniformFrom(words[0]!), uniformFrom(words[2]!)),
          'u1',
        );
        const second = b.letTemp(
          f32,
          E.select(E.lt(lane, E.u32(2)), uniformFrom(words[1]!), uniformFrom(words[3]!)),
          'u2',
        );
        const safe = b.letTemp(f32, E.max(first, E.const(f32, 2 ** -24)), 'u1s');
        const radius = b.letTemp(
          f32,
          E.call('sqrt', E.mul(E.const(f32, -2), E.call('log', safe))),
          'rad',
        );
        const angle = b.letTemp(f32, E.mul(E.const(f32, 2 * Math.PI), second), 'ang');
        const even = b.letTemp(vt('u32'), E.bin('and', lane, E.u32(1)), 'par');
        value = E.add(
          mean!,
          E.mul(
            E.select(
              E.eq(even, E.u32(0)),
              E.mul(radius, E.call('cos', angle)),
              E.mul(radius, E.call('sin', angle)),
            ),
            stddev!,
          ),
        );
        break;
      }
    }
    b.store('out0', i, E.cast(vt(spec.dtype), value));
  });

  return { ir: b.build(), key: specKey('random', { kind: spec.kind, dtype: spec.dtype, wg }) };
}

/** Workgroups a grid-stride kernel needs for an element count. */
export function linearGrid(count: number, wg = 256): [number, number, number] {
  return [Math.max(Math.ceil(count / wg), 1), 1, 1];
}
