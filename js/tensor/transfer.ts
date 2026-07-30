/**
 * Moving tensors between devices.
 *
 * A transfer is a readback followed by an upload, so it is a synchronisation point
 * and therefore promise-shaped like every other one. Same-device transfers are the
 * identity rather than a copy, matching what callers writing `model.to(dev)` in a
 * setup path expect: calling it twice costs nothing the second time.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { Device } from './backend.ts';
import { requireDType, resolveDevice, sameDevice } from './backend.ts';
import { fromHostBytes } from './create.ts';
import { readBytes } from './readback.ts';
import type { Tensor } from './tensor.ts';

/**
 * Copy a tensor to another device.
 *
 * The result is a fresh leaf: gradients do not flow back across a transfer, because
 * `backward()` is synchronous and a transfer cannot be. Moving a parameter is
 * therefore something to do while setting a model up, not inside a step — the moved
 * tensor keeps `requiresGrad`, so it accumulates its own gradient on the new device
 * and the original is left behind rather than fed.
 *
 * `f64` and `i64` exist only on the CPU, so moving one to a GPU is refused rather
 * than narrowed; the error names the dtype and the device.
 */
export async function to(tensor: Tensor, target: 'auto' | string | Device): Promise<Tensor> {
  tensor.check();
  const device = await resolveDevice(target);
  if (sameDevice(tensor.device, device)) return tensor;
  // Checked before the readback so an impossible transfer costs nothing and reports
  // the destination rather than failing later inside an allocation.
  requireDType(device, tensor.dtype);
  const bytes = await readBytes(tensor);
  return fromHostBytes(bytes, tensor.shape, tensor.dtype, device, tensor.requiresGrad);
}
