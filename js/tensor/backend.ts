/**
 * `fino:tensor/backend` — the device backend contract and registry.
 *
 * **Experimental.** This interface is public so backends can be implemented
 * out-of-tree, including for hardware nobody here owns. It is not yet stable:
 * per `specs/tensor-contract.md` §1 it stops being experimental only once two
 * in-tree backends and one out-of-tree backend pass the conformance suite.
 * Until then, additive changes may land in any release and breaking changes in
 * any minor release.
 *
 * A backend is deliberately thin. All tensor semantics — dtype promotion,
 * broadcasting, autodiff, memory pooling, kernel generation — live above it in
 * backend-neutral TypeScript. A backend supplies memory, ordering, and the
 * execution of primitive operations, and nothing else.
 *
 * ## Two device classes
 *
 * Programmable devices (`caps.class === 'kernel'`) take work per operation and
 * compile kernels this engine generates. Fixed-function devices
 * (`caps.class === 'graph'`) take a whole subgraph and run it with their own
 * implementations, which is how CoreML, TensorRT, QNN, and OpenVINO actually
 * work. The distinction is in the contract from the first commit because
 * retrofitting it would break every out-of-tree implementation.
 */
import { env } from 'internal:process';
import type { DType } from './dtype.ts';

/**
 * An opaque device allocation.
 *
 * Backends define the representation; nothing above the contract may inspect it.
 */
export interface DeviceBuffer {
  /** Bytes the allocation spans. */
  readonly byteLength: number;
}

/** Host memory a device can copy into or out of without staging. */
export interface PinnedBuffer {
  readonly byteLength: number;
}

/** An ordered submission queue. */
export interface Stream {
  readonly id: number;
}

/** A point in a stream that other work can wait on. */
export interface DeviceEvent {
  readonly id: number;
}

/** A compiled kernel. */
export interface Kernel {
  readonly entry: string;
}

/** A compiled whole-graph program, for fixed-function devices. */
export interface CompiledGraph {
  readonly id: number;
}

/** A recorded, replayable sequence of work. */
export interface Executable {
  readonly id: number;
}

/** Which device a tensor lives on. */
export interface Device {
  /** Backend name: `'cpu'`, `'metal'`, `'vulkan'`, … Never a vendor. */
  readonly type: string;
  /** Index among devices of this type. */
  readonly index: number;
}

/** Render a device as `type` or `type:index`. */
export function formatDevice(device: Device): string {
  return device.index === 0 ? device.type : `${device.type}:${device.index}`;
}

/** Whether two devices are the same. */
export function sameDevice(a: Device, b: Device): boolean {
  return a.type === b.type && a.index === b.index;
}

/**
 * A tensor as a backend sees it.
 *
 * Backend-facing only: `Tensor` never exposes strides, and callers must not
 * retain a descriptor past the call it was passed to, since the framework reuses
 * these objects to keep dispatch allocation-free.
 */
export interface TensorDesc {
  buffer: DeviceBuffer;
  dtype: DType;
  shape: readonly number[];
  /** Strides in elements. */
  strides: readonly number[];
  /** Offset from the buffer start, in elements. */
  offset: number;
}

/** What a backend can do. */
export interface BackendCaps {
  /** Programmable versus fixed-function. */
  class: 'kernel' | 'graph';
  /** Kernel dialect the device compiles, or `false` for fixed-function devices. */
  kernelCompile: 'msl' | 'spirv' | 'cuda-c' | false;
  /** Whether work is submitted per operation or at graph flush points. */
  dispatch: 'per-op' | 'graph-flush';
  /** Whether recorded work can be replayed. */
  captureReplay: boolean;
  /** Element types the device supports. */
  dtypes: readonly DType[];
  /** Subgroup arithmetic, which makes reductions substantially faster. */
  subgroups: boolean;
  /** Cooperative-matrix instructions, the portable route to tensor-core GEMM. */
  cooperativeMatrix: boolean;
  /** Whether pinned host allocations are available for staging. */
  pinnedHost: boolean;
  /** Whether host and device share memory, making readback a view. */
  unifiedMemory: boolean;
}

/** Elementwise operation kinds. */
export type EwOp =
  | 'neg'
  | 'abs'
  | 'exp'
  | 'log'
  | 'sqrt'
  | 'rsqrt'
  | 'sin'
  | 'cos'
  | 'tanh'
  | 'sigmoid'
  | 'relu'
  | 'gelu'
  | 'silu'
  | 'erf'
  | 'floor'
  | 'ceil'
  | 'round'
  | 'logicalNot'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'pow'
  | 'maximum'
  | 'minimum'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'where';

