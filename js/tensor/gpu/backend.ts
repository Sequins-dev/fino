/**
 * A `DeviceBackend` over any {@link GpuDriver}.
 *
 * The mapping from primitive operations to kernel templates lives here, once, for
 * every GPU. Metal and Vulkan differ in how a kernel is compiled and launched, not
 * in which kernel an operation needs, so duplicating this mapping per backend would
 * be duplicating the semantics.
 *
 * ## Compilation is asynchronous, dispatch is not
 *
 * A kernel compile takes milliseconds and dispatch must not block. So the first
 * dispatch of an uncompiled kernel records the work it wanted and returns; the
 * kernel compiles in the background and the work is launched when it is ready.
 * Ordering is preserved because a readback awaits the whole queue, and later launches
 * queue behind earlier ones.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/gpu`; import from there.
 */
import type { DType } from '../dtype.ts';
import { DTYPE_BYTES, irScalarFor } from '../dtype.ts';
import type { ChainStep } from '../backend.ts';
import type {
  BackendCaps,
  DeviceBackend,
  Executable,
  DeviceBuffer,
  DeviceEvent,
  Device,
  EwOp,
  GemmOpts,
  OpAttrs,
  OpKind,
  PinnedBuffer,
  RedOp,
  RngKey,
  RngOp,
  Stream,
  TensorDesc,
} from '../backend.ts';
import {
  DEFAULT_TILING,
  SMALL_TILING,
  arangeKernel,
  argReduceKernel,
  binaryKernel,
  castKernel,
  fillKernel,
  gemmGrid,
  gemmIsExact,
  gemmKernel,
  gemmMmaFits,
  gemmMmaGrid,
  gemmMmaKernel,
  gatherKernel,
  indexSelectKernel,
  layerNormKernel,
  linearGrid,
  optimizerKernel,
  packParams,
  randomKernel,
  reduceKernel,
  rowGrid,
  scatterAddKernel,
  softmaxKernel,
  stridedCopyKernel,
  unaryKernel,
} from '../ir/index.ts';
import type { EwContext, EwInput, Expr, KernelIR, ScalarDType, VecWidth } from '../ir/index.ts';
import {
  BINARY,
  COMPARE,
  E,
  UNARY,
  classifyOperands,
  computeTypeFor,
  ewKernel,
  numel,
} from '../ir/index.ts';
import { chainKey, chainScalars } from '../fusion.ts';
import { contiguousStrides } from '../shape.ts';
import { KernelCache } from '../kernel-cache.ts';
import { poolFor } from '../pool.ts';
import type { PooledBuffer } from '../pool.ts';
import type { DriverBuffer, DriverExecutable, DriverKernel, GpuDriver } from './driver.ts';

/** Element types a GPU handles. `f64` and `i64` are CPU-only by design. */
/**
 * Smallest output side that pays for the larger tile.
 *
 * Both tilings launch 256 threads, but the 64x64 one gives each thread sixteen outputs
 * to the 32x32 one's four, so it reads far less shared memory per multiply. That only
 * helps once there is enough work to go round: a big tile over a small matrix leaves
 * most of the device idle, and measured on an M5 Max the 32x32 tiling is half again as
 * fast at 256 while the 64x64 one is nearly half again as fast at 2048. They are level
 * at 512, which is where this sits.
 */
const LARGE_TILE_SIDE = 512;

/**
 * The tiling to use for an output of this size.
 *
 * Both operands' extents matter rather than the total work: a tall, narrow multiply has
 * plenty of elements and still only covers a few tiles across, so it wants the smaller
 * tile even though its element count is large.
 *
 * @internal
 */
function gemmTiling(m: number, n: number) {
  return m >= LARGE_TILE_SIDE && n >= LARGE_TILE_SIDE ? DEFAULT_TILING : SMALL_TILING;
}

/**
 * Smallest multiply that takes the cooperative-matrix kernel, counted in `m * n * k`.
 *
 * This used to require both output extents to reach 1024, which followed from a sweep of
 * *square* multiplies and was not tested by it: every shape in a square sweep has large
 * extents and plenty of work together, so it cannot say which of the two mattered. It is
 * the work. `tests/tensor/gemm-selection.test.ts` measures both kernels alternately over
 * non-square shapes, and at or above this figure the matrix kernel wins everywhere —
 * 1.18x at 512x512x512, 1.20x at 128x1024x1024, 1.43x at 256x1024x1024, 1.35x at
 * 768x768x768. Below it the two trade places (0.81x at 256 cubed, 0.94x at 384 cubed,
 * and yet 1.16x at 512x256x256), so the boundary is drawn where the answer stops
 * depending on the shape rather than at the last winning measurement.
 *
 * The old rule was refusing the matrix kernel on ordinary transformer sizes: a 256 by 768
 * activation against a 768 by 768 weight divides its tiling exactly and was turned away
 * for having a short side.
 */
const MATRIX_MIN_WORK = 1 << 27;

const GPU_DTYPES: readonly DType[] = ['f32', 'f16', 'bf16', 'i32', 'u8', 'bool'];

/**
 * Longest row a row-per-thread kernel is used for.
 *
 * The motivating case is a row shorter than one SIMD group, where a
 * workgroup-per-row kernel cannot fill even a single group and its barriers
 * synchronise threads that mostly have nothing to do. Measured at 2M rows of 8 on
 * Apple silicon, row-per-thread is 2.3x faster through Metal and 2.7x through
 * Vulkan.
 *
 * The bound is well above the widest SIMD group in common hardware but far below
 * where a thread walking a row starts to hurt: consecutive threads read addresses
 * `cols` apart, so a long row turns one coalesced load into one cache line per
 * thread. That penalty is hardware-specific and this bound is set from Apple
 * measurements, so it stays conservative rather than chasing the last few percent on
 * rows long enough for the tree reduction to be fine anyway.
 */
/**
 * Queued operations allowed before dispatch refuses to queue more.
 *
 * Far above any real program's depth between two awaits, and far below what it takes
 * to exhaust memory, so it only ever catches a loop that never yields at all.
 */
const MAX_PENDING = 50_000;

const ROW_PER_THREAD_COLS = 256;

