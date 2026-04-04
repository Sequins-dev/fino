import { describe, it } from 'fino:test/test';

type EventConstructorWithConstants = typeof Event & {
  NONE: number;
  CAPTURING_PHASE: number;
  AT_TARGET: number;
  BUBBLING_PHASE: number;
};
type SymbolRecord = Record<symbol, unknown>;

const { Event, CustomEvent, EventTarget } = globalThis;

describe('Event', () => {
  it('basic properties', (t) => {
    const e = new Event('click');
    t.equal(e.type, 'click', 'type');
    t.equal(e.bubbles, false, 'bubbles defaults false');
    t.equal(e.cancelable, false, 'cancelable defaults false');
    t.equal(e.composed, false, 'composed defaults false');
    t.equal(e.defaultPrevented, false, 'defaultPrevented starts false');
    t.equal(e.target, null, 'target starts null');
    t.equal(e.currentTarget, null, 'currentTarget starts null');
    t.equal(e.eventPhase, Event.NONE, 'eventPhase starts NONE');
    t.equal(e.isTrusted, false, 'isTrusted is always false');
    t.ok(typeof e.timeStamp === 'number', 'timeStamp is a number');
  });

  it('eventInitDict', (t) => {
    const e = new Event('submit', { bubbles: true, cancelable: true, composed: true });
    t.equal(e.bubbles, true, 'bubbles');
    t.equal(e.cancelable, true, 'cancelable');
    t.equal(e.composed, true, 'composed');
  });

  it('static phase constants', (t) => {
    t.equal(Event.NONE, 0, 'NONE = 0');
    t.equal(Event.CAPTURING_PHASE, 1, 'CAPTURING_PHASE = 1');
    t.equal(Event.AT_TARGET, 2, 'AT_TARGET = 2');
    t.equal(Event.BUBBLING_PHASE, 3, 'BUBBLING_PHASE = 3');
  });

  it('preventDefault on cancelable event', (t) => {
    const e = new Event('click', { cancelable: true });
    e.preventDefault();
    t.equal(e.defaultPrevented, true, 'defaultPrevented set');
  });

  it('preventDefault on non-cancelable event is a no-op', (t) => {
    const e = new Event('click');
    e.preventDefault();
    t.equal(e.defaultPrevented, false, 'defaultPrevented stays false');
  });

  it('stopPropagation', (t) => {
    const e = new Event('click');
    // Just verifies it doesn't throw; effect is tested in dispatchEvent tests.
    e.stopPropagation();
    t.ok(true, 'no throw');
  });

  it('composedPath returns empty array outside dispatch', (t) => {
    const e = new Event('click');
    t.deepEqual(e.composedPath(), [], 'empty outside dispatch');
  });
});

describe('CustomEvent', () => {
  it('detail property', (t) => {
    const e = new CustomEvent('custom', { detail: { foo: 42 } });
    t.equal(e.type, 'custom', 'type inherited');
    t.deepEqual(e.detail, { foo: 42 }, 'detail set');
  });

  it('detail defaults to null', (t) => {
    const e = new CustomEvent('custom');
    t.equal(e.detail, null, 'detail null');
  });

  it('is instance of Event', (t) => {
    const e = new CustomEvent('custom');
    t.ok(e instanceof Event, 'instanceof Event');
    t.ok(e instanceof CustomEvent, 'instanceof CustomEvent');
  });
});

