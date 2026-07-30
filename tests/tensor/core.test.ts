/**
 * Tests for fino:tensor — dtypes, shapes, dispatch, lifecycle, and the graph.
 *
 * These assert the rules `specs/tensor-contract.md` specifies, in the acceptance
 * shapes its §12 names.
 */
import { describe, it } from 'fino:test/test';
import {
  DTYPES,
  arange,
  bf16ToF32,
  broadcastShapes,
  concat,
  currentGraph,
  device,
  f16ToF32,
  f32ToBf16,
  f32ToF16,
  full,
  matmulShape,
  noGrad,
  ones,
  onesLike,
  poolStats,
  promote,
  promoteScalar,
  roundToDType,
  tensor,
  tidy,
  keep,
  zeros,
} from 'fino:tensor';

describe('dtype promotion', () => {
  it('is commutative over every pair', (t) => {
    for (const a of DTYPES) {
      for (const b of DTYPES) {
        t.equal(promote(a, b), promote(b, a), `promote(${a}, ${b}) is symmetric`);
      }
    }
  });
  it('widens within a category', (t) => {
    t.equal(promote('u8', 'i32'), 'i32', 'u8 with i32');
    t.equal(promote('i32', 'i64'), 'i64', 'i32 with i64');
    t.equal(promote('f32', 'f64'), 'f64', 'f32 with f64');
    t.equal(promote('bool', 'u8'), 'u8', 'bool with u8');
  });
  it('lets a float dominate an integer of any width', (t) => {
    t.equal(promote('i64', 'f16'), 'f16', 'an i64 does not widen an f16');
    t.equal(promote('i32', 'f32'), 'f32', 'i32 with f32');
  });
  it('widens past both f16 and bf16 when they meet', (t) => {
    // Neither can represent the other's range, so promoting to either would lose
    // information silently.
    t.equal(promote('f16', 'bf16'), 'f32', 'f16 with bf16 becomes f32');
  });
  it('treats a JS number as weak', (t) => {
    t.equal(promoteScalar('f16', 2), 'f16', 'an integral scalar keeps f16');
    t.equal(promoteScalar('f16', 2.5), 'f16', 'a fractional scalar keeps f16');
    t.equal(promoteScalar('i32', 2), 'i32', 'an integral scalar keeps i32');
    t.equal(promoteScalar('i32', 2.5), 'f32', 'a fractional scalar promotes an int');
    t.equal(promoteScalar('bool', 1), 'i32', 'bool with an integral scalar');
  });
});

describe('half precision', () => {
  it('round-trips representable values', (t) => {
    for (const value of [0, 1, -1, 0.5, 2048, -0.25]) {
      t.equal(f16ToF32(f32ToF16(value)), value, `f16 round-trip of ${value}`);
      t.equal(bf16ToF32(f32ToBf16(value)), value, `bf16 round-trip of ${value}`);
    }
  });
  it('rounds to nearest even', (t) => {
    // 1 + 2^-11 sits exactly between two f16 values and must round to even.
    const midpoint = 1 + 2 ** -11;
    t.equal(f16ToF32(f32ToF16(midpoint)), 1, 'ties round to even');
  });
  it('handles overflow and subnormals', (t) => {
    t.equal(f16ToF32(f32ToF16(1e6)), Infinity, 'overflow becomes infinity');
    t.equal(f16ToF32(f32ToF16(1e-8)), 0, 'underflow becomes zero');
    t.ok(f16ToF32(f32ToF16(1e-6)) > 0, 'a subnormal survives');
  });
  it('preserves special values', (t) => {
    t.ok(Number.isNaN(f16ToF32(f32ToF16(NaN))), 'NaN stays NaN in f16');
    t.ok(Number.isNaN(bf16ToF32(f32ToBf16(NaN))), 'NaN stays NaN in bf16');
    t.equal(f16ToF32(f32ToF16(-Infinity)), -Infinity, 'negative infinity survives');
  });
  it('rounds through storage precision', (t) => {
    // bf16 keeps 8 mantissa bits, so 1.1 is visibly coarser than in f32.
    t.notEqual(roundToDType('bf16', 1.1), 1.1, 'bf16 is coarse');
    t.equal(roundToDType('f32', 0.5), 0.5, 'f32 keeps exact halves');
    t.equal(roundToDType('i32', 2.7), 2, 'integers truncate towards zero');
    t.equal(roundToDType('u8', 300), 255, 'narrow integers clamp');
    t.equal(roundToDType('bool', 5), 1, 'bool normalises to 0 or 1');
  });
});

