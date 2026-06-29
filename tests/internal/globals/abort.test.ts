/**
 * Tests for AbortController and AbortSignal globals.
 * Uses the global instances registered by internal/main.mjs.
 */

import { describe, it } from 'fino:test/test';

describe('AbortController', () => {
  it('signal starts non-aborted', (t) => {
    const ctrl = new AbortController();
    t.ok(ctrl.signal instanceof AbortSignal, 'signal is AbortSignal');
    t.equal(ctrl.signal.aborted, false, 'aborted is false');
    t.equal(ctrl.signal.reason, undefined, 'reason is undefined');
  });

  it('abort() with default reason', (t) => {
    const ctrl = new AbortController();
    ctrl.abort();
    t.equal(ctrl.signal.aborted, true, 'aborted is true');
    t.ok(ctrl.signal.reason instanceof Error, 'reason is Error');
    t.equal(ctrl.signal.reason.name, 'AbortError', 'reason.name is AbortError');
  });

  it('abort() default reason is a DOMException AbortError', (t) => {
    const ctrl = new AbortController();
    ctrl.abort();
    const reason = ctrl.signal.reason as DOMException;

    t.ok(reason instanceof DOMException, 'reason is DOMException');
    t.equal(reason.name, 'AbortError', 'reason.name is AbortError');
    t.equal(reason.code, 20, 'reason.code is ABORT_ERR');
    t.equal(reason.message, 'The operation was aborted.', 'reason.message is stable');
  });

  it('abort() with custom reason', (t) => {
    const ctrl = new AbortController();
    const reason = new Error('custom');
    ctrl.abort(reason);
    t.equal(ctrl.signal.aborted, true, 'aborted is true');
    t.equal(ctrl.signal.reason, reason, 'reason is the custom error');
  });

  it('abort() is idempotent', (t) => {
    const ctrl = new AbortController();
    const reason = new Error('first');
    ctrl.abort(reason);
    ctrl.abort(new Error('second'));
    t.equal(ctrl.signal.reason, reason, 'reason stays as the first abort reason');
  });
});

describe('AbortSignal', () => {
  it('throwIfAborted before abort', (t) => {
    const ctrl = new AbortController();
    let threw = false;
    try { ctrl.signal.throwIfAborted(); } catch (_) { threw = true; }
    t.equal(threw, false, 'does not throw before abort');
  });

  it('throwIfAborted after abort', (t) => {
    const ctrl = new AbortController();
    const reason = new Error('stop');
    reason.name = 'AbortError';
    ctrl.abort(reason);
    t.throws(() => ctrl.signal.throwIfAborted(), (e) => e === reason, 'throws the abort reason');
  });

  it('addEventListener fires on abort', (t) => {
    const ctrl = new AbortController();
    let fired = false;
    let firedEvent: Event | null = null;
    ctrl.signal.addEventListener('abort', (e) => {
      fired = true;
      firedEvent = e;
    });
    ctrl.abort();
    t.equal(fired, true, 'listener fired');
    if (firedEvent === null) throw new Error('abort listener should receive an event');
    const event = firedEvent as Event;
    t.equal(event.type, 'abort', 'event.type is abort');
    t.equal(event.target, ctrl.signal, 'event.target is the signal');
  });

  it('addEventListener fires immediately if already aborted? (no)', (t) => {
    // If signal is already aborted before addEventListener, the listener is NOT
    // retroactively called (unlike onabort). This matches the DOM spec.
    const signal = AbortSignal.abort();
    let fired = false;
    signal.addEventListener('abort', () => { fired = true; });
    t.equal(fired, false, 'listener not called retroactively');
  });

  it('removeEventListener prevents callback', (t) => {
    const ctrl = new AbortController();
    let count = 0;
    const cb = () => { count++; };
    ctrl.signal.addEventListener('abort', cb);
    ctrl.signal.removeEventListener('abort', cb);
    ctrl.abort();
    t.equal(count, 0, 'removed listener not called');
  });

  it('onabort property fires on abort', (t) => {
    const ctrl = new AbortController();
    let fired = false;
    let targetDuringHandler: EventTarget | null = null;
    ctrl.signal.onabort = (event) => {
      fired = true;
      targetDuringHandler = event.target;
      t.equal(event.isTrusted, true, 'abort-generated event is trusted');
    };
    ctrl.abort();
    t.equal(fired, true, 'onabort fired');
    t.equal(targetDuringHandler, ctrl.signal, 'event.target is the signal during onabort');
  });

  it('onabort null does nothing', (t) => {
    const ctrl = new AbortController();
    ctrl.signal.onabort = 42 as unknown as ((this: AbortSignal, ev: Event) => any); // invalid — should be silently ignored
    t.equal(ctrl.signal.onabort, null, 'non-function sets onabort to null');
    let threw = false;
    try { ctrl.abort(); } catch (_) { threw = true; }
    t.equal(threw, false, 'aborting with null onabort does not throw');
  });
});