/** Reduction kinds. */
export type RedOp = 'sum' | 'mean' | 'max' | 'min' | 'prod' | 'any' | 'all' | 'argmax' | 'argmin';

/** Random-sampling kinds. */
export type RngOp = 'uniform' | 'normal' | 'bernoulli' | 'randint';

/** Every primitive operation a backend may be asked about. */
export type OpKind =
  | EwOp
  | RedOp
  | RngOp
  | 'cast'
  | 'gemm'
  | 'copyStrided'
  | 'reshape'
  | 'permute'
  | 'expand'
  | 'softmax'
  | 'logSoftmax'
  | 'layerNorm'
  | 'gather'
  | 'scatterAddAt'
  | 'scatterAdd'
  | 'indexSelect'
  | 'oneHot'
  | 'fill'
  | 'arange'
  | 'fromHost'
  | 'sgdStep'
  | 'adamStep';

/** Free-form operation attributes. Must stay JSON-representable. */
export type OpAttrs = Record<string, number | boolean | string | readonly number[]>;

/** Options for a matrix multiply. */
export interface GemmOpts {
  m: number;
  n: number;
  k: number;
  /** Batch count; descriptors carry the batch stride. */
  batch: number;
  transA: boolean;
  transB: boolean;
  /** Scale applied to the existing output, for accumulation. */
  beta?: number;
}

/**
 * Where one operand of a fused step comes from.
 *
 * A leaf tensor, the result of an earlier step, or a constant. Constants are named
 * rather than compiled in, so two chains differing only in their numbers share a
 * kernel.
 */
export type ChainArg =
  | { from: 'input'; index: number }
  | { from: 'step'; index: number }
  | { from: 'scalar'; value: number };

/** One elementwise operation within a fused chain. */
export interface ChainStep {
  /** Named as {@link DeviceBackend.elementwise} names it. */
  op: EwOp;
  /** Operands, in the order the operation takes them. */
  args: readonly ChainArg[];
}

/** A counter-based RNG position, per `specs/tensor-contract.md` §8. */
export interface RngKey {
  /** Low and high words of the 64-bit key. */
  key: readonly [number, number];
  /** Counter base for the first element. */
  counter: number;
}

/**
 * The device backend contract.
 *
 * Ordering methods are meaningful even on synchronous backends: the reference
 * implementation executes inline and its streams and events are inert, which
 * keeps one dispatch path in the framework rather than a branch per device
 * class.
 */
export interface DeviceBackend {
  readonly device: Device;
  readonly caps: BackendCaps;

  // -- memory ------------------------------------------------------------

  /** Allocate device memory, ordered on `stream`. */
  alloc(bytes: number, stream: Stream): DeviceBuffer;
  /** Release device memory, ordered on `stream`. */
  free(buffer: DeviceBuffer, stream: Stream): void;
  /** Allocate host memory suitable for staging. */
  allocPinned(bytes: number): PinnedBuffer;
  /** Release staging memory. */
  freePinned(buffer: PinnedBuffer): void;
  /** View staging memory as bytes, without copying. */
  viewPinned(buffer: PinnedBuffer): Uint8Array;
  /** Copy host bytes to the device. */
  copyH2D(dst: DeviceBuffer, dstOffset: number, src: Uint8Array, stream: Stream): void;
  /** Copy device bytes to staging memory. */
  copyD2H(
    dst: PinnedBuffer,
    src: DeviceBuffer,
    srcOffset: number,
    bytes: number,
    stream: Stream,
  ): void;
  /** Copy within the device. */
  copyD2D(
    dst: DeviceBuffer,
    dstOffset: number,
    src: DeviceBuffer,
    srcOffset: number,
    bytes: number,
    stream: Stream,
  ): void;

  // -- ordering ----------------------------------------------------------

  createStream(): Stream;
  createEvent(): DeviceEvent;
  /** Mark a point in `stream` that {@link eventDone} can wait on. */
  record(event: DeviceEvent, stream: Stream): void;
  /** Make `stream` wait for `event` before proceeding. */
  streamWait(stream: Stream, event: DeviceEvent): void;
  /**
   * Resolve once the device reaches `event`.
   *
   * Implementations must not block the event loop: park a worker on a fence and
   * resolve through the runtime's wake pipe.
   */
  eventDone(event: DeviceEvent): Promise<void>;
  /** Resolve once every operation queued on `stream` has finished. */
  sync(stream: Stream): Promise<void>;

