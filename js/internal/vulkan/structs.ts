/**
 * Vulkan structure layout.
 *
 * Vulkan takes every structure by pointer, so these are plain host buffers rather
 * than by-value FFI arguments. Each is described once with natural alignment and
 * asserted against the size the specification fixes for LP64, so a layout mistake
 * fails at import with a name attached rather than as a driver crash later.
 *
 * `structType` from `fino:ffi` computes layout too, but its setter takes a JS
 * number for a 64-bit field, and Vulkan is full of 64-bit handles and device
 * sizes. So this module carries its own writer, which handles `u64` as a BigInt
 * throughout.
 *
 * @internal
 *
 * This module is re-exported through `internal:vulkan`; import from there.
 */
import { Pointer } from 'fino:ffi';

/** Field types a Vulkan structure can hold. */
export type FieldType = 'u32' | 'i32' | 'u64' | 'f32' | 'ptr' | `bytes:${number}`;

/** One field in a structure. */
export type FieldSpec = readonly [name: string, type: FieldType];

/**
 * Byte width of a field type.
 *
 * @internal
 */
function widthOf(type: FieldType): number {
  if (type.startsWith('bytes:')) return Number(type.slice(6));
  switch (type) {
    case 'u32':
    case 'i32':
    case 'f32':
      return 4;
    default:
      return 8;
  }
}

/**
 * Alignment of a field type. A byte blob aligns to one byte.
 *
 * @internal
 */
function alignOf(type: FieldType): number {
  return type.startsWith('bytes:') ? 1 : widthOf(type);
}

/** A value a structure field can take. */
export type FieldValue = number | bigint | ArrayBuffer | ArrayBufferView | null | undefined;

/**
 * A described Vulkan structure.
 */
export class VkStruct {
  readonly name: string;
  readonly size: number;

  /**
   * @internal
   */
  #fields = new Map<string, { offset: number; type: FieldType }>();

  constructor(name: string, fields: readonly FieldSpec[], expectedSize?: number) {
    this.name = name;
    let offset = 0;
    let maxAlign = 1;
    for (const [field, type] of fields) {
      const align = alignOf(type);
      maxAlign = Math.max(maxAlign, align);
      offset = Math.ceil(offset / align) * align;
      this.#fields.set(field, { offset, type });
      offset += widthOf(type);
    }
    this.size = Math.ceil(offset / maxAlign) * maxAlign;
    if (expectedSize !== undefined && this.size !== expectedSize) {
      throw new Error(
        `${name} lays out to ${this.size} bytes but the specification fixes ${expectedSize}; a field is missing or misordered`,
      );
    }
  }

  /** Byte offset of a field. */
  offsetOf(field: string): number {
    const found = this.#fields.get(field);
    if (!found) throw new Error(`${this.name} has no field '${field}'`);
    return found.offset;
  }

  /** Allocate a zeroed instance. */
  alloc(): ArrayBuffer {
    return new ArrayBuffer(this.size);
  }

  /**
   * Write one field.
   *
   * A `ptr` field accepts a buffer, whose address is taken. The caller must keep
   * that buffer alive for as long as Vulkan may read the structure — see
   * {@link StructChain}, which exists to make that straightforward.
   */
  set(buffer: ArrayBuffer, field: string, value: FieldValue): void {
    const found = this.#fields.get(field);
    if (!found) throw new Error(`${this.name} has no field '${field}'`);
    const { offset, type } = found;
    if (type.startsWith('bytes:')) {
      if (value === null || value === undefined) return;
      const source =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(
              (value as ArrayBufferView).buffer,
              (value as ArrayBufferView).byteOffset,
              (value as ArrayBufferView).byteLength,
            );
      new Uint8Array(buffer, offset, widthOf(type)).set(source.subarray(0, widthOf(type)));
      return;
    }
    const view = new DataView(buffer);
    switch (type) {
      case 'u32':
        view.setUint32(offset, Number(value ?? 0), true);
        return;
      case 'i32':
        view.setInt32(offset, Number(value ?? 0), true);
        return;
      case 'f32':
        view.setFloat32(offset, Number(value ?? 0), true);
        return;
      case 'u64':
        view.setBigUint64(offset, BigInt(value ?? 0), true);
        return;
      default: {
        if (value === null || value === undefined) {
          view.setBigUint64(offset, 0n, true);
          return;
        }
        if (typeof value === 'bigint') {
          view.setBigUint64(offset, value, true);
          return;
        }
        if (typeof value === 'number') {
          view.setBigUint64(offset, BigInt(value), true);
          return;
        }
        view.setBigUint64(offset, Pointer.addr(value as ArrayBuffer), true);
        return;
      }
    }
  }

