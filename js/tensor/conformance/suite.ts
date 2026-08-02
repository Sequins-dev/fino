/**
 * The conformance cases, and the runner that executes them.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/conformance`; import from there.
 */
import type { Device } from '../backend.ts';
import { backendFor, listDevices, resolveDevice, sameDevice } from '../backend.ts';
import type { Tensor } from '../tensor.ts';
import { compareValues, describeComparison, sampleValues } from '../harness.ts';
import { allOps } from '../ops/registry.ts';
import {
  Generator,
  bernoulli,
  onesLike,
  poolStats,
  rand,
  randint,
  randn,
  tensor,
  tidy,
  zerosLike,
} from '../index.ts';
import { currentGraph, partition } from '../graph.ts';
import { layerNorm } from '../nn/functional.ts';

/** What a case does with its inputs. */
export type Program = (...inputs: Tensor[]) => Tensor;

/** One thing a backend has to get right. */
export interface ConformanceCase {
  /** Identifies the case in a report. */
  name: string;
  /** Which part of the contract it covers. */
  group: 'forward' | 'gradient' | 'memory' | 'runtime';
  /** Operations it exercises, so a report can say what is untested. */
  covers: readonly string[];
  /** Input shapes, filled with reproducible values. */
  inputs?: readonly { shape: readonly number[]; dtype?: 'f32' | 'i32'; seed?: number }[];
  run?: Program;
  /**
   * A case that asserts a behaviour rather than a value.
   *
   * Most of the contract is "this program produces these numbers", which the reference
   * backend can settle by computing them too. Some of it is not: whether disposal
   * returns memory, whether a device stays responsive, whether one program survives a
   * change of shape. Those have no reference value to compare against, so the case
   * checks the property itself and throws to fail.
   */
  check?: (device: Device) => Promise<void>;
  /**
   * Extra relative tolerance beyond the dtype's.
   *
   * A reduction accumulates error, so a case that sums a long run needs more room
   * than one that does not; the runner scales by the reduction length it is told.
   */
  reduction?: number;
}

/** How one case turned out. */
export interface CaseResult {
  name: string;
  group: ConformanceCase['group'];
  ok: boolean;
  /** Absent when the case passed. */
  detail?: string;
  /** Set when the case could not run at all. */
  error?: string;
}

/** What a whole run produced. */
export interface ConformanceReport {
  device: Device;
  passed: number;
  failed: number;
  results: readonly CaseResult[];
  /**
   * Registered operations no case exercises.
   *
   * Reported rather than asserted: a backend is free to be incomplete, but a caller
   * should be able to see what the run did not say anything about.
   */
  uncovered: readonly string[];
}

/** How {@link runConformance} behaves. */
export interface ConformanceOptions {
  /** Run only cases whose name contains this. */
  filter?: string;
  /** Run only these groups. Defaults to all of them. */
  groups?: readonly ConformanceCase['group'][];
}

/**
 * Every case the suite runs.
 *
 * Deliberately expressed through the public `fino:tensor` surface rather than through
 * backend calls: a backend passes by making ordinary programs produce the right
 * numbers, not by implementing an interface a particular way.
 */
