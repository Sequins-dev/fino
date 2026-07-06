/**
* internal:runtime/poll — Linux fallback event-loop backend.
*
* This backend implements the same small contract as `internal:runtime/io_uring`
* — the surface that `internal:runtime/loop` drives — but built on the ancient,
* universally available `poll(2)` syscall instead of io_uring. It exists for
* containers and restricted hosts where `io_uring_setup(2)` is blocked by a
* seccomp profile or disabled by kernel policy: the loop selector falls back to
* this module so readiness watches, timers, signals, and `loop.submit()` async
* file operations keep working, just with worse throughput than a real ring.
*
* All event types are normalised to the same kqueue-flavoured filter constants
* the other backends emit (`EVFILT_READ`, `EVFILT_WRITE`, `EVFILT_TIMER`,
* `EVFILT_SIGNAL`, `EVFILT_COMPLETION`) so the loop consumes one uniform event
* shape regardless of platform.
*
* Design notes that differ from a ring-based backend:
*
* - **Readiness is edge-consumed.** Because `poll(2)` is level-triggered and
*   stateless, this backend keeps its own sets of watched identifiers and
*   rebuilds the `pollfd` array on every `wait()`. One-shot read/write watches
*   are removed as they fire (matching `loop.ts`, which drops resolvers after
*   dispatch); persistent reads survive.
* - **Identifier is the fd.** Watches are keyed by the `userData` value the loop
*   passes, which for readiness is the file descriptor itself — that value is
*   both the map key and the fd handed to `poll(2)`. The separate `fd` argument
*   on the `add*` helpers is accepted only for signature parity with the other
*   backends and is ignored.
* - **Async file I/O is synchronous.** There is no kernel async I/O here, so
*   `asyncOpen`/`asyncRead`/`asyncClose` run the blocking syscall immediately
*   and queue the result as an `EVFILT_COMPLETION` event, preserving the
*   `loop.submit()` contract without a ring.
* - **Signals** are delivered through `signalfd(2)`: the signal is blocked with
*   `sigprocmask` and its fd is added as a persistent read; when it becomes
*   readable the `signalfd_siginfo` struct is drained and an `EVFILT_SIGNAL`
*   event is emitted.
*
* This is an `internal:*` backend module, not something application code loads
* directly — use `internal:runtime/loop`, which picks the right backend for the
* host. The example below shows the raw contract for orientation.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addRead(loop, myFd, myFd);           // watch myFd for readability
* poll.addTimer(loop, 1, 50);               // fire timer id 1 after 50ms
* for (const ev of poll.wait(loop, 100)) {  // block up to 100ms
*   if (ev.filter === poll.EVFILT_READ) drainSocket(ev.ident);
*   if (ev.filter === poll.EVFILT_TIMER) onTimer(ev.ident);
* }
* poll.destroy(loop);
* ```
*
* poll(2): https://man7.org/linux/man-pages/man2/poll.2.html
* signalfd(2): https://man7.org/linux/man-pages/man2/signalfd.2.html
*
* @internal
*/
import { dlopen, Pointer } from 'fino:ffi';
/**
* Mutable state for one poll-backed loop handle.
*
* This is the backend's private bookkeeping — the loop treats it as an opaque
* handle. It holds the sets of watched identifiers (`reads`/`writes` are
* one-shot, `persistentReads` survive firing), pending timer deadlines keyed by
* id, the queue of synchronous file-op completions awaiting delivery, and the
* bidirectional maps that tie each watched signal number to its `signalfd`.
*
* @internal
*/
interface PollLoop {
  reads: Set<number>;
  writes: Set<number>;
  persistentReads: Set<number>;
  timers: Map<number, number>;
  completions: PollEvent[];
  signalFds: Map<number, number>;
  signalFdToSig: Map<number, number>;
}
/**
* A single normalised backend event returned by `wait()` / `poll()`.
*
* Its shape matches the kqueue and io_uring backends so the loop consumes one
* uniform event regardless of platform. `ident` identifies the source (fd for
* readiness, timer id, signal number, or the `userData` of a completion),
* `filter` is one of the `EVFILT_*` constants, and `res` carries the readiness
* mask or the syscall return value for completions.
*
* @internal
*/
interface PollEvent {
  ident: number;
  filter: number;
  flags: number;
  data?: number;
  res?: number;
}
const lib = dlopen('libc.so.6', {
  poll: {
    parameters: [
      'buffer',
      'usize',
      'i32'
    ],
    result: 'i32'
  },
  open: {
    parameters: [
      'buffer',
      'i32',
      'i32'
    ],
    result: 'i32'
  },
  read: {
    parameters: [
      'i32',
      'buffer',
      'usize'
    ],
    result: 'isize'
  },
  close: {
    parameters: ['i32'],
    result: 'i32'
  },
  sigprocmask: {
    parameters: [
      'i32',
      'buffer',
      'pointer'
    ],
    result: 'i32'
  },
  signalfd: {
    parameters: [
      'i32',
      'buffer',
      'i32'
    ],
    result: 'i32'
  }
});
const POLLIN = 1;
const POLLOUT = 4;
const POLLERR = 8;
const POLLHUP = 16;
const POLLNVAL = 32;
const SIG_BLOCK = 0;
const SFD_NONBLOCK = 2048n;
const SFD_CLOEXEC = 524288n;
const GLIBC_SIGSET_SIZE = 128;
const SIGNALFD_SIGINFO_SIZE = 128;
/**
* Filter value marking a read-readiness event, matching kqueue's `EVFILT_READ`.
*
* Compare against `PollEvent.filter` to recognise a readable fd; the shared
* value lets loop code stay backend-agnostic across poll, io_uring, and kqueue.
*
* ```ts no_run
* import { EVFILT_READ } from 'internal:runtime/poll';
* void EVFILT_READ;
* ```
*
* @internal
*/
export const EVFILT_READ = -1;
/**
* Filter value marking a write-readiness event, matching kqueue's `EVFILT_WRITE`.
*
* ```ts no_run
* import { EVFILT_WRITE } from 'internal:runtime/poll';
* void EVFILT_WRITE;
* ```
*
* @internal
*/
export const EVFILT_WRITE = -2;
/**
* Filter value marking a fired timer event, matching kqueue's `EVFILT_TIMER`.
*
* The event's `ident` is the timer id passed to `addTimer`.
*
* ```ts no_run
* import { EVFILT_TIMER } from 'internal:runtime/poll';
* void EVFILT_TIMER;
* ```
*
* @internal
*/
export const EVFILT_TIMER = -7;
/**
* Filter value marking a delivered signal, matching kqueue's `EVFILT_SIGNAL`.
*
* The event's `ident` is the signal number; the signal is drained from its
* `signalfd` before the event is emitted.
*
* ```ts no_run
* import { EVFILT_SIGNAL } from 'internal:runtime/poll';
* void EVFILT_SIGNAL;
* ```
*
* @internal
*/
export const EVFILT_SIGNAL = -6;
/**
* Filter value marking an async file-op completion queued by `loop.submit()`.
*
* Events with this filter carry the `userData` of the submitted operation in
* `ident` and the syscall return value (fd, byte count, or status) in `res`.
* This is the mechanism `asyncOpen`/`asyncRead`/`asyncClose` use to report
* their synchronously-computed results back through the event stream.
*
* ```ts no_run
* import { EVFILT_COMPLETION } from 'internal:runtime/poll';
* void EVFILT_COMPLETION;
* ```
*
* @internal
*/
export const EVFILT_COMPLETION = -10;
/**
* Create a fresh poll-backed loop handle with empty watch sets.
*
* Unlike the io_uring backend there is no kernel resource to allocate here —
* the returned object is pure JS bookkeeping, so this never fails. Pair each
* handle with a matching `destroy()` to close any `signalfd`s it opened.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addTimer(loop, 1, 0);
* poll.wait(loop, 0);
* poll.destroy(loop);
* ```
*
* @internal
*/
export function create(): PollLoop {
  return {
    reads: new Set(),
    writes: new Set(),
    persistentReads: new Set(),
    timers: new Map(),
    completions: [],
    signalFds: new Map(),
    signalFdToSig: new Map()
  };
}
/**
* Register a one-shot watch for read readiness.
*
* The watch is keyed by `userData`, which for readiness is the file descriptor
* itself — that value becomes both the tracking key and the fd polled for
* `POLLIN`. The separate `fd` argument exists only for signature parity with
* the io_uring/kqueue backends and is ignored. "One-shot" means the watch is
* removed the moment it fires an `EVFILT_READ` event, so re-arm it after each
* readable notification; use `addPersistentRead` for a watch that survives.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addRead(loop, sockFd, sockFd);
* for (const ev of poll.wait(loop, 100)) {
*   if (ev.filter === poll.EVFILT_READ) readFrom(ev.ident);
* }
* ```
*
* @internal
*/
export function addRead(loop: PollLoop, fd: number, userData: number): void {
  void fd;
  loop.reads.add(userData);
}
/**
* Register a read-readiness watch that persists across firings.
*
* Identical to `addRead` in keying (by `userData`, which is the fd), but the
* watch is not consumed when it fires — it keeps producing `EVFILT_READ`
* events on every `wait()` where the fd is readable until explicitly removed
* with `removeRead`. Used for long-lived readers such as the loop's own wake
* pipe and `signalfd`s.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addPersistentRead(loop, wakeFd, wakeFd);
* ```
*
* @internal
*/
export function addPersistentRead(loop: PollLoop, fd: number, userData: number): void {
  void fd;
  loop.persistentReads.add(userData);
}
/**
* Register a one-shot watch for write readiness.
*
* Mirrors `addRead` for the `POLLOUT` side: keyed by `userData` (the fd), the
* watch fires a single `EVFILT_WRITE` event when the fd becomes writable and is
* then removed. Re-arm it when a socket write returns `EAGAIN` and you need to
* wait for drain.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addWrite(loop, sockFd, sockFd);
* ```
*
* @internal
*/
export function addWrite(loop: PollLoop, fd: number, userData: number): void {
  void fd;
  loop.writes.add(userData);
}
/**
* Cancel any read watch on `fd`, whether one-shot or persistent.
*
* Removes `fd` from both the one-shot and persistent read sets, so a single
* call is sufficient regardless of how the watch was registered. Removing an fd
* that was never watched is a harmless no-op.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addPersistentRead(loop, sockFd, sockFd);
* poll.removeRead(loop, sockFd);
* ```
*
* @internal
*/
export function removeRead(loop: PollLoop, fd: number): void {
  loop.reads.delete(fd);
  loop.persistentReads.delete(fd);
}
/**
* Cancel the write watch on `fd`.
*
* Removes `fd` from the write set; a no-op if no write watch is registered.
* One-shot write watches remove themselves when they fire, so this is only
* needed to cancel a watch that has not yet become writable.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addWrite(loop, sockFd, sockFd);
* poll.removeWrite(loop, sockFd);
* ```
*
* @internal
*/
export function removeWrite(loop: PollLoop, fd: number): void {
  loop.writes.delete(fd);
}
/**
* Arm a one-shot timer that fires `ms` milliseconds from now.
*
* The deadline is stored as an absolute wall-clock time (`Date.now() + ms`);
* negative delays are clamped to zero so they fire on the next `wait()`. When
* the deadline passes, `wait()`/`poll()` emit a single `EVFILT_TIMER` event
* whose `ident` is `id` and drop the timer. Registering an existing `id` again
* overwrites its deadline. Pending timers also shorten the `poll(2)` blocking
* timeout so the loop wakes exactly when the earliest one is due.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addTimer(loop, 42, 250);
* for (const ev of poll.wait(loop, 1000)) {
*   if (ev.filter === poll.EVFILT_TIMER && ev.ident === 42) console.log('fired');
* }
* ```
*
* @internal
*/
export function addTimer(loop: PollLoop, id: number, ms: number): void {
  loop.timers.set(id, Date.now() + Math.max(0, ms));
}
/**
* Cancel a pending timer before it fires.
*
* Removes the timer keyed by `id`; a no-op if it already fired or never
* existed. Because timers are one-shot, this is only needed to cancel a delay
* that has not yet elapsed.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addTimer(loop, 7, 5000);
* poll.removeTimer(loop, 7);
* ```
*
* @internal
*/
export function removeTimer(loop: PollLoop, id: number): void {
  loop.timers.delete(id);
}
/**
* Start watching for delivery of Unix signal `signo` via `signalfd(2)`.
*
* Blocks `signo` for the process with `sigprocmask(SIG_BLOCK, …)` so the kernel
* queues it to a `signalfd` instead of running the default disposition, opens
* that fd non-blocking and close-on-exec, and adds it as a persistent read.
* When the signal arrives the fd becomes readable, its `signalfd_siginfo` is
* drained, and `wait()` emits an `EVFILT_SIGNAL` event with `ident === signo`.
* Watching a signal already registered on this loop is a no-op.
*
* Throws if `sigprocmask` or `signalfd` fail (for example under a seccomp
* profile that blocks them), with the failing return code in the message.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const SIGINT = 2;
* const loop = poll.create();
* poll.addSignal(loop, SIGINT);
* for (const ev of poll.wait(loop, -1)) {
*   if (ev.filter === poll.EVFILT_SIGNAL && ev.ident === SIGINT) shutdown();
* }
* ```
*
* @internal
*/
export function addSignal(loop: PollLoop, signo: number): void {
  if (loop.signalFds.has(signo)) return;
  const sigset = new ArrayBuffer(GLIBC_SIGSET_SIZE);
  const sigsetView = new DataView(sigset);
  sigsetView.setBigUint64(0, 1n << BigInt(signo - 1), true);
  const maskRc = lib.symbols.sigprocmask(SIG_BLOCK, sigset, Pointer.null()) as number;
  if (maskRc !== 0) throw new Error(`sigprocmask failed: ${maskRc}`);
  const fd = Number(lib.symbols.signalfd(-1, sigset, Number(SFD_NONBLOCK | SFD_CLOEXEC)));
  if (fd < 0) throw new Error(`signalfd4 failed: ${fd}`);
  loop.signalFds.set(signo, fd);
  loop.signalFdToSig.set(fd, signo);
  loop.persistentReads.add(fd);
}
/**
* Stop watching signal `signo` and close its `signalfd`.
*
* Drops the fd from the persistent-read set, forgets both signal↔fd mappings,
* and closes the descriptor. A no-op if `signo` is not currently watched. Note
* that the process-level signal block installed by `addSignal` is left in place
* — this only tears down the loop's interest in the fd.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const SIGINT = 2;
* const loop = poll.create();
* poll.addSignal(loop, SIGINT);
* poll.removeSignal(loop, SIGINT);
* ```
*
* @internal
*/
export function removeSignal(loop: PollLoop, signo: number): void {
  const fd = loop.signalFds.get(signo);
  if (fd === undefined) return;
  loop.signalFds.delete(signo);
  loop.signalFdToSig.delete(fd);
  loop.persistentReads.delete(fd);
  lib.symbols.close(fd);
}
function drainDueTimers(loop: PollLoop, now: number, events: PollEvent[]): void {
  for (const [id, deadline] of loop.timers) {
    if (deadline <= now) {
      loop.timers.delete(id);
      events.push({
        ident: id,
        filter: EVFILT_TIMER,
        flags: 0,
        res: 0
      });
    }
  }
}
function nextTimerDelay(loop: PollLoop, timeoutMs: number | null): number {
  let delay = timeoutMs ?? -1;
  const now = Date.now();
  for (const deadline of loop.timers.values()) {
    const timerDelay = Math.max(0, deadline - now);
    delay = delay < 0 ? timerDelay : Math.min(delay, timerDelay);
  }
  return delay;
}
function buildPollList(loop: PollLoop): Array<{
  fd: number;
  events: number;
}> {
  const watched = new Map<number, number>();
  for (const fd of loop.reads) watched.set(fd, (watched.get(fd) ?? 0) | POLLIN);
  for (const fd of loop.persistentReads) watched.set(fd, (watched.get(fd) ?? 0) | POLLIN);
  for (const fd of loop.writes) watched.set(fd, (watched.get(fd) ?? 0) | POLLOUT);
  return Array.from(watched, ([fd, events]) => ({
    fd,
    events
  }));
}
function readPollEvent(view: DataView, index: number): {
  fd: number;
  events: number;
  revents: number;
} {
  const base = index * 8;
  return {
    fd: view.getInt32(base, true),
    events: view.getInt16(base + 4, true),
    revents: view.getInt16(base + 6, true)
  };
}
/**
* Block until backend events are available, then return them all at once.
*
* This is the core pump. It first flushes any queued completions and drains
* timers that are already due; if that yields events — or if `timeoutMs` is
* `0` — it returns immediately without touching the kernel. Otherwise it builds
* a `pollfd` array from the current read/write/persistent sets and calls
* `poll(2)`, capping the blocking time at whichever is sooner: `timeoutMs` or
* the nearest timer deadline. A `null` timeout (or `-1`) means block
* indefinitely, subject to timers.
*
* On return it re-drains newly-due timers, then translates each ready `pollfd`:
* `POLLERR`/`POLLHUP`/`POLLNVAL` are folded into both read and write readiness
* so error conditions surface as events; `signalfd`s emit `EVFILT_SIGNAL` after
* draining their siginfo; one-shot readers/writers are removed as they fire.
* A negative `poll(2)` return (interrupted or failed) is swallowed and yields
* only whatever timers/completions were already collected — callers just spin
* again on the next loop tick.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addRead(loop, fd, fd);
* const events = poll.wait(loop, 500);   // block up to 500ms
* for (const ev of events) dispatch(ev);
* ```
*
* @internal
*/
export function wait(loop: PollLoop, timeoutMs: number | null = null): PollEvent[] {
  const events = loop.completions.splice(0);
  drainDueTimers(loop, Date.now(), events);
  if (events.length > 0 || timeoutMs === 0) return events;
  const entries = buildPollList(loop);
  const pollTimeout = nextTimerDelay(loop, timeoutMs);
  const buf = new ArrayBuffer(Math.max(1, entries.length) * 8);
  const view = new DataView(buf);
  for (let i = 0; i < entries.length; i++) {
    const base = i * 8;
    view.setInt32(base, entries[i]!.fd, true);
    view.setInt16(base + 4, entries[i]!.events, true);
    view.setInt16(base + 6, 0, true);
  }
  const rc = Number(lib.symbols.poll(buf, entries.length, pollTimeout));
  if (rc < 0) return events;
  drainDueTimers(loop, Date.now(), events);
  if (rc === 0) return events;
  for (let i = 0; i < entries.length; i++) {
    const { fd, revents } = readPollEvent(view, i);
    if (revents === 0) continue;
    const readiness = revents | (revents & (POLLERR | POLLHUP | POLLNVAL) ? POLLIN | POLLOUT : 0);
    const signo = loop.signalFdToSig.get(fd);
    if (signo !== undefined && readiness & POLLIN) {
      const infoBuf = new ArrayBuffer(SIGNALFD_SIGINFO_SIZE);
      lib.symbols.read(fd, infoBuf, SIGNALFD_SIGINFO_SIZE);
      events.push({
        ident: signo,
        filter: EVFILT_SIGNAL,
        flags: 0,
        res: readiness
      });
      continue;
    }
    if (readiness & POLLIN) {
      if (loop.reads.delete(fd) || loop.persistentReads.has(fd)) {
        events.push({
          ident: fd,
          filter: EVFILT_READ,
          flags: 0,
          data: 0,
          res: readiness
        });
      }
    }
    if (readiness & POLLOUT) {
      if (loop.writes.delete(fd)) {
        events.push({
          ident: fd,
          filter: EVFILT_WRITE,
          flags: 0,
          res: readiness
        });
      }
    }
  }
  return events;
}
/**
* Collect currently-ready events without blocking.
*
* A thin `wait(loop, 0)` — it returns queued completions, due timers, and any
* fds `poll(2)` reports ready right now, then returns even if that set is
* empty. Use it to service the loop between other work without stalling.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* const ready = poll.poll(loop);   // never blocks
* for (const ev of ready) dispatch(ev);
* ```
*
* @internal
*/
export function poll(loop: PollLoop): PollEvent[] {
  return wait(loop, 0);
}
/**
* Perform an `open(2)` synchronously and queue its result as a completion.
*
* This backend has no kernel async I/O, so the open runs inline on the calling
* thread and its return value (the new fd on success, a negative errno on
* failure) is pushed as an `EVFILT_COMPLETION` event carrying `userData` in
* `ident` and the result in `res`. The event surfaces on the next
* `wait()`/`poll()`, preserving the `loop.submit()` async contract. `pathBuf`
* must be a NUL-terminated C string buffer.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* const path = new TextEncoder().encode('/tmp/x\0').buffer;
* poll.asyncOpen(loop, path, 0, 0, 1001);
* for (const ev of poll.poll(loop)) {
*   if (ev.filter === poll.EVFILT_COMPLETION && ev.ident === 1001) {
*     const fd = ev.res;   // opened fd, or negative errno
*   }
* }
* ```
*
* @internal
*/
export function asyncOpen(loop: PollLoop, pathBuf: ArrayBuffer, flags: number, mode: number, userData: number): void {
  const fd = Number(lib.symbols.open(pathBuf, flags, mode));
  loop.completions.push({
    ident: userData,
    filter: EVFILT_COMPLETION,
    flags: 0,
    res: fd
  });
}
/**
* Perform a `read(2)` synchronously and queue its result as a completion.
*
* Reads up to `len` bytes from `fd` into `buf` on the calling thread, then
* queues an `EVFILT_COMPLETION` event with `userData` in `ident` and the byte
* count (`0` at EOF, negative errno on error) in `res`. Because the read is
* blocking, only use this for descriptors known to be ready or backed by
* regular files. The filled data lives in `buf`; the event reports only length.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* const buf = new ArrayBuffer(4096);
* poll.asyncRead(loop, fileFd, buf, 4096, 2002);
* for (const ev of poll.poll(loop)) {
*   if (ev.filter === poll.EVFILT_COMPLETION && ev.ident === 2002) {
*     const bytes = new Uint8Array(buf, 0, ev.res);
*   }
* }
* ```
*
* @internal
*/
export function asyncRead(loop: PollLoop, fd: number, buf: ArrayBuffer, len: number, userData: number): void {
  const n = Number(lib.symbols.read(fd, buf, len));
  loop.completions.push({
    ident: userData,
    filter: EVFILT_COMPLETION,
    flags: 0,
    res: n
  });
}
/**
* Perform a `close(2)` synchronously and queue its result as a completion.
*
* Closes `fd` inline and queues an `EVFILT_COMPLETION` event with `userData` in
* `ident` and the `close(2)` return (`0` on success, negative errno on failure)
* in `res`, so a submitted close reports back through the same event stream as
* opens and reads.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.asyncClose(loop, fileFd, 3003);
* for (const ev of poll.poll(loop)) {
*   if (ev.filter === poll.EVFILT_COMPLETION && ev.ident === 3003) {
*     const ok = ev.res === 0;
*   }
* }
* ```
*
* @internal
*/
export function asyncClose(loop: PollLoop, fd: number, userData: number): void {
  const rc = Number(lib.symbols.close(fd));
  loop.completions.push({
    ident: userData,
    filter: EVFILT_COMPLETION,
    flags: 0,
    res: rc
  });
}
/**
* Tear down the loop handle, closing every open `signalfd` and clearing state.
*
* Closes all descriptors opened by `addSignal`, then empties every watch set,
* the timer map, the completion queue, and the signal maps so the handle holds
* no live resources. The object itself remains usable — a subsequent `create`
* is unnecessary — but any pending watches and queued completions are gone.
* Call this when the loop is shutting down to avoid leaking signal fds.
*
* ```ts no_run
* import * as poll from 'internal:runtime/poll';
*
* const loop = poll.create();
* poll.addSignal(loop, 2);
* poll.destroy(loop);   // closes the signalfd and clears all state
* ```
*
* @internal
*/
export function destroy(loop: PollLoop): void {
  for (const fd of loop.signalFds.values()) lib.symbols.close(fd);
  loop.reads.clear();
  loop.writes.clear();
  loop.persistentReads.clear();
  loop.timers.clear();
  loop.completions.length = 0;
  loop.signalFds.clear();
  loop.signalFdToSig.clear();
}
