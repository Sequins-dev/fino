/**
 * Metal object plumbing.
 *
 * Wraps the Objective-C message sends behind a plain interface so backend logic
 * can be tested against a fake, and so the autorelease discipline lives in one
 * place rather than at every call site.
 *
 * Sync-versus-async follows the rule the HTTP/2 bindings set out
 * (`js/internal/net/http/h2/bindings.ts`): command encoding stays synchronous on
 * the JS thread, because a command buffer is not thread-safe and the calls only
 * move handles around. Only the two genuinely blocking operations — shader
 * compilation and waiting on a fence — go to the blocking pool.
 *
 * @internal
 *
 * This module is re-exported through `internal:metal`; import from there.
 */
import { Pointer, dlopen } from 'fino:ffi';
import type { Id } from './objc.ts';
import {
  MTLSize,
  cstring,
  errorSlot,
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
} from './objc.ts';

/** Where the Metal framework lives. */
const METAL_FRAMEWORK = '/System/Library/Frameworks/Metal.framework/Metal';

/** `MTLResourceStorageModeShared`: host and device see the same memory. */
const STORAGE_MODE_SHARED = 0n;

/** `MTLGPUFamilyApple7`, the first family with the simdgroup features worth using. */
const GPU_FAMILY_APPLE7 = 1007n;

/** Raised when Metal is present but a call fails. */
export class MetalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetalError';
  }
}

