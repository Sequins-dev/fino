/**
 * fino:context - Async context propagation.
 *
 * A `Context` is a named slot whose value follows the causal chain of async
 * execution through promise continuations, including `await`, `.then()`,
 * `queueMicrotask()`, timers implemented on the runtime loop, and promise-based
 * runtime APIs such as file I/O. It works by hooking into V8's
 * ContinuationPreservedEmbedderData (CPED): when a promise continuation is
 * enqueued, the current frame is captured; when the continuation runs, the
 * frame is restored. Because the frame array is copied on every write, values
 * captured by already-enqueued continuations are never mutated retroactively -
 * each async branch sees exactly the values that were active when it was
 * scheduled.
 *
 * Synchronous dispatch and callback re-entry observe whatever context is active
 * during the dispatch/callback call (e.g. an `EventTarget` listener sees the
 * context of the `dispatchEvent()` caller). External or native schedulers that
 * do not enqueue through these runtime paths are not promised to preserve
 * context unless they are explicitly covered by tests or the callback is
 * manually wrapped with a `Snapshot`.
 *
 * The API supports both callback and disposable scopes. `runWithValue()` scopes
 * a value to a callback and restores the previous frame afterwards, similar to
 * Node's `AsyncLocalStorage.run()`. `withValue()` returns a disposable scope for
 * `using` blocks. `enterWith()`/`exit()` remain the unscoped escape hatch, and
 * `Snapshot` replays a frame across schedulers that do not propagate. For
 * context-bound publish/subscribe, see `fino:context/topic`.
 *
 * ```ts no_run
 *   import { Context } from 'fino:context';
 *
 *   const requestId = new Context<string>('requestId');
 *
 *   {
 *     using scope = requestId.withValue('abc-123');
 *     await someAsyncOp();
 *     console.log(requestId.get()); // 'abc-123' - propagated through await
 *   }
 * ```
 */
import { getCPED, setCPED } from 'internal:async-context';
// ---------------------------------------------------------------------------
// Slot management - implemented in JS using V8 CPED intrinsics.
//
// getCPED() / setCPED() are Torque builtins extracted from the V8 extras
// binding object. They compile to direct CPED memory loads/stores on the
// V8 isolate and can be inlined by TurboFan/Maglev.
//
// COW invariant: setSlot and clearSlot always create a NEW array so that
// previously-enqueued promise continuations keep their captured frame intact.
// ---------------------------------------------------------------------------
let slotCount = 0;
function createSlot(): number {
  return slotCount++;
}
function getSlot<T>(slot: number): T | undefined {
  const arr = getCPED() as unknown[] | undefined;
  return arr ? (arr[slot] as T) : undefined;
}
function setSlot<T>(slot: number, value: T): void {
  const old = getCPED() as unknown[] | undefined;
  // COW: create a new array so V8-captured continuations keep their frame.
  const arr: unknown[] = old ? old.slice() : new Array(slotCount);
  arr[slot] = value;
  setCPED(arr);
}
function clearSlot(slot: number): void {
  const old = getCPED() as unknown[] | undefined;
  if (!old) return;
  const arr = old.slice();
  arr[slot] = undefined;
  setCPED(arr);
}
function snapshot(): unknown {
  return getCPED();
}
function restore(state: unknown): void {
  setCPED(state);
}
/**
 * Disposable context scope returned by `Context.withValue()` and
 * `Context.withClear()`.
 *
 * Disposing the scope restores the complete context frame captured before the
 * scope was entered. `using` declarations dispose in reverse order, so nested
 * scopes restore naturally.
 *
 * ```ts no_run
 * import { Context } from 'fino:context';
 *
 * const request = new Context<string>('request');
 * {
 *   using scope = request.withValue('req-1');
 *   console.log(request.get());
 * }
 * ```
 */
export interface ContextScope {
  /**
   * Restore the context frame captured before the scope was entered.
   *
   * Calling this method more than once has no additional effect.
   */
  [Symbol.dispose](): void;
}
function restoreScope(previous: unknown): ContextScope {
  let disposed = false;
  return {
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      restore(previous);
    },
  };
}
/**
 * Async-local context slot whose value follows promise continuations.
 *
 * Each `Context` instance owns one independent slot. Values are scoped to the
 * current async execution frame and are restored after `runWithValue()` or
 * `runClear()` completes, even when the callback throws. Values are not shared
 * across unrelated realms or processes.
 *
 * ```ts no_run
 * import { Context } from 'fino:context';
 *
 * const requestId = new Context<string>('requestId');
 * await requestId.runWithValue('req-1', async () => {
 *   await Promise.resolve();
 *   console.log(requestId.get());
 * });
 * ```
 */