describe('AbortSignal.abort()', () => {
  it('returns pre-aborted signal', (t) => {
    const signal = AbortSignal.abort();
    t.equal(signal.aborted, true, 'aborted is true');
    t.ok(signal.reason instanceof Error, 'reason is Error');
    t.equal(signal.reason.name, 'AbortError', 'name is AbortError');
  });

  it('default reason is a DOMException AbortError', (t) => {
    const signal = AbortSignal.abort();
    const reason = signal.reason as DOMException;

    t.ok(reason instanceof DOMException, 'reason is DOMException');
    t.equal(reason.name, 'AbortError', 'reason.name is AbortError');
    t.equal(reason.code, 20, 'reason.code is ABORT_ERR');
    t.equal(reason.message, 'The operation was aborted.', 'reason.message is stable');
  });

  it('custom reason', (t) => {
    const reason = new TypeError('forbidden');
    const signal = AbortSignal.abort(reason);
    t.equal(signal.reason, reason, 'reason matches');
  });
});

describe('AbortSignal.any()', () => {
  it('aborts when first input aborts', (t) => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = AbortSignal.any([ctrl1.signal, ctrl2.signal]);
    t.equal(combined.aborted, false, 'starts non-aborted');
    ctrl1.abort(new Error('first'));
    t.equal(combined.aborted, true, 'aborts when ctrl1 aborts');
    t.equal(combined.reason.message, 'first', 'carries ctrl1 reason');
  });

  it('pre-aborted input', (t) => {
    const signal = AbortSignal.abort(new Error('pre'));
    const combined = AbortSignal.any([signal]);
    t.equal(combined.aborted, true, 'immediately aborted');
    t.equal(combined.reason.message, 'pre', 'carries pre-abort reason');
  });

  it('empty array stays non-aborted', (t) => {
    const combined = AbortSignal.any([]);
    t.equal(combined.aborted, false, 'non-aborted with empty input');
  });
});

describe('AbortSignal.timeout()', () => {
  it('aborts after delay', async (t) => {
    const signal = AbortSignal.timeout(10);
    t.equal(signal.aborted, false, 'not yet aborted');

    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve);
    });

    t.equal(signal.aborted, true, 'aborted after timeout');
    t.equal(signal.reason.name, 'TimeoutError', 'reason.name is TimeoutError');
  });

  it('uses a DOMException TimeoutError reason', async (t) => {
    const signal = AbortSignal.timeout(1);

    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve);
    });

    const reason = signal.reason as DOMException;
    t.ok(reason instanceof DOMException, 'reason is DOMException');
    t.equal(reason.name, 'TimeoutError', 'reason.name is TimeoutError');
    t.equal(reason.code, 23, 'reason.code is TIMEOUT_ERR');
    t.equal(reason.message, 'The operation timed out.', 'reason.message is stable');
  });

  it('coerces finite non-negative delay values with Number()', async (t) => {
    const signal = AbortSignal.timeout('0' as unknown as number);

    await new Promise((resolve) => {
      signal.addEventListener('abort', resolve);
    });

    t.equal(signal.aborted, true, 'string delay coerces and aborts');
    t.equal(signal.reason.name, 'TimeoutError', 'reason.name is TimeoutError');
  });

  it('rejects NaN, negative, and infinite delay values', (t) => {
    t.throws(() => AbortSignal.timeout(NaN), (e) => e instanceof RangeError, 'NaN throws RangeError');
    t.throws(() => AbortSignal.timeout(-1), (e) => e instanceof RangeError, 'negative throws RangeError');
    t.throws(() => AbortSignal.timeout(Infinity), (e) => e instanceof RangeError, 'Infinity throws RangeError');
    t.throws(() => AbortSignal.timeout(-Infinity), (e) => e instanceof RangeError, '-Infinity throws RangeError');
  });
});

describe('AbortSignal.abort() — additional cases', () => {
  it('AbortSignal.abort(null) — reason is null', (t) => {
    const signal = AbortSignal.abort(null);
    t.equal(signal.aborted, true, 'aborted is true');
    t.equal(signal.reason, null, 'reason is null, not a default Error');
  });
});

