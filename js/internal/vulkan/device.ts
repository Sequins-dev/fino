/**
 * Vulkan compute device.
 *
 * Wraps instance and device creation, memory, pipelines, and dispatch behind a
 * small interface, so the backend above it never handles a create-info structure
 * directly.
 *
 * Ordering uses timeline semaphores (core in Vulkan 1.2) rather than fences: a
 * timeline is a monotonically increasing counter, which maps directly onto the
 * stream-and-event model the backend contract describes, whereas a fence would
 * need one object per submission.
 *
 * @internal
 *
 * This module is re-exported through `internal:vulkan`; import from there.
 */
import { env } from 'internal:process';
import { Pointer } from 'fino:ffi';
import { VulkanError, check, loader, vulkanAvailable, vulkanUnavailableReason } from './loader.ts';
import type { VulkanLibrary } from './loader.ts';
import {
  BufferUsage,
  VkBufferCopy,
  CommandBufferLevel,
  CommandBufferUsage,
  DescriptorType,
  InstanceCreateFlags,
  MemoryProperty,
  PipelineBindPoint,
  PipelineStage,
  QueueFlags,
  SemaphoreType,
  ShaderStage,
  StructChain,
  StructureType,
  VK_FOREVER,
  VkApplicationInfo,
  VkBufferCreateInfo,
  VkCommandBufferAllocateInfo,
  VkCommandBufferBeginInfo,
  VkCommandPoolCreateInfo,
  VkComputePipelineCreateInfo,
  VkDescriptorBufferInfo,
  VkDescriptorPoolCreateInfo,
  VkDescriptorPoolSize,
  Access,
  VkMemoryBarrier,
  VkDescriptorSetAllocateInfo,
  VkDescriptorSetLayoutBinding,
  VkDescriptorSetLayoutCreateInfo,
  VkDeviceCreateInfo,
  VkDeviceQueueCreateInfo,
  VkInstanceCreateInfo,
  VkMemoryAllocateInfo,
  VkMemoryRequirements,
  VkPhysicalDeviceMemoryProperties,
  VkPipelineLayoutCreateInfo,
  VkPipelineShaderStageCreateInfo,
  VkPushConstantRange,
  VkQueueFamilyProperties,
  VkSemaphoreCreateInfo,
  VkSemaphoreTypeCreateInfo,
  VkSemaphoreWaitInfo,
  VkShaderModuleCreateInfo,
  VkSubmitInfo,
  VkTimelineSemaphoreSubmitInfo,
  VkWriteDescriptorSet,
  makeVersion,
  memoryTypeFlags,
} from './structs.ts';

/** Bindings a compute pipeline layout reserves. */
const MAX_BINDINGS = 8;

/**
 * Descriptor sets the pool holds.
 *
 * One is consumed per dispatch and they are reclaimed in bulk, so this is how many
 * dispatches can be in flight before the device has to be caught up with. Large
 * enough that a burst between two synchronisation points never notices, small enough
 * that the pool costs nothing to hold.
 */
const DESCRIPTOR_SETS = 4096;

/**
 * Dispatches recorded before a batch is submitted regardless of synchronisation.
 *
 * Large enough that the per-submission cost amortises away, small enough that the
 * device is not left idle waiting for the host to finish a long run of launches.
 */
const MAX_BATCH = 64;

/** Push-constant bytes reserved, matching the kernel IR's parameter-block cap. */
const PUSH_CONSTANT_BYTES = 128;

/** A device allocation. */
export interface VkBuffer {
  /** `VkBuffer` handle. */
  handle: bigint;
  /** `VkDeviceMemory` backing it. */
  memory: bigint;
  /** Bytes requested. */
  bytes: number;
  /** Host mapping, when the memory is host-visible. */
  mapped: ArrayBuffer | null;
}

/** A compiled compute pipeline. */
export interface VkPipeline {
  /** `VkPipeline` handle. */
  handle: bigint;
  /** `VkShaderModule` it was built from. */
  module: bigint;
}

/** What the chosen device reports. */
export interface VkDeviceInfo {
  name: string;
  /** Whether every heap is host-visible, as on an integrated GPU. */
  unifiedMemory: boolean;
  /** Whether 16-bit storage is available, which the f16 kernels need. */
  storage16: boolean;
  /** Whether float16 arithmetic is available. */
  float16: boolean;
  timelineSemaphores: boolean;
  maxWorkgroupInvocations: number;
}

/**
 * Read a dispatchable handle out of an eight-byte out-parameter.
 *
 * @internal
 */
function readPointer(slot: Uint8Array): ArrayBuffer {
  return slot.slice().buffer;
}

/**
 * Read a non-dispatchable 64-bit handle out of an out-parameter.
 *
 * @internal
 */
function readHandle(slot: Uint8Array): bigint {
  return new DataView(slot.buffer, slot.byteOffset, 8).getBigUint64(0, true);
}

/**
 * The handle value a dispatchable-handle buffer holds.
 *
 * A dispatchable handle arrives as an eight-byte buffer whose *contents* are the
 * pointer. Passing it as a `pointer` argument is correct, but an array of such
 * handles needs the values themselves — `Pointer.addr` would give the address of
 * the wrapper instead, which is a different thing entirely.
 *
 * @internal
 */
function handleValue(wrapper: ArrayBuffer): bigint {
  return new DataView(wrapper).getBigUint64(0, true);
}

/** An eight-byte out-parameter slot. */
function slot(): Uint8Array {
  return new Uint8Array(8);
}

/**
 * Bytes `VkPhysicalDeviceProperties` occupies, rounded up generously.
 *
 * The structure is read rather than modelled: two fields are wanted out of the hundred
 * it holds, and declaring the rest would be a great deal of offset arithmetic to get
 * wrong. The driver writes what it writes and the remainder is ignored.
 *
 * @internal
 */