describe('addEventListener / removeEventListener', () => {
  it('addEventListener and dispatch', (t) => {
    const target = new EventTarget();
    let called = false;
    target.addEventListener('test', () => { called = true; });
    target.dispatchEvent(new Event('test'));
    t.ok(called, 'listener was called');
  });

  it('listener not called for different event type', (t) => {
    const target = new EventTarget();
    let called = false;
    target.addEventListener('foo', () => { called = true; });
    target.dispatchEvent(new Event('bar'));
    t.equal(called, false, 'not called');
  });

  it('removeEventListener prevents callback', (t) => {
    const target = new EventTarget();
    let count = 0;
    const fn = () => { count++; };
    target.addEventListener('test', fn);
    target.removeEventListener('test', fn);
    target.dispatchEvent(new Event('test'));
    t.equal(count, 0, 'not called after removal');
  });

  it('addEventListener is idempotent (same callback+capture)', (t) => {
    const target = new EventTarget();
    let count = 0;
    const fn = () => { count++; };
    target.addEventListener('test', fn);
    target.addEventListener('test', fn); // duplicate — should be ignored
    target.dispatchEvent(new Event('test'));
    t.equal(count, 1, 'called exactly once');
  });

  it('non-function callback is silently ignored', (t) => {
    const target = new EventTarget();
    target.addEventListener('test', 'not a function' as unknown as EventListener);
    target.dispatchEvent(new Event('test')); // should not throw
    t.ok(true, 'no throw');
  });

  it('multiple listeners for same event', (t) => {
    const target = new EventTarget();
    const results: number[] = [];
    target.addEventListener('test', () => results.push(1));
    target.addEventListener('test', () => results.push(2));
    target.addEventListener('test', () => results.push(3));
    target.dispatchEvent(new Event('test'));
    t.deepEqual(results, [1, 2, 3], 'all called in order');
  });

  it('listener error does not prevent subsequent listeners', (t) => {
    const target = new EventTarget();
    let secondCalled = false;
    target.addEventListener('test', () => { throw new Error('oops'); });
    target.addEventListener('test', () => { secondCalled = true; });
    target.dispatchEvent(new Event('test'));
    t.ok(secondCalled, 'second listener still called');
  });
});

describe('once / stopImmediatePropagation / signal / passive options', () => {
  it('once option — fires once then auto-removes', (t) => {
    const target = new EventTarget();
    let count = 0;
    target.addEventListener('test', () => { count++; }, { once: true });
    target.dispatchEvent(new Event('test'));
    target.dispatchEvent(new Event('test'));
    t.equal(count, 1, 'called exactly once');
  });

  it('stopImmediatePropagation halts remaining listeners', (t) => {
    const target = new EventTarget();
    const results: number[] = [];
    target.addEventListener('test', (e) => { results.push(1); e.stopImmediatePropagation(); });
    target.addEventListener('test', () => { results.push(2); });
    target.dispatchEvent(new Event('test'));
    t.deepEqual(results, [1], 'only first listener called');
  });

  it('signal option auto-removes listener when signal aborts', async (t) => {
    const { AbortController } = globalThis;
    const controller = new AbortController();
    const target = new EventTarget();
    let count = 0;
    target.addEventListener('test', () => { count++; }, { signal: controller.signal });
    target.dispatchEvent(new Event('test')); // fires
    controller.abort();
    target.dispatchEvent(new Event('test')); // should not fire
    t.equal(count, 1, 'only fired before abort');
  });

  it('signal already aborted — listener is never added', async (t) => {
    const { AbortSignal } = globalThis;
    const signal = AbortSignal.abort();
    const target = new EventTarget();
    let called = false;
    target.addEventListener('test', () => { called = true; }, { signal });
    target.dispatchEvent(new Event('test'));
    t.equal(called, false, 'listener never added');
  });

  it('passive listener — preventDefault has no effect', (t) => {
    const target = new EventTarget();
    target.addEventListener('test', (e) => e.preventDefault(), { passive: true });
    const result = target.dispatchEvent(new Event('test', { cancelable: true }));
    t.equal(result, true, 'event not cancelled inside passive listener');
  });
});

describe('event properties during dispatch', () => {
  it('event.target and event.currentTarget set during dispatch', (t) => {
    const target = new EventTarget();
    let capturedTarget = null;
    let capturedCurrent = null;
    let capturedPhase = null;
    target.addEventListener('test', (e) => {
      capturedTarget = e.target;
      capturedCurrent = e.currentTarget;
      capturedPhase = e.eventPhase;
    });
    target.dispatchEvent(new Event('test'));
    t.ok(capturedTarget === target, 'target is the EventTarget');
    t.ok(capturedCurrent === target, 'currentTarget is the EventTarget');
    t.equal(capturedPhase, Event.AT_TARGET, 'eventPhase is AT_TARGET');
  });

  it('event.target preserved after dispatch, currentTarget is null', (t) => {
    const target = new EventTarget();
    const e = new Event('test');
    target.dispatchEvent(e);
    t.ok(e.target === target, 'target preserved after dispatch');
    t.equal(e.currentTarget, null, 'currentTarget null after dispatch');
  });

  it('composedPath returns [target] during dispatch', (t) => {
    const target = new EventTarget();
    let path: unknown = null;
    target.addEventListener('test', (e) => { path = e.composedPath(); });
    target.dispatchEvent(new Event('test'));
    const composedPath = path as EventTarget[];
    t.ok(Array.isArray(composedPath) && composedPath.length === 1 && composedPath[0] === target, 'composedPath = [target]');
  });
});

