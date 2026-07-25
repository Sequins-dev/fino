/**
* Native reactor handle coverage — vnode, signal, and proc paths, plus the
* realm end-to-end sweep (watch + signal + child exit + async FFI
* wake). tests/reactor.test.ts covers readiness, fused I/O, and timers.
*
* Part A drives `internal:runtime/loop` directly in the main realm. `spin`
* only works from a synchronous frame (inside a microtask continuation its
* drainMicrotasks is a re-entrant no-op), so each test makes exactly one
* `rloop.run(...)` call before any `await`, awaits inside it only through the
* reactor (rloop.timeout), and mutates files with synchronous libc FFI.
*/
import { describe, it } from 'fino:test/test';
import * as rloop from 'internal:runtime/loop';
import { Realm } from 'fino:realm';
import { Process, SIGUSR2, kill, os, pid } from 'fino:process';
import { dlopen } from 'fino:ffi';

const NOTE_DELETE = 0x1;
const NOTE_WRITE = 0x2;
const ALL_NOTES = 0x7f;

const isDarwin = os === 'darwin';
// `open` is variadic — its `mode` rides the variadic ABI, which a fixed-arg
// FFI signature miscompiles on ARM64. Create with the non-variadic `creat`
// and only ever `open` with two fixed args (no O_CREAT → mode unread).
const libc = dlopen(isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  creat: { parameters: ['buffer', 'i32'], result: 'i32' },
  open: { parameters: ['buffer', 'i32'], result: 'i32' },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  close: { parameters: ['i32'], result: 'i32' },
  unlink: { parameters: ['buffer'], result: 'i32' },
  raise: { parameters: ['i32'], result: 'i32' },
  waitpid: { parameters: ['i32', 'buffer', 'i32'], result: 'i32' }
});

function cstr(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

const O_WRONLY = 0x1;
const O_APPEND = isDarwin ? 0x8 : 0x400;
// O_EVTONLY on macOS (watch without inhibiting unmount); plain O_RDONLY is
// enough for the path recovery the reactor does elsewhere.
const WATCH_FLAGS = isDarwin ? 0x8000 : 0;

function createFileSync(path: string, text: string): void {
  const fd = libc.symbols.creat(cstr(path), 0o644) as number;
  if (fd < 0) throw new Error(`creat('${path}') failed`);
  const bytes = new TextEncoder().encode(text);
  libc.symbols.write(fd, bytes, bytes.length);
  libc.symbols.close(fd);
}

function appendFileSync(path: string, text: string): void {
  const fd = libc.symbols.open(cstr(path), O_WRONLY | O_APPEND) as number;
  if (fd < 0) throw new Error(`open('${path}', append) failed`);
  const bytes = new TextEncoder().encode(text);
  libc.symbols.write(fd, bytes, bytes.length);
  libc.symbols.close(fd);
}

async function spinUntil(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await rloop.timeout(10);
  }
}

describe('native reactor — watch handles (direct drive)', () => {
  it('dispatches vnode callbacks with NOTE_* fflags and honors removeVnode in-callback', (t) => {
    const path = `/tmp/fino-reactor-vnode-${Math.floor(Math.random() * 1e9)}.txt`;
    createFileSync(path, 'a');
    const wfd = libc.symbols.open(cstr(path), WATCH_FLAGS) as number;
    t.ok(wfd >= 0, 'opened the watched file');

    let mask = 0;
    let events = 0;
    rloop.vnode(wfd, ALL_NOTES, (ev) => {
      mask |= ev.fflags;
      events++;
      // Mirrors watch.ts's delete handler: tear down synchronously inside the
      // callback — the adapter must not re-arm a removed watch.
      if (ev.fflags & NOTE_DELETE) rloop.removeVnode(wfd);
    });

    rloop.run(async () => {
      appendFileSync(path, 'bb');
      await spinUntil(() => (mask & NOTE_WRITE) !== 0, 'a NOTE_WRITE vnode event');

      // Close our fd before the unlink: Linux inotify defers IN_DELETE_SELF
      // until the inode is truly gone (no remaining open fds). The watch is
      // path-based natively, so by now the fd is only the removeVnode key.
      libc.symbols.close(wfd);
      libc.symbols.unlink(cstr(path));
      await spinUntil(() => (mask & NOTE_DELETE) !== 0, 'a NOTE_DELETE vnode event');

      // A removed watch must stay quiet.
      const seen = events;
      await rloop.timeout(50);
      if (events !== seen) throw new Error('vnode events after removeVnode');
    });
    t.ok((mask & NOTE_WRITE) !== 0, 'append surfaced as NOTE_WRITE');
    t.ok((mask & NOTE_DELETE) !== 0, 'unlink surfaced as NOTE_DELETE');
  });

  it('dispatches signal callbacks and re-arms across deliveries', (t) => {
    let fired = 0;
    rloop.signal(SIGUSR2, () => {
      fired++;
    });
    // macOS EVFILT_SIGNAL only observes process-directed signals (kill);
    // Linux signalfd needs a thread-directed raise() so an unblocked pool
    // thread cannot consume the delivery first.
    const send = () => (isDarwin ? kill(pid, SIGUSR2) : libc.symbols.raise(SIGUSR2));

    rloop.run(async () => {
      send();
      await spinUntil(() => fired >= 1, 'the first SIGUSR2 callback');
      send();
      await spinUntil(() => fired >= 2, 'the re-armed SIGUSR2 callback');
    });

    // Removal restores the previous disposition natively; SIGUSR2's default
    // action is terminate, so no post-removal send — surviving removal is
    // the assertion.
    rloop.removeSignal(SIGUSR2);
    t.ok(fired >= 2, 'signal watch fired across re-arms');
  });

  it('proc() resolves on child exit and for already-reaped pids', (t) => {
    const child = new Process('/bin/sleep', ['0.05']);
    rloop.run(() => rloop.proc(child.pid));
    // Reap synchronously — the child has exited (proc() resolved).
    const status = new Uint8Array(4);
    const reaped = libc.symbols.waitpid(child.pid, status, 0) as number;
    t.equal(reaped, child.pid, 'child reaped after proc() resolved');

    // Already reaped: the watch completes with "process gone", which must
    // still resolve (the caller's next step is always a no-op reap).
    rloop.run(() => rloop.proc(child.pid));
    t.ok(true, 'proc() on a reaped pid resolves');
  });
});

describe('native reactor — handle sweep in a realm', () => {
  it('watch + signal + child exit + async FFI wake all ride the reactor', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/reactor-handles-worker.ts', import.meta.url).pathname
    });
    await realm.run();
    t.ok(true, 'realm exercised every handle type and self-exited');
  });
});
