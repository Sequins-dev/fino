/**
 * Is the Neural Engine actually faster than this engine's Metal kernels? (FIN-156)
 *
 * The feasibility work established that CoreML will *run* the operations this engine
 * emits on the Neural Engine, and that it keeps doing so when the weights arrive as
 * runtime operands rather than baked constants. Neither of those is a performance claim.
 * Placement says where the work went, not how long it took.
 *
 * This is the gate on the rest of the ticket. Emitting MIL and standing up a graph-class
 * backend is the bulk of the work, and none of it is worth building on an unmeasured
 * assumption — the same reasoning that cancelled FIN-159 once f32 matrix instructions
 * measured eight and a half times slower than the scalar kernel they were to replace.
 *
 * ## What is compared
 *
 * Eight matrix multiplies with a ReLU between them, every weight an input — the shape a
 * recorded region would hand over. The same arithmetic runs through `fino:tensor` on
 * Metal in half precision, which is what CoreML computes in.
 *
 * Two sizes, because size is what selects this engine's kernels. At 256x768 the
 * cooperative-matrix GEMM does not engage and the smaller tiling is chosen; at 1024 both
 * do. Measuring only the first would compare CoreML against the slower of two paths this
 * engine has and call the difference a verdict.
 *
 * Two numbers per size, because they answer different questions. *Per call* is one
 * prediction waited for; CoreML's `predictionFromFeatures:` is synchronous, so this
 * engine is measured synchronised too and neither side is credited with the other's
 * submission model. *Compile and load* is paid once per compiled region and amortised
 * only if that region survives many steps — a per-call win a recompile eats is not a win.
 *
 * Measurements alternate pass by pass and keep the fastest of several rounds. Running one
 * side to completion and then the other has reversed a result in this project before: the
 * GPU's clock drifts far enough across a sequence to invert a two-to-one difference.
 *
 * Like the other spikes here, this asserts that both sides computed the same thing and
 * reports the rates without asserting which is faster. A threshold would turn a
 * measurement into a flaky test on someone else's hardware, and the answer is the point.
 *
 * ## The answer, on an M5 Max: no, and the apparent win was submission overhead
 *
 * GFLOP/s, higher is better, across several runs:
 *
 *                  CoreML/ANE   fino per call   fino pipelined
 *     256x768            3125+           1600-2650          4260
 *     1024               7900+           7800-8120          9570-10420
 *
 * Read per call, CoreML wins at 256x768 and is level at 1024. That was almost the
 * conclusion. But the shape of it is wrong for an arithmetic advantage: a faster engine
 * does not stop being faster as the problem grows, and the Neural Engine's lead
 * evaporates exactly where the work per dispatch gets large enough to dominate what
 * surrounds it. The spread in this engine's per-call column is the same tell — CoreML's
 * figure barely moves between runs while this one swings by half, which is what a number
 * governed by submission rather than arithmetic looks like.
 *
 * Issuing the same iterations without waiting between them settles it. Doing so removes
 * 39% of the per-call time at 256x768 and 23% at 1024 — this engine submits sixteen
 * dispatches per iteration where CoreML submits one graph, and at these sizes that is
 * most of the difference. With it removed this engine is ahead at both sizes.
 *
 * So the Neural Engine has no arithmetic headroom here worth a MIL emitter, an
 * `.mlpackage` writer, and a narrow-op backend. What the comparison actually found is
 * that *whole-graph submission* is worth about a quarter to a third at these sizes — and
 * that is available in-tree through capture/replay and the graph plane, with no CoreML
 * anywhere in it. FIN-156 closes on this measurement.
 *
 * ## What this deliberately does not claim
 *
 * The pipelined column is not like-for-like: CoreML has `predictionsFromBatch:`, which
 * would amortise submission on its side too, and it is not measured here. The claim that
 * survives that caveat is the narrower one — at 1024, per call, the two are level, so
 * there is no arithmetic advantage to buy. The pipelined figures explain *why* the
 * smaller size looked different; they are not the basis for the decision.
 *
 * Run with `--show-output=always` to see the tables.
 *
 * Skipped when the Objective-C runtime or the fixtures are absent;
 * `tests/fixtures/coreml/generate.py` makes them.
 */
