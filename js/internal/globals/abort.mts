/**
 * fino:abort — AbortController and AbortSignal (WHATWG DOM spec)
 *
 * AbortController / AbortSignal is the cancellation primitive used across
 * the web platform: fetch(), stream readers, and any API that accepts a
 * `signal` option. This module implements the WHATWG DOM spec surface
 * (https://dom.spec.whatwg.org/#aborting-ongoing-activities) in pure JS.
 *
 *
 * ## AbortSignal extends EventTarget
 *
 * AbortSignal inherits addEventListener / removeEventListener / dispatchEvent
 * from `fino:eventtarget`. The abort event is dispatched as a proper Event
 * instance. The `onabort` IDL event handler fires before registered listeners
 * (consistent with browsers and the previous ad-hoc implementation).
 *
 *
 * ## The _signalAbort WeakMap pattern
 *
 * The WHATWG spec has a conceptual "abort steps" algorithm that is triggered
 * by the controller but runs inside the signal. In a full DOM implementation
 * this is a C++ internal link. Here we approximate it with a WeakMap.
 *
 * In `AbortSignal`'s constructor, a closure is created that has direct access
 * to `this.#aborted` and `this.#reason`. That closure is stored in the
 * module-level `_signalAbort` WeakMap, keyed on the signal instance.
 * `AbortController.abort()` calls `_signalAbort.get(this.#signal)` to
 * retrieve and invoke the closure.
 *
 *
 * ## AbortSignal.timeout(ms)
 *
 * Uses `fino:loop` to set a timer. The import is done lazily to avoid a
 * circular dependency at module load time.
 *
 *
 * ## AbortSignal.any(signals)
 *
 * Iterates the input signals. If any is already aborted, the output signal
 * is immediately aborted. Otherwise each input gets an abort listener that
 * triggers the output. The first input to fire wins (idempotent closure).
 *
 *
 * ```ts
 * // AbortController and AbortSignal are available via globalThis
 *
 * const controller = new AbortController();
 * const { signal } = controller;
 *
 * signal.addEventListener('abort', (e) => console.log('aborted:', e.target.reason));
 * controller.abort();
 * // → signal.aborted === true
 *
 * // Static factories:
 * AbortSignal.abort(reason?)   // pre-aborted signal
 * AbortSignal.timeout(ms)      // signal that aborts after ms milliseconds
 * AbortSignal.any(signals)     // signal that aborts when any input signal aborts
 * ```
 *
 * @internal
 */

import { EventTarget, Event } from './eventtarget.mts';

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

// Maps each AbortSignal to its internal abort trigger function.
// Created inside the constructor so the closure has private-field access.
const _signalAbort = new WeakMap<AbortSignal, (reason: unknown) => void>();

function defaultAbortError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// Guards against direct `new AbortSignal()` — must only be created via _createSignal().
let _allowConstruct = false;
function _createSignal(): AbortSignal {
  _allowConstruct = true;
  return new AbortSignal();
}

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

export class AbortSignal extends EventTarget {
  #aborted: boolean = false;
  #reason: unknown = undefined;
  #onabort: ((event: Event) => void) | null = null;

  get [Symbol.toStringTag]() { return 'AbortSignal'; }

  constructor() {
    if (!_allowConstruct) throw new TypeError('Illegal constructor');
    _allowConstruct = false;
    super();
    const signal = this;
    _signalAbort.set(this, function (reason: unknown) {
      if (signal.#aborted) return;
      signal.#aborted = true;
      signal.#reason = reason;
      signal.dispatchEvent(new Event('abort'));
    });
  }

  get aborted() { return this.#aborted; }
  get reason()  { return this.#reason; }
  get onabort() { return this.#onabort; }
  set onabort(v: ((event: Event) => void) | null) { this.#onabort = typeof v === 'function' ? v : null; }

  throwIfAborted(): void {
    if (this.#aborted) throw this.#reason;
  }

  // Fire the onabort IDL event handler before registered EventTarget listeners.
  dispatchEvent(event: Event): boolean {
    if (event.type === 'abort' && typeof this.#onabort === 'function') {
      try { this.#onabort(event); } catch (_) {}
    }
    return super.dispatchEvent(event);
  }

  // ---------------------------------------------------------------------------
  // Static factories
  // ---------------------------------------------------------------------------

  static abort(reason?: unknown): AbortSignal {
    if (reason === undefined) {
      reason = defaultAbortError('The operation was aborted.', 'AbortError');
    }
    const signal = _createSignal();
    _signalAbort.get(signal)?.(reason);
    return signal;
  }

  static timeout(ms: number): AbortSignal {
    const signal = _createSignal();
    const fireAbort = _signalAbort.get(signal);
    import('fino:runtime/loop').then(function (loop) {
      loop.timeout(ms).then(function () {
        fireAbort?.(defaultAbortError('The operation timed out.', 'TimeoutError'));
      });
    });
    return signal;
  }

  static any(signals: AbortSignal[]): AbortSignal {
    // Validate: must be iterable and all elements must be AbortSignal instances.
    if (signals == null || typeof (signals as any)[Symbol.iterator] !== 'function') {
      throw new TypeError('AbortSignal.any: argument must be iterable');
    }
    const arr = Array.from(signals as Iterable<unknown>);
    for (let i = 0; i < arr.length; i++) {
      if (!(arr[i] instanceof AbortSignal)) {
        throw new TypeError(`AbortSignal.any: element at index ${i} is not an AbortSignal`);
      }
    }
    const out = _createSignal();
    const doAbort = _signalAbort.get(out);
    for (let i = 0; i < arr.length; i++) {
      const sig = arr[i] as AbortSignal;
      if (sig.aborted) {
        doAbort?.(sig.reason);
        return out;
      }
    }
    const listeners: Array<[AbortSignal, () => void]> = [];
    function onAbort(sig: AbortSignal): void {
      doAbort?.(sig.reason);
      for (let j = 0; j < listeners.length; j++) {
        listeners[j]![0].removeEventListener('abort', listeners[j]![1]);
      }
    }
    for (let i = 0; i < arr.length; i++) {
      const sig = arr[i] as AbortSignal;
      const fn = function () { onAbort(sig); };
      listeners.push([sig, fn]);
      sig.addEventListener('abort', fn);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// AbortController
// ---------------------------------------------------------------------------

export class AbortController {
  #signal = _createSignal();

  get [Symbol.toStringTag]() { return 'AbortController'; }
  get signal() { return this.#signal; }

  abort(reason?: unknown): void {
    if (reason === undefined) {
      reason = defaultAbortError('The operation was aborted.', 'AbortError');
    }
    _signalAbort.get(this.#signal)?.(reason);
  }
}