  // -- operations --------------------------------------------------------

  /** Elementwise operation over broadcast-compatible inputs. */
  elementwise(
    op: EwOp,
    inputs: readonly TensorDesc[],
    out: TensorDesc,
    attrs: OpAttrs | null,
    stream: Stream,
  ): void;
  /** Element type conversion. */
  cast(x: TensorDesc, out: TensorDesc, stream: Stream): void;
  /** Reduction over `axes`. */
  reduce(
    op: RedOp,
    x: TensorDesc,
    out: TensorDesc,
    axes: readonly number[],
    stream: Stream,
  ): void;
  /** Softmax or log-softmax along one axis. */
  softmax(x: TensorDesc, out: TensorDesc, axis: number, log: boolean, stream: Stream): void;
  /**
   * Layer normalisation, optionally affine.
   *
   * `rms` selects root-mean-square normalisation, which omits mean subtraction.
   */
  layerNorm(
    x: TensorDesc,
    weight: TensorDesc | null,
    bias: TensorDesc | null,
    out: TensorDesc,
    axisSize: number,
    epsilon: number,
    rms: boolean,
    stream: Stream,
  ): void;
  /** Matrix multiply. */
  gemm(
    a: TensorDesc,
    b: TensorDesc,
    out: TensorDesc,
    opts: GemmOpts,
    stream: Stream,
  ): void;
  /** Strided copy, which backs transpose, permute, slice, concat, and expand. */
  copyStrided(x: TensorDesc, out: TensorDesc, stream: Stream): void;
  /** Gather along an axis using an index tensor. */
  gather(
    x: TensorDesc,
    indices: TensorDesc,
    out: TensorDesc,
    axis: number,
    stream: Stream,
  ): void;
  /** Scatter-add into `out` along an axis. */
  /**
   * Accumulate one element per source position along an axis.
   *
   * The element-wise counterpart to {@link scatterAdd}, and the adjoint of
   * {@link gather}: `indices` has `src`'s shape and every position chooses its own
   * destination, where `scatterAdd` takes a list of positions and moves whole slices.
   * Repeated indices accumulate, so this is atomic on a device.
   */
  scatterAddAt(
    out: TensorDesc,
    indices: TensorDesc,
    src: TensorDesc,
    axis: number,
    stream: Stream,
  ): void;

  scatterAdd(
    out: TensorDesc,
    indices: TensorDesc,
    src: TensorDesc,
    axis: number,
    stream: Stream,
  ): void;
  /** Select whole slices along an axis; the embedding forward pass. */
  indexSelect(
    x: TensorDesc,
    indices: TensorDesc,
    out: TensorDesc,
    axis: number,
    stream: Stream,
  ): void;
  /** Fill with a constant. */
  fill(out: TensorDesc, value: number, stream: Stream): void;
  /** Fill with an arithmetic sequence. */
  arange(out: TensorDesc, start: number, step: number, stream: Stream): void;
  /** Sample random values from a counter-based generator. */
  random(
    op: RngOp,
    out: TensorDesc,
    key: RngKey,
    attrs: OpAttrs | null,
    stream: Stream,
  ): void;
  /**
   * Run a chain of elementwise steps as one kernel.
   *
   * Optional: a backend that does not implement it never receives a chain, because
   * the framework only defers work when there is something to defer it to.
   *
   * Every operand has the output's shape — a chain does not broadcast — and the steps
   * are in evaluation order, the last one producing the result.
   */
  elementwiseChain?(
    steps: readonly ChainStep[],
    inputs: readonly TensorDesc[],
    out: TensorDesc,
    stream: Stream,
  ): void;

  /**
   * Fused optimizer update.
   *
   * A primitive rather than a composition so a backend can flatten a parameter
   * group into one launch instead of several per tensor.
   */
  optimizerStep(
    kind: 'sgd' | 'adam',
    tensors: readonly TensorDesc[],
    attrs: OpAttrs,
    stream: Stream,
  ): void;

  /**
   * Whether this device can execute an operation on these operands.
   *
   * Required, not optional: a fully general backend returns `true`, and making
   * it mandatory means the graph partitioner never special-cases its absence.
   */
  supportsOp(op: OpKind, operands: readonly TensorDesc[]): boolean;

  // -- kernel plane (caps.class === 'kernel') ---------------------------