  /** Read a 32-bit field. */
  getU32(buffer: ArrayBuffer, field: string): number {
    return new DataView(buffer).getUint32(this.offsetOf(field), true);
  }

  /** Read a 64-bit field. */
  getU64(buffer: ArrayBuffer, field: string): bigint {
    return new DataView(buffer).getBigUint64(this.offsetOf(field), true);
  }

  /** Fill a fresh instance from named values. */
  make(values: Readonly<Record<string, FieldValue>>): ArrayBuffer {
    const buffer = this.alloc();
    for (const [field, value] of Object.entries(values)) this.set(buffer, field, value);
    return buffer;
  }
}

/**
 * Keeps every buffer a structure points at alive.
 *
 * A Vulkan create-info holds raw addresses of arrays, strings, and chained
 * structures. Nothing in the FFI layer knows about those inner pointers — argument
 * pinning covers only the argument itself — so dropping one before the call means
 * the driver reads freed memory. Holding them in a chain makes the lifetime
 * explicit rather than accidental.
 */
export class StructChain {
  /**
   * @internal
   */
  #held: unknown[] = [];

  /** Retain a value and return it. */
  hold<T>(value: T): T {
    this.#held.push(value);
    return value;
  }

  /** Retain a buffer and return its address. */
  addressOf(value: ArrayBuffer | ArrayBufferView): bigint {
    this.#held.push(value);
    return Pointer.addr(value as ArrayBuffer);
  }

  /** A NUL-terminated UTF-8 string, retained. */
  cstring(text: string): Uint8Array {
    const bytes = new TextEncoder().encode(text);
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes, 0);
    return this.hold(out);
  }

  /** An array of C string pointers, retained, returning its address. */
  cstringArray(values: readonly string[]): bigint | null {
    if (values.length === 0) return null;
    const pointers = new BigUint64Array(values.length);
    for (let i = 0; i < values.length; i++) {
      pointers[i] = Pointer.addr(this.cstring(values[i]!) as unknown as ArrayBuffer);
    }
    return this.addressOf(pointers);
  }

  /** An array of 64-bit handles, retained, returning its address. */
  handleArray(values: readonly bigint[]): bigint | null {
    if (values.length === 0) return null;
    return this.addressOf(BigUint64Array.from(values));
  }

  /** An array of 32-bit values, retained, returning its address. */
  u32Array(values: readonly number[]): bigint | null {
    if (values.length === 0) return null;
    return this.addressOf(Uint32Array.from(values));
  }

  /** An array of floats, retained, returning its address. */
  f32Array(values: readonly number[]): bigint | null {
    if (values.length === 0) return null;
    return this.addressOf(Float32Array.from(values));
  }
}

/** `VkStructureType` values used here. */
export const StructureType = {
  ApplicationInfo: 0,
  MemoryBarrier: 46,
  InstanceCreateInfo: 1,
  DeviceQueueCreateInfo: 2,
  DeviceCreateInfo: 3,
  SubmitInfo: 4,
  MemoryAllocateInfo: 5,
  FenceCreateInfo: 8,
  SemaphoreCreateInfo: 9,
  BufferCreateInfo: 12,
  ShaderModuleCreateInfo: 16,
  PipelineShaderStageCreateInfo: 18,
  ComputePipelineCreateInfo: 29,
  PipelineLayoutCreateInfo: 30,
  DescriptorSetLayoutCreateInfo: 32,
  DescriptorPoolCreateInfo: 33,
  DescriptorSetAllocateInfo: 34,
  WriteDescriptorSet: 35,
  CommandPoolCreateInfo: 39,
  CommandBufferAllocateInfo: 40,
  CommandBufferBeginInfo: 42,
  PhysicalDeviceFeatures2: 1000059000,
  PhysicalDeviceTimelineSemaphoreFeatures: 1000207000,
  SemaphoreTypeCreateInfo: 1000207002,
  TimelineSemaphoreSubmitInfo: 1000207003,
  SemaphoreWaitInfo: 1000207004,
} as const;

/** Buffer usage bits. */
export const BufferUsage = {
  TransferSrc: 0x1,
  TransferDst: 0x2,
  StorageBuffer: 0x20,
} as const;

/** Memory property bits. */
export const MemoryProperty = {
  DeviceLocal: 0x1,
  HostVisible: 0x2,
  HostCoherent: 0x4,
  HostCached: 0x8,
} as const;

/** Queue capability bits. */
export const QueueFlags = { Graphics: 0x1, Compute: 0x2, Transfer: 0x4 } as const;