/**
 * Rows needed before a row-per-thread kernel is used, as a multiple of the largest
 * workgroup the device supports.
 *
 * Row-per-thread parallelises over rows and nothing else, so too few rows leaves
 * most of the device idle — and unlike the short-row case this is a cliff, not a
 * slope: 8 rows of 1M elements takes 197ms per iteration that way against 1.6ms for
 * the tree reduction, a 127x loss. Scaling the bar by `maxWorkgroup` tracks how much
 * work a device wants in flight better than a constant would.
 */
const ROW_PER_THREAD_OCCUPANCY = 16;

/** Operations that are not implemented on the GPU path. */
const UNSUPPORTED: ReadonlySet<OpKind> = new Set<OpKind>();


/**
 * A `DeviceBackend` backed by a GPU driver.
 */
export class GpuBackend implements DeviceBackend {
  readonly device: Device;
  readonly caps: BackendCaps;

  #driver: GpuDriver;
  #cache = new KernelCache<DriverKernel>();

  /**
   * Everything queued for this device, in order.
   *
   * Kernel compilation is asynchronous while dispatch must not block, so a launch
   * cannot always be submitted at the moment it is requested. Chaining every
   * operation — launches and host copies alike — onto one promise preserves program
   * order regardless: a copy queued after a launch runs after that launch has been
   * submitted and completed.
   *
   * Without this, a readback would memcpy out of memory the kernel had not written
   * yet, which reads as zeros rather than as an error.
   *
   * @internal
   */
  #queue: Promise<void> = Promise.resolve();

  #nextToken = 1;
  #disposed = false;

  /**
   * One word of device memory kernels write a fault code into.
   *
   * A kernel cannot throw, so an out-of-range index records itself here and the
   * next synchronisation point raises it — which is how the contract says device
   * errors surface. Allocated on first use, since a program that never indexes
   * never needs it.
   *
   * @internal
   */
  #status: DriverBuffer | null = null;

  constructor(driver: GpuDriver, index = 0) {
    this.#driver = driver;
    this.device = { type: driver.caps.type, index };
    this.caps = {
      class: 'kernel',
      kernelCompile: driver.caps.type === 'metal' ? 'msl' : 'spirv',
      dispatch: 'per-op',
      captureReplay: typeof driver.captureBegin === 'function',
      dtypes: driver.caps.f16 ? GPU_DTYPES : GPU_DTYPES.filter((d) => d !== 'f16'),
      subgroups: driver.caps.subgroups,
      cooperativeMatrix: driver.caps.matrix,
      // Staging exists whenever the device does not share memory.
      pinnedHost: !driver.hostVisible,
      unifiedMemory: driver.hostVisible,
    };
  }

  /** The driver's reported name. */
  get name(): string {
    return this.#driver.caps.name;
  }

  /**
   * The fault-reporting buffer, cleared and ready.
   *
   * @internal
   */
  #statusBuffer(): DriverBuffer {
    // Host-visible so the fault can be read without a staged transfer. Host-visible
    // memory is device-writable everywhere, just slower, and one word never matters.
    if (!this.#status) this.#status = this.#driver.allocHost(4);
    new Uint32Array(this.#status.host!)[0] = 0;
    return this.#status;
  }

  /**
   * Raise any fault a kernel recorded, then clear it.
   *
   * @internal
   */
  #checkStatus(): void {
    if (!this.#status) return;
    const view = new Uint32Array(this.#status.host!);
    const code = view[0]!;
    if (code === 0) return;
    view[0] = 0;
    throw new Error(
      `index ${code - 1} is out of range for the axis being gathered or scattered on ${this.device.type}. ` +
        'A kernel cannot throw, so this is reported at the next synchronisation point and may come ' +
        'from an earlier operation; set FINO_TENSOR_SYNC=1 to attribute it exactly.',
    );
  }

  /** Kernel cache counters. */
  cacheStats(): ReturnType<KernelCache<DriverKernel>['stats']> {
    return this.#cache.stats();
  }

  // -- memory ------------------------------------------------------------

  alloc(bytes: number): DeviceBuffer {
    return this.#driver.alloc(bytes) as unknown as DeviceBuffer;
  }

  free(buffer: DeviceBuffer): void {
    this.#deferFree(buffer as unknown as DriverBuffer);
  }

  /**
   * Buffers whose memory the device may still be reading, with the point it has to
   * reach before they can be destroyed.
   *
   * Freeing is not the same as recycling. The framework pool recycles most buffers,
   * which is harmless, but it destroys large ones outright — and a destroyed buffer
   * can still be bound in a command buffer that has been recorded and not yet
   * executed. Dispatches are batched, so that window is up to a whole batch wide
   * rather than a single launch, which is long enough for a garbage-collected tensor
   * to take memory out from under work already queued.
   *
   * @internal
   */
  #pendingFrees: { buffer: DriverBuffer; token: bigint }[] = [];

  /**
   * Hold a buffer until the device has passed everything recorded so far.
   *
   * @internal
   */
  #deferFree(buffer: DriverBuffer): void {
    this.#drainFrees();
    this.#pendingFrees.push({ buffer, token: this.#driver.submitted() });
  }

  /**
   * Destroy whatever the device has finished with.
   *
   * @internal
   */
  #drainFrees(): void {
    if (this.#pendingFrees.length === 0) return;
    const completed = this.#driver.completed();
    let kept = 0;
    for (const entry of this.#pendingFrees) {
      if (entry.token <= completed) this.#driver.free(entry.buffer);
      else this.#pendingFrees[kept++] = entry;
    }
    this.#pendingFrees.length = kept;
  }

  allocPinned(bytes: number): PinnedBuffer {
    // Always host-addressable: this is where readbacks land.
    return this.#driver.allocHost(bytes) as unknown as PinnedBuffer;
  }

  freePinned(buffer: PinnedBuffer): void {
    // Staging is read by a queued copy, so it is held on the same terms as any other
    // buffer rather than destroyed the moment the readback returns.
    this.#deferFree(buffer as unknown as DriverBuffer);
  }

  viewPinned(buffer: PinnedBuffer): Uint8Array {
    return new Uint8Array((buffer as unknown as DriverBuffer).host!);
  }

  /**
   * Append work to the device queue, preserving program order.
   *
   * @internal
   */
  #enqueue(work: () => Promise<void> | void): void {
    if (this.#pending >= MAX_PENDING) {
      // Queued work only runs on a microtask turn, so a loop that never awaits
      // anything can queue without limit and — because compilation is asynchronous
      // too — without a single launch reaching the device. Left alone this ends as an
      // out-of-memory crash with nothing to point at, so it is named here instead.
      throw new Error(
        `${MAX_PENDING} device operations are queued without the event loop running; ` +
          'await something (a readback, or any promise) inside the loop so queued work ' +
          'can be submitted and kernels can finish compiling',
      );
    }
    this.#pending++;
    this.#queue = this.#queue
      .then(work)
      .catch((cause) => {
        // Re-thrown from `sync`, so a failed launch surfaces at the next
        // synchronisation point with its own message rather than as an unhandled
        // rejection.
        this.#failure ??= cause instanceof Error ? cause : new Error(String(cause));
      })
      .then(() => {
        this.#pending--;
      });
  }

