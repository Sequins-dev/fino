/**
 * Sampling, on whichever device the tensor lives on.
 *
 * The backend contract has always had a `random` primitive and every backend has
 * implemented it — the GPUs through a Philox kernel, the reference through
 * {@link sampleAt} — but nothing reached it, because no operation was registered under
 * the names it dispatches by. Initialisers drew on the host and uploaded the result,
 * which works and costs a round trip per parameter, and left the device path untested.
 *
 * Sampling is counter-based rather than stateful: an element's value is a pure function
 * of the key, the counter block, and the element's own index. Nothing accumulates, so
 * every element can be computed independently and in any order, which is what lets the
 * same stream come out of a sequential host loop and a parallel kernel alike. A
 * {@link Generator} hands out counter blocks; drawing the same block twice would repeat
 * values, so reserving is what advances it.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from '../dtype.ts';
import type { OpAttrs, RngOp } from '../backend.ts';
import { backendFor } from '../backend.ts';
import type { OpId } from './registry.ts';
import { registerOp } from './registry.ts';
import { dispatchInto } from '../dispatch.ts';
import type { Tensor } from '../tensor.ts';
import type { Generator } from '../generator.ts';
import { sampleAt } from '../generator.ts';
import { emptyTensor } from './movement.ts';
import { numel } from '../shape.ts';

/** Registered sampling operations, by kind. */
export const RNG: Partial<Record<RngOp, OpId>> = {};

/** Every kind the contract names. */
const KINDS: readonly RngOp[] = ['uniform', 'normal', 'bernoulli', 'randint'];

for (const kind of KINDS) {
  RNG[kind] = registerOp({
    name: kind,
    group: 'creation',
    arity: 0,
    dtypeRule: (_inputs, attrs) => attrs!.dtype as DType,
    shapeRule: (_inputs, attrs) => attrs!.shape as readonly number[],
    enqueue: (backend, _inputs, out, attrs, stream) =>
      backend.random(
        kind,
        out,
        {
          key: [attrs!.keyLo as number, attrs!.keyHi as number],
          counter: attrs!.counter as number,
        },
        attrs,
        stream,
      ),
    // The oracle and the kernels share `sampleAt`'s definition of the stream rather
    // than each restating it, so a differential failure here means a kernel diverged
    // from the scheme rather than that two schemes disagree.
    refImpl: (_inputs, out, attrs) => {
      const key: readonly [number, number] = [
        attrs!.keyLo as number,
        attrs!.keyHi as number,
      ];
      const counter = attrs!.counter as number;
      for (let i = 0; i < out.size; i++) {
        out.set(i, sampleAt(kind, key, counter, i, attrs as Record<string, number>));
      }
    },
  });
}

/**
 * Draw a tensor of samples.
 *
 * @internal
 */
function sample(
  kind: RngOp,
  shape: readonly number[],
  dtype: DType,
  device: Parameters<typeof backendFor>[0],
  generator: Generator,
  attrs: OpAttrs,
): Tensor {
  const out = emptyTensor(shape, dtype, device);
  // Reserved before dispatch and never reused: two tensors drawn from one generator
  // have to come from different blocks, or they would hold identical values.
  const position = generator.reserve(numel(shape));
  return dispatchInto(RNG[kind]!, out, {
    ...attrs,
    shape,
    dtype,
    keyLo: position.key[0],
    keyHi: position.key[1],
    counter: position.counter,
  });
}

/** How a draw is specified. */
export interface SampleOptions {
  /** The stream to draw from; required, so a result is always reproducible. */
  generator: Generator;
  dtype?: DType;
  device?: Parameters<typeof backendFor>[0];
}

/** Uniform samples over `[low, high)`. */
export function rand(
  shape: readonly number[],
  options: SampleOptions & { low?: number; high?: number },
): Tensor {
  return sample(
    'uniform',
    shape,
    options.dtype ?? 'f32',
    options.device,
    options.generator,
    { low: options.low ?? 0, high: options.high ?? 1 },
  );
}

/** Normal samples. */
export function randn(
  shape: readonly number[],
  options: SampleOptions & { mean?: number; stddev?: number },
): Tensor {
  return sample('normal', shape, options.dtype ?? 'f32', options.device, options.generator, {
    mean: options.mean ?? 0,
    stddev: options.stddev ?? 1,
  });
}

/** Integers drawn uniformly from `[low, high)`. */
export function randint(
  shape: readonly number[],
  options: SampleOptions & { low?: number; high: number },
): Tensor {
  return sample('randint', shape, options.dtype ?? 'i32', options.device, options.generator, {
    low: options.low ?? 0,
    high: options.high,
  });
}

/** Ones with probability `p`, zeros otherwise. */
export function bernoulli(
  shape: readonly number[],
  options: SampleOptions & { p?: number },
): Tensor {
  return sample(
    'bernoulli',
    shape,
    options.dtype ?? 'f32',
    options.device,
    options.generator,
    { p: options.p ?? 0.5 },
  );
}