import { describe, it } from 'fino:test/test';
import { dlopen, Pointer } from 'fino:ffi';
import { DiskFileSystem } from 'fino:file';
import { listDevices, tensor } from 'fino:tensor';
import type { Device, Tensor } from 'fino:tensor';
import {
  errorSlot,
  nsArray,
  nsDictionary,
  nsNumber,
  nsString,
  objcAvailable,
  objcClass,
  popPool,
  pushPool,
  retain,
  sel,
  send,
  takeError,
  withPool,
} from 'internal:metal';

/** `MLMultiArrayDataType.float32` — the fixture's interface type, whatever it computes in. */
const FLOAT32 = 65568n;

/** `MLComputeUnitsCPUAndNeuralEngine`. Three, not two; the enum puts `all` at two. */
const CPU_AND_NEURAL_ENGINE = 3n;

/** Matrix multiplies in the stack, each followed by a ReLU. */
const LAYERS = 8;

/**
 * Timed repetitions kept per side.
 *
 * One run of either side varies by more than the difference this exists to report, so a
 * single pass says as much about what else the machine was doing as about either engine.
 */
const ROUNDS = 5;

/** Untimed passes each side takes before any round is kept. */
const WARMUP = 5;

/** One size to compare the two engines at. */
interface Case {
  name: string;
  fixture: string;
  rows: number;
  width: number;
  iterations: number;
}

const CASES: readonly Case[] = [
  {
    name: '256x768, below this engine’s cooperative-matrix threshold',
    fixture: 'tests/fixtures/coreml/runtime-weights.mlpackage',
    rows: 256,
    width: 768,
    iterations: 20,
  },
  {
    name: '1024, where the cooperative-matrix GEMM engages',
    fixture: 'tests/fixtures/coreml/runtime-weights-1024.mlpackage',
    rows: 1024,
    width: 1024,
    iterations: 10,
  },
];

/**
 * A well-mixed value in [0, 1) from an integer.
 *
 * Deliberately a hash rather than a linear sequence mod some modulus. The first version
 * of this file used the latter, and eight layers of it produced an output that was
 * *entirely zero* on both sides: the operands stayed correlated enough through the
 * multiply that every sum landed the same side of the ReLU. Two engines agreeing on zero
 * is not evidence that either computed anything.
 */
function mix(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Deterministic activations, in [0, 1). */
function activations(count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < out.length; i++) out[i] = mix(i);
  return out;
}

/**
 * Deterministic weights for one layer.
 *
 * Spread to `sqrt(6 / fan_in)`, the uniform form of He initialisation, which makes a ReLU
 * layer roughly magnitude-preserving. That matters here for a mundane reason: eight
 * layers at any other scale either decay into half precision's subnormals or saturate out
 * of its range, and in both cases the two engines would be compared on arithmetic that
 * had stopped being meaningful several layers earlier.
 */
function weights(layer: number, width: number): Float32Array {
  const spread = Math.sqrt(6 / width);
  const out = new Float32Array(width * width);
  for (let i = 0; i < out.length; i++) {
    out[i] = (mix(i + layer * 0x10_0000) - 0.5) * 2 * spread;
  }
  return out;
}

/** Seconds per iteration for the fastest of `ROUNDS` timed passes. */
async function fastest(run: () => Promise<number>): Promise<number> {
  let best = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    const iterations = await run();
    best = Math.min(best, (performance.now() - start) / 1000 / iterations);
  }
  return best;
}

/** Seconds per iteration for each side, alternating so both sample the same clock. */
async function alternate(
  left: () => Promise<number>,
  right: () => Promise<number>,
): Promise<[number, number]> {
  let bestLeft = Infinity;
  let bestRight = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    let start = performance.now();
    let iterations = await left();
    bestLeft = Math.min(bestLeft, (performance.now() - start) / 1000 / iterations);

    start = performance.now();
    iterations = await right();
    bestRight = Math.min(bestRight, (performance.now() - start) / 1000 / iterations);
  }
  return [bestLeft, bestRight];
}