  /**
   * Queued operations that have not finished running.
   *
   * A launch may only bypass the queue when this is zero. Otherwise it would be
   * submitted ahead of work queued before it, which is the one thing the queue
   * exists to prevent.
   *
   * @internal
   */
  #pending = 0;

  /**
   * The first error a queued operation raised, surfaced at the next sync point.
   *
   * @internal
   */
  #failure: Error | null = null;

  copyH2D(dst: DeviceBuffer, dstOffset: number, src: Uint8Array): void {
    // Queued so an upload cannot overtake a kernel still reading the destination,
    // and copied because the caller's bytes may be gone by the time it runs.
    const bytes = src.slice();
    this.#enqueue(async () => {
      // Wait before touching the memory: on a shared-memory device this is a host
      // memcpy, and a kernel submitted earlier may still be reading or writing the
      // destination. Being queued is not enough — queue position guarantees
      // submission order, not completion.
      await this.#driver.wait(this.#driver.submitted());
      this.#driver.write(dst as unknown as DriverBuffer, dstOffset, bytes);
    });
  }

  copyD2H(
    dst: PinnedBuffer,
    src: DeviceBuffer,
    srcOffset: number,
    bytes: number,
  ): void {
    this.#enqueue(async () => {
      // `read` waits for work already submitted, so the values are the ones the
      // kernels produced rather than whatever the buffer held beforehand.
      const data = await this.#driver.read(
        src as unknown as DriverBuffer,
        srcOffset,
        bytes,
      );
      new Uint8Array((dst as unknown as DriverBuffer).host!).set(data);
    });
  }

  copyD2D(
    dst: DeviceBuffer,
    dstOffset: number,
    src: DeviceBuffer,
    srcOffset: number,
    bytes: number,
  ): void {
    this.#enqueue(async () => {
      // Same reasoning as an upload: a shared-memory copy is a host memcpy and must
      // not race a kernel that has been submitted but not finished.
      await this.#driver.wait(this.#driver.submitted());
      this.#driver.copy(
        dst as unknown as DriverBuffer,
        dstOffset,
        src as unknown as DriverBuffer,
        srcOffset,
        bytes,
      );
    });
  }

  // -- ordering ----------------------------------------------------------

  createStream(): Stream {
    // One queue per driver, so every stream names the same submission order.
    return { id: this.#nextToken++ };
  }

  createEvent(): DeviceEvent {
    return { id: this.#nextToken++ };
  }

  record(): void {
    // Submission order is the ordering; an event needs no separate marker.
  }

  streamWait(): void {}

  async eventDone(): Promise<void> {
    await this.sync();
  }

  /** Resolve once every queued operation has completed. */
  async sync(): Promise<void> {
    // The queue may grow while it drains, since awaiting it yields to code that can
    // enqueue more, so drain until it is stable.
    let seen: Promise<void> | null = null;
    while (seen !== this.#queue) {
      seen = this.#queue;
      await seen;
    }
    await this.#driver.wait(this.#driver.submitted());
    // The device has caught up, so every deferred free is now safe to carry out. Doing
    // it here bounds how long held memory can accumulate: a program that never
    // synchronises is also one that never frees a large buffer twice over.
    this.#drainFrees();
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = null;
      throw failure;
    }
    this.#checkStatus();
  }

  // -- kernel dispatch ---------------------------------------------------

  /**
   * Launch a kernel, compiling it first if necessary.
   *
   * Returns nothing: dispatch is fire-and-forget, and ordering is preserved because
   * a deferred launch's continuation runs before any later readback resolves.
   *
   * @internal
   */
  #run(
    build: () => { ir: KernelIR; key: string },
    buffers: readonly DeviceBuffer[],
    params: Readonly<Record<string, number>>,
    groups: readonly [number, number, number],
  ): void {
    // Built unconditionally, because the specialization key comes out of the builder
    // along with the IR and the key is what decides a cache hit. That makes every
    // launch pay for an IR it usually throws away. Now that the command-buffer cost is
    // batched away, host cost per launch is around 9 to 12 microseconds depending on
    // the backend, and this is one of the remaining pieces — splitting the key out from
    // the builder is where to look next, along with Vulkan's per-dispatch descriptor
    // set.
    const built = build();
    const driverBuffers = buffers as unknown as DriverBuffer[];

    // The fast path: a kernel already compiled and nothing queued ahead of it, which
    // is every launch after the first of its shape. Going through the queue instead
    // would cost a microtask turn per launch — and worse, a synchronous loop that
    // never yields would accumulate every launch as a pending closure rather than
    // submitting any of them, so a long compute loop grew until the process died.
    const ready = this.#pending === 0 && this.#driver.canLaunch()
      ? this.#cache.peekReady(built.key, this.#driver.target)
      : null;
    if (ready !== null) {
      const packed = packParams(built.ir.params, params);
      this.#driver.launch(ready, driverBuffers, packed, groups);
      return;
    }

    const packed = packParams(built.ir.params, params);
    if (this.#capturing) {
      // A capture records what is launched between its two ends, and a launch deferred
      // to a microtask would land outside that window — producing a recording missing
      // some of its work, which replays as silently wrong numbers rather than an error.
      // Running the step once before capturing it compiles its kernels and leaves the
      // fast path available, which is what makes capture possible at all.
      throw new Error(
        'cannot capture a launch that has to wait for a kernel compile or for the ' +
          'device; run the step once before capturing it',
      );
    }
    this.#enqueue(async () => {
      const kernel = await this.#cache.get({
        spec: built.key,
        target: this.#driver.target,
        compile: () => this.#driver.compile(built.ir),
      });
      // Per-dispatch resources are finite. Being here means either the kernel was not
      // compiled yet or the device is behind; the second needs waiting out, which is
      // possible here and not on the synchronous path.
      if (!this.#driver.canLaunch()) {
        await this.#driver.wait(this.#driver.submitted());
      }
      this.#driver.launch(kernel, driverBuffers, packed, groups);
    });
  }

  /** Whether launches are being recorded rather than submitted. @internal */
  #capturing = false;

  /** Recordings by handle id, so an `Executable` stays an opaque number. @internal */
  #executables = new Map<number, DriverExecutable>();

  /** @internal */
  #nextExecutable = 1;

  /**
   * Buffers each recording refers to, released when that recording is.
   *
   * @internal
   */
  #pinnedByExecutable = new Map<number, readonly PooledBuffer[]>();

  // -- capture plane (caps.captureReplay) -------------------------------

  captureBegin(): void {
    if (!this.#driver.captureBegin) {
      throw new Error(`${this.device.type} cannot capture`);
    }
    if (this.#capturing) throw new Error('a capture is already open');
    if (this.#pending !== 0) {
      throw new Error(
        'cannot capture while launches are still queued; await the previous step first',
      );
    }
    this.#capturing = true;
    // Everything released between here and `captureEnd` is held rather than reused. The
    // recording refers to buffers by address, so handing one back out would let the next
    // taker write into memory the replay still reads.
    poolFor(this).beginPinning();
    this.#driver.captureBegin();
  }

  captureEnd(): Executable {
    if (!this.#capturing) throw new Error('no capture is open');
    this.#capturing = false;
    const id = this.#nextExecutable++;
    this.#executables.set(id, this.#driver.captureEnd!());
    // The executable owns them now, and gives them back when it is destroyed.
    this.#pinnedByExecutable.set(id, poolFor(this).endPinning());
    return { id };
  }

  replay(executable: Executable): void {
    if (this.#capturing) throw new Error('cannot replay while a capture is open');
    const recorded = this.#executables.get(executable.id);
    if (recorded === undefined) throw new Error('unknown executable');
    this.#driver.replay!(recorded);
  }

  /** Release a recording. */
  destroyExecutable(executable: Executable): void {
    const recorded = this.#executables.get(executable.id);
    if (recorded === undefined) return;
    this.#executables.delete(executable.id);
    this.#driver.destroyExecutable?.(recorded);
    const held = this.#pinnedByExecutable.get(executable.id);
    if (held) {
      this.#pinnedByExecutable.delete(executable.id);
      poolFor(this).releasePinned(held);
    }
  }

  /**
   * The IR scalar type for a descriptor, rejecting CPU-only dtypes clearly.
   *
   * @internal
   */
  #scalar(desc: TensorDesc): ScalarDType {
    return irScalarFor(desc.dtype);
  }

  // -- operations --------------------------------------------------------

  elementwise(
    op: EwOp,
    inputs: readonly TensorDesc[],
    out: TensorDesc,
    attrs: OpAttrs | null,
  ): void {
    const count = numel(out.shape);
    if (count === 0) return;

    const outScalar = this.#scalar(out);
    const scalar = attrs && typeof attrs.scalar === 'number' ? attrs.scalar : null;
    const onLeft = attrs?.scalarSide === 'lhs';

    if (scalar !== null) {
      // A scalar operand rides in the parameter block, so one buffer is bound.
      const inputScalar = this.#scalar(inputs[0]!);
      const lanes = ewLanes(count, [{ dtype: inputScalar, layout: 'cont' }], outScalar, [inputs[0]!, out]);
      const groups = count / lanes;
      this.#run(
        () => buildScalarElementwise(op, inputScalar, outScalar, onLeft, lanes),
        [inputs[0]!.buffer, out.buffer],
        { n: groups, operand: scalar },
        linearGrid(groups),
      );
      return;
    }

    // An operand whose broadcast does not collapse to a leading or trailing run — a
    // size-one axis in the *middle* — cannot be indexed by the elementwise template,
    // which addresses operands arithmetically rather than by stride. Rather than
    // refuse the operation, stretch that operand into a contiguous scratch buffer
    // first; the strided copy exists precisely to express an arbitrary broadcast. It
    // costs a pass over the output, which is why it is a fallback and not the norm.
    const scratch: DriverBuffer[] = [];
    const resolved = inputs.map((input, index) => {
      const initial = classifyOperands(out.shape, [input.shape]).layouts[0]!;
      if (initial.class !== 'strided') return input;
      return this.#stretch(input, out.shape, scratch);
    });

    const { layouts } = classifyOperands(
      out.shape,
      resolved.map((input) => input.shape),
    );
    const ewInputs: EwInput[] = resolved.map((input, index) => ({
      dtype: this.#scalar(input),
      layout: layouts[index]!.class,
    }));
    const lanes = ewLanes(count, ewInputs, outScalar, [...resolved, out]);
    const groups = count / lanes;
    const params: Record<string, number> = { n: groups };
    layouts.forEach((layout, index) => {
      if (layout.class === 'outerBroadcast' || layout.class === 'innerBroadcast') {
        params[`inner${index}`] = layout.inner;
      }
    });

    this.#run(
      () => buildElementwise(op, ewInputs, outScalar, lanes),
      [...resolved.map((input) => input.buffer), out.buffer],
      params,
      linearGrid(groups),
    );
    // Read only by launches already queued ahead of the release, as in `reduce`.
    if (scratch.length > 0) this.#releaseScratch(scratch);
  }

  /**
   * Stretch an operand to the output's shape in a fresh contiguous buffer.
   *
   * The broadcast is expressed as strides — zero on every axis the operand does not
   * have, or has at size one — which is exactly what the strided copy consumes.
   *
   * @internal
   */
  #stretch(
    input: TensorDesc,
    shape: readonly number[],
    scratch: DriverBuffer[],
  ): TensorDesc {
    const own = contiguousStrides(input.shape);
    const rank = shape.length;
    const strides = new Array<number>(rank).fill(0);
    for (let i = 0; i < rank; i++) {
      const axis = input.shape.length - rank + i;
      if (axis < 0) continue;
      strides[i] = input.shape[axis] === 1 && shape[i] !== 1 ? 0 : own[axis]!;
    }
    const target: TensorDesc = {
      buffer: this.#scratchBuffer(numel(shape) * DTYPE_BYTES[input.dtype], scratch),
      dtype: input.dtype,
      shape: [...shape],
      strides: contiguousStrides(shape),
      offset: 0,
    };
    this.copyStrided(
      { buffer: input.buffer, dtype: input.dtype, shape: [...shape], strides, offset: input.offset },
      target,
    );
    return target;
  }

  elementwiseChain(
    steps: readonly ChainStep[],
    inputs: readonly TensorDesc[],
    out: TensorDesc,
  ): void {
    const count = numel(out.shape);
    if (count === 0) return;
    const outScalar = this.#scalar(out);
    const ewInputs: EwInput[] = inputs.map((input) => ({
      dtype: this.#scalar(input),
      layout: 'cont',
    }));
    // The key describes the chain's shape, not its constants, so a loop whose
    // coefficients change between steps still compiles one kernel.
    const shape = chainKey(steps);
    const constants = chainScalars(steps);
    const lanes = ewLanes(count, ewInputs, outScalar, [...inputs, out]);
    const groups = count / lanes;
    const params: Record<string, number> = { n: groups };
    constants.forEach((value, index) => {
      params[`k${index}`] = value;
    });

    this.#run(
      () =>
        ewKernel({
          op: `chain_${shape}`,
          inputs: ewInputs,
          out: outScalar,
          vec: lanes,
          scalars: constants.map((_, index) => ({ name: `k${index}`, type: 'f32' as const })),
          body: (values, ctx) => {
            const results: Expr[] = [];
            let nextConstant = 0;
            for (const step of steps) {
              const args = step.args.map((arg) =>
                arg.from === 'input'
                  ? values[arg.index]!
                  : arg.from === 'step'
                    ? results[arg.index]!
                    : ctx.scalar(`k${nextConstant++}`),
              );
              results.push(applyChainStep(step.op, args, ctx));
            }
            return results[results.length - 1]!;
          },
        }),
      [...inputs.map((input) => input.buffer), out.buffer],
      params,
      linearGrid(groups),
    );
  }

  cast(x: TensorDesc, out: TensorDesc): void {
    const count = numel(out.shape);
    if (count === 0) return;
    const lanes = ewLanes(count, [{ dtype: this.#scalar(x), layout: 'cont' }], this.#scalar(out), [x, out]);
    const groups = count / lanes;
    this.#run(
      () => castKernel(this.#scalar(x), this.#scalar(out), { vec: lanes }),
      [x.buffer, out.buffer],
      { n: groups },
      linearGrid(groups),
    );
  }

  reduce(op: RedOp, x: TensorDesc, out: TensorDesc, axes: readonly number[]): void {
    const count = numel(out.shape);
    if (count === 0) return;
    const dtype = this.#scalar(x);

    if (op === 'argmax' || op === 'argmin') {
      // An index reduction cannot be decomposed: the position it reports is
      // relative to the whole reduced extent, which axis-at-a-time would lose.
      // Every case the framework emits is a single axis or a full reduction, both
      // of which are contiguous runs.
      const { reduceSize, innerSize } = reductionExtents(x.shape, axes, op);
      this.#run(
        () => argReduceKernel({ op, dtype }),
        [x.buffer, out.buffer],
        { n: count, reduceSize, innerSize },
        linearGrid(count),
      );
      return;
    }

    // A contiguous run of axes is one kernel. A scattered set is reduced one axis
    // at a time, highest first so the remaining axis indices stay valid. Every
    // reduction here is associative, and reducing means axis-by-axis divides by
    // each axis's size in turn, whose product is the total count — so the answer
    // is the same either way.
    const runs = contiguousRuns(axes);
    let source = x;
    let shape = [...x.shape];
    const scratch: DriverBuffer[] = [];
    for (let step = runs.length - 1; step >= 0; step--) {
      const run = runs[step]!;
      const { reduceSize, innerSize } = reductionExtents(shape, run, op);
      const nextShape = shape.filter((_, axis) => !run.includes(axis));
      const last = step === 0;
      const target: TensorDesc = last
        ? out
        : {
            buffer: this.#scratchBuffer(numel(nextShape) * DTYPE_BYTES[out.dtype], scratch),
            dtype: out.dtype,
            shape: nextShape,
            strides: [],
            offset: 0,
          };
      const elements = numel(nextShape);
      this.#run(
        () => reduceKernel({ op, dtype: this.#scalar(source), out: this.#scalar(target) }),
        [source.buffer, target.buffer],
        { n: elements, reduceSize, innerSize },
        linearGrid(elements),
      );
      source = target;
      shape = nextShape;
    }
    // The intermediates are only read by launches already queued ahead of the
    // free, so releasing them on the queue is safe and keeps them off the pool.
    if (scratch.length > 0) this.#releaseScratch(scratch);
  }

  /**
   * Allocate a scratch buffer for a multi-step operation.
   *
   * Taken from the driver rather than the framework pool: it is never handed to a
   * `Tensor`, so it has no reference count and no lifetime beyond this dispatch.
   *
   * @internal
   */
  #scratchBuffer(bytes: number, into: DriverBuffer[]): DeviceBuffer {
    const buffer = this.#driver.alloc(Math.max(bytes, 4));
    into.push(buffer);
    return buffer as unknown as DeviceBuffer;
  }

  /**
   * Free scratch buffers once the launches that read them have been submitted.
   *
   * @internal
   */
  #releaseScratch(buffers: readonly DriverBuffer[]): void {
    this.#enqueue(async () => {
      await this.#driver.wait(this.#driver.submitted());
      for (const buffer of buffers) this.#driver.free(buffer);
    });
  }

  /**
   * Whether a row-wise kernel should give each thread a whole row rather than each
   * workgroup, which needs short rows *and* many of them.
   */
  #rowPerThread(rows: number, cols: number): boolean {
    if (cols > ROW_PER_THREAD_COLS) return false;
    return rows >= this.#driver.caps.maxWorkgroup * ROW_PER_THREAD_OCCUPANCY;
  }

  softmax(x: TensorDesc, out: TensorDesc, axis: number, log: boolean): void {
    const cols = x.shape[axis]!;
    if (cols === 0 || numel(x.shape) === 0) return;
    // Addressing the axis by stride means an interior axis needs no transpose.
    const inner = trailingExtent(x.shape, axis);
    const rows = numel(x.shape) / cols;
    if (rows === 0) return;
    if (this.#rowPerThread(rows, cols)) {
      this.#run(
        () => softmaxKernel({ dtype: this.#scalar(x), log, perThread: true }),
        [x.buffer, out.buffer],
        { rows, cols, inner },
        linearGrid(rows),
      );
      return;
    }
    const wg = rowWorkgroup(cols, this.#driver.caps.maxWorkgroup);
    this.#run(
      () => softmaxKernel({ dtype: this.#scalar(x), log, wg }),
      [x.buffer, out.buffer],
      { cols, inner },
      rowGrid(rows),
    );
  }

  layerNorm(
    x: TensorDesc,
    weight: TensorDesc | null,
    bias: TensorDesc | null,
    out: TensorDesc,
    axisSize: number,
    epsilon: number,
    rms: boolean,
  ): void {
    const rows = numel(x.shape) / Math.max(axisSize, 1);
    if (rows === 0 || axisSize === 0) return;
    const buffers: DeviceBuffer[] = [x.buffer];
    if (weight) buffers.push(weight.buffer);
    if (bias) buffers.push(bias.buffer);
    buffers.push(out.buffer);
    if (this.#rowPerThread(rows, axisSize)) {
      this.#run(
        () =>
          layerNormKernel({
            dtype: this.#scalar(x),
            rms,
            weight: weight !== null,
            bias: bias !== null,
            perThread: true,
          }),
        buffers,
        { rows, cols: axisSize, epsilon },
        linearGrid(rows),
      );
      return;
    }
    const wg = rowWorkgroup(axisSize, this.#driver.caps.maxWorkgroup);
    this.#run(
      () =>
        layerNormKernel({
          dtype: this.#scalar(x),
          rms,
          weight: weight !== null,
          bias: bias !== null,
          wg,
        }),
      buffers,
      { cols: axisSize, epsilon },
      rowGrid(rows),
    );
  }

  gemm(a: TensorDesc, b: TensorDesc, out: TensorDesc, opts: GemmOpts): void {
    if (numel(out.shape) === 0) return;
    const batched = opts.batch > 1;
    const params: Record<string, number> = { M: opts.m, N: opts.n, K: opts.k };
    if (batched) {
      // A stride of zero means the operand is shared across the batch, which is
      // how a broadcast batch dimension arrives.
      params.strideA = numel(a.shape) === opts.m * opts.k ? 0 : opts.m * opts.k;
      params.strideB = numel(b.shape) === opts.k * opts.n ? 0 : opts.k * opts.n;
      params.strideC = opts.m * opts.n;
    }
    // The matrix path when everything it needs holds: the device can compile it, the
    // operands are the half precision it is faster for, the shapes divide its tile since
    // it has no edge handling, and there is enough work for the margin to be real.
    // Anything else is the scalar kernel, which covers every case.
    const useMatrix =
      this.#driver.caps.matrix &&
      this.#scalar(a) === 'f16' &&
      !batched &&
      !opts.transA &&
      !opts.transB &&
      opts.m * opts.n * opts.k >= MATRIX_MIN_WORK &&
      gemmMmaFits(opts.m, opts.n, opts.k);
    if (useMatrix) {
      this.#run(
        () => gemmMmaKernel({ dtype: 'f16' }),
        [a.buffer, b.buffer, out.buffer],
        params,
        gemmMmaGrid(opts.m, opts.n),
      );
      return;
    }
    const tiling = gemmTiling(opts.m, opts.n);
    // Every tile lands wholly inside the matrix when each extent divides its tile, so
    // the bounds checks on every staged element and every write are known to pass and
    // can be left out. The kernel has always been able to do this; nothing but its
    // tests ever asked. It changes the emitted code, so it is part of the cache key and
    // an exact multiply and a ragged one of the same dtype get different kernels.
    const exact = gemmIsExact(opts.m, opts.n, opts.k, tiling);
    this.#run(
      () =>
        gemmKernel({
          dtype: this.#scalar(a),
          transA: opts.transA,
          transB: opts.transB,
          tiling,
          batched,
          noEdgeGuards: exact,
        }),
      [a.buffer, b.buffer, out.buffer],
      params,
      gemmGrid(opts.m, opts.n, tiling, opts.batch),
    );
  }

  copyStrided(x: TensorDesc, out: TensorDesc): void {
    const count = numel(out.shape);
    if (count === 0) return;
    // Outputs are always freshly allocated, so the kernel writes from zero. Anything
    // else would silently land in the wrong place, so it is refused rather than
    // ignored.
    if (out.offset !== 0) {
      throw new Error(`copyStrided cannot write into an offset view (offset ${out.offset})`);
    }
    const rank = Math.max(out.shape.length, 1);
    const params: Record<string, number> = { n: count, base: x.offset };
    for (let axis = 0; axis < rank; axis++) {
      params[`shape${axis}`] = out.shape[axis] ?? 1;
      params[`stride${axis}`] = x.strides[axis] ?? 0;
    }
    this.#run(
      () =>
        stridedCopyKernel({
          rank,
          from: this.#scalar(x),
          to: this.#scalar(out),
        }),
      [x.buffer, out.buffer],
      params,
      linearGrid(count),
    );
  }

  gather(x: TensorDesc, indices: TensorDesc, out: TensorDesc, axis: number): void {
    const elements = numel(out.shape);
    if (elements === 0) return;
    this.#run(
      () => gatherKernel({ dtype: this.#scalar(x) }),
      [x.buffer, indices.buffer, out.buffer, this.#statusBuffer() as unknown as DeviceBuffer],
      {
        n: elements,
        inner: trailingExtent(x.shape, axis),
        axisSize: x.shape[axis]!,
        outAxis: out.shape[axis]!,
      },
      linearGrid(elements),
    );
  }

  scatterAdd(
    out: TensorDesc,
    indices: TensorDesc,
    src: TensorDesc,
    axis: number,
  ): void {
    const elements = numel(src.shape);
    if (elements === 0) return;
    this.#run(
      () => scatterAddKernel({ dtype: this.#scalar(out) }),
      [indices.buffer, src.buffer, out.buffer, this.#statusBuffer() as unknown as DeviceBuffer],
      {
        n: elements,
        count: numel(indices.shape),
        inner: trailingExtent(out.shape, axis),
        axisSize: out.shape[axis]!,
      },
      linearGrid(elements),
    );
  }

  indexSelect(
    x: TensorDesc,
    indices: TensorDesc,
    out: TensorDesc,
    axis: number,
  ): void {
    const elements = numel(out.shape);
    if (elements === 0) return;
    this.#run(
      () => indexSelectKernel({ dtype: this.#scalar(x) }),
      [x.buffer, indices.buffer, out.buffer, this.#statusBuffer() as unknown as DeviceBuffer],
      {
        n: elements,
        count: numel(indices.shape),
        inner: trailingExtent(x.shape, axis),
        axisSize: x.shape[axis]!,
      },
      linearGrid(elements),
    );
  }

  fill(out: TensorDesc, value: number): void {
    const count = numel(out.shape);
    if (count === 0) return;
    this.#run(
      () => fillKernel({ dtype: this.#scalar(out) }),
      [out.buffer],
      { n: count, value },
      linearGrid(count),
    );
  }

  arange(out: TensorDesc, start: number, step: number): void {
    const count = numel(out.shape);
    if (count === 0) return;
    this.#run(
      () => arangeKernel({ dtype: this.#scalar(out) }),
      [out.buffer],
      { n: count, start, step },
      linearGrid(count),
    );
  }

  random(op: RngOp, out: TensorDesc, key: RngKey, attrs: OpAttrs | null): void {
    const count = numel(out.shape);
    if (count === 0) return;
    const params: Record<string, number> = {
      n: count,
      keyLo: key.key[0],
      keyHi: key.key[1],
      counter: key.counter,
    };
    if (op === 'uniform' || op === 'randint') {
      params.low = Number(attrs?.low ?? 0);
      params.high = Number(attrs?.high ?? 1);
    } else if (op === 'normal') {
      params.mean = Number(attrs?.mean ?? 0);
      params.stddev = Number(attrs?.stddev ?? 1);
    } else {
      params.p = Number(attrs?.p ?? 0.5);
    }
    this.#run(
      () => randomKernel({ kind: op, dtype: this.#scalar(out) }),
      [out.buffer],
      params,
      linearGrid(count),
    );
  }

  optimizerStep(
    kind: 'sgd' | 'adam',
    tensors: readonly TensorDesc[],
    attrs: OpAttrs,
  ): void {
    const count = numel(tensors[0]!.shape);
    if (count === 0) return;
    const momentum = kind === 'sgd' && tensors.length > 2;
    const decoupled = attrs.decoupled === true;
    const weightDecay = Number(attrs.decay ?? 0) !== 0;
    const params: Record<string, number> = {
      n: count,
      lr: Number(attrs.lr ?? 0),
      decay: Number(attrs.decay ?? 0),
    };
    if (momentum) params.momentum = Number(attrs.momentum ?? 0);
    if (kind === 'adam') {
      params.beta1 = Number(attrs.beta1 ?? 0.9);
      params.beta2 = Number(attrs.beta2 ?? 0.999);
      params.epsilon = Number(attrs.epsilon ?? 1e-8);
      params.corr1 = Number(attrs.corr1 ?? 1);
      params.corr2 = Number(attrs.corr2 ?? 1);
    }
    this.#run(
      () =>
        optimizerKernel({
          kind,
          dtype: this.#scalar(tensors[0]!),
          momentum,
          nesterov: attrs.nesterov === true,
          decoupled,
          weightDecay,
        }),
      tensors.map((t) => t.buffer),
      params,
      linearGrid(count),
    );
  }

  supportsOp(op: OpKind, operands: readonly TensorDesc[]): boolean {
    if (UNSUPPORTED.has(op)) return false;
    // `f64` and `i64` have no kernel-IR representation, so the framework must keep
    // those on the CPU.
    for (const operand of operands) {
      if (operand.dtype === 'f64' || operand.dtype === 'i64') return false;
    }
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.#cache.clear((kernel) => this.#driver.release(kernel));
    // Everything deferred is released here whatever the device has reached, since the
    // driver is going away and taking its memory with it.
    for (const entry of this.#pendingFrees) this.#driver.free(entry.buffer);
    this.#pendingFrees.length = 0;
    if (this.#status) this.#driver.free(this.#status);
    this.#driver.dispose();
  }
}

/**
 * Product of the axes after `axis`.
 *
 * This is the stride between successive elements along `axis`, which is what lets
 * one kernel address any axis rather than only the outermost or innermost.
 *
 * @internal
 */
function trailingExtent(shape: readonly number[], axis: number): number {
  let size = 1;
  for (let i = axis + 1; i < shape.length; i++) size *= shape[i]!;
  return Math.max(size, 1);
}

/**
 * Split a shape into the reduced extent and the trailing extent.
 *
 * The reduced axes must form a contiguous run, which covers a single axis and a
 * full reduction — everything the framework currently emits. A non-contiguous set
 * would need either a transpose or one kernel per axis, so it is refused with an
 * actionable message rather than silently producing wrong numbers.
 *
 * @internal
 */
function reductionExtents(
  shape: readonly number[],
  axes: readonly number[],
  op: RedOp,
): { reduceSize: number; innerSize: number } {
  if (axes.length === 0) return { reduceSize: 1, innerSize: numel(shape) };
  for (let i = 1; i < axes.length; i++) {
    if (axes[i]! !== axes[i - 1]! + 1) {
      throw new Error(
        `'${op}' over axes [${axes.join(', ')}] needs a contiguous run; an index reduction cannot be decomposed`,
      );
    }
  }
  let reduceSize = 1;
  for (const axis of axes) reduceSize *= shape[axis]!;
  let innerSize = 1;
  for (let i = axes[axes.length - 1]! + 1; i < shape.length; i++) innerSize *= shape[i]!;
  return { reduceSize, innerSize: Math.max(innerSize, 1) };
}

/**
 * Split sorted axes into maximal contiguous runs.
 *
 * Each run is one kernel launch; a scattered set becomes several.
 *
 * @internal
 */
function contiguousRuns(axes: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const axis of axes) {
    const last = runs[runs.length - 1];
    if (last && axis === last[last.length - 1]! + 1) last.push(axis);
    else runs.push([axis]);
  }
  return runs;
}

/**
 * Workgroup size for a row-per-workgroup kernel.
 *
 * A power of two no larger than the row, so the tree reduction is exact and no
 * thread idles through every iteration.
 *
 * @internal
 */
function rowWorkgroup(cols: number, maximum: number): number {
  let wg = 1;
  while (wg * 2 <= Math.min(cols, maximum, 1024)) wg *= 2;
  return Math.max(wg, 1);
}

/**
 * Build an elementwise kernel for a named operation.
 *
 * @internal
 */
function buildElementwise(
  op: EwOp,
  inputs: readonly EwInput[],
  out: ScalarDType,
  vec: VecWidth = 1,
): { ir: KernelIR; key: string } {
  if (inputs.length === 1) return unaryKernel(op, inputs[0]!, out, { vec });
  if (inputs.length === 2) return binaryKernel(op, [inputs[0]!, inputs[1]!], out, { vec });
  if (inputs.length === 3 && op === 'where') {
    // The condition arrives converted into the compute type, so testing it against
    // zero is how a boolean becomes a selector.
    return ewKernel({
      op: 'where',
      inputs,
      out,
      vec,
      body: ([condition, whenTrue, whenFalse], ctx) =>
        E.select(E.ne(condition!, ctx.lit(0)), whenTrue!, whenFalse!),
    });
  }
  throw new Error(`no GPU kernel for elementwise '${op}' with ${inputs.length} inputs`);
}

/**
 * Lanes an elementwise launch should use.
 *
 * One scalar per thread is what limits these kernels. They are not bandwidth-bound — a
 * write-only fill, a read-and-write unary and a two-read binary all cost about the same
 * per element while moving one, two and three words — and giving each thread more
 * elements changes nothing, which rules out scheduling. What is left is the width of a
 * single operation.
 *
 * Only contiguous operands qualify, and that is a property of the indexing rather than a
 * conservatism worth removing later. A vectorised buffer is indexed in vector units,
 * which coincides with element units only when the operand walks the output one element
 * at a time: a `scalar` operand would read four elements where it wants one broadcast,
 * and the broadcast layouts divide and modulo by a block size counted in elements. Both
 * keep the scalar kernel.
 *
 * Every operand must also start at the beginning of its buffer, which the elementwise
 * path already assumes — views are materialised before they reach here — but which a
 * four-wide load additionally needs for alignment rather than only for correctness.
 *
 * One-byte storage is excluded, which is a limitation of the lowering rather than of the
 * hardware. A comparison computes in `f32` and stores a `bool`, and MSL will not take a
 * ternary whose condition and result have different element widths — `bool4 ? int4 : int4`
 * is rejected where the scalar form is fine. Expressing a vector select as `select()`
 * would lift this, but comparisons are not what the width was measured to help, so the
 * narrow rule is the one that carries its weight.
 *
 * @internal
 */
function ewLanes(
  count: number,
  inputs: readonly EwInput[],
  out: ScalarDType,
  operands: readonly TensorDesc[],
): VecWidth {
  if (count % 4 !== 0) return 1;
  if (!inputs.every((input) => input.layout === 'cont')) return 1;
  const narrow = (dtype: ScalarDType) => dtype === 'bool' || dtype === 'u8';
  if (narrow(out) || inputs.some((input) => narrow(input.dtype))) return 1;
  return operands.every((operand) => operand.offset === 0) ? 4 : 1;
}

/**
 * Build a binary operation whose second operand is a scalar parameter.
 *
 * The framework folds a JS number into an attribute rather than materialising a
 * tensor for it, so the GPU path has to accept it the same way — as a push constant
 * with one buffer bound instead of two.
 *
 * @internal
 */
/**
 * Apply one chain step to operands already in the compute type.
 *
 * @internal
 */
function applyChainStep(op: EwOp, args: readonly Expr[], ctx: EwContext): Expr {
  const compare = COMPARE[op];
  if (compare) {
    // A comparison inside a chain yields one or zero rather than a boolean, so the
    // steps after it keep arithmetic in the same type.
    return E.select(compare(args[0]!, args[1]!, ctx), ctx.lit(1), ctx.lit(0));
  }
  if (args.length === 1) {
    const unary = UNARY[op];
    if (!unary) throw new Error(`no GPU kernel for elementwise '${op}' in a chain`);
    return unary(args[0]!, ctx);
  }
  if (args.length === 2) {
    const binary = BINARY[op];
    if (!binary) throw new Error(`no GPU kernel for elementwise '${op}' in a chain`);
    return binary(args[0]!, args[1]!, ctx);
  }
  if (args.length === 3 && op === 'where') {
    return E.select(E.ne(args[0]!, ctx.lit(0)), args[1]!, args[2]!);
  }
  throw new Error(`no GPU kernel for elementwise '${op}' with ${args.length} operands`);
}

function buildScalarElementwise(
  op: EwOp,
  input: ScalarDType,
  out: ScalarDType,
  onLeft: boolean,
  vec: VecWidth = 1,
): { ir: KernelIR; key: string } {
  const compare = COMPARE[op];
  const build = compare ?? BINARY[op];
  if (!build) throw new Error(`no GPU kernel for scalar elementwise '${op}'`);
  return ewKernel({
    op: `${op}_scalar${onLeft ? '_lhs' : ''}`,
    inputs: [{ dtype: input, layout: 'cont' }],
    out,
    vec,
    // A comparison computes in the operand's type and stores a boolean, so the
    // compute type is pinned to the input rather than derived from the output.
    compute: compare ? computeTypeFor(input) : undefined,
    scalars: [{ name: 'operand', type: 'f32' }],
    body: ([value], ctx) => {
      const operand = ctx.scalar('operand');
      const result = onLeft ? build(operand, value!, ctx) : build(value!, operand, ctx);
      return compare ? E.select(result, ctx.lit(1), ctx.lit(0)) : result;
    },
  });
}