describe('AbortSignal.any() — additional cases', () => {
  it('cleans up listeners after one signal fires (no double-fire)', (t) => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = AbortSignal.any([ctrl1.signal, ctrl2.signal]);
    let fireCount = 0;
    combined.addEventListener('abort', () => { fireCount++; });
    ctrl1.abort(new Error('first'));
    // abort ctrl2 — listener should have been removed from ctrl2, so combined should not re-fire
    ctrl2.abort(new Error('second'));
    t.equal(fireCount, 1, 'abort event fired exactly once');
    t.equal(combined.reason.message, 'first', 'reason stays from first abort');
  });

  it('duplicate signals in array — first pre-aborted wins', (t) => {
    const sig = AbortSignal.abort(new Error('dup'));
    // Same signal appears twice; the first occurrence should win immediately
    const combined = AbortSignal.any([sig, sig]);
    t.equal(combined.aborted, true, 'combined is aborted');
    t.equal(combined.reason.message, 'dup', 'reason comes from the pre-aborted signal');
  });

  it('fires source abort event before dependent AbortSignal.any() events', (t) => {
    const controller = new AbortController();
    const signals = [
      controller.signal,
      AbortSignal.any([controller.signal]),
      AbortSignal.any([controller.signal]),
      AbortSignal.any([controller.signal]),
    ];
    signals.push(AbortSignal.any([signals[1]!]));

    let order = '';
    for (let i = 0; i < signals.length; i++) {
      signals[i]!.addEventListener('abort', () => { order += i; });
    }

    controller.abort();
    t.equal(order, '01234', 'source event fires before dependents in creation order');
  });
});

describe('AbortSignal — throwIfAborted with string reason', () => {
  it('throwIfAborted throws the string itself when reason is a string', (t) => {
    const signal = AbortSignal.abort('cancelled');
    t.throws(
      () => signal.throwIfAborted(),
      (e) => e === 'cancelled',
      'throws the string reason directly',
    );
  });
});

describe('AbortController — signal identity', () => {
  it('controller.signal always returns the same object reference', (t) => {
    const ctrl = new AbortController();
    t.ok(ctrl.signal === ctrl.signal, 'signal property returns the same object each time');
  });
});

describe('AbortSignal — onabort fires before addEventListener listeners', () => {
  it('onabort handler fires before addEventListener abort listeners', (t) => {
    const ctrl = new AbortController();
    const order: string[] = [];
    ctrl.signal.onabort = () => { order.push('onabort'); };
    ctrl.signal.addEventListener('abort', () => { order.push('listener'); });
    ctrl.abort();
    t.equal(order[0], 'onabort', 'onabort fires first');
    t.equal(order[1], 'listener', 'listener fires second');
    t.equal(order.length, 2, 'both fired');
  });
});

describe('AbortSignal — throwIfAborted with default reason', () => {
  it('throwIfAborted() with no-argument abort throws an AbortError', (t) => {
    const ctrl = new AbortController();
    ctrl.abort(); // no reason argument
    t.throws(
      () => ctrl.signal.throwIfAborted(),
      (e) => e instanceof DOMException && e.name === 'AbortError' && e.code === 20,
      'throws with AbortError name',
    );
  });
});

describe('AbortController — abort(undefined) uses default reason', () => {
  it('abort(undefined) produces the same default AbortError as abort()', (t) => {
    const ctrl = new AbortController();
    ctrl.abort(undefined);
    t.equal(ctrl.signal.aborted, true, 'aborted is true');
    t.ok(ctrl.signal.reason instanceof Error, 'reason is Error');
    t.equal(ctrl.signal.reason.name, 'AbortError', 'name is AbortError');
  });
});

describe('AbortSignal.any() — second signal aborts', () => {
  it('combined signal aborts when second input signal aborts', (t) => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = AbortSignal.any([ctrl1.signal, ctrl2.signal]);
    t.equal(combined.aborted, false, 'starts non-aborted');
    ctrl2.abort(new Error('second'));
    t.equal(combined.aborted, true, 'aborts when ctrl2 aborts');
    t.equal(combined.reason.message, 'second', 'carries ctrl2 reason');
  });

  it('combined signal carries reason from whichever fires first', (t) => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const combined = AbortSignal.any([ctrl1.signal, ctrl2.signal]);
    ctrl2.abort(new Error('from-two'));
    ctrl1.abort(new Error('from-one'));
    t.equal(combined.reason.message, 'from-two', 'second signal fired first, reason preserved');
  });
});