describe('dispatchEvent', () => {
  it('returns true when not cancelled', (t) => {
    const target = new EventTarget();
    const result = target.dispatchEvent(new Event('test'));
    t.equal(result, true, 'returns true');
  });

  it('returns false when cancelled', (t) => {
    const target = new EventTarget();
    target.addEventListener('test', (e) => e.preventDefault());
    const result = target.dispatchEvent(new Event('test', { cancelable: true }));
    t.equal(result, false, 'returns false');
  });

  it('dispatching an event already in dispatch throws', (t) => {
    const target = new EventTarget();
    target.addEventListener('test', () => {
      // try to re-dispatch the same event while it's being dispatched
    });
    const e = new Event('test');
    let threw = false;
    target.addEventListener('test', (innerEvent) => {
      try {
        target.dispatchEvent(innerEvent); // same object, currently dispatched
        threw = false;
      } catch (_) {
        threw = true;
      }
    });
    target.dispatchEvent(e);
    t.ok(threw, 'threw on re-dispatch of in-flight event');
  });
});

describe('handleEvent object listeners', () => {
  it('object with handleEvent method is called as a listener', (t) => {
    const target = new EventTarget();
    let received: Event | null = null;
    const handler = {
      handleEvent(e: Event) { received = e; },
    };
    target.addEventListener('test', handler);
    const evt = new Event('test');
    target.dispatchEvent(evt);
    t.ok(received === evt, 'handleEvent was called with the event');
  });

  it('object with handleEvent is deduplicated by same (object, capture) pair', (t) => {
    const target = new EventTarget();
    let count = 0;
    const handler = { handleEvent() { count++; } };
    target.addEventListener('test', handler);
    target.addEventListener('test', handler); // duplicate — should be ignored
    target.dispatchEvent(new Event('test'));
    t.equal(count, 1, 'handleEvent called exactly once');
  });
});

describe('null callback', () => {
  it('addEventListener with null callback is silently ignored', (t) => {
    const target = new EventTarget();
    target.addEventListener('test', null); // should not throw
    target.dispatchEvent(new Event('test')); // should not throw
    t.ok(true, 'no throw with null callback');
  });
});

describe('capture flag creates separate listener registrations', () => {
  it('same callback with capture:true and capture:false adds two listeners', (t) => {
    const target = new EventTarget();
    let count = 0;
    const fn = () => { count++; };
    target.addEventListener('test', fn, { capture: false });
    target.addEventListener('test', fn, { capture: true });
    target.dispatchEvent(new Event('test'));
    t.equal(count, 2, 'both capture and bubble listeners fired');
  });
});

describe('stopPropagation vs stopImmediatePropagation', () => {
  it('stopPropagation does NOT stop same-target listeners (only stopImmediatePropagation does)', (t) => {
    const target = new EventTarget();
    const results: number[] = [];
    target.addEventListener('test', (e) => { results.push(1); e.stopPropagation(); });
    target.addEventListener('test', () => { results.push(2); });
    target.dispatchEvent(new Event('test'));
    t.deepEqual(results, [1, 2], 'both listeners fired despite stopPropagation');
  });
});

