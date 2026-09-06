/**
 * The public conformance suite, run against every device.
 *
 * This is the suite an out-of-tree backend runs to claim it conforms, so it has to
 * pass for the in-tree ones first. It overlaps the differential tests by design: those
 * exist to locate a defect, this one exists to be a statement a third party can make.
 */
import { describe, it } from 'fino:test/test';
import { compareValues } from 'internal:tensor/harness';
import { conformanceCases, formatReport, runConformanceEverywhere } from 'fino:tensor/conformance';

describe('conformance', () => {
  it('passes on every device the registry produces', async (t) => {
    const reports = await runConformanceEverywhere();
    t.ok(reports.length > 0, 'at least the reference backend is present');
    for (const report of reports) {
      t.equal(
        report.failed,
        0,
        report.failed === 0
          ? `${report.device.type} passes all ${report.passed}`
          : formatReport(report),
      );
    }
  });

  it('covers all but a named few of the registered operations', async (t) => {
    // `arange` is the exception: every case is a program over its inputs, and arange
    // takes none. Listing what is uncovered is part of the report rather than a
    // failure, but a suite that quietly stopped covering things would be worthless, so
    // the set is pinned here.
    const [report] = await runConformanceEverywhere({ groups: ['forward'] });
    t.deepEqual([...report!.uncovered], ['arange'], 'nothing has slipped out of coverage');
  });

  it('reports a filtered run honestly', async (t) => {
    const [report] = await runConformanceEverywhere({ filter: 'matmul' });
    t.ok(report!.results.length > 0, 'the filter selected something');
    t.ok(
      report!.results.every((r) => r.name.includes('matmul')),
      'and only that',
    );
    t.ok(
      report!.uncovered.length > 10,
      'a partial run says how much it did not exercise rather than implying a pass',
    );
  });

  it('names every case uniquely, so a report is unambiguous', (t) => {
    const names = conformanceCases().map((c) => c.name);
    t.equal(new Set(names).size, names.length, 'no duplicate case names');
  });
});

describe('portability', () => {
  it('computes powers of a negative base the way IEEE does', async (t) => {
    // SPIR-V leaves `pow` undefined for a negative base, and implementations differ:
    // one returns a usable number, another a NaN. Neither is wrong, so the engine
    // cannot delegate it — this pins the behaviour to `Math.pow` on every backend.
    const { listDevices, tensor } = await import('fino:tensor');
    const base = [-2, -1.5, -1, -0.5, 0.5, 1.5, 2, 3];
    for (const exponent of [2, 3, 0.5, -1]) {
      const want = base.map((b) => Math.pow(b, exponent));
      for (const dev of await listDevices()) {
        const x = await tensor(base, { device: dev });
        const got = [...(await x.pow(exponent).data())].map(Number);
        const agrees = want.every((value, i) =>
          Number.isNaN(value) ? Number.isNaN(got[i]!) : Math.abs(got[i]! - value) < 1e-5,
        );
        t.ok(agrees, `pow(x, ${exponent}) on ${dev.type}: ${got.map((v) => v.toFixed(3))}`);
        x.dispose();
      }
    }
  });
});

/**
 * The rule that decides whether every differential test passes.
 *
 * Its absolute floor scales with the largest expected magnitude, so that an output
 * element where a reduction cancelled is judged against the scale of the computation
 * rather than against its own small value. That relaxation has to stay narrow: it exists
 * for rounding that lands equally on every element, and a comparison that waved through
 * a genuinely wrong number would make the whole suite decorative.
 */
describe('comparison tolerance', () => {
  it('forgives cancellation without forgiving a wrong answer', (t) => {
    // One element cancels to a thousandth of the range, carrying the absolute rounding
    // error of the terms that produced it. Every neighbour holds the same error happily.
    const want = [9.4, -8.2, 0.030572308, 7.1, -6.5];
    const rounded = [...want];
    rounded[2] = 0.030573219;
    t.ok(compareValues(rounded, want, 'f32', 32).ok, 'rounding on a cancelled element passes');

    // The same element, wrong by a part in fifty of the range rather than by rounding.
    const wrong = [...want];
    wrong[2] = 0.2;
    t.ok(!compareValues(wrong, want, 'f32', 32).ok, 'a wrong small value still fails');

    // And a large element wrong by more than `rtol` allows, which the floor must not
    // rescue however big the range is.
    const drifted = [...want];
    drifted[0] = 9.4 * (1 + 1e-3);
    t.ok(!compareValues(drifted, want, 'f32', 32).ok, 'a drifted large value still fails');

    // Outputs no larger than one are unaffected by the scaling.
    const small = [0.4, -0.2, 0.11];
    const smallWrong = [0.4, -0.2, 0.11 + 1e-3];
    t.ok(!compareValues(smallWrong, small, 'f32', 32).ok, 'small outputs keep their floor');
  });
});
