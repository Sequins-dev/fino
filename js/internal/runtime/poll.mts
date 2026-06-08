/**
 * internal:runtime/poll — Linux fallback event-loop backend.
 *
 * This backend implements the same small contract as the io_uring backend
 * using poll(2). It is intended for containers and restricted hosts where
 * io_uring_setup(2) is unavailable through seccomp or kernel policy. Read and
 * write readiness are one-shot at the API boundary because `loop.mts` removes
 * resolvers after dispatch. File "async" completions are performed
 * synchronously and queued as completion events, preserving the `loop.submit()`
 * contract without requiring kernel async I/O.
 *
 * @internal
 */

import { dlopen, Pointer } from 'fino:ffi';

interface PollLoop {
  reads: Set<number>;
  writes: Set<number>;
  persistentReads: Set<number>;
  timers: Map<number, number>;
  completions: PollEvent[];
  signalFds: Map<number, number>;
  signalFdToSig: Map<number, number>;
}

interface PollEvent {
  ident: number;
  filter: number;
  flags: number;
  data?: number;
  res?: number;
}

const lib = dlopen('libc.so.6', {
  poll: { parameters: ['buffer', 'usize', 'i32'], result: 'i32' },
  open: { parameters: ['buffer', 'i32', 'i32'], result: 'i32' },
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  close: { parameters: ['i32'], result: 'i32' },
  sigprocmask: { parameters: ['i32', 'buffer', 'pointer'], result: 'i32' },
  signalfd: { parameters: ['i32', 'buffer', 'i32'], result: 'i32' },
});

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const POLLNVAL = 0x0020;

const SIG_BLOCK = 0;
const SFD_NONBLOCK = 0x800n;
const SFD_CLOEXEC = 0x80000n;
const GLIBC_SIGSET_SIZE = 128;
const SIGNALFD_SIGINFO_SIZE = 128;

/**
 * Kqueue-compatible read readiness filter.
 *
 * @internal
 */
export const EVFILT_READ = -1;
/**
 * Kqueue-compatible write readiness filter.
 *
 * @internal
 */
export const EVFILT_WRITE = -2;
/**
 * Kqueue-compatible timer filter.
 *
 * @internal
 */
export const EVFILT_TIMER = -7;
/**
 * Kqueue-compatible signal filter.
 *
 * @internal
 */
export const EVFILT_SIGNAL = -6;
/**
 * Completion filter used by `loop.submit()`.
 *
 * @internal
 */
export const EVFILT_COMPLETION = -10;

/**
 * Create a poll-backed loop handle.
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
    signalFdToSig: new Map(),
  };
}

/**
 * Register a one-shot read readiness watch.
 *
 * @internal
 */
export function addRead(loop: PollLoop, fd: number, userData: number): void {
  void fd;
  loop.reads.add(userData);
}

/**
 * Register a persistent read readiness watch.
 *
 * @internal
 */
export function addPersistentRead(loop: PollLoop, fd: number, userData: number): void {
  void fd;
  loop.persistentReads.add(userData);
}

/**
 * Register a one-shot write readiness watch.
 *
 * @internal
 */
export function addWrite(loop: PollLoop, fd: number, userData: number): void {
  void fd;
  loop.writes.add(userData);
}

/**
 * Remove read readiness for `fd`.
 *
 * @internal
 */
export function removeRead(loop: PollLoop, fd: number): void {
  loop.reads.delete(fd);
  loop.persistentReads.delete(fd);
}

/**
 * Remove write readiness for `fd`.
 *
 * @internal
 */
export function removeWrite(loop: PollLoop, fd: number): void {
  loop.writes.delete(fd);
}

/**
 * Register a timer in milliseconds.
 *
 * @internal
 */
export function addTimer(loop: PollLoop, id: number, ms: number): void {
  loop.timers.set(id, Date.now() + Math.max(0, ms));
}

/**
 * Remove a pending timer.
 *
 * @internal
 */
export function removeTimer(loop: PollLoop, id: number): void {
  loop.timers.delete(id);
}

/**
 * Watch `signo` through signalfd.
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
 * Remove a signal watch.
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
      events.push({ ident: id, filter: EVFILT_TIMER, flags: 0, res: 0 });
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

function buildPollList(loop: PollLoop): Array<{ fd: number; events: number }> {
  const watched = new Map<number, number>();
  for (const fd of loop.reads) watched.set(fd, (watched.get(fd) ?? 0) | POLLIN);
  for (const fd of loop.persistentReads) watched.set(fd, (watched.get(fd) ?? 0) | POLLIN);
  for (const fd of loop.writes) watched.set(fd, (watched.get(fd) ?? 0) | POLLOUT);
  return Array.from(watched, ([fd, events]) => ({ fd, events }));
}

function readPollEvent(view: DataView, index: number): { fd: number; events: number; revents: number } {
  const base = index * 8;
  return {
    fd: view.getInt32(base, true),
    events: view.getInt16(base + 4, true),
    revents: view.getInt16(base + 6, true),
  };
}

/**
 * Wait for backend events.
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
    if (signo !== undefined && (readiness & POLLIN)) {
      const infoBuf = new ArrayBuffer(SIGNALFD_SIGINFO_SIZE);
      lib.symbols.read(fd, infoBuf, SIGNALFD_SIGINFO_SIZE);
      events.push({ ident: signo, filter: EVFILT_SIGNAL, flags: 0, res: readiness });
      continue;
    }

    if (readiness & POLLIN) {
      if (loop.reads.delete(fd) || loop.persistentReads.has(fd)) {
        events.push({ ident: fd, filter: EVFILT_READ, flags: 0, data: 0, res: readiness });
      }
    }
    if (readiness & POLLOUT) {
      if (loop.writes.delete(fd)) {
        events.push({ ident: fd, filter: EVFILT_WRITE, flags: 0, res: readiness });
      }
    }
  }
  return events;
}

/**
 * Non-blocking poll for backend events.
 *
 * @internal
 */
export function poll(loop: PollLoop): PollEvent[] {
  return wait(loop, 0);
}

/**
 * Queue a synchronous open(2) result as a completion.
 *
 * @internal
 */
export function asyncOpen(loop: PollLoop, pathBuf: ArrayBuffer, flags: number, mode: number, userData: number): void {
  const fd = Number(lib.symbols.open(pathBuf, flags, mode));
  loop.completions.push({ ident: userData, filter: EVFILT_COMPLETION, flags: 0, res: fd });
}

/**
 * Queue a synchronous read(2) result as a completion.
 *
 * @internal
 */
export function asyncRead(loop: PollLoop, fd: number, buf: ArrayBuffer, len: number, userData: number): void {
  const n = Number(lib.symbols.read(fd, buf, len));
  loop.completions.push({ ident: userData, filter: EVFILT_COMPLETION, flags: 0, res: n });
}

/**
 * Queue a synchronous close(2) result as a completion.
 *
 * @internal
 */
export function asyncClose(loop: PollLoop, fd: number, userData: number): void {
  const rc = Number(lib.symbols.close(fd));
  loop.completions.push({ ident: userData, filter: EVFILT_COMPLETION, flags: 0, res: rc });
}

/**
 * Destroy the backend handle.
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
