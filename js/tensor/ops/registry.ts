/**
 * The operation registry.
 *
 * Every primitive is declared once, in one place, carrying everything the engine
 * needs to know about it: how it infers shape and dtype, how it reaches a
 * backend, how it differentiates, and how the reference implementation computes
 * it. Registering an operation without a reference kernel is a startup error, so
 * the correctness oracle is complete by construction rather than by diligence,
 * and the differential harness can enumerate coverage instead of trusting a list.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from '../dtype.ts';
import type { DeviceBackend, OpAttrs, OpKind, Stream, TensorDesc } from '../backend.ts';
import type { Tensor } from '../tensor.ts';

/** Dense integer identifying a registered operation. */
export type OpId = number;

/** Which family an operation belongs to, for diagnostics and harness grouping. */
export type OpGroup =
  | 'elementwise'
  | 'reduce'
  | 'gemm'
  | 'movement'
  | 'indexing'
  | 'creation'
  | 'random'
  | 'optimizer'
  | 'normalization';

/** A gradient rule. */
export interface VjpRule {
  /**
   * Tensors backward needs.
   *
   * Declared rather than inferred so the engine knows exactly what to retain and
   * can release it the moment backward consumes it. Saving the output instead of
   * an input is often cheaper — `relu` needs only its result — and that choice
   * belongs here.
   */
  saves(inputs: readonly Tensor[], output: Tensor): readonly Tensor[];
  /**
   * Cotangents for the inputs, in input order.
   *
   * Returns `null` for inputs that do not need one. `needs` says which inputs
   * actually require gradients, so a rule can skip work nobody will read.
   * Implemented with ordinary dispatched operations, which is what makes the
   * tape portable across every backend including the oracle.
   */
  backward(
    cotangent: Tensor,
    saved: readonly Tensor[],
    attrs: OpAttrs | null,
    needs: readonly boolean[],
  ): (Tensor | null)[];
}

/** A reference implementation, operating on host memory. */
export type RefKernel = (
  inputs: readonly RefAccessor[],
  output: RefAccessor,
  attrs: OpAttrs | null,
) => void;

/**
 * A tensor as a reference kernel sees it.
 *
 * Values are read and written as JS numbers — which are already f64 — so kernels
 * accumulate at full precision regardless of storage dtype, and `set` rounds
 * through the storage precision. That is what makes a chain of `f16` operations
 * behave like real half-precision arithmetic rather than `f32` arithmetic
 * reported as `f16`, which the accuracy tolerances depend on.
 */
export interface RefAccessor {
  readonly dtype: DType;
  readonly shape: readonly number[];
  /** Element count. */
  readonly size: number;
  /** Read by flat index over the logical shape, honouring strides. */
  get(index: number): number;
  /** Write by flat index, rounding to the storage dtype. */
  set(index: number, value: number): void;
  /** Read by per-axis coordinates. */
  getAt(coords: readonly number[]): number;
  /** Write by per-axis coordinates. */
  setAt(coords: readonly number[], value: number): void;
}

/** One registered operation. */
export interface OpSpec {
  /** Stable public name, also the graph node kind. */
  name: OpKind;
  /** Dense id, assigned at registration. */
  id: OpId;
  group: OpGroup;
  /** Number of tensor inputs. */
  arity: number;
  /** Result dtype. */
  dtypeRule(inputs: readonly Tensor[], attrs: OpAttrs | null): DType;
  /** Result shape. */
  shapeRule(inputs: readonly Tensor[], attrs: OpAttrs | null): readonly number[];
  /** Enqueue the operation on a backend. */
  enqueue(
    backend: DeviceBackend,
    inputs: readonly TensorDesc[],
    output: TensorDesc,
    attrs: OpAttrs | null,
    stream: Stream,
  ): void;
  /** Gradient rule, or absent for a non-differentiable operation. */
  vjp?: VjpRule;
  /**
   * Equivalent composition, for backends that cannot run the primitive.
   *
   * `layerNorm` and `softmax` are primitives because accelerators want them
   * fused, but they are also ordinary compositions. Declaring both lets one
   * mechanism serve reference simplicity, GPU performance, and partitioning onto
   * fixed-function devices.
   */
  decompose?(inputs: readonly Tensor[], attrs: OpAttrs | null): Tensor;
  /** The reference implementation. Mandatory. */
  refImpl: RefKernel;
}

/**
 * Registered operations, indexed by id.
 *
 * @internal
 */
const specs: OpSpec[] = [];

/**
 * Name to id, for graph consumers that only have the node kind.
 *
 * @internal
 */
const byName = new Map<OpKind, OpId>();

/** Register an operation, returning its id. */
export function registerOp(spec: Omit<OpSpec, 'id'>): OpId {
  if (byName.has(spec.name)) {
    throw new Error(`operation '${spec.name}' is already registered`);
  }
  if (typeof spec.refImpl !== 'function') {
    throw new Error(
      `operation '${spec.name}' has no reference implementation; the oracle must cover every operation`,
    );
  }
  const id = specs.length;
  specs.push({ ...spec, id });
  byName.set(spec.name, id);
  return id;
}

/** Look up an operation by id. */
export function opById(id: OpId): OpSpec {
  const spec = specs[id];
  if (!spec) throw new Error(`no operation registered with id ${id}`);
  return spec;
}

/** Look up an operation by name. */
export function opByName(name: OpKind): OpSpec {
  const id = byName.get(name);
  if (id === undefined) throw new Error(`no operation named '${name}'`);
  return specs[id]!;
}

/** Whether an operation is registered. */
export function hasOp(name: OpKind): boolean {
  return byName.has(name);
}

/** Every registered operation, in registration order. */
export function allOps(): readonly OpSpec[] {
  return specs;
}

/** Registered operations that carry a gradient rule. */
export function differentiableOps(): readonly OpSpec[] {
  return specs.filter((s) => s.vjp !== undefined);
}
