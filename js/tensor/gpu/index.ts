/**
 * GPU backends for the tensor engine.
 *
 * One `DeviceBackend` implementation over a small driver abstraction, so the
 * operation-to-kernel mapping exists once for every GPU.
 *
 * ## Boundary
 *
 * Not a public `fino:*` builtin. The public surface is the
 * `fino:tensor/backend` contract these satisfy, plus the device names they
 * register under.
 *
 * @internal
 */
import type { BackendProvider, DeviceBackend } from '../backend.ts';
import { GpuBackend } from './backend.ts';
import { createCudaDriver, cudaDriverAvailable, cudaDriverReason } from './cuda-driver.ts';
import { createMetalDriver, metalDriverAvailable, metalDriverReason } from './metal-driver.ts';
import { createVulkanDriver, vulkanDriverAvailable, vulkanDriverReason } from './vulkan-driver.ts';

export type { DriverBuffer, DriverCaps, DriverKernel, GpuDriver } from './driver.ts';
export { GpuBackend } from './backend.ts';
export { createCudaDriver, cudaDriverAvailable, cudaDriverReason } from './cuda-driver.ts';
export { createMetalDriver, metalDriverAvailable, metalDriverReason } from './metal-driver.ts';
export { createVulkanDriver, vulkanDriverAvailable, vulkanDriverReason } from './vulkan-driver.ts';

/**
 * Metal provider.
 *
 * The highest priority, so `device('auto')` selects it when present: on an Apple
 * machine it is the only target that gives real GPU acceleration with no
 * translation layer.
 */
export const metalProvider: BackendProvider = {
  type: 'metal',
  priority: 300,
  async probe(): Promise<DeviceBackend[]> {
    return metalProvider.probeSync!();
  },
  probeSync(): DeviceBackend[] {
    if (!metalDriverAvailable()) return [];
    try {
      return [new GpuBackend(createMetalDriver())];
    } catch (cause) {
      probeFailures.metal = (cause as Error).message;
      return [];
    }
  },
};

/**
 * CUDA provider.
 *
 * Preferred over Vulkan on NVIDIA systems because it reaches the native compute
 * stack directly and leaves room for CUDA-specific capabilities such as tensor cores.
 */
export const cudaProvider: BackendProvider = {
  type: 'cuda',
  priority: 200,
  async probe(): Promise<DeviceBackend[]> {
    return cudaProvider.probeSync!();
  },
  probeSync(): DeviceBackend[] {
    if (!cudaDriverAvailable()) return [];
    try {
      return [new GpuBackend(createCudaDriver())];
    } catch {
      return [];
    }
  },
};

/**
 * Vulkan provider.
 *
 * Below Metal because on Apple hardware it reaches the same GPU through MoltenVK,
 * which is a translation layer this design avoids shipping. It is the breadth
 * target everywhere else, and above the CPU reference either way.
 */
export const vulkanProvider: BackendProvider = {
  type: 'vulkan',
  priority: 100,
  async probe(): Promise<DeviceBackend[]> {
    return vulkanProvider.probeSync!();
  },
  probeSync(): DeviceBackend[] {
    if (!vulkanDriverAvailable()) return [];
    try {
      return [new GpuBackend(createVulkanDriver())];
    } catch {
      return [];
    }
  },
};

/** Why a GPU is unavailable, for diagnostics. */
export function gpuUnavailableReasons(): Record<string, string | null> {
  return {
    metal: metalDriverReason(),
    cuda: cudaDriverReason(),
    vulkan: vulkanDriverReason(),
  };
}
