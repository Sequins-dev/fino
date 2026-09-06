/**
 * BLAS behind the CPU matrix multiply.
 *
 * The scalar reference loop is the oracle here as everywhere else, so these compare
 * BLAS against a multiply computed in the test itself rather than against recorded
 * values. Shapes are chosen to cover what a library gets wrong when a leading
 * dimension is passed badly: non-square, ragged, rank-1 promotion, and batches with
 * and without a broadcast operand.
 */
import { describe, it } from 'fino:test/test';
import { device, tensor } from 'fino:tensor';
import type { Device } from 'fino:tensor';
import { blasAvailable, blasPath, blasUnavailableReason } from 'internal:tensor/cpu/blas';
import { sampleValues } from 'internal:tensor/harness';

/** Unit roundoff per dtype, for the bound below. */
const EPSILON: Record<string, number> = {
  f64: 2.221e-16,
  f32: 1.193e-7,
  f16: 9.77e-4,
  bf16: 7.82e-3,
};

/**
 * Check a multiply against the standard error bound for one.
 *
 * The contract's per-dtype tolerance is a *relative* bound, which is the wrong shape
 * for a dot product: a result near zero is the difference of much larger partial sums,
 * so its relative error can be arbitrary while the computation is perfectly correct.
 * The textbook criterion bounds the residual by the size of the terms being summed
 * instead — `eps * k * max|A| * max|B|` — which is what a library is actually allowed,
 * and which still fails loudly for the mistakes that matter, since passing a wrong
 * leading dimension produces errors the size of the operands rather than of the
 * roundoff.
 */
function assertMultiply(
  t: { ok(value: unknown, message: string): void },
  label: string,
  got: ArrayLike<number>,
  want: readonly number[],
  a: readonly number[],
  b: readonly number[],
  k: number,
  dtype: keyof typeof EPSILON,
): void {
  const scale = Math.max(...a.map(Math.abs)) * Math.max(...b.map(Math.abs));
  // The factor of four is slack for a library reordering the sum, not licence: the
  // bound is still five orders of magnitude tighter than any indexing mistake.
  const allowed = EPSILON[dtype]! * k * scale * 4;
  let worst = 0;
  let at = -1;
  for (let i = 0; i < want.length; i++) {
    const delta = Math.abs(got[i]! - want[i]!);
    if (delta > worst) {
      worst = delta;
      at = i;
    }
  }
  t.ok(
    worst <= allowed,
    worst <= allowed
      ? `${label}: within ${allowed.toExponential(2)}`
      : `${label}: element ${at} is off by ${worst.toExponential(2)}, bound ${allowed.toExponential(2)}`,
  );
}

/** Row-major multiply, computed here so the assertion does not trust the engine. */
function reference(
  a: readonly number[],
  b: readonly number[],
  m: number,
  k: number,
  n: number,
): number[] {
  const out: number[] = [];
  for (let row = 0; row < m; row++) {
    for (let col = 0; col < n; col++) {
      let total = 0;
      for (let i = 0; i < k; i++) total += a[row * k + i]! * b[i * n + col]!;
      out.push(total);
    }
  }
  return out;
}