export class Context<T = unknown> {
  /**
   * Slot index allocated from the module-wide counter at construction time.
   * It is this context's fixed position in the CPED frame array and is what
   * actually keys lookups - not the debug name.
   *
   * @internal
   */
  #id: number;
  /**
   * Debug name supplied to the constructor, exposed via the `name` getter.
   * Purely informational; it plays no part in slot identity.
   *
   * @internal
   */
  #name: string;
  /**
   * Create a context slot with a stable debug name.
   *
   * The name is informational and does not affect lookup identity. Two
   * contexts with the same name remain separate slots. The constructor does not
   * install a value; `get()` returns `undefined` until a scope is entered.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const tenant = new Context<string>('tenant');
   * console.log(tenant.name);
   * ```
   */
  constructor(name: string) {
    this.#name = name;
    this.#id = createSlot();
  }
  /**
   * Read the debug name supplied to the constructor.
   *
   * The value is read-only and never falls back to a generated name. It is safe
   * to use in logs, but it is not a unique key because callers may create
   * multiple contexts with the same name.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const ctx = new Context('request');
   * console.log(ctx.name);
   * ```
   */
  get name() {
    return this.#name;
  }
  /**
   * Return the current value of this context slot, or `undefined` if no value
   * has been set (or if `runClear` is active) in the current async scope.
   *
   * The lookup is synchronous and allocation-free in the common case. A stored
   * value of `undefined` is indistinguishable from an unset slot, so use a
   * sentinel object if that distinction matters.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const locale = new Context<string>('locale');
   * console.log(locale.get());
   * locale.runWithValue('en-US', () => console.log(locale.get()));
   * ```
   */
  get(): T | undefined {
    return getSlot(this.#id) as T | undefined;
  }
  /**
   * Run `fn` with this context slot set to `value`. The previous value is
   * restored when `fn` returns or throws, preserving proper scope nesting.
   *
   * Works for both sync and async functions. When `fn` is async, all
   * continuations within the returned promise will see `value`.
   *
   * If `fn` throws, the previous frame is restored before the error propagates.
   * The returned value has exactly the same shape as `fn`'s return value; async
   * callbacks therefore return their original `Promise`.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const trace = new Context<string>('trace');
   * const result = await trace.runWithValue('abc', async () => {
   *   await Promise.resolve();
   *   return trace.get();
   * });
   * ```
   */
  runWithValue<R>(value: T, fn: () => R): R {
    const snap = snapshot();
    setSlot(this.#id, value);
    try {
      return fn();
    } finally {
      restore(snap);
    }
  }
  /**
   * Enter a disposable scope with this context slot set to `value`.
   *
   * Use this with a `using` declaration when the scope is naturally represented
   * by a block instead of a callback. Disposing the returned scope restores the
   * complete context frame that was active before `withValue()` was called.
   * Promise continuations scheduled while the scope is active inherit `value`.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const trace = new Context<string>('trace');
   * {
   *   using scope = trace.withValue('abc');
   *   await Promise.resolve();
   *   console.log(trace.get());
   * }
   * ```
   */
  withValue(value: T): ContextScope {
    const snap = snapshot();
    setSlot(this.#id, value);
    return restoreScope(snap);
  }
  /**
   * Run `fn` with this context slot explicitly cleared, making `get()` return
   * `undefined` for the duration of `fn` even if an outer scope has a value.
   * The previous value is restored afterwards.
   *
   * Use this when calling code that must not inherit sensitive request state.
   * As with `runWithValue()`, thrown errors propagate after restoration and
   * async continuations created inside `fn` observe the cleared slot.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const auth = new Context<string>('auth');
   * auth.runWithValue('token', () => {
   *   auth.runClear(() => console.log(auth.get()));
   * });
   * ```
   */
  runClear<R>(fn: () => R): R {
    const snap = snapshot();
    clearSlot(this.#id);
    try {
      return fn();
    } finally {
      restore(snap);
    }
  }
  /**
   * Enter a disposable scope with this context slot cleared.
   *
   * Use this when a block must not inherit an outer value. Disposing the scope
   * restores the complete context frame that was active before `withClear()` was
   * called.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const auth = new Context<string>('auth');
   * auth.runWithValue('token', () => {
   *   using scope = auth.withClear();
   *   console.log(auth.get());
   * });
   * ```
   */
  withClear(): ContextScope {
    const snap = snapshot();
    clearSlot(this.#id);
    return restoreScope(snap);
  }
  /**
   * Unconditionally set this slot to `value` in the current async execution
   * scope without scheduling a restore. All future microtasks enqueued from
   * this point - and their continuations - will inherit the value.
   *
   * Use sparingly. Unlike `runWithValue`, there is no automatic cleanup:
   * the caller is responsible for calling `exit()` when appropriate.
   *
   * Analogous to Node.js `AsyncLocalStorage.enterWith()`.
   *
   * Prefer `runWithValue()` for bounded scopes. `enterWith()` is useful for
   * event-loop integration points that need to set state before scheduling
   * callbacks and then clear it explicitly.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const request = new Context<string>('request');
   * request.enterWith('req-42');
   * queueMicrotask(() => console.log(request.get()));
   * request.exit();
   * ```
   */
  enterWith(value: T): void {
    setSlot(this.#id, value);
  }
  /**
   * Clear this slot in the current async execution scope.
   * Code running synchronously after this call will see `undefined`.
   * Previously-enqueued microtasks keep their captured value unchanged.
   *
   * `exit()` only clears this context's slot, not other `Context` instances.
   * It does not throw when the slot is already empty.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const ctx = new Context('request');
   * ctx.enterWith('req-1');
   * ctx.exit();
   * console.log(ctx.get());
   * ```
   */
  exit(): void {
    clearSlot(this.#id);
  }
  /**
   * Capture the current frame as a `Snapshot` that can be re-entered later -
   * useful when manually scheduling callbacks outside the normal async flow
   * (e.g. passing callbacks to third-party queues or custom event emitters).
   *
   * The snapshot captures all context slots, not just this instance. Re-enter
   * it with `Snapshot.runWithValue()` around callbacks whose scheduler does
   * not preserve promise continuation state.
   *
   * ```ts no_run
   * import { Context } from 'fino:context';
   *
   * const ctx = new Context<string>('request');
   * const saved = ctx.runWithValue('req-1', () => ctx.snapshot());
   * saved.runWithValue(() => console.log(ctx.get()));
   * ```
   */
  snapshot() {
    return new Snapshot(snapshot());
  }
}
/**
 * A frozen capture of the full context frame at a point in time, across all
 * `Context` instances. Can be re-entered later via `runWithValue()`.
 *
 * Obtain via `context.snapshot()` or the module-level `snapshotAll()`.
 *
 * ```ts no_run
 * import { Context, snapshotAll } from 'fino:context';
 *
 * const ctx = new Context<string>('request');
 * const snap = ctx.runWithValue('req-1', () => snapshotAll());
 * snap.runWithValue(() => console.log(ctx.get()));
 * ```
 */
export class Snapshot {
  /**
   * Opaque CPED frame captured at snapshot time. Restored verbatim for the
   * duration of `runWithValue()`; never mutated, so the snapshot stays valid
   * across repeated re-entries.
   *
   * @internal
   */
  #handle: unknown;
  /**
   * Create a snapshot wrapper around an opaque runtime context frame.
   *
   * Application code normally obtains snapshots through `Context.snapshot()`
   * or `snapshotAll()`. The handle is intentionally opaque; passing an invalid
   * value can restore an unusable frame.
   *
   * ```ts no_run
   * import { snapshotAll } from 'fino:context';
   *
   * const snap = snapshotAll();
   * snap.runWithValue(() => console.log('restored'));
   * ```
   */
  constructor(handle: unknown) {
    this.#handle = handle;
  }
  /**
   * Run `fn` inside the snapshotted frame. The previous frame is restored
   * afterwards regardless of whether `fn` throws.
   *
   * The return value is the exact return value from `fn`. If `fn` schedules
   * promise continuations, those continuations inherit the snapshotted frame.
   *
   * ```ts no_run
   * import { Context, snapshotAll } from 'fino:context';
   *
   * const ctx = new Context<string>('trace');
   * const snap = ctx.runWithValue('abc', () => snapshotAll());
   * await snap.runWithValue(async () => ctx.get());
   * ```
   */
  runWithValue<R>(fn: () => R): R {
    const prev = snapshot();
    restore(this.#handle);
    try {
      return fn();
    } finally {
      restore(prev);
    }
  }
}
/**
 * Capture all current context slot values as a `Snapshot`. Useful at the
 * point where a callback is registered, so it can be replayed with the full
 * context frame intact when the callback is invoked later.
 *
 * The returned object is independent of later `enterWith()` or `exit()` calls.
 * It may be reused for multiple callbacks.
 *
 * ```ts no_run
 * import { Context, snapshotAll } from 'fino:context';
 *
 * const ctx = new Context<string>('tenant');
 * const snap = ctx.runWithValue('acme', () => snapshotAll());
 * setTimeout(() => snap.runWithValue(() => console.log(ctx.get())), 0);
 * ```
 */
export function snapshotAll(): Snapshot {
  return new Snapshot(snapshot());
}
