/**
 * Tests for realm watch mode (watch: true).
 *
 * The watcher runs inside the child realm's bootstrap; when a watched file
 * changes, the child calls requestReload() (sets terminated=true), the parent
 * sees a null step result and spawns a fresh handle — same Realm instance.
 */

import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Realm } from 'fino:realm';
import * as loop from 'fino:runtime/loop';

const TEST_DIR = '/tmp/fino-realm-watch-' + Math.floor(Math.random() * 1_000_000);
const fs = new DiskFileSystem();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function poll(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (await check()) return;
    } catch (_) {}
    if (Date.now() >= deadline) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await loop.timeout(50);
  }
}

async function readCounter(path: string): Promise<number> {
  try {
    const n = parseInt(await fs.readFile(path));
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** Build the content of a dynamically-created entry module. */
function entryCode(counterPath: string, extra = ''): string {
  const cp = JSON.stringify(counterPath);
  return [
    `import { DiskFileSystem } from 'fino:file';`,
    `const _fs = new DiskFileSystem();`,
    `const _n = parseInt(await _fs.readFile(${cp}).catch(() => '0'));`,
    `await _fs.writeFile(${cp}, String(isNaN(_n) ? 1 : _n + 1));`,
    extra,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Realm watch mode', () => {
  before(async () => {
    await fs.mkdir(TEST_DIR);
  });

  after(async () => {
    async function rm(p: string): Promise<void> {
      const st = await fs.lstat(p);
      if (st.isDirectory()) {
        const dir = await fs.dir(p);
        for await (const e of dir) await rm(e.path.toString());
        await fs.rmdir(p);
      } else {
        await fs.unlink(p);
      }
    }
    await rm(TEST_DIR);
  });
  it('watch: true with remote: true throws', (t) => {
    t.throws(
      () => new Realm({ entry: '/irrelevant.mts', watch: true, remote: true }),
      /watch/i,
      'constructing with watch + remote throws',
    );
  });

  it('embedded realm reloads when entry file changes', async (t) => {
    const dir = TEST_DIR + '/embed-entry';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';

    await fs.writeFile(entryPath, entryCode(counterPath));

    const realm = new Realm({ entry: entryPath, watch: true });
    const runP = realm.run();

    // Wait for the first run.
    await poll(() => readCounter(counterPath).then(n => n >= 1), 2000);

    // Allow the watcher loop to set up (async import of fino:file/watch +
    // _refreshWatchPaths). The entry file is already in fs_cache by this point.
    await loop.timeout(300);

    // Trigger reload by modifying the entry file.
    await fs.writeFile(entryPath, entryCode(counterPath) + '\n// trigger reload');

    // Wait for the second run.
    await poll(() => readCounter(counterPath).then(n => n >= 2), 3000);

    realm.terminate();
    await runP;

    t.ok(await readCounter(counterPath) >= 2, 'embedded realm reloaded after entry change');
  });

  it('embedded realm reloads when a transitively imported file changes', async (t) => {
    const dir = TEST_DIR + '/embed-transitive';
    await fs.mkdir(dir);
    const helperPath = dir + '/helper.mts';
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';

    await fs.writeFile(helperPath, `export const VERSION = 1;`);
    await fs.writeFile(entryPath, [
      `import { VERSION } from ${JSON.stringify(helperPath)};`,
      `import { DiskFileSystem } from 'fino:file';`,
      `const _fs = new DiskFileSystem();`,
      `const _n = parseInt(await _fs.readFile(${JSON.stringify(counterPath)}).catch(() => '0'));`,
      `await _fs.writeFile(${JSON.stringify(counterPath)}, String(isNaN(_n) ? 1 : _n + 1));`,
      `void VERSION;`,
    ].join('\n'));

    const realm = new Realm({ entry: entryPath, watch: true });
    const runP = realm.run();

    await poll(() => readCounter(counterPath).then(n => n >= 1), 2000);
    await loop.timeout(300);

    // Modify the helper — not the entry — to trigger reload.
    await fs.writeFile(helperPath, `export const VERSION = 2;`);

    await poll(() => readCounter(counterPath).then(n => n >= 2), 3000);

    realm.terminate();
    await runP;

    t.ok(await readCounter(counterPath) >= 2, 'realm reloaded after transitive import changed');
  });

  it('files not imported by the realm do not trigger reload', async (t) => {
    const dir = TEST_DIR + '/embed-unimported';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';
    const unrelatedPath = dir + '/unrelated.txt';

    await fs.writeFile(entryPath, entryCode(counterPath));
    await fs.writeFile(unrelatedPath, 'initial');

    const realm = new Realm({ entry: entryPath, watch: true });
    const runP = realm.run();

    await poll(() => readCounter(counterPath).then(n => n >= 1), 2000);
    await loop.timeout(300);

    // Modify a file the realm never imported.
    await fs.writeFile(unrelatedPath, 'changed');

    // Wait well past the debounce window (50ms) to confirm no reload fires.
    await loop.timeout(500);
    const countAfter = await readCounter(counterPath);

    realm.terminate();
    await runP;

    t.equal(countAfter, 1, 'unrelated file change did not trigger reload');
  });

  it('multiple rapid edits within the debounce window produce one reload', async (t) => {
    const dir = TEST_DIR + '/embed-debounce';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';

    await fs.writeFile(entryPath, entryCode(counterPath));

    const realm = new Realm({ entry: entryPath, watch: true });
    const runP = realm.run();

    await poll(() => readCounter(counterPath).then(n => n >= 1), 2000);
    await loop.timeout(300);

    // Write 5 times rapidly; each write resets the 50ms debounce timer.
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(entryPath, entryCode(counterPath) + `\n// rapid edit ${i}`);
      await loop.timeout(5);
    }

    // Wait for exactly one reload.
    await poll(() => readCounter(counterPath).then(n => n >= 2), 3000);

    // Extra wait to confirm no second reload fires.
    await loop.timeout(200);
    const finalCount = await readCounter(counterPath);

    realm.terminate();
    await runP;

    t.equal(finalCount, 2, 'rapid edits collapsed into a single reload');
  });

  it('realm.terminate() stops the watch loop and resolves run()', async (t) => {
    const dir = TEST_DIR + '/embed-terminate';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';

    await fs.writeFile(entryPath, entryCode(counterPath));

    const realm = new Realm({ entry: entryPath, watch: true });
    const runP = realm.run();

    await poll(() => readCounter(counterPath).then(n => n >= 1), 2000);
    await loop.timeout(100);

    realm.terminate();
    await runP;

    t.ok(true, 'run() resolved after terminate()');

    // Modifying the entry after terminate must not cause another reload.
    const countBefore = await readCounter(counterPath);
    await fs.writeFile(entryPath, entryCode(counterPath) + '\n// post-terminate');
    await loop.timeout(300);
    t.equal(await readCounter(counterPath), countBefore, 'no reload after terminate()');
  });

  it('thread realm reloads when entry file changes', async (t) => {
    const dir = TEST_DIR + '/thread-entry';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';

    await fs.writeFile(entryPath, entryCode(counterPath));

    const realm = new Realm({ thread: true, entry: entryPath, watch: true });
    const runP = realm.run();

    // Thread realms take longer to start.
    await poll(() => readCounter(counterPath).then(n => n >= 1), 5000);
    await loop.timeout(500);

    await fs.writeFile(entryPath, entryCode(counterPath) + '\n// trigger reload');

    await poll(() => readCounter(counterPath).then(n => n >= 2), 5000);

    realm.terminate();
    await runP;

    t.ok(await readCounter(counterPath) >= 2, 'thread realm reloaded after entry change');
  });

  it('process realm reloads when entry file changes', async (t) => {
    const dir = TEST_DIR + '/process-entry';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.mts';
    const counterPath = dir + '/counter.txt';

    await fs.writeFile(entryPath, entryCode(counterPath));

    const realm = new Realm({ process: true, entry: entryPath, watch: true });
    const runP = realm.run();

    // Process realms have startup overhead.
    await poll(() => readCounter(counterPath).then(n => n >= 1), 8000);
    await loop.timeout(600);

    await fs.writeFile(entryPath, entryCode(counterPath) + '\n// trigger reload');

    await poll(() => readCounter(counterPath).then(n => n >= 2), 8000);

    realm.terminate();
    await runP;

    t.ok(await readCounter(counterPath) >= 2, 'process realm reloaded after entry change');
  });
});
