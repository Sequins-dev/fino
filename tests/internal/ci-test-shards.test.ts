import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
const decoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  return decoder.decode(await fs.readFile(path));
}
describe('CI full test suites', () => {
  it('runs the complete suite once on Linux and once on macOS', async (t) => {
    const workflow = await readText('.github/workflows/ci.yml');
    const fullRuns = workflow.match(
      /run: FINO_REQUIRE_SQLITE=1 \.\/target\/debug\/fino test tests/g,
    );
    t.equal(fullRuns?.length, 2, 'Linux and macOS each run the unsplit suite');
  });
});
