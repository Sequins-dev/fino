/**
 * The capture plane: recording a run of work and submitting it again.
 *
 * A recording holds buffer addresses rather than values, so replaying repeats the same
 * arithmetic over whatever those buffers hold at the time. That is the whole contract,
 * and it is what makes a training step replayable: parameters are updated in place, so
 * the same recorded work applied again advances another step, while a caller who
 * allocates fresh tensors each iteration cannot replay at all.
 *
 * Skipped on devices whose backend does not report `captureReplay`.
 */
import { describe, it } from 'fino:test/test';
import { backendFor, listDevices } from 'fino:tensor/backend';
import type { DeviceBackend } from 'fino:tensor/backend';
import { tensor } from 'fino:tensor';
import type { Tensor } from 'fino:tensor';
import type { TensorDesc } from 'fino:tensor/backend';

/** A descriptor for a tensor; `describe` fills a caller-owned record. */
function desc(value: Tensor): TensorDesc {
  return value.describe({} as TensorDesc);
}

/** Backends that can record, with their device. */
async function capturing(): Promise<DeviceBackend[]> {
  const found: DeviceBackend[] = [];
  for (const device of await listDevices()) {
    const backend = backendFor(device);
    if (backend.caps.captureReplay) found.push(backend);
  }
  return found;
}

describe('capture plane', () => {
  it('refuses to capture where it says it cannot', async (t) => {
    for (const device of await listDevices()) {
      const backend = backendFor(device);
      if (backend.caps.captureReplay) {
        t.ok(backend.captureBegin, `${device.type} claims capture and provides it`);
        continue;
      }
      if (!backend.captureBegin) {
        t.ok(true, `${device.type} does not offer capture at all`);
        continue;
      }
      // Claiming the capability is what a caller checks, so a backend that does not
      // claim it has to refuse rather than record something it cannot replay.
      t.throws(
        () => backend.captureBegin?.(),
        /cannot capture/,
        `${device.type} refuses to capture`,
      );
    }
  });

  it('replays recorded work over the same memory', async (t) => {
    const backends = await capturing();
    if (backends.length === 0) {
      t.ok(true, 'SKIP: no backend here records');
      return;
    }
    for (const backend of backends) {
      const device = backend.device;
      const step = await tensor([1, 1, 1, 1], { device });
      const total = await tensor([0, 0, 0, 0], { device });

      // Accumulating in place: the output is also an input, so each run advances the
      // values rather than recomputing them. An idempotent recording would look the
      // same whether or not the replay actually ran.
      const accumulate = () =>
        backend.elementwise('add', [desc(total), desc(step)], desc(total), null);

      // Run it once before capturing: a launch that still needs its kernel compiled is
      // deferred to a microtask and would land outside the recording.
      accumulate();
      t.deepEqual([...(await total.data())].map(Number), [1, 1, 1, 1], `${device.type} warmed up`);

      backend.captureBegin!();
      accumulate();
      const executable = backend.captureEnd!();
      t.deepEqual(
        [...(await total.data())].map(Number),
        [1, 1, 1, 1],
        `${device.type} records without running`,
      );

      backend.replay!(executable);
      t.deepEqual([...(await total.data())].map(Number), [2, 2, 2, 2], `${device.type} replays it`);

      backend.replay!(executable);
      backend.replay!(executable);
      t.deepEqual(
        [...(await total.data())].map(Number),
        [4, 4, 4, 4],
        `${device.type} replays it as many times as asked`,
      );

      backend.destroyExecutable?.(executable);
      step.dispose();
      total.dispose();
    }
  });

  it('refuses to capture a launch it would have to defer', async (t) => {
    const backends = await capturing();
    if (backends.length === 0) {
      t.ok(true, 'SKIP: no backend here records');
      return;
    }
    const backend = backends[0]!;
    const device = backend.device;
    // A shape whose kernel has never been compiled, so the launch has to go through the
    // queue — which would leave it outside the recording.
    const a = await tensor(Array.from({ length: 37 }, (_, i) => i), { device });
    const out = await tensor(new Array(37).fill(0), { device });
    // Drain first: capture refuses to start while earlier launches are still queued.
    await out.data();
    backend.captureBegin!();
    t.throws(
      () => backend.elementwise('sqrt', [desc(a)], desc(out), null),
      /run the step once before capturing/,
      'an uncompiled kernel is refused rather than silently dropped',
    );
    backend.captureEnd!();
    a.dispose();
    out.dispose();
  });
});