const PROPERTIES_BYTES = 1024;

/**
 * Where `deviceName` starts: after `apiVersion`, `driverVersion`, `vendorID`,
 * `deviceID`, and `deviceType`, all 32-bit.
 *
 * @internal
 */
const DEVICE_NAME_OFFSET = 20;

/**
 * Where `limits.maxComputeWorkGroupInvocations` starts.
 *
 * `deviceName` is 256 bytes and `pipelineCacheUUID` is 16, ending at 292; `limits`
 * holds 64-bit members so it begins at the next multiple of eight, and the field sits
 * 232 bytes into it. Checked for plausibility rather than trusted, because a wrong
 * offset here would silently produce a workgroup size the device rejects.
 *
 * @internal
 */
const MAX_WORKGROUP_INVOCATIONS_OFFSET = 296 + 232;

/**
 * Read the driver's name and the one limit the engine sizes its launches against.
 *
 * Both were previously hardcoded — every device called itself "Vulkan device" and
 * claimed a thousand invocations per workgroup, which is true of the drivers this has
 * been run on and is not a fact about Vulkan.
 *
 * @internal
 */
function describePhysicalDevice(
  lib: VulkanLibrary,
  physicalDevice: unknown,
): { name: string; maxWorkgroupInvocations: number } {
  const bytes = new Uint8Array(PROPERTIES_BYTES);
  (lib.symbols.vkGetPhysicalDeviceProperties as (a: unknown, b: Uint8Array) => void)(
    physicalDevice,
    bytes,
  );

  const end = bytes.indexOf(0, DEVICE_NAME_OFFSET);
  const name = new TextDecoder()
    .decode(bytes.subarray(DEVICE_NAME_OFFSET, end < 0 ? DEVICE_NAME_OFFSET + 256 : end))
    .trim();

  const reported = new DataView(bytes.buffer).getUint32(
    MAX_WORKGROUP_INVOCATIONS_OFFSET,
    true,
  );
  // Vulkan guarantees at least 128 and nothing sane reports more than a few thousand.
  // Outside that the offset is wrong, and the guaranteed floor beats a launch the
  // device refuses.
  const plausible = reported >= 128 && reported <= 4096;
  return {
    name: name.length > 0 ? name : 'Vulkan device',
    maxWorkgroupInvocations: plausible ? reported : 128,
  };
}

/**
 * A Vulkan compute context: one instance, one device, one queue.
 */
export class VulkanCompute {
  #lib: VulkanLibrary;
  #instance: ArrayBuffer;
  #physicalDevice: ArrayBuffer;
  #device: ArrayBuffer;
  #queue: ArrayBuffer;
  #queueFamily: number;
  #memoryProperties: ArrayBuffer;
  #info: VkDeviceInfo;
  #commandPool: bigint;
  #descriptorPool: bigint;

  /**
   * Descriptor sets handed out since the pools were last reset.
   *
   * A set cannot be freed individually, so the pool is reset as a whole — which is
   * only safe once the device has finished everything that referenced it. Counting
   * them is what lets a dispatch know it must recycle before allocating.
   *
   * @internal
   */
  #setsUsed = 0;
  #setLayout: bigint;
  #pipelineLayout: bigint;
  #timeline: bigint;
  #counter = 0n;
  #disposed = false;

  /**
   * Buffers a pending submission still points at.
   *
   * Vulkan reads command buffers and submit structures asynchronously, and the
   * FFI layer only pins the top-level argument, so anything referenced by address
   * has to be held until the submission completes.
   *
   * @internal
   */
  #pending: unknown[] = [];

  private constructor(parts: {
    lib: VulkanLibrary;
    instance: ArrayBuffer;
    physicalDevice: ArrayBuffer;
    device: ArrayBuffer;
    queue: ArrayBuffer;
    queueFamily: number;
    memoryProperties: ArrayBuffer;
    info: VkDeviceInfo;
  }) {
    this.#lib = parts.lib;
    this.#instance = parts.instance;
    this.#physicalDevice = parts.physicalDevice;
    this.#device = parts.device;
    this.#queue = parts.queue;
    this.#queueFamily = parts.queueFamily;
    this.#memoryProperties = parts.memoryProperties;
    this.#info = parts.info;
    this.#commandPool = this.#createCommandPool();
    this.#descriptorPool = this.#createDescriptorPool();
    this.#setLayout = this.#createSetLayout();
    this.#pipelineLayout = this.#createPipelineLayout();
    this.#timeline = this.#createTimeline();
  }

  /** What the device reports. */
  get info(): VkDeviceInfo {
    return this.#info;
  }

