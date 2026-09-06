/**
 * What the GPU backends actually achieve, in units that mean something.
 *
 * The other tensor benchmark measures the framework on the reference backend, where a
 * figure says something about dispatch overhead and nothing about hardware. This one
 * measures the kernels, and reports GFLOP/s and GB/s rather than iterations per second
 * so the numbers can be compared against the hardware and against other engines
 * instead of only against yesterday's run.
 *
 * Nothing here is claimed to be fast. The point is that the numbers exist and are
 * honest, which is what makes it possible to tell whether a change helped.
 *
 * Timing shape: dispatch is non-blocking, so a loop that never reads anything back
 * measures enqueueing rather than execution. Each rate below issues its iterations and
 * then reads once, which times the device rather than the host.
 *
 * The rates are computed once, at load, and printed as a block. The registered
 * benchmarks below then track per-operation wall time for regressions, which is what
 * the harness is shaped for — it repeats a function until a second has passed, and a
 * rate measured inside that would be re-measured and re-printed dozens of times. The
 * first few would also read low: a GPU idles at a lower clock, and these kernels warm
 * it up in the first tenth of a second.
 */
import { device, listDevices, zeros } from 'fino:tensor';
import type { Device, Tensor } from 'fino:tensor';
import { bench } from 'fino:bench';

/** Timed repetitions of each rate; the fastest is reported. */
const ROUNDS = 3;

/** GPUs to measure, or nothing when the machine has none. */
const gpus: Device[] = (await listDevices()).filter((d) => d.type !== 'cpu');

/** Deterministic values, so a run is comparable with the last one. */
function values(count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = ((i * 2654435761) % 1000) / 1000 - 0.5;
  return out;
}

/**
 * Time a device operation, reporting a rate rather than a duration.
 *
 * `work` is whatever unit makes the operation comparable — floating-point operations
 * for a multiply, bytes for a copy.
 */
async function rate(
  make: () => Tensor,
  iterations: number,
  work: number,
  unit: 'GFLOP/s' | 'GB/s' | 'Gelem/s',
  deferred = false,
): Promise<string> {
  const warm = make();
  await drain(warm);
  warm.dispose();

  // Best of several, not one run. The same program measured twice differed sixfold
  // here: the first call allocates its outputs while the second finds them in the pool,
  // and a GPU that has been idle starts at a lower clock. The fastest run is the one
  // least polluted by everything else that was going on.
  let seconds = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    seconds = Math.min(seconds, await once());
  }
  return `${(work / seconds / 1e9).toFixed(0)} ${unit} (${(seconds * 1000).toFixed(2)} ms)`;

  // Each result is forced before it is released. An elementwise expression is deferred
  // until something needs its values, and disposing one *drops* it — so a loop that
  // made and released a chain per iteration executed none of them but the last, and
  // reported a rate for work the device never did.
  //
  // Slicing forces its input to materialise, which launches the expression without
  // waiting for it. Holding every result instead would work too, and would mean four
  // gigabytes of live tensors here — enough that allocation, not the kernel, is what
  // gets measured. Only the one-element probes are kept, and only the last is read.
  async function once(): Promise<number> {
    const start = performance.now();
    let seconds: number;
    if (deferred) {
      const probes: Tensor[] = [];
      for (let i = 0; i < iterations; i++) {
        const out = make();
        probes.push(out.reshape([out.size]).slice([{ end: 1 }]));
        out.dispose();
      }
      await probes[probes.length - 1]!.data();
      seconds = (performance.now() - start) / 1000 / iterations;
      for (const probe of probes) probe.dispose();
    } else {
      let last: Tensor | null = null;
      for (let i = 0; i < iterations; i++) {
        last?.dispose();
        last = make();
      }
      await drain(last!);
      seconds = (performance.now() - start) / 1000 / iterations;
      last!.dispose();
    }
    return seconds;
  }
}

/**
 * Wait for the device without moving the result back.
 *
 * Reading a result outright would copy it to the host, and for a sixteen-million
 * element tensor that is sixty-four megabytes of transfer folded into the timing and
 * divided across the iterations — enough, when the iteration count is low, to make the
 * kernel look two to three times slower than it is. Reading a single element forces
 * the same queue to drain and moves four bytes.
 */
async function drain(tensor: Tensor): Promise<void> {
  const probe = tensor.rank === 0 ? tensor : tensor.reshape([tensor.size]).slice([{ end: 1 }]);
  await probe.data();
  if (probe !== tensor) probe.dispose();
}

const { tensor } = await import('fino:tensor');

// -- rates, measured once ------------------------------------------------------

for (const dev of gpus) {
  const lines: string[] = [];
  for (const n of [256, 512, 1024]) {
    const a = await tensor(values(n * n), { shape: [n, n], device: dev });
    const b = await tensor(values(n * n), { shape: [n, n], device: dev });
    // Two operations per multiply-accumulate, the conventional count.
    lines.push(
      `  gemm ${n}^3: ${await rate(() => a.matmul(b), n <= 512 ? 200 : 60, 2 * n ** 3, 'GFLOP/s')}`,
    );
    a.dispose();
    b.dispose();
  }

  const count = 1 << 24;
  const x = await zeros([count], { device: dev });
  // Three shapes of the same loop, moving one, two, and three words per element. Both
  // rates are reported because on this hardware the three take the same time: the cost
  // tracks elements rather than bytes, so a bytes-per-second figure on its own would
  // imply a bandwidth limit that is not the one being hit.
  const cases: [string, () => Tensor, number][] = [
    ['fill  (one write)      ', () => x.mul(0), 4],
    ['unary (read, write)    ', () => x.mul(2), 8],
    ['binary (2 reads, write)', () => x.add(x), 12],
  ];
  for (const [label, program, bytesPerElement] of cases) {
    const bytes = await rate(program, 60, count * bytesPerElement, 'GB/s', true);
    const elements = await rate(program, 60, count, 'Gelem/s', true);
    lines.push(`  ${label}: ${bytes}, ${elements}`);
  }
  x.dispose();

  console.log(`${dev.type} achieved rates\n${lines.join('\n')}`);
}

// -- per-operation time, for tracking regressions ------------------------------
//
// These include a readback, which for the 16M case moves 64MB back to the host and
// dominates the figure. That is deliberate: it is a stable number to watch for
// regressions, not a claim about kernel speed. The rates above are the kernel.

for (const dev of gpus) {
  bench(`${dev.type} kernels`, (b) => {
    const size = 512;
    let left: Tensor | null = null;
    let right: Tensor | null = null;
    let vector: Tensor | null = null;
    b.measure('matmul 512, including its readback', {
      async setup() {
        left = await tensor(values(size * size), { shape: [size, size], device: dev });
        right = await tensor(values(size * size), { shape: [size, size], device: dev });
      },
      async fn() {
        const out = left!.matmul(right!);
        await out.data();
        out.dispose();
      },
      teardown() {
        left?.dispose();
        right?.dispose();
      },
    });
    b.measure('elementwise 16M, including its readback', {
      async setup() {
        vector = await zeros([1 << 24], { device: dev });
      },
      async fn() {
        const out = vector!.mul(2);
        await out.data();
        out.dispose();
      },
      teardown() {
        vector?.dispose();
      },
    });
  });
}

if (gpus.length === 0) {
  bench('gpu', (b) => {
    b.measure('no GPU on this machine, nothing measured', () => {});
  });
}

void device;
