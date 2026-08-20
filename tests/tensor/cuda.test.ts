/**
 * Direct CUDA backend coverage.
 *
 * Skipped when the CUDA Driver API or NVRTC is unavailable. Set
 * `FINO_REQUIRE_CUDA=1` on an NVIDIA runner to turn absence into a failure.
 */
import { env } from 'fino:process';
import { describe, it } from 'fino:test/test';
import { device, gpuUnavailableReasons, listDevices, tensor } from 'fino:tensor';

const available = (await listDevices()).some((found) => found.type === 'cuda');
const reason = gpuUnavailableReasons().cuda ?? 'no CUDA device';

if (env.FINO_REQUIRE_CUDA === '1' && !available) {
  throw new Error(`FINO_REQUIRE_CUDA=1 but CUDA is unavailable: ${reason}`);
}

describe('CUDA tensor backend', () => {
  it('discovers a direct CUDA device and prefers it to Vulkan', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason}`);
      return;
    }
    const cuda = await device('cuda');
    t.equal(cuda.type, 'cuda', 'resolves cuda:0');
    t.equal((await device('auto')).type, 'cuda', 'auto prefers CUDA on NVIDIA');
  });

  it('compiles, launches, and reads a fused CUDA kernel', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason}`);
      return;
    }
    const cuda = await device('cuda');
    const left = await tensor([1, 2, 3, 4], { device: cuda });
    const right = await tensor([10, 20, 30, 40], { device: cuda });
    const result = left.add(right).mul(2).tanh();
    const got = Array.from(await result.data());
    const want = [11, 22, 33, 44].map((value) => Math.tanh(value * 2));
    for (let i = 0; i < got.length; i++) {
      t.ok(Math.abs(got[i]! - want[i]!) < 1e-6, `element ${i} matches`);
    }
    result.dispose();
    left.dispose();
    right.dispose();
  });

  it('executes f16 vector arithmetic through CUDA', async (t) => {
    if (!available) {
      t.ok(true, `SKIP: ${reason}`);
      return;
    }
    const value = await tensor([0.1, -2, 1024, 0.0004], {
      dtype: 'f16',
      device: await device('cuda'),
    });
    const doubled = value.mul(2);
    const roundTrip = await doubled.to('cpu');
    t.deepEqual(
      Array.from(await roundTrip.data()),
      [0.199951171875, -4, 2048, 0.0008001327514648438],
      'f16 vector arithmetic runs on CUDA',
    );
    roundTrip.dispose();
    doubled.dispose();
    value.dispose();
  });
});
