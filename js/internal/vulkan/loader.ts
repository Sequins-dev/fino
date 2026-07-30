/**
 * Vulkan loader binding.
 *
 * The core Vulkan commands are exported symbols of the loader library, so
 * `dlopen` reaches them by name. Extension entry points are not — those come from
 * `vkGetInstanceProcAddr`, which is what `ffiFunction` exists for.
 *
 * Every `vkCmd*` and every create call stays synchronous on the JS thread: they
 * only move handles into driver state, and a command buffer is not thread-safe.
 * `vkWaitSemaphores` and `vkWaitForFences` are the only blocking calls, and they
 * go to the blocking pool so the event loop keeps running.
 *
 * @internal
 *
 * This module is re-exported through `internal:vulkan`; import from there.
 */
import { env } from 'internal:process';
import { dlopen } from 'fino:ffi';

/**
 * Where the loader might live.
 *
 * On macOS this is normally the Vulkan SDK's loader in front of MoltenVK; on
 * Linux it is the system loader. `FINO_VULKAN_LIBRARY` overrides the search.
 */
const CANDIDATES: readonly string[] = [
  'libvulkan.1.dylib',
  '/usr/local/lib/libvulkan.1.dylib',
  '/opt/homebrew/lib/libvulkan.1.dylib',
  'libvulkan.so.1',
  '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
  '/usr/lib/aarch64-linux-gnu/libvulkan.so.1',
  '/usr/lib/libvulkan.so.1',
];

/** Raised when a Vulkan call reports failure. */
export class VulkanError extends Error {
  readonly result: number;

  constructor(call: string, result: number) {
    super(`${call} failed with VkResult ${result} (${resultName(result)})`);
    this.name = 'VulkanError';
    this.result = result;
  }
}

/** Raised when the loader itself is unavailable. */
export class VulkanUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Vulkan is unavailable: ${reason}. Install a Vulkan loader (the LunarG SDK on macOS, or a distribution's libvulkan package).`,
    );
    this.name = 'VulkanUnavailableError';
  }
}

/**
 * Names for the result codes worth recognising.
 *
 * @internal
 */
function resultName(result: number): string {
  switch (result) {
    case 0:
      return 'VK_SUCCESS';
    case 1:
      return 'VK_NOT_READY';
    case 2:
      return 'VK_TIMEOUT';
    case -1:
      return 'VK_ERROR_OUT_OF_HOST_MEMORY';
    case -2:
      return 'VK_ERROR_OUT_OF_DEVICE_MEMORY';
    case -3:
      return 'VK_ERROR_INITIALIZATION_FAILED';
    case -4:
      return 'VK_ERROR_DEVICE_LOST';
    case -7:
      return 'VK_ERROR_EXTENSION_NOT_PRESENT';
    case -8:
      return 'VK_ERROR_FEATURE_NOT_PRESENT';
    case -9:
      return 'VK_ERROR_INCOMPATIBLE_DRIVER';
    case -1000069000:
      return 'VK_ERROR_OUT_OF_POOL_MEMORY';
    default:
      return 'unrecognised';
  }
}

/**
 * The core symbol table.
 *
 * Handles are typed by dispatchability: `VkInstance`, `VkDevice`, `VkQueue`, and
 * `VkCommandBuffer` are dispatchable and therefore real pointers, while everything
 * else is a 64-bit handle that must be carried as a `u64` rather than a `usize`,
 * which would lose precision above 2^53.
 *
 * @internal
 */
