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
import * as loop from 'internal:runtime/loop';
const TEST_DIR = '/tmp/fino-realm-watch-' + Math.floor(Math.random() * 1e6);
const fs = new DiskFileSystem();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function writeText(path: string, text: string): Promise<void> {
  return fs.writeFile(path, textEncoder.encode(text));
}
async function poll(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (await check()) return;
    } catch (_) {}
    if (Date.now() >= deadline) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await loop.timeout(10);
  }
}
async function readCounter(path: string): Promise<number> {
  try {
    const n = parseInt(textDecoder.decode(await fs.readFile(path)));
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
    `const _decode = (bytes) => new TextDecoder().decode(bytes);`,
    `const _encode = (text) => new TextEncoder().encode(text);`,
    `const _n = parseInt(await _fs.readFile(${cp}).then(_decode).catch(() => '0'));`,
    `await _fs.writeFile(${cp}, _encode(String(isNaN(_n) ? 1 : _n + 1)));`,
    extra
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
  it('reactor realm reloads when entry file changes', async (t) => {
    const dir = TEST_DIR + '/embed-entry';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.ts';
    const counterPath = dir + '/counter.txt';
    await writeText(entryPath, entryCode(counterPath));
    const realm = new Realm({
      entry: entryPath,
      watch: true
    });
    const runP = realm.run();
    // Wait for the first run.
    await poll(() => readCounter(counterPath).then((n) => n >= 1), 2e3);
    // Allow the watcher loop to set up after the first import graph is known.
    await loop.timeout(100);
    // Trigger reload by modifying the entry file.
    await writeText(entryPath, entryCode(counterPath) + '\n// trigger reload');
    // Wait for the second run.
    await poll(() => readCounter(counterPath).then((n) => n >= 2), 3e3);
    realm.terminate();
    await runP;
    t.ok(await readCounter(counterPath) >= 2, 'reactor realm reloaded after entry change');
  });
  it('reactor realm reloads when a transitively imported file changes', async (t) => {
    const dir = TEST_DIR + '/embed-transitive';
    await fs.mkdir(dir);
    const helperPath = dir + '/helper.ts';
    const entryPath = dir + '/entry.ts';
    const counterPath = dir + '/counter.txt';
    await writeText(helperPath, `export const VERSION = 1;`);
    await fs.writeFile(entryPath, textEncoder.encode([
      `import { VERSION } from ${JSON.stringify(helperPath)};`,
      `import { DiskFileSystem } from 'fino:file';`,
      `const _fs = new DiskFileSystem();`,
      `const _decode = (bytes) => new TextDecoder().decode(bytes);`,
      `const _encode = (text) => new TextEncoder().encode(text);`,
      `const _n = parseInt(await _fs.readFile(${JSON.stringify(counterPath)}).then(_decode).catch(() => '0'));`,
      `await _fs.writeFile(${JSON.stringify(counterPath)}, _encode(String(isNaN(_n) ? 1 : _n + 1)));`,
      `void VERSION;`
    ].join('\n')));
    const realm = new Realm({
      entry: entryPath,
      watch: true
    });
    const runP = realm.run();
    await poll(() => readCounter(counterPath).then((n) => n >= 1), 2e3);
    await loop.timeout(100);
    // Modify the helper — not the entry — to trigger reload.
    await writeText(helperPath, `export const VERSION = 2;`);
    await poll(() => readCounter(counterPath).then((n) => n >= 2), 3e3);
    realm.terminate();
    await runP;
    t.ok(await readCounter(counterPath) >= 2, 'realm reloaded after transitive import changed');
  });
  it('files not imported by the realm do not trigger reload', async (t) => {
    const dir = TEST_DIR + '/embed-unimported';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.ts';
    const counterPath = dir + '/counter.txt';
    const unrelatedPath = dir + '/unrelated.txt';
    await writeText(entryPath, entryCode(counterPath));
    await writeText(unrelatedPath, 'initial');
    const realm = new Realm({
      entry: entryPath,
      watch: true
    });
    const runP = realm.run();
    await poll(() => readCounter(counterPath).then((n) => n >= 1), 2e3);
    await loop.timeout(100);
    // Modify a file the realm never imported.
    await writeText(unrelatedPath, 'changed');
    // Wait past the debounce window (50ms) to confirm no reload fires.
    await loop.timeout(150);
    const countAfter = await readCounter(counterPath);
    realm.terminate();
    await runP;
    t.equal(countAfter, 1, 'unrelated file change did not trigger reload');
  });
  it('multiple rapid edits within the debounce window produce one reload', async (t) => {
    const dir = TEST_DIR + '/embed-debounce';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.ts';
    const counterPath = dir + '/counter.txt';
    await writeText(entryPath, entryCode(counterPath));
    const realm = new Realm({
      entry: entryPath,
      watch: true
    });
    const runP = realm.run();
    await poll(() => readCounter(counterPath).then((n) => n >= 1), 2e3);
    await loop.timeout(100);
    // Write 5 times rapidly; each write resets the 50ms debounce timer.
    for (let i = 0; i < 5; i++) {
      await writeText(entryPath, entryCode(counterPath) + `\n// rapid edit ${i}`);
      await loop.timeout(5);
    }
    // Wait for exactly one reload.
    await poll(() => readCounter(counterPath).then((n) => n >= 2), 3e3);
    // Extra wait to confirm no second reload fires.
    await loop.timeout(100);
    const finalCount = await readCounter(counterPath);
    realm.terminate();
    await runP;
    t.equal(finalCount, 2, 'rapid edits collapsed into a single reload');
  });
  it('realm.terminate() stops the watch loop and resolves run()', async (t) => {
    const dir = TEST_DIR + '/embed-terminate';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.ts';
    const counterPath = dir + '/counter.txt';
    await writeText(entryPath, entryCode(counterPath));
    const realm = new Realm({
      entry: entryPath,
      watch: true
    });
    const runP = realm.run();
    await poll(() => readCounter(counterPath).then((n) => n >= 1), 2e3);
    await loop.timeout(50);
    realm.terminate();
    await runP;
    t.ok(true, 'run() resolved after terminate()');
    // Modifying the entry after terminate must not cause another reload.
    const countBefore = await readCounter(counterPath);
    await writeText(entryPath, entryCode(counterPath) + '\n// post-terminate');
    await loop.timeout(150);
    t.equal(await readCounter(counterPath), countBefore, 'no reload after terminate()');
  });
  it('process realm reloads when entry file changes', async (t) => {
    const dir = TEST_DIR + '/process-entry';
    await fs.mkdir(dir);
    const entryPath = dir + '/entry.ts';
    const counterPath = dir + '/counter.txt';
    await writeText(entryPath, entryCode(counterPath));
    const realm = new Realm({
      process: true,
      entry: entryPath,
      watch: true
    });
    const runP = realm.run();
    await poll(() => readCounter(counterPath).then((n) => n >= 1), 8e3);
    await loop.timeout(150);
    await writeText(entryPath, entryCode(counterPath) + '\n// trigger reload');
    await poll(() => readCounter(counterPath).then((n) => n >= 2), 8e3);
    realm.terminate();
    await runP;
    t.ok(await readCounter(counterPath) >= 2, 'process realm reloaded after entry change');
  });
});