describe('broadcasting', () => {
  it('right-aligns and stretches size-1 axes', (t) => {
    t.deepEqual(broadcastShapes([3, 1], [3, 4]), [3, 4], 'column stretches');
    t.deepEqual(broadcastShapes([4], [3, 4]), [3, 4], 'rank pads on the left');
    t.deepEqual(broadcastShapes([], [2, 2]), [2, 2], 'rank 0 broadcasts anywhere');
    t.deepEqual(broadcastShapes([1, 1], [5, 6]), [5, 6], 'both axes stretch');
  });
  it('names the axis and both shapes when incompatible', (t) => {
    t.throws(
      () => broadcastShapes([3, 2], [3, 4]),
      /axis 1 has sizes 2 and 4/,
      'error is specific enough to act on',
    );
  });
  it('handles zero-sized axes', (t) => {
    t.deepEqual(broadcastShapes([0, 3], [1, 3]), [0, 3], 'an empty axis stays empty');
  });
});

describe('matmul shape inference', () => {
  it('multiplies matrices', (t) => {
    const info = matmulShape([2, 3], [3, 4]);
    t.deepEqual(info.out, [2, 4], 'output shape');
    t.equal(info.k, 3, 'shared dimension');
  });
  it('promotes 1-D operands and drops the promoted axis', (t) => {
    t.deepEqual(matmulShape([3], [3, 4]).out, [4], 'vector times matrix');
    t.deepEqual(matmulShape([2, 3], [3]).out, [2], 'matrix times vector');
    t.deepEqual(matmulShape([3], [3]).out, [], 'vector dot vector is a scalar');
  });
  it('broadcasts leading axes', (t) => {
    t.deepEqual(matmulShape([5, 1, 2, 3], [1, 4, 3, 6]).out, [5, 4, 2, 6], 'batch broadcast');
  });
  it('rejects a mismatched shared dimension', (t) => {
    t.throws(
      () => matmulShape([2, 3], [4, 5]),
      /shared dimension \(3 vs 4\)/,
      'error names both sizes',
    );
  });
});

describe('creation and readback', () => {
  it('builds from a nested array', async (t) => {
    const x = await tensor([[1, 2, 3], [4, 5, 6]]);
    t.deepEqual([...x.shape], [2, 3], 'shape is inferred');
    t.equal(x.dtype, 'f32', 'f32 by default');
    t.deepEqual(Array.from(await x.data()), [1, 2, 3, 4, 5, 6], 'row-major values');
  });
  it('rejects a ragged array', async (t) => {
    await t.rejects(
      () => tensor([[1, 2], [3]]),
      /ragged/,
      'ragged input is refused rather than padded',
    );
  });
  it('builds zeros, ones, and full', async (t) => {
    t.deepEqual(Array.from(await (await zeros([3])).data()), [0, 0, 0], 'zeros');
    t.deepEqual(Array.from(await (await ones([2, 2])).data()), [1, 1, 1, 1], 'ones');
    t.deepEqual(Array.from(await (await full([2], 7)).data()), [7, 7], 'full');
  });
  it('builds an arithmetic sequence', async (t) => {
    const x = await arange(4, { start: 2, step: 3 });
    t.deepEqual(Array.from(await x.data()), [2, 5, 8, 11], 'arange with start and step');
  });
  it('carries integer and boolean dtypes', async (t) => {
    const i = await tensor([1, 2, 3], { dtype: 'i32' });
    t.deepEqual(Array.from(await i.data()), [1, 2, 3], 'i32 round-trips');
    const b = await tensor([true, false, true], { dtype: 'bool' });
    t.deepEqual(Array.from(await b.data()), [1, 0, 1], 'bool reads back as 0/1');
  });
  it('converts half precision on readback', async (t) => {
    const x = await tensor([1, 2, 0.5], { dtype: 'f16' });
    const values = await x.data();
    t.ok(values instanceof Float32Array, 'f16 reads back as Float32Array');
    t.deepEqual(Array.from(values), [1, 2, 0.5], 'representable values survive');
  });
  it('rejects item() on a non-scalar', async (t) => {
    const x = await tensor([1, 2]);
    await t.rejects(() => x.item(), /exactly one element/, 'item() needs one element');
  });
  it('handles empty tensors', async (t) => {
    const x = await zeros([0, 3]);
    t.equal(x.size, 0, 'no elements');
    t.equal((await x.data()).length, 0, 'readback is empty');
    const y = x.add(1);
    t.equal(y.size, 0, 'operations stay empty');
  });
});

