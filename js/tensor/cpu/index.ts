/**
 * `internal:tensor/cpu` — the CPU backend's accelerated paths.
 *
 * @internal
 *
 * Imported by `internal:tensor/ref`; not part of any public surface.
 */
export { blasAvailable, blasGemm, blasPath, blasUnavailableReason } from './blas.ts';
export type { BlasGemm } from './blas.ts';
