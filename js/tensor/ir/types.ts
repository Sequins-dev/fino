/**
 * Dialect-neutral kernel IR.
 *
 * The IR exists so one implementation of each kernel's numerics serves every
 * target. It is intentionally much smaller than a general compiler IR: it
 * expresses the kernels this engine actually ships and nothing more, and it
 * grows only when a new in-tree kernel needs it.
 *
 * ## Why structured, not SSA
 *
 * Kernel bodies are trees of structured statements over typed expression trees,
 * not a control-flow graph. This is load-bearing rather than a simplification:
 * SPIR-V requires structured control flow — every loop needs `OpLoopMerge` and
 * every conditional `OpSelectionMerge`, with strict rules about which blocks may
 * be merge or continue targets. A structured IR lowers one-to-one to legal
 * SPIR-V and trivially to MSL text. An arbitrary-CFG IR would make the SPIR-V
 * lowering the hard part of the engine.
 *
 * Single assignment still falls out where it matters: `let` bindings are
 * immutable, and loop-carried state uses explicit `var` declarations that lower
 * to function-storage variables.
 *
 * ## What is deliberately absent
 *
 * - **Arrays of registers.** GEMM register blocking is done by unrolling in the
 *   emitting template — plain TypeScript loops producing repeated statements —
 *   because dynamically indexed private arrays lower badly.
 * - **Pointer bit-casting.** Vector width is a property of a buffer binding, so
 *   a `f32x4` binding indexes in vec4 units. Reinterpreting a pointer is
 *   trivial in MSL and painful in SPIR-V, so the IR does not allow it;
 *   templates specialize on divisibility instead.
 * - **Dynamic workgroup or shared-memory sizes.** Both are baked into the
 *   kernel and are part of its specialization key, because SPIR-V wants
 *   `LocalSize` at module build time and has no dynamic shared memory.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */

/** Scalar element types the IR can compute with. */
export type ScalarDType = 'f32' | 'f16' | 'bf16' | 'i32' | 'u32' | 'u8' | 'bool';

/** Lanes per value. Vector width is fixed per binding, never cast. */
export type VecWidth = 1 | 2 | 4;

/** A value type: a scalar type plus a lane count. */
export interface ValType {
  scalar: ScalarDType;
  lanes: VecWidth;
}

/** Shorthand for a scalar value type. */
export function vt(scalar: ScalarDType, lanes: VecWidth = 1): ValType {
  return { scalar, lanes };
}

/** Whether two value types are identical. */
export function sameType(a: ValType, b: ValType): boolean {
  return a.scalar === b.scalar && a.lanes === b.lanes;
}

/** Render a value type as a stable key fragment, e.g. `f32x4`. */
export function typeKey(t: ValType): string {
  return t.lanes === 1 ? t.scalar : `${t.scalar}x${t.lanes}`;
}

/** Whether a scalar type is floating-point. */
export function isFloatScalar(s: ScalarDType): boolean {
  return s === 'f32' || s === 'f16' || s === 'bf16';
}

/** Whether a scalar type is a signed integer. */
export function isSignedScalar(s: ScalarDType): boolean {
  return s === 'i32';
}

/** Bytes occupied by one element of a scalar type in a buffer. */
export function scalarBytes(s: ScalarDType): number {
  switch (s) {
    case 'f32':
    case 'i32':
    case 'u32':
      return 4;
    case 'f16':
    case 'bf16':
      return 2;
    case 'u8':
    case 'bool':
      return 1;
  }
}

/** A buffer the kernel reads or writes. Binding index is its array position. */
export interface BufferBinding {
  /** Identifier used by `load`/`store` expressions. Unique within a kernel. */
  name: string;
  /** Element type as indexed. A `lanes > 1` binding indexes in vector units. */
  elem: ValType;
  /** Access pattern; drives `NonWritable`/`const` annotations. */
  access: 'read' | 'write' | 'readwrite';
}

/**
 * A scalar kernel parameter.
 *
 * All parameters share one flat block, laid out in declaration order with each
 * field at a 4-byte offset. The block is capped at 128 bytes because that is
 * Vulkan's guaranteed minimum push-constant size. There are no 64-bit fields:
 * sizes and strides pass as `u32`, which caps a single buffer at 4Gi elements.
 */
export interface ScalarParam {
  name: string;
  type: 'u32' | 'i32' | 'f32';
}

/** A workgroup-shared array. Length is static and part of the kernel identity. */
export interface SharedDecl {
  name: string;
  elem: ScalarDType;
  length: number;
}

/** Thread-index and subgroup built-ins. */
export type Builtin =
  | 'globalId'
  | 'localId'
  | 'groupId'
  | 'numGroups'
  /**
   * Total threads in the grid along a dimension.
   *
   * Derived, not native: MSL has `threads_per_grid` but SPIR-V does not, so the
   * SPIR-V lowering computes `NumWorkgroups * workgroupSize`. This asymmetry is
   * exactly the kind the dialect layer exists to absorb.
   */
  | 'globalSize'
  | 'subgroupSize'
  | 'subgroupId'
  | 'laneId';

/** Binary operators. Comparison operators yield `bool`. */
export type BinOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'min'
  | 'max'
  | 'and'
  | 'or'
  | 'xor'
  | 'shl'
  | 'shr'
  /** High word of an unsigned 32x32 product; needed by counter-based RNG. */
  | 'mulhi'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'logicalAnd'
  | 'logicalOr';

/** Unary operators. */
export type UnOp = 'neg' | 'not' | 'abs';

/** Math functions available in both dialects. */
export type MathFn =
  | 'exp'
  | 'log'
  | 'sqrt'
  | 'rsqrt'
  | 'tanh'
  | 'sin'
  | 'cos'
  | 'pow'
  | 'fma'
  | 'floor'
  | 'ceil'
  | 'round'
  | 'clamp';

