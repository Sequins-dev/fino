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

  it('keeps TypeScript host failures distinct from argument type errors', async (t) => {
    const source = decoder.decode(await fs.readFile(`${root}src/typescript_format.rs`));
    const start = source.indexOf('fn set_json_result(');
    const end = source.indexOf('\n#[derive(Default)]', start);
    const helper = source.slice(start, end);

    t.ok(start >= 0 && end > start, 'locates the set_json_result helper');
    t.ok(helper.includes('v8util::throw_error'), 'host failures throw ordinary Error values');
    t.equal(
      helper.includes('v8util::throw_type_error'),
      false,
      'host failures are not reported as argument type errors',
    );
  });
});
