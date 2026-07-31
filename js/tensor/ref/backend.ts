/**
 * The reference backend.
 *
 * Two roles, deliberately the same code. It is the correctness oracle every
 * accelerated backend is differentially tested against, and it is a *shipping*
 * universal fallback: a machine with no GPU still runs `fino:tensor`, just
 * slowly. That second property is what lets everything above depend on
 * `fino:tensor` unconditionally.
 *
 * Execution is inline: `enqueue` computes. Streams and events are inert tokens
 * and `eventDone` resolves immediately, which is indistinguishable from an
 * infinitely fast device and keeps a single dispatch path in the framework rather
 * than a branch per device class.
 *
 * It is not fast, and should never be quoted as this engine's performance. Large
 * operations block the event loop for their duration.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ref`; import from there.
 */
import type { DType } from '../dtype.ts';
import { DTYPES } from '../dtype.ts';
import type {
  BackendCaps,
  BackendProvider,
  Device,
  DeviceBackend,
  DeviceBuffer,
  DeviceEvent,
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
import { opByName } from '../ops/registry.ts';
import type { RefAccessor } from '../ops/registry.ts';
import { RefView, refAlloc } from './view.ts';
import type { RefBuffer } from './view.ts';
import { blasAvailable, blasGemm } from '../cpu/blas.ts';
import { numel } from '../shape.ts';

/** Every dtype; the reference backend is the universal fallback. */
const CAPS: BackendCaps = {
  class: 'kernel',
  kernelCompile: false,
  dispatch: 'per-op',
  captureReplay: false,
  dtypes: DTYPES,
  subgroups: false,
  cooperativeMatrix: false,
  pinnedHost: false,
  unifiedMemory: true,
};

/**
 * Turn a descriptor into a strided host view.
 *
 * @internal
 */
function viewOf(desc: TensorDesc): RefView {
  const buffer = (desc.buffer as RefBuffer).bytes;
  return new RefView(buffer, desc.dtype, desc.shape, desc.strides, desc.offset);
}

/**
 * Multiply through BLAS when the operands suit it.
 *
 * Returns false for anything it does not handle, which the caller answers with the
 * reference loop. The conditions are all about *not* silently doing something
 * different: only the two dtypes BLAS has, only contiguous operands, and only the
 * non-transposed form the reference loop itself assumes.
 *
 * @internal
 */
function blasGemm2D(
  a: TensorDesc,
  b: TensorDesc,
  out: TensorDesc,
  opts: GemmOpts,
): boolean {
  if (out.dtype !== 'f32' && out.dtype !== 'f64') return false;
  if (a.dtype !== out.dtype || b.dtype !== out.dtype) return false;
  // The framework materialises transposes before reaching a backend, so these are
  // always false today. Declining keeps this from being the one path that would
  // interpret them, and so disagree with the reference loop if that ever changed.
  if (opts.transA || opts.transB) return false;
  if ((opts.beta ?? 0) !== 0) return false;
  if (!isContiguous(a) || !isContiguous(b) || !isContiguous(out)) return false;
  if (opts.m === 0 || opts.n === 0 || opts.k === 0) return false;
  if (!blasAvailable()) return false;

  const { m, n, k, batch } = opts;
  // Zero for an operand that broadcasts over the batch, matching the reference loop.
  const aBatch = numel(a.shape) === m * k ? 0 : m * k;
  const bBatch = numel(b.shape) === k * n ? 0 : k * n;
  for (let index = 0; index < batch; index++) {
    const ok = blasGemm({
      transA: false,
      transB: false,
      m,
      n,
      k,
      alpha: 1,
      beta: 0,
      a: elementsOf(a, index * aBatch, m * k),
      lda: k,
      b: elementsOf(b, index * bBatch, k * n),
      ldb: n,
      c: elementsOf(out, index * m * n, m * n),
      ldc: n,
    });
    // A partial batch would leave the rest of the output untouched, so bail only
    // before the first call can have written anything.
    if (!ok) return index > 0;
  }
  return true;
}

/**
 * Whether a descriptor's strides are the row-major ones for its shape.
 *
 * @internal
 */
function isContiguous(desc: TensorDesc): boolean {
  let expected = 1;
  for (let axis = desc.shape.length - 1; axis >= 0; axis--) {
    if (desc.shape[axis] !== 1 && desc.strides[axis] !== expected) return false;
    expected *= desc.shape[axis]!;
  }
  return true;
}

/**
 * A typed-array window onto a descriptor's elements.
 *
 * BLAS takes pointers, and the FFI applies a view's byte offset, so this is what
 * positions a call on one batch item without copying.
 *
 * @internal
 */
function elementsOf(
  desc: TensorDesc,
  offset: number,
  count: number,
): Float32Array | Float64Array {
  const bytes = (desc.buffer as RefBuffer).bytes;
  const start = desc.offset + offset;
  return desc.dtype === 'f64'
    ? new Float64Array(bytes, start * 8, count)
    : new Float32Array(bytes, start * 4, count);
}

/**
 * Inert ordering token.
 *
 * @internal
 */
let nextToken = 1;

/**
 * The reference backend.
 */
export class RefBackend implements DeviceBackend {
  readonly device: Device;
  readonly caps = CAPS;

  constructor(index = 0) {
    this.device = { type: 'cpu', index };
  }

  // -- memory ------------------------------------------------------------

  alloc(bytes: number): DeviceBuffer {
    return refAlloc(bytes) as unknown as DeviceBuffer;
  }

  free(): void {
    // Host memory is reclaimed by the collector once the pool drops the buffer.
  }

  allocPinned(bytes: number): PinnedBuffer {
    return refAlloc(bytes) as unknown as PinnedBuffer;
  }

  freePinned(): void {}

  viewPinned(buffer: PinnedBuffer): Uint8Array {
    return new Uint8Array((buffer as unknown as RefBuffer).bytes);
  }

  copyH2D(dst: DeviceBuffer, dstOffset: number, src: Uint8Array): void {
    new Uint8Array((dst as unknown as RefBuffer).bytes).set(src, dstOffset);
  }

  copyD2H(
    dst: PinnedBuffer,
    src: DeviceBuffer,
    srcOffset: number,
    bytes: number,
  ): void {
    const from = new Uint8Array((src as unknown as RefBuffer).bytes, srcOffset, bytes);
    new Uint8Array((dst as unknown as RefBuffer).bytes).set(from);
  }

  copyD2D(
    dst: DeviceBuffer,
    dstOffset: number,
    src: DeviceBuffer,
    srcOffset: number,
    bytes: number,
  ): void {
    const from = new Uint8Array((src as unknown as RefBuffer).bytes, srcOffset, bytes);
    new Uint8Array((dst as unknown as RefBuffer).bytes).set(from, dstOffset);
  }

  // -- ordering ----------------------------------------------------------

  createStream(): Stream {
    return { id: nextToken++ };
  }

  createEvent(): DeviceEvent {
    return { id: nextToken++ };
  }

  record(): void {}

  streamWait(): void {}

  async eventDone(): Promise<void> {
    // Work has already run inline; the microtask hop keeps callers from
    // observing an ordering difference against a real device.
  }

  async sync(): Promise<void> {}

  // -- operations --------------------------------------------------------

  /**
   * Run a registered operation's reference kernel.
   *
   * @internal
   */
  #run(
    name: OpKind,
    inputs: readonly TensorDesc[],
    out: TensorDesc,
    attrs: OpAttrs | null,
  ): void {
    const spec = opByName(name);
    const views: RefAccessor[] = inputs.map(viewOf);
    spec.refImpl(views, viewOf(out), attrs);
  }

  elementwise(
    op: EwOp,
    inputs: readonly TensorDesc[],
    out: TensorDesc,
    attrs: OpAttrs | null,
  ): void {
    this.#run(op, inputs, out, attrs);
  }

  cast(x: TensorDesc, out: TensorDesc): void {
    this.#run('cast', [x], out, null);
  }

  reduce(
    op: RedOp,
    x: TensorDesc,
    out: TensorDesc,
    axes: readonly number[],
  ): void {
    this.#run(op, [x], out, { axes });
  }

  softmax(x: TensorDesc, out: TensorDesc, axis: number, log: boolean): void {
    this.#run(log ? 'logSoftmax' : 'softmax', [x], out, { axis });
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
    const inputs = [x];
    if (weight) inputs.push(weight);
    if (bias) inputs.push(bias);
    this.#run('layerNorm', inputs, out, {
      axisSize,
      epsilon,
      rms,
      hasWeight: weight !== null,
      hasBias: bias !== null,
    });
  }

  gemm(a: TensorDesc, b: TensorDesc, out: TensorDesc, opts: GemmOpts): void {
    // BLAS where it applies, which is most of the arithmetic a model does. It
    // declines rather than throws when it cannot help, and the loop below is both the
    // fallback and the oracle BLAS is checked against.
    if (blasGemm2D(a, b, out, opts)) return;
    this.#run('gemm', [a, b], out, {
      m: opts.m,
      n: opts.n,
      k: opts.k,
      batch: opts.batch,
      transA: opts.transA,
      transB: opts.transB,
      beta: opts.beta ?? 0,
    });
  }

  /**
   * Copy through the source descriptor's strides.
   *
   * Generic rather than routed through the registry: reshape, permute, and expand
   * all reduce to this one loop, differing only in the strides their caller
   * supplies. A permuted read is the output's shape walked with reordered
   * strides; a broadcast read is the same walk with zeros. Expressing all three
   * as strides is what keeps this a single implementation.
   */
  copyStrided(x: TensorDesc, out: TensorDesc): void {
    const src = viewOf(x);
    const dst = viewOf(out);
    for (let i = 0; i < dst.size; i++) dst.set(i, src.get(i));
  }

  gather(x: TensorDesc, indices: TensorDesc, out: TensorDesc, axis: number): void {
    this.#run('gather', [x, indices], out, { axis });
  }

  scatterAdd(
    out: TensorDesc,
    indices: TensorDesc,
    src: TensorDesc,
    axis: number,
  ): void {
    this.#run('scatterAdd', [indices, src], out, { axis });
  }

  indexSelect(x: TensorDesc, indices: TensorDesc, out: TensorDesc, axis: number): void {
    this.#run('indexSelect', [x, indices], out, { axis });
  }

  fill(out: TensorDesc, value: number): void {
    this.#run('fill', [], out, { value });
  }

  arange(out: TensorDesc, start: number, step: number): void {
    this.#run('arange', [], out, { start, step });
  }

  random(op: RngOp, out: TensorDesc, key: RngKey, attrs: OpAttrs | null): void {
    this.#run(op, [], out, {
      ...(attrs ?? {}),
      keyLo: key.key[0],
      keyHi: key.key[1],
      counter: key.counter,
    });
  }

  /**
   * Update parameters in place.
   *
   * Written out here rather than routed through the operation registry, because the
   * registry gives a kernel one output and this writes three — the parameter and both
   * moments. That is what makes it a primitive: the whole point is to touch each
   * buffer once instead of allocating a chain of intermediates.
   *
   * The arithmetic is the same as `optimizerKernel` emits, statement for statement,
   * because this is the oracle that kernel is checked against.
   */
  optimizerStep(
    kind: 'sgd' | 'adam',
    tensors: readonly TensorDesc[],
    attrs: OpAttrs,
  ): void {
    const parameter = viewOf(tensors[0]!);
    const gradient = viewOf(tensors[1]!);
    const lr = Number(attrs.lr ?? 0);
    const decay = Number(attrs.decay ?? 0);
    const decoupled = attrs.decoupled === true;

    if (kind === 'sgd') {
      const momentum = Number(attrs.momentum ?? 0);
      const nesterov = attrs.nesterov === true;
      const velocity = tensors.length > 2 ? viewOf(tensors[2]!) : null;
      for (let i = 0; i < parameter.size; i++) {
        const p = parameter.get(i);
        let g = gradient.get(i);
        let base = p;
        if (decay !== 0) {
          if (decoupled) base = p - p * lr * decay;
          else g = g + p * decay;
        }
        if (velocity) {
          const next = velocity.get(i) * momentum + g;
          velocity.set(i, next);
          parameter.set(i, base - (nesterov ? g + next * momentum : next) * lr);
        } else {
          parameter.set(i, base - g * lr);
        }
      }
      return;
    }

    const m = viewOf(tensors[2]!);
    const v = viewOf(tensors[3]!);
    const beta1 = Number(attrs.beta1 ?? 0.9);
    const beta2 = Number(attrs.beta2 ?? 0.999);
    const epsilon = Number(attrs.epsilon ?? 1e-8);
    const corr1 = Number(attrs.corr1 ?? 1);
    const corr2 = Number(attrs.corr2 ?? 1);
    for (let i = 0; i < parameter.size; i++) {
      const p = parameter.get(i);
      let g = gradient.get(i);
      let base = p;
      if (decay !== 0) {
        if (decoupled) base = p - p * lr * decay;
        else g = g + p * decay;
      }
      const mNext = m.get(i) * beta1 + g * (1 - beta1);
      const vNext = v.get(i) * beta2 + g * g * (1 - beta2);
      m.set(i, mNext);
      v.set(i, vNext);
      parameter.set(i, base - (mNext / corr1 / (Math.sqrt(vNext / corr2) + epsilon)) * lr);
    }
  }

  supportsOp(op: OpKind): boolean {
    // The fallback runs everything, which is what makes partitioning total.
    void op;
    return true;
  }
}

/** Provider for the reference backend. Always available, lowest priority. */
export const refProvider: BackendProvider = {
  type: 'cpu',
  priority: 0,
  async probe(): Promise<DeviceBackend[]> {
    return refProvider.probeSync!();
  },
  probeSync(): DeviceBackend[] {
    return [new RefBackend()];
  },
};

/** Dtypes the reference backend supports, for the harness. */
export function refDTypes(): readonly DType[] {
  return CAPS.dtypes;
}
