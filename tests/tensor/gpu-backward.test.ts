/**
 * Gradients on the GPU, against the reference oracle.
 *
 * The differential suite compares *forward* results, and `gradCheck` validates the
 * tape against finite differences on the CPU in f64. Neither compared a GPU's
 * gradients to the oracle's, which left the entire backward pass on both GPU backends
 * without differential coverage.
 *
 * What that gap hid was not a GPU defect but an oracle one: the reference backend
 * dropped `keepDims` on the way into its reduction kernel, so every gradient that
 * reduces over a broadcast axis — which is every weight gradient in a model taking
 * batched input — was wrong on the CPU and right on the GPU. Cross-device comparison
 * could never have found it; the values checked against hand arithmetic in
 * `core.test.ts` are what pin it down. This suite catches the converse.
 *
 * Each case runs the same program on the reference backend and on every GPU, and
 * compares the gradient rather than the result.
 */
import { describe, it } from 'fino:test/test';
import { device, listDevices, tensor } from 'fino:tensor';
import type { Tensor } from 'fino:tensor';
import { compareValues, describeComparison, sampleValues } from 'internal:tensor/harness';

/** One differentiable program. */
interface Case {
  name: string;
  shape: number[];
  run: (x: Tensor) => Tensor;
  tolerance?: number;
}

const CASES: Case[] = [
  { name: 'scaled sum', shape: [4, 6], run: (x) => x.mul(2).sum() },
  { name: 'softmax over the last axis', shape: [4, 6], run: (x) => x.softmax(1).mul(3).sum() },
  {
    name: 'softmax over the last axis of a rank-three tensor',
    shape: [2, 4, 5],
    run: (x) => x.softmax(-1).mul(3).sum(),
  },
  { name: 'log softmax', shape: [4, 6], run: (x) => x.logSoftmax(1).mul(3).sum() },
  {
    name: 'batched matmul with a transpose',
    shape: [3, 4, 5],
    run: (x) => x.matmul(x.transpose()).sum(),
  },
  {
    name: 'reduction keeping dimensions',
    shape: [4, 6],
    run: (x) => x.sum([1], true).mul(2).sum(),
  },
  { name: 'broadcast', shape: [4, 1], run: (x) => x.expand([4, 6]).mul(2).sum() },
  {
    name: 'permuted rank four',
    shape: [2, 2, 3, 4],
    run: (x) => x.permute([0, 2, 1, 3]).mul(2).sum(),
  },
  {
    name: 'reshape around a permute, as attention does',
    shape: [2, 6, 4],
    run: (x) => x.reshape([2, 6, 2, 2]).permute([0, 2, 1, 3]).reshape([4, 6, 2]).mul(2).sum(),
  },
  {
    // The shape attention actually has: split into heads, fold them into the batch,
    // score, mask, softmax, attend, and merge back. Built from one input so the
    // gradient is a single tensor to compare.
    name: 'attention shaped',
    shape: [2, 6, 8],
    run: (x) => {
      const heads = (v: Tensor): Tensor =>
        v.reshape([2, 6, 2, 4]).permute([0, 2, 1, 3]).reshape([4, 6, 4]);
      const q = heads(x);
      const k = heads(x.mul(0.5));
      const v = heads(x.add(1));
      const scores = q.matmul(k.transpose()).mul(0.5).softmax(-1);
      const attended = scores.matmul(v);
      return attended.reshape([2, 2, 6, 4]).permute([0, 2, 1, 3]).reshape([2, 6, 8]).sum();
    },
  },
];

describe('GPU gradients against the oracle', () => {
  it('matches the reference backward pass', async (t) => {
    const cpu = await device('cpu');
    const gpus = (await listDevices()).filter((d) => d.type !== 'cpu');
    for (const testCase of CASES) {
      const count = testCase.shape.reduce((a, b) => a * b, 1);
      const values = sampleValues(count, count + 3);

      const reference = await tensor(values, {
        shape: testCase.shape,
        device: cpu,
        requiresGrad: true,
      });
      testCase.run(reference).backward();
      const expected = await reference.grad!.data();

      for (const dev of gpus) {
        const x = await tensor(values, {
          shape: testCase.shape,
          device: dev,
          requiresGrad: true,
        });
        testCase.run(x).backward();
        const result = compareValues(await x.grad!.data(), expected, 'f32', count);
        t.ok(result.ok, describeComparison(result, `${testCase.name} on ${dev.type}`));
        x.dispose();
      }
      reference.dispose();
    }
  });

  it('differentiates softmax over an interior axis', async (t) => {
    // This used to throw: the gradient broadcasts a reduction back over a middle axis,
    // which the elementwise template cannot address because it indexes operands
    // arithmetically rather than by stride. Such an operand is now stretched into a
    // contiguous buffer first.
    const cpu = await device('cpu');
    for (const shape of [
      [2, 4, 5],
      [2, 3, 4, 2],
    ]) {
      for (const axis of [1, shape.length - 2]) {
        const count = shape.reduce((a, b) => a * b, 1);
        const values = sampleValues(count, count + axis);
        const reference = await tensor(values, { shape, device: cpu, requiresGrad: true });
        reference.softmax(axis).mul(3).sum().backward();
        const expected = await reference.grad!.data();

        for (const dev of (await listDevices()).filter((d) => d.type !== 'cpu')) {
          const x = await tensor(values, { shape, device: dev, requiresGrad: true });
          x.softmax(axis).mul(3).sum().backward();
          const result = compareValues(await x.grad!.data(), expected, 'f32', count);
          t.ok(
            result.ok,
            describeComparison(
              result,
              `softmax axis ${axis} of [${shape.join(', ')}] on ${dev.type}`,
            ),
          );
          x.dispose();
        }
        reference.dispose();
      }
    }
  });
});
