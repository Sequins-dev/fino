import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
const decoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  return decoder.decode(await fs.readFile(path));
}
describe('CI workflow', () => {
  it('runs the complete parallel suite once on Linux and once on macOS', async (t) => {
    const workflow = await readText('.github/workflows/ci.yml');
    const fullRuns = workflow.match(
      /run: FINO_REQUIRE_SQLITE=1 \.\/target\/debug\/fino test --parallel tests/g,
    );
    t.equal(fullRuns?.length, 2, 'Linux and macOS each run the complete parallel suite');
    t.equal(
      workflow.includes('FINO_TEST_CONCURRENCY:'),
      false,
      'CI retains the reactor-scaled default concurrency',
    );
  });

  it('reuses the Linux build for linting', async (t) => {
    const workflow = await readText('.github/workflows/ci.yml');
    const lintJob = workflow.match(/\n  lint:\n([\s\S]*?)\n  linux-build:/)?.[1];
    const linuxBuildJob = workflow.match(/\n  linux-build:\n([\s\S]*?)\n  macos-build:/)?.[1];

    t.ok(lintJob?.includes('needs: linux-build'), 'lint waits for the Linux build');
    t.equal(lintJob?.includes('cargo '), false, 'lint does not invoke Cargo');
    t.ok(lintJob?.includes('Restore Linux build'), 'lint restores the built Fino binary');
    t.ok(linuxBuildJob?.includes('run: cargo clippy'), 'the Linux build runs Rust lint');
  });
});
