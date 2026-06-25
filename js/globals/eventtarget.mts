/**
 * Event, CustomEvent, and EventTarget globals
 *
 * Pure JS implementation of the WHATWG EventTarget interface:
 * https://dom.spec.whatwg.org/#interface-eventtarget
 *
 * Scope: flat dispatch only (no DOM tree). All events fire at AT_TARGET.
 * The `bubbles` and `composed` flags are stored but have no propagation
 * effect — Fino has no parent node traversal.
 *
 * Spec conformance:
 *   - addEventListener is idempotent for the same (callback, capture) pair
 *   - `once: true` auto-removes the listener after first invocation
 *   - `signal` option auto-removes the listener when the AbortSignal aborts
 *   - `passive` listeners cannot cancel the event via preventDefault()
 *   - dispatchEvent throws if the event is currently being dispatched
 *   - Listener errors are swallowed and do not prevent later listeners from
 *     firing. Fino does not currently report these through a browser-style
 *     global error event.
 *
 * ## Example
 *
 * ```typescript no_run
 *
 * const target = new EventTarget();
 * target.addEventListener('ready', () => console.log('ready'), { once: true });
 *
 * target.dispatchEvent(new Event('ready'));
 * target.dispatchEvent(new Event('ready'));
 * ```
 *
 */

// ---------------------------------------------------------------------------
// Internal state WeakMaps
// ---------------------------------------------------------------------------

interface EventState {
  type: string; bubbles: boolean; cancelable: boolean; composed: boolean;
  defaultPrevented: boolean; target: EventTarget | null; currentTarget: EventTarget | null;
  eventPhase: number; dispatch: boolean; stopPropagation: boolean;
  stopImmediate: boolean; inPassiveListener: boolean; timeStamp: number;
  trusted: boolean;
}

type EventCallback = ((event: Event) => void) | { handleEvent(event: Event): void };

interface ListenerRecord {
  callback: EventCallback;
  capture: boolean; once: boolean; passive: boolean; removed: boolean;
}

interface AddEventListenerOptions {
  capture?: boolean; once?: boolean; passive?: boolean; signal?: AbortSignal;
}

// Event internal mutable state, keyed on Event instance.
const _eventState = new WeakMap<Event, EventState>();

// EventTarget listener registry: instance → Map<type, ListenerRecord[]>
const _listeners = new WeakMap<EventTarget, Map<string, ListenerRecord[]>>();