  /**
   * Create a compute context, or throw explaining why not.
   */
  static create(options: { validation?: boolean } = {}): VulkanCompute {
    const lib = loader();
    const chain = new StructChain();

    // MoltenVK is a portability driver, so the loader hides it unless portability
    // enumeration is asked for explicitly.
    const instanceExtensions = availableInstanceExtensions(lib);
    const portability = instanceExtensions.includes('VK_KHR_portability_enumeration');
    const wanted = portability ? ['VK_KHR_portability_enumeration'] : [];
    const layers =
      options.validation && instanceLayerAvailable() ? ['VK_LAYER_KHRONOS_validation'] : [];

    const appInfo = chain.hold(
      VkApplicationInfo.make({
        sType: StructureType.ApplicationInfo,
        pApplicationName: chain.cstring('fino'),
        applicationVersion: makeVersion(0, 1, 0),
        pEngineName: chain.cstring('fino:tensor'),
        engineVersion: makeVersion(0, 1, 0),
        // 1.2 is the floor: timeline semaphores are core there.
        apiVersion: makeVersion(1, 2, 0),
      }),
    );
    const instanceInfo = chain.hold(
      VkInstanceCreateInfo.make({
        sType: StructureType.InstanceCreateInfo,
        flags: portability ? InstanceCreateFlags.EnumeratePortability : 0,
        pApplicationInfo: appInfo,
        enabledLayerCount: layers.length,
        ppEnabledLayerNames: chain.cstringArray(layers),
        enabledExtensionCount: wanted.length,
        ppEnabledExtensionNames: chain.cstringArray(wanted),
      }),
    );
    const instanceSlot = slot();
    check(
      'vkCreateInstance',
      lib.symbols.vkCreateInstance(instanceInfo, null, instanceSlot) as number,
    );
    const instance = readPointer(instanceSlot);

    const physicalDevice = pickPhysicalDevice(lib, instance);
    const queueFamily = pickComputeQueue(lib, physicalDevice);

    const memoryProperties = VkPhysicalDeviceMemoryProperties.alloc();
    lib.symbols.vkGetPhysicalDeviceMemoryProperties(
      physicalDevice,
      new Uint8Array(memoryProperties),
    );

    const deviceExtensions = availableDeviceExtensions(lib, physicalDevice);
    const enabled: string[] = [];
    // A portability driver requires this extension to be enabled explicitly.
    if (deviceExtensions.includes('VK_KHR_portability_subset')) {
      enabled.push('VK_KHR_portability_subset');
    }
    const storage16 = deviceExtensions.includes('VK_KHR_16bit_storage');
    const float16 = deviceExtensions.includes('VK_KHR_shader_float16_int8');
    if (storage16) enabled.push('VK_KHR_16bit_storage');
    if (float16) enabled.push('VK_KHR_shader_float16_int8');

    const deviceChain = new StructChain();
    const priorities = deviceChain.f32Array([1]);
    const queueInfo = deviceChain.hold(
      VkDeviceQueueCreateInfo.make({
        sType: StructureType.DeviceQueueCreateInfo,
        queueFamilyIndex: queueFamily,
        queueCount: 1,
        pQueuePriorities: priorities,
      }),
    );
    const deviceInfo = deviceChain.hold(
      VkDeviceCreateInfo.make({
        sType: StructureType.DeviceCreateInfo,
        queueCreateInfoCount: 1,
        pQueueCreateInfos: queueInfo,
        enabledExtensionCount: enabled.length,
        ppEnabledExtensionNames: deviceChain.cstringArray(enabled),
      }),
    );
    const deviceSlot = slot();
    check(
      'vkCreateDevice',
      lib.symbols.vkCreateDevice(physicalDevice, deviceInfo, null, deviceSlot) as number,
    );
    const device = readPointer(deviceSlot);

    const queueSlot = slot();
    lib.symbols.vkGetDeviceQueue(device, queueFamily, 0, queueSlot);
    const queue = readPointer(queueSlot);

    // Every heap being host-visible is what makes readback a mapping rather than
    // a staging copy, which is the case on Apple Silicon and other integrated GPUs.
    const typeCount = VkPhysicalDeviceMemoryProperties.getU32(
      memoryProperties,
      'memoryTypeCount',
    );
    let allHostVisible = typeCount > 0;
    for (let i = 0; i < typeCount; i++) {
      if ((memoryTypeFlags(memoryProperties, i) & MemoryProperty.HostVisible) === 0) {
        allHostVisible = false;
        break;
      }
    }

    const described = describePhysicalDevice(lib, physicalDevice);

    return new VulkanCompute({
      lib,
      instance,
      physicalDevice,
      device,
      queue,
      queueFamily,
      memoryProperties,
      info: {
        name: described.name,
        unifiedMemory: allHostVisible,
        storage16,
        float16,
        timelineSemaphores: true,
        maxWorkgroupInvocations: described.maxWorkgroupInvocations,
      },
    });
  }

