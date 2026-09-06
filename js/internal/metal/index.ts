/**
 * Metal binding.
 *
 * Reaches Metal through the Objective-C runtime over `fino:ffi`, with no compiled
 * shim and no translation layer. Availability is probed lazily: importing this
 * module never throws, so a non-Apple platform can load the tensor engine and
 * simply not offer a Metal device.
 *
 * ## Boundary
 *
 * Not a public `fino:*` builtin. This is platform plumbing with no stable surface;
 * what is public is the `fino:tensor/backend` contract it satisfies.
 *
 * @internal
 */
export type { Id, Sel } from './objc.ts';
export {
  MTLSize,
  cstring,
  errorSlot,
  blockLiteral,
  nsArray,
  nsDictionary,
  nsNumber,
  nsString,
  objcAvailable,
  objcClass,
  popPool,
  pushPool,
  readNSString,
  release,
  retain,
  sel,
  send,
  takeError,
  withPool,
} from './objc.ts';
export type { MetalApi, MetalDeviceInfo, MetalPipeline } from './bindings.ts';
export {
  MetalError,
  MetalUnavailableError,
  createMetalApi,
  metalAvailable,
  metalUnavailableReason,
} from './bindings.ts';
