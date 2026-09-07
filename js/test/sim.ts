/**
 * fino:test/sim — test-owned cassette storage for deterministic simulations.
 *
 * `simulate()` from `fino:sim` owns execution, recording, and replay. This
 * module adds only test storage policy: the first run records transport frames
 * in a JSON file named after the test, and later runs replay that file. Delete
 * the cassette deliberately when changed behavior should be recorded again.
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
 */
import { DiskFileSystem } from 'fino:file';
import { join } from 'fino:file/path';
import { simulate, type Cassette, type SimReport, type SimulateOptions } from 'fino:sim';

/** Test identity required to assign ownership of a cassette file. */
export interface SimTestContext {
  /** Full test name used to derive the default cassette basename. */
  readonly name: string;
}

/** Options for a simulation whose cassette belongs to one test. */
export interface SimulatedOptions extends Omit<SimulateOptions, 'cassette'> {
  /** Directory containing cassettes. Defaults to `./__cassettes__` from the Realm cwd. */
  cassetteDir?: string;
  /** Cassette basename without `.json`. Defaults to a slug of the full test name. */
  cassetteName?: string;
  /** Run against the live world without reading or writing cassette storage. */
  noCassette?: boolean;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'simulation' : slug;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

async function readCassette(fs: DiskFileSystem, path: string): Promise<Cassette | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Cassette;
}

async function ensureDirectory(fs: DiskFileSystem, path: string): Promise<void> {
  try {
    await fs.mkdir(path);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
}

/**
 * Run a deterministic simulation using the cassette owned by `context.name`.
 *
 * An absent cassette is recorded and written after a successful run. An
 * existing cassette is replayed without invoking its live providers. Invalid,
 * unreadable, or divergent cassettes fail the test and remain untouched.
 */
export async function simulated<Result = unknown>(
  context: SimTestContext,
  options: SimulatedOptions,
): Promise<SimReport<Result>> {
  const { cassetteDir, cassetteName, noCassette, ...simulation } = options;
  if (noCassette === true) return simulate<Result>(simulation);

  const directory = cassetteDir ?? './__cassettes__';
  const basename = cassetteName ?? slugify(context.name);
  const path = join(directory, `${basename}.json`).toString();
  const fs = new DiskFileSystem();
  const cassette = await readCassette(fs, path);
  const report = await simulate<Result>({
    ...simulation,
    cassette: cassette === undefined ? { mode: 'record' } : { mode: 'replay', data: cassette },
  });

  if (report.cassette !== undefined) {
    await ensureDirectory(fs, directory);
    const json = JSON.stringify(report.cassette, null, 2) + '\n';
    await fs.writeFile(path, new TextEncoder().encode(json));
  }
  return report;
}
