import { DiskFileSystem } from 'fino:file';
import type { it as ItFn, describe as DescribeFn } from 'fino:test/test';

export interface CorpusCase {
  id: string;
  input: Uint8Array;
  expected: 'parse-ok' | 'parse-err' | unknown;
  skip?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function loadCorpus(dir: string): Promise<CorpusCase[]> {
  const fs = new DiskFileSystem();
  const cases: CorpusCase[] = [];

  async function readDir(subdir: string, expected: 'parse-ok' | 'parse-err'): Promise<void> {
    let dirEntry;
    try {
      dirEntry = await fs.dir(subdir);
    } catch {
      return;
    }
    for (const entry of await dirEntry.entries()) {
      if (!entry.isFile()) continue;
      const name = entry.path.basename();
      if (name.startsWith('.')) continue;
      if (name.endsWith('.json') || name.endsWith('.txt')) continue;

      const file = await fs.open(entry.path.toString(), 'r');
      const input = await file.bytes();
      await file.close();

      let caseExpected: 'parse-ok' | 'parse-err' | unknown = expected;
      if (expected === 'parse-ok') {
        const stem = name.slice(0, name.lastIndexOf('.'));
        const jsonPath = subdir + '/' + stem + '.json';
        try {
          const f = await fs.open(jsonPath, 'r');
          const jsonBytes = await f.bytes();
          await f.close();
          caseExpected = JSON.parse(dec.decode(jsonBytes)) as unknown;
        } catch {
          // no json companion — just verify parse succeeds
        }
      }

      cases.push({ id: subdir.split('/').pop()! + '/' + name, input, expected: caseExpected });
    }
  }

  let skipMap: Record<string, string> = {};
  try {
    const sf = await fs.open(dir + '/skip.json', 'r');
    const skipBytes = await sf.bytes();
    await sf.close();
    skipMap = JSON.parse(dec.decode(skipBytes)) as Record<string, string>;
  } catch {
    // no skip.json — all cases run
  }

  await readDir(dir + '/valid', 'parse-ok');
  await readDir(dir + '/invalid', 'parse-err');

  for (const c of cases) {
    const stem = c.id.split('/').pop()!.replace(/\.[^.]+$/, '');
    if (skipMap[stem]) c.skip = skipMap[stem];
  }

  return cases;
}

type TestFn = Parameters<typeof ItFn>[1];

export function runCorpus(
  cases: CorpusCase[],
  itFn: typeof ItFn,
  runner: (c: CorpusCase, t: Parameters<TestFn>[0]) => void | Promise<void>,
): void {
  for (const c of cases) {
    if (c.skip !== undefined) {
      itFn(c.id, { skip: c.skip }, () => {});
    } else {
      itFn(c.id, (t) => runner(c, t));
    }
  }
}
