/**
 * Benchmarks for fino:tensor (dispatch, pooling, autodiff, matmul).
 *
 * These measure the framework, not the hardware. The reference backend is a
 * scalar TypeScript implementation, so the matmul figures say nothing about this
 * engine's eventual GPU performance; what they do track is dispatch overhead and
 * allocation behaviour, which is where the framework itself can regress.
 */
import { tensor, zeros, tidy, noGrad } from 'fino:tensor';
import { bench } from 'fino:bench';

const small = await tensor(Array.from({ length: 1024 }, (_, i) => i / 1024), { shape: [32, 32] });
const other = await tensor(Array.from({ length: 1024 }, (_, i) => (i % 7) / 7), { shape: [32, 32] });
const weights = await tensor(Array.from({ length: 1024 }, (_, i) => (i % 5) / 5), {
  shape: [32, 32],
  requiresGrad: true,
});
const vector = await zeros([4096]);

bench('dispatch', (b) => {
  // Isolates the per-operation framework cost: shape and dtype inference, pool
  // acquisition, graph append, and the backend call.
  b.measure('elementwise add (32x32)', () => {
    tidy(() => small.add(other));
  });
  b.measure('scalar multiply (32x32)', () => {
    tidy(() => small.mul(2));
  });
  b.measure('chain of four ops (32x32)', () => {
    tidy(() => small.add(other).mul(2).relu().neg());
  });
  b.measure('no-grad chain of four ops (32x32)', () => {
    noGrad(() => tidy(() => small.add(other).mul(2).relu().neg()));
  });
});

bench('pool', (b) => {
  b.measure('allocate and release (4096 f32)', () => {
    tidy(() => vector.add(1));
  });
  b.measure('metadata-only reshape', () => {
    tidy(() => small.reshape([1024]));
  });
});

bench('reduce', (b) => {
  b.measure('full sum (32x32)', () => {
    tidy(() => small.sum());
  });
  b.measure('axis sum (32x32)', () => {
    tidy(() => small.sum([1]));
  });
  b.measure('softmax (32x32)', () => {
    tidy(() => small.softmax(1));
  });
});

bench('matmul', (b) => {
  b.measure('32x32 by 32x32', () => {
    tidy(() => small.matmul(other));
  });
});

bench('autograd', (b) => {
  b.measure('forward and backward (32x32 matmul)', () => {
    tidy(() => {
      small.matmul(weights).relu().sum().backward();
    });
    weights.grad?.dispose();
    weights.grad = null;
  });
});