const SYMBOLS = {
  vkCreateInstance: { parameters: ['buffer', 'pointer', 'buffer'], result: 'i32' },
  vkDestroyInstance: { parameters: ['pointer', 'pointer'], result: 'void' },
  vkEnumerateInstanceExtensionProperties: {
    parameters: ['pointer', 'buffer', 'buffer'],
    result: 'i32',
  },
  vkEnumeratePhysicalDevices: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  vkGetPhysicalDeviceQueueFamilyProperties: {
    parameters: ['pointer', 'buffer', 'buffer'],
    result: 'void',
  },
  vkGetPhysicalDeviceMemoryProperties: { parameters: ['pointer', 'buffer'], result: 'void' },
  vkEnumerateDeviceExtensionProperties: {
    parameters: ['pointer', 'pointer', 'buffer', 'buffer'],
    result: 'i32',
  },
  vkCreateDevice: { parameters: ['pointer', 'buffer', 'pointer', 'buffer'], result: 'i32' },
  vkDestroyDevice: { parameters: ['pointer', 'pointer'], result: 'void' },
  vkGetDeviceQueue: { parameters: ['pointer', 'u32', 'u32', 'buffer'], result: 'void' },
  vkDeviceWaitIdle: { parameters: ['pointer'], result: 'i32', async: true },

  vkCreateBuffer: { parameters: ['pointer', 'buffer', 'pointer', 'buffer'], result: 'i32' },
  vkDestroyBuffer: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkGetBufferMemoryRequirements: {
    parameters: ['pointer', 'u64', 'buffer'],
    result: 'void',
  },
  vkAllocateMemory: { parameters: ['pointer', 'buffer', 'pointer', 'buffer'], result: 'i32' },
  vkFreeMemory: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkBindBufferMemory: { parameters: ['pointer', 'u64', 'u64', 'u64'], result: 'i32' },
  vkMapMemory: {
    parameters: ['pointer', 'u64', 'u64', 'u64', 'u32', 'buffer'],
    result: 'i32',
  },
  vkUnmapMemory: { parameters: ['pointer', 'u64'], result: 'void' },

  vkCreateShaderModule: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroyShaderModule: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkCreateDescriptorSetLayout: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroyDescriptorSetLayout: {
    parameters: ['pointer', 'u64', 'pointer'],
    result: 'void',
  },
  vkCreatePipelineLayout: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroyPipelineLayout: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkCreateComputePipelines: {
    parameters: ['pointer', 'u64', 'u32', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroyPipeline: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },

  vkCreateDescriptorPool: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroyDescriptorPool: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkResetDescriptorPool: { parameters: ['pointer', 'u64', 'u32'], result: 'i32' },
  vkAllocateDescriptorSets: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  vkUpdateDescriptorSets: {
    parameters: ['pointer', 'u32', 'buffer', 'u32', 'pointer'],
    result: 'void',
  },

  vkCreateCommandPool: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroyCommandPool: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkResetCommandPool: { parameters: ['pointer', 'u64', 'u32'], result: 'i32' },
  vkAllocateCommandBuffers: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  vkFreeCommandBuffers: {
    parameters: ['pointer', 'u64', 'u32', 'buffer'],
    result: 'void',
  },
  vkBeginCommandBuffer: { parameters: ['pointer', 'buffer'], result: 'i32' },
  vkEndCommandBuffer: { parameters: ['pointer'], result: 'i32' },
  vkCmdBindPipeline: { parameters: ['pointer', 'u32', 'u64'], result: 'void' },
  vkCmdBindDescriptorSets: {
    parameters: ['pointer', 'u32', 'u64', 'u32', 'u32', 'buffer', 'u32', 'pointer'],
    result: 'void',
  },
  vkCmdPushConstants: {
    parameters: ['pointer', 'u64', 'u32', 'u32', 'u32', 'buffer'],
    result: 'void',
  },
  vkCmdDispatch: { parameters: ['pointer', 'u32', 'u32', 'u32'], result: 'void' },
  vkCmdCopyBuffer: {
    parameters: ['pointer', 'u64', 'u64', 'u32', 'buffer'],
    result: 'void',
  },
  vkCmdPipelineBarrier: {
    parameters: [
      'pointer',
      'u32',
      'u32',
      'u32',
      'u32',
      // The memory barriers are passed as data, like every other struct array here;
      // `pointer` would hand the driver the address of the address.
      'buffer',
      'u32',
      'pointer',
      'u32',
      'pointer',
    ],
    result: 'void',
  },

  vkQueueSubmit: { parameters: ['pointer', 'u32', 'buffer', 'u64'], result: 'i32' },
  vkCreateFence: { parameters: ['pointer', 'buffer', 'pointer', 'buffer'], result: 'i32' },
  vkDestroyFence: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkResetFences: { parameters: ['pointer', 'u32', 'buffer'], result: 'i32' },
  vkGetFenceStatus: { parameters: ['pointer', 'u64'], result: 'i32' },
  // The two blocking waits: offloaded so the event loop keeps running.
  vkWaitForFences: {
    parameters: ['pointer', 'u32', 'buffer', 'u32', 'u64'],
    result: 'i32',
    async: true,
  },
  vkCreateSemaphore: {
    parameters: ['pointer', 'buffer', 'pointer', 'buffer'],
    result: 'i32',
  },
  vkDestroySemaphore: { parameters: ['pointer', 'u64', 'pointer'], result: 'void' },
  vkGetSemaphoreCounterValue: { parameters: ['pointer', 'u64', 'buffer'], result: 'i32' },
  vkWaitSemaphores: {
    parameters: ['pointer', 'buffer', 'u64'],
    result: 'i32',
    async: true,
  },
  vkGetInstanceProcAddr: { parameters: ['pointer', 'buffer'], result: 'pointer' },
} as const;

/** The bound loader. */
export type VulkanLibrary = ReturnType<typeof openLoader>;

/**
 * @internal
 */
function openLoader() {
  const override = env.FINO_VULKAN_LIBRARY;
  const paths = override ? [override, ...CANDIDATES] : CANDIDATES;
  const failures: string[] = [];
  for (const path of paths) {
    try {
      return dlopen(path, SYMBOLS as never);
    } catch (cause) {
      failures.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  throw new Error(`no Vulkan loader found. Tried:\n  ${failures.join('\n  ')}`);
}

/**
 * @internal
 */
let state: { lib: VulkanLibrary } | { error: string } | null = null;

/** Whether a Vulkan loader could be opened. */
export function vulkanAvailable(): boolean {
  return loaderOrNull() !== null;
}

/** Why Vulkan is unavailable, or null when it is available. */
export function vulkanUnavailableReason(): string | null {
  if (loaderOrNull()) return null;
  return state && 'error' in state ? state.error : 'unknown';
}

/**
 * @internal
 */
function loaderOrNull(): VulkanLibrary | null {
  if (state === null) {
    try {
      state = { lib: openLoader() };
    } catch (cause) {
      state = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return 'lib' in state ? state.lib : null;
}

/** The loader, throwing a descriptive error when it is unavailable. */
export function loader(): VulkanLibrary {
  const lib = loaderOrNull();
  if (!lib) throw new VulkanUnavailableError(vulkanUnavailableReason() ?? 'unknown');
  return lib;
}

/** Throw when a Vulkan call did not succeed. */
export function check(call: string, result: number): void {
  if (result !== 0) throw new VulkanError(call, result);
}
