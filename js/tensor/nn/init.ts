/**
 * Parameter initialisers.
 *
 * Every initialiser draws from an explicit {@link Generator}, so a model's
 * starting point is reproducible from a single seed rather than from whatever the
 * platform's random source happened to produce.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/nn`; import from there.
 */
import type { DType } from '../dtype.ts';
import type { Device } from '../backend.ts';
import type { Tensor } from '../tensor.ts';
import type { Generator } from '../generator.ts';

/** Where and how to allocate an initialised parameter. */
export interface InitOptions {
  dtype?: DType;
  device?: Device;
}

/**
 * Hooks installed by the `fino:tensor/nn` barrel, avoiding an import cycle.
 *
 * @internal
 */
let hooks: {
  fromValues(
    values: readonly number[],
    shape: readonly number[],
    dtype: DType,
    device: Device,
  ): Tensor;
  fillOf(shape: readonly number[], dtype: DType, device: Device, value: number): Tensor;
  defaultDevice(): Device;
} | null = null;

/** Install the operations the initialisers need. */
export function installInitHooks(value: NonNullable<typeof hooks>): void {
  hooks = value;
}

/**
 * @internal
 */
function need(): NonNullable<typeof hooks> {
  if (!hooks) throw new Error('initialiser hooks are not installed');
  return hooks;
}

/**
 * @internal
 */
function target(options: InitOptions): { dtype: DType; device: Device } {
  return {
    dtype: options.dtype ?? 'f32',
    device: options.device ?? need().defaultDevice(),
  };
}

/**
 * @internal
 */
function count(shape: readonly number[]): number {
  return shape.reduce((a, b) => a * b, 1);
}

/** All zeros. */
export function zeros(shape: readonly number[], options: InitOptions = {}): Tensor {
  const { dtype, device } = target(options);
  return need().fillOf(shape, dtype, device, 0);
}

/** All ones. */
export function ones(shape: readonly number[], options: InitOptions = {}): Tensor {
  const { dtype, device } = target(options);
  return need().fillOf(shape, dtype, device, 1);
}

/** A constant. */
export function constant(
  shape: readonly number[],
  value: number,
  options: InitOptions = {},
): Tensor {
  const { dtype, device } = target(options);
  return need().fillOf(shape, dtype, device, value);
}

/** Uniform over `[low, high)`. */
export function uniform(
  shape: readonly number[],
  low: number,
  high: number,
  generator: Generator,
  options: InitOptions = {},
): Tensor {
  const { dtype, device } = target(options);
  return need().fromValues(generator.uniform(count(shape), low, high), shape, dtype, device);
}

/** Normal with the given mean and standard deviation. */
export function normal(
  shape: readonly number[],
  mean: number,
  stddev: number,
  generator: Generator,
  options: InitOptions = {},
): Tensor {
  const { dtype, device } = target(options);
  return need().fromValues(generator.normal(count(shape), mean, stddev), shape, dtype, device);
}

/**
 * Xavier (Glorot) uniform.
 *
 * Scales the range by both fan-in and fan-out, which keeps activation variance
 * stable through a network of `tanh`-like activations.
 */
export function xavierUniform(
  shape: readonly number[],
  fanIn: number,
  fanOut: number,
  generator: Generator,
  options: InitOptions = {},
): Tensor {
  const bound = Math.sqrt(6 / (fanIn + fanOut));
  return uniform(shape, -bound, bound, generator, options);
}

/**
 * Kaiming (He) uniform, the default for a `Linear` weight.
 *
 * Scales by fan-in only, which is the right choice for rectified activations
 * because half the units are expected to be inactive.
 */
export function kaimingUniform(
  shape: readonly number[],
  fanIn: number,
  generator: Generator,
  options: InitOptions = {},
): Tensor {
  const bound = Math.sqrt(6 / fanIn);
  return uniform(shape, -bound, bound, generator, options);
}

/** Kaiming (He) normal. */
export function kaimingNormal(
  shape: readonly number[],
  fanIn: number,
  generator: Generator,
  options: InitOptions = {},
): Tensor {
  return normal(shape, 0, Math.sqrt(2 / fanIn), generator, options);
}