export function conformanceCases(): ConformanceCase[] {
  return [
    // -- forward ------------------------------------------------------------
    {
      name: 'elementwise chain',
      group: 'forward',
      covers: ['mul', 'add', 'relu', 'tanh'],
      inputs: [{ shape: [64] }],
      run: (x) => x.mul(2).add(1).relu().tanh(),
    },
    {
      name: 'transcendentals',
      group: 'forward',
      covers: ['abs', 'log', 'exp', 'sqrt', 'sigmoid', 'gelu', 'silu'],
      inputs: [{ shape: [48] }],
      run: (x) => x.abs().add(0.5).log().exp().sqrt().sigmoid().add(x.gelu()).add(x.silu()),
    },
    {
      name: 'broadcasting',
      group: 'forward',
      covers: ['add', 'sub', 'maximum'],
      inputs: [{ shape: [6, 5] }, { shape: [5] }, { shape: [6, 1] }],
      run: (a, b, c) => a.add(b).sub(c).maximum(a),
    },
    {
      name: 'comparison and select',
      group: 'forward',
      covers: ['gt', 'where'],
      inputs: [{ shape: [40] }, { shape: [40], seed: 2 }],
      run: (a, b) => a.gt(b).where(a, b),
    },
    {
      name: 'dtype round trip',
      group: 'forward',
      covers: ['cast'],
      inputs: [{ shape: [32] }],
      run: (x) => x.mul(10).cast('i32').cast('f32'),
    },
    {
      name: 'reductions',
      group: 'forward',
      covers: ['sum', 'mean', 'max', 'min'],
      inputs: [{ shape: [4, 6] }],
      run: (x) => x.sum([1]).add(x.mean([1])).add(x.max([1])).add(x.min([1])),
      reduction: 6,
    },
    {
      name: 'reductions keeping dimensions',
      group: 'forward',
      covers: ['sum', 'mean'],
      inputs: [{ shape: [2, 3, 4] }],
      run: (x) => x.sum([0], true).mul(2).add(x.mean([1], true).sum([0], true)),
      reduction: 4,
    },
    {
      name: 'argmax',
      group: 'forward',
      covers: ['argmax'],
      inputs: [{ shape: [5, 7] }],
      run: (x) => x.argmax(1).cast('f32'),
    },
    {
      name: 'softmax',
      group: 'forward',
      covers: ['softmax', 'logSoftmax'],
      inputs: [{ shape: [5, 9] }],
      run: (x) => x.softmax(1).add(x.logSoftmax(1).exp()),
      reduction: 9,
    },
    {
      name: 'softmax over an interior axis',
      group: 'forward',
      covers: ['softmax'],
      inputs: [{ shape: [2, 5, 3] }],
      run: (x) => x.softmax(1),
      reduction: 5,
    },
    {
      name: 'matmul',
      group: 'forward',
      covers: ['gemm'],
      inputs: [{ shape: [9, 7] }, { shape: [7, 5], seed: 2 }],
      run: (a, b) => a.matmul(b),
      reduction: 7,
    },
    {
      name: 'batched matmul with a broadcast operand',
      group: 'forward',
      covers: ['gemm'],
      inputs: [{ shape: [2, 4, 3] }, { shape: [1, 3, 5], seed: 2 }],
      run: (a, b) => a.matmul(b),
      reduction: 3,
    },
    {
      name: 'matmul large enough to change tiling',
      group: 'forward',
      covers: ['gemm'],
      // Backends may pick a different kernel once a multiply is big enough to be worth
      // a larger tile, and that choice is invisible from here — which is exactly why it
      // needs a case. Both sides are past the threshold this engine uses, with a short
      // reduction so the case stays cheap.
      inputs: [{ shape: [520, 24] }, { shape: [24, 520], seed: 2 }],
      run: (a, b) => a.matmul(b),
      reduction: 24,
    },
    {
      name: 'matmul whose extents divide its tiles',
      group: 'forward',
      covers: ['gemm'],
      // A backend may drop its bounds checks when every tile lands wholly inside the
      // matrix, which is a second kernel for the same operation. These extents divide
      // the tile sizes this engine uses; the case above deliberately does not.
      inputs: [{ shape: [512, 32] }, { shape: [32, 512], seed: 2 }],
      run: (a, b) => a.matmul(b),
      reduction: 32,
    },
    {
      name: 'movement',
      group: 'forward',
      covers: ['transpose', 'permute', 'reshape', 'expand'],
      inputs: [{ shape: [2, 3, 4] }],
      run: (x) => x.permute([2, 0, 1]).reshape([4, 6]).transpose().mul(2),
    },
    {
      name: 'slicing',
      group: 'forward',
      covers: ['slice'],
      inputs: [{ shape: [7, 8] }],
      run: (x) => x.slice([{ start: 1, step: 2 }, { start: 3 }]),
    },
    {
      name: 'indexing',
      group: 'forward',
      covers: ['indexSelect', 'scatterAdd'],
      inputs: [{ shape: [6, 4] }, { shape: [5], dtype: 'i32', seed: 3 }],
      run: (table, ids) => table.indexSelect(ids.abs().cast('i32'), 0).mul(2),
    },

    {
      name: 'seeded sampling',
      group: 'forward',
      covers: ['uniform', 'normal', 'randint', 'bernoulli'],
      // The input exists only to say which device to draw on; the case is about the
      // stream, which is a pure function of the seed and so has to agree everywhere.
      inputs: [{ shape: [64] }],
      run: (x) => {
        const where = { device: x.device };
        return rand([64], { generator: new Generator(2024), ...where })
          .add(randn([64], { generator: new Generator(2025), ...where }))
          .add(bernoulli([64], { generator: new Generator(2026), p: 0.3, ...where }))
          .add(randint([64], { generator: new Generator(2027), high: 10, ...where }).cast('f32'));
      },
    },
    {
      name: 'more transcendentals',
      group: 'forward',
      covers: ['sin', 'cos', 'erf', 'rsqrt', 'pow', 'div', 'neg'],
      inputs: [{ shape: [40] }],
      run: (x) => x.sin().add(x.cos()).add(x.erf()).add(x.abs().add(1).rsqrt()).add(x.pow(2)).div(3).neg(),
    },
    {
      name: 'rounding',
      group: 'forward',
      covers: ['floor', 'ceil', 'round'],
      inputs: [{ shape: [40] }],
      run: (x) => x.mul(4).floor().add(x.mul(4).ceil()).add(x.mul(4).round()),
    },
    {
      name: 'comparisons',
      group: 'forward',
      covers: ['eq', 'ne', 'lt', 'le', 'ge', 'logicalNot', 'minimum'],
      inputs: [{ shape: [40] }, { shape: [40], seed: 2 }],
      run: (a, b) =>
        a
          .eq(b)
          .cast('f32')
          .add(a.ne(b).cast('f32'))
          .add(a.lt(b).cast('f32'))
          .add(a.le(b).cast('f32'))
          .add(a.ge(b).cast('f32'))
          .add(a.lt(b).logicalNot().cast('f32'))
          .add(a.minimum(b)),
    },
    {
      name: 'boolean reductions',
      group: 'forward',
      covers: ['all', 'any'],
      inputs: [{ shape: [4, 6] }],
      run: (x) => x.gt(0).all([1]).cast('f32').add(x.gt(0).any([1]).cast('f32')),
      reduction: 6,
    },
    {
      name: 'product and argmin',
      group: 'forward',
      covers: ['prod', 'argmin'],
      inputs: [{ shape: [4, 5] }],
      run: (x) => x.abs().add(0.5).prod([1]).add(x.argmin(1).cast('f32')),
      reduction: 5,
    },
    {
      name: 'constant creation',
      group: 'forward',
      covers: ['fill'],
      inputs: [{ shape: [3, 4] }],
      run: (x) => onesLike(x).mul(2).add(zerosLike(x)).add(x),
    },
    {
      name: 'layer normalisation',
      group: 'forward',
      covers: ['layerNorm'],
      inputs: [{ shape: [5, 8] }, { shape: [8], seed: 2 }, { shape: [8], seed: 3 }],
      run: (x, weight, bias) => layerNorm(x, weight, bias),
      reduction: 8,
    },

    // -- gradients ----------------------------------------------------------
    {
      // The scaling keeps `tanh` away from saturation deliberately. Its gradient is
      // 1 - tanh squared, and at an argument of three that is a difference of two
      // nearly equal numbers: implementations that agree on `tanh` to the last bit
      // then disagree on the gradient by a hundred times as much. That is a fact about
      // subtraction rather than about a backend, and a conformance suite that failed on
      // it would be reporting the wrong thing.
      name: 'gradient of an elementwise chain',
      group: 'gradient',
      covers: ['mul', 'add', 'tanh'],
      inputs: [{ shape: [32] }],
      run: (x) => x.mul(0.5).add(0.1).tanh().sum(),
    },
    {
      name: 'gradient through a matmul with a broadcast operand',
      group: 'gradient',
      covers: ['gemm', 'sum'],
      inputs: [{ shape: [2, 3, 4] }, { shape: [4, 5], seed: 2 }],
      run: (a, b) => a.matmul(b).mul(2).sum(),
      reduction: 4,
    },
    {
      name: 'gradient through softmax',
      group: 'gradient',
      covers: ['softmax'],
      inputs: [{ shape: [4, 6] }],
      run: (x) => x.softmax(1).mul(3).sum(),
      reduction: 6,
    },
    {
      name: 'gradient through softmax over an interior axis',
      group: 'gradient',
      covers: ['softmax'],
      inputs: [{ shape: [2, 4, 5] }],
      run: (x) => x.softmax(1).mul(3).sum(),
      reduction: 4,
    },
    {
      name: 'gradient through a reduction that keeps dimensions',
      group: 'gradient',
      covers: ['sum'],
      inputs: [{ shape: [3, 5] }],
      run: (x) => x.sum([0], true).mul(x.sum([1], true)).sum(),
      reduction: 5,
    },
    {
      name: 'gradient through movement',
      group: 'gradient',
      covers: ['permute', 'reshape', 'expand'],
      inputs: [{ shape: [2, 3, 4] }],
      run: (x) => x.permute([2, 0, 1]).reshape([4, 6]).mul(2).sum(),
    },
    {
      name: 'gradient through a slice',
      group: 'gradient',
      covers: ['slice'],
      inputs: [{ shape: [6, 6] }],
      run: (x) => x.slice([{ start: 1, step: 2 }]).mul(2).sum(),
    },
    {
      name: 'gradient through layer normalisation',
      group: 'gradient',
      covers: ['layerNorm'],
      inputs: [{ shape: [5, 8] }, { shape: [8], seed: 2 }],
      run: (x, weight) => layerNorm(x, weight).mul(2).sum(),
      reduction: 8,
    },
    {
      name: 'gradient through division and powers',
      group: 'gradient',
      covers: ['div', 'pow', 'neg'],
      inputs: [{ shape: [24] }, { shape: [24], seed: 2 }],
      run: (a, b) => a.pow(2).div(b.abs().add(1)).neg().sum(),
    },
    {
      name: 'gradient through an embedding lookup',
      group: 'gradient',
      covers: ['indexSelect', 'scatterAdd'],
      inputs: [{ shape: [6, 4] }, { shape: [5], dtype: 'i32', seed: 3 }],
      run: (table, ids) => table.indexSelect(ids.abs().cast('i32'), 0).mul(2).sum(),
    },

    // -- memory ---------------------------------------------------------------

    {
      name: 'disposal returns buffers',
      group: 'memory',
      covers: [],
      check: async (device) => {
        const before = poolStats(device);
        const held = [];
        for (let i = 0; i < 8; i++) {
          held.push(await tensor(new Array(4096).fill(1), { device }));
        }
        for (const value of held) value.dispose();
        const after = poolStats(device);
        if (after.liveBuffers !== before.liveBuffers) {
          throw new Error(
            `${after.liveBuffers - before.liveBuffers} buffers were still held after disposal`,
          );
        }
      },
    },
    {
      name: 'the pool reuses what disposal returned',
      group: 'memory',
      covers: [],
      check: async (device) => {
        // A pool that never reuses is not wrong, only pointless — and the whole reason
        // allocation is not left to the driver is that reuse is what makes a training
        // loop's steady state free.
        const first = await tensor(new Array(2048).fill(0), { device });
        first.dispose();
        const before = poolStats(device);
        const second = await tensor(new Array(2048).fill(0), { device });
        const after = poolStats(device);
        second.dispose();
        if (after.hits <= before.hits) {
          throw new Error('an allocation the pool could have served hit the device instead');
        }
      },
    },
    {
      name: 'tidy releases its intermediates',
      group: 'memory',
      covers: ['mul', 'add', 'exp', 'log'],
      check: async (device) => {
        const x = await tensor([1, 2, 3, 4], { device });
        const before = poolStats(device);
        const out = tidy(() => x.mul(2).add(1).exp().log());
        // The chain makes four tensors; one survives, so at most one buffer is added.
        const after = poolStats(device);
        const added = after.liveBuffers - before.liveBuffers;
        out.dispose();
        x.dispose();
        if (added > 1) throw new Error(`${added} buffers survived a scope that returns one`);
      },
    },

    // -- runtime --------------------------------------------------------------

    {
      name: 'one program over changing shapes',
      group: 'runtime',
      covers: ['mul', 'sum'],
      check: async (device) => {
        // Kernels are cached by a key that includes the shape's *class*, not its
        // extent, so a size that is not a multiple of a workgroup has to be handled by
        // the same compiled kernel as one that is. These sizes straddle the boundaries.
        for (const n of [1, 7, 63, 64, 65, 1000]) {
          const x = await tensor(
            Array.from({ length: n }, (_, i) => i + 1),
            { device },
          );
          const got = Number(await x.mul(2).sum().item());
          const want = n * (n + 1);
          x.dispose();
          if (Math.abs(got - want) > Math.max(1e-3, want * 1e-6)) {
            throw new Error(`size ${n} gave ${got}, expected ${want}`);
          }
        }
      },
    },
    {
      name: 'the recorded graph partitions into contiguous regions',
      group: 'runtime',
      covers: [],
      check: async (device) => {
        const x = await tensor([1, 2, 3, 4], { device });
        const out = x.mul(2).add(1).sum();
        await out.item();
        const view = currentGraph();
        // Two targets splitting the recording by operation, so partitioning has to
        // produce more than one region and every node has to land in exactly one.
        const regions = partition(view, [
          { name: 'reductions', supports: (node) => node.op === 'sum' },
          { name: 'rest', supports: () => true, fallback: true },
        ]);
        const assigned = regions.reduce((total, region) => total + region.nodes.length, 0);
        const total = [...view.nodes()].length;
        x.dispose();
        out.dispose();
        if (assigned !== total) {
          throw new Error(`partitioning covered ${assigned} of ${total} nodes`);
        }
        const names = new Set(regions.map((region) => region.target));
        if (!names.has('reductions')) {
          throw new Error('the reduction never reached the target that claimed it');
        }
      },
    },
    {
      name: 'the event loop keeps turning while the device works',
      group: 'runtime',
      covers: ['gemm'],
      check: async (device) => {
        // A backend that compiles no kernels computes inline, so it has no wait for
        // anything to overlap with. What can be checked there is that the answer came
        // out right, which is worth doing rather than skipping the case entirely.
        const inline = backendFor(device).caps.kernelCompile === false;
        const side = inline ? 8 : 256;
        const ones = await tensor(new Array(side * side).fill(1), {
          shape: [side, side],
          device,
        });

        let fired = false;
        setTimeout(() => {
          fired = true;
        }, 0);

        // Deliberately not a race between the timer and the work. A race asserts that
        // the device is slower than a timer, which is a fact about the hardware rather
        // than about this engine, and it flaps the moment the machine is busy or a
        // kernel gets faster. Issuing many independent multiplies and waiting for the
        // last makes the wait long enough that the loop must turn during it, so a
        // zero-delay timer scheduled beforehand will have run by the time it returns.
        const issued: Tensor[] = [];
        for (let i = 0; i < (inline ? 1 : 100); i++) issued.push(ones.matmul(ones));
        const last = issued[issued.length - 1]!;
        const got = Number((await last.data())[0]);

        for (const value of issued) value.dispose();
        ones.dispose();

        if (got !== side) throw new Error(`the multiply gave ${got}, expected ${side}`);
        if (!inline && !fired) {
          throw new Error('a zero-delay timer did not run while the device worked');
        }
      },
    },
  ];
}

