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
import { createMetalDriver, metalDriverAvailable, metalDriverReason } from './metal-driver.ts';
import {
  createVulkanDriver,
  vulkanDriverAvailable,
  vulkanDriverReason,
} from './vulkan-driver.ts';

export type { DriverBuffer, DriverCaps, DriverKernel, GpuDriver } from './driver.ts';
export { GpuBackend } from './backend.ts';
export { createMetalDriver, metalDriverAvailable, metalDriverReason } from './metal-driver.ts';
export {
  createVulkanDriver,
  vulkanDriverAvailable,
  vulkanDriverReason,
} from './vulkan-driver.ts';

/**
 * Metal provider.
 *
 * Priority is deliberately *below* the reference backend, so `device('auto')` does
 * not select a GPU yet. The GPU path does not cover the whole contract — batched
 * matmul, softmax over a non-final axis, and index bounds checking are all still
 * CPU-only — and silently moving every program onto a backend with known gaps is
 * worse than requiring `device('metal')` to opt in.
 *
 * Raising this above the CPU's 0 is the single change that makes the GPU the
 * default, and it should happen when the differential suite covers the full
 * primitive set rather than most of it.
 */
export const metalProvider: BackendProvider = {
  type: 'metal',
  priority: -100,
  async probe(): Promise<DeviceBackend[]> {
    if (!metalDriverAvailable()) return [];
    try {
      return [new GpuBackend(createMetalDriver())];
    } catch {
      // A device that cannot be initialised is simply absent.
      return [];
    }
  },
};

/**
 * Vulkan provider.
 *
 * Below Metal because on Apple hardware it reaches the same GPU through MoltenVK,
 * which is a translation layer this design avoids shipping. It is the breadth
 * target elsewhere. Opt-in for the same reason as Metal.
 */
export const vulkanProvider: BackendProvider = {
  type: 'vulkan',
  priority: -200,
  async probe(): Promise<DeviceBackend[]> {
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
    vulkan: vulkanDriverReason(),
  };
}
