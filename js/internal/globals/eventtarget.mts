/**
 * fino:eventtarget — Event, CustomEvent, and EventTarget
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
 *   - Listener errors do not prevent subsequent listeners from firing
 *
 * @internal
 */

// ---------------------------------------------------------------------------
// Internal state WeakMaps
// ---------------------------------------------------------------------------

interface EventState {
  type: string; bubbles: boolean; cancelable: boolean; composed: boolean;
  defaultPrevented: boolean; target: EventTarget | null; currentTarget: EventTarget | null;
  eventPhase: number; dispatch: boolean; stopPropagation: boolean;
  stopImmediate: boolean; inPassiveListener: boolean; timeStamp: number;
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

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

export class Event {
  static NONE            = 0;
  static CAPTURING_PHASE = 1;
  static AT_TARGET       = 2;
  static BUBBLING_PHASE  = 3;

  get [Symbol.toStringTag]() { return 'Event'; }

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
    });
  }

  get type()             { return _eventState.get(this)!.type; }
  get bubbles()          { return _eventState.get(this)!.bubbles; }
  get cancelable()       { return _eventState.get(this)!.cancelable; }
  get composed()         { return _eventState.get(this)!.composed; }
  get defaultPrevented() { return _eventState.get(this)!.defaultPrevented; }
  get target()           { return _eventState.get(this)!.target; }
  get currentTarget()    { return _eventState.get(this)!.currentTarget; }
  get eventPhase()       { return _eventState.get(this)!.eventPhase; }
  get timeStamp()        { return _eventState.get(this)!.timeStamp; }
  get isTrusted()        { return false; }

  preventDefault() {
    const s = _eventState.get(this)!;
    if (s.cancelable && !s.inPassiveListener) s.defaultPrevented = true;
  }

  stopPropagation() {
    _eventState.get(this)!.stopPropagation = true;
  }

  stopImmediatePropagation() {
    const s = _eventState.get(this)!;
    s.stopPropagation = true;
    s.stopImmediate = true;
  }

  composedPath() {
    const s = _eventState.get(this)!;
    return s.target != null ? [s.target] : [];
  }
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

export class CustomEvent extends Event {
  #detail: unknown;

  get [Symbol.toStringTag]() { return 'CustomEvent'; }

  constructor(type: string, eventInitDict?: { bubbles?: boolean; cancelable?: boolean; composed?: boolean; detail?: unknown }) {
    super(type, eventInitDict);
    this.#detail = eventInitDict?.detail ?? null;
  }

  get detail() { return this.#detail; }

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

export class EventTarget {
  get [Symbol.toStringTag]() { return 'EventTarget'; }

  constructor() {
    _listeners.set(this, new Map());
  }

  addEventListener(type: string, callback: EventCallback | null, options?: boolean | AddEventListenerOptions): void {
    if (callback === null) return;
    if (typeof callback !== 'function' && typeof (callback as any)?.handleEvent !== 'function') return;
    const t = String(type);
    const { capture, once, passive } = normalizeOptions(options);
    const signal = (options != null && typeof options === 'object') ? options.signal : undefined;

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

  removeEventListener(type: string, callback: EventCallback, options?: boolean | { capture?: boolean }): void {
    const t = String(type);
    const { capture } = normalizeOptions(options);
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