/**
 * Run the suite on a device, comparing everything against the reference backend.
 *
 * The reference backend is the definition of correct, so a device conforms when the
 * same program produces the same numbers on it. Nothing here reaches for a backend
 * method directly: an out-of-tree backend passes by making ordinary `fino:tensor`
 * programs come out right, which is the only thing a caller of this engine depends on.
 */
export async function runConformance(
  target: 'auto' | string | Device,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  // Also the registration point for the built-in providers; see below.
  const { tensor } = await import('../index.ts');
  const device = await resolveDevice(target);
  const reference = await resolveDevice('cpu');
  const groups = options.groups ?? (['forward', 'gradient', 'memory', 'runtime'] as const);

  const cases = conformanceCases().filter(
    (item) =>
      groups.includes(item.group) && (!options.filter || item.name.includes(options.filter)),
  );

  const results: CaseResult[] = [];
  const covered = new Set<string>();
  for (const item of cases) {
    for (const op of item.covers) covered.add(op);
    try {
      if (item.check) {
        await item.check(device);
        results.push({ name: item.name, group: item.group, ok: true });
        continue;
      }
      const values = item.inputs!.map((spec, index) =>
        sampleValues(
          spec.shape.reduce((a, b) => a * b, 1),
          spec.seed ?? index + 1,
        ),
      );
      const wantsGradient = item.group === 'gradient';

      const build = async (where: Device): Promise<Tensor[]> =>
        Promise.all(
          item.inputs!.map((spec, index) =>
            tensor(values[index]!, {
              shape: [...spec.shape],
              dtype: spec.dtype ?? 'f32',
              device: where,
              // Only the first input carries a gradient, so a report names one tensor
              // rather than needing the caller to disambiguate.
              requiresGrad: wantsGradient && index === 0 && spec.dtype !== 'i32',
            }),
          ),
        );

      const evaluate = async (where: Device): Promise<ArrayLike<number>> => {
        const inputs = await build(where);
        const out = item.run!(...inputs);
        if (!wantsGradient) {
          const data = await out.data();
          for (const input of inputs) input.dispose();
          return data;
        }
        out.backward();
        const gradient = inputs[0]!.grad;
        if (!gradient) throw new Error('the program produced no gradient for its first input');
        const data = await gradient.data();
        for (const input of inputs) input.dispose();
        return data;
      };

      // A device that *is* the reference has nothing to compare against; running the
      // case still proves it does not throw, which is what the report says.
      const got = await evaluate(device);
      if (sameDevice(device, reference)) {
        results.push({ name: item.name, group: item.group, ok: true });
        continue;
      }
      const want = await evaluate(reference);
      const comparison = compareValues(got, want, 'f32', item.reduction ?? 1);
      results.push({
        name: item.name,
        group: item.group,
        ok: comparison.ok,
        detail: comparison.ok ? undefined : describeComparison(comparison, item.name),
      });
    } catch (cause) {
      results.push({
        name: item.name,
        group: item.group,
        ok: false,
        error: (cause as Error).message,
      });
    }
  }

  const uncovered = allOps()
    .map((op) => op.name)
    .filter((name) => !covered.has(name))
    .sort();

  return {
    device,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    uncovered,
  };
}

/** Run the suite on every device the registry can produce. */
export async function runConformanceEverywhere(
  options: ConformanceOptions = {},
): Promise<ConformanceReport[]> {
  // Importing the barrel is what registers the built-in providers, so it has to happen
  // before asking which devices exist. Reaching for `backend.ts` alone would find an
  // empty registry and report success over nothing.
  await import('../index.ts');
  const reports: ConformanceReport[] = [];
  for (const device of await listDevices()) reports.push(await runConformance(device, options));
  return reports;
}

/** Render a report as lines a human or a CI log can read. */
export function formatReport(report: ConformanceReport): string {
  const lines = [
    `${report.device.type}:${report.device.index} — ${report.passed} passed, ${report.failed} failed`,
  ];
  for (const result of report.results) {
    if (result.ok) continue;
    lines.push(`  FAIL ${result.name}: ${result.error ?? result.detail ?? 'mismatch'}`);
  }
  if (report.uncovered.length > 0) {
    lines.push(`  not exercised: ${report.uncovered.join(', ')}`);
  }
  return lines.join('\n');
}
