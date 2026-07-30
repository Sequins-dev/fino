/**
 * Vulkan driver.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/gpu`; import from there.
 */
import { VulkanCompute, vulkanAvailable, vulkanUnavailableReason } from 'internal:vulkan';
import type { VkBuffer, VkPipeline } from 'internal:vulkan';
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

  const caps: DriverCaps = {
    type: 'vulkan',
    name: info.name,
    f16: info.storage16 && info.float16,
    // Float atomics need an extension this binding does not yet enable, so the
    // SPIR-V lowering emits its compare-and-swap fallback instead.
    atomicFloat: false,
    subgroups: false,
    maxWorkgroup: info.maxWorkgroupInvocations,
  };

  if (!info.unifiedMemory) {
    throw new Error(
      'the Vulkan driver currently requires host-visible device memory; a discrete GPU needs a staging path that is not implemented',
    );
  }

  return {
    caps,
    target: `spirv-1.3:${info.name}${caps.f16 ? '+f16' : ''}`,

    alloc(bytes: number): DriverBuffer {
      const handle = context.createBuffer(Math.max(bytes, 4));
      const buffer: VulkanBuffer = {
        handle,
        byteLength: handle.bytes,
        host: handle.mapped!,
      };
      return buffer;
    },

    free(buffer: DriverBuffer): void {
      context.destroyBuffer((buffer as VulkanBuffer).handle);
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
      await context.waitFor(token);
    },

    submitted(): bigint {
      return context.submitted;
    },

    completed(): bigint {
      return context.completed();
    },

    dispose(): void {
      context.dispose();
    },
  };
}
