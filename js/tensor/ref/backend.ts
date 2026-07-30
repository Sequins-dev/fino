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

  optimizerStep(
    kind: 'sgd' | 'adam',
    tensors: readonly TensorDesc[],
    attrs: OpAttrs,
  ): void {
    const name: OpKind = kind === 'sgd' ? 'sgdStep' : 'adamStep';
    // The parameter is both an input and the output of an optimizer step.
    this.#run(name, tensors.slice(1), tensors[0]!, attrs);
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
