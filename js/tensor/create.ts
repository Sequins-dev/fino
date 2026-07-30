/**
 * Host-to-device upload and default device selection.
 *
 * Separated from the public barrel so that `fino:tensor/nn` can build parameters
 * without importing `fino:tensor`, which would form a cycle through the operation
 * registry.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from './dtype.ts';
import { DTYPE_BYTES, f32ToBf16, f32ToF16 } from './dtype.ts';
import type { Device } from './backend.ts';
import { backendFor, requireDType, resolveDeviceSync } from './backend.ts';
import { computeStream } from './dispatch.ts';
import { currentGraph } from './graph.ts';
import { numel } from './shape.ts';
import { Storage, Tensor, allocStorage } from './tensor.ts';

/**
 * Device used when a caller does not name one, resolved on first use.
 *
 * Resolved lazily rather than at import so that loading `fino:tensor` does not
 * touch a GPU, and resolved through the same path `device('auto')` uses so that a
 * synchronously constructed layer and an awaited tensor never disagree about where
 * they live.
 *
 * @internal
 */
let selected: Device | null = null;

/** The device synchronous constructors allocate on. */
export function defaultDevice(): Device {
  selected ??= resolveDeviceSync('auto');
  return selected;
}

/** Choose the device synchronous constructors allocate on. */
export function setDefaultDevice(device: Device): void {
  selected = device;
}

/** Forget the resolved default, so the next use re-resolves it. */
export function resetDefaultDevice(): void {
  selected = null;
}

/**
 * Encode host values as the bytes a dtype stores.
 *
 * Half-precision values round exactly as an on-device store would, so a value
 * uploaded and a value computed agree.
 */
export function encodeValues(values: readonly number[], dtype: DType): Uint8Array {
  const bytes = new Uint8Array(values.length * DTYPE_BYTES[dtype]);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    switch (dtype) {
      case 'f64':
        view.setFloat64(i * 8, value, true);
        break;
      case 'f32':
        view.setFloat32(i * 4, value, true);
        break;
      case 'f16':
        view.setUint16(i * 2, f32ToF16(value), true);
        break;
      case 'bf16':
        view.setUint16(i * 2, f32ToBf16(value), true);
        break;
      case 'i64':
        view.setBigInt64(i * 8, BigInt(Math.trunc(value)), true);
        break;
      case 'i32':
        view.setInt32(i * 4, value, true);
        break;
      case 'u8':
        view.setUint8(i, value & 0xff);
        break;
      case 'bool':
        view.setUint8(i, value !== 0 ? 1 : 0);
        break;
    }
  }
  return bytes;
}

/**
 * Upload host values into a new tensor.
 *
 * Records no graph node: the values come from outside the computation, so there
 * is nothing to differentiate through.
 */
export function fromHostValues(
  values: readonly number[],
  shape: readonly number[],
  dtype: DType,
  device: Device,
  requiresGrad = false,
): Tensor {
  requireDType(device, dtype);
  const backend = backendFor(device);
  const stream = computeStream(backend);
  const bytes = Math.max(numel(shape) * DTYPE_BYTES[dtype], 1);
  const storage: Storage = allocStorage(backend, device, bytes, stream);
  const out = new Tensor({
    storage,
    shape,
    dtype,
    valueId: currentGraph().nextValue(),
    requiresGrad,
  });
  if (values.length > 0) {
    backend.copyH2D(storage.pooled.buffer, 0, encodeValues(values, dtype), stream);
  }
  return out;
}
