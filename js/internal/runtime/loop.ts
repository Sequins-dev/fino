/**
* internal:runtime/loop — the native reactor-backed runtime loop.
*
* This is the single internal loop implementation used by every realm. It
* delegates readiness, fused transfers, timers, and poll/dispatch work to
* `internal:reactor-native`, which owns the platform poller and resolves
* promises itself. Application modules must not import this implementation
* detail directly.
*
* @internal
*/
import { drainMicrotasks, hasPendingV8Tasks } from 'internal:async-context';
import * as native from 'internal:reactor-native';

interface SpinOptions {
  signal?: AbortSignal;
}

/**
* A `Promise<void>` returned by `timeout()` carrying a `cancel()` method to tear
* down the pending timer before it fires. Mirrors the `internal:runtime/loop`
* contract: a cancelled timer is left unsettled forever.
*
* @internal
*/
export interface CancelablePromise extends Promise<void> {
  cancel(): void;
  ref(): CancelablePromise;
  unref(): CancelablePromise;
  hasRef(): boolean;
}

// Atomics.waitAsync settles from another thread with no reactor registration,
// so — as in loop.ts — it is tracked with a JS counter that feeds alive().
// The count is mirrored natively (trackAtomicsWaiter) because under native
// drive the Rust loop needs it to bound its reactor wait.
let _atomicsWaiters = 0;

// ---------------------------------------------------------------------------
// Runtime hooks
// ---------------------------------------------------------------------------
/** Poll the reactor for ready events, resolve them, and return the count. */
export function tick(timeoutMs: number): number {
  return native.tick(timeoutMs);
}

/** Whether the reactor still has work that could settle. */
export function alive(): boolean {
  return native.alive() || hasPendingV8Tasks() || _atomicsWaiters > 0;
}

/** Live handle counts for diagnostics/tests — mirrors loop.ts's shape. */
export function _activeHandleCounts(): {
  reads: number;
  writes: number;
  timers: number;
  procs: number;
  completions: number;
  vnodes: number;
  atomicsWaiters: number;
  pendingV8Tasks: boolean;
} {
  const c = native.activeHandleCounts();
  return {
    reads: c.reads,
    writes: c.writes,
    timers: c.timers,
    procs: c.procs,
    completions: 0,
    vnodes: c.vnodes,
    atomicsWaiters: _atomicsWaiters,
    pendingV8Tasks: hasPendingV8Tasks()
  };
}

export function _trackAtomicsWaiter(): void {
  _atomicsWaiters++;
  native.trackAtomicsWaiter();
}

export function _untrackAtomicsWaiter(): void {
  _atomicsWaiters--;
  native.untrackAtomicsWaiter();
}

// ---------------------------------------------------------------------------
// Readiness + fused transfer
// ---------------------------------------------------------------------------
/**
* Resolve when `fd` is readable, with the bytes-available estimate. An
* unreferenced watch (`referenced: false`) never keeps its realm alive — used
* for a realm's own port wake, mirroring an unref'd IPC channel.
*/
export function readable(fd: number, referenced = true): Promise<number> {
  return native.readable(fd, referenced);
}

/**
* Resolve when `fd` is writable. Resolves `0` when genuinely writable, or the
* negated pending socket error (e.g. a failed connect's `-ECONNREFUSED`) —
* the reactor's poll consumes `SO_ERROR`, so a caller's own `getsockopt`
* afterwards would read `0`.
*/
export function writable(fd: number): Promise<number> {
  return native.writable(fd) as unknown as Promise<number>;
}

/**
* Fused read: perform `read(2)` natively and return the byte count (`0` = EOF,
* negative = `-errno`). Returns a plain number SYNCHRONOUSLY when the read
* completes without blocking (the common case), or a `Promise<number>` when it
* would block — so the hot path pays no Promise/microtask.
*/
export function readAsync(fd: number, buf: Uint8Array | ArrayBuffer, offset: number, len: number): number | Promise<number> {
  return native.readAsync(fd, buf, offset, len);
}

/**
* Fused write: drain `buf` natively across `EAGAIN`, returning the total bytes
* written (negative = `-errno`). Returns a plain number SYNCHRONOUSLY when the
* write completes without blocking, or a `Promise<number>` when it would block.
*/
export function writeAsync(fd: number, buf: Uint8Array | ArrayBuffer, offset: number, len: number): number | Promise<number> {
  return native.writeAsync(fd, buf, offset, len);
}

/**
* Fused read, always awaitable: a synchronous completion resolves without
* parking, so callers can `await` unconditionally instead of repeating the
* number-or-promise branch at every site.
*/
export function readAwaited(fd: number, buf: Uint8Array | ArrayBuffer, offset: number, len: number): Promise<number> {
  const r = native.readAsync(fd, buf, offset, len);
  return typeof r === 'number' ? Promise.resolve(r) : r as Promise<number>;
}