  /** Compile a kernel from the engine's IR. `cacheKey` identifies the artifact. */
  compileKernel?(ir: unknown, entry: string, cacheKey: string): Promise<Kernel>;
  /** Launch a compiled kernel. */
  launch?(
    kernel: Kernel,
    grid: readonly [number, number, number],
    block: readonly [number, number, number],
    buffers: readonly DeviceBuffer[],
    params: ArrayBuffer,
    stream: Stream,
  ): void;

  // -- graph plane (caps.class === 'graph') ------------------------------

  /** Compile a whole subgraph ahead of execution. */
  compileGraph?(graph: unknown, io: unknown): Promise<CompiledGraph>;
  /** Run a compiled subgraph. */
  runGraph?(
    compiled: CompiledGraph,
    inputs: readonly TensorDesc[],
    outputs: readonly TensorDesc[],
    stream: Stream,
  ): void;

  // -- capture plane (caps.captureReplay) -------------------------------

  captureBegin?(stream: Stream): void;
  captureEnd?(stream: Stream): Executable;
  replay?(executable: Executable, stream: Stream): void;

  /** Release every resource the backend holds. */
  dispose?(): void;
}

/** Registers the devices one backend implementation provides. */
export interface BackendProvider {
  /** Device type name this provider serves. */
  readonly type: string;
  /**
   * Selection priority for `device('auto')`; higher wins.
   *
   * The CPU reference provider is 0 and always succeeds, so automatic selection
   * cannot fail.
   */
  readonly priority: number;
  /** Discover devices, returning an empty list when unavailable. */
  probe(): Promise<DeviceBackend[]>;
  /**
   * Discover devices synchronously, when the platform allows it.
   *
   * Both GPU drivers here can be created without awaiting, and that matters:
   * layer constructors are synchronous, so without a synchronous resolution path
   * they would pick a different default device than `tensor()` does and a model's
   * weights would land on one device while its inputs land on another.
   */
  probeSync?(): DeviceBackend[];
}

/**
 * Registered providers, highest priority first.
 *
 * @internal
 */
const providers: BackendProvider[] = [];

/**
 * Backends discovered so far, keyed by `formatDevice`.
 *
 * @internal
 */
const discovered = new Map<string, DeviceBackend>();

/**
 * Provider types already probed, so probing is done once per process.
 *
 * @internal
 */
const probed = new Set<string>();

/** Register a backend provider. */
export function registerBackend(provider: BackendProvider): void {
  const existing = providers.findIndex((p) => p.type === provider.type);
  if (existing >= 0) providers.splice(existing, 1);
  providers.push(provider);
  providers.sort((a, b) => b.priority - a.priority);
  probed.delete(provider.type);
}

/** Registered provider type names, in selection order. */
export function registeredProviders(): string[] {
  return providers.map((p) => p.type);
}

/**
 * Make a backend available without probing.
 *
 * The reference CPU backend registers this way at import so that `cpu:0` is
 * usable synchronously. Layer constructors and initialisers are synchronous, and
 * requiring them to await device discovery to allocate host-side weights would be
 * ceremony with no benefit.
 */
export function registerDevice(backend: DeviceBackend): void {
  discovered.set(formatDevice(backend.device), backend);
  probed.add(backend.device.type);
}

/**
 * Probe one provider, caching its devices.
 *
 * @internal
 */
async function probeProvider(provider: BackendProvider): Promise<DeviceBackend[]> {
  if (probed.has(provider.type)) {
    return [...discovered.values()].filter((b) => b.device.type === provider.type);
  }
  let backends: DeviceBackend[] = [];
  try {
    backends = await provider.probe();
  } catch {
    // A provider that cannot initialise is simply absent; the next one is tried.
    backends = [];
  }
  probed.add(provider.type);
  for (const backend of backends) discovered.set(formatDevice(backend.device), backend);
  return backends;
}

/**
 * Probe one provider synchronously, caching its devices.
 *
 * @internal
 */
function probeProviderSync(provider: BackendProvider): DeviceBackend[] {
  if (probed.has(provider.type)) {
    return [...discovered.values()].filter((b) => b.device.type === provider.type);
  }
  if (!provider.probeSync) return [];
  let backends: DeviceBackend[] = [];
  try {
    backends = provider.probeSync();
  } catch {
    backends = [];
  }
  probed.add(provider.type);
  for (const backend of backends) discovered.set(formatDevice(backend.device), backend);
  return backends;
}

/**
 * Resolve a device specification without awaiting.
 *
 * Used by synchronous constructors. Providers without a synchronous probe are
 * skipped, so this can only ever choose among devices that are cheap to discover.
 */