describe('snapshot semantics during dispatch', () => {
  it('listener added during dispatch does not fire in same dispatch', (t) => {
    const target = new EventTarget();
    let addedFired = false;
    target.addEventListener('test', () => {
      // Add a new listener during dispatch
      target.addEventListener('test', () => { addedFired = true; });
    });
    target.dispatchEvent(new Event('test'));
    t.equal(addedFired, false, 'newly added listener did not fire in current dispatch');
    // But it should fire on the next dispatch
    target.dispatchEvent(new Event('test'));
    t.equal(addedFired, true, 'fires on next dispatch');
  });

  it('listener removed during dispatch does not fire in same dispatch', (t) => {
    const target = new EventTarget();
    const results: number[] = [];
    const fn2 = () => { results.push(2); };
    target.addEventListener('test', () => {
      results.push(1);
      target.removeEventListener('test', fn2);
    });
    target.addEventListener('test', fn2);
    target.dispatchEvent(new Event('test'));
    t.equal(results.length, 1, 'second listener was removed before it fired');
    t.equal(results[0], 1, 'first listener fired');
  });
});

describe('once + signal interaction', () => {
  it('once listener with signal: listener fires once and is cleaned up', (t) => {
    const ctrl = new AbortController();
    const target = new EventTarget();
    let count = 0;
    target.addEventListener('test', () => { count++; }, { once: true, signal: ctrl.signal });
    target.dispatchEvent(new Event('test')); // fires and auto-removes
    target.dispatchEvent(new Event('test')); // should NOT fire
    t.equal(count, 1, 'only fired once');
  });

  it('signal abort removes listener before it fires', (t) => {
    const ctrl = new AbortController();
    const target = new EventTarget();
    let count = 0;
    target.addEventListener('test', () => { count++; }, { once: true, signal: ctrl.signal });
    ctrl.abort();
    target.dispatchEvent(new Event('test')); // listener already removed
    t.equal(count, 0, 'listener removed by abort before dispatch');
  });
});

describe('handleEvent throws — other listeners still fire', () => {
  it('handleEvent method that throws does not prevent subsequent listeners', (t) => {
    const target = new EventTarget();
    let secondFired = false;
    const handler = {
      handleEvent() { throw new Error('handler error'); },
    };
    target.addEventListener('test', handler);
    target.addEventListener('test', () => { secondFired = true; });
    target.dispatchEvent(new Event('test'));
    t.ok(secondFired, 'second listener fired despite handleEvent throwing');
  });
});

describe('dispatchEvent return value with no listeners', () => {
  it('dispatchEvent returns true when no listeners are registered', (t) => {
    const target = new EventTarget();
    const result = target.dispatchEvent(new Event('no-listeners'));
    t.equal(result, true, 'returns true with no listeners');
  });
});

describe('removeEventListener — never-added callback is a no-op', () => {
  it('removeEventListener with callback that was never added does not throw', (t) => {
    const target = new EventTarget();
    const fn = () => {};
    let threw = false;
    try {
      target.removeEventListener('test', fn);
    } catch (_) {
      threw = true;
    }
    t.equal(threw, false, 'no throw for never-added callback');
  });
});

describe('Event() with no arguments', () => {
  it('Event() with no arguments throws TypeError per spec', (t) => {
    const EventCtor = Event as unknown as { new (): Event };
    t.throws(() => new EventCtor(), /argument required/, 'no-arg Event() throws TypeError');
  });
});

describe('CustomEvent — full init options', () => {
  it('bubbles, cancelable, composed, and detail are all set correctly', (t) => {
    const e = new CustomEvent('my-event', {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: { key: 'value' },
    });
    t.equal(e.bubbles, true, 'bubbles');
    t.equal(e.cancelable, true, 'cancelable');
    t.equal(e.composed, true, 'composed');
    t.deepEqual(e.detail, { key: 'value' }, 'detail');
  });
});

describe('Event static phase constants via constructor reference', () => {
  it('phase constants are accessible via the constructor on an instance', (t) => {
    const e = new Event('test');
    const ctor = e.constructor as EventConstructorWithConstants;
    // Static fields live on the class (constructor), not on instances.
    // Access them via e.constructor (same as Event itself).
    t.equal(ctor.NONE, 0, 'constructor.NONE === 0');
    t.equal(ctor.AT_TARGET, 2, 'constructor.AT_TARGET === 2');
    t.equal(ctor.CAPTURING_PHASE, 1, 'constructor.CAPTURING_PHASE === 1');
    t.equal(ctor.BUBBLING_PHASE, 3, 'constructor.BUBBLING_PHASE === 3');
  });
});