function getEventIsTrusted(this: Event): boolean {
  return _eventState.get(this)!.trusted;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOptions(options: boolean | AddEventListenerOptions | null | undefined): { capture: boolean; once: boolean; passive: boolean } {
  if (typeof options === 'boolean') {
    return { capture: options, once: false, passive: false };
  }
  return {
    capture: Boolean(options?.capture),
    once:    Boolean(options?.once),
    passive: Boolean(options?.passive),
  };
}

function normalizeCapture(options: boolean | { capture?: boolean } | null | undefined): boolean {
  if (typeof options === 'boolean') return options;
  return Boolean(options?.capture);
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

/**
 * Flat-dispatch implementation of the WHATWG Event interface.
 *
 * Fino does not have a DOM tree, so every dispatch runs at AT_TARGET and
 * composedPath() returns either the dispatch target or an empty array.
 *
 * ```typescript no_run
 * const event = new Event('ready', { cancelable: true });
 * event.type; // "ready"
 * ```
 */
export class Event {
  /**
   * Event phase constant for no active dispatch.
   *
   * ```typescript no_run
   * Event.NONE; // 0
   * ```
   */
  static NONE            = 0;

  /**
   * Event phase constant for DOM capture.
   *
   * Fino stores the value for compatibility but never enters this phase because
   * there is no parent tree.
   *
   * ```typescript no_run
   * Event.CAPTURING_PHASE; // 1
   * ```
   */
  static CAPTURING_PHASE = 1;

  /**
   * Event phase constant used while dispatching to the target.
   *
   * ```typescript no_run
   * Event.AT_TARGET; // 2
   * ```
   */
  static AT_TARGET       = 2;

  /**
   * Event phase constant for DOM bubbling.
   *
   * The value is exposed for compatibility, but Fino never bubbles events.
   *
   * ```typescript no_run
   * Event.BUBBLING_PHASE; // 3
   * ```
   */
  static BUBBLING_PHASE  = 3;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new Event('x')); // "[object Event]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'Event'; }

  /**
   * Create an Event with optional bubbles, cancelable, and composed flags.
   *
   * The type argument is required and string-coerced. The flags are stored for
   * compatibility, but bubbles and composed do not cause propagation in this
   * flat EventTarget implementation.
   *
   * ```typescript no_run
   * const event = new Event('submit', { cancelable: true });
   * event.cancelable; // true
   * ```
   */
  constructor(type: string, eventInitDict?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean }) {
    if (arguments.length < 1) throw new TypeError("Failed to construct 'Event': 1 argument required, but only 0 present.");
    _eventState.set(this, {
      type:              String(type),
      bubbles:           Boolean(eventInitDict?.bubbles),
      cancelable:        Boolean(eventInitDict?.cancelable),
      composed:          Boolean(eventInitDict?.composed),
      defaultPrevented:  false,
      target:            null,
      currentTarget:     null,
      eventPhase:        0,
      dispatch:          false,
      stopPropagation:   false,
      stopImmediate:     false,
      inPassiveListener: false,
      timeStamp:         typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now(),
      trusted:           false,
    });
    Object.defineProperty(this, 'isTrusted', {
      get: getEventIsTrusted,
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Event type supplied at construction or initEvent().
   *
   * ```typescript no_run
   * new Event('message').type; // "message"
   * ```
   */
  get type()             { return _eventState.get(this)!.type; }

  /**
   * Whether the event was constructed with bubbles: true.
   *
   * This flag is stored only; Fino has no bubbling tree.
   *
   * ```typescript no_run
   * new Event('x', { bubbles: true }).bubbles; // true
   * ```
   */
  get bubbles()          { return _eventState.get(this)!.bubbles; }

  /**
   * Whether preventDefault() can set defaultPrevented.
   *
   * Passive listeners cannot cancel even when this is true.
   *
   * ```typescript no_run
   * new Event('x', { cancelable: true }).cancelable; // true
   * ```
   */
  get cancelable()       { return _eventState.get(this)!.cancelable; }

  /**
   * Whether the event was constructed with composed: true.
   *
   * This value is exposed for compatibility and has no propagation effect.
   *
   * ```typescript no_run
   * new Event('x', { composed: true }).composed; // true
   * ```
   */
  get composed()         { return _eventState.get(this)!.composed; }

  /**
   * Whether preventDefault() has successfully canceled the event.
   *
   * It remains false for non-cancelable events and inside passive listeners.
   *
   * ```typescript no_run
   * const event = new Event('x', { cancelable: true });
   * event.preventDefault();
   * event.defaultPrevented; // true
   * ```
   */
  get defaultPrevented() { return _eventState.get(this)!.defaultPrevented; }

  /**
   * EventTarget currently dispatching or last dispatched this event.
   *
   * The target is null before dispatch and preserved after dispatch, matching
   * browser behavior.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * const event = new Event('x');
   * target.dispatchEvent(event);
   * event.target === target; // true
   * ```
   */
  get target()           { return _eventState.get(this)!.target; }

  /**
   * EventTarget whose listener is currently running.
   *
   * This is set during dispatch and reset to null after dispatch completes.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * target.addEventListener('x', (event) => console.log(event.currentTarget));
   * ```
   */
  get currentTarget()    { return _eventState.get(this)!.currentTarget; }

  /**
   * Current dispatch phase.
   *
   * Fino reports AT_TARGET during listener execution and NONE otherwise.
   *
   * ```typescript no_run
   * const event = new Event('x');
   * event.eventPhase; // Event.NONE
   * ```
   */
  get eventPhase()       { return _eventState.get(this)!.eventPhase; }

  /**
   * Monotonic timestamp captured when the Event was created.
   *
   * Uses performance.now() when available, otherwise Date.now().
   *
   * ```typescript no_run
   * const event = new Event('x');
   * typeof event.timeStamp; // "number"
   * ```
   */
  get timeStamp()        { return _eventState.get(this)!.timeStamp; }

  /**
   * Whether the event was generated by the runtime rather than user code.
   *
   * Events created with `new Event(...)` are untrusted. Built-in APIs may mark
   * their own spec-defined events as trusted before dispatch.
   *
   * ```typescript no_run
   * new Event('x').isTrusted; // false
   * ```
   */
  get isTrusted()        { return getEventIsTrusted.call(this); }

  /**
   * Mark a cancelable event as default-prevented.
   *
   * Calling this on a non-cancelable event or from a passive listener has no
   * effect.
   *
   * ```typescript no_run
   * const event = new Event('x', { cancelable: true });
   * event.preventDefault();
   * ```
   */
  preventDefault() {
    const s = _eventState.get(this)!;
    if (s.cancelable && !s.inPassiveListener) s.defaultPrevented = true;
  }

  /**
   * Request that event propagation stop after the current target.
   *
   * With flat dispatch this flag is stored for compatibility but there are no
   * ancestor targets to skip.
   *
   * ```typescript no_run
   * const event = new Event('x');
   * event.stopPropagation();
   * ```
   */
  stopPropagation() {
    _eventState.get(this)!.stopPropagation = true;
  }

  /**
   * Stop dispatching any remaining listeners for this event.
   *
   * During dispatch this prevents later listeners on the same EventTarget from
   * running.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * target.addEventListener('x', (event) => event.stopImmediatePropagation());
   * ```
   */
  stopImmediatePropagation() {
    const s = _eventState.get(this)!;
    s.stopPropagation = true;
    s.stopImmediate = true;
  }

  /**
   * Return the composed path for this event.
   *
   * Because there is no DOM tree, the path is `[target]` while dispatching and
   * an empty array outside dispatch.
   *
   * ```typescript no_run
   * const event = new Event('x');
   * event.composedPath(); // []
   * ```
   */
  composedPath() {
    const s = _eventState.get(this)!;
    return s.dispatch && s.target != null ? [s.target] : [];
  }
}

/**
 * Create an event that represents runtime-generated platform behavior.
 *
 * User-created `new Event(...)` objects remain untrusted. This helper is for
 * built-in globals that must dispatch spec-defined trusted events, such as the
 * `abort` event produced by AbortController.
 *
 * @internal
 */
export function _createTrustedEvent(type: string, eventInitDict?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean }): Event {
  const event = new Event(type, eventInitDict);
  _eventState.get(event)!.trusted = true;
  return event;
}

/**
 * Mark a platform-created event object as trusted before dispatch.
 *
 * Use this for built-in event subclasses, such as `MessageEvent`, that are
 * created internally by a web API rather than by user code.
 *
 * @internal
 */
export function _markEventTrusted(event: Event): void {
  _eventState.get(event)!.trusted = true;
}

// Phase constants on prototype (spec requires instance access via event.NONE etc.)
const eventPrototype = Event.prototype as Event & {
  NONE: number;
  CAPTURING_PHASE: number;
  AT_TARGET: number;
  BUBBLING_PHASE: number;
  initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
};

eventPrototype.NONE = 0;
eventPrototype.CAPTURING_PHASE = 1;
eventPrototype.AT_TARGET = 2;
eventPrototype.BUBBLING_PHASE = 3;

// Legacy methods
/**
 * Reinitialize an event before it is dispatched.
 *
 * Calls during dispatch are ignored. The composed flag is not part of the
 * legacy method and remains unchanged.
 *
 * ```typescript no_run
 * const event = new Event('old');
 * event.initEvent('new', false, true);
 * ```
 */
eventPrototype.initEvent = function initEvent(type: string, bubbles: boolean = false, cancelable: boolean = false): void {
  const s = _eventState.get(this);
  if (!s || s.dispatch) return; // no-op if currently dispatching
  s.type = String(type);
  s.bubbles = Boolean(bubbles);
  s.cancelable = Boolean(cancelable);
  s.defaultPrevented = false;
  s.stopPropagation = false;
  s.stopImmediate = false;
  s.target = null;
};

Object.defineProperty(Event.prototype, 'cancelBubble', {
  get() { return _eventState.get(this as Event)!.stopPropagation; },
  set(v) { if (v) this.stopPropagation(); },
  configurable: true,
});

Object.defineProperty(Event.prototype, 'returnValue', {
  get() { return !_eventState.get(this as Event)!.defaultPrevented; },
  set(v) { if (!v) this.preventDefault(); },
  configurable: true,
});

Object.defineProperty(Event.prototype, 'srcElement', {
  get() { return _eventState.get(this as Event)!.target; },
  configurable: true,
});

// ---------------------------------------------------------------------------
// CustomEvent
// ---------------------------------------------------------------------------

/**
 * Event subclass that carries arbitrary detail data.
 *
 * The detail value defaults to null and is stored by reference.
 *
 * ```typescript no_run
 * const event = new CustomEvent('data', { detail: { id: 1 } });
 * event.detail.id; // 1
 * ```
 */
export class CustomEvent extends Event {
  /**
   * Private property `#detail` used by `CustomEvent`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #detail = undefined;
   *
   *   readInternalState() {
   *     return this.#detail;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #detail: unknown;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new CustomEvent('x')); // "[object CustomEvent]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'CustomEvent'; }

  /**
   * Create a CustomEvent with optional detail.
   *
   * Event flags are passed through to Event. Missing detail becomes null.
   *
   * ```typescript no_run
   * const event = new CustomEvent('x', { detail: 'payload' });
   * event.detail; // "payload"
   * ```
   */
  constructor(type: string, eventInitDict?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean; detail?: unknown }) {
    super(type, eventInitDict);
    this.#detail = eventInitDict?.detail ?? null;
  }

  /**
   * Application-defined payload for the custom event.
   *
   * ```typescript no_run
   * new CustomEvent('x').detail; // null
   * ```
   */
  get detail() { return this.#detail; }

  /**
   * Legacy initializer for CustomEvent instances.
   *
   * Calls during dispatch are ignored. The method updates type, bubbles,
   * cancelable, and detail.
   *
   * ```typescript no_run
   * const event = new CustomEvent('old');
   * event.initCustomEvent('new', false, false, 123);
   * ```
   */
  initCustomEvent(type: string, bubbles: boolean = false, cancelable: boolean = false, detail: unknown = null): void {
    const s = _eventState.get(this);
    if (!s || s.dispatch) return; // no-op if currently dispatching
    eventPrototype.initEvent.call(this, type, bubbles, cancelable);
    this.#detail = detail;
  }
}

// ---------------------------------------------------------------------------
// EventTarget
// ---------------------------------------------------------------------------

/**
 * WHATWG EventTarget with flat listener dispatch.
 *
 * Listener registration is idempotent for the same callback and capture flag.
 * Listener exceptions are swallowed so later listeners still run; this runtime
 * does not surface those exceptions through a global error event.
 *
 * ```typescript no_run
 * const target = new EventTarget();
 * target.addEventListener('ready', () => console.log('ready'));
 * target.dispatchEvent(new Event('ready'));
 * ```
 */
export class EventTarget {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new EventTarget()); // "[object EventTarget]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'EventTarget'; }

  /**
   * Create an EventTarget with an empty listener registry.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * ```
   */
  constructor() {
    _listeners.set(this, new Map());
  }

  /**
   * Register an event listener.
   *
   * Null callbacks and objects without handleEvent are ignored. The once option
   * removes a listener after its first call, passive prevents default
   * cancellation, and signal removes the listener when aborted.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * target.addEventListener('tick', (event) => console.log(event.type), { once: true });
   * ```
   */
  addEventListener(type: string, callback: EventCallback | null, options?: boolean | AddEventListenerOptions): void {
    const t = String(type);
    const { capture, once, passive } = normalizeOptions(options);
    const signal = (options != null && typeof options === 'object') ? options.signal : undefined;

    if (signal === null) {
      throw new TypeError('addEventListener: signal must be an AbortSignal');
    }
    if (callback === null) return;
    if (typeof callback !== 'function' && typeof (callback as any)?.handleEvent !== 'function') return;

    // If the signal is already aborted, skip adding the listener.
    if (signal != null && signal.aborted) return;

    const listenersMap = _listeners.get(this)!;
    let list = listenersMap.get(t);
    if (list == null) {
      list = [];
      listenersMap.set(t, list);
    }

    // Idempotent: same (callback, capture) pair is not added twice.
    for (let i = 0; i < list.length; i++) {
      if (!list[i]!.removed && list[i]!.callback === callback && list[i]!.capture === capture) {
        return;
      }
    }

    const record = { callback, capture, once, passive, removed: false };
    list.push(record);

    // Auto-remove when the provided signal aborts.
    if (signal != null) {
      const self = this;
      signal.addEventListener('abort', function () {
        self.removeEventListener(t, callback, { capture });
      }, { once: true });
    }
  }

  /**
   * Remove a previously registered event listener.
   *
   * The type, callback, and capture flag must match the original registration.
   * Unknown listeners are ignored.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * const fn = () => {};
   * target.addEventListener('x', fn);
   * target.removeEventListener('x', fn);
   * ```
   */
  removeEventListener(type: string, callback: EventCallback, options?: boolean | { capture?: boolean }): void {
    const t = String(type);
    const capture = normalizeCapture(options);
    const listenersMap = _listeners.get(this)!;
    const list = listenersMap.get(t);
    if (list == null) return;
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.callback === callback && list[i]!.capture === capture && !list[i]!.removed) {
        list[i]!.removed = true;
        list.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Dispatch an Event synchronously to matching listeners.
   *
   * The argument must be an Event instance and cannot already be dispatching.
   * Returns false only when a cancelable event was canceled.
   *
   * ```typescript no_run
   * const target = new EventTarget();
   * const ok = target.dispatchEvent(new Event('x', { cancelable: true }));
   * ```
   */
  dispatchEvent(event: Event): boolean {
    const s = _eventState.get(event);
    if (s == null) throw new TypeError('Argument must be an Event instance');
    if (s.dispatch) {
      const err = new Error('The event is already being dispatched.');
      err.name = 'InvalidStateError';
      throw err;
    }

    s.dispatch = true;
    s.target = this;
    s.currentTarget = this;
    s.eventPhase = Event.AT_TARGET;

    const propertyHandler = (this as any)[`on${s.type}`];
    if (typeof propertyHandler === 'function') {
      try { propertyHandler.call(this, event); } catch (_) {}
    }

    const listenersMap = _listeners.get(this)!;
    const list = listenersMap.get(s.type);
    if (list != null && list.length > 0) {
      // Snapshot before iteration so mutations during dispatch don't affect order.
      const snapshot = list.slice();
      for (let i = 0; i < snapshot.length; i++) {
        const lr = snapshot[i]!;
        if (lr.removed) continue;

        if (lr.once) {
          // Mark removed and splice from live list before invoking, so the
          // callback cannot re-add the same listener and trigger its removal
          // again by another path.
          lr.removed = true;
          const idx = list.indexOf(lr);
          if (idx >= 0) list.splice(idx, 1);
        }

        if (lr.passive) s.inPassiveListener = true;
        try {
          if (typeof lr.callback === 'function') {
            lr.callback.call(this, event);
          } else {
            (lr.callback as any).handleEvent(event);
          }
        } catch (_) {}
        if (lr.passive) s.inPassiveListener = false;

        if (s.stopImmediate) break;
      }
    }

    s.dispatch = false;
    // target is preserved after dispatch (browsers keep it set)
    s.currentTarget = null;
    s.eventPhase = Event.NONE;
    s.stopPropagation = false;
    s.stopImmediate = false;

    return !s.defaultPrevented;
  }
}
