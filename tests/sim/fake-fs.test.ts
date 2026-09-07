/**
 * Public `FakeFs` filesystem adapter coverage.
 */
import { describe, it } from 'fino:test/test';
import { FakeFs, simulate } from 'fino:sim';

const GUEST = new URL('./fixtures/fake-fs-guest.ts', import.meta.url).pathname;

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

async function seed(files: Record<string, string>): Promise<FakeFs> {
  const fs = new FakeFs(files);
  for (const dir of ['/var', '/var/log', '/tmp']) await fs.filesystem.mkdir(dir);
  return fs;
}

describe('FakeFs', { exclusive: true }, () => {
  it('serves the fino:file filesystem contract through a parent-owned fake', async (t) => {
    const fs = await seed({
      '/etc/app/config': 'debug=true',
      '/etc/app/extra/nested.txt': 'deep',
    });

    const report = await simulate({ entry: GUEST, world: fs.world() });
    const result = report.result as GuestReport;

    t.equal(result.config, 'debug=true');
    t.equal(result.statSize, 10);
    t.ok(result.statIsFile);
    t.ok(result.statIsDir);
    t.deepEqual(result.listing, [
      { name: 'config', dir: false },
      { name: 'extra', dir: true },
    ]);
    t.equal(result.afterRename, 'draft');
    t.equal(result.missingCode, 'ENOENT');
    t.ok(result.wroteLog);
    t.equal(fs.snapshot()['/var/log/app.log'], 'started\nready\n');
    t.ok(!('/tmp/final' in fs.snapshot()));
    t.ok(report.journal.calls(FakeFs.specifier).length > 0);
  });

  it('serves symlinks created on the parent side', async (t) => {
    const fs = await seed({ '/real/app/config': 'linked=yes' });
    await fs.filesystem.mkdir('/etc');
    await fs.filesystem.symlink('/real/app', '/etc/app');

    const report = await simulate({ entry: GUEST, world: fs.world() });
    const result = report.result as GuestReport;

    t.equal(result.config, 'linked=yes');
    t.deepEqual(result.listing, [{ name: 'config', dir: false }]);
  });

  it('equal seeds journal identical file traffic', async (t) => {
    const first = await simulate({
      entry: GUEST,
      world: (await seed({ '/etc/app/config': 'x' })).world(),
      seed: 7,
    });
    const second = await simulate({
      entry: GUEST,
      world: (await seed({ '/etc/app/config': 'x' })).world(),
      seed: 7,
    });

    t.deepEqual(
      second.journal.calls().map((call) => [call.specifier, call.method]),
      first.journal.calls().map((call) => [call.specifier, call.method]),
    );
  });
});
