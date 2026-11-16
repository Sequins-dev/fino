/** Metal allocation ownership, including views that outlive their wrapper. */
import { describe, it } from 'fino:test/test';
import { Pointer } from 'fino:ffi';
import { detachArrayBuffer } from 'internal:serializer';
import { os, arch, env } from 'fino:process';
function fakeApi() {
  const objects = new Map<ArrayBuffer, { refs: number; bytes: ArrayBuffer }>();
  let device: ArrayBuffer;
  let buffer: ArrayBuffer;
  let failInfo = false;
  let failAllocation = false;
  let failContents = false;
  const make = (bytes: number) => {
    const handle = new ArrayBuffer(8);
    objects.set(handle, { refs: 1, bytes: new ArrayBuffer(bytes) });
    return handle;
  };
  return {
    objects,
    compile: async () => {
      throw new Error('not used by memory tests');
    },
    get device() {
      return device;
    },
    get buffer() {
      return buffer;
    },
    set failInfo(value: boolean) {
      failInfo = value;
    },
    set failAllocation(value: boolean) {
      failAllocation = value;
    },
    set failContents(value: boolean) {
      failContents = value;
    },
    createDevice() {
      return (device = make(0));
    },
    info() {
      if (failInfo) throw new Error('metadata failed');
      return { name: 'fake', unifiedMemory: true, maxBufferLength: 1024 };
    },
    createBuffer(_device: ArrayBuffer, length: number) {
      if (failAllocation) return null;
      return (buffer = make(length));
    },
    contents(handle: ArrayBuffer) {
      return failContents
        ? null
        : new BigUint64Array([Pointer.addr(objects.get(handle)!.bytes)]).buffer;
    },
    retain(handle: ArrayBuffer) {
      objects.get(handle)!.refs++;
      return handle;
    },
    release(handle: ArrayBuffer) {
      const object = objects.get(handle)!;
      if (--object.refs < 0) throw new Error('double release');
    },
  };
}
async function waitFor(t: any, check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  t.ok(check(), 'backing-store releases are drained');
}
describe('Metal memory ownership', () => {
  it('balances owned device references and failed initialization', async (t) => {
    const { openDevice } = await import('internal:metal');
    const api = fakeApi();
    const device = openDevice(api)!;
    t.equal(api.objects.get(api.device)!.refs, 1, 'Create result needs no extra retain');
    t.equal(device.info.name, 'fake');
    device.close();
    device.close();
    t.equal(api.objects.get(api.device)!.refs, 0);
    t.throws(() => device.allocate(1), /closed/);
    api.failInfo = true;
    t.throws(() => openDevice(api), /metadata failed/);
    t.equal(api.objects.get(api.device)!.refs, 0, 'failed metadata releases device');
    t.equal(openDevice({ ...fakeApi(), createDevice: () => null }), null);
  });
  it('validates sizes and keeps buffers independent of the device wrapper', async (t) => {
    const { openDevice } = await import('internal:metal');
    const api = fakeApi();
    const device = openDevice(api)!;
    for (const size of [-1, 0.5, NaN, Infinity, 1025, Number.MAX_SAFE_INTEGER + 1]) {
      t.throws(() => device.allocate(size), /length/);
    }
    api.failAllocation = true;
    t.throws(() => device.allocate(1), /allocation/);
    api.failAllocation = false;
    const buffer = device.allocate(0);
    t.equal(buffer.byteLength, 0);
    t.equal(buffer.view().byteLength, 0);
    device.close();
    t.equal(buffer.view().byteLength, 0);
    buffer.close();
    buffer.close();
    t.equal(api.objects.get(api.buffer)!.refs, 0);
    t.throws(() => buffer.view(), /closed/);
  });
  it('retains each alias until its backing store is released', async (t) => {
    const { openDevice } = await import('internal:metal');
    const api = fakeApi();
    using device = openDevice(api)!;
    const buffer = device.allocate(16);
    api.failContents = true;
    t.throws(() => buffer.view(), /contents/);
    t.equal(api.objects.get(api.buffer)!.refs, 1);
    api.failContents = false;
    const contents = api.contents;
    api.contents = () => new ArrayBuffer(8);
    t.throws(() => buffer.view(), /null/);
    t.equal(api.objects.get(api.buffer)!.refs, 1, 'failed view creation releases its retain');
    api.contents = contents;
    const first = buffer.view();
    const second = buffer.view();
    new Uint8Array(first)[3] = 91;
    t.equal(new Uint8Array(second)[3], 91, 'views alias native bytes');
    t.equal(api.objects.get(api.buffer)!.refs, 3);
    buffer.close();
    t.equal(new Uint8Array(first)[3], 91, 'closing owner preserves existing views');
    detachArrayBuffer(first);
    await waitFor(t, () => api.objects.get(api.buffer)!.refs === 1);
    t.equal(new Uint8Array(second)[3], 91);
    detachArrayBuffer(second);
    await waitFor(t, () => api.objects.get(api.buffer)!.refs === 0);
  });
  it('opens native shared storage when a Metal device is available', async (t) => {
    const { openDevice } = await import('internal:metal');
    using device = openDevice();
    if (!device) {
      t.ok(env.FINO_REQUIRE_METAL_DEVICE !== '1', 'a Metal device is required when requested');
      if (os !== 'darwin' || arch !== 'aarch64') t.equal(device, null);
      return;
    }
    t.ok(device.info.name.length > 0);
    t.ok(device.info.maxBufferLength >= 1024);
    const buffer = device.allocate(32);
    const first = buffer.view();
    const second = buffer.view();
    try {
      t.deepEqual(Array.from(new Uint8Array(first)), new Array(32).fill(0));
      new Float32Array(first)[2] = 3.5;
      t.equal(new Float32Array(second)[2], 3.5);
      buffer.close();
      device.close();
      t.equal(new Float32Array(second)[2], 3.5);
    } finally {
      buffer.close();
      detachArrayBuffer(first);
      detachArrayBuffer(second);
    }
  });
});
