/**
 * Metal device and shared-buffer ownership, built on `internal:objc` and FFI.
 *
 * Each wrapper owns one native reference and supports idempotent disposal.
 * Closing a device prevents new allocations; existing buffers remain valid.
 * Each zero-copy view owns another buffer reference, released by Pointer.view
 * when V8 releases its backing store. Closing a buffer prevents new views but
 * leaves existing views usable. Dispose wrappers explicitly; view reclamation
 * follows V8 backing-store lifetime and can be delayed until GC.
 *
 * Shared storage does not synchronize CPU and GPU access. Callers must finish
 * GPU work before touching its bytes; command submission is a separate layer.
 * Views are ordinary ArrayBuffers, not SharedArrayBuffers: this does not expose
 * concurrent cross-Realm shared memory. Native wrappers belong to one Realm.
 *
 * References:
 * - [Metal buffers](https://developer.apple.com/documentation/metal/buffers)
 * - [Shared storage synchronization](https://developer.apple.com/documentation/metal/mtlstoragemode/shared)
 *
 * @internal
 */
import { Pointer } from 'fino:ffi';
import type { ObjectHandle } from 'internal:objc';
import { nativeMemoryApi } from './native.ts';

/** Immutable device properties used to choose storage and allocation sizes. */
export interface MetalDeviceInfo {
  readonly name: string;
  readonly unifiedMemory: boolean;
  readonly maxBufferLength: number;
}

/** Owned native compilation result; metadata is pipeline-specific. */
export interface CompiledMetalPipeline {
  readonly pointer: ObjectHandle;
  readonly threadExecutionWidth: number;
  readonly maxThreadsPerThreadgroup: number;
  close(): void;
}

/**
 * Native operations used by the ownership layer, injectable for lifecycle tests.
 * Create methods return owned references or null; contents returns a borrowed
 * pointer valid while its buffer lives. A native buffer keeps its device alive.
 */
export interface MetalMemoryApi {
  compile(device: ObjectHandle, source: string, entry: string): Promise<CompiledMetalPipeline>;
  createDevice(): ObjectHandle | null;
  info(device: ObjectHandle): MetalDeviceInfo;
  createBuffer(device: ObjectHandle, byteLength: number): ObjectHandle | null;
  contents(buffer: ObjectHandle): ArrayBuffer | null;
  retain(object: ObjectHandle): ObjectHandle;
  release(object: ObjectHandle): void;
}

/**
 * Open the default device, or return null on unsupported platforms/no device.
 * Unexpected framework and metadata errors propagate after releasing owned state.
 * The optional adapter implements the same native ownership contract for tests.
 */
export function openDevice(api: MetalMemoryApi | null = nativeMemoryApi()): MetalDevice | null {
  if (!api) return null;
  const handle = api.createDevice();
  if (!handle) return null;
  try {
    return new MetalDevice(api, handle, Object.freeze({ ...api.info(handle) }));
  } catch (error) {
    api.release(handle);
    throw error;
  }
}

/** Device owner. Construct through {@link openDevice}. */
class MetalDevice {
  #api: MetalMemoryApi;
  #handle: ObjectHandle | null;
  readonly info: MetalDeviceInfo;
  constructor(api: MetalMemoryApi, handle: ObjectHandle, info: MetalDeviceInfo) {
    this.#api = api;
    this.#handle = handle;
    this.info = info;
  }

  /**
   * Compile MSL 3.0 with fast math disabled, without blocking the Realm loop.
   * Closing this device while compilation is pending discards the resulting
   * pipeline and rejects after native completion; it does not cancel Metal work.
   */
  async compile(source: string, entry: string): Promise<MetalPipeline> {
    if (!this.#handle) throw new Error('Metal device is closed');
    if (typeof source !== 'string' || typeof entry !== 'string' || !entry || entry.includes('\0')) {
      throw new TypeError(
        'Metal compilation requires source text and a non-empty entry name without NUL',
      );
    }
    const result = await this.#api.compile(this.#handle, source, entry);
    if (!this.#handle) {
      result.close();
      throw new Error('Metal device closed during compilation');
    }
    return new MetalPipeline(result, entry);
  }

  /** Allocate shared storage. Zero logical bytes use a one-byte native allocation. */
  allocate(byteLength: number): MetalBuffer {
    if (!this.#handle) throw new Error('Metal device is closed');
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > this.info.maxBufferLength
    ) {
      throw new RangeError(
        'Metal buffer length must be a non-negative safe integer within the device limit',
      );
    }
    const handle = this.#api.createBuffer(this.#handle, Math.max(1, byteLength));
    if (!handle) throw new Error(`Metal buffer allocation failed for ${byteLength} bytes`);
    return new MetalBuffer(this.#api, handle, byteLength);
  }

  /** Release this device reference once; allocated buffers retain their native device. */
  close(): void {
    const handle = this.#handle;
    this.#handle = null;
    if (handle) this.#api.release(handle);
  }
  /** Dispose this device owner. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** Shared allocation owner. Obtain through {@link MetalDevice.allocate}. */
class MetalBuffer {
  #api: MetalMemoryApi;
  #handle: ObjectHandle | null;
  readonly byteLength: number;
  constructor(api: MetalMemoryApi, handle: ObjectHandle, byteLength: number) {
    this.#api = api;
    this.#handle = handle;
    this.byteLength = byteLength;
  }

  /**
   * Alias the allocation without copying. Each returned view has an independent
   * lifetime; closing the wrapper does not invalidate it. An empty view owns no
   * native reference. Ordinary structured cloning copies the bytes.
   */
  view(): ArrayBuffer {
    if (!this.#handle) throw new Error('Metal buffer is closed');
    if (this.byteLength === 0) return new ArrayBuffer(0);
    const api = this.#api;
    const contents = api.contents(this.#handle);
    if (contents == null) throw new Error('Metal buffer contents are unavailable');
    const owned = api.retain(this.#handle);
    try {
      return Pointer.view(contents, this.byteLength, { onRelease: () => api.release(owned) });
    } catch (error) {
      api.release(owned);
      throw error;
    }
  }

  /** Release the wrapper's reference once; existing views keep their own references. */
  close(): void {
    const handle = this.#handle;
    this.#handle = null;
    if (handle) this.#api.release(handle);
  }
  /** Dispose this buffer owner. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** Owned compiled pipeline. Obtain from the device that will submit it. */
class MetalPipeline {
  #owned: CompiledMetalPipeline | null;
  readonly entry: string;
  readonly threadExecutionWidth: number;
  readonly maxThreadsPerThreadgroup: number;
  constructor(owned: CompiledMetalPipeline, entry: string) {
    this.#owned = owned;
    this.entry = entry;
    this.threadExecutionWidth = owned.threadExecutionWidth;
    this.maxThreadsPerThreadgroup = owned.maxThreadsPerThreadgroup;
  }
  /** Release once. Native execution is not part of this layer yet. */
  close(): void {
    const owned = this.#owned;
    this.#owned = null;
    owned?.close();
  }
  /** Dispose this pipeline owner. */
  [Symbol.dispose](): void {
    this.close();
  }
}