describe('CPU BLAS', () => {
  it('reports whether a library was found', (t) => {
    const available = blasAvailable();
    if (available) {
      t.ok(blasPath(), `loaded ${blasPath()}`);
      t.equal(blasUnavailableReason(), null, 'and reports no reason for absence');
    } else {
      // Absence is a supported state: the reference loop still answers every call.
      t.ok(blasUnavailableReason(), `absent, and says why: ${blasUnavailableReason()}`);
    }
  });

  it('matches the reference multiply across shapes', async (t) => {
    const cpu: Device = await device('cpu');
    const shapes: [number, number, number][] = [
      [1, 1, 1],
      [4, 3, 2],
      [1, 7, 1],
      [7, 1, 5],
      [65, 33, 47],
      [128, 128, 128],
    ];
    for (const [m, k, n] of shapes) {
      const av = sampleValues(m * k, m + k);
      const bv = sampleValues(k * n, k + n + 1);
      const a = await tensor(av, { shape: [m, k], dtype: 'f32', device: cpu });
      const b = await tensor(bv, { shape: [k, n], dtype: 'f32', device: cpu });
      assertMultiply(
        t,
        `${m}x${k}x${n}`,
        await a.matmul(b).data(),
        reference(av, bv, m, k, n),
        av,
        bv,
        k,
        'f32',
      );
      a.dispose();
      b.dispose();
    }
  });

  it('matches the reference multiply in f64', async (t) => {
    const cpu = await device('cpu');
    const [m, k, n] = [33, 17, 9];
    const av = sampleValues(m * k, 91);
    const bv = sampleValues(k * n, 93);
    const a = await tensor(av, { shape: [m, k], dtype: 'f64', device: cpu });
    const b = await tensor(bv, { shape: [k, n], dtype: 'f64', device: cpu });
    assertMultiply(
      t,
      'dgemm',
      await a.matmul(b).data(),
      reference(av, bv, m, k, n),
      av,
      bv,
      k,
      'f64',
    );
    a.dispose();
    b.dispose();
  });

  it('handles batches, including a broadcast operand', async (t) => {
    const cpu = await device('cpu');
    const [batch, m, k, n] = [3, 5, 4, 6];
    const av = sampleValues(batch * m * k, 11);
    const bv = sampleValues(batch * k * n, 13);
    const a = await tensor(av, { shape: [batch, m, k], dtype: 'f32', device: cpu });
    const b = await tensor(bv, { shape: [batch, k, n], dtype: 'f32', device: cpu });
    const got = await a.matmul(b).data();
    const want: number[] = [];
    for (let index = 0; index < batch; index++) {
      want.push(
        ...reference(
          av.slice(index * m * k, (index + 1) * m * k),
          bv.slice(index * k * n, (index + 1) * k * n),
          m,
          k,
          n,
        ),
      );
    }
    assertMultiply(t, 'batched multiply', got, want, av, bv, k, 'f32');

    // A batch of one on the right broadcasts, which means every batch item reads the
    // same operand — a zero batch stride, and the case a naive loop gets wrong.
    const shared = await tensor(sampleValues(k * n, 17), {
      shape: [1, k, n],
      dtype: 'f32',
      device: cpu,
    });
    const sharedValues = [...(await shared.data())].map(Number);
    const broadcast = await a.matmul(shared).data();
    const wantBroadcast: number[] = [];
    for (let index = 0; index < batch; index++) {
      wantBroadcast.push(
        ...reference(av.slice(index * m * k, (index + 1) * m * k), sharedValues, m, k, n),
      );
    }
    assertMultiply(
      t,
      'broadcast operand is read by every batch item',
      broadcast,
      wantBroadcast,
      av,
      sharedValues,
      k,
      'f32',
    );
    a.dispose();
    b.dispose();
    shared.dispose();
  });

  it('agrees with itself through a transposed operand', async (t) => {
    // `transpose` materialises before reaching the backend, so this checks that the
    // resulting contiguous operand is multiplied correctly rather than that BLAS
    // received a transpose flag — which it never does.
    const cpu = await device('cpu');
    const [m, k, n] = [6, 4, 3];
    const av = sampleValues(m * k, 21);
    const bv = sampleValues(n * k, 23);
    const a = await tensor(av, { shape: [m, k], dtype: 'f32', device: cpu });
    const b = await tensor(bv, { shape: [n, k], dtype: 'f32', device: cpu });
    const transposed: number[] = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < n; j++) transposed.push(bv[j * k + i]!);
    assertMultiply(
      t,
      'a times b transposed',
      await a.matmul(b.transpose()).data(),
      reference(av, transposed, m, k, n),
      av,
      transposed,
      k,
      'f32',
    );
    a.dispose();
    b.dispose();
  });

  it('leaves dtypes BLAS does not have to the reference loop', async (t) => {
    const cpu = await device('cpu');
    for (const dtype of ['f16', 'bf16'] as const) {
      const [m, k, n] = [3, 2, 4];
      const av = sampleValues(m * k, 31);
      const bv = sampleValues(k * n, 33);
      const a = await tensor(av, { shape: [m, k], dtype, device: cpu });
      const b = await tensor(bv, { shape: [k, n], dtype, device: cpu });
      // Compared against a reference built from the *rounded* inputs, since storing
      // them at half precision is part of the operation.
      const rounded = [...(await a.data())].map(Number);
      const roundedB = [...(await b.data())].map(Number);
      assertMultiply(
        t,
        `${dtype} multiply`,
        await a.matmul(b).data(),
        reference(rounded, roundedB, m, k, n),
        rounded,
        roundedB,
        k,
        dtype,
      );
      a.dispose();
      b.dispose();
    }
  });
});
