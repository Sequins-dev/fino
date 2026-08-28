/**
 * Source-policy tests for implementation patterns that silently lose data.
 */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const root = new URL('../../', import.meta.url).pathname;
const decoder = new TextDecoder();

describe('source policy', () => {
  it('never uses JSON serialization to clone production values', async (t) => {
    const offenders: string[] = [];
    for (const directory of ['js', 'benchmarks']) {
      for await (const entry of fs.glob(`${root}${directory}/**/*.ts`)) {
        if (!entry.isFile()) continue;
        const source = decoder.decode(await fs.readFile(entry.path));
        if (/JSON\.parse\s*\(\s*JSON\.stringify/.test(source)) {
          offenders.push(entry.path.toString().slice(root.length));
        }
      }
    }
    t.deepEqual(offenders.sort(), []);
  });
});
