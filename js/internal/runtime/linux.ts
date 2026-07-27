/**
 * internal:runtime/linux — Linux event-loop backend selector.
 *
 * This module is the Linux entry point for `internal:runtime/loop`. It exposes
 * the same small backend contract as `internal:runtime/kqueue` on macOS —
 * readiness watches, timers, signals, file completions, and a pollable fd — but
 * internally routes every call to one of two concrete backends chosen at
 * loop-creation time: `internal:runtime/io_uring` (the fast path) or
 * `internal:runtime/poll` (the fallback).
 *
 * The preferred backend is io_uring, which submits async operations directly
 * into kernel-shared ring buffers and needs no extra syscalls to collect
 * results. Some production-like environments — most notably Docker under its
 * default seccomp profile — deny `io_uring_setup(2)`. Rather than fail the
 * whole runtime, `create()` probes io_uring exactly once: on success it returns
 * an io_uring-backed handle, and only when ring setup is rejected (an error
 * whose message contains `io_uring_setup failed`) does it fall back to the
 * poll(2) backend. Any other failure is a real error and propagates. All later
 * calls inspect the handle's `kind` tag and dispatch to the matching backend,
 * so callers never observe which one is live.
 *
 * Because both backends implement the identical surface, this file is almost
 * entirely mechanical delegation. The one place the two differ observably is
 * `pollFd()`: io_uring has a single waitable ring fd, whereas the poll fallback
 * has no single fd to wait on and reports `-1`.
 *
 * The `EVFILT_*` constants are re-exported from the io_uring backend and keep
 * their kqueue-style names and negative values so that `internal:runtime/loop`
 * can use one dispatch table across both platforms.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();          // io_uring, or poll(2) under seccomp
 *
 * // Wait for a socket to become readable.
 * linux.addRead(loop, sockFd, sockFd);
 * const events = linux.wait(loop, 1000); // block up to 1 s
 * for (const ev of events) {
 *   if (ev.filter === linux.EVFILT_READ) handleReadable(ev.ident);
 * }
 *
 * linux.destroy(loop);
 * ```
 *
 * @internal
 */
import * as ioUring from './io_uring.ts';
import * as pollBackend from './poll.ts';
type BackendKind = 'io_uring' | 'poll';
interface SelectedLoop {
  kind: BackendKind;
  raw: object;
}
/**
 * Event `filter` tag identifying a read-readiness completion.
 *
 * Re-exported from the io_uring backend so that `internal:runtime/loop` can
 * match events with the same negative, kqueue-style filter value on both Linux
 * and macOS. Compare it against `event.filter` on entries returned by `wait()`
 * or `poll()`.
 *
 * @internal
 */
export const EVFILT_READ = ioUring.EVFILT_READ;
/**
 * Event `filter` tag identifying a write-readiness completion.
 *
 * Carries the same value and meaning as the macOS kqueue backend so loop
 * dispatch stays platform-agnostic.
 *
 * @internal
 */
export const EVFILT_WRITE = ioUring.EVFILT_WRITE;
/**
 * Event `filter` tag identifying an expired timer.
 *
 * The `ident` of a matching event is the timer id passed to `addTimer()`.
 *
 * @internal
 */
export const EVFILT_TIMER = ioUring.EVFILT_TIMER;
/**
 * Event `filter` tag identifying a delivered signal.
 *
 * The `ident` of a matching event is the signal number registered with
 * `addSignal()`.
 *
 * @internal
 */
export const EVFILT_SIGNAL = ioUring.EVFILT_SIGNAL;
/**
 * Event `filter` tag identifying a completed async file operation.
 *
 * Backs the generic `loop.submit()` path: `asyncOpen()`, `asyncRead()`, and
 * `asyncClose()` all report their results as events carrying this filter, with
 * the operation's `userData` echoed back as the event identifier.
 *
 * @internal
 */
export const EVFILT_COMPLETION = ioUring.EVFILT_COMPLETION;
/**
 * Create the best available Linux backend and return an opaque loop handle.
 *
 * Attempts io_uring first. If `io_uring_setup(2)` is rejected by the kernel or
 * a sandbox — recognized by an error message containing `io_uring_setup
 * failed` — it silently falls back to the poll(2) backend. The returned handle
 * is tagged with its `kind` so every other function in this module can route to
 * the live backend; callers should treat it as opaque and pass it back
 * unmodified.
 *
 * Throws if io_uring fails for any reason other than setup being denied (for
 * example an out-of-memory ring allocation), since that indicates a genuine
 * fault rather than a restricted environment.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * // On a normal host: loop.kind === 'io_uring'
 * // Inside Docker's default seccomp profile: loop.kind === 'poll'
 * ```
 *
 * @internal
 */