/** Descriptor types used here. */
export const DescriptorType = { StorageBuffer: 7 } as const;

/** Shader stage bits. */
export const ShaderStage = { Compute: 0x20 } as const;

/** Pipeline bind points. */
export const PipelineBindPoint = { Compute: 1 } as const;

/** Command buffer levels. */
export const CommandBufferLevel = { Primary: 0 } as const;

/** Command buffer usage bits. */
export const CommandBufferUsage = { OneTimeSubmit: 0x1 } as const;

/** Instance creation flags. */
export const InstanceCreateFlags = { EnumeratePortability: 0x1 } as const;

/** Semaphore types. */
export const SemaphoreType = { Binary: 0, Timeline: 1 } as const;

/** Pipeline stage bits. */
export const PipelineStage = { ComputeShader: 0x800, AllCommands: 0x10000 } as const;

/** Memory access bits, for the barrier between two dispatches. */
export const Access = { ShaderRead: 0x20, ShaderWrite: 0x40 } as const;

/**
 * `VkMemoryBarrier` — a global barrier, covering every buffer at once.
 *
 * Per-buffer barriers would be narrower, but a compute dispatch reads and writes
 * whatever its bindings name and the cost here is a pipeline stall either way, so
 * naming buffers individually would add bookkeeping without removing the stall.
 */
export const VkMemoryBarrier = new VkStruct(
  'VkMemoryBarrier',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['srcAccessMask', 'u32'],
    ['dstAccessMask', 'u32'],
  ],
  24,
);

/** `VK_SUCCESS`. */
export const VK_SUCCESS = 0;

/** Wait forever, in nanoseconds. */
export const VK_FOREVER = 0xffffffffffffffffn;

/** Pack a Vulkan API version. */
export function makeVersion(major: number, minor: number, patch: number): number {
  return (major << 22) | (minor << 12) | patch;
}

// Expected sizes below are the specification's LP64 layout, asserted at import so
// a mistake is a startup error rather than memory corruption.

/** `VkApplicationInfo`. */
export const VkApplicationInfo = new VkStruct(
  'VkApplicationInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['pApplicationName', 'ptr'],
    ['applicationVersion', 'u32'],
    ['pEngineName', 'ptr'],
    ['engineVersion', 'u32'],
    ['apiVersion', 'u32'],
  ],
  48,
);

/** `VkInstanceCreateInfo`. */
export const VkInstanceCreateInfo = new VkStruct(
  'VkInstanceCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['pApplicationInfo', 'ptr'],
    ['enabledLayerCount', 'u32'],
    ['ppEnabledLayerNames', 'ptr'],
    ['enabledExtensionCount', 'u32'],
    ['ppEnabledExtensionNames', 'ptr'],
  ],
  64,
);

/** `VkDeviceQueueCreateInfo`. */
export const VkDeviceQueueCreateInfo = new VkStruct(
  'VkDeviceQueueCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['queueFamilyIndex', 'u32'],
    ['queueCount', 'u32'],
    ['pQueuePriorities', 'ptr'],
  ],
  40,
);

/** `VkDeviceCreateInfo`. */
export const VkDeviceCreateInfo = new VkStruct(
  'VkDeviceCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['queueCreateInfoCount', 'u32'],
    ['pQueueCreateInfos', 'ptr'],
    ['enabledLayerCount', 'u32'],
    ['ppEnabledLayerNames', 'ptr'],
    ['enabledExtensionCount', 'u32'],
    ['ppEnabledExtensionNames', 'ptr'],
    ['pEnabledFeatures', 'ptr'],
  ],
  72,
);

/** `VkBufferCreateInfo`. */
export const VkBufferCreateInfo = new VkStruct(
  'VkBufferCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['size', 'u64'],
    ['usage', 'u32'],
    ['sharingMode', 'u32'],
    ['queueFamilyIndexCount', 'u32'],
    ['pQueueFamilyIndices', 'ptr'],
  ],
  56,
);

/** `VkBufferCopy`. */
export const VkBufferCopy = new VkStruct(
  'VkBufferCopy',
  [
    ['srcOffset', 'u64'],
    ['dstOffset', 'u64'],
    ['size', 'u64'],
  ],
  24,
);

/** `VkMemoryRequirements`. */
export const VkMemoryRequirements = new VkStruct(
  'VkMemoryRequirements',
  [
    ['size', 'u64'],
    ['alignment', 'u64'],
    ['memoryTypeBits', 'u32'],
  ],
  24,
);

