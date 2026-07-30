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
import type {
  BackendCaps,
  DeviceBackend,
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
  SMALL_TILING,
  arangeKernel,
  argReduceKernel,
  binaryKernel,
  castKernel,
  fillKernel,
  gemmGrid,
  gemmKernel,
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
import type { EwInput, KernelIR, ScalarDType } from '../ir/index.ts';
import { BINARY, COMPARE, E, classifyOperands, computeTypeFor, ewKernel, numel } from '../ir/index.ts';
import { KernelCache } from '../kernel-cache.ts';
import type { DriverBuffer, DriverKernel, GpuDriver } from './driver.ts';

/** Element types a GPU handles. `f64` and `i64` are CPU-only by design. */
const GPU_DTYPES: readonly DType[] = ['f32', 'f16', 'bf16', 'i32', 'u8', 'bool'];

/** Operations that are not implemented on the GPU path. */
const UNSUPPORTED: ReadonlySet<OpKind> = new Set<OpKind>(['gather']);


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
      captureReplay: false,
      dtypes: driver.caps.f16 ? GPU_DTYPES : GPU_DTYPES.filter((d) => d !== 'f16'),
      subgroups: driver.caps.subgroups,
      cooperativeMatrix: false,
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
    this.#driver.free(buffer as unknown as DriverBuffer);
  }

  allocPinned(bytes: number): PinnedBuffer {
    // Always host-addressable: this is where readbacks land.
    return this.#driver.allocHost(bytes) as unknown as PinnedBuffer;
  }

  freePinned(buffer: PinnedBuffer): void {
    this.#driver.free(buffer as unknown as DriverBuffer);
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
    this.#queue = this.#queue.then(work).catch((cause) => {
      // Re-thrown from `sync`, so a failed launch surfaces at the next
      // synchronisation point with its own message rather than as an unhandled
      // rejection.
      this.#failure ??= cause instanceof Error ? cause : new Error(String(cause));
    });
  }

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
    // Building the IR is cheap, but the key alone decides a cache hit, so build
    // lazily only when the cache misses.
    const built = build();
    const driverBuffers = buffers as unknown as DriverBuffer[];
    const packed = packParams(built.ir.params, params);
    this.#enqueue(async () => {
      const kernel = await this.#cache.get({
        spec: built.key,
        target: this.#driver.target,
        compile: () => this.#driver.compile(built.ir),
      });
      this.#driver.launch(kernel, driverBuffers, packed, groups);
    });
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
      this.#run(
        () =>
          buildScalarElementwise(op, inputScalar, outScalar, onLeft),
        [inputs[0]!.buffer, out.buffer],
        { n: count, operand: scalar },
        linearGrid(count),
      );
      return;
    }

    const { layouts } = classifyOperands(
      out.shape,
      inputs.map((input) => input.shape),
    );
    const ewInputs: EwInput[] = inputs.map((input, index) => ({
      dtype: this.#scalar(input),
      layout: layouts[index]!.class,
    }));
    const params: Record<string, number> = { n: count };
    layouts.forEach((layout, index) => {
      if (layout.class === 'outerBroadcast' || layout.class === 'innerBroadcast') {
        params[`inner${index}`] = layout.inner;
      }
    });

    this.#run(
      () => buildElementwise(op, ewInputs, outScalar),
      [...inputs.map((input) => input.buffer), out.buffer],
      params,
      linearGrid(count),
    );
  }

  cast(x: TensorDesc, out: TensorDesc): void {
    const count = numel(out.shape);
    if (count === 0) return;
    this.#run(
      () => castKernel(this.#scalar(x), this.#scalar(out)),
      [x.buffer, out.buffer],
      { n: count },
      linearGrid(count),
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

  softmax(x: TensorDesc, out: TensorDesc, axis: number, log: boolean): void {
    const cols = x.shape[axis]!;
    if (cols === 0 || numel(x.shape) === 0) return;
    // Addressing the axis by stride means an interior axis needs no transpose.
    const inner = trailingExtent(x.shape, axis);
    const rows = numel(x.shape) / cols;
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
    const wg = rowWorkgroup(axisSize, this.#driver.caps.maxWorkgroup);
    const buffers: DeviceBuffer[] = [x.buffer];
    if (weight) buffers.push(weight.buffer);
    if (bias) buffers.push(bias.buffer);
    buffers.push(out.buffer);
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
    this.#run(
      () =>
        gemmKernel({
          dtype: this.#scalar(a),
          transA: opts.transA,
          transB: opts.transB,
          tiling: SMALL_TILING,
          batched,
        }),
      [a.buffer, b.buffer, out.buffer],
      params,
      gemmGrid(opts.m, opts.n, SMALL_TILING, opts.batch),
    );
  }

  copyStrided(x: TensorDesc, out: TensorDesc): void {
    const count = numel(out.shape);
    if (count === 0) return;
    const rank = Math.max(out.shape.length, 1);
    const params: Record<string, number> = { n: count };
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

  gather(): void {
    throw new Error('gather is not implemented on the GPU path; use indexSelect');
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
): { ir: KernelIR; key: string } {
  if (inputs.length === 1) return unaryKernel(op, inputs[0]!, out);
  if (inputs.length === 2) return binaryKernel(op, [inputs[0]!, inputs[1]!], out);
  if (inputs.length === 3 && op === 'where') {
    // The condition arrives converted into the compute type, so testing it against
    // zero is how a boolean becomes a selector.
    return ewKernel({
      op: 'where',
      inputs,
      out,
      body: ([condition, whenTrue, whenFalse], ctx) =>
        E.select(E.ne(condition!, ctx.lit(0)), whenTrue!, whenFalse!),
    });
  }
  throw new Error(`no GPU kernel for elementwise '${op}' with ${inputs.length} inputs`);
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
function buildScalarElementwise(
  op: EwOp,
  input: ScalarDType,
  out: ScalarDType,
  onLeft: boolean,
): { ir: KernelIR; key: string } {
  const compare = COMPARE[op];
  const build = compare ?? BINARY[op];
  if (!build) throw new Error(`no GPU kernel for scalar elementwise '${op}'`);
  return ewKernel({
    op: `${op}_scalar${onLeft ? '_lhs' : ''}`,
    inputs: [{ dtype: input, layout: 'cont' }],
    out,
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
