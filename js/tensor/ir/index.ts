/**
 * Dialect-neutral kernel IR, its lowerings, and the template library.
 *
 * The engine compiles its own kernels rather than wrapping a vendor library, so
 * this module is the engine's substance rather than an optimization stage. One
 * implementation of each kernel's numerics lives in `templates/`; two lowerings
 * turn it into Metal Shading Language text or SPIR-V words.
 *
 * The two dialects exist together from the start on purpose. An IR designed
 * against one dialect is that dialect's IR wearing a neutral name, and the cost
 * of discovering that later is every template.
 *
 * ## Boundary
 *
 * Not a public `fino:*` builtin. Backends consume the lowerings and the
 * framework consumes the templates; the IR itself is an implementation detail of
 * how this engine compiles kernels, and it is expected to grow new node kinds as
 * kernels demand them.
 *
 * @internal
 */
export type {
  BinOp,
  BufferBinding,
  Builtin,
  Expr,
  KernelCaps,
  KernelIR,
  MathFn,
  ScalarDType,
  ScalarParam,
  SharedDecl,
  Stmt,
  UnOp,
  ValType,
  VecWidth,
} from './types.ts';
export {
  MAX_PARAM_BYTES,
  isFloatScalar,
  isSignedScalar,
  packParams,
  paramBytes,
  paramOffset,
  sameType,
  scalarBytes,
  typeKey,
  validateKernel,
  vt,
} from './types.ts';

export { E, KernelBuilder, unroll, unroll2 } from './builder.ts';
export { TypeEnv, checkExpr, typeOf } from './typing.ts';

export type { LayoutClass, OperandLayout } from './layout.ts';
export {
  broadcastShapes,
  broadcastStrides,
  classifyOperands,
  collapseAxes,
  contiguousStrides,
  layoutKey,
  numel,
} from './layout.ts';

export type { CacheKeyParts } from './key.ts';
export { IR_CODEGEN_VERSION, cacheKeyHash, cacheKeyText, fnv1a64, specKey } from './key.ts';

export type { MslOptions } from './lower/msl.ts';
export { lowerToMSL } from './lower/msl.ts';
export type { SpirvOptions } from './lower/spirv.ts';
export { lowerToSPIRV } from './lower/spirv.ts';

export type { EwContext, EwInput, EwSpec } from './templates/elementwise.ts';
export {
  BINARY,
  COMPARE,
  UNARY,
  binaryKernel,
  castKernel,
  computeTypeFor,
  ewKernel,
  inputsFromLayouts,
  isCompare,
  unaryKernel,
} from './templates/elementwise.ts';

export type { GemmSpec, GemmTiling } from './templates/gemm.ts';
export {
  DEFAULT_TILING,
  SMALL_TILING,
  gemmGrid,
  gemmIsExact,
  gemmKernel,
} from './templates/gemm.ts';

export type { LayerNormSpec, ReduceOp, ReduceSpec, SoftmaxSpec } from './templates/reduce.ts';
export {
  argReduceKernel,
  layerNormKernel,
  reduceKernel,
  rowGrid,
  softmaxKernel,
} from './templates/reduce.ts';

export type { OptimizerSpec, RandomKind } from './templates/structural.ts';
export {
  arangeKernel,
  fillKernel,
  indexSelectKernel,
  linearGrid,
  optimizerKernel,
  randomKernel,
  scatterAddKernel,
  stridedCopyKernel,
} from './templates/structural.ts';