/** `VkMemoryAllocateInfo`. */
export const VkMemoryAllocateInfo = new VkStruct(
  'VkMemoryAllocateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['allocationSize', 'u64'],
    ['memoryTypeIndex', 'u32'],
  ],
  32,
);

/**
 * `VkPhysicalDeviceMemoryProperties`.
 *
 * The two arrays are read with explicit offsets rather than described field by
 * field, since 32 memory types and 16 heaps would be ninety-six declarations.
 */
export const VkPhysicalDeviceMemoryProperties = new VkStruct(
  'VkPhysicalDeviceMemoryProperties',
  [
    ['memoryTypeCount', 'u32'],
    // 32 x VkMemoryType { propertyFlags: u32, heapIndex: u32 }
    ['memoryTypes', 'bytes:256'],
    ['memoryHeapCount', 'u32'],
    // 16 x VkMemoryHeap { size: u64, flags: u32, padding }. This starts at 264,
    // which is already 8-aligned, so no explicit padding belongs here.
    ['memoryHeaps', 'bytes:256'],
  ],
  520,
);

/** `VkQueueFamilyProperties`. */
export const VkQueueFamilyProperties = new VkStruct(
  'VkQueueFamilyProperties',
  [
    ['queueFlags', 'u32'],
    ['queueCount', 'u32'],
    ['timestampValidBits', 'u32'],
    ['granularity', 'bytes:12'],
  ],
  24,
);

/** `VkDescriptorSetLayoutBinding`. */
export const VkDescriptorSetLayoutBinding = new VkStruct(
  'VkDescriptorSetLayoutBinding',
  [
    ['binding', 'u32'],
    ['descriptorType', 'u32'],
    ['descriptorCount', 'u32'],
    ['stageFlags', 'u32'],
    ['pImmutableSamplers', 'ptr'],
  ],
  24,
);

/** `VkDescriptorSetLayoutCreateInfo`. */
export const VkDescriptorSetLayoutCreateInfo = new VkStruct(
  'VkDescriptorSetLayoutCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['bindingCount', 'u32'],
    ['pBindings', 'ptr'],
  ],
  32,
);

/** `VkPushConstantRange`. */
export const VkPushConstantRange = new VkStruct(
  'VkPushConstantRange',
  [
    ['stageFlags', 'u32'],
    ['offset', 'u32'],
    ['size', 'u32'],
  ],
  12,
);

/** `VkPipelineLayoutCreateInfo`. */
export const VkPipelineLayoutCreateInfo = new VkStruct(
  'VkPipelineLayoutCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['setLayoutCount', 'u32'],
    ['pSetLayouts', 'ptr'],
    ['pushConstantRangeCount', 'u32'],
    ['pPushConstantRanges', 'ptr'],
  ],
  48,
);

/** `VkShaderModuleCreateInfo`. */
export const VkShaderModuleCreateInfo = new VkStruct(
  'VkShaderModuleCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['codeSize', 'u64'],
    ['pCode', 'ptr'],
  ],
  40,
);

/** `VkPipelineShaderStageCreateInfo`. */
export const VkPipelineShaderStageCreateInfo = new VkStruct(
  'VkPipelineShaderStageCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['stage', 'u32'],
    ['module', 'u64'],
    ['pName', 'ptr'],
    ['pSpecializationInfo', 'ptr'],
  ],
  48,
);

/** `VkComputePipelineCreateInfo`, whose stage structure is embedded by value. */
export const VkComputePipelineCreateInfo = new VkStruct(
  'VkComputePipelineCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    // The embedded stage structure is 8-aligned, which a byte blob does not imply,
    // so the padding is explicit. Without it the total size still comes to 96 and
    // the assertion passes while every field inside the stage is four bytes low.
    ['stagePad', 'bytes:4'],
    ['stage', 'bytes:48'],
    ['layout', 'u64'],
    ['basePipelineHandle', 'u64'],
    ['basePipelineIndex', 'i32'],
  ],
  96,
);

/** `VkDescriptorPoolSize`. */
export const VkDescriptorPoolSize = new VkStruct(
  'VkDescriptorPoolSize',
  [
    ['type', 'u32'],
    ['descriptorCount', 'u32'],
  ],
  8,
);

/** `VkDescriptorPoolCreateInfo`. */
export const VkDescriptorPoolCreateInfo = new VkStruct(
  'VkDescriptorPoolCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['maxSets', 'u32'],
    ['poolSizeCount', 'u32'],
    ['pPoolSizes', 'ptr'],
  ],
  40,
);

/** `VkDescriptorSetAllocateInfo`. */
export const VkDescriptorSetAllocateInfo = new VkStruct(
  'VkDescriptorSetAllocateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['descriptorPool', 'u64'],
    ['descriptorSetCount', 'u32'],
    ['pSetLayouts', 'ptr'],
  ],
  40,
);

