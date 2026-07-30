/**
 * Metal driver.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/gpu`; import from there.
 */
import { createMetalApi, metalAvailable, metalUnavailableReason } from 'internal:metal';
import type { MetalBatch, MetalApi, MetalPipeline, Id } from 'internal:metal';
import type { KernelIR } from '../ir/index.ts';
import { lowerToMSL } from '../ir/index.ts';
import type { DriverBuffer, DriverCaps, DriverKernel, GpuDriver } from './driver.ts';

/**
 * Dispatches encoded before a batch is committed regardless of synchronisation.
 *
 * Large enough that the per-batch cost is amortised to nothing, small enough that the
 * device is never waiting on the host to finish a long run of launches.
 */
const MAX_BATCH = 64;

/** A Metal buffer plus its host mapping. */
interface MetalBuffer extends DriverBuffer {
  handle: Id;
}

/** A Metal pipeline plus its shader library. */
interface MetalKernel extends DriverKernel {
  pipeline: MetalPipeline;
  library: Id;
}

/** Whether a Metal driver can be created. */
export function metalDriverAvailable(): boolean {
  return metalAvailable();
}

/** Why a Metal driver is unavailable, or null. */
export function metalDriverReason(): string | null {
  return metalUnavailableReason();
}

/** Create a Metal driver. */
export function createMetalDriver(): GpuDriver {
  const api: MetalApi = createMetalApi();
  const device = api.createDevice();
  const queue = api.createQueue(device);
  const event = api.createSharedEvent(device);
  const info = api.deviceInfo(device);
  let counter = 0n;

  /**
   * Dispatches encoded into the open command buffer, if there is one.
   *
   * Metal serialises dispatches within one compute encoder and inserts the barriers
   * between them, so batching does not change what any kernel sees — it only stops
   * paying for a command buffer, an encoder, a fence, and a commit per operation.
   */
  let batch: MetalBatch | null = null;
  let encoded = 0;

  /** Timeline value of the most recently committed batch. */
  let committed = 0n;

  /** Submit whatever is encoded. */
  function flush(): void {
    if (!batch) return;
    const open = batch;
    const value = counter;
    // Cleared first so a throwing commit cannot leave a released batch installed.
    batch = null;
    encoded = 0;
    api.commitBatch(open, event, value);
    committed = value;
  }

  const caps: DriverCaps = {
    type: 'metal',
    name: info.name,
    // Metal has native half precision, and simdgroup reductions on Apple7 and up.
    f16: true,
    atomicFloat: true,
    subgroups: info.simdgroups,
    maxWorkgroup: info.maxThreadsPerThreadgroup,
  };

  if (!info.unifiedMemory) {
    throw new Error(
      'the Metal driver currently requires unified memory; discrete Metal needs a staging path that is not implemented',
    );
  }

  const allocate = (bytes: number): DriverBuffer => {
    const size = Math.max(bytes, 4);
    const handle = api.createBuffer(device, size);
    const buffer: MetalBuffer = {
      handle,
      byteLength: size,
      host: api.bufferContents(handle, size),
    };
    return buffer;
  };

  return {
    caps,
    // The device name is part of the target so a compiled kernel is never reused
    // across machines with different GPUs.
    target: `msl-3.0:${info.name}`,
    // Apple Silicon shares memory, so every allocation is addressable from both
    // sides and a transfer never needs staging.
    hostVisible: true,

    alloc: allocate,
    allocHost: allocate,

    free(buffer: DriverBuffer): void {
      api.destroy((buffer as MetalBuffer).handle);
    },

    write(buffer: DriverBuffer, offset: number, bytes: Uint8Array): void {
      new Uint8Array(buffer.host!).set(bytes, offset);
    },

    async read(buffer: DriverBuffer, offset: number, length: number): Promise<Uint8Array> {
      // Shared storage, so the only requirement is that the GPU has finished.
      await this.wait(this.submitted());
      return new Uint8Array(buffer.host!, offset, length).slice();
    },

    copy(
      dst: DriverBuffer,
      dstOffset: number,
      src: DriverBuffer,
      srcOffset: number,
      bytes: number,
    ): void {
      new Uint8Array(dst.host!).set(new Uint8Array(src.host!, srcOffset, bytes), dstOffset);
    },

    async compile(ir: KernelIR): Promise<DriverKernel> {
      // Fast math is disabled explicitly: Metal enables it by default, and its
      // NaN and infinity relaxations would make results disagree with the
      // reference backend and with Vulkan.
      const source = lowerToMSL(ir, { fastMath: false });
      const library = await api.compileLibrary(device, source);
      const pipeline = api.createPipeline(device, library, ir.name);
      const kernel: MetalKernel = {
        entry: ir.name,
        workgroup: ir.wg,
        pipeline,
        library,
      };
      return kernel;
    },

    release(kernel: DriverKernel): void {
      const metal = kernel as MetalKernel;
      api.destroy(metal.pipeline.state);
      api.destroy(metal.library);
    },

    launch(
      kernel: DriverKernel,
      buffers: readonly DriverBuffer[],
      params: ArrayBuffer,
      groups: readonly [number, number, number],
    ): bigint {
      batch ??= api.beginBatch(queue);
      api.encode(batch, {
        pipeline: (kernel as MetalKernel).pipeline,
        buffers: buffers.map((b) => ({ buffer: (b as MetalBuffer).handle, offset: 0 })),
        params,
        grid: groups,
        threadgroup: kernel.workgroup,
      });
      encoded++;
      const signalValue = ++counter;
      // Committing on a bound rather than only at a synchronisation point keeps the
      // device busy during a long run of dispatches, instead of idle until whatever
      // forces the flush.
      if (encoded >= MAX_BATCH) flush();
      return signalValue;
    },

    async wait(token: bigint): Promise<void> {
      // Anything still encoded has to be submitted before it can be waited for; an
      // uncommitted command buffer will never signal.
      if (token > committed) flush();
      if (token <= api.eventValue(event)) return;
      const finished = await api.waitForEvent(event, token, 60_000);
      if (!finished) {
        throw new Error(`Metal work did not complete within 60s (waiting for ${token})`);
      }
    },

    canLaunch(): boolean {
      // Metal owns command-buffer lifetime itself, so there is nothing to reclaim.
      return true;
    },

    submitted(): bigint {
      return counter;
    },

    completed(): bigint {
      return api.eventValue(event);
    },

    dispose(): void {
      // Submit anything encoded rather than dropping a retained command buffer, and so
      // that a queue is not destroyed with work outstanding on it.
      flush();
      api.destroy(event);
      api.destroy(queue);
      api.destroy(device);
    },
  };
}