/** Fused write counterpart of {@link readAwaited}. */
export function writeAwaited(fd: number, buf: Uint8Array | ArrayBuffer, offset: number, len: number): Promise<number> {
  const r = native.writeAsync(fd, buf, offset, len);
  return typeof r === 'number' ? Promise.resolve(r) : r as Promise<number>;
}

/**
* Positional/streaming file read. `pos < 0` reads at the current offset;
* otherwise `pread(2)` at `pos`. Resolves with the byte count (negative =
* `-errno`). Regular-file reads do not block meaningfully, so this is a native
* synchronous read surfaced as a promise.
*/
export function fileReadAsync(fd: number, buf: Uint8Array | ArrayBuffer, offset: number, len: number, pos = -1): Promise<number> {
  return Promise.resolve(native.fileRead(fd, buf, offset, len, pos));
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------
/** Resolve after at least `ms` ms, returning a cancelable promise. */
export function timeout(ms: number): CancelablePromise {
  const { id, promise } = native.addTimer(ms);
  const p = promise as CancelablePromise;
  let referenced = true;
  p.cancel = function cancelTimeout() {
    native.cancelTimer(id);
  };
  p.ref = function refTimeout() {
    if (!referenced) {
      referenced = true;
      native.setTimerRef(id, true);
    }
    return p;
  };
  p.unref = function unrefTimeout() {
    if (referenced) {
      referenced = false;
      native.setTimerRef(id, false);
    }
    return p;
  };
  p.hasRef = function hasTimerRef() {
    return referenced;
  };
  return p;
}

// ---------------------------------------------------------------------------
// proc / vnode / signal
// ---------------------------------------------------------------------------
export function proc(pid: number): Promise<void> {
  return native.proc(pid);
}

export function vnode(fd: number, fflags: number, callback: (event: {
  fflags: number;
}) => void): void {
  native.addVnode(fd, fflags, callback);
}

export function removeVnode(fd: number): void {
  native.removeVnode(fd);
}

export function signal(signo: number, callback: () => void): void {
  native.addSignal(signo, callback);
}

export function removeSignal(signo: number): void {
  native.removeSignal(signo);
}

// ---------------------------------------------------------------------------
// Wake sources + watch removal
// ---------------------------------------------------------------------------
export function registerWakeSource(fd: number): void {
  native.registerWakeSource(fd);
}

/**
* Set `fd` to non-blocking mode. Native because `fcntl(2)` is variadic —
* the JS FFI silently miscalls it on ARM64 Darwin — and because non-blocking
* fds are a hard precondition of the fused read/write fast paths.
*
* @internal
*/
export function setNonblocking(fd: number): void {
  native.setNonblocking(fd);
}

/**
* Variadic-safe `open(2)`: the mode argument rides the variadic ABI, which
* the JS FFI silently miscalls on ARM64 Darwin — files created through a
* fixed-arg FFI `open` get garbage permission bits. Returns the fd, or the
* negated errno on failure.
*
* @internal
*/
export function openSync(path: string, flags: number, mode: number = 0): number {
  return native.openSync(path, flags, mode);
}

export function removeRead(fd: number): void {
  native.removeRead(fd);
}

export function removeWrite(fd: number): void {
  native.removeWrite(fd);
}

// ---------------------------------------------------------------------------
// Synchronous spinning
// ---------------------------------------------------------------------------
/** Synchronously drive the reactor until `promise` settles. */
export function spin<T>(promise: Promise<T>, options?: SpinOptions): T {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  let settled = false;
  let result: T | undefined, error: unknown;
  let hasError = false;
  promise.then(function onSpinResolved(v) {
    result = v;
    settled = true;
  }, function onSpinRejected(e) {
    error = e;
    hasError = true;
    settled = true;
  });
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = function onSpinAborted() {
      error = signal.reason;
      hasError = true;
      settled = true;
    };
    signal.addEventListener('abort', onAbort);
  }
  try {
    let emptyTicks = 0;
    while (!settled) {
      drainMicrotasks();
      if (settled) break;
      const timeout = emptyTicks >= 3 ? signal ? 10 : 50 : 0;
      const count = native.tick(timeout);
      drainMicrotasks();
      if (settled) break;
      emptyTicks = count === 0 ? emptyTicks + 1 : 0;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (hasError) throw error;
  return result as T;
}

/** Invoke `fn`, spinning the reactor if it returns a promise. */
export function run<T>(fn: () => T | Promise<T>, options?: SpinOptions): T {
  const ret = fn();
  if (ret && typeof (ret as any).then === 'function') {
    return spin(ret as Promise<T>, options);
  }
  return ret as T;
}
