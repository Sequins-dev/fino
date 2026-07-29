/**
 * Reading tensor values back to the host.
 *
 * The only synchronisation points in the programming model. A readback issues a
 * device-to-host copy, records an event, and awaits it — which parks a worker on
 * a fence and resolves through the runtime's wake pipe rather than blocking the
 * event loop. A training loop can serve HTTP or stream logs while a step runs.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType, HostArray } from './dtype.ts';
import { DTYPE_BYTES, bf16ToF32, f16ToF32, viewAs } from './dtype.ts';
import type { PinnedBuffer } from './backend.ts';
import { computeStream } from './dispatch.ts';
import type { Storage, Tensor } from './tensor.ts';

/**
 * Readbacks with a worker parked on their fence.
 *
 * Holds storage strongly so a tensor cannot be freed underneath an in-flight
 * copy — neither by `dispose()` nor by the collector.
 *
 * @internal
 */
const inFlight = new Map<number, { storage: Storage; staging: PinnedBuffer }>();

/**
 * @internal
 */
let nextTicket = 1;

/** Number of readbacks currently in flight, for diagnostics and tests. */
export function pendingReadbacks(): number {
  return inFlight.size;
}

/**
 * Read a tensor's elements to the host.
 *
 * Non-contiguous tensors are materialised first, because a strided copy on the
 * device is cheaper than reading the whole buffer and re-indexing on the host.
 */
export async function readTensor(tensor: Tensor): Promise<HostArray> {
  tensor.check();
  const source = tensor.contiguous ? tensor : materialize(tensor);
  const backend = source.backend;
  const stream = computeStream(backend);
  const bytes = source.size * DTYPE_BYTES[source.dtype];

  if (bytes === 0) return viewAs(source.dtype, new ArrayBuffer(0), 0, 0);

  const staging = backend.allocPinned(bytes);
  const ticket = nextTicket++;
  source.storage.retain();
  inFlight.set(ticket, { storage: source.storage, staging });

  try {
    backend.copyD2H(
      staging,
      source.storage.pooled.buffer,
      source.offset * DTYPE_BYTES[source.dtype],
      bytes,
      stream,
    );
    const event = backend.createEvent();
    backend.record(event, stream);
    await backend.eventDone(event);

    // Zero-copy where the backend can manage it; the copy below is what makes
    // the returned array safe to hold after the staging slot is recycled.
    const raw = backend.viewPinned(staging);
    return decode(source.dtype, raw.subarray(0, bytes));
  } finally {
    inFlight.delete(ticket);
    source.storage.release();
    backend.freePinned(staging);
    if (source !== tensor) source.dispose();
  }
}

/** Read a one-element tensor. */
export async function readScalar(tensor: Tensor): Promise<number> {
  if (tensor.size !== 1) {
    throw new Error(
      `item() needs exactly one element but the tensor has shape [${tensor.shape.join(', ')}]`,
    );
  }
  const values = await readTensor(tensor);
  const value = values[0]!;
  if (typeof value === 'bigint') {
    if (value > 9007199254740991n || value < -9007199254740991n) {
      throw new Error(`${value} cannot be represented exactly as a JS number`);
    }
    return Number(value);
  }
  return value;
}

/**
 * Turn staged bytes into the host array a dtype reads back as.
 *
 * Half-precision dtypes have no host array type, so they are converted to
 * `Float32Array`. That copy is documented rather than hidden: it is the only
 * place readback is not a view.
 *
 * @internal
 */
function decode(dtype: DType, bytes: Uint8Array): HostArray {
  // Copy out of the staging slot so the result outlives its recycling.
  const owned = bytes.slice();
  if (dtype === 'f16' || dtype === 'bf16') {
    const bits = new Uint16Array(owned.buffer, owned.byteOffset, owned.byteLength / 2);
    const out = new Float32Array(bits.length);
    const convert = dtype === 'f16' ? f16ToF32 : bf16ToF32;
    for (let i = 0; i < bits.length; i++) out[i] = convert(bits[i]!);
    return out;
  }
  return viewAs(dtype, owned.buffer, owned.byteOffset, owned.byteLength / DTYPE_BYTES[dtype]);
}

/**
 * Hook installed by the operation modules so this one does not import them.
 *
 * @internal
 */
let materializeHook: ((t: Tensor) => Tensor) | null = null;

/** Install the copy used to make a strided tensor contiguous. */
export function installReadbackHooks(hook: (t: Tensor) => Tensor): void {
  materializeHook = hook;
}

/**
 * @internal
 */
function materialize(tensor: Tensor): Tensor {
  if (!materializeHook) throw new Error('readback hooks are not installed');
  return materializeHook(tensor);
}
