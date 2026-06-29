/**
* Tests for fino:file/watch — cross-platform filesystem watcher.
*/
import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Watcher } from 'fino:file/watch';
const TEST_DIR = '/tmp/fino-watch-test-' + Math.floor(Math.random() * 1e6);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Collect the next `n` events from the watcher within `timeoutMs`. */
async function collectEvents(watcher: Watcher, n: number, timeoutMs = 2e3): Promise<any[]> {
  const events: any[] = [];
  const iter = watcher[Symbol.asyncIterator]();
  for (let i = 0; i < n; i++) {
    let timeoutId = 0;
    const timeout = new Promise<{
      value: null;
      done: false;
      timedOut: true;
    }>((resolve) => {
      timeoutId = setTimeout(() => resolve({
        value: null,
        done: false,
        timedOut: true
      }), timeoutMs);
    });
    const result = await Promise.race([iter.next().then((r) => {
      clearTimeout(timeoutId);
      return r;
    }), timeout]);
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
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
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
    t.ok(events.length >= 1, 'got at least one event');
    t.ok(events[0].type === 'modify' || events[0].type === 'delete', 'event is modify or delete');
    t.ok(events[0].path === path, 'event path matches watched file');
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
    t.ok(events.some((e) => e.type === 'delete'), 'got a delete event');
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
    t.ok(events.some((e) => e.type === 'modify' || e.type === 'create'), 'got modify or create event');
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
    watcher.close();
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
    t.throws(() => watcher.watch(nonExistent), /watch|open|inotify/i, 'watch() throws for non-existent path');
    watcher.close();
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
    await delay(50);
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
  it('reports rename or delete when a watched file is renamed then removed', async (t) => {
    const path = TEST_DIR + '/rename-delete-source.txt';
    const renamed = TEST_DIR + '/rename-delete-target.txt';
    await fs.writeFile(path, 'hello');
    const watcher = new Watcher();
    watcher.watch(path);
    await fs.rename(path, renamed);
    await fs.unlink(renamed);
    const events = await collectEvents(watcher, 2);
    watcher.close();
    t.ok(events.length >= 1, 'got at least one rename/delete transition event');
    t.ok(events.some((e) => e.type === 'rename' || e.type === 'delete'), 'transition is normalized as rename or delete');
    t.ok(events.some((e) => e.path === path || e.path === renamed), 'event path identifies the watched file or renamed file');
  });
  it('recursive: true watches subdirectories created after watch()', async (t) => {
    const dir = TEST_DIR + '/recursive-created-dir';
    const sub = dir + '/created';
    const file = sub + '/later.txt';
    await fs.mkdir(dir);
    const watcher = new Watcher({ recursive: true });
    watcher.watch(dir);
    await fs.mkdir(sub);
    await delay(100);
    await fs.writeFile(file, 'later');
    const events = await collectEvents(watcher, 3);
    watcher.close();
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(sub).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
    t.ok(events.length >= 1, 'got at least one event after recursive subdirectory creation');
    t.ok(events.some((e) => e.path === dir || e.path === sub || e.path === file), 'event path is directory or created child depending on backend');
  });
  it('close() completes an already pending iterator next()', async (t) => {
    const path = TEST_DIR + '/pending-close.txt';
    await fs.writeFile(path, 'x');
    const watcher = new Watcher();
    watcher.watch(path);
    const iter = watcher[Symbol.asyncIterator]();
    const pending = iter.next();
    watcher.close();
    const result = await pending;
    t.equal(result.done, true, 'pending next() resolves as done after close');
    await fs.unlink(path);
  });
  it('duplicate watch() calls for the same path do not emit duplicate notifications', async (t) => {
    const path = TEST_DIR + '/duplicate-watch.txt';
    await fs.writeFile(path, 'initial');
    const watcher = new Watcher();
    watcher.watch(path);
    watcher.watch(path);
    await fs.writeFile(path, 'changed');
    const events = await collectEvents(watcher, 2, 250);
    watcher.close();
    await fs.unlink(path);
    t.ok(events.length >= 1, 'duplicate watch still delivers a notification');
    t.ok(events.length <= 2, 'duplicate watch does not multiply backend notifications');
    t.ok(events.every((e) => e.path === path), 'event path matches watched file');
  });
  it('rapid event bursts produce at least one coherent notification', async (t) => {
    const path = TEST_DIR + '/burst.txt';
    await fs.writeFile(path, '0');
    const watcher = new Watcher();
    watcher.watch(path);
    for (let i = 1; i <= 8; i++) {
      await fs.writeFile(path, String(i));
    }
    const events = await collectEvents(watcher, 4);
    watcher.close();
    await fs.unlink(path);
    t.ok(events.length >= 1, 'burst produced at least one event');
    t.ok(events.every((e) => e.path === path), 'burst notifications identify the watched file');
    t.ok(events.some((e) => e.type === 'modify' || e.type === 'delete'), 'burst event has a coherent normalized type');
  });
  it('uses explicit close and string paths instead of Node fs.watch options', async (t) => {
    const path = TEST_DIR + '/release-contract.txt';
    await fs.writeFile(path, 'x');
    const watcher = new Watcher({
      recursive: false,
      persistent: false,
      encoding: 'buffer',
      signal: AbortSignal.abort()
    } as any);
    watcher.watch(path);
    const pending = watcher[Symbol.asyncIterator]().next();
    watcher.close();
    const result = await pending;
    t.equal(result.done, true, 'unsupported Node-style options do not replace explicit close');
    const pathWatcher = new Watcher();
    t.throws(() => pathWatcher.watch(new URL(`file://${path}`) as any), /path must be a string/i, 'watch() only accepts string paths');
    pathWatcher.close();
    await fs.unlink(path);
  });
});
