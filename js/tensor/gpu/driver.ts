/**
 * The minimum a GPU needs to expose to back the tensor engine.
 *
 * Metal and Vulkan differ enormously in their APIs and not at all in what the
 * engine asks of them: allocate memory it can also see, compile a kernel from IR,
 * launch it, and tell it when the work is done. Naming that surface lets the
 * operation-to-kernel mapping be written once rather than twice, which matters
 * because that mapping is where the semantics live.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/gpu`; import from there.
 */
import type { KernelIR } from '../ir/index.ts';

/** A device allocation. */
export interface DriverBuffer {
  /** Bytes the allocation spans. */
  readonly byteLength: number;
  /**
   * Host view of the same memory, or `null` when the device cannot share it.
   *
   * Unified memory makes this the device's own storage, so a transfer is a memcpy.
   * A discrete GPU's device-local memory is not host-visible at all, so transfers
   * go through staging. Callers should not branch on this — use {@link
   * GpuDriver.write} and {@link GpuDriver.read}, which do the right thing either
   * way. It exists so a driver can take the fast path internally.
   */
  readonly host: ArrayBuffer | null;
}

/** A compiled kernel. */
export interface DriverKernel {
  readonly entry: string;
  /** Threads per workgroup the kernel was compiled for. */
  readonly workgroup: readonly [number, number, number];
}

/** What a driver can do, so the engine can report it and specialize kernels. */
export interface DriverCaps {
  /** Backend name, used as the device type. */
  type: string;
  /** Human-readable device name. */
  name: string;
  /** Whether 16-bit float storage is usable. */
  f16: boolean;
  /** Whether float atomics are native rather than emulated. */
  atomicFloat: boolean;
  /** Whether subgroup reductions are available. */
  subgroups: boolean;
  /** Largest workgroup the device accepts. */
  maxWorkgroup: number;
}

/**
 * One GPU, as the engine sees it.
 */
export interface GpuDriver {
  readonly caps: DriverCaps;
  /** Identity used in cache keys, so two drivers never share a compiled kernel. */
  readonly target: string;

  /** Whether {@link alloc} returns memory the host can address directly. */
  readonly hostVisible: boolean;

  /** Allocate device memory, host-visible or not as the device prefers. */
  alloc(bytes: number): DriverBuffer;
  /**
   * Allocate memory the host can always address.
   *
   * Used for staging and for the small buffers a kernel writes diagnostics into.
   * Host-visible memory is device-accessible everywhere, just slower, so this is
   * always available.
   */
  allocHost(bytes: number): DriverBuffer;
  /** Release an allocation. */
  free(buffer: DriverBuffer): void;

  /**
   * Copy host bytes into a buffer, ordered behind work already submitted.
   *
   * On unified memory this is a memcpy; on a discrete device it stages and records
   * a transfer.
   */
  write(buffer: DriverBuffer, offset: number, bytes: Uint8Array): void;
  /** Read bytes out of a buffer, once work already submitted has completed. */
  read(buffer: DriverBuffer, offset: number, length: number): Promise<Uint8Array>;
  /** Copy within the device, ordered behind work already submitted. */
  copy(
    dst: DriverBuffer,
    dstOffset: number,
    src: DriverBuffer,
    srcOffset: number,
    bytes: number,
  ): void;

  /** Compile a kernel from IR. */
  compile(ir: KernelIR): Promise<DriverKernel>;
  /** Release a compiled kernel. */
  release(kernel: DriverKernel): void;

  /**
   * Launch a kernel, returning a token that identifies its completion.
   *
   * Tokens are monotonically increasing, so a later token completing implies every
   * earlier one has. That is what lets the engine's events be plain integers.
   */
  launch(
    kernel: DriverKernel,
    buffers: readonly DriverBuffer[],
    params: ArrayBuffer,
    groups: readonly [number, number, number],
  ): bigint;

  /** Resolve once the device has completed `token`. */
  wait(token: bigint): Promise<void>;
  /** The most recently submitted token. */
  submitted(): bigint;
  /** The token the device has completed. */
  completed(): bigint;

  /** Release the device and everything on it. */
  dispose(): void;
}
