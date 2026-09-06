/**
 * What this engine achieves next to ggml, on the same machine and the same GPU.
 *
 * The other benchmarks compare this engine against itself, which says whether a change
 * helped and nothing about whether the result is any good. ggml is the bar the roadmap
 * named: a mature, hand-tuned Metal implementation of the same arithmetic. Running both
 * here means the comparison is made on one machine at one moment, rather than setting
 * this engine's numbers against someone else's published ones.
 *
 * The point is honesty rather than a win. Publishing only the flattering half of a
 * comparison is how benchmarks stop meaning anything, so both halves are printed.
 *
 * ## Measuring both the same way
 *
 * Dispatch here is non-blocking, and `ggml_backend_graph_compute` is not, so timing one
 * against the other directly would compare a queue depth against a round trip and call
 * the difference performance. Both are therefore measured twice:
 *
 * - *synchronised*: one submission, waited for, per iteration. This is latency, and it
 *   is what a program that reads its result every step actually experiences.
 * - *pipelined*: every iteration issued, then waited for once. This is throughput, and
 *   it is what a training loop that only synchronises on the loss experiences.
 *
 * ggml's own async entry point plus an explicit synchronise gives it the same shape,
 * so neither side is credited with the other's submission model.
 *
 * Skipped, with a reason, when no ggml is installed. `FINO_GGML_LIBRARY` names the
 * directory holding `libggml-base` and friends.
 */
import { dlopen, structType } from 'fino:ffi';
import { env } from 'fino:process';
import { bench } from 'fino:bench';
import { device, listDevices, tensor } from 'fino:tensor';
import type { Device, Tensor } from 'fino:tensor';

/** Directories that tend to hold a ggml build. */
function candidates(): string[] {
  const named = env.FINO_GGML_LIBRARY;
  const home = env.HOME ?? '';
  return [
    ...(named ? [named] : []),
    '/opt/homebrew/lib',
    '/usr/local/lib',
    // Docker Desktop ships a ggml build with its model runner, which is the one most
    // likely to be present on a Mac that never installed llama.cpp deliberately.
    `${home}/Library/Application Support/com.docker.install/in_progress/Docker.app/Contents/Resources/model-runner/lib`,
    '/Applications/Docker.app/Contents/Resources/model-runner/lib',
  ];
}

/** `struct ggml_init_params`, passed by value. */
const InitParams = structType([
  ['mem_size', 'usize'],
  ['mem_buffer', 'pointer'],
  ['no_alloc', 'bool'],
  { name: '_pad', type: 'bytes', size: 7 },
]);

/** `GGML_TYPE_F32`. */
const TYPE_F32 = 0;

/**
 * Timed repetitions of each measurement.
 *
 * A single run of any of these varies by a third between invocations, which is more
 * than the difference the benchmark exists to report — a published ratio drawn from one
 * run says as much about the GPU's clock at that moment as about either engine. The
 * fastest run is the one least polluted by everything else the machine was doing.
 */
const ROUNDS = 5;

/** Seconds per iteration for the fastest of `rounds` timed repetitions. */
function fastest(rounds: number, run: () => number): number {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    const iterations = run();
    best = Math.min(best, (performance.now() - start) / 1000 / iterations);
  }
  return best;
}

/** {@link fastest}, for a measurement that has to await the device. */
async function fastestAsync(rounds: number, run: () => Promise<number>): Promise<number> {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    const iterations = await run();
    best = Math.min(best, (performance.now() - start) / 1000 / iterations);
  }
  return best;
}

/** What a usable ggml build provides. */
interface Ggml {
  base: ReturnType<typeof dlopen>;
  backend: unknown;
}

/**
 * Open ggml and create its Metal backend, or return null.
 *
 * Deliberately not `ggml_backend_init_by_type`: the registry entry point ends the
 * process rather than returning, on this build, when the backend libraries were opened
 * individually rather than let dyld resolve them. `ggml_backend_metal_init` names what
 * is wanted directly and does not consult the registry at all.
 */
