/**
 * fino:test/sim — simulation helpers for the test runner.
 *
 * `simulate()` from `fino:sim` is the engine; this is the ergonomics. It names
 * a cassette after the test that owns it, records on the first run, replays on
 * every run after, and fails the test when the guest diverges from what was
 * recorded — so a behavioural change shows up as a test failure rather than as
 * a silently different run.
 *
 * ```ts no_run
 * import { describe, it } from 'fino:test/test';
 * import { simulated } from 'fino:test/sim';
 *
 * describe('checkout', () => {
 *   it('charges once', async (t) => {
 *     const report = await simulated(t, {
 *       entry: './checkout.ts',
 *       world: { 'app:payments': { charge: async () => ({ ok: true }) } },
 *     });
 *     t.equal(report.journal.calls('app:payments', 'charge').length, 1);
 *   });
 * });
 * ```
 *
 * Delete a cassette file to re-record it.
 */
import { DiskFileSystem } from 'fino:file';
import { simulate, type Cassette, type SimReport, type SimulateOptions } from 'fino:sim';
/**
 * The subset of the test context these helpers need.
 *
 * Declared structurally so the helpers do not depend on the runner's concrete
 * context type.
 */
export interface SimTestContext {
  /** Test name, used to derive the cassette file name. */
  readonly name?: string;
}
/**
 * Options for `simulated()`.
 */
export interface SimulatedOptions extends Omit<SimulateOptions, 'cassette'> {
  /**
   * Directory cassettes are written to. Defaults to `./__cassettes__` beside
   * the working directory.
   */
  cassetteDir?: string;
  /**
   * Cassette file name. Defaults to a slug of the test's name.
   */
  cassetteName?: string;
  /**
   * Skip cassettes entirely and run against the live world every time.
   */
  noCassette?: boolean;
}
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'simulation' : slug;
}
/**
 * Run a simulation whose cassette is tied to the test that owns it.
 *
 * The first run records; later runs replay and fail on divergence. Pass
 * `noCassette` to opt out.
 *
 * ```ts no_run
 * import { simulated } from 'fino:test/sim';
 *
 * const report = await simulated({ name: 'my test' }, { entry: './worker.ts' });
 * console.log(report.seed);
 * ```
 */
export async function simulated(
  context: SimTestContext,
  options: SimulatedOptions,
): Promise<SimReport> {
  const { cassetteDir, cassetteName, noCassette, ...simOptions } = options;
  if (noCassette === true) return simulate(simOptions);
  const directory = cassetteDir ?? './__cassettes__';
  const file = `${directory}/${cassetteName ?? slugify(context.name ?? 'simulation')}.json`;
  const fs = new DiskFileSystem();
  const existing = await readCassette(fs, file);
  const report = await simulate({
    ...simOptions,
    cassette: existing === null ? { mode: 'record' } : { mode: 'replay', data: existing },
  });
  if (report.cassette !== undefined) {
    // mkdir(2) is not recursive and fails when the directory already exists;
    // either outcome is fine here, and a genuine problem surfaces on the write.
    try {
      await fs.mkdir(directory);
    } catch {}
    await fs.writeFile(file, new TextEncoder().encode(JSON.stringify(report.cassette, null, 2)));
  }
  return report;
}
async function readCassette(fs: DiskFileSystem, path: string): Promise<Cassette | null> {
  try {
    const bytes = await fs.readFile(path);
    return JSON.parse(new TextDecoder().decode(bytes)) as Cassette;
  } catch {
    return null;
  }
}
