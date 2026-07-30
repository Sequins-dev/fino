/**
 * Vulkan binding.
 *
 * Drives Vulkan through `fino:ffi` with no interposed layer. Core commands are
 * exported symbols the loader resolves by name; extension entry points come from
 * `vkGetInstanceProcAddr` via `ffiFunction`.
 *
 * Availability is probed lazily, so importing this module on a machine with no
 * loader never throws — it simply reports no device.
 *
 * ## Boundary
 *
 * Not a public `fino:*` builtin. Platform plumbing with no stable surface; what is
 * public is the `fino:tensor/backend` contract it satisfies.
 *
 * @internal
 */
export {
  VulkanError,
  VulkanUnavailableError,
  check,
  loader,
  vulkanAvailable,
  vulkanUnavailableReason,
} from './loader.ts';
export type { VulkanLibrary } from './loader.ts';
export { VulkanCompute, vulkanComputeAvailable } from './device.ts';
export type { VkBuffer, VkDeviceInfo, VkPipeline } from './device.ts';
export {
  StructChain,
  VkStruct,
  StructureType,
  BufferUsage,
  MemoryProperty,
  QueueFlags,
  DescriptorType,
  ShaderStage,
  PipelineBindPoint,
  SemaphoreType,
  VK_SUCCESS,
  VK_FOREVER,
  makeVersion,
} from './structs.ts';
export type { FieldSpec, FieldType, FieldValue } from './structs.ts';
