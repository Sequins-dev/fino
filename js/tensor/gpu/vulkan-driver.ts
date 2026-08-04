/**
 * Vulkan driver.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/gpu`; import from there.
 */
import { VulkanCompute, vulkanAvailable, vulkanUnavailableReason } from 'internal:vulkan';
import type { VkBuffer, VkExecutable, VkPipeline } from 'internal:vulkan';
import type { KernelIR } from '../ir/index.ts';
import { lowerToSPIRV } from '../ir/index.ts';
import type { DriverBuffer, DriverCaps, DriverKernel, GpuDriver } from './driver.ts';

/** A Vulkan buffer plus its persistent mapping. */
interface VulkanBuffer extends DriverBuffer {
  handle: VkBuffer;
}

/** A Vulkan pipeline. */
interface VulkanKernel extends DriverKernel {
  pipeline: VkPipeline;
}

/** Whether a Vulkan driver can be created. */
export function vulkanDriverAvailable(): boolean {
  if (!vulkanAvailable()) return false;
  try {
    const context = VulkanCompute.create();
    context.dispose();
    return true;
  } catch {
    return false;
  }
}

/** Why a Vulkan driver is unavailable, or null. */
export function vulkanDriverReason(): string | null {
  return vulkanUnavailableReason();
}

/** Create a Vulkan driver. */
export function createVulkanDriver(): GpuDriver {
  const context = VulkanCompute.create();
  const info = context.info;
  const shared = context.sharesMemory;

  const caps: DriverCaps = {
    type: 'vulkan',
    name: info.name,
    f16: info.storage16 && info.float16,
    // The device offering `VK_EXT_shader_atomic_float` is necessary and not sufficient.
    // MoltenVK offers it and is measurably worse for it: a scatter-add of 8192 rows into
    // 64 colliding ones takes 0.24ms through `OpAtomicFAddEXT` against 0.12ms through the
    // lowering's own compare-and-swap, reproducibly, computing the same numbers. Metal
    // has no float atomic to translate it to, so the extension buys an emulated loop with
    // a translation layer around it rather than an instruction.
    //
    // A driver that is not translating has an instruction to offer, and this is the
    // measurement that would decide it — on hardware that is not here. So the capability
    // is taken where the driver is native and declined where it is a portability layer,
    // which is the honest reading of what was actually measured.
    atomicFloat: info.atomicFloat && !info.portable,
    subgroups: false,
    // Not because the hardware lacks them — on this machine it is the same GPU Metal
    // reports true for — but because there is no cooperative-matrix lowering that
    // MoltenVK and lavapipe both accept, so no kernel using them can be compiled here.
    matrix: false,
    maxWorkgroup: info.maxWorkgroupInvocations,
  };

  /**
   * A host-visible buffer used to stage reads, grown as needed.
   *
   * Safe to share because a read waits for its own transfer before returning, so no
   * second read can be in flight against it.
   */
  let readStaging: VkBuffer | null = null;
  const stagingForRead = (bytes: number): VkBuffer => {
    if (readStaging && readStaging.bytes >= bytes) return readStaging;
    if (readStaging) context.destroyBuffer(readStaging);
    readStaging = context.createBuffer(Math.max(bytes, 4096), { hostVisible: true });
    return readStaging;
  };

  /**
   * Stage an upload through its own buffer, released once the transfer completes.
   *
   * A shared upload buffer would be wrong: `write` is synchronous and only *queues*
   * the transfer, so a second write would overwrite the bytes before the first copy
   * ran — the first buffer would silently receive the second's data. Uploads are
   * rare compared with kernel launches, so a buffer each is the right trade for
   * correctness. Batching them behind one arena is a later optimisation.
   */
  const stageUpload = (bytes: Uint8Array): { buffer: VkBuffer; done: () => void } => {
    const buffer = context.createBuffer(Math.max(bytes.byteLength, 4), {
      hostVisible: true,
    });
    new Uint8Array(buffer.mapped!).set(bytes, 0);
    return { buffer, done: () => context.destroyBuffer(buffer) };
  };

  return {
    caps,
    target: `spirv-1.3:${info.name}${caps.f16 ? '+f16' : ''}`,
    hostVisible: shared,

    alloc(bytes: number): DriverBuffer {
      // Device-local when the device does not share memory, so kernels get the fast
      // memory and transfers go through staging.
      const handle = context.createBuffer(Math.max(bytes, 4), { hostVisible: shared });
      const buffer: VulkanBuffer = {
        handle,
        byteLength: handle.bytes,
        host: handle.mapped,
      };
      return buffer;
    },

    allocHost(bytes: number): DriverBuffer {
      const handle = context.createBuffer(Math.max(bytes, 4), { hostVisible: true });
      const buffer: VulkanBuffer = {
        handle,
        byteLength: handle.bytes,
        host: handle.mapped,
      };
      return buffer;
    },

    free(buffer: DriverBuffer): void {
      context.destroyBuffer((buffer as VulkanBuffer).handle);
    },

    write(buffer: DriverBuffer, offset: number, bytes: Uint8Array): void {
      if (buffer.host) {
        new Uint8Array(buffer.host).set(bytes, offset);
        return;
      }
      // Staged: the bytes land in host-visible memory, then the device copies them
      // into its own.
      const stage = stageUpload(bytes);
      const token = context.copyBuffer(
        (buffer as VulkanBuffer).handle,
        offset,
        stage.buffer,
        0,
        bytes.byteLength,
      );
      // Released once the copy has run, not before.
      void context.waitFor(token).then(stage.done, stage.done);
    },

    async read(buffer: DriverBuffer, offset: number, length: number): Promise<Uint8Array> {
      if (buffer.host) {
        await context.waitFor(context.submitted);
        return new Uint8Array(buffer.host, offset, length).slice();
      }
      // Staged: copy out, wait for exactly that transfer, then read.
      const stage = stagingForRead(length);
      const token = context.copyBuffer(stage, 0, (buffer as VulkanBuffer).handle, offset, length);
      await context.waitFor(token);
      return new Uint8Array(stage.mapped!, 0, length).slice();
    },

    copy(
      dst: DriverBuffer,
      dstOffset: number,
      src: DriverBuffer,
      srcOffset: number,
      bytes: number,
    ): void {
      if (dst.host && src.host) {
        new Uint8Array(dst.host).set(new Uint8Array(src.host, srcOffset, bytes), dstOffset);
        return;
      }
      context.copyBuffer(
        (dst as VulkanBuffer).handle,
        dstOffset,
        (src as VulkanBuffer).handle,
        srcOffset,
        bytes,
      );
    },

    async compile(ir: KernelIR): Promise<DriverKernel> {
      const words = lowerToSPIRV(ir, {
        caps: { f16: caps.f16, atomicFloat: caps.atomicFloat, subgroups: caps.subgroups },
      });
      const pipeline = context.createPipeline(words, ir.name);
      const kernel: VulkanKernel = { entry: ir.name, workgroup: ir.wg, pipeline };
      return kernel;
    },

    release(kernel: DriverKernel): void {
      context.destroyPipeline((kernel as VulkanKernel).pipeline);
    },

    launch(
      kernel: DriverKernel,
      buffers: readonly DriverBuffer[],
      params: ArrayBuffer,
      groups: readonly [number, number, number],
    ): bigint {
      return context.dispatch({
        pipeline: (kernel as VulkanKernel).pipeline,
        buffers: buffers.map((b) => (b as VulkanBuffer).handle),
        params,
        groups,
      });
    },

    async wait(token: bigint): Promise<void> {
      if (token <= context.completed()) return;
      // `waitFor` submits anything still being recorded, so a token for an unsubmitted
      // dispatch resolves rather than hanging on a value nothing will signal.
      await context.waitFor(token);
    },

    canLaunch(): boolean {
      return context.reclaim();
    },

    submitted(): bigint {
      return context.submitted;
    },

    completed(): bigint {
      return context.completed();
    },

    captureBegin(): void {
      context.captureBegin();
    },
    captureEnd(): unknown {
      return context.captureEnd();
    },
    replay(executable: unknown): bigint {
      return context.replay(executable as VkExecutable);
    },
    destroyExecutable(executable: unknown): void {
      context.destroyExecutable(executable as VkExecutable);
    },
    dispose(): void {
      if (readStaging) context.destroyBuffer(readStaging);
      context.dispose();
    },
  };
}