/** Raised when Metal itself is unavailable. */
export class MetalUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Metal is unavailable: ${reason}. The Metal backend requires macOS on Apple Silicon.`,
    );
    this.name = 'MetalUnavailableError';
  }
}

/**
 * @internal
 */
function openFramework() {
  return dlopen(METAL_FRAMEWORK, {
    MTLCreateSystemDefaultDevice: { parameters: [], result: 'pointer' },
  });
}

/**
 * Memoized framework handle.
 *
 * @internal
 */
let frameworkState: { lib: ReturnType<typeof openFramework> } | { error: string } | null = null;

/**
 * @internal
 */
function framework(): ReturnType<typeof openFramework> | null {
  if (frameworkState === null) {
    try {
      frameworkState = { lib: openFramework() };
    } catch (cause) {
      frameworkState = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return 'lib' in frameworkState ? frameworkState.lib : null;
}

/**
 * Build an `MTLSize` from three lengths.
 *
 * The fields are written through a `DataView` rather than `StructType.set`, which
 * takes a JS number for a `u64` field and so cannot express the full range. These
 * values are small, but writing them directly keeps the encoding explicit.
 *
 * @internal
 */
function makeSize(dims: readonly [number, number, number]): ArrayBuffer {
  const buffer = MTLSize.alloc();
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(dims[0]), true);
  view.setBigUint64(8, BigInt(dims[1]), true);
  view.setBigUint64(16, BigInt(dims[2]), true);
  return buffer;
}

/** What a Metal device reports about itself. */
export interface MetalDeviceInfo {
  name: string;
  unifiedMemory: boolean;
  /** Whether simdgroup reductions are available. */
  simdgroups: boolean;
  maxThreadsPerThreadgroup: number;
}

/** A compiled and ready-to-dispatch kernel. */
export interface MetalPipeline {
  /** `MTLComputePipelineState`. */
  state: Id;
  /** Maximum threads the pipeline supports per threadgroup. */
  maxThreadsPerThreadgroup: number;
  /**
   * SIMD width for this pipeline.
   *
   * A property of the compiled pipeline rather than of the device: the compiler
   * chooses it per kernel, and `MTLDevice` has no such property at all.
   */
  threadExecutionWidth: number;
}

/**
 * The Metal operations the backend needs.
 *
 * An interface rather than a module of functions so backend logic can run against
 * a fake on a machine without a GPU.
 */
export interface MetalApi {
  deviceInfo(device: Id): MetalDeviceInfo;
  createDevice(): Id;
  createQueue(device: Id): Id;
  createBuffer(device: Id, bytes: number): Id;
  bufferContents(buffer: Id, bytes: number): ArrayBuffer;
  compileLibrary(device: Id, source: string): Promise<Id>;
  createPipeline(device: Id, library: Id, entry: string): MetalPipeline;
  createSharedEvent(device: Id): Id;
  /**
   * Encode and commit one dispatch.
   *
   * Signals `event` with `signalValue` when the work completes, which is what a
   * readback waits on.
   */
  dispatch(options: {
    queue: Id;
    pipeline: MetalPipeline;
    buffers: readonly { buffer: Id; offset: number }[];
    params: ArrayBuffer | null;
    grid: readonly [number, number, number];
    threadgroup: readonly [number, number, number];
    event: Id;
    signalValue: bigint;
  }): void;
  /** Wait for an event to reach a value, on the blocking pool. */
  waitForEvent(event: Id, value: bigint, timeoutMs: number): Promise<boolean>;
  /** The value an event has reached. */
  eventValue(event: Id): bigint;
  destroy(object: Id): void;
}

/** Whether a Metal device can be created on this machine. */
export function metalAvailable(): boolean {
  if (!objcAvailable()) return false;
  const lib = framework();
  if (!lib) return false;
  try {
    const device = lib.symbols.MTLCreateSystemDefaultDevice() as Id | null;
    if (!device) return false;
    release(device);
    return true;
  } catch {
    return false;
  }
}

/** Why Metal is unavailable, or null when it is available. */
export function metalUnavailableReason(): string | null {
  if (!objcAvailable()) return 'the Objective-C runtime could not be loaded';
  if (!framework()) {
    const reason = frameworkState && 'error' in frameworkState ? frameworkState.error : 'unknown';
    return `the Metal framework could not be loaded (${reason})`;
  }
  if (!metalAvailable()) return 'no system default Metal device';
  return null;
}

/**
 * The real Metal implementation.
 */
export function createMetalApi(): MetalApi {
  const reason = metalUnavailableReason();
  if (reason) throw new MetalUnavailableError(reason);
  const lib = framework()!;

  return {
    createDevice(): Id {
      const device = lib.symbols.MTLCreateSystemDefaultDevice() as Id | null;
      if (!device) throw new MetalError('MTLCreateSystemDefaultDevice returned null');
      // Retained because it must outlive any autorelease pool.
      return retain(device);
    },

    deviceInfo(device: Id): MetalDeviceInfo {
      const pool = pushPool();
      try {
        const nameObject = send.ptr(device, sel('name')) as Id | null;
        return {
          name: nameObject ? readNSString(nameObject) : 'unknown',
          unifiedMemory: send.bool(device, sel('hasUnifiedMemory')) as boolean,
          simdgroups: send.boolI64(
            device,
            sel('supportsFamily:'),
            GPU_FAMILY_APPLE7,
          ) as boolean,
          // maxThreadsPerThreadgroup is an MTLSize, not a scalar; the width is
          // the limit a one-dimensional kernel cares about.
          maxThreadsPerThreadgroup: Number(
            new DataView(
              send.sizeRet(device, sel('maxThreadsPerThreadgroup')) as ArrayBuffer,
            ).getBigUint64(0, true),
          ),
        };
      } finally {
        popPool(pool);
      }
    },

    createQueue(device: Id): Id {
      const queue = send.ptr(device, sel('newCommandQueue')) as Id | null;
      if (!queue) throw new MetalError('newCommandQueue returned null');
      // `new…` methods return a retained object already.
      return queue;
    },

    createBuffer(device: Id, bytes: number): Id {
      const buffer = send.ptrU64U64(
        device,
        sel('newBufferWithLength:options:'),
        BigInt(Math.max(bytes, 1)),
        STORAGE_MODE_SHARED,
      ) as Id | null;
      if (!buffer) throw new MetalError(`newBufferWithLength: failed for ${bytes} bytes`);
      return buffer;
    },

    bufferContents(buffer: Id, bytes: number): ArrayBuffer {
      const contents = send.ptr(buffer, sel('contents')) as ArrayBuffer | null;
      if (!contents) throw new MetalError('MTLBuffer contents returned null');
      // Unified memory means this is the device's own storage: a genuine
      // zero-copy view rather than a staging buffer.
      return Pointer.view(contents, Math.max(bytes, 1));
    },

    async compileLibrary(device: Id, source: string): Promise<Id> {
      const pool = pushPool();
      try {
        const sourceString = nsString(source);
        const slot = errorSlot();
        // Compilation takes milliseconds to tens of milliseconds, so it goes to
        // the blocking pool rather than stalling the event loop.
        const library = (await send.ptrPtrPtrBufAsync(
          device,
          sel('newLibraryWithSource:options:error:'),
          sourceString,
          null,
          slot,
        )) as Id | null;
        const error = takeError(slot);
        if (!library) {
          throw new MetalError(`Metal shader compilation failed: ${error ?? 'unknown error'}`);
        }
        return library;
      } finally {
        popPool(pool);
      }
    },

    createPipeline(device: Id, library: Id, entry: string): MetalPipeline {
      const pool = pushPool();
      try {
        const fn = send.ptrPtr(library, sel('newFunctionWithName:'), nsString(entry)) as Id | null;
        if (!fn) throw new MetalError(`the compiled library has no function named '${entry}'`);
        const slot = errorSlot();
        const state = send.ptrPtrBuf(
          device,
          sel('newComputePipelineStateWithFunction:error:'),
          fn,
          slot,
        ) as Id | null;
        release(fn);
        const error = takeError(slot);
        if (!state) {
          throw new MetalError(
            `could not create a compute pipeline for '${entry}': ${error ?? 'unknown error'}`,
          );
        }
        return {
          state,
          maxThreadsPerThreadgroup: Number(
            send.u64(state, sel('maxTotalThreadsPerThreadgroup')) as bigint,
          ),
          threadExecutionWidth: Number(
            send.u64(state, sel('threadExecutionWidth')) as bigint,
          ),
        };
      } finally {
        popPool(pool);
      }
    },

    createSharedEvent(device: Id): Id {
      const event = send.ptr(device, sel('newSharedEvent')) as Id | null;
      if (!event) {
        throw new MetalError('newSharedEvent returned null');
      }
      return event;
    },

    dispatch(options): void {
      // The pool wraps command-buffer and encoder creation, both of which return
      // autoreleased objects. Metal retains a committed command buffer itself, so
      // popping the pool right after commit is safe.
      const pool = pushPool();
      try {
        const commandBuffer = send.ptr(options.queue, sel('commandBuffer')) as Id | null;
        if (!commandBuffer) throw new MetalError('commandBuffer returned null');
        const encoder = send.ptr(commandBuffer, sel('computeCommandEncoder')) as Id | null;
        if (!encoder) throw new MetalError('computeCommandEncoder returned null');

        send.voidPtr(encoder, sel('setComputePipelineState:'), options.pipeline.state);
        options.buffers.forEach((entry, index) => {
          send.voidPtrU64U64(
            encoder,
            sel('setBuffer:offset:atIndex:'),
            entry.buffer,
            BigInt(entry.offset),
            BigInt(index),
          );
        });
        if (options.params && options.params.byteLength > 0) {
          // Scalar parameters ride in the argument table rather than a buffer,
          // which is what `setBytes:` is for.
          send.voidBufU64U64(
            encoder,
            sel('setBytes:length:atIndex:'),
            new Uint8Array(options.params),
            BigInt(options.params.byteLength),
            BigInt(options.buffers.length),
          );
        }

        const grid = makeSize(options.grid);
        const group = makeSize(options.threadgroup);
        send.voidSizeSize(
          encoder,
          sel('dispatchThreadgroups:threadsPerThreadgroup:'),
          grid,
          group,
        );
        send.void(encoder, sel('endEncoding'));

        // Signalling from the command buffer, not the encoder, so the value lands
        // after every encoded pass in this submission.
        send.voidPtrU64(
          commandBuffer,
          sel('encodeSignalEvent:value:'),
          options.event,
          options.signalValue,
        );
        send.void(commandBuffer, sel('commit'));
      } finally {
        popPool(pool);
      }
    },

    async waitForEvent(event: Id, value: bigint, timeoutMs: number): Promise<boolean> {
      // Blocking-pool wait: the JS thread keeps serving the event loop, and the
      // promise resolves through the runtime's wake pipe.
      return (await send.boolU64U64Async(
        event,
        sel('waitUntilSignaledValue:timeoutMS:'),
        value,
        BigInt(timeoutMs),
      )) as boolean;
    },

    eventValue(event: Id): bigint {
      return send.u64(event, sel('signaledValue')) as bigint;
    },

    destroy(object: Id): void {
      release(object);
    },
  };
}

/** Re-exported so the backend can build C strings for diagnostics. */
export { cstring };