/** `VkDescriptorBufferInfo`. */
export const VkDescriptorBufferInfo = new VkStruct(
  'VkDescriptorBufferInfo',
  [
    ['buffer', 'u64'],
    ['offset', 'u64'],
    ['range', 'u64'],
  ],
  24,
);

/** `VkWriteDescriptorSet`. */
export const VkWriteDescriptorSet = new VkStruct(
  'VkWriteDescriptorSet',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['dstSet', 'u64'],
    ['dstBinding', 'u32'],
    ['dstArrayElement', 'u32'],
    ['descriptorCount', 'u32'],
    ['descriptorType', 'u32'],
    ['pImageInfo', 'ptr'],
    ['pBufferInfo', 'ptr'],
    ['pTexelBufferView', 'ptr'],
  ],
  64,
);

/** `VkCommandPoolCreateInfo`. */
export const VkCommandPoolCreateInfo = new VkStruct(
  'VkCommandPoolCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['queueFamilyIndex', 'u32'],
  ],
  24,
);

/** `VkCommandBufferAllocateInfo`. */
export const VkCommandBufferAllocateInfo = new VkStruct(
  'VkCommandBufferAllocateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['commandPool', 'u64'],
    ['level', 'u32'],
    ['commandBufferCount', 'u32'],
  ],
  32,
);

/** `VkCommandBufferBeginInfo`. */
export const VkCommandBufferBeginInfo = new VkStruct(
  'VkCommandBufferBeginInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['pInheritanceInfo', 'ptr'],
  ],
  32,
);

/** `VkSubmitInfo`. */
export const VkSubmitInfo = new VkStruct(
  'VkSubmitInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['waitSemaphoreCount', 'u32'],
    ['pWaitSemaphores', 'ptr'],
    ['pWaitDstStageMask', 'ptr'],
    ['commandBufferCount', 'u32'],
    ['pCommandBuffers', 'ptr'],
    ['signalSemaphoreCount', 'u32'],
    ['pSignalSemaphores', 'ptr'],
  ],
  72,
);

/** `VkFenceCreateInfo`. */
export const VkFenceCreateInfo = new VkStruct(
  'VkFenceCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
  ],
  24,
);

/** `VkSemaphoreCreateInfo`. */
export const VkSemaphoreCreateInfo = new VkStruct(
  'VkSemaphoreCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
  ],
  24,
);

/** `VkSemaphoreTypeCreateInfo`, chained onto a semaphore creation. */
export const VkSemaphoreTypeCreateInfo = new VkStruct(
  'VkSemaphoreTypeCreateInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['semaphoreType', 'u32'],
    ['initialValue', 'u64'],
  ],
  32,
);

/** `VkSemaphoreWaitInfo`. */
export const VkSemaphoreWaitInfo = new VkStruct(
  'VkSemaphoreWaitInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['flags', 'u32'],
    ['semaphoreCount', 'u32'],
    ['pSemaphores', 'ptr'],
    ['pValues', 'ptr'],
  ],
  40,
);

/** `VkTimelineSemaphoreSubmitInfo`, chained onto a submission. */
export const VkTimelineSemaphoreSubmitInfo = new VkStruct(
  'VkTimelineSemaphoreSubmitInfo',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['waitSemaphoreValueCount', 'u32'],
    ['pWaitSemaphoreValues', 'ptr'],
    ['signalSemaphoreValueCount', 'u32'],
    ['pSignalSemaphoreValues', 'ptr'],
  ],
  48,
);

/** `VkPhysicalDeviceTimelineSemaphoreFeatures`. */
export const VkPhysicalDeviceTimelineSemaphoreFeatures = new VkStruct(
  'VkPhysicalDeviceTimelineSemaphoreFeatures',
  [
    ['sType', 'u32'],
    ['pNext', 'ptr'],
    ['timelineSemaphore', 'u32'],
  ],
  24,
);

/** Read a memory type's property flags out of the properties blob. */
export function memoryTypeFlags(properties: ArrayBuffer, index: number): number {
  const base = VkPhysicalDeviceMemoryProperties.offsetOf('memoryTypes');
  return new DataView(properties).getUint32(base + index * 8, true);
}

/** Read a memory type's heap index. */
export function memoryTypeHeap(properties: ArrayBuffer, index: number): number {
  const base = VkPhysicalDeviceMemoryProperties.offsetOf('memoryTypes');
  return new DataView(properties).getUint32(base + index * 8 + 4, true);
}