describe('elementwise operations', () => {
  it('applies unary functions', async (t) => {
    const x = await tensor([-1, 3, 2]);
    t.deepEqual(Array.from(await x.relu().data()), [0, 3, 2], 'relu');
    t.deepEqual(Array.from(await x.abs().data()), [1, 3, 2], 'abs');
    t.deepEqual(Array.from(await x.neg().data()), [1, -3, -2], 'neg');
    t.deepEqual(Array.from(await x.sign().data()), [-1, 1, 1], 'sign');
  });
  it('negates zero to negative zero', async (t) => {
    // IEEE-754 behaviour, and worth pinning: -0 and 0 compare equal but are
    // distinguishable, so a kernel that returned 0 here would be subtly wrong.
    const x = await tensor([0]);
    t.ok(Object.is((await x.neg().data())[0], -0), 'neg(0) is -0');
  });
  it('applies binary functions with broadcasting', async (t) => {
    const a = await tensor([[1, 2], [3, 4]]);
    const b = await tensor([10, 20]);
    t.deepEqual(Array.from(await a.add(b).data()), [11, 22, 13, 24], 'row broadcast');
    t.deepEqual(Array.from(await a.mul(b).data()), [10, 40, 30, 80], 'row broadcast mul');
  });
  it('folds a scalar operand into an attribute', async (t) => {
    const dev = await device();
    const x = await tensor([1, 2, 3]);
    const before = poolStats(dev).liveBuffers;
    const y = x.mul(3);
    // One new buffer for the result, and none for the scalar.
    t.equal(poolStats(dev).liveBuffers, before + 1, 'a scalar allocates nothing');
    t.deepEqual(Array.from(await y.data()), [3, 6, 9], 'scalar multiply is correct');
  });
  it('subtracts from a scalar in the right order', async (t) => {
    const x = await tensor([1, 2, 3]);
    t.deepEqual(Array.from(await x.sub(10).data()), [-9, -8, -7], 'tensor minus scalar');
  });
  it('produces booleans from comparisons', async (t) => {
    const a = await tensor([1, 5, 3]);
    const b = await tensor([2, 2, 3]);
    const mask = a.gt(b);
    t.equal(mask.dtype, 'bool', 'comparison yields bool');
    t.deepEqual(Array.from(await mask.data()), [0, 1, 0], 'elementwise greater-than');
  });
  it('selects with where', async (t) => {
    const cond = await tensor([true, false, true], { dtype: 'bool' });
    const a = await tensor([1, 2, 3]);
    const b = await tensor([10, 20, 30]);
    t.deepEqual(Array.from(await cond.where(a, b).data()), [1, 20, 3], 'where selects');
  });
  it('casts between dtypes', async (t) => {
    const x = await tensor([1.7, -2.3]);
    t.deepEqual(Array.from(await x.cast('i32').data()), [1, -2], 'truncates towards zero');
  });
  it('computes gelu close to its definition', async (t) => {
    const x = await tensor([0, 1, -1]);
    const values = Array.from(await x.gelu().data());
    t.ok(Math.abs(values[0]!) < 1e-6, 'gelu(0) is 0');
    t.ok(Math.abs(values[1]! - 0.8411) < 1e-3, `gelu(1) is about 0.841, got ${values[1]}`);
    t.ok(values[2]! < 0 && values[2]! > -0.2, `gelu(-1) is small and negative, got ${values[2]}`);
  });
  it('preserves NaN and infinity', async (t) => {
    const x = await tensor([NaN, Infinity, -Infinity]);
    const values = Array.from(await x.mul(2).data());
    t.ok(Number.isNaN(values[0]!), 'NaN survives');
    t.equal(values[1], Infinity, 'infinity survives');
    t.equal(values[2], -Infinity, 'negative infinity survives');
  });
});