/** An IR expression. */
export type Expr =
  | { k: 'const'; type: ValType; value: number }
  | { k: 'param'; name: string }
  | { k: 'builtin'; which: Builtin; dim: 0 | 1 | 2 }
  | { k: 'let'; name: string }
  | { k: 'var'; name: string }
  | { k: 'load'; buf: string; index: Expr }
  | { k: 'shload'; sh: string; index: Expr }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { k: 'un'; op: UnOp; a: Expr }
  | { k: 'call'; fn: MathFn; args: Expr[] }
  | { k: 'select'; cond: Expr; a: Expr; b: Expr }
  | { k: 'cast'; to: ValType; a: Expr }
  | { k: 'bitcast'; to: ValType; a: Expr }
  | { k: 'lane'; a: Expr; i: 0 | 1 | 2 | 3 }
  | { k: 'vec'; type: ValType; lanes: Expr[] }
  | { k: 'subgroup'; op: 'add' | 'min' | 'max'; a: Expr };

/** An IR statement. */
export type Stmt =
  | { k: 'let'; name: string; type: ValType; init: Expr }
  | { k: 'var'; name: string; type: ValType; init: Expr }
  | { k: 'assign'; name: string; value: Expr }
  | { k: 'store'; buf: string; index: Expr; value: Expr }
  | { k: 'shstore'; sh: string; index: Expr; value: Expr }
  | {
      k: 'for';
      v: string;
      init: Expr;
      limit: Expr;
      step: Expr;
      body: Stmt[];
    }
  | { k: 'if'; cond: Expr; then: Stmt[]; else?: Stmt[] }
  | { k: 'barrier' }
  | { k: 'atomicAdd'; buf: string; index: Expr; value: Expr }
  | { k: 'comment'; text: string };

/** Capabilities a kernel body requires of its target. */
export interface KernelCaps {
  /** Uses `subgroup` reductions. */
  subgroups?: boolean;
  /** Uses `atomicAdd` on a floating-point buffer. */
  atomicFloat?: boolean;
  /** Reads or writes 16-bit floats in a buffer. */
  f16?: boolean;
}

/** A complete kernel. */
export interface KernelIR {
  /** Entry-point symbol name. */
  name: string;
  /** Workgroup size, baked into the kernel. */
  wg: [number, number, number];
  /** Buffers, in binding order. */
  buffers: BufferBinding[];
  /** Scalar parameters, in layout order. */
  params: ScalarParam[];
  /** Workgroup-shared arrays. */
  shared: SharedDecl[];
  /** Kernel body. */
  body: Stmt[];
  /** Required target capabilities. */
  caps: KernelCaps;
}

/** Maximum bytes the scalar parameter block may occupy. */
export const MAX_PARAM_BYTES = 128;

/** Byte offset of a named scalar parameter within the parameter block. */
export function paramOffset(params: readonly ScalarParam[], name: string): number {
  const index = params.findIndex((p) => p.name === name);
  if (index < 0) throw new Error(`unknown kernel parameter '${name}'`);
  return index * 4;
}

/** Total bytes the scalar parameter block occupies. */
export function paramBytes(params: readonly ScalarParam[]): number {
  return params.length * 4;
}

/**
 * Pack scalar parameter values into the flat block a launch expects.
 *
 * Values are supplied by name so callers cannot silently depend on declaration
 * order.
 */
export function packParams(
  params: readonly ScalarParam[],
  values: Readonly<Record<string, number>>,
): ArrayBuffer {
  const bytes = paramBytes(params);
  if (bytes > MAX_PARAM_BYTES) {
    throw new Error(
      `kernel parameter block is ${bytes} bytes, over the ${MAX_PARAM_BYTES}-byte limit`,
    );
  }
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const value = values[p.name];
    if (value === undefined) throw new Error(`missing value for kernel parameter '${p.name}'`);
    if (p.type === 'f32') view.setFloat32(i * 4, value, true);
    else if (p.type === 'i32') view.setInt32(i * 4, value, true);
    else view.setUint32(i * 4, value, true);
  }
  return buf;
}

/**
 * Validate structural invariants a lowering relies on.
 *
 * Called by both lowerings so a malformed kernel fails with a clear message
 * rather than producing a shader that a driver rejects opaquely.
 */
export function validateKernel(ir: KernelIR): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ir.name)) {
    throw new Error(`kernel name '${ir.name}' is not a valid identifier`);
  }
  const [x, y, z] = ir.wg;
  if (x < 1 || y < 1 || z < 1) throw new Error(`kernel '${ir.name}' has an empty workgroup`);
  if (x * y * z > 1024) {
    throw new Error(`kernel '${ir.name}' workgroup of ${x * y * z} threads exceeds 1024`);
  }
  const names = new Set<string>();
  for (const b of ir.buffers) {
    if (names.has(b.name)) throw new Error(`duplicate binding name '${b.name}'`);
    names.add(b.name);
  }
  for (const p of ir.params) {
    if (names.has(p.name)) throw new Error(`parameter '${p.name}' collides with a binding`);
    names.add(p.name);
  }
  for (const s of ir.shared) {
    if (names.has(s.name)) throw new Error(`shared array '${s.name}' collides with a binding`);
    names.add(s.name);
    if (s.length < 1) throw new Error(`shared array '${s.name}' has zero length`);
  }
  const bytes = paramBytes(ir.params);
  if (bytes > MAX_PARAM_BYTES) {
    throw new Error(
      `kernel '${ir.name}' parameter block is ${bytes} bytes, over the ${MAX_PARAM_BYTES}-byte limit`,
    );
  }
}