describe('Symbol.toStringTag', () => {
  it('EventTarget [Symbol.toStringTag] is "EventTarget"', (t) => {
    const target = new EventTarget();
    t.equal((target as unknown as SymbolRecord)[Symbol.toStringTag], 'EventTarget', 'toStringTag is EventTarget');
  });

  it('Event [Symbol.toStringTag] is "Event"', (t) => {
    const e = new Event('test');
    t.equal((e as unknown as SymbolRecord)[Symbol.toStringTag], 'Event', 'toStringTag is Event');
  });

  it('CustomEvent [Symbol.toStringTag] is "CustomEvent"', (t) => {
    const e = new CustomEvent('test');
    t.equal((e as unknown as SymbolRecord)[Symbol.toStringTag], 'CustomEvent', 'toStringTag is CustomEvent');
  });
});

describe('Event phase constants on prototype', () => {
  it('instance can access NONE via event.NONE', (t) => {
    const e = new Event('test');
    t.equal(e.NONE, 0, 'event.NONE === 0');
    t.equal(e.CAPTURING_PHASE, 1, 'event.CAPTURING_PHASE === 1');
    t.equal(e.AT_TARGET, 2, 'event.AT_TARGET === 2');
    t.equal(e.BUBBLING_PHASE, 3, 'event.BUBBLING_PHASE === 3');
  });
});

describe('Event.timeStamp', () => {
  it('timeStamp is a number >= 0', (t) => {
    const e = new Event('test');
    t.ok(typeof e.timeStamp === 'number', 'is a number');
    t.ok(e.timeStamp >= 0, 'is non-negative');
  });
});

describe('Event legacy methods', () => {
  it('initEvent re-initializes type, bubbles, cancelable', (t) => {
    const e = new Event('click', { bubbles: true, cancelable: true });
    e.initEvent('change', false, false);
    t.equal(e.type, 'change', 'type updated');
    t.equal(e.bubbles, false, 'bubbles updated');
    t.equal(e.cancelable, false, 'cancelable updated');
  });

  it('cancelBubble getter returns stopPropagation state', (t) => {
    const e = new Event('test');
    t.equal((e as any).cancelBubble, false, 'initially false');
    (e as any).cancelBubble = true;
    t.equal((e as any).cancelBubble, true, 'true after setting');
  });

  it('returnValue getter reflects defaultPrevented (inverted)', (t) => {
    const e = new Event('test', { cancelable: true });
    t.equal((e as any).returnValue, true, 'initially true (not prevented)');
    e.preventDefault();
    t.equal((e as any).returnValue, false, 'false after preventDefault');
  });

  it('srcElement is an alias for target', (t) => {
    const et = new EventTarget();
    let src;
    et.addEventListener('test', (ev) => { src = (ev as any).srcElement; });
    et.dispatchEvent(new Event('test'));
    t.ok(src === et, 'srcElement equals target during dispatch');
  });
});

describe('CustomEvent.initCustomEvent', () => {
  it('re-initializes type, bubbles, cancelable, and detail', (t) => {
    const ce = new CustomEvent<unknown>('click', { bubbles: true, detail: 42 });
    ce.initCustomEvent('change', false, false, 'newDetail');
    t.equal(ce.type, 'change', 'type updated');
    t.equal(ce.bubbles, false, 'bubbles updated');
    t.equal(ce.detail, 'newDetail', 'detail updated');
  });
});

describe('dispatchEvent with non-Event argument', () => {
  it('throws TypeError when argument is not an Event', (t) => {
    const et = new EventTarget();
    t.throws(() => et.dispatchEvent({} as any), undefined, 'plain object throws');
  });
});

describe('removeEventListener with mismatched capture flag', () => {
  it('does not remove listener when capture flag differs', (t) => {
    const et = new EventTarget();
    let count = 0;
    const fn = () => { count++; };
    et.addEventListener('test', fn, { capture: false });
    et.removeEventListener('test', fn, true); // wrong capture flag
    et.dispatchEvent(new Event('test'));
    t.equal(count, 1, 'listener still fires (capture flag mismatch)');
  });
});