/** Whether a generated package is present. */
async function fixtureExists(path: string): Promise<boolean> {
  try {
    await new DiskFileSystem('.').stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A loaded model, the inputs it will be fed, and what it cost to get there. */
interface Loaded {
  model: unknown;
  features: unknown;
  slot: Uint8Array;
  compileSeconds: number;
  loadSeconds: number;
}

/**
 * Compile and load a fixture, and build its inputs once.
 *
 * The model comes back from a class convenience method, so it is autoreleased and has to
 * be retained to outlive the pool this runs in. The multi-arrays and the feature provider
 * come from `alloc`/`init` and are already owned.
 */
function load(item: Case): Loaded {
  dlopen('/System/Library/Frameworks/CoreML.framework/CoreML', {});
  let loaded: Loaded | null = null;

  withPool(() => {
    const MLModel = objcClass('MLModel')!;
    const slot = errorSlot();
    const source = send.ptrPtr(
      objcClass('NSURL')!,
      sel('fileURLWithPath:'),
      nsString(item.fixture),
    );

    const compileStart = performance.now();
    const compiled = send.ptrPtrBuf(MLModel, sel('compileModelAtURL:error:'), source, slot);
    const compileSeconds = (performance.now() - compileStart) / 1000;
    if (!compiled) throw new Error(`compile failed: ${takeError(slot) ?? 'no error given'}`);

    const config = send.ptr(
      send.ptr(objcClass('MLModelConfiguration')!, sel('alloc')),
      sel('init'),
    );
    send.voidI64(config, sel('setComputeUnits:'), CPU_AND_NEURAL_ENGINE);

    const loadStart = performance.now();
    const model = send.ptrPtrPtrBuf(
      MLModel,
      sel('modelWithContentsOfURL:configuration:error:'),
      compiled,
      config,
      slot,
    );
    const loadSeconds = (performance.now() - loadStart) / 1000;
    if (!model) throw new Error(`load failed: ${takeError(slot) ?? 'no error given'}`);

    const multiArray = (dims: readonly number[], fill: Float32Array) => {
      const array = send.ptrPtrI64Buf(
        send.ptr(objcClass('MLMultiArray')!, sel('alloc')),
        sel('initWithShape:dataType:error:'),
        nsArray(dims.map(nsNumber)),
        FLOAT32,
        slot,
      );
      if (!array) throw new Error(`MLMultiArray failed: ${takeError(slot) ?? 'no error'}`);
      const view = new Float32Array(
        Pointer.view(send.ptr(array as never, sel('dataPointer')) as never, fill.length * 4),
      );
      view.set(fill);
      return array;
    };

    const names = ['x', ...Array.from({ length: LAYERS }, (_, i) => `w${i}`)];
    const arrays = [
      multiArray([item.rows, item.width], activations(item.rows * item.width)),
      ...Array.from({ length: LAYERS }, (_, i) =>
        multiArray([item.width, item.width], weights(i, item.width)),
      ),
    ];

    const features = send.ptrPtrBuf(
      send.ptr(objcClass('MLDictionaryFeatureProvider')!, sel('alloc')),
      sel('initWithDictionary:error:'),
      nsDictionary(names.map(nsString), arrays),
      slot,
    );
    if (!features) throw new Error(`features failed: ${takeError(slot) ?? 'no error'}`);

    loaded = { model: retain(model), features, slot, compileSeconds, loadSeconds };
  });

  return loaded!;
}

/**
 * One prediction, returning `elements` of its output copied out.
 *
 * Pooled per call because the prediction and everything reached through it arrive
 * autoreleased, and twenty of them at megabytes apiece is not something to leave to the
 * enclosing scope.
 */
function predict(loaded: Loaded, elements: number): Float32Array {
  const pool = pushPool();
  try {
    const prediction = send.ptrPtrBuf(
      loaded.model as never,
      sel('predictionFromFeatures:error:'),
      loaded.features as never,
      loaded.slot,
    );
    if (!prediction) throw new Error(`predict failed: ${takeError(loaded.slot) ?? 'no error'}`);
    const value = send.ptrPtr(prediction, sel('featureValueForName:'), nsString('relu_7'));
    const result = send.ptr(value, sel('multiArrayValue'));
    return new Float32Array(
      Pointer.view(send.ptr(result, sel('dataPointer')) as never, elements * 4),
    ).slice();
  } finally {
    popPool(pool);
  }
}

/** The same stack through this engine, on `dev`, in half precision. */
async function finoStack(dev: Device, item: Case) {
  const x = await tensor([...activations(item.rows * item.width)], {
    shape: [item.rows, item.width],
    device: dev,
    dtype: 'f16',
  });
  const w: Tensor[] = [];
  for (let i = 0; i < LAYERS; i++) {
    w.push(
      await tensor([...weights(i, item.width)], {
        shape: [item.width, item.width],
        device: dev,
        dtype: 'f16',
      }),
    );
  }

  const run = (): Tensor => {
    let out = x;
    const scratch: Tensor[] = [];
    for (let i = 0; i < LAYERS; i++) {
      const mul = out.matmul(w[i]!);
      const act = mul.relu();
      scratch.push(mul, act);
      out = act;
    }
    for (const t of scratch.slice(0, -1)) t.dispose();
    return out;
  };

  // Draining the queue without adding work to it. Reading any tensor waits on everything
  // submitted, so a one-element tensor allocated once suffices. Slicing the result
  // instead would dispatch a copy kernel per iteration and charge this engine for work
  // CoreML never does, which is measuring the benchmark rather than the engine.
  const probe = await tensor([0], { device: dev });

  const warm = run();
  const full = Float32Array.from(await warm.cast('f32').data(), Number);
  warm.dispose();

  // The first pass through this stack costs three and a half times the rest — kernels
  // compile, buffers land, the GPU's clock comes up — and it settles within one pass.
  // Absorbing that here rather than inside a timed round keeps the fastest-round rule
  // from having to spend a round on it.
  for (let i = 0; i < WARMUP; i++) {
    const out = run();
    await probe.data();
    out.dispose();
  }

  return {
    full,
    async timed(): Promise<number> {
      for (let i = 0; i < item.iterations; i++) {
        const out = run();
        await probe.data();
        out.dispose();
      }
      return item.iterations;
    },
    /**
     * The same work with every iteration issued before anything is waited for.
     *
     * This is not a like-for-like number against a synchronous `predictionFromFeatures:`
     * and is not offered as one. It is here to separate two things the per-call figure
     * conflates: how fast the arithmetic runs, and what this engine pays to submit it one
     * operation at a time. Sixteen dispatches per iteration is sixteen submissions, and
     * CoreML makes one.
     */
    async pipelined(): Promise<number> {
      const held: Tensor[] = [];
      for (let i = 0; i < item.iterations; i++) held.push(run());
      await probe.data();
      for (const t of held) t.dispose();
      return item.iterations;
    },
    dispose(): void {
      probe.dispose();
      x.dispose();
      for (const t of w) t.dispose();
    },
  };
}

/** Largest absolute difference between two outputs, and the scale it sits against. */
function compare(a: Float32Array, b: Float32Array): { worst: number; scale: number } {
  let worst = 0;
  let scale = 0;
  for (let i = 0; i < a.length; i++) {
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    scale = Math.max(scale, Math.abs(b[i]!));
  }
  return { worst, scale };
}

describe('CoreML against this engine', () => {
  for (const item of CASES) {
    it(`runs the same stack at ${item.name}`, async (t) => {
      const metal = (await listDevices()).find((d) => d.type === 'metal') ?? null;
      if (!objcAvailable() || !metal || !(await fixtureExists(item.fixture))) {
        t.ok(true, 'SKIP: no Objective-C runtime, no Metal device, or the fixture is absent');
        return;
      }

      const loaded = load(item);
      const mine = await finoStack(metal, item);
      // Warm CoreML the same way, so neither side pays a first-call cost the other does
      // not, and keep the whole output: comparing one element of a ReLU is a coin flip on
      // whether the check says anything at all.
      const theirs = predict(loaded, item.rows * item.width);
      const { worst, scale } = compare(mine.full, theirs);
      for (let i = 0; i < WARMUP; i++) predict(loaded, 1);

      const coremlPass = async () => {
        for (let i = 0; i < item.iterations; i++) predict(loaded, 1);
        return item.iterations;
      };

      const [coreml, fino] = await alternate(coremlPass, mine.timed);
      // The same two measurements with each side run to completion on its own. Alternating
      // controls for the GPU's clock drifting across a long sequence, but it turns out to
      // introduce a confound of its own — see the note below the table.
      const soloFino = await fastest(mine.timed);
      const soloCoreml = await fastest(coremlPass);
      const piped = await fastest(mine.pipelined);

      const flops = 2 * item.rows * item.width * item.width * LAYERS;
      const rate = (seconds: number) => (flops / seconds / 1e9).toFixed(0);
      const ms = (seconds: number) => (seconds * 1000).toFixed(2);

      // Assertion messages only surface on failure, so the table is logged as well; run
      // with `--show-output=always` to see it.
      console.log(
        [
          `${LAYERS} x (matmul ${item.rows}x${item.width}x${item.width} + relu), f16, ` +
            `best of ${ROUNDS} alternated rounds`,
          '                 | alternated ms/call | alone ms/call | alone GFLOP/s',
          `  CoreML (ANE)   | ${ms(coreml).padStart(18)} | ${ms(soloCoreml).padStart(13)} | ${rate(soloCoreml).padStart(13)}`,
          `  fino (Metal)   | ${ms(fino).padStart(18)} | ${ms(soloFino).padStart(13)} | ${rate(soloFino).padStart(13)}`,
          `  fino pipelined | ${''.padStart(18)} | ${ms(piped).padStart(13)} | ${rate(piped).padStart(13)}`,
          `  ratio          | ${(coreml / fino).toFixed(2)}x alternated, ` +
            `${(soloCoreml / soloFino).toFixed(2)}x alone, ` +
            `${(soloCoreml / piped).toFixed(2)}x against pipelined ` +
            `(above 1 means this engine is faster)`,
          `  paid once      | compile ${ms(loaded.compileSeconds)}ms, load ${ms(loaded.loadSeconds)}ms` +
            (soloCoreml < soloFino
              ? `, break-even after ${Math.ceil(
                  (loaded.compileSeconds + loaded.loadSeconds) / (soloFino - soloCoreml),
                )} calls`
              : ', which never amortises at this size'),
          `  agreement      | worst ${worst.toExponential(2)} against a scale of ${scale.toFixed(4)}`,
        ].join('\n'),
      );

      // Both computed the same stack from the same values over every output, so a large
      // disagreement means one of them is not doing the arithmetic the timings claim.
      // Eight chained half-precision layers drift, so this is a loose bound on purpose:
      // loose enough to permit rounding, tight enough to catch a different computation.
      // The scale check is not ceremony — the first version of this file produced an
      // all-zero output on both sides and would otherwise have passed.
      t.ok(
        scale > 0 && worst / scale < 5e-2,
        `both compute the same stack (worst ${worst.toExponential(2)} against scale ${scale.toFixed(4)})`,
      );
      t.ok(
        true,
        `per call: CoreML ${ms(coreml)}ms (${rate(coreml)} GFLOP/s) vs ` +
          `Metal ${ms(fino)}ms (${rate(fino)} GFLOP/s), ${(coreml / fino).toFixed(2)}x`,
      );

      mine.dispose();
    });
  }
});
