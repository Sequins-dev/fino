/**
* AbortController and AbortSignal globals.
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
* from the EventTarget global implementation. The abort event is dispatched as
* a proper Event instance. The `onabort` IDL attribute is backed by a listener
* registered via addEventListener, so it fires in insertion order relative to
* other abort listeners.
*
*
* ## The _signalAbort WeakMap pattern
*
* The WHATWG spec has a conceptual "abort steps" algorithm that is triggered
* by the controller but runs inside the signal. In a full DOM implementation
* this is a C++ internal link. Here we approximate it with WeakMaps.
*
* In `AbortSignal`'s constructor, closures are created that have direct
* access to `this.#aborted` and `this.#reason`. They are stored in the
* module-level `_signalAbort` and `_signalMarkAbort` WeakMaps, keyed on the
* signal instance. `AbortController.abort()` calls
* `_signalAbort.get(this.#signal)` to retrieve and invoke the trigger.
* Aborting is two-phase, matching the spec: first every affected signal
* (the source plus its transitive dependents) is marked aborted and its
* reason recorded, then abort events are dispatched in that same order.
* An abort listener therefore always observes `aborted === true` on every
* related signal, and sources fire before their dependents.
*
*
* ## AbortSignal.timeout(ms)
*
* Coerces `ms` with Number() and accepts only finite, non-negative delays.
* Invalid values throw RangeError before a signal is created. Uses
* `internal:runtime/loop` to set a timer. The import is done lazily to avoid
* a circular dependency at module load time. The timer is not externally
* cancelable; it either fires and aborts the signal or is ignored if the
* realm exits first.
*
*
* ## AbortSignal.any(signals)
*
* Validates that the input is iterable and every element is an AbortSignal.
* If any input is already aborted, the output signal is created pre-aborted
* with that input's reason. Otherwise the output is registered as a
* dependent of each input's *source* signals (composite signals from a
* previous `any()` call are flattened to their original sources), so a
* single controller abort marks the whole dependency graph before any abort
* event fires. The first source to abort wins; later aborts are ignored
* because signal state is immutable once settled.
*
*
* ```ts no_run
* // AbortController and AbortSignal are available via globalThis
*
* const controller = new AbortController();
* const { signal } = controller;
*
* signal.addEventListener('abort', () => console.log('aborted:', signal.reason));
* controller.abort();
* // → signal.aborted === true
*
* // Static factories:
* const done = AbortSignal.abort(new Error('done'));  // pre-aborted signal
* const timed = AbortSignal.timeout(5000);            // aborts after 5s with a TimeoutError
* const merged = AbortSignal.any([signal, timed]);    // aborts when any input aborts
* ```
*
*/
import { EventTarget, Event, _createTrustedEvent } from './eventtarget.ts';
import { DOMException } from './encoding.ts';
// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------
// Maps each AbortSignal to its internal abort trigger function.
// Created inside the constructor so the closure has private-field access.
const _signalAbort = new WeakMap<AbortSignal, (reason: unknown) => void>();
const _signalMarkAbort = new WeakMap<AbortSignal, (reason: unknown, queue: AbortSignal[]) => void>();
const _signalDependents = new WeakMap<AbortSignal, AbortSignal[]>();
const _signalSources = new WeakMap<AbortSignal, AbortSignal[]>();
function _markSignalAborted(signal: AbortSignal, reason: unknown, queue: AbortSignal[]): void {
  _signalMarkAbort.get(signal)?.(reason, queue);
}
function _sourceSignals(signal: AbortSignal): AbortSignal[] {
  return _signalSources.get(signal) ?? [signal];
}
function defaultAbortError(message: string, name: string): DOMException {
  return new DOMException(message, name);
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
/**
* A signal object that notifies observers when an operation is aborted.
*
* This is the WHATWG `AbortSignal` interface, installed on `globalThis` by the
* runtime bootstrap — application code never imports it. A signal starts
* non-aborted; once it aborts (via its owning AbortController or one of the
* static factories) it stays aborted forever, its `reason` is fixed, and an
* `abort` event is dispatched exactly once. Listeners added after the signal
* has already aborted are never called retroactively — check `aborted` first
* or use `throwIfAborted()`.
*
* Signals cannot be constructed directly (`new AbortSignal()` throws a
* TypeError). Create them through `new AbortController().signal`,
* `AbortSignal.abort()`, `AbortSignal.timeout()`, or `AbortSignal.any()`.
*
* ```ts no_run
* const controller = new AbortController();
* const { signal } = controller;
*
* async function poll(signal: AbortSignal) {
*   while (true) {
*     signal.throwIfAborted();
*     await fetch('https://example.com/status', { signal });
*   }
* }
*
* const work = poll(signal).catch((err) => console.log('stopped:', err));
* controller.abort(new Error('shutting down'));
* ```
*
*/
export class AbortSignal extends EventTarget {
  /**
  * Backing state for the `aborted` getter.
  *
  * Flipped to true exactly once by the mark-abort closure created in the
  * constructor; it never returns to false. Only that closure and the public
  * getters read or write it, which is why the closure is captured in a
  * module-level WeakMap rather than exposed as a method.
  *
  * @internal
  */
  #aborted: boolean = false;
  /**
  * Backing state for the `reason` getter.
  *
  * Remains undefined until the signal aborts, then holds whatever value was
  * passed to abort() — including falsy values like null, 0, or '' — for the
  * rest of the signal's lifetime.
  *
  * @internal
  */
  #reason: unknown = undefined;
  /**
  * Currently assigned `onabort` handler, or null when unset.
  *
  * The setter mirrors this into a real addEventListener registration, so the
  * field exists only to remember which listener to remove when the handler is
  * replaced or cleared.
  *
  * @internal
  */
  #onabort: ((event: Event) => void) | null = null;
  /**
  * String tag used by Object.prototype.toString for this web-platform object.
  *
  * ```typescript no_run
  * const signal = AbortSignal.abort();
  * Object.prototype.toString.call(signal); // "[object AbortSignal]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'AbortSignal';
  }
  /**
  * Internal constructor for AbortSignal instances.
  *
  * Signals are created by AbortController and the static AbortSignal factory
  * methods. Direct construction throws a TypeError so callers cannot create a
  * signal that is missing the internal abort closure.
  *
  * ```typescript no_run
  * const signal = AbortSignal.abort('done');
  * signal.aborted; // true
  * ```
  */
  constructor() {
    if (!_allowConstruct) throw new TypeError('Illegal constructor');
    _allowConstruct = false;
    super();
    const signal = this;
    _signalMarkAbort.set(this, function(reason: unknown, queue: AbortSignal[]) {
      if (signal.#aborted) return;
      signal.#aborted = true;
      signal.#reason = reason;
      queue.push(signal);
      const dependents = _signalDependents.get(signal);
      if (dependents != null) {
        for (let i = 0; i < dependents.length; i++) {
          _markSignalAborted(dependents[i]!, reason, queue);
        }
      }
    });
    _signalAbort.set(this, function(reason: unknown) {
      const queue: AbortSignal[] = [];
      _markSignalAborted(signal, reason, queue);
      for (let i = 0; i < queue.length; i++) {
        queue[i]!.dispatchEvent(_createTrustedEvent('abort'));
      }
    });
  }
  /**
  * Whether this signal has already been aborted.
  *
  * Once true, the value never returns to false and the abort reason is fixed.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * controller.signal.aborted; // false
  * controller.abort();
  * controller.signal.aborted; // true
  * ```
  */
  get aborted() {
    return this.#aborted;
  }
  /**
  * The reason supplied to abort(), or undefined before aborting.
  *
  * When no reason is supplied, AbortController.abort() and AbortSignal.abort()
  * use a DOMException named "AbortError"; timeout() uses "TimeoutError".
  *
  * ```typescript no_run
  * const signal = AbortSignal.abort(new Error('stop'));
  * signal.reason.message; // "stop"
  * ```
  */
  get reason() {
    return this.#reason;
  }
  /**
  * IDL event handler for the abort event.
  *
  * Assigning a non-function clears the handler. The handler is backed by a
  * regular addEventListener registration, so it fires in insertion order
  * relative to other abort listeners: assign it first and it runs first.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * controller.signal.onabort = (event) => console.log(event.type);
  * controller.abort();
  * ```
  */
  get onabort() {
    return this.#onabort;
  }
  /**
  * Set the abort event handler or clear it with null.
  *
  * Non-function values are treated as null, matching browser IDL handler
  * behavior.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * controller.signal.onabort = null;
  * ```
  */
  set onabort(v: ((event: Event) => void) | null) {
    if (this.#onabort !== null) this.removeEventListener('abort', this.#onabort);
    this.#onabort = typeof v === 'function' ? v : null;
    if (this.#onabort !== null) this.addEventListener('abort', this.#onabort);
  }
  /**
  * Throw the abort reason if this signal has aborted.
  *
  * This is a synchronous guard for APIs that need to fail early before doing
  * work. It returns undefined while the signal is still active.
  *
  * ```typescript no_run
  * const signal = AbortSignal.abort('cancelled');
  * signal.throwIfAborted(); // throws "cancelled"
  * ```
  */
  throwIfAborted(): void {
    if (this.#aborted) throw this.#reason;
  }
  /**
  * Dispatch an event on the signal.
  *
  * The return value follows EventTarget.dispatchEvent(): false only when the
  * event was cancelable and preventDefault() was called.
  *
  * ```typescript no_run
  * const signal = AbortSignal.abort();
  * signal.dispatchEvent(new Event('custom'));
  * ```
  */
  dispatchEvent(event: Event): boolean {
    return super.dispatchEvent(event);
  }
  // ---------------------------------------------------------------------------
  // Static factories
  // ---------------------------------------------------------------------------
  /**
  * Create a signal that is already aborted.
  *
  * If no reason is supplied, the reason is a DOMException named "AbortError".
  * The returned signal dispatches no future abort events because it is already
  * settled.
  *
  * ```typescript no_run
  * const signal = AbortSignal.abort('done');
  * signal.aborted; // true
  * signal.reason; // "done"
  * ```
  */
  static abort(reason?: unknown): AbortSignal {
    if (reason === undefined) {
      reason = defaultAbortError('The operation was aborted.', 'AbortError');
    }
    const signal = _createSignal();
    _signalAbort.get(signal)?.(reason);
    return signal;
  }
  /**
  * Create a signal that aborts after the given delay in milliseconds.
  *
  * The delay is coerced with Number() and must be finite and non-negative.
  * NaN, negative values, and infinities throw RangeError. The timer is
  * scheduled with the runtime loop, and the reason is a DOMException named
  * "TimeoutError". The timer cannot be cancelled from the outside; to combine
  * a deadline with manual cancellation, merge this signal with a controller's
  * signal via AbortSignal.any().
  *
  * ```typescript no_run
  * const signal = AbortSignal.timeout(1000);
  * signal.addEventListener('abort', () => console.log(signal.reason.name));
  * ```
  */
  static timeout(ms: number): AbortSignal {
    const delay = Number(ms);
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError('AbortSignal.timeout: delay must be a finite non-negative number');
    }
    const signal = _createSignal();
    const fireAbort = _signalAbort.get(signal);
    import('internal:runtime/loop').then(function(loop) {
      loop.timeout(delay).then(function() {
        fireAbort?.(defaultAbortError('The operation timed out.', 'TimeoutError'));
      });
    });
    return signal;
  }
  /**
  * Create a signal that aborts when the first input signal aborts.
  *
  * The input must be iterable and every element must be an AbortSignal —
  * anything else throws a TypeError. If an input is already aborted, the
  * returned signal is aborted immediately with the reason of the first such
  * input in iteration order. Otherwise the signal is linked to the original
  * source signals (composite inputs from a previous any() call are flattened)
  * so dependents are marked aborted before abort events are dispatched. An
  * empty iterable yields a signal that can never abort.
  *
  * ```typescript no_run
  * const a = new AbortController();
  * const b = new AbortController();
  * const signal = AbortSignal.any([a.signal, b.signal]);
  * b.abort('winner');
  * signal.reason; // "winner"
  * ```
  */
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
    const sources: AbortSignal[] = [];
    for (let i = 0; i < arr.length; i++) {
      const sig = arr[i] as AbortSignal;
      const sigSources = _sourceSignals(sig);
      for (let j = 0; j < sigSources.length; j++) {
        const source = sigSources[j]!;
        sources.push(source);
        let dependents = _signalDependents.get(source);
        if (dependents == null) {
          dependents = [];
          _signalDependents.set(source, dependents);
        }
        dependents.push(out);
      }
    }
    _signalSources.set(out, sources);
    return out;
  }
}
// ---------------------------------------------------------------------------
// AbortController
// ---------------------------------------------------------------------------
/**
* The controller half of the abort protocol: owns a signal and can abort it.
*
* This is the WHATWG `AbortController` interface, installed on `globalThis`
* by the runtime bootstrap — application code never imports it. Construction
* is cheap: each controller creates exactly one AbortSignal, hands out that
* same instance from the `signal` getter, and `abort()` settles it at most
* once. The split exists so cancellation authority stays with the code that
* created the controller while the signal can be passed freely to any number
* of consumers, none of which can trigger the abort themselves.
*
* ```ts no_run
* const controller = new AbortController();
*
* const response = fetch('https://example.com/large-file', {
*   signal: controller.signal,
* });
*
* // Give up if the download has not finished in five seconds.
* setTimeout(() => controller.abort(new Error('took too long')), 5000);
*
* try {
*   await response;
* } catch (err) {
*   if (controller.signal.aborted) console.log('cancelled:', controller.signal.reason);
* }
* ```
*
*/
export class AbortController {
  /**
  * The single AbortSignal owned by this controller.
  *
  * Created eagerly at construction through _createSignal(), which flips the
  * one-shot construction guard so the otherwise-illegal AbortSignal
  * constructor can run. The instance never changes for the controller's
  * lifetime.
  *
  * @internal
  */
  #signal = _createSignal();
  /**
  * String tag used by Object.prototype.toString for this controller.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * Object.prototype.toString.call(controller); // "[object AbortController]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'AbortController';
  }
  /**
  * The AbortSignal controlled by this controller.
  *
  * The same signal object is returned for the lifetime of the controller.
  * Calling abort() settles it exactly once.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * const signal = controller.signal;
  * controller.abort();
  * signal.aborted; // true
  * ```
  */
  get signal() {
    return this.#signal;
  }
  /**
  * Abort the controlled signal with an optional reason.
  *
  * The first call wins. Later calls are ignored because AbortSignal state is
  * immutable after aborting. If reason is omitted or undefined, the reason is
  * a DOMException named "AbortError". Aborting also settles any dependent
  * signals created with AbortSignal.any() before dispatching abort events.
  *
  * ```typescript no_run
  * const controller = new AbortController();
  * controller.abort(new Error('cancelled'));
  * controller.signal.throwIfAborted();
  * ```
  */
  abort(reason?: unknown): void {
    if (reason === undefined) {
      reason = defaultAbortError('The operation was aborted.', 'AbortError');
    }
    _signalAbort.get(this.#signal)?.(reason);
  }
}