describe('reductions', () => {
  it('reduces fully and along axes', async (t) => {
    const x = await tensor([[1, 2, 3], [4, 5, 6]]);
    t.equal(await x.sum().item(), 21, 'full sum');
    t.equal(await x.mean().item(), 3.5, 'full mean');
    t.deepEqual(Array.from(await x.sum([0]).data()), [5, 7, 9], 'column sums');
    t.deepEqual(Array.from(await x.sum([1]).data()), [6, 15], 'row sums');
    t.equal(await x.max().item(), 6, 'max');
    t.equal(await x.min().item(), 1, 'min');
  });
  it('keeps reduced axes when asked', async (t) => {
    const x = await tensor([[1, 2], [3, 4]]);
    const kept = x.sum([1], true);
    t.deepEqual([...kept.shape], [2, 1], 'keepDims retains the axis');
  });
  it('produces a rank-0 tensor from a full reduction', async (t) => {
    const x = await tensor([[1, 2], [3, 4]]);
    t.deepEqual([...x.sum().shape], [], 'full reduction is rank 0');
    t.equal(x.sum().size, 1, 'and holds one element');
  });
  it('finds argmax along an axis', async (t) => {
    const x = await tensor([[1, 9, 3], [7, 2, 5]]);
    const idx = x.argmax(1);
    t.equal(idx.dtype, 'i32', 'indices are i32');
    t.deepEqual(Array.from(await idx.data()), [1, 0], 'per-row argmax');
  });
  it('computes a numerically stable softmax', async (t) => {
    // Without subtracting the row maximum this overflows to NaN.
    const x = await tensor([[1000, 1001, 1002]]);
    const values = Array.from(await x.softmax(1).data());
    t.ok(values.every((v) => Number.isFinite(v)), 'no overflow');
    const total = values.reduce((a, b) => a + b, 0);
    t.ok(Math.abs(total - 1) < 1e-6, `softmax sums to 1, got ${total}`);
    t.ok(values[2]! > values[1]! && values[1]! > values[0]!, 'ordering is preserved');
  });
  it('computes log-softmax consistently with softmax', async (t) => {
    const x = await tensor([[1, 2, 3]]);
    const direct = Array.from(await x.logSoftmax(1).data());
    const viaLog = Array.from(await x.softmax(1).log().data());
    for (let i = 0; i < direct.length; i++) {
      t.ok(Math.abs(direct[i]! - viaLog[i]!) < 1e-5, `element ${i} agrees`);
    }
  });
});

describe('matmul', () => {
  it('multiplies matrices', async (t) => {
    const a = await tensor([[1, 2], [3, 4]]);
    const b = await tensor([[5, 6], [7, 8]]);
    t.deepEqual(Array.from(await a.matmul(b).data()), [19, 22, 43, 50], 'result');
  });
  it('handles non-square shapes', async (t) => {
    const a = await tensor([[1, 2, 3]]);
    const b = await tensor([[1], [2], [3]]);
    t.deepEqual(Array.from(await a.matmul(b).data()), [14], 'inner product');
  });
  it('multiplies batches', async (t) => {
    const a = await tensor([[[1, 0], [0, 1]], [[2, 0], [0, 2]]]);
    const b = await tensor([[[1, 2], [3, 4]], [[1, 1], [1, 1]]]);
    const out = a.matmul(b);
    t.deepEqual([...out.shape], [2, 2, 2], 'batch shape');
    t.deepEqual(
      Array.from(await out.data()),
      [1, 2, 3, 4, 2, 2, 2, 2],
      'each batch multiplies independently',
    );
  });
});

