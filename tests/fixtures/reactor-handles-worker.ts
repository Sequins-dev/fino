/**
* Realm entry for the reactor handle-coverage test. This realm has
* `internal:runtime/loop` remapped to `fino:net/loop-reactor`, so file
* watches, OS signals, child-process exit, and background FFI wakes below all
* ride the native reactor. Throws on any failure (the parent's `run()`
* rejects); self-exits when idle.
*
* Uses only public APIs — a realm entry cannot import `internal:*` modules.
*/
import { DiskFileSystem } from 'fino:file';
import { Watcher } from 'fino:file/watch';
import { Process, SIGUSR2, kill, os, pid, signal } from 'fino:process';
import { dlopen } from 'fino:ffi';

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`reactor realm: timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(id);
  }
}

const fs = new DiskFileSystem();

// --- fs watch: macOS rides the reactor's vnode adapter; Linux rides inotify
// over the reactor's readable(). Deletion also exercises the synchronous
// removeVnode-inside-callback re-arm guard in the native adapter.
const dir = `/tmp/fino-reactor-handles-${Math.floor(Math.random() * 1e9)}`;
await fs.mkdir(dir);
const file = `${dir}/watched.txt`;
await fs.writeFile(file, new TextEncoder().encode('start'));
const watcher = new Watcher();
watcher.watch(file);
const iter = watcher[Symbol.asyncIterator]();
await fs.writeFile(file, new TextEncoder().encode('changed'));
const modify = await withTimeout(iter.next(), 3000, 'a watch modify event');
if (modify.done) throw new Error('reactor realm: watcher ended before the modify event');
await fs.unlink(file);
const del = await withTimeout(iter.next(), 3000, 'a watch delete event');
if (del.done) throw new Error('reactor realm: watcher ended before the delete event');
watcher.close();
await fs.rmdir(dir);

// --- OS signal through the reactor's signal watch. Linux uses raise() (a
// thread-directed signal lands on the reactor thread, where it is blocked and
// routed to signalfd); a process-directed kill() could be consumed by any
// unblocked pool thread. macOS is the opposite: EVFILT_SIGNAL only observes
// process-directed delivery, so kill(pid) is required and raise() invisible.
const delivered = new Promise<void>((resolve) => {
  const topic = signal('SIGUSR2');
  const handle = topic.subscribe(() => {
    handle.dispose();
    resolve();
  });
});
if (os === 'linux') {
  const libc = dlopen('libc.so.6', { raise: { parameters: ['i32'], result: 'i32' } });
  libc.symbols.raise(SIGUSR2);
} else {
  kill(pid, SIGUSR2);
}
await withTimeout(delivered, 3000, 'SIGUSR2 delivery');

// --- child-process exit through the reactor (proc watch on macOS, pidfd
// readability on Linux), then reap. sleep writes nothing, so its inherited
// pipes can be left alone until the process object is dropped.
const child = new Process('/bin/sleep', ['0.05']);
const result = await withTimeout(child.wait(), 5000, 'child exit');
if (result.code !== 0) throw new Error(`reactor realm: child exited ${result.code}`);

// --- background FFI completion: the pool thread's wake must arrive as a
// reactor Notifier post (this realm's wake sink was upgraded at bootstrap).
const asyncLib = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  usleep: { parameters: ['u32'], result: 'i32', async: true }
});
await withTimeout(asyncLib.symbols.usleep(1000) as Promise<number>, 5000, 'an async FFI completion');