describe('handleEvent removal via removeEventListener', () => {
  it('removes object listener with handleEvent', (t) => {
    const et = new EventTarget();
    let count = 0;
    const obj = { handleEvent() { count++; } };
    et.addEventListener('test', obj);
    et.removeEventListener('test', obj);
    et.dispatchEvent(new Event('test'));
    t.equal(count, 0, 'object listener was removed');
  });
});

describe('passive + once interaction', () => {
  it('once listener with passive:true fires once and preventDefault is blocked', (t) => {
    const et = new EventTarget();
    let fired = 0;
    let prevented = false;
    et.addEventListener('test', (e) => {
      fired++;
      e.preventDefault();
      prevented = e.defaultPrevented;
    }, { passive: true, once: true });
    et.dispatchEvent(new Event('test', { cancelable: true }));
    et.dispatchEvent(new Event('test', { cancelable: true }));
    t.equal(fired, 1, 'listener fired only once');
    t.equal(prevented, false, 'preventDefault blocked by passive');
  });
});

describe('Event.initEvent', () => {
  it('initEvent is a no-op during dispatch', (t) => {
    const et = new EventTarget();
    let observedType = '';
    et.addEventListener('original', (e) => {
      e.initEvent('changed', false, false);
      observedType = e.type;
    });
    et.dispatchEvent(new Event('original'));
    // Per spec, initEvent during dispatch should be a no-op
    t.equal(observedType, 'original', 'type unchanged by initEvent during dispatch');
  });
});

describe('Event.returnValue and cancelBubble setters', () => {
  it('returnValue = false calls preventDefault', (t) => {
    const et = new EventTarget();
    let prevented = false;
    et.addEventListener('test', (e) => {
      e.returnValue = false;
      prevented = e.defaultPrevented;
    });
    et.dispatchEvent(new Event('test', { cancelable: true }));
    t.equal(prevented, true, 'returnValue=false triggers preventDefault');
  });

  it('returnValue = true is a no-op', (t) => {
    const et = new EventTarget();
    let prevented = false;
    et.addEventListener('test', (e) => {
      e.returnValue = true; // should be no-op
      prevented = e.defaultPrevented;
    });
    et.dispatchEvent(new Event('test', { cancelable: true }));
    t.equal(prevented, false, 'returnValue=true does not call preventDefault');
  });

  it('cancelBubble = true sets stop propagation flag', (t) => {
    const et = new EventTarget();
    let propagationStopped = false;
    et.addEventListener('test', (e) => {
      e.cancelBubble = true;
      // In flat dispatch, stopPropagation only affects bubbling/capturing; flag is still set
      propagationStopped = e.cancelBubble;
    });
    et.dispatchEvent(new Event('test'));
    t.equal(propagationStopped, true, 'cancelBubble getter returns true after setter');
  });
});

describe('initEvent() resets target to null', () => {
  it('target is null after initEvent() is called outside dispatch', (t) => {
    const et = new EventTarget();
    let capturedEvent: Event | null = null;
    et.addEventListener('click', (e) => { capturedEvent = e; });
    et.dispatchEvent(new Event('click'));
    t.ok(capturedEvent !== null, 'event was received');
    // After dispatch, target remains set; but calling initEvent re-initializes
    capturedEvent!.initEvent('reset');
    t.equal(capturedEvent!.target, null, 'target is null after initEvent()');
  });
});

describe('initCustomEvent() is a no-op during dispatch', () => {
  it('initCustomEvent() during dispatch does not change detail', (t) => {
    const et = new EventTarget();
    const ev = new CustomEvent('custom', { detail: 'original' });
    et.addEventListener('custom', () => {
      ev.initCustomEvent('custom', false, false, 'mutated');
    });
    et.dispatchEvent(ev);
    // After dispatch, detail should still be 'original' since initCustomEvent is no-op during dispatch
    t.equal(ev.detail, 'original', 'detail unchanged by initCustomEvent during dispatch');
  });
});