describe('movement', () => {
  it('reshapes without copying when contiguous', async (t) => {
    const dev = await device();
    const x = await tensor([[1, 2], [3, 4]]);
    const before = poolStats(dev).liveBuffers;
    const y = x.reshape([4]);
    t.equal(poolStats(dev).liveBuffers, before, 'no allocation for a contiguous reshape');
    t.deepEqual(Array.from(await y.data()), [1, 2, 3, 4], 'values are unchanged');
  });
  it('resolves a -1 placeholder', async (t) => {
    const x = await tensor([[1, 2, 3], [4, 5, 6]]);
    t.deepEqual([...x.reshape([3, -1]).shape], [3, 2], 'placeholder is filled in');
  });
  it('rejects a reshape that changes the element count', async (t) => {
    const x = await tensor([1, 2, 3]);
    t.throws(() => x.reshape([2, 2]), /cannot reshape/, 'element count must match');
  });
  it('transposes', async (t) => {
    const x = await tensor([[1, 2, 3], [4, 5, 6]]);
    const y = x.transpose();
    t.deepEqual([...y.shape], [3, 2], 'shape swaps');
    t.deepEqual(Array.from(await y.data()), [1, 4, 2, 5, 3, 6], 'values transpose');
  });
  it('permutes three axes', async (t) => {
    const x = await tensor([[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
    const y = x.permute([2, 0, 1]);
    t.deepEqual([...y.shape], [2, 2, 2], 'shape follows the permutation');
    t.deepEqual(Array.from(await y.data()), [1, 3, 5, 7, 2, 4, 6, 8], 'values follow');
  });
  it('expands size-1 axes', async (t) => {
    const x = await tensor([[1], [2]]);
    const y = x.expand([2, 3]);
    t.deepEqual(Array.from(await y.data()), [1, 1, 1, 2, 2, 2], 'rows repeat');
  });
  it('refuses to expand a non-unit axis', async (t) => {
    const x = await tensor([[1, 2]]);
    t.throws(() => x.expand([1, 4]), /cannot expand/, 'only size-1 axes stretch');
  });
  it('selects rows by index', async (t) => {
    const table = await tensor([[1, 2], [3, 4], [5, 6]]);
    const idx = await tensor([2, 0], { dtype: 'i32' });
    const out = table.indexSelect(idx, 0);
    t.deepEqual([...out.shape], [2, 2], 'one row per index');
    t.deepEqual(Array.from(await out.data()), [5, 6, 1, 2], 'rows are gathered');
  });
  it('rejects an out-of-range index', async (t) => {
    const table = await tensor([[1, 2], [3, 4]]);
    const idx = await tensor([5], { dtype: 'i32' });
    // The reference backend executes inline and throws at dispatch; an accelerated
    // backend cannot throw from a kernel, so it records the fault and raises it at
    // the next synchronisation point. Either way the index is refused rather than
    // silently reading whatever lies at that offset.
    let message = '';
    try {
      await table.indexSelect(idx, 0).data();
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    t.ok(/out of range/.test(message), `bounds are checked (${message})`);
  });
  it('concatenates along an axis', async (t) => {
    const a = await tensor([[1, 2]]);
    const b = await tensor([[3, 4], [5, 6]]);
    const out = concat([a, b], 0);
    t.deepEqual([...out.shape], [3, 2], 'shapes add along the axis');
    t.deepEqual(Array.from(await out.data()), [1, 2, 3, 4, 5, 6], 'values are placed in order');
  });
});

describe('lifecycle', () => {
  it('disposes with tidy, keeping the result', async (t) => {
    const dev = await device();
    const x = await tensor([1, 2, 3]);
    const before = poolStats(dev).liveBuffers;
    const out = tidy(() => x.mul(2).add(1).exp().log());
    t.equal(poolStats(dev).liveBuffers, before + 1, 'only the returned tensor survives');
    t.equal((await out.data()).length, 3, 'and it is usable');
  });
  it('keeps an extra tensor out of the scope', async (t) => {
    const dev = await device();
    const x = await tensor([1, 2, 3]);
    const before = poolStats(dev).liveBuffers;
    let escaped: unknown;
    tidy(() => {
      const a = x.mul(2);
      escaped = keep(a);
      return x.add(1);
    });
    t.equal(poolStats(dev).liveBuffers, before + 2, 'both the result and the kept tensor live');
    t.ok(!(escaped as { disposed: boolean }).disposed, 'the kept tensor was not disposed');
  });
  it('returns storage to the pool on dispose', async (t) => {
    const dev = await device();
    const before = poolStats(dev);
    const x = await tensor([1, 2, 3, 4]);
    t.equal(poolStats(dev).liveBuffers, before.liveBuffers + 1, 'one buffer taken');
    x.dispose();
    t.equal(poolStats(dev).liveBuffers, before.liveBuffers, 'and returned');
  });
  it('reuses pooled buffers', async (t) => {
    const dev = await device();
    const first = await tensor([1, 2, 3, 4]);
    first.dispose();
    const hitsBefore = poolStats(dev).hits;
    const second = await tensor([5, 6, 7, 8]);
    t.equal(poolStats(dev).hits, hitsBefore + 1, 'the freed buffer was reused');
    second.dispose();
  });
  it('supports using', async (t) => {
    const dev = await device();
    const before = poolStats(dev).liveBuffers;
    {
      using x = await tensor([1, 2, 3]);
      t.equal(x.size, 3, 'usable inside the block');
    }
    t.equal(poolStats(dev).liveBuffers, before, 'disposed at the end of the block');
  });
  it('keeps shared storage alive when an alias is collected', async (t) => {
    // A contiguous reshape aliases storage rather than copying, so a collected
    // alias must decrement the reference count like any other handle. Forcing it to
    // zero would free the buffer out from under the original — a use-after-free that
    // only appears once the collector happens to run, which is the worst kind.
    const x = await tensor([1, 2, 3, 4]);
    for (let i = 0; i < 200; i++) {
      // Each alias is dropped immediately, giving the collector plenty to reclaim.
      x.reshape([2, 2]);
    }
    t.ok(!x.storage.disposed, 'the original storage survived every dropped alias');
    t.deepEqual(Array.from(await x.data()), [1, 2, 3, 4], 'and still reads correctly');
  });
  it('refuses to use a disposed tensor', async (t) => {
    const x = await tensor([1, 2]);
    x.dispose();
    t.throws(() => x.add(1), /has been disposed/, 'a clear error rather than corruption');
  });
});

describe('graph recording', () => {
  it('records a node per dispatched operation', async (t) => {
    const graph = currentGraph();
    const x = await tensor([1, 2, 3]);
    const before = graph.length;
    x.mul(2).add(1);
    t.equal(graph.length, before + 2, 'two operations, two nodes');
  });
  it('records shapes, dtypes, and the operation kind', async (t) => {
    const graph = currentGraph();
    const x = await tensor([[1, 2], [3, 4]]);
    const before = graph.length;
    x.sum([1]);
    const node = graph.node(before);
    t.equal(node.op, 'sum', 'node names the operation');
    t.deepEqual([...node.shapes[0]!], [2], 'output shape is recorded');
    t.equal(node.dtypes[0], 'f32', 'output dtype is recorded');
    t.equal(node.device.type, (await device()).type, 'device is recorded');
  });
  it('hashes structurally identical work equally', async (t) => {
    const graph = currentGraph();
    const x = await tensor([1, 2, 3]);
    const startA = graph.length;
    x.mul(2).add(1).sum();
    const spanA = graph.slice(startA, graph.length).hash();
    const startB = graph.length;
    x.mul(2).add(1).sum();
    const spanB = graph.slice(startB, graph.length).hash();
    t.equal(spanA, spanB, 'the same computation hashes the same');
  });
  it('hashes different shapes differently', async (t) => {
    const graph = currentGraph();
    const small = await tensor([1, 2]);
    const large = await tensor([1, 2, 3]);
    const startA = graph.length;
    small.mul(2);
    const hashA = graph.slice(startA, graph.length).hash();
    const startB = graph.length;
    large.mul(2);
    const hashB = graph.slice(startB, graph.length).hash();
    t.notEqual(hashA, hashB, 'shape is part of the identity');
  });
  it('reports the producer of a value', async (t) => {
    const graph = currentGraph();
    const x = await tensor([1, 2, 3]);
    const y = x.mul(2);
    const producer = graph.producerOf(y.valueId);
    t.ok(producer !== null, 'the value has a producer');
    t.equal(graph.node(producer!).op, 'mul', 'and it is the multiply');
  });
  it('marks steps and hashes the span between them', async (t) => {
    const graph = currentGraph();
    const x = await tensor([1, 2, 3]);
    x.mul(2).sum();
    graph.markStep();
    x.mul(2).sum();
    graph.markStep();
    const stepHash = graph.lastStepHash();
    t.ok(stepHash !== null, 'a step hash is available after two boundaries');
    x.mul(2).sum();
    graph.markStep();
    t.equal(graph.lastStepHash(), stepHash, 'a repeated step hashes identically');
  });
  it('does not retain tensors', async (t) => {
    const graph = currentGraph();
    const dev = await device();
    const x = await tensor([1, 2, 3]);
    const before = poolStats(dev).liveBuffers;
    const y = x.mul(2);
    y.dispose();
    // The recording still holds the node, but no buffer.
    t.ok(graph.length > 0, 'the node is still recorded');
    t.equal(poolStats(dev).liveBuffers, before, 'yet the buffer was released');
  });
});

describe('autodiff', () => {
  it('differentiates a linear layer', async (t) => {
    const w = await tensor([[1], [2]], { requiresGrad: true });
    const x = await tensor([[3, 4]]);
    const loss = x.matmul(w).sum();
    loss.backward();
    t.deepEqual(Array.from(await w.grad!.data()), [3, 4], 'dL/dw equals x');
  });
  it('differentiates through relu', async (t) => {
    const x = await tensor([-1, 2, -3, 4], { requiresGrad: true });
    x.relu().sum().backward();
    t.deepEqual(Array.from(await x.grad!.data()), [0, 1, 0, 1], 'gradient is the mask');
  });
  it('accumulates into a broadcast operand', async (t) => {
    const bias = await tensor([1, 2], { requiresGrad: true });
    const x = await tensor([[1, 1], [1, 1]]);
    x.add(bias).sum().backward();
    // Each bias element participated in two rows.
    t.deepEqual(Array.from(await bias.grad!.data()), [2, 2], 'broadcast axes are summed');
  });
  it('accumulates a gradient used twice', async (t) => {
    const x = await tensor([3], { requiresGrad: true });
    // y = x * x, so dy/dx = 2x = 6.
    x.mul(x).sum().backward();
    t.deepEqual(Array.from(await x.grad!.data()), [6], 'both paths contribute');
  });
  it('accumulates across two backward passes', async (t) => {
    const x = await tensor([2], { requiresGrad: true });
    x.mul(3).sum().backward();
    t.deepEqual(Array.from(await x.grad!.data()), [3], 'first pass');
    x.mul(3).sum().backward();
    t.deepEqual(Array.from(await x.grad!.data()), [6], 'gradients add rather than replace');
  });
  it('skips gradients for inputs that do not need them', async (t) => {
    const a = await tensor([1, 2], { requiresGrad: true });
    const b = await tensor([3, 4]);
    a.mul(b).sum().backward();
    t.ok(a.grad !== null, 'the tracked input has a gradient');
    t.equal(b.grad, null, 'the untracked input does not');
  });
  it('records nothing under noGrad', async (t) => {
    const x = await tensor([1, 2], { requiresGrad: true });
    const y = noGrad(() => x.mul(2));
    t.equal(y.gradFn, null, 'no gradient edge was built');
    t.throws(() => y.sum().backward(), /does not require gradients/, 'and backward refuses');
  });
  it('keeps memory bounded across repeated training steps', async (t) => {
    // The property that matters: saved activations are released as backward
    // consumes them, so an unbounded loop does not grow the pool.
    const dev = await device();
    const w = await tensor([[1], [2]], { requiresGrad: true });
    const x = await tensor([[3, 4]]);
    const step = () => {
      tidy(() => {
        const loss = x.matmul(w).relu().sum();
        loss.backward();
      });
      w.grad?.dispose();
      w.grad = null;
    };
    step();
    const baseline = poolStats(dev).liveBuffers;
    for (let i = 0; i < 20; i++) step();
    t.equal(
      poolStats(dev).liveBuffers,
      baseline,
      'twenty more steps left the live-buffer count unchanged',
    );
  });
  it('requires an explicit seed for a non-scalar output', async (t) => {
    const x = await tensor([1, 2], { requiresGrad: true });
    const y = x.mul(2);
    t.throws(() => y.backward(), /needs an explicit gradient/, 'ambiguity is refused');
    y.backward(onesLike(y));
    t.deepEqual(Array.from(await x.grad!.data()), [2, 2], 'an explicit seed works');
  });
  it('detaches from the graph', async (t) => {
    const x = await tensor([1, 2], { requiresGrad: true });
    const y = x.mul(2).detach();
    t.equal(y.gradFn, null, 'the edge is dropped');
    t.ok(!y.requiresGrad, 'and the result is untracked');
  });
  it('differentiates a two-layer network', async (t) => {
    const w1 = await tensor([[1, 0], [0, 1]], { requiresGrad: true });
    const w2 = await tensor([[1], [1]], { requiresGrad: true });
    const x = await tensor([[2, 3]]);
    x.matmul(w1).relu().matmul(w2).sum().backward();
    t.ok(w1.grad !== null && w2.grad !== null, 'both layers received gradients');
    t.deepEqual(Array.from(await w2.grad!.data()), [2, 3], 'dL/dw2 is the hidden activation');
  });
});
