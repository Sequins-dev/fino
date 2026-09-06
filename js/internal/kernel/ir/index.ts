/**
 * internal:kernel/ir — typed, structured kernels independent of tensor APIs and targets.
 *
 * Builders produce independent, structured-cloneable snapshots. Validation checks
 * lexical scopes, explicit conversions and memory access declarations. Hardware
 * limits, compilation, allocations and submission belong to later layers.
 * Workgroup barriers require uniform participation; validation does not prove
 * convergence, bounds safety, race freedom, or termination of arbitrary kernels.
 * @internal
 */
export * from './types.ts';
export { E, KernelBuilder, unroll, unroll2 } from './builder.ts';
export { TypeEnv, checkExpr, typeOf } from './typing.ts';
