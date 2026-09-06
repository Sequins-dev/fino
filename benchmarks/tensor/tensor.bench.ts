/**
 * Benchmarks for fino:tensor (dispatch, pooling, autodiff, matmul).
 *
 * Every measured body returns nothing from `tidy`, deliberately. A `tidy` scope
 * keeps whatever its function returns — that is what makes it useful — so a body
 * ending in an expression would hand the caller a tensor per iteration and the
 * benchmark would measure itself running out of memory.
 *
 * These pin the reference backend rather than taking the default device. Two reasons:
 * a GPU figure here would be a launch-queue measurement rather than a kernel one,
 * since dispatch is non-blocking and nothing in a timed loop waits for the device; and
 * a timed loop does not yield, which is what a GPU needs in order to finish compiling
 * a kernel it has not seen before. Measuring the GPU means measuring wall time around
 * a readback, which is a different benchmark than this one.
 *
 * These measure the framework, not the hardware. The reference backend is a
 * scalar TypeScript implementation, so the matmul figures say nothing about this
 * engine's eventual GPU performance; what they do track is dispatch overhead and
 * allocation behaviour, which is where the framework itself can regress.
 */
import { device, tensor, zeros, tidy, noGrad } from 'fino:tensor';
import { loadSafetensors, saveSafetensors } from 'fino:tensor/io';
import { runConformance } from 'fino:tensor/conformance';
import { bench } from 'fino:bench';

const cpu = await device('cpu');
const small = await tensor(
  Array.from({ length: 1024 }, (_, i) => i / 1024),
  {
    shape: [32, 32],
    device: cpu,
  },
);
const other = await tensor(
  Array.from({ length: 1024 }, (_, i) => (i % 7) / 7),
  {
    shape: [32, 32],
    device: cpu,
  },
);
const weights = await tensor(
  Array.from({ length: 1024 }, (_, i) => (i % 5) / 5),
  {
    shape: [32, 32],
    device: cpu,
    requiresGrad: true,
  },
);
const vector = await zeros([4096], { device: cpu });

bench('dispatch', (b) => {
  // Isolates the per-operation framework cost: shape and dtype inference, pool
  // acquisition, graph append, and the backend call.
  b.measure('elementwise add (32x32)', () => {
    tidy(() => {
      small.add(other);
    });
  });
  b.measure('scalar multiply (32x32)', () => {
    tidy(() => {
      small.mul(2);
    });
  });
  b.measure('chain of four ops (32x32)', () => {
    tidy(() => {
      small.add(other).mul(2).relu().neg();
    });
  });
  b.measure('no-grad chain of four ops (32x32)', () => {
    noGrad(() =>
      tidy(() => {
        small.add(other).mul(2).relu().neg();
      }),
    );
  });
});

bench('pool', (b) => {
  b.measure('allocate and release (4096 f32)', () => {
    tidy(() => {
      vector.add(1);
    });
  });
  b.measure('metadata-only reshape', () => {
    tidy(() => {
      small.reshape([1024]);
    });
  });
});

bench('reduce', (b) => {
  b.measure('full sum (32x32)', () => {
    tidy(() => {
      small.sum();
    });
  });
  b.measure('axis sum (32x32)', () => {
    tidy(() => {
      small.sum([1]);
    });
  });
  b.measure('softmax (32x32)', () => {
    tidy(() => {
      small.softmax(1);
    });
  });
});

bench('matmul', (b) => {
  b.measure('32x32 by 32x32', () => {
    tidy(() => {
      small.matmul(other);
    });
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

bench('slice', (b) => {
  b.measure('strided sub-region (32x32)', () => {
    tidy(() => {
      small.slice([{ start: 1, step: 2 }, { start: 2 }]);
    });
  });
});

// Written once here rather than in a measurement's setup, so the load benchmark has
// something to read on its first iteration and the save benchmark simply overwrites it.
// The file is left behind deliberately: removing it between iterations would put a
// filesystem unlink inside the timing.
const ioPath = '/tmp/fino-tensor-bench.safetensors';
const ioState = new Map([
  ['weight', small],
  ['other', other],
  ['vector', vector],
]);
await saveSafetensors(ioPath, ioState);

bench('io', (b) => {
  // A weight file is read once, but its size is what a load costs, so this tracks the
  // header parse plus the per-tensor positional reads rather than any single operation.
  b.measure('save three tensors', async () => {
    await saveSafetensors(ioPath, ioState);
  });
  b.measure('load three tensors', async () => {
    const loaded = await loadSafetensors(ioPath);
    for (const value of loaded.values()) value.dispose();
  });
});

bench('conformance', (b) => {
  // What it costs an out-of-tree backend to check itself. Worth tracking because a
  // suite nobody runs is a suite nobody runs — if this grows into minutes, it stops
  // being something to reach for while iterating on a backend.
  b.measure('the whole suite on the reference backend', async () => {
    await runConformance(cpu);
  });
});
