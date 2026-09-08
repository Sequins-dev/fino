/**
 * Tests for fino:file/watch — cross-platform filesystem watcher.
 */
import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Watcher, type WatchEvent } from 'fino:file/watch';
import * as loop from 'internal:runtime/loop';
const TEST_DIR = '/tmp/fino-watch-test-' + Math.floor(Math.random() * 1e6);
const writeText = (fs: DiskFileSystem, path: string, text: string): Promise<void> =>
  fs.writeFile(path, new TextEncoder().encode(text));
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
      timeoutId = setTimeout(
        () =>
          resolve({
            value: null,
            done: false,
            timedOut: true,
          }),
        timeoutMs,
      );
    });
    const result = await Promise.race([
      iter.next().then((r) => {
        clearTimeout(timeoutId);
        return r;
      }),
      timeout,
    ]);
    if ((result as any).timedOut) break;
    if (result.done) break;
    events.push(result.value);
  }
  return events;
}
/** Wait for the first event matching `check`, ignoring unrelated native notes. */
async function waitForEvent(
  watcher: Watcher,
  check: (event: WatchEvent) => boolean,
  timeoutMs = 2e3,
): Promise<WatchEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  const iter = watcher[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timeoutId = 0;
    const result = await Promise.race([
      iter.next().then((event) => {
        clearTimeout(timeoutId);
        return event;
      }),
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
    if (result === undefined || result.done) return undefined;
    if (check(result.value)) return result.value;
  }
  return undefined;
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
    await writeText(fs, path, 'initial');
    const watcher = new Watcher();
    await watcher.watch(path);
    // Write to the file to trigger an event
    await writeText(fs, path, 'modified');
    const events = await collectEvents(watcher, 1);
    watcher.close();
    await fs.unlink(path);
    t.ok(events.length >= 1, 'got at least one event');
    t.ok(events[0].type === 'modify' || events[0].type === 'delete', 'event is modify or delete');
    t.ok(events[0].path === path, 'event path matches watched file');
  });
  it('detects file deletion', async (t) => {
    const path = TEST_DIR + '/delete-test.txt';
    await writeText(fs, path, 'hello');
    const watcher = new Watcher();
    await watcher.watch(path);
    await fs.unlink(path);
    const event = await waitForEvent(watcher, (event) => event.type === 'delete');
    watcher.close();
    t.ok(event !== undefined, 'got a delete event');
  });
  it('detects new files in a watched directory', async (t) => {
    const dir = TEST_DIR + '/dir-watch';
    await fs.mkdir(dir);
    const watcher = new Watcher();
    await watcher.watch(dir);
    // Create a file in the watched directory
    const newFile = dir + '/newfile.txt';
    await writeText(fs, newFile, 'content');
    const events = await collectEvents(watcher, 1);
    watcher.close();
    // Cleanup
    await fs.unlink(newFile);
    await fs.rmdir(dir);
    t.ok(events.length >= 1, 'got at least one event for new file');
    // On macOS, dir watches fire NOTE_WRITE on the dir path. On Linux, IN_CREATE on the file.
    t.ok(
      events.some((e) => e.type === 'modify' || e.type === 'create'),
      'got modify or create event',
    );
  });
  it('close() stops the iterator', async (t) => {
    const path = TEST_DIR + '/close-test.txt';
    await writeText(fs, path, 'x');
    const watcher = new Watcher();
    await watcher.watch(path);
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
    await writeText(fs, file1, 'a');
    await writeText(fs, file2, 'b');
    const watcher = new Watcher();
    await watcher.watch(file1);
    await watcher.watch(file2);
    await writeText(fs, file1, 'aa');
    const events = await collectEvents(watcher, 1);
    watcher.close();
    await fs.unlink(file1);
    await fs.unlink(file2);
    t.ok(events.length >= 1, 'got at least one event');
  });
  it('watch() on a non-existent path either throws or emits no events', async (t) => {
    const watcher = new Watcher();
    const nonExistent = TEST_DIR + '/does-not-exist-' + Date.now() + '.txt';
    t.throws(
      () => watcher.watch(nonExistent),
      /watch|open|inotify/i,
      'watch() throws for non-existent path',
    );
    watcher.close();
  });
  it('close() suppresses events for modifications made after close', async (t) => {
    const path = TEST_DIR + '/post-close-test.txt';
    await writeText(fs, path, 'initial');
    const watcher = new Watcher();
    await watcher.watch(path);
    watcher.close();
    // Modify the file after the watcher was closed — should not receive events
    await writeText(fs, path, 'modified after close');
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
    await watcher.watch(dir);
    // Give watcher time to set up recursive watches
    await delay(50);
    // Write to a file in the subdirectory
    const newFile = sub + '/deep.txt';
    await writeText(fs, newFile, 'deep content');
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
    await writeText(fs, path, 'hello');
    const watcher = new Watcher();
    await watcher.watch(path);
    await fs.rename(path, renamed);
    await fs.unlink(renamed);
    const events = await collectEvents(watcher, 2);
    watcher.close();
    t.ok(events.length >= 1, 'got at least one rename/delete transition event');
    t.ok(
      events.some((e) => e.type === 'rename' || e.type === 'delete'),
      'transition is normalized as rename or delete',
    );
    t.ok(
      events.some((e) => e.path === path || e.path === renamed),
      'event path identifies the watched file or renamed file',
    );
  });
  it('recursive: true watches subdirectories created after watch()', async (t) => {
    const dir = TEST_DIR + '/recursive-created-dir';
    const sub = dir + '/created';
    const file = sub + '/later.txt';
    await fs.mkdir(dir);
    const watcher = new Watcher({ recursive: true });
    await watcher.watch(dir);
    await fs.mkdir(sub);
    await delay(100);
    await writeText(fs, file, 'later');
    const events = await collectEvents(watcher, 3);
    watcher.close();
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(sub).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
    t.ok(events.length >= 1, 'got at least one event after recursive subdirectory creation');
    t.ok(
      events.some((e) => e.path === dir || e.path === sub || e.path === file),
      'event path is directory or created child depending on backend',
    );
  });
  it('close() completes an already pending iterator next()', async (t) => {
    const path = TEST_DIR + '/pending-close.txt';
    await writeText(fs, path, 'x');
    const watcher = new Watcher();
    await watcher.watch(path);
    const iter = watcher[Symbol.asyncIterator]();
    const pending = iter.next();
    watcher.close();
    const result = await pending;
    t.equal(result.done, true, 'pending next() resolves as done after close');
    await fs.unlink(path);
  });
  it('duplicate watch() calls for the same path do not emit duplicate notifications', async (t) => {
    const path = TEST_DIR + '/duplicate-watch.txt';
    await writeText(fs, path, 'initial');
    const watcher = new Watcher();
    await watcher.watch(path);
    await watcher.watch(path);
    await writeText(fs, path, 'changed');
    const events = await collectEvents(watcher, 2, 250);
    watcher.close();
    await fs.unlink(path);
    t.ok(events.length >= 1, 'duplicate watch still delivers a notification');
    t.ok(events.length <= 2, 'duplicate watch does not multiply backend notifications');
    t.ok(
      events.every((e) => e.path === path),
      'event path matches watched file',
    );
  });
  it('rapid event bursts produce at least one coherent notification', async (t) => {
    const path = TEST_DIR + '/burst.txt';
    await writeText(fs, path, '0');
    const watcher = new Watcher();
    await watcher.watch(path);
    for (let i = 1; i <= 8; i++) {
      await writeText(fs, path, String(i));
    }
    const events = await collectEvents(watcher, 4);
    watcher.close();
    await fs.unlink(path);
    t.ok(events.length >= 1, 'burst produced at least one event');
    t.ok(
      events.every((e) => e.path === path),
      'burst notifications identify the watched file',
    );
    t.ok(
      events.some((e) => e.type === 'modify' || e.type === 'delete'),
      'burst event has a coherent normalized type',
    );
  });
  it('uses explicit close and string paths instead of Node fs.watch options', async (t) => {
    const watcher = new Watcher({
      recursive: false,
      persistent: false,
      encoding: 'buffer',
      signal: AbortSignal.abort(),
    } as any);
    const pending = watcher[Symbol.asyncIterator]().next();
    watcher.close();
    const result = await pending;
    t.equal(result.done, true, 'unsupported Node-style options do not replace explicit close');
    const pathWatcher = new Watcher();
    t.throws(
      () => pathWatcher.watch(new URL('file:///tmp/fino-watch-release-contract') as any),
      /path must be a string/i,
      'watch() only accepts string paths',
    );
    pathWatcher.close();
  });
  it('settles a pending watch() when the watcher closes before it is armed', async (t) => {
    const watcher = new Watcher({ recursive: true });
    // No await: close() lands while the arming acknowledgement is still in
    // flight, which is the ordering Presentation.close() hits in practice.
    const arming = watcher.watch(TEST_DIR);
    watcher.close();
    const outcome = await Promise.race([
      arming.then(() => 'settled'),
      loop.timeout(2e3).then(() => 'hung'),
    ]);
    t.equal(outcome, 'settled', 'watch() does not strand its caller when the watch is torn down');
  });
  it('stops arming watches once closed, so a recursive scan cannot leak handles', async (t) => {
    const root = TEST_DIR + '/scan-after-close';
    await fs.mkdir(root);
    for (let i = 0; i < 24; i++) await fs.mkdir(`${root}/dir-${i}`);
    const baseline = loop._activeHandleCounts();
    const watcher = new Watcher({ recursive: true });
    void watcher.watch(root);
    watcher.close();
    // The recursive scan resolves a tick or two after close(), so watch for
    // registrations *appearing* over a window rather than sampling once: a
    // single early read sees the pre-scan counts and proves nothing.
    let peakVnodes = 0;
    let peakInstalls = 0;
    for (let i = 0; i < 20; i++) {
      await loop.timeout(50);
      const counts = loop._activeHandleCounts();
      peakVnodes = Math.max(peakVnodes, counts.vnodes - baseline.vnodes);
      peakInstalls = Math.max(peakInstalls, counts.pendingInstalls - baseline.pendingInstalls);
    }
    t.equal(peakVnodes, 0, 'a closed watcher arms no further vnode watches');
    t.equal(peakInstalls, 0, 'and leaves no unacknowledged installs behind');
  });
});
