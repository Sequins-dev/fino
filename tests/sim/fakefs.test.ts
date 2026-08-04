/**
 * FakeFs as a drop-in for fino:file: a guest that imports the real module
 * specifier is served by the in-memory fake, every operation crosses the
 * facade, and the journal sees all of it.
 */
import { describe, it } from 'fino:test/test';
import { FakeFs, simulate } from 'fino:sim';
const GUEST = new URL('./fixtures/file-guest.ts', import.meta.url).pathname;
type GuestReport = {
  config: string;
  statSize: number;
  statIsFile: boolean;
  statIsDir: boolean;
  listing: { name: string; dir: boolean }[];
  afterRename: string;
  missingCode: string;
  wroteLog: boolean;
};
/**
 * The guest writes into `/var/log` and `/tmp` without creating them, exactly as
 * it would on a real system, so the fake has to have them already.
 */
async function seed(files: Record<string, string>): Promise<FakeFs> {
  const fs = new FakeFs(files);
  for (const dir of ['/var', '/var/log', '/tmp']) await fs.filesystem.mkdir(dir);
  return fs;
}
function world(fs: FakeFs) {
  return { entry: GUEST, world: { ...fs.world() } };
}
describe('FakeFs serves fino:file', () => {
  it('a guest using DiskFileSystem lands on the fake', async (t) => {
    const fs = await seed({
      '/etc/app/config': 'debug=true',
      '/etc/app/extra/nested.txt': 'deep',
    });
    const report = await simulate(world(fs));
    const result = report.result as GuestReport;
    t.equal(result.config, 'debug=true', 'readFile returns seeded contents');
    t.equal(result.statSize, 10, 'stat sizes the file');
    t.ok(result.statIsFile, 'stat marks files as files');
    t.ok(result.statIsDir, 'implied parent directories stat as directories');
    t.deepEqual(
      result.listing,
      [
        { name: 'config', dir: false },
        { name: 'extra', dir: true },
      ],
      'directory iteration lists children with kinds',
    );
    t.equal(result.afterRename, 'draft', 'rename moves contents');
    t.equal(result.missingCode, 'ENOENT', 'errno codes survive the facade crossing');
    t.ok(result.wroteLog, 'file handles flush through to the fake');
    const snapshot = fs.snapshot();
    t.equal(snapshot['/var/log/app.log'], 'started\nready\n', 'writes are visible parent-side');
    t.ok(!('/tmp/final' in snapshot), 'unlink removed the renamed file');
    t.ok(
      report.journal.calls(FakeFs.specifier).length > 0,
      'file operations appear in the journal',
    );
  });
  it('serves symlinks created on the parent side', async (t) => {
    const fs = await seed({ '/real/app/config': 'linked=yes' });
    await fs.filesystem.mkdir('/etc');
    await fs.filesystem.symlink('/real/app', '/etc/app');
    const report = await simulate(world(fs));
    const result = report.result as GuestReport;
    t.equal(result.config, 'linked=yes', 'reads resolve through the link');
    t.deepEqual(
      result.listing,
      [{ name: 'config', dir: false }],
      'listing follows the link to the target directory',
    );
  });
  it('equal seeds journal identical file traffic', async (t) => {
    const first = await simulate({ ...world(await seed({ '/etc/app/config': 'x' })), seed: 7 });
    const second = await simulate({ ...world(await seed({ '/etc/app/config': 'x' })), seed: 7 });
    t.deepEqual(
      second.journal.calls().map((call) => [call.specifier, call.method]),
      first.journal.calls().map((call) => [call.specifier, call.method]),
      'same seed, same call sequence',
    );
  });
});
