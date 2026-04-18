/**
 * fino:context — Async context propagation.
 *
 * A `Context` is a named slot whose value follows the causal chain of async
 * execution through `await` and `.then()`. It works by hooking into V8's ContinuationPreservedEmbedderData (CPED):
 * when a promise continuation is enqueued, the current frame is captured;
 * when the continuation runs, the frame is restored.
 *
 * API mirrors the execution-flow library (closure-based):
 *
 *   import { Context } from './context.mts';
 *
 *   const requestId = new Context('requestId');
 *
 *   await requestId.runWithValue('abc-123', async () => {
 *     await someAsyncOp();
 *     console.log(requestId.get()); // 'abc-123' — propagated through await
 *   });
 */

import { getCPED, setCPED } from 'internal:async-context';

// ---------------------------------------------------------------------------
// Slot management — implemented in JS using V8 CPED intrinsics.
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
  const arr = old.slice(); // COW
  arr[slot] = undefined;
  setCPED(arr);
}

function snapshot(): unknown {
  return getCPED();
}

function restore(state: unknown): void {
  setCPED(state);
}

export class Context<T = unknown> {
  #id: number;
  #name: string;

  /**
   * @param {string} name  Descriptive name for debugging.
   */
  constructor(name: string) {
    this.#name = name;
    this.#id = createSlot();
  }

  /** The context name (readonly). */
  get name() {
    return this.#name;
  }

  /**
   * Return the current value of this context slot, or `undefined` if no value
   * has been set (or if `runClear` is active) in the current async scope.
   *
   * @returns {* | undefined}
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
   * @param {*}        value  The value to set for the duration of `fn`.
   * @param {Function} fn     The function to run.
   * @returns The return value of `fn`.
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
   * Run `fn` with this context slot explicitly cleared, making `get()` return
   * `undefined` for the duration of `fn` even if an outer scope has a value.
   * The previous value is restored afterwards.
   *
   * @param {Function} fn
   * @returns The return value of `fn`.
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
   * Unconditionally set this slot to `value` in the current async execution
   * scope without scheduling a restore. All future microtasks enqueued from
   * this point — and their continuations — will inherit the value.
   *
   * Use sparingly. Unlike `runWithValue`, there is no automatic cleanup:
   * the caller is responsible for calling `exit()` when appropriate.
   *
   * Analogous to Node.js `AsyncLocalStorage.enterWith()`.
   *
   * @param {*} value
   */
  enterWith(value: T): void {
    setSlot(this.#id, value);
  }

  /**
   * Clear this slot in the current async execution scope.
   * Code running synchronously after this call will see `undefined`.
   * Previously-enqueued microtasks keep their captured value unchanged.
   */
  exit(): void {
    clearSlot(this.#id);
  }

  /**
   * Capture the current frame as a `Snapshot` that can be re-entered later —
   * useful when manually scheduling callbacks outside the normal async flow
   * (e.g. passing callbacks to third-party queues or custom event emitters).
   *
   * @returns {Snapshot}
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
 */
export class Snapshot {
  #handle: unknown;

  constructor(handle: unknown) {
    this.#handle = handle;
  }

  /**
   * Run `fn` inside the snapshotted frame. The previous frame is restored
   * afterwards regardless of whether `fn` throws.
   *
   * @param {Function} fn
   * @returns The return value of `fn`.
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
 * @returns {Snapshot}
 */
export function snapshotAll(): Snapshot {
  return new Snapshot(snapshot());
}
