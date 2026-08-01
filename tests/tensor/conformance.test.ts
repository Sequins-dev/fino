/**
 * The public conformance suite, run against every device.
 *
 * This is the suite an out-of-tree backend runs to claim it conforms, so it has to
 * pass for the in-tree ones first. It overlaps the differential tests by design: those
 * exist to locate a defect, this one exists to be a statement a third party can make.
 */
import { describe, it } from 'fino:test/test';
import {
  conformanceCases,
  formatReport,
  runConformanceEverywhere,
} from 'fino:tensor/conformance';

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
