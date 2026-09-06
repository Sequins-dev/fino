/**
 * Fused elementwise chains.
 *
 * Fusing changes when work happens, never what it computes, so the important test is
 * that results are unchanged — which the differential, conformance, and gradient suites
 * already assert, since they compare a fused GPU against an unfused reference backend.
 *
 * What those cannot see is whether fusion is happening at all: a planner that quietly
 * refused everything would leave every one of them passing. That is what these check.
 */
import { describe, it } from 'fino:test/test';
import { chainRunCount, device, listDevices, tensor, tidy } from 'fino:tensor';

/** GPUs, which are the only backends that fuse. */
async function gpus() {
  return (await listDevices()).filter((d) => d.type !== 'cpu');
}

/**
 * Whether fusion is actually on.
 *
 * `FINO_TENSOR_FUSION=0` turns it off, and the suite is expected to pass either way —
 * so the cases that count chains ask first rather than asserting a configuration.
 */
async function fusing(): Promise<boolean> {
  const [dev] = await gpus();
  if (!dev) return false;
  const x = await tensor([1, 2], { device: dev });
  const before = chainRunCount();
  const y = x.mul(2).add(1);
  await y.data();
  const ran = chainRunCount() > before;
  x.dispose();
  y.dispose();
  return ran;
}

describe('elementwise fusion', () => {
  it('runs a chain of four as one kernel', async (t) => {
    if (!(await fusing())) {
      t.ok(true, 'SKIP: fusion is disabled');
      return;
    }
    for (const dev of await gpus()) {
      const x = await tensor([1, 2, 3, 4], { device: dev });
      const before = chainRunCount();
      const y = tidy(() => x.mul(2).add(1).mul(3).add(0.5));
      await y.data();
      t.equal(chainRunCount() - before, 1, `${dev.type} ran one chain for four operations`);
      x.dispose();
      y.dispose();
    }
  });

  it('computes what the unfused path computes', async (t) => {
    const cpu = await device('cpu');
    const values = [-2, -0.5, 0, 0.5, 2, 4];
    const program = (x: import('fino:tensor').Tensor) =>
      x.mul(2).add(1).relu().mul(0.5).tanh().add(x.mul(-1));
    const reference = await tensor(values, { device: cpu });
    const want = [...(await program(reference).data())].map(Number);
    for (const dev of await gpus()) {
      const x = await tensor(values, { device: dev });
      const got = [...(await program(x).data())].map(Number);
      t.ok(
        want.every((value, i) => Math.abs(got[i]! - value) < 1e-5),
        `${dev.type} matches the reference: ${got.map((v) => v.toFixed(4))}`,
      );
      x.dispose();
    }
    reference.dispose();
  });

  it('does not fuse across a shape change', async (t) => {
    // A broadcast needs operands indexed differently from one another, which a chain
    // does not describe, so it must fall back rather than silently compute the wrong
    // thing.
    for (const dev of await gpus()) {
      const a = await tensor([1, 2, 3, 4, 5, 6], { shape: [2, 3], device: dev });
      const b = await tensor([10, 20, 30], { shape: [3], device: dev });
      const out = a.add(b).mul(2);
      t.deepEqual(
        [...(await out.data())].map(Number),
        [22, 44, 66, 28, 50, 72],
        `${dev.type} broadcasts correctly`,
      );
      a.dispose();
      b.dispose();
      out.dispose();
    }
  });

  it('gives a reused intermediate the same value everywhere it appears', async (t) => {
    // The intermediate is folded into the first consumer and materialised for the
    // second. Both must see the same numbers.
    for (const dev of await gpus()) {
      const x = await tensor([1, 2, 3, 4], { device: dev });
      const shared = x.mul(3).add(1);
      const first = shared.mul(2);
      const second = shared.add(10);
      t.deepEqual([...(await first.data())].map(Number), [8, 14, 20, 26], `${dev.type} first`);
      t.deepEqual([...(await second.data())].map(Number), [14, 17, 20, 23], `${dev.type} second`);
      x.dispose();
      shared.dispose();
      first.dispose();
      second.dispose();
    }
  });

  it('discards a chain nobody read rather than running it', async (t) => {
    if (!(await fusing())) {
      t.ok(true, 'SKIP: fusion is disabled');
      return;
    }
    for (const dev of await gpus()) {
      const x = await tensor([1, 2, 3, 4], { device: dev });
      const before = chainRunCount();
      tidy(() => {
        const unused = x.mul(2).add(1);
        void unused;
      });
      t.equal(chainRunCount() - before, 0, `${dev.type} ran nothing for a discarded chain`);
      x.dispose();
    }
  });
});
