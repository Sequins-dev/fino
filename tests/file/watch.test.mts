/**
 * Tests for fino:file/watch — cross-platform filesystem watcher.
 */

import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Watcher } from 'fino:file/watch';
import * as loop from 'fino:runtime/loop';

const TEST_DIR = '/tmp/fino-watch-test-' + Math.floor(Math.random() * 1_000_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect the next `n` events from the watcher within `timeoutMs`. */
async function collectEvents(watcher: Watcher, n: number, timeoutMs = 2000): Promise<any[]> {
  const events: any[] = [];
  const iter = watcher[Symbol.asyncIterator]();

  for (let i = 0; i < n; i++) {
    const t = loop.timeout(timeoutMs);
    const result = await Promise.race([
      iter.next().then(r => { t.cancel(); return r; }),
      t.then(() => ({ value: null, done: false, timedOut: true })),
    ]);
    if ((result as any).timedOut) break;
    if (result.done) break;
    events.push(result.value);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Watcher', () => {
  let fs: DiskFileSystem;

  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
  });

  after(async () => {
    // Remove test tree
    async function rm(path: string) {
      const st = await fs.lstat(path);
      if (st.isDirectory()) {
        const dir = await fs.dir(path);
        for await (const entry of dir) {
          await rm(entry.path.toString());
        }
        await fs.rmdir(path);
      } else {
        await fs.unlink(path);
      }
    }
    await rm(TEST_DIR);
  });

  it('detects file modification', async (t) => {
    const path = TEST_DIR + '/modify-test.txt';
    await fs.writeFile(path, 'initial');

    const watcher = new Watcher();
    watcher.watch(path);

    // Write to the file to trigger an event
    await fs.writeFile(path, 'modified');

    const events = await collectEvents(watcher, 1);
    watcher.close();
    await fs.unlink(path);

    t.ok(events.length >= 1,              'got at least one event');
    t.ok(events[0].type === 'modify' || events[0].type === 'delete', 'event is modify or delete');
    t.ok(events[0].path === path,         'event path matches watched file');
  });

  it('detects file deletion', async (t) => {
    const path = TEST_DIR + '/delete-test.txt';
    await fs.writeFile(path, 'hello');

    const watcher = new Watcher();
    watcher.watch(path);

    await fs.unlink(path);

    const events = await collectEvents(watcher, 1);
    watcher.close();

    t.ok(events.length >= 1, 'got at least one event');
    t.ok(events.some(e => e.type === 'delete'), 'got a delete event');
  });

  it('detects new files in a watched directory', async (t) => {
    const dir = TEST_DIR + '/dir-watch';
    await fs.mkdir(dir);

    const watcher = new Watcher();
    watcher.watch(dir);

    // Create a file in the watched directory
    const newFile = dir + '/newfile.txt';
    await fs.writeFile(newFile, 'content');

    const events = await collectEvents(watcher, 1);
    watcher.close();

    // Cleanup
    await fs.unlink(newFile);
    await fs.rmdir(dir);

    t.ok(events.length >= 1, 'got at least one event for new file');
    // On macOS, dir watches fire NOTE_WRITE on the dir path. On Linux, IN_CREATE on the file.
    t.ok(
      events.some(e => e.type === 'modify' || e.type === 'create'),
      'got modify or create event'
    );
  });

  it('close() stops the iterator', async (t) => {
    const path = TEST_DIR + '/close-test.txt';
    await fs.writeFile(path, 'x');

    const watcher = new Watcher();
    watcher.watch(path);

    watcher.close();

    const iter = watcher[Symbol.asyncIterator]();
    const result = await iter.next();
    t.ok(result.done, 'iterator is done after close()');

    await fs.unlink(path);
  });

  it('close() is idempotent', async (t) => {
    const watcher = new Watcher();
    watcher.close();
    watcher.close(); // should not throw
    t.ok(true, 'double close() does not throw');
  });

  it('watch() after close() throws', async (t) => {
    const watcher = new Watcher();
    watcher.close();
    t.throws(() => watcher.watch(TEST_DIR), /closed/, 'throws on watch after close');
  });

  it('watches multiple paths', async (t) => {
    const file1 = TEST_DIR + '/multi1.txt';
    const file2 = TEST_DIR + '/multi2.txt';
    await fs.writeFile(file1, 'a');
    await fs.writeFile(file2, 'b');

    const watcher = new Watcher();
    watcher.watch(file1);
    watcher.watch(file2);

    await fs.writeFile(file1, 'aa');

    const events = await collectEvents(watcher, 1);
    watcher.close();

    await fs.unlink(file1);
    await fs.unlink(file2);

    t.ok(events.length >= 1, 'got at least one event');
  });

  it('watch() on a non-existent path either throws or emits no events', async (t) => {
    const watcher = new Watcher();
    const nonExistent = TEST_DIR + '/does-not-exist-' + Date.now() + '.txt';
    let threw = false;
    try {
      watcher.watch(nonExistent);
    } catch (_) {
      threw = true;
    }

    if (!threw) {
      // If watch() did not throw, ensure no spurious events arrive in a short window
      const events = await collectEvents(watcher, 1, 150);
      watcher.close();
      t.equal(events.length, 0, 'no events emitted for non-existent path');
    } else {
      watcher.close();
      t.ok(true, 'watch() throws for non-existent path (acceptable behavior)');
    }
  });

  it('close() suppresses events for modifications made after close', async (t) => {
    const path = TEST_DIR + '/post-close-test.txt';
    await fs.writeFile(path, 'initial');

    const watcher = new Watcher();
    watcher.watch(path);
    watcher.close();

    // Modify the file after the watcher was closed — should not receive events
    await fs.writeFile(path, 'modified after close');

    const iter = watcher[Symbol.asyncIterator]();
    const result = await iter.next();
    t.ok(result.done === true, 'iterator is done immediately after close (no post-close events)');

    await fs.unlink(path);
  });

  it('recursive: true watches subdirectories', async (t) => {
    const dir = TEST_DIR + '/recursive-dir';
    const sub = dir + '/sub';
    await fs.mkdir(dir);
    await fs.mkdir(sub);

    const watcher = new Watcher({ recursive: true });
    watcher.watch(dir);

    // Give watcher time to set up recursive watches
    await loop.timeout(50);

    // Write to a file in the subdirectory
    const newFile = sub + '/deep.txt';
    await fs.writeFile(newFile, 'deep content');

    const events = await collectEvents(watcher, 1);
    watcher.close();

    // Cleanup
    await fs.unlink(newFile);
    await fs.rmdir(sub);
    await fs.rmdir(dir);

    t.ok(events.length >= 1, 'got at least one event from subdirectory');
  });
});
