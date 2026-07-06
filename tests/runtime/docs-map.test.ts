/**
* Tests that js/documentation.md stays a complete map of the authored guides.
*/
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const jsRoot = new URL('../../js/', import.meta.url).pathname;
const textDecoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  return textDecoder.decode(await fs.readFile(path));
}

async function collectGuides(dir: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of fs.glob(`${dir}**/*.md`)) {
    const path = entry.path.toString();
    found.push(prefix + path.slice(dir.length));
  }
  return found.sort();
}

function linkedPaths(markdown: string): Set<string> {
  const linked = new Set<string>();
  for (const match of markdown.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
    const target = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    linked.add(target.replace(/^\.\//, ''));
  }
  return linked;
}

describe('documentation map', () => {
  it('links every authored guide under js/', async (t) => {
    const guides = await collectGuides(jsRoot, '');
    t.ok(guides.length > 30, `found ${guides.length} guides`);
    const map = await readText(`${jsRoot}documentation.md`);
    const linked = linkedPaths(map);
    const missing = guides.filter((guide) => {
      return guide !== 'documentation.md' && !linked.has(guide);
    });
    t.deepEqual(missing, [], 'every guide is linked from js/documentation.md');
  });

  it('links only guides that exist', async (t) => {
    const guides = new Set(await collectGuides(jsRoot, ''));
    const map = await readText(`${jsRoot}documentation.md`);
    const stale = [...linkedPaths(map)].filter((target) => {
      return !guides.has(target);
    });
    t.deepEqual(stale, [], 'every link in js/documentation.md resolves to a guide');
  });
});