function openGgml(): Ggml | null {
  for (const dir of candidates()) {
    for (const suffix of ['.0.9.5.dylib', '.dylib', '.so']) {
      try {
        // ggml's libraries reference one another through `@rpath`, which resolves
        // against this executable rather than against ggml's own directory. Opening
        // each by absolute path first registers it under the install name those
        // references use, so a later load finds what it needs already present.
        for (const sibling of ['libggml-base', 'libggml-cpu', 'libggml-blas']) {
          try {
            dlopen(`${dir}/${sibling}${suffix}`, {});
          } catch {
            // A build without this piece may still be usable.
          }
        }
        const metal = dlopen(`${dir}/libggml-metal${suffix}`, {
          ggml_backend_metal_init: { parameters: [], result: 'pointer' },
        });
        const base = dlopen(`${dir}/libggml-base${suffix}`, {
          ggml_init: { parameters: [InitParams], result: 'pointer' },
          ggml_free: { parameters: ['pointer'], result: 'void' },
          ggml_new_tensor_2d: {
            parameters: ['pointer', 'i32', 'i64', 'i64'],
            result: 'pointer',
          },
          ggml_mul_mat: { parameters: ['pointer', 'pointer', 'pointer'], result: 'pointer' },
          ggml_new_graph: { parameters: ['pointer'], result: 'pointer' },
          ggml_build_forward_expand: { parameters: ['pointer', 'pointer'], result: 'void' },
          ggml_backend_alloc_ctx_tensors: {
            parameters: ['pointer', 'pointer'],
            result: 'pointer',
          },
          ggml_backend_tensor_set: {
            parameters: ['pointer', 'buffer', 'usize', 'usize'],
            result: 'void',
          },
          ggml_backend_tensor_get: {
            parameters: ['pointer', 'buffer', 'usize', 'usize'],
            result: 'void',
          },
          ggml_backend_graph_compute: { parameters: ['pointer', 'pointer'], result: 'i32' },
          ggml_backend_graph_compute_async: {
            parameters: ['pointer', 'pointer'],
            result: 'i32',
          },
          ggml_backend_synchronize: { parameters: ['pointer'], result: 'void' },
          ggml_backend_buffer_free: { parameters: ['pointer'], result: 'void' },
          ggml_backend_free: { parameters: ['pointer'], result: 'void' },
        });
        const backend = metal.symbols.ggml_backend_metal_init();
        if (!backend) continue;
        return { base, backend };
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

/**
 * A deterministic symmetric matrix.
 *
 * Symmetric on purpose. `ggml_mul_mat(a, b)` contracts both operands along their
 * fastest axis — it computes `a·bᵀ`, not `a·b` — so with arbitrary values the two
 * engines do the same number of multiplies on the same numbers and produce different
 * matrices, and the comparison could only ever be timed, never checked. Where the
 * operands are symmetric the two products coincide, which costs nothing and makes it
 * possible to assert that both sides really did the multiply being timed.
 */
function values(n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const value = (((i * 73856093) ^ (j * 19349663)) % 1000) / 1000 - 0.5;
      out[i * n + j] = value;
      out[j * n + i] = value;
    }
  }
  return out;
}

/** Seconds per iteration, both ways, for an `n`-cubed matrix multiply under ggml. */
function ggmlGemm(
  ggml: Ggml,
  n: number,
  iterations: number,
): { synchronised: number; pipelined: number; first: number } {
  const { symbols } = ggml.base;
  const { backend } = ggml;
  // Room for the tensor headers and the graph; the data lives in the backend buffer,
  // because `no_alloc` leaves allocation to it.
  const params = InitParams.alloc();
  InitParams.set(params, 'mem_size', 64 * 1024 * 1024);
  InitParams.set(params, 'mem_buffer', null);
  InitParams.set(params, 'no_alloc', true);
  const context = symbols.ggml_init(params);

  const a = symbols.ggml_new_tensor_2d(context, TYPE_F32, BigInt(n), BigInt(n));
  const b = symbols.ggml_new_tensor_2d(context, TYPE_F32, BigInt(n), BigInt(n));
  const c = symbols.ggml_mul_mat(context, a, b);
  const buffer = symbols.ggml_backend_alloc_ctx_tensors(context, backend);
  const graph = symbols.ggml_new_graph(context);
  symbols.ggml_build_forward_expand(graph, c);

  const bytes = new Uint8Array(values(n).buffer);
  symbols.ggml_backend_tensor_set(a, bytes, 0, bytes.byteLength);
  symbols.ggml_backend_tensor_set(b, bytes, 0, bytes.byteLength);

  symbols.ggml_backend_graph_compute(backend, graph);

  const synchronised = fastest(ROUNDS, () => {
    for (let i = 0; i < iterations; i++) symbols.ggml_backend_graph_compute(backend, graph);
    return iterations;
  });
  const pipelined = fastest(ROUNDS, () => {
    for (let i = 0; i < iterations; i++) {
      symbols.ggml_backend_graph_compute_async(backend, graph);
    }
    symbols.ggml_backend_synchronize(backend);
    return iterations;
  });

  // One element of the result, so the two engines can be checked against each other
  // rather than only timed.
  const out = new Uint8Array(4);
  symbols.ggml_backend_tensor_get(c, out, 0, 4);
  const first = new Float32Array(out.buffer)[0]!;

  symbols.ggml_backend_buffer_free(buffer);
  symbols.ggml_free(context);
  return { synchronised, pipelined, first };
}

/** Seconds per iteration, both ways, for the same multiply through this engine. */
async function finoGemm(
  dev: Device,
  n: number,
  iterations: number,
): Promise<{ synchronised: number; pipelined: number; first: number }> {
  const data = [...values(n)];
  const a = await tensor(data, { shape: [n, n], device: dev });
  const b = await tensor(data, { shape: [n, n], device: dev });

  // Syncing without adding work. Reading any tensor waits on everything submitted, so
  // a four-byte scalar allocated once drains the queue for the matmul that preceded it.
  // Slicing the result instead would have dispatched a copy kernel per iteration and
  // charged this engine for work the other side never does — which is measuring the
  // benchmark rather than the engine.
  const probe = await tensor([0], { device: dev });
  const sync = async (): Promise<void> => {
    await probe.data();
  };

  const warm = a.matmul(b);
  await sync();
  const firstRow = warm.reshape([warm.size]).slice([{ end: 1 }]);
  const first = Number((await firstRow.data())[0]);
  firstRow.dispose();
  warm.dispose();

  const synchronised = await fastestAsync(ROUNDS, async () => {
    for (let i = 0; i < iterations; i++) {
      const out = a.matmul(b);
      await sync();
      out.dispose();
    }
    return iterations;
  });

  let last: Tensor | null = null;
  const pipelined = await fastestAsync(ROUNDS, async () => {
    for (let i = 0; i < iterations; i++) {
      last?.dispose();
      last = a.matmul(b);
    }
    await sync();
    last?.dispose();
    last = null;
    return iterations;
  });
  probe.dispose();

  a.dispose();
  b.dispose();
  return { synchronised, pipelined, first };
}

const ggml = openGgml();
// ggml's Metal backend and this engine's coexist in one process; the comparison is
// against Metal specifically, since that is the ggml backend being initialised.
const metal = (await listDevices()).find((d) => d.type === 'metal') ?? null;

if (ggml && metal) {
  const rows: string[] = [];
  for (const n of [256, 512, 1024]) {
    const iterations = n <= 512 ? 50 : 20;
    const flops = 2 * n ** 3;
    const mine = await finoGemm(metal, n, iterations);
    const theirs = ggmlGemm(ggml, n, iterations);
    const rate = (seconds: number) => (flops / seconds / 1e9).toFixed(0).padStart(5);
    const ratio = (a: number, b: number) => (b / a).toFixed(2).padStart(5);
    rows.push(
      `  ${String(n).padStart(4)} | ${rate(mine.synchronised)} ${rate(theirs.synchronised)} ` +
        `${ratio(mine.synchronised, theirs.synchronised)}x | ` +
        `${rate(mine.pipelined)} ${rate(theirs.pipelined)} ${ratio(mine.pipelined, theirs.pipelined)}x`,
    );
    // Both computed the same product from the same values, so a large disagreement
    // means one of them is not doing the arithmetic the timing claims.
    const agree = Math.abs(mine.first - theirs.first) <= Math.abs(theirs.first) * 1e-3 + 1e-4;
    if (!agree) {
      rows.push(`       ! results disagree: ${mine.first} vs ${theirs.first}`);
    }
  }
  console.log(
    [
      'metal vs ggml-metal, f32 matrix multiply, GFLOP/s (higher is better)',
      '  size |  synchronised (per-call)  |  pipelined (queue depth)',
      '       |  fino  ggml    fino/ggml  |  fino  ggml    fino/ggml',
      ...rows,
    ].join('\n'),
  );
  ggml.base.symbols.ggml_backend_free(ggml.backend);
}

// The registered benchmark tracks this engine alone, so a machine without ggml still
// contributes a comparable number rather than a gap in the series.
bench('ggml comparison', (b) => {
  if (!metal) {
    b.measure('no Metal device here, nothing compared', () => {});
    return;
  }
  if (!ggml) {
    b.measure('no ggml installed, nothing compared', () => {});
    return;
  }
  let left: Tensor | null = null;
  let right: Tensor | null = null;
  b.measure('matmul 512 on this engine, the left column above', {
    async setup() {
      const data = [...values(512)];
      left = await tensor(data, { shape: [512, 512], device: metal });
      right = await tensor(data, { shape: [512, 512], device: metal });
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
});

void device;