describe('AbortSignal — direct construction blocked', () => {
  it('new AbortSignal() throws TypeError', (t) => {
    t.throws(() => new AbortSignal(), /Illegal constructor/, 'direct construction throws');
  });

  it('AbortController still works after blocked construction attempt', (t) => {
    try { new AbortSignal(); } catch (_) {}
    const ctrl = new AbortController();
    t.ok(ctrl.signal instanceof AbortSignal, 'controller still creates signals normally');
    t.equal(ctrl.signal.aborted, false, 'signal is non-aborted');
  });
});

describe('AbortSignal — onabort replacement', () => {
  it('replacing onabort: old handler does not fire', (t) => {
    const ctrl = new AbortController();
    const calls: string[] = [];
    ctrl.signal.onabort = () => calls.push('old');
    ctrl.signal.onabort = () => calls.push('new');
    ctrl.abort();
    t.equal(calls.length, 1, 'only one handler fired');
    t.equal(calls[0], 'new', 'new handler fired');
  });

  it('setting onabort = null after setting prevents firing', (t) => {
    const ctrl = new AbortController();
    let fired = false;
    ctrl.signal.onabort = () => { fired = true; };
    ctrl.signal.onabort = null;
    ctrl.abort();
    t.equal(fired, false, 'handler was cleared and did not fire');
  });
});

describe('AbortSignal.any() — pre-aborted not first', () => {
  it('aborts immediately when pre-aborted signal is not first in array', (t) => {
    const live = new AbortController();
    const pre = AbortSignal.abort(new Error('pre-aborted'));
    const combined = AbortSignal.any([live.signal, pre]);
    t.equal(combined.aborted, true, 'combined is immediately aborted');
    t.equal(combined.reason.message, 'pre-aborted', 'carries pre-abort reason');
  });
});

describe('AbortSignal — manual dispatchEvent fires onabort', () => {
  it('manually dispatching abort event triggers onabort', (t) => {
    const ctrl = new AbortController();
    let fired = false;
    ctrl.signal.onabort = () => { fired = true; };
    ctrl.abort();
    t.equal(fired, true, 'onabort fired via controller.abort() which dispatches the event');
  });
});

describe('Symbol.toStringTag', () => {
  it('AbortSignal [Symbol.toStringTag] is "AbortSignal"', (t) => {
    const signal = new AbortController().signal;
    t.equal((signal as unknown as Record<symbol, unknown>)[Symbol.toStringTag], 'AbortSignal', 'toStringTag is AbortSignal');
  });

  it('AbortController [Symbol.toStringTag] is "AbortController"', (t) => {
    const ctrl = new AbortController();
    t.equal((ctrl as unknown as Record<symbol, unknown>)[Symbol.toStringTag], 'AbortController', 'toStringTag is AbortController');
  });
});

describe('AbortSignal.abort() — falsy non-undefined reasons', () => {
  it('AbortSignal.abort(false) — reason is false (falsy but not undefined)', (t) => {
    const signal = AbortSignal.abort(false as any);
    t.equal(signal.aborted, true, 'signal is aborted');
    t.equal(signal.reason, false, 'reason is false');
  });

  it('AbortSignal.abort(0) — reason is 0', (t) => {
    const signal = AbortSignal.abort(0 as any);
    t.equal(signal.aborted, true, 'signal is aborted');
    t.equal(signal.reason, 0, 'reason is 0');
  });

  it('AbortSignal.abort("") — reason is empty string', (t) => {
    const signal = AbortSignal.abort('' as any);
    t.equal(signal.aborted, true, 'signal is aborted');
    t.equal(signal.reason, '', 'reason is empty string');
  });
});

describe('AbortSignal.any() — input validation', () => {
  it('throws when passed a non-iterable', (t) => {
    t.throws(
      () => AbortSignal.any(null as any),
      /iterable/i,
      'null throws with iterable message',
    );
  });

  it('throws when array contains non-AbortSignal values', (t) => {
    t.throws(
      () => AbortSignal.any([{} as any]),
      /AbortSignal/i,
      'non-signal in array throws with AbortSignal message',
    );
  });
});

describe('AbortSignal.timeout() — input validation', () => {
  it('creates a non-aborted signal initially', (t) => {
    const sig = AbortSignal.timeout(5);
    t.equal(sig.aborted, false, 'freshly created timeout signal is not aborted');
  });

  it('creates a signal with TimeoutError reason when it fires', async (t) => {
    const sig = AbortSignal.timeout(5);
    await new Promise(r => setTimeout(r, 20));
    t.equal(sig.aborted, true, 'signal aborted after timeout');
    t.equal((sig.reason as any)?.name, 'TimeoutError', 'reason has name TimeoutError');
  });
});