  /**
   * @internal
   */
  #createCommandPool(): bigint {
    const info = VkCommandPoolCreateInfo.make({
      sType: StructureType.CommandPoolCreateInfo,
      // Reset the whole pool between submissions rather than tracking buffers.
      flags: 0x2,
      queueFamilyIndex: this.#queueFamily,
    });
    const out = slot();
    check(
      'vkCreateCommandPool',
      this.#lib.symbols.vkCreateCommandPool(this.#device, info, null, out) as number,
    );
    return readHandle(out);
  }

  /**
   * @internal
   */
  #createDescriptorPool(): bigint {
    const chain = new StructChain();
    const size = chain.hold(
      VkDescriptorPoolSize.make({
        type: DescriptorType.StorageBuffer,
        // Every set writes all of its bindings, so the pool needs the product rather
        // than one descriptor per set.
        descriptorCount: MAX_BINDINGS * DESCRIPTOR_SETS,
      }),
    );
    const info = chain.hold(
      VkDescriptorPoolCreateInfo.make({
        sType: StructureType.DescriptorPoolCreateInfo,
        maxSets: DESCRIPTOR_SETS,
        poolSizeCount: 1,
        pPoolSizes: size,
      }),
    );
    const out = slot();
    check(
      'vkCreateDescriptorPool',
      this.#lib.symbols.vkCreateDescriptorPool(this.#device, info, null, out) as number,
    );
    return readHandle(out);
  }

  /**
   * One layout of eight storage buffers, shared by every kernel.
   *
   * A single layout means `compileKernel` never has to build one, and a kernel
   * using fewer bindings simply leaves the rest unwritten.
   *
   * @internal
   */
  #createSetLayout(): bigint {
    const chain = new StructChain();
    const bindings = new Uint8Array(VkDescriptorSetLayoutBinding.size * MAX_BINDINGS);
    for (let i = 0; i < MAX_BINDINGS; i++) {
      const one = VkDescriptorSetLayoutBinding.make({
        binding: i,
        descriptorType: DescriptorType.StorageBuffer,
        descriptorCount: 1,
        stageFlags: ShaderStage.Compute,
      });
      bindings.set(new Uint8Array(one), i * VkDescriptorSetLayoutBinding.size);
    }
    const info = chain.hold(
      VkDescriptorSetLayoutCreateInfo.make({
        sType: StructureType.DescriptorSetLayoutCreateInfo,
        bindingCount: MAX_BINDINGS,
        pBindings: chain.addressOf(bindings),
      }),
    );
    const out = slot();
    check(
      'vkCreateDescriptorSetLayout',
      this.#lib.symbols.vkCreateDescriptorSetLayout(this.#device, info, null, out) as number,
    );
    return readHandle(out);
  }

  /**
   * @internal
   */
  #createPipelineLayout(): bigint {
    const chain = new StructChain();
    const range = chain.hold(
      VkPushConstantRange.make({
        stageFlags: ShaderStage.Compute,
        offset: 0,
        size: PUSH_CONSTANT_BYTES,
      }),
    );
    const info = chain.hold(
      VkPipelineLayoutCreateInfo.make({
        sType: StructureType.PipelineLayoutCreateInfo,
        setLayoutCount: 1,
        pSetLayouts: chain.handleArray([this.#setLayout]),
        pushConstantRangeCount: 1,
        pPushConstantRanges: range,
      }),
    );
    const out = slot();
    check(
      'vkCreatePipelineLayout',
      this.#lib.symbols.vkCreatePipelineLayout(this.#device, info, null, out) as number,
    );
    return readHandle(out);
  }

  /**
   * @internal
   */
  #createTimeline(): bigint {
    const chain = new StructChain();
    const type = chain.hold(
      VkSemaphoreTypeCreateInfo.make({
        sType: StructureType.SemaphoreTypeCreateInfo,
        semaphoreType: SemaphoreType.Timeline,
        initialValue: 0n,
      }),
    );
    const info = chain.hold(
      VkSemaphoreCreateInfo.make({
        sType: StructureType.SemaphoreCreateInfo,
        pNext: type,
      }),
    );
    const out = slot();
    check(
      'vkCreateSemaphore',
      this.#lib.symbols.vkCreateSemaphore(this.#device, info, null, out) as number,
    );
    return readHandle(out);
  }

  /**
   * Allocate a buffer and its backing memory.
   *
   * Host-visible coherent memory is chosen so readback needs no explicit
   * invalidation; on an integrated GPU it is also device-local, so this costs
   * nothing.
   */
  createBuffer(bytes: number, options: { hostVisible?: boolean } = {}): VkBuffer {
    const chain = new StructChain();
    const size = BigInt(Math.max(bytes, 4));
    const info = chain.hold(
      VkBufferCreateInfo.make({
        sType: StructureType.BufferCreateInfo,
        size,
        usage:
          BufferUsage.StorageBuffer | BufferUsage.TransferSrc | BufferUsage.TransferDst,
        sharingMode: 0,
      }),
    );
    const bufferSlot = slot();
    check(
      'vkCreateBuffer',
      this.#lib.symbols.vkCreateBuffer(this.#device, info, null, bufferSlot) as number,
    );
    const handle = readHandle(bufferSlot);

    const requirements = VkMemoryRequirements.alloc();
    this.#lib.symbols.vkGetBufferMemoryRequirements(
      this.#device,
      handle,
      new Uint8Array(requirements),
    );
    const allocationSize = VkMemoryRequirements.getU64(requirements, 'size');
    const typeBits = VkMemoryRequirements.getU32(requirements, 'memoryTypeBits');
    const hostVisible = options.hostVisible ?? true;
    const typeIndex = this.#chooseMemoryType(
      typeBits,
      hostVisible
        ? MemoryProperty.HostVisible | MemoryProperty.HostCoherent
        : MemoryProperty.DeviceLocal,
    );

    const allocateInfo = VkMemoryAllocateInfo.make({
      sType: StructureType.MemoryAllocateInfo,
      allocationSize,
      memoryTypeIndex: typeIndex,
    });
    const memorySlot = slot();
    check(
      'vkAllocateMemory',
      this.#lib.symbols.vkAllocateMemory(
        this.#device,
        allocateInfo,
        null,
        memorySlot,
      ) as number,
    );
    const memory = readHandle(memorySlot);
    check(
      'vkBindBufferMemory',
      this.#lib.symbols.vkBindBufferMemory(this.#device, handle, memory, 0n) as number,
    );

    let mapped: ArrayBuffer | null = null;
    if (hostVisible) {
      const mapSlot = slot();
      check(
        'vkMapMemory',
        this.#lib.symbols.vkMapMemory(
          this.#device,
          memory,
          0n,
          allocationSize,
          0,
          mapSlot,
        ) as number,
      );
      const address = readHandle(mapSlot);
      // Persistently mapped: a view over the driver's own allocation, so writes
      // need no copy.
      mapped = Pointer.view(readPointer(mapSlot), Math.max(bytes, 4));
      void address;
    }
    return { handle, memory, bytes, mapped };
  }

  /**
   * Whether a memory type exists that is both device-local and host-visible.
   *
   * True on an integrated GPU, false on a discrete one. `FINO_VULKAN_STAGING=1`
   * forces the staged path regardless, which is how it gets tested on hardware that
   * does not require it.
   */
  get sharesMemory(): boolean {
    if (env.FINO_VULKAN_STAGING === '1') return false;
    return this.#info.unifiedMemory;
  }

  /**
   * Record and submit a buffer-to-buffer copy.
   *
   * Returns the timeline value it signals, so a caller can wait on exactly this
   * transfer rather than on the whole queue.
   */
  copyBuffer(
    dst: VkBuffer,
    dstOffset: number,
    src: VkBuffer,
    srcOffset: number,
    bytes: number,
  ): bigint {
    // This submits on its own, and the timeline it signals into is shared with the
    // batched dispatches. Anything still being recorded has to go first, or the copy
    // would signal a value ahead of dispatches that were issued before it — and a
    // timeline semaphore may only be signalled with increasing values.
    this.flush();
    const chain = new StructChain();
    const allocateInfo = chain.hold(
      VkCommandBufferAllocateInfo.make({
        sType: StructureType.CommandBufferAllocateInfo,
        commandPool: this.#commandPool,
        level: CommandBufferLevel.Primary,
        commandBufferCount: 1,
      }),
    );
    const commandSlot = slot();
    check(
      'vkAllocateCommandBuffers',
      this.#lib.symbols.vkAllocateCommandBuffers(
        this.#device,
        allocateInfo,
        commandSlot,
      ) as number,
    );
    const commandBuffer = readPointer(commandSlot);
    const beginInfo = chain.hold(
      VkCommandBufferBeginInfo.make({
        sType: StructureType.CommandBufferBeginInfo,
        flags: CommandBufferUsage.OneTimeSubmit,
      }),
    );
    check(
      'vkBeginCommandBuffer',
      this.#lib.symbols.vkBeginCommandBuffer(commandBuffer, beginInfo) as number,
    );
    const region = chain.hold(
      VkBufferCopy.make({
        srcOffset: BigInt(srcOffset),
        dstOffset: BigInt(dstOffset),
        size: BigInt(bytes),
      }),
    );
    this.#lib.symbols.vkCmdCopyBuffer(
      commandBuffer,
      src.handle,
      dst.handle,
      1,
      new Uint8Array(region),
    );
    check(
      'vkEndCommandBuffer',
      this.#lib.symbols.vkEndCommandBuffer(commandBuffer) as number,
    );

    const signalValue = ++this.#counter;
    const timelineInfo = chain.hold(
      VkTimelineSemaphoreSubmitInfo.make({
        sType: StructureType.TimelineSemaphoreSubmitInfo,
        signalSemaphoreValueCount: 1,
        pSignalSemaphoreValues: chain.addressOf(BigUint64Array.from([signalValue])),
      }),
    );
    const submitInfo = chain.hold(
      VkSubmitInfo.make({
        sType: StructureType.SubmitInfo,
        pNext: timelineInfo,
        commandBufferCount: 1,
        pCommandBuffers: chain.addressOf(
          BigUint64Array.from([handleValue(commandBuffer)]),
        ),
        signalSemaphoreCount: 1,
        pSignalSemaphores: chain.handleArray([this.#timeline]),
      }),
    );
    check(
      'vkQueueSubmit',
      this.#lib.symbols.vkQueueSubmit(this.#queue, 1, submitInfo, 0n) as number,
    );
    this.#pending.push(chain, commandBuffer);
    return signalValue;
  }

  /** Release a buffer and its memory. */
  destroyBuffer(buffer: VkBuffer): void {
    if (buffer.mapped) this.#lib.symbols.vkUnmapMemory(this.#device, buffer.memory);
    this.#lib.symbols.vkDestroyBuffer(this.#device, buffer.handle, null);
    this.#lib.symbols.vkFreeMemory(this.#device, buffer.memory, null);
  }

  /**
   * @internal
   */
  #chooseMemoryType(typeBits: number, required: number): number {
    const count = VkPhysicalDeviceMemoryProperties.getU32(
      this.#memoryProperties,
      'memoryTypeCount',
    );
    for (let i = 0; i < count; i++) {
      if ((typeBits & (1 << i)) === 0) continue;
      if ((memoryTypeFlags(this.#memoryProperties, i) & required) === required) return i;
    }
    throw new VulkanError(`no memory type with properties 0x${required.toString(16)}`, -1);
  }

  /** Build a compute pipeline from SPIR-V words. */
  createPipeline(words: Uint32Array, entry: string): VkPipeline {
    const chain = new StructChain();
    const code = chain.hold(words.slice());
    const moduleInfo = chain.hold(
      VkShaderModuleCreateInfo.make({
        sType: StructureType.ShaderModuleCreateInfo,
        codeSize: BigInt(code.byteLength),
        pCode: chain.addressOf(code),
      }),
    );
    const moduleSlot = slot();
    check(
      'vkCreateShaderModule',
      this.#lib.symbols.vkCreateShaderModule(
        this.#device,
        moduleInfo,
        null,
        moduleSlot,
      ) as number,
    );
    const module = readHandle(moduleSlot);

    const stage = VkPipelineShaderStageCreateInfo.make({
      sType: StructureType.PipelineShaderStageCreateInfo,
      stage: ShaderStage.Compute,
      module,
      pName: chain.cstring(entry),
    });
    const pipelineInfo = chain.hold(
      VkComputePipelineCreateInfo.make({
        sType: StructureType.ComputePipelineCreateInfo,
        stage,
        layout: this.#pipelineLayout,
        basePipelineIndex: -1,
      }),
    );
    const pipelineSlot = slot();
    check(
      'vkCreateComputePipelines',
      this.#lib.symbols.vkCreateComputePipelines(
        this.#device,
        0n,
        1,
        pipelineInfo,
        null,
        pipelineSlot,
      ) as number,
    );
    return { handle: readHandle(pipelineSlot), module };
  }

  /** Release a pipeline and its shader module. */
  destroyPipeline(pipeline: VkPipeline): void {
    this.#lib.symbols.vkDestroyPipeline(this.#device, pipeline.handle, null);
    this.#lib.symbols.vkDestroyShaderModule(this.#device, pipeline.module, null);
  }

  /**
   * The command buffer dispatches are being recorded into, if any.
   *
   * @internal
   */
  #openCommand: unknown = null;

  /**
   * Dispatches recorded into it.
   *
   * @internal
   */
  #encoded = 0;

  /**
   * Timeline value of the most recent submission.
   *
   * Distinct from `#counter`, which counts what has been *recorded*: a value that has
   * not been submitted will never be signalled, so anything waiting on one has to
   * flush first.
   *
   * @internal
   */
  #submittedValue = 0n;

  /**
   * Argument graphs belonging to calls that have not returned.
   *
   * An asynchronous call reads its arguments on another thread, for as long as it
   * takes. The FFI pins the buffer it is passed, but a structure that points at other
   * allocations keeps those alive only through the chain that built it — and a local
   * that is never read again is collectable the moment the call is issued.
   *
   * @internal
   */
  #awaited = new Set<StructChain>();

  /**
   * Open a command buffer to record into, or return the one already open.
   *
   * @internal
   */
  #beginCommands(): unknown {
    if (this.#openCommand) return this.#openCommand;
    const chain = new StructChain();
    const allocateInfo = chain.hold(
      VkCommandBufferAllocateInfo.make({
        sType: StructureType.CommandBufferAllocateInfo,
        commandPool: this.#commandPool,
        level: CommandBufferLevel.Primary,
        commandBufferCount: 1,
      }),
    );
    const commandSlot = slot();
    check(
      'vkAllocateCommandBuffers',
      this.#lib.symbols.vkAllocateCommandBuffers(
        this.#device,
        allocateInfo,
        commandSlot,
      ) as number,
    );
    const commandBuffer = readPointer(commandSlot);
    const beginInfo = chain.hold(
      VkCommandBufferBeginInfo.make({
        sType: StructureType.CommandBufferBeginInfo,
        flags: CommandBufferUsage.OneTimeSubmit,
      }),
    );
    check(
      'vkBeginCommandBuffer',
      this.#lib.symbols.vkBeginCommandBuffer(commandBuffer, beginInfo) as number,
    );
    this.#pending.push(chain);
    this.#openCommand = commandBuffer;
    return commandBuffer;
  }

  /**
   * Record and submit one dispatch, returning the timeline value it signals.
   */
  dispatch(options: {
    pipeline: VkPipeline;
    buffers: readonly VkBuffer[];
    params: ArrayBuffer | null;
    groups: readonly [number, number, number];
  }): bigint {
    if (!this.reclaim()) {
      throw new Error(
        `all ${DESCRIPTOR_SETS} descriptor sets are in use by work the device has not ` +
          'finished; wait for submitted work before dispatching more',
      );
    }
    const chain = new StructChain();

    // A fresh descriptor set per dispatch; the pool is reset when the timeline
    // passes, which is the simple correct choice before push descriptors.
    const setInfo = chain.hold(
      VkDescriptorSetAllocateInfo.make({
        sType: StructureType.DescriptorSetAllocateInfo,
        descriptorPool: this.#descriptorPool,
        descriptorSetCount: 1,
        pSetLayouts: chain.handleArray([this.#setLayout]),
      }),
    );
    const setSlot = slot();
    check(
      'vkAllocateDescriptorSets',
      this.#lib.symbols.vkAllocateDescriptorSets(this.#device, setInfo, setSlot) as number,
    );
    const descriptorSet = readHandle(setSlot);
    this.#setsUsed++;

    // Only the bindings the shader uses. The layout declares all eight, but a
    // descriptor that is not statically accessed does not have to be bound, and
    // writing the spares was most of the per-dispatch cost for kernels that take two
    // or three buffers — which is nearly all of them.
    const used = Math.min(options.buffers.length, MAX_BINDINGS);
    const writes = new Uint8Array(VkWriteDescriptorSet.size * used);
    for (let i = 0; i < used; i++) {
      const source = options.buffers[i]!;
      const bufferInfo = chain.hold(
        VkDescriptorBufferInfo.make({
          buffer: source.handle,
          offset: 0n,
          range: BigInt(Math.max(source.bytes, 4)),
        }),
      );
      const write = VkWriteDescriptorSet.make({
        sType: StructureType.WriteDescriptorSet,
        dstSet: descriptorSet,
        dstBinding: i,
        dstArrayElement: 0,
        descriptorCount: 1,
        descriptorType: DescriptorType.StorageBuffer,
        pBufferInfo: chain.addressOf(bufferInfo),
      });
      writes.set(new Uint8Array(write), i * VkWriteDescriptorSet.size);
    }
    this.#lib.symbols.vkUpdateDescriptorSets(this.#device, used, writes, 0, null);

    const commandBuffer = this.#beginCommands();
    this.#lib.symbols.vkCmdBindPipeline(
      commandBuffer,
      PipelineBindPoint.Compute,
      options.pipeline.handle,
    );
    this.#lib.symbols.vkCmdBindDescriptorSets(
      commandBuffer,
      PipelineBindPoint.Compute,
      this.#pipelineLayout,
      0,
      1,
      chain.hold(new Uint8Array(BigUint64Array.from([descriptorSet]).buffer)),
      0,
      null,
    );
    if (options.params && options.params.byteLength > 0) {
      this.#lib.symbols.vkCmdPushConstants(
        commandBuffer,
        this.#pipelineLayout,
        ShaderStage.Compute,
        0,
        options.params.byteLength,
        new Uint8Array(options.params),
      );
    }
    this.#lib.symbols.vkCmdDispatch(
      commandBuffer,
      options.groups[0],
      options.groups[1],
      options.groups[2],
    );
    // A global barrier after every dispatch. Batched dispatches share one command
    // buffer, so without this the next one could read what this one has not finished
    // writing — and separate submissions never guaranteed that ordering either, they
    // only tended to get it.
    const barrier = chain.hold(
      VkMemoryBarrier.make({
        sType: StructureType.MemoryBarrier,
        srcAccessMask: Access.ShaderWrite,
        dstAccessMask: Access.ShaderRead | Access.ShaderWrite,
      }),
    );
    this.#lib.symbols.vkCmdPipelineBarrier(
      commandBuffer,
      PipelineStage.ComputeShader,
      PipelineStage.ComputeShader,
      0,
      1,
      new Uint8Array(barrier),
      0,
      null,
      0,
      null,
    );

    this.#encoded++;
    // The driver reads the recorded structures asynchronously, so they must outlive
    // the submission, which has not happened yet.
    this.#pending.push(chain);
    const signalValue = ++this.#counter;
    if (this.#encoded >= MAX_BATCH) this.flush();
    return signalValue;
  }

  /**
   * Submit whatever has been recorded.
   *
   * One submission per batch rather than per dispatch: allocating a command buffer,
   * recording into it, and submitting it are most of the host cost of a launch, and
   * only the recording is per-dispatch work.
   */
  flush(): void {
    const commandBuffer = this.#openCommand;
    if (!commandBuffer) return;
    this.#openCommand = null;
    this.#encoded = 0;
    const signalValue = this.#counter;

    check(
      'vkEndCommandBuffer',
      this.#lib.symbols.vkEndCommandBuffer(commandBuffer) as number,
    );
    const chain = new StructChain();
    const timelineInfo = chain.hold(
      VkTimelineSemaphoreSubmitInfo.make({
        sType: StructureType.TimelineSemaphoreSubmitInfo,
        signalSemaphoreValueCount: 1,
        pSignalSemaphoreValues: chain.addressOf(BigUint64Array.from([signalValue])),
      }),
    );
    const submitInfo = chain.hold(
      VkSubmitInfo.make({
        sType: StructureType.SubmitInfo,
        pNext: timelineInfo,
        commandBufferCount: 1,
        pCommandBuffers: chain.addressOf(
          BigUint64Array.from([handleValue(commandBuffer)]),
        ),
        signalSemaphoreCount: 1,
        pSignalSemaphores: chain.handleArray([this.#timeline]),
      }),
    );
    check(
      'vkQueueSubmit',
      this.#lib.symbols.vkQueueSubmit(this.#queue, 1, submitInfo, 0n) as number,
    );
    this.#pending.push(chain, commandBuffer);
    this.#submittedValue = signalValue;
  }

  /**
   * Wait for the timeline to reach a value.
   *
   * Parks on the blocking pool, so the event loop keeps running while the GPU
   * works.
   */
  async waitFor(value: bigint): Promise<void> {
    // Unconditionally, not just when the value needs it. Waiting ends by resetting the
    // command pool, which frees every buffer allocated from it — including the one
    // still being recorded into. Flushing first is what keeps a later dispatch from
    // recording into freed memory, and it is a no-op when nothing is open.
    this.flush();
    const chain = new StructChain();
    const info = chain.hold(
      VkSemaphoreWaitInfo.make({
        sType: StructureType.SemaphoreWaitInfo,
        semaphoreCount: 1,
        pSemaphores: chain.handleArray([this.#timeline]),
        pValues: chain.addressOf(BigUint64Array.from([value])),
      }),
    );
    // The call is asynchronous, and the FFI pins only the buffer it is handed — not
    // the arrays that buffer points at. Those live in the chain, and nothing refers to
    // the chain after the call is issued, so a garbage collection during the wait was
    // free to reclaim them while the driver was still reading. Holding it somewhere
    // reachable for the duration is the whole fix.
    this.#awaited.add(chain);
    let result: number;
    try {
      result = (await this.#lib.symbols.vkWaitSemaphores(
        this.#device,
        info,
        VK_FOREVER,
      )) as number;
    } finally {
      this.#awaited.delete(chain);
    }
    check('vkWaitSemaphores', result);
    // Everything submitted up to this point has completed, so the recorded
    // command buffers and their referenced memory can be released.
    this.#pending.length = 0;
    check(
      'vkResetCommandPool',
      this.#lib.symbols.vkResetCommandPool(this.#device, this.#commandPool, 0) as number,
    );
    check(
      'vkResetDescriptorPool',
      this.#lib.symbols.vkResetDescriptorPool(this.#device, this.#descriptorPool, 0) as number,
    );
    this.#setsUsed = 0;
    // The reset freed every command buffer, so nothing may still be treated as open.
    // `flush` above has already cleared this; saying so here means a future caller that
    // resets without flushing fails loudly rather than recording into freed memory.
    this.#openCommand = null;
    this.#encoded = 0;
  }

  /**
   * Whether a dispatch can be recorded right now, recycling if it needs to be.
   *
   * Descriptor sets and command buffers are per-dispatch and cannot be freed one at a
   * time, so they are reclaimed in bulk once the device has caught up with everything
   * submitted. Sustained dispatch works because the device does catch up constantly;
   * this returns false only when it genuinely has not, which the caller answers by
   * waiting.
   */
  reclaim(): boolean {
    if (this.#setsUsed < DESCRIPTOR_SETS) return true;
    // Resetting the pools would free the command buffer currently being recorded
    // into, so anything open has to be submitted before it can be waited for.
    this.flush();
    if (this.completed() < this.#counter) return false;
    this.#pending.length = 0;
    check(
      'vkResetCommandPool',
      this.#lib.symbols.vkResetCommandPool(this.#device, this.#commandPool, 0) as number,
    );
    check(
      'vkResetDescriptorPool',
      this.#lib.symbols.vkResetDescriptorPool(this.#device, this.#descriptorPool, 0) as number,
    );
    this.#setsUsed = 0;
    return true;
  }

  /** The timeline value most recently submitted. */
  get submitted(): bigint {
    return this.#counter;
  }

  /** The timeline value the device has reached. */
  completed(): bigint {
    const out = slot();
    check(
      'vkGetSemaphoreCounterValue',
      this.#lib.symbols.vkGetSemaphoreCounterValue(this.#device, this.#timeline, out) as number,
    );
    return readHandle(out);
  }

  /** Release every resource. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending.length = 0;
    this.#lib.symbols.vkDestroySemaphore(this.#device, this.#timeline, null);
    this.#lib.symbols.vkDestroyPipelineLayout(this.#device, this.#pipelineLayout, null);
    this.#lib.symbols.vkDestroyDescriptorSetLayout(this.#device, this.#setLayout, null);
    this.#lib.symbols.vkDestroyDescriptorPool(this.#device, this.#descriptorPool, null);
    this.#lib.symbols.vkDestroyCommandPool(this.#device, this.#commandPool, null);
    this.#lib.symbols.vkDestroyDevice(this.#device, null);
    this.#lib.symbols.vkDestroyInstance(this.#instance, null);
  }
}

/**
 * Instance extension names the loader reports.
 *
 * @internal
 */
function availableInstanceExtensions(lib: VulkanLibrary): string[] {
  const countSlot = new Uint8Array(4);
  check(
    'vkEnumerateInstanceExtensionProperties',
    lib.symbols.vkEnumerateInstanceExtensionProperties(null, countSlot, null) as number,
  );
  const count = new DataView(countSlot.buffer).getUint32(0, true);
  if (count === 0) return [];
  // VkExtensionProperties is a 256-byte name followed by a u32 revision.
  const stride = 260;
  const buffer = new Uint8Array(stride * count);
  check(
    'vkEnumerateInstanceExtensionProperties',
    lib.symbols.vkEnumerateInstanceExtensionProperties(null, countSlot, buffer) as number,
  );
  return readExtensionNames(buffer, count, stride);
}

/**
 * Device extension names.
 *
 * @internal
 */
function availableDeviceExtensions(
  lib: VulkanLibrary,
  physicalDevice: ArrayBuffer,
): string[] {
  const countSlot = new Uint8Array(4);
  check(
    'vkEnumerateDeviceExtensionProperties',
    lib.symbols.vkEnumerateDeviceExtensionProperties(
      physicalDevice,
      null,
      countSlot,
      null,
    ) as number,
  );
  const count = new DataView(countSlot.buffer).getUint32(0, true);
  if (count === 0) return [];
  const stride = 260;
  const buffer = new Uint8Array(stride * count);
  check(
    'vkEnumerateDeviceExtensionProperties',
    lib.symbols.vkEnumerateDeviceExtensionProperties(
      physicalDevice,
      null,
      countSlot,
      buffer,
    ) as number,
  );
  return readExtensionNames(buffer, count, stride);
}

/**
 * @internal
 */
function readExtensionNames(buffer: Uint8Array, count: number, stride: number): string[] {
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = buffer.subarray(i * stride, i * stride + 256);
    const end = bytes.indexOf(0);
    names.push(decoder.decode(bytes.subarray(0, end < 0 ? 256 : end)));
  }
  return names;
}

/**
 * Whether the validation layer is installed.
 *
 * @internal
 */
function instanceLayerAvailable(): boolean {
  // Enabling a missing layer fails instance creation outright, so this is a
  // deliberate no-op until the layer enumeration is bound.
  return false;
}

/**
 * Choose a physical device, preferring a discrete GPU.
 *
 * @internal
 */
function pickPhysicalDevice(lib: VulkanLibrary, instance: ArrayBuffer): ArrayBuffer {
  const countSlot = new Uint8Array(4);
  check(
    'vkEnumeratePhysicalDevices',
    lib.symbols.vkEnumeratePhysicalDevices(instance, countSlot, null) as number,
  );
  const count = new DataView(countSlot.buffer).getUint32(0, true);
  if (count === 0) throw new VulkanError('no Vulkan physical device present', -3);
  const handles = new Uint8Array(8 * count);
  check(
    'vkEnumeratePhysicalDevices',
    lib.symbols.vkEnumeratePhysicalDevices(instance, countSlot, handles) as number,
  );
  const index = Number(env.FINO_VULKAN_DEVICE ?? 0) || 0;
  const chosen = Math.min(Math.max(index, 0), count - 1);
  return handles.slice(chosen * 8, chosen * 8 + 8).buffer;
}

/**
 * Find a queue family that supports compute.
 *
 * @internal
 */
function pickComputeQueue(lib: VulkanLibrary, physicalDevice: ArrayBuffer): number {
  const countSlot = new Uint8Array(4);
  lib.symbols.vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, countSlot, null);
  const count = new DataView(countSlot.buffer).getUint32(0, true);
  if (count === 0) throw new VulkanError('the device reports no queue families', -3);
  const properties = new Uint8Array(VkQueueFamilyProperties.size * count);
  lib.symbols.vkGetPhysicalDeviceQueueFamilyProperties(physicalDevice, countSlot, properties);
  for (let i = 0; i < count; i++) {
    const flags = new DataView(
      properties.buffer,
      properties.byteOffset + i * VkQueueFamilyProperties.size,
      4,
    ).getUint32(0, true);
    if ((flags & QueueFlags.Compute) !== 0) return i;
  }
  throw new VulkanError('no queue family supports compute', -3);
}

/** Whether a Vulkan compute device can be created. */
export function vulkanComputeAvailable(): boolean {
  if (!vulkanAvailable()) return false;
  try {
    const context = VulkanCompute.create();
    context.dispose();
    return true;
  } catch {
    return false;
  }
}

export { vulkanAvailable, vulkanUnavailableReason };
