import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
const decoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  return decoder.decode(await fs.readFile(path));
}
async function containsTestFile(path: string): Promise<boolean> {
  const dir = await fs.dir(path);
  for (const entry of await dir.entries()) {
    if (entry.isFile() && entry.name.endsWith('.test.ts')) return true;
    if (entry.isDirectory() && await containsTestFile(entry.path.toString())) return true;
  }
  return false;
}
describe('CI test shards', () => {
  it('runs every top-level test directory containing test files', async (t) => {
    const workflow = await readText('.github/workflows/ci.yml');
    const testsDir = await fs.dir('tests');
    const testDirectories: string[] = [];
    for (const entry of await testsDir.entries()) {
      if (entry.isDirectory() && await containsTestFile(entry.path.toString())) {
        testDirectories.push(entry.name);
      }
    }
    const missing = testDirectories.sort().filter((name) => !workflow.includes(`          - ${name}\n`));
    t.deepEqual(missing, [], 'every test directory has a Linux and macOS matrix shard');
  });
});