export function resolveDeviceSync(spec: 'auto' | string | Device = 'auto'): Device {
  if (typeof spec !== 'string') return spec;
  if (spec === 'auto') {
    const override = envDevice();
    if (override) return resolveDeviceSync(override);
    for (const provider of providers) {
      const backends = probeProviderSync(provider);
      if (backends.length > 0) return backends[0]!.device;
    }
    throw new Error('no tensor backend is registered');
  }
  const [type, indexText] = spec.split(':');
  const index = indexText === undefined ? 0 : Number(indexText);
  const provider = providers.find((p) => p.type === type);
  if (provider) probeProviderSync(provider);
  const key = formatDevice({ type: type!, index });
  const backend = discovered.get(key);
  if (!backend) {
    throw new Error(`device ${key} is not available without asynchronous discovery`);
  }
  return backend.device;
}

/** Every available device, probing providers as needed. */
export async function listDevices(): Promise<Device[]> {
  for (const provider of providers) await probeProvider(provider);
  return [...discovered.values()].map((b) => b.device);
}

/**
 * Resolve a device specification.
 *
 * Accepts `'auto'`, a type name, `'type:index'`, or a {@link Device}. `'auto'`
 * takes the highest-priority provider that yields a device;
 * `FINO_TENSOR_DEVICE` overrides it, which is how CI and the differential
 * harness pin a backend.
 */
export async function resolveDevice(spec: 'auto' | string | Device = 'auto'): Promise<Device> {
  if (typeof spec !== 'string') {
    await probeType(spec.type);
    const key = formatDevice(spec);
    if (!discovered.has(key)) throw new Error(`device ${key} is not available`);
    return spec;
  }
  if (spec === 'auto') {
    const override = envDevice();
    if (override) return resolveDevice(override);
    for (const provider of providers) {
      // Prefer the synchronous probe where a provider has one, so both resolution
      // paths choose the same device.
      const backends = provider.probeSync
        ? probeProviderSync(provider)
        : await probeProvider(provider);
      if (backends.length > 0) return backends[0]!.device;
    }
    throw new Error('no tensor backend is registered');
  }
  const [type, indexText] = spec.split(':');
  const index = indexText === undefined ? 0 : Number(indexText);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid device specification '${spec}'`);
  }
  await probeType(type!);
  const key = formatDevice({ type: type!, index });
  const backend = discovered.get(key);
  if (!backend) throw new Error(`device ${key} is not available`);
  return backend.device;
}

/**
 * Probe the provider serving one device type.
 *
 * @internal
 */
async function probeType(type: string): Promise<void> {
  const provider = providers.find((p) => p.type === type);
  if (!provider) throw new Error(`no backend registered for device type '${type}'`);
  await probeProvider(provider);
}

/**
 * Device pinned by the environment, if any.
 *
 * @internal
 */
function envDevice(): string | null {
  // Read lazily so a test can set it before the first resolution.
  const value = env.FINO_TENSOR_DEVICE;
  return value && value.length > 0 ? value : null;
}

/**
 * The backend serving a device.
 *
 * Throws rather than probing, because dispatch is synchronous and must not
 * await; a device reaches dispatch only after {@link resolveDevice}.
 */
export function backendFor(device: Device): DeviceBackend {
  const backend = discovered.get(formatDevice(device));
  if (!backend) {
    throw new Error(
      `device ${formatDevice(device)} has no registered backend; resolve it before dispatching`,
    );
  }
  return backend;
}

/**
 * Throw unless a device supports a dtype.
 *
 * Checked at tensor creation as well as at dispatch: a device that cannot
 * represent `f64` should say so when asked to hold one, not several operations
 * later, and certainly not by silently narrowing a dtype someone chose
 * deliberately.
 */
export function requireDType(device: Device, dtype: DType): void {
  const backend = backendFor(device);
  if (backend.caps.dtypes.includes(dtype)) return;
  throw new Error(
    `device ${formatDevice(device)} does not support ${dtype}; supported: ${backend.caps.dtypes.join(', ')}`,
  );
}

/** Whether a device has been discovered. */
export function hasBackend(device: Device): boolean {
  return discovered.has(formatDevice(device));
}

/**
 * Forget every registration.
 *
 * Exists for tests that install fake backends; production code registers once at
 * import.
 */
export function resetRegistry(): void {
  providers.length = 0;
  discovered.clear();
  probed.clear();
}