export function create(): SelectedLoop {
  try {
    return {
      kind: 'io_uring',
      raw: ioUring.create(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('io_uring_setup failed')) throw error;
    return {
      kind: 'poll',
      raw: pollBackend.create(),
    };
  }
}
/**
 * Register a one-shot interest in `fd` becoming readable.
 *
 * The watch fires at most once: after the readiness event surfaces from
 * `wait()`/`poll()`, `internal:runtime/loop` removes its resolver, matching the
 * one-shot semantics both backends expose at this boundary. `userData` is the
 * opaque token echoed back as the event `ident`, so callers typically pass the
 * fd itself as both arguments.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addRead(loop, connFd, connFd);
 * const [event] = linux.wait(loop, null);
 * if (event.filter === linux.EVFILT_READ) recv(event.ident);
 * ```
 *
 * @internal
 */
export function addRead(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.addRead(loop.raw as any, fd, userData);
  else pollBackend.addRead(loop.raw as any, fd, userData);
}
/**
 * Register a level-triggered read watch that survives each dispatch.
 *
 * Unlike `addRead()`, the watch stays armed across events, so it keeps firing
 * while `fd` remains readable without needing to be re-added. This suits
 * long-lived readers such as an accepting listen socket or a wake pipe. Clear it
 * with `removeRead()`.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addPersistentRead(loop, listenFd, listenFd);
 * for (;;) {
 *   for (const ev of linux.wait(loop, null)) accept(ev.ident);
 * }
 * ```
 *
 * @internal
 */
export function addPersistentRead(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.addPersistentRead(loop.raw as any, fd, userData);
  else pollBackend.addPersistentRead(loop.raw as any, fd, userData);
}
/**
 * Register a one-shot interest in `fd` becoming writable.
 *
 * The write mirror of `addRead()`: the watch fires once when `fd` can accept
 * more bytes, then is dropped after dispatch. Use it to resume a blocked write
 * after a partial `send()`/`write()` returned `EAGAIN`.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addWrite(loop, sockFd, sockFd);
 * const [event] = linux.wait(loop, null);
 * if (event.filter === linux.EVFILT_WRITE) flushPending(event.ident);
 * ```
 *
 * @internal
 */
export function addWrite(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.addWrite(loop.raw as any, fd, userData);
  else pollBackend.addWrite(loop.raw as any, fd, userData);
}
/**
 * Cancel any read watch on `fd`, one-shot or persistent.
 *
 * Idempotent: removing a watch that was never registered, or was already
 * consumed, is a no-op. Call it when tearing down a connection so a persistent
 * watch does not keep firing on a closed fd.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addPersistentRead(loop, connFd, connFd);
 * linux.removeRead(loop, connFd); // stop watching before close()
 * ```
 *
 * @internal
 */
export function removeRead(loop: SelectedLoop, fd: number): void {
  if (loop.kind === 'io_uring') ioUring.removeRead(loop.raw as any, fd);
  else pollBackend.removeRead(loop.raw as any, fd);
}
/**
 * Cancel any write watch on `fd`.
 *
 * Idempotent, like `removeRead()`. One-shot write watches usually clear
 * themselves after firing; call this to abandon a pending write before it
 * becomes writable.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addWrite(loop, sockFd, sockFd);
 * linux.removeWrite(loop, sockFd); // give up on the pending flush
 * ```
 *
 * @internal
 */
export function removeWrite(loop: SelectedLoop, fd: number): void {
  if (loop.kind === 'io_uring') ioUring.removeWrite(loop.raw as any, fd);
  else pollBackend.removeWrite(loop.raw as any, fd);
}
/**
 * Arm a one-shot timer that fires roughly `ms` milliseconds from now.
 *
 * When it expires, `wait()`/`poll()` yield an event with filter `EVFILT_TIMER`
 * and `ident` equal to `id`. The `id` is caller-chosen and used to correlate
 * and, if needed, cancel the timer via `removeTimer()`. Firing time is a lower
 * bound, not a deadline: the timer will not fire early but may be late if the
 * loop is busy.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addTimer(loop, 1, 500); // fire timer #1 after ~500 ms
 * for (const ev of linux.wait(loop, null)) {
 *   if (ev.filter === linux.EVFILT_TIMER && ev.ident === 1) onTimeout();
 * }
 * ```
 *
 * @internal
 */
export function addTimer(loop: SelectedLoop, id: number, ms: number): void {
  if (loop.kind === 'io_uring') ioUring.addTimer(loop.raw as any, id, ms);
  else pollBackend.addTimer(loop.raw as any, id, ms);
}
/**
 * Cancel the pending timer identified by `id`.
 *
 * Useful for clearing a timeout that is no longer needed, for example when the
 * operation it guarded completed first. Removing an already-fired or unknown
 * timer is a no-op.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addTimer(loop, 1, 5000);
 * // ...work finished early...
 * linux.removeTimer(loop, 1); // the timeout never fires
 * ```
 *
 * @internal
 */
export function removeTimer(loop: SelectedLoop, id: number): void {
  if (loop.kind === 'io_uring') ioUring.removeTimer(loop.raw as any, id);
  else pollBackend.removeTimer(loop.raw as any, id);
}
/**
 * Begin delivering the POSIX signal `signo` through the loop.
 *
 * Once registered, occurrences of the signal surface as events with filter
 * `EVFILT_SIGNAL` and `ident` equal to `signo`, instead of interrupting the
 * process via a signal handler. Under io_uring this uses the ring's signal
 * support; under the poll fallback it is backed by `signalfd(2)`. Registering
 * the same signal twice is harmless.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const SIGINT = 2;
 * const loop = linux.create();
 * linux.addSignal(loop, SIGINT);
 * for (const ev of linux.wait(loop, null)) {
 *   if (ev.filter === linux.EVFILT_SIGNAL && ev.ident === SIGINT) shutdown();
 * }
 * ```
 *
 * @internal
 */
export function addSignal(loop: SelectedLoop, signo: number, userData: number = signo): void {
  if (loop.kind === 'io_uring') ioUring.addSignal(loop.raw as any, signo, userData);
  else pollBackend.addSignal(loop.raw as any, signo);
}
/**
 * Stop delivering `signo` through the loop and release its backing resources.
 *
 * After this call the signal reverts to its default disposition for the
 * process. Removing a signal that was never registered is a no-op.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const SIGINT = 2;
 * const loop = linux.create();
 * linux.addSignal(loop, SIGINT);
 * linux.removeSignal(loop, SIGINT); // stop intercepting Ctrl-C
 * ```
 *
 * @internal
 */
export function removeSignal(loop: SelectedLoop, signo: number): void {
  if (loop.kind === 'io_uring') ioUring.removeSignal(loop.raw as any, signo);
  else pollBackend.removeSignal(loop.raw as any, signo);
}
/**
 * Block until at least one event is ready, or the timeout elapses.
 *
 * Returns an array of ready events, each carrying at least `ident` (the fd,
 * timer id, or signal number) and `filter` (one of the `EVFILT_*` tags).
 * Passing `timeoutMs` as `null` waits indefinitely; a number bounds the wait to
 * that many milliseconds and may return an empty array if nothing became ready
 * in time. Completion events from `asyncOpen()`/`asyncRead()`/`asyncClose()`
 * also carry the raw syscall result.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.addRead(loop, fd, fd);
 * const events = linux.wait(loop, 250); // wait up to 250 ms
 * if (events.length === 0) console.log('idle');
 * for (const ev of events) dispatch(ev);
 * ```
 *
 * @internal
 */
export function wait(loop: SelectedLoop, timeoutMs: number | null = null): any[] {
  if (loop.kind === 'io_uring') return ioUring.wait(loop.raw as any, timeoutMs);
  return pollBackend.wait(loop.raw as any, timeoutMs);
}
/**
 * Collect events that are ready right now without blocking.
 *
 * Equivalent to `wait()` with a zero timeout: it drains whatever is currently
 * ready and returns immediately, yielding an empty array when nothing is
 * pending. Used by the loop's synchronous `spin()` path to make progress
 * without parking the thread.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * let events;
 * while ((events = linux.poll(loop)).length > 0) {
 *   for (const ev of events) dispatch(ev);
 * }
 * ```
 *
 * @internal
 */
export function poll(loop: SelectedLoop): any[] {
  if (loop.kind === 'io_uring') return ioUring.poll(loop.raw as any);
  return pollBackend.poll(loop.raw as any);
}
/**
 * Submit queued backend registrations without harvesting events.
 *
 * The io_uring path publishes pending SQEs to the thread-shared ring. The poll
 * fallback keeps registrations in memory and therefore has nothing to flush.
 *
 * @internal
 */
export function flush(loop: SelectedLoop): number {
  if (loop.kind === 'io_uring') return ioUring.flush(loop.raw as any);
  return 0;
}
/**
 * Submit an asynchronous `openat(2)` and complete it as a loop event.
 *
 * `pathBuf` must be a NUL-terminated path in an `ArrayBuffer`; `flags` and
 * `mode` are the usual `open(2)` arguments. When the open finishes, a
 * completion event with filter `EVFILT_COMPLETION` and identifier `userData`
 * carries the result — the new fd on success, or a negative `-errno` on
 * failure. Under io_uring the open runs in the kernel; under the poll fallback
 * it is performed synchronously and queued as a completion, preserving the same
 * contract.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * const path = new TextEncoder().encode('/etc/hostname\0').buffer;
 * const O_RDONLY = 0;
 * linux.asyncOpen(loop, path, O_RDONLY, 0, 42);
 * for (const ev of linux.wait(loop, null)) {
 *   if (ev.ident === 42) console.log(ev.res >= 0 ? `fd ${ev.res}` : `errno ${-ev.res}`);
 * }
 * ```
 *
 * @internal
 */
export function asyncOpen(
  loop: SelectedLoop,
  pathBuf: ArrayBuffer,
  flags: number,
  mode: number,
  userData: number,
): void {
  if (loop.kind === 'io_uring') ioUring.asyncOpen(loop.raw as any, pathBuf, flags, mode, userData);
  else pollBackend.asyncOpen(loop.raw as any, pathBuf, flags, mode, userData);
}
/**
 * Submit an asynchronous read of up to `len` bytes from `fd` into `buf`.
 *
 * Bytes are written into `buf` (which must have room for `len`), and a
 * completion event with filter `EVFILT_COMPLETION` and identifier `userData`
 * reports how many bytes were read: a non-negative count (0 means EOF) or a
 * negative `-errno`. The caller must keep `buf` alive until the completion
 * arrives. As with `asyncOpen()`, the poll fallback performs the read inline
 * and queues an equivalent completion.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * const buf = new ArrayBuffer(4096);
 * linux.asyncRead(loop, fd, buf, buf.byteLength, 7);
 * for (const ev of linux.wait(loop, null)) {
 *   if (ev.ident === 7 && ev.res > 0) consume(new Uint8Array(buf, 0, ev.res));
 * }
 * ```
 *
 * @internal
 */
export function asyncRead(
  loop: SelectedLoop,
  fd: number,
  buf: ArrayBuffer,
  len: number,
  userData: number,
): void {
  if (loop.kind === 'io_uring') ioUring.asyncRead(loop.raw as any, fd, buf, len, userData);
  else pollBackend.asyncRead(loop.raw as any, fd, buf, len, userData);
}
/**
 * Submit an asynchronous `close(2)` of `fd` and complete it as a loop event.
 *
 * A completion event with filter `EVFILT_COMPLETION` and identifier `userData`
 * reports the close result: `0` on success or a negative `-errno`. Deferring
 * the close through the loop keeps the potentially blocking syscall off the
 * critical path and lets callers observe when the descriptor is truly released.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * linux.asyncClose(loop, fd, 99);
 * for (const ev of linux.wait(loop, null)) {
 *   if (ev.ident === 99 && ev.res < 0) console.error(`close failed: ${-ev.res}`);
 * }
 * ```
 *
 * @internal
 */
export function asyncClose(loop: SelectedLoop, fd: number, userData: number): void {
  if (loop.kind === 'io_uring') ioUring.asyncClose(loop.raw as any, fd, userData);
  else pollBackend.asyncClose(loop.raw as any, fd, userData);
}
/**
 * Tear down the loop handle and release its backend resources.
 *
 * For io_uring this unmaps the shared rings and closes the ring fd; for the
 * poll fallback it drops the in-memory watch sets and closes any signalfds. The
 * handle must not be used after this call. Typically invoked once at process or
 * realm shutdown.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * try {
 *   // ...drive the loop...
 * } finally {
 *   linux.destroy(loop);
 * }
 * ```
 *
 * @internal
 */
export function destroy(loop: SelectedLoop): void {
  if (loop.kind === 'io_uring') ioUring.destroy(loop.raw as any);
  else pollBackend.destroy(loop.raw as any);
}
/**
 * Return a single fd that becomes readable when the loop has work, or `-1`.
 *
 * io_uring exposes its thread-reactor fd here. The poll(2) fallback has no
 * aggregate descriptor and returns `-1`, signalling callers that they must
 * drive it directly via `wait()`/`poll()`.
 *
 * ```ts no_run
 * import * as linux from 'internal:runtime/linux';
 *
 * const loop = linux.create();
 * const fd = linux.pollFd(loop);
 * if (fd === -1) driveDirectly(loop);
 * else console.log(`reactor fd: ${fd}`);
 * ```
 *
 * @internal
 */
export function pollFd(loop: SelectedLoop): number {
  if (loop.kind === 'io_uring') return ioUring.pollFd(loop.raw as any);
  return -1;
}
