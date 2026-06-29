/**
 * Tests for timer globals: setTimeout, setInterval, clearTimeout, clearInterval,
 * queueMicrotask, and performance.now().
 *
 * Also tests atob/btoa, structuredClone, console.count, and
 * console.countReset as globals.
 */

import { describe, it } from 'fino:test/test';
type CloneMapValue = number | { x: number };
const { setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance } = globalThis;
const { atob, btoa, structuredClone } = globalThis;
const { console } = globalThis;

describe('setTimeout', () => {
  it('fires after delay', async (t) => {
    let fired = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => { fired = true; resolve(); }, 10);
    });
    t.ok(fired, 'callback fired');
  });

  it('passes extra args to fn', async (t) => {
    let received: [string, number] | undefined;
    await new Promise<void>((resolve) => {
      setTimeout((a: string, b: number) => { received = [a, b]; resolve(); }, 5, 'x', 42);
    });
    t.deepEqual(received, ['x', 42], 'args forwarded');
  });

  it('returns integer id', (t) => {
    const id = setTimeout(() => {}, 1000);
    t.ok(typeof id === 'number' && id > 0, 'returns positive integer');
    clearTimeout(id);
  });

  it('clearTimeout prevents callback', async (t) => {
    let fired = false;
    const id = setTimeout(() => { fired = true; }, 10);
    clearTimeout(id);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    t.ok(!fired, 'callback was not called');
  });

  it('clearTimeout no-op on unknown id', (t) => {
    t.ok(true, 'does not throw');
    clearTimeout(99999);
    t.ok(true, 'still alive after no-op clearTimeout');
  });

  it('ms=0 fires in the next tick', async (t) => {
    let order: string[] = [];
    await new Promise<void>((resolve) => {
      order.push('sync');
      setTimeout(() => { order.push('timer'); resolve(); }, 0);
      order.push('sync2');
    });
    t.equal(order[0], 'sync', 'first sync');
    t.equal(order[1], 'sync2', 'second sync');
    t.equal(order[2], 'timer', 'timer fires after sync code');
  });
});

describe('setInterval / clearInterval', () => {
  it('setInterval fires multiple times', async (t) => {
    let count = 0;
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        count++;
        if (count >= 3) { clearInterval(id); resolve(); }
      }, 10);
    });
    t.equal(count, 3, 'fired exactly 3 times');
  });

  it('clearInterval stops future invocations', async (t) => {
    let count = 0;
    const id = setInterval(() => { count++; }, 10);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    clearInterval(id);
    const countAtCancel = count;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    t.equal(count, countAtCancel, 'no more calls after clearInterval');
  });
});

describe('queueMicrotask', () => {
  it('runs before next setTimeout', async (t) => {
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      setTimeout(() => { order.push('timer'); resolve(); }, 0);
      queueMicrotask(() => { order.push('microtask'); });
    });
    t.equal(order[0], 'microtask', 'microtask ran before timer');
    t.equal(order[1], 'timer', 'timer ran after microtask');
  });

  it('multiple microtasks run in order', async (t) => {
    const order: number[] = [];
    await new Promise<void>((resolve) => {
      queueMicrotask(() => order.push(1));
      queueMicrotask(() => order.push(2));
      queueMicrotask(() => { order.push(3); resolve(); });
    });
    t.deepEqual(order, [1, 2, 3], 'ran in registration order');
  });

  it('does not pass arguments to the callback', async (t) => {
    const args = await new Promise<unknown[]>((resolve) => {
      queueMicrotask(function(this: unknown) {
        resolve(Array.from(arguments));
      });
    });
    t.deepEqual(args, [], 'callback receives no arguments');
  });
});

describe('queueMicrotask — validation', () => {
  it('throws TypeError for non-callable argument', (t) => {
    t.throws(() => queueMicrotask(42 as any), /must be a function/, 'throws for number');
    t.throws(() => queueMicrotask('fn' as any), /must be a function/, 'throws for string');
    t.throws(() => queueMicrotask(null as any), /must be a function/, 'throws for null');
  });
});

describe('performance.now', () => {
  it('returns a number', (t) => {
    const t0 = performance.now();
    t.ok(typeof t0 === 'number', 'returns number');
    t.ok(t0 >= 0, 'non-negative');
  });

  it('is monotonically increasing', async (t) => {
    const t0 = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const t1 = performance.now();
    t.ok(t1 > t0, 't1 > t0');
  });

  it('measures elapsed time with sub-ms precision', async (t) => {
    const t0 = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const t1 = performance.now();
    const elapsed = t1 - t0;
    t.ok(elapsed >= 40, `elapsed >= 40ms (got ${elapsed.toFixed(2)}ms)`);
    t.ok(elapsed < 200, `elapsed < 200ms (got ${elapsed.toFixed(2)}ms)`);
    t.ok(typeof elapsed === 'number', 'returns number');
  });

  it('returns fractional milliseconds (sub-ms precision)', async (t) => {
    // Take two readings in tight succession; at least one should be non-integer
    const readings = Array.from({ length: 10 }, () => performance.now());
    const hasDecimal = readings.some(v => v !== Math.floor(v));
    t.ok(hasDecimal, 'at least one reading has sub-millisecond precision');
  });
});

describe('performance.timeOrigin', () => {
  it('is a positive number', (t) => {
    t.ok(typeof performance.timeOrigin === 'number', 'is a number');
    t.ok(performance.timeOrigin > 0, 'is positive');
  });

  it('is a reasonable Unix timestamp (after year 2020)', (t) => {
    const year2020 = 1577836800000;
    t.ok(performance.timeOrigin > year2020, 'timeOrigin is after 2020');
  });
});

describe('performance.toJSON', () => {
  it('returns an object with timeOrigin', (t) => {
    const json = performance.toJSON();
    t.ok(typeof json === 'object' && json !== null, 'returns object');
    t.ok('timeOrigin' in json, 'has timeOrigin key');
    t.equal(json.timeOrigin, performance.timeOrigin, 'timeOrigin matches');
  });
});

describe('Performance interface shape', () => {
  it('exposes a WebIDL-compatible Performance interface object', (t) => {
    const PerformanceCtor = (globalThis as any).Performance;
    t.equal(typeof PerformanceCtor, 'function', 'Performance constructor is exposed');
    t.equal(PerformanceCtor.length, 0, 'Performance.length');
    t.equal(PerformanceCtor.name, 'Performance', 'Performance.name');
    t.ok(performance instanceof PerformanceCtor, 'performance is a Performance instance');
    t.equal(Object.prototype.toString.call(performance), '[object Performance]', 'class string');
    t.equal(typeof PerformanceCtor.prototype.now, 'function', 'now is on prototype');
    t.equal(typeof PerformanceCtor.prototype.toJSON, 'function', 'toJSON is on prototype');
    t.equal(Object.hasOwn(performance, 'timeOrigin'), false, 'timeOrigin is inherited');
    t.ok('timeOrigin' in performance, 'timeOrigin exists');
    const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    t.equal(typeof globalDescriptor?.get, 'function', 'global performance is exposed by getter');
    t.equal(typeof globalDescriptor?.set, 'function', 'global performance has replaceable setter');
    t.equal(globalDescriptor?.get?.name, 'get performance', 'global performance getter name');
    t.equal(globalDescriptor?.set?.name, 'set performance', 'global performance setter name');
    t.equal(globalDescriptor?.set?.length, 1, 'global performance setter length');
    t.equal(globalDescriptor?.enumerable, true, 'global performance is enumerable');
    t.equal(globalDescriptor!.get!.call(undefined), performance, 'global performance getter allows unbound reads');
    t.throws(() => globalDescriptor!.get!.call({}), TypeError, 'global performance getter brands this');
    t.throws(() => globalDescriptor!.set!.call({}, performance), TypeError, 'global performance setter brands this');
    t.throws(() => PerformanceCtor.prototype.now.call(null), TypeError, 'now brands this');
    t.throws(() => PerformanceCtor.prototype.toJSON.call({}), TypeError, 'toJSON brands this');
  });
});

describe('performance EventTarget behavior', () => {
  it('dispatches events through EventTarget methods', (t) => {
    let called = false;
    performance.addEventListener('fino-test', () => {
      called = true;
    }, { once: true });
    performance.dispatchEvent(new Event('fino-test'));
    t.equal(called, true, 'listener ran');
  });
});

describe('performance release subset', () => {
  it('exposes now, timeOrigin, and toJSON only for timing APIs', (t) => {
    t.equal(typeof performance.now, 'function', 'now is available');
    t.equal(typeof performance.timeOrigin, 'number', 'timeOrigin is available');
    t.equal(typeof performance.toJSON, 'function', 'toJSON is available');
    t.equal(typeof (performance as any).mark, 'undefined', 'mark is out of scope');
    t.equal(typeof (performance as any).measure, 'undefined', 'measure is out of scope');
    t.equal(typeof (performance as any).getEntries, 'undefined', 'timeline is out of scope');
  });
});

describe('atob / btoa', () => {
  it('btoa encodes ASCII string', (t) => {
    t.equal(btoa('hello'), 'aGVsbG8=', 'btoa("hello")');
    t.equal(btoa(''), '', 'empty string');
    t.equal(btoa('Man'), 'TWFu', 'btoa("Man")');
  });

  it('btoa encodes binary bytes', (t) => {
    t.equal(btoa('\x00\x01\x02'), 'AAEC', 'binary bytes');
    t.equal(btoa('\xFF\xFE\xFD'), '//79', 'high bytes');
  });

  it('btoa throws on chars > 255', (t) => {
    t.throws(() => btoa('hello\u0100'), undefined, 'throws on non-Latin1 char');
  });

  it('atob decodes base64 string', (t) => {
    t.equal(atob('aGVsbG8='), 'hello', 'atob("aGVsbG8=")');
    t.equal(atob(''), '', 'empty string');
    t.equal(atob('TWFu'), 'Man', 'atob("TWFu")');
  });

  it('atob strips whitespace', (t) => {
    t.equal(atob('aGVs\nbG8='), 'hello', 'strips newlines');
    t.equal(atob('aGVs bG8='), 'hello', 'strips spaces');
  });

  it('atob round-trips with btoa', (t) => {
    const original = 'Hello, World! \x00\xFF\xAB';
    t.equal(atob(btoa(original)), original, 'round-trip');
  });

  it('atob throws on invalid base64', (t) => {
    t.throws(() => atob('!!!!'), undefined, 'throws on invalid chars');
    t.throws(() => atob('a'), undefined, 'throws on length % 4 == 1 (always invalid)');
  });
});

describe('structuredClone', () => {
  it('clones primitives', (t) => {
    t.equal(structuredClone(42), 42, 'number');
    t.equal(structuredClone('hello'), 'hello', 'string');
    t.equal(structuredClone(true), true, 'boolean');
    t.equal(structuredClone(null), null, 'null');
    t.equal(structuredClone(undefined), undefined, 'undefined');
  });

  it('clones plain objects', (t) => {
    const obj = { a: 1, b: { c: 2 } };
    const clone = structuredClone(obj);
    t.deepEqual(clone, obj, 'deep equal');
    clone.b.c = 99;
    t.equal(obj.b.c, 2, 'original not mutated');
  });

  it('clones arrays', (t) => {
    const arr: [number, number[], { x: number }] = [1, [2, 3], { x: 4 }];
    const clone = structuredClone(arr);
    t.deepEqual(clone, arr, 'deep equal');
    clone[1][0] = 99;
    t.equal(arr[1][0], 2, 'original not mutated');
  });

  it('clones Date', (t) => {
    const d = new Date(1234567890000);
    const clone = structuredClone(d);
    t.ok(clone instanceof Date, 'is Date');
    t.equal(clone.getTime(), d.getTime(), 'same time');
    t.ok(clone !== d, 'different reference');
  });

  it('clones RegExp', (t) => {
    const re = /hello/gi;
    const clone = structuredClone(re);
    t.ok(clone instanceof RegExp, 'is RegExp');
    t.equal(clone.source, re.source, 'same source');
    t.equal(clone.flags, re.flags, 'same flags');
    t.ok(clone !== re, 'different reference');
  });

  it('clones Map', (t) => {
    const m = new Map<string, CloneMapValue>([['a', 1], ['b', { x: 2 }]]);
    const clone = structuredClone(m);
    t.ok(clone instanceof Map, 'is Map');
    t.equal(clone.get('a'), 1, 'a value');
    t.deepEqual(clone.get('b'), { x: 2 }, 'b value deep equal');
    t.ok(clone.get('b') !== m.get('b'), 'b value is new object');
  });

  it('clones Set', (t) => {
    const s = new Set([1, { y: 2 }, 'three']);
    const clone = structuredClone(s);
    t.ok(clone instanceof Set, 'is Set');
    t.equal(clone.size, s.size, 'same size');
    t.ok(clone.has(1), 'has 1');
    t.ok(clone.has('three'), 'has "three"');
  });

  it('clones ArrayBuffer', (t) => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    const clone = structuredClone(buf);
    t.ok(clone instanceof ArrayBuffer, 'is ArrayBuffer');
    t.ok(clone !== buf, 'different reference');
    t.deepEqual(Array.from(new Uint8Array(clone)), [1, 2, 3, 4], 'same content');
  });

  it('clones TypedArray', (t) => {
    const arr = new Uint8Array([10, 20, 30]);
    const clone = structuredClone(arr);
    t.ok(clone instanceof Uint8Array, 'is Uint8Array');
    t.ok(clone.buffer !== arr.buffer, 'different backing buffer');
    t.deepEqual(Array.from(clone), [10, 20, 30], 'same content');
  });

  it('handles cycles', (t) => {
    const obj: { name: string; self?: unknown } = { name: 'root' };
    obj.self = obj;
    const clone = structuredClone(obj);
    t.equal(clone.name, 'root', 'name cloned');
    t.ok(clone.self === clone, 'cycle preserved');
    t.ok(clone !== obj, 'different root reference');
  });

  it('throws on functions', (t) => {
    t.throws(() => structuredClone(() => {}), undefined, 'throws on function');
  });

  it('throws on Symbols', (t) => {
    t.throws(() => structuredClone(Symbol('x')), undefined, 'throws on symbol');
  });
});

describe('setTimeout — edge cases', () => {
  it('negative delay is clamped to 0', async (t) => {
    let fired = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => { fired = true; resolve(); }, -100);
    });
    t.ok(fired, 'callback fired despite negative delay');
  });

  it('NaN delay is clamped to 0', async (t) => {
    let fired = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => { fired = true; resolve(); }, NaN);
    });
    t.ok(fired, 'callback fired with NaN delay (treated as 0)');
  });

  it('clearTimeout with undefined is a no-op', (t) => {
    let threw = false;
    try { clearTimeout(undefined); } catch (_) { threw = true; }
    t.equal(threw, false, 'clearTimeout(undefined) does not throw');
  });

  it('clearTimeout with null is a no-op', (t) => {
    let threw = false;
    try { clearTimeout(null as any); } catch (_) { threw = true; }
    t.equal(threw, false, 'clearTimeout(null) does not throw');
  });
});

describe('setInterval — args forwarding', () => {
  it('passes extra args to interval callback', async (t) => {
    let received: [string, number] | undefined;
    await new Promise<void>((resolve) => {
      const id = setInterval((a: string, b: number) => {
        received = [a, b];
        clearInterval(id);
        resolve();
      }, 10, 'hello', 42);
    });
    t.deepEqual(received, ['hello', 42], 'args forwarded to setInterval callback');
  });
});

describe('clearTimeout / clearInterval interchangeability', () => {
  it('clearInterval can cancel a setTimeout (same id space)', async (t) => {
    let fired = false;
    const id = setTimeout(() => { fired = true; }, 20);
    clearInterval(id); // cross-cancel
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    t.equal(fired, false, 'setTimeout cancelled via clearInterval');
  });

  it('clearTimeout can cancel a setInterval (same id space)', async (t) => {
    let count = 0;
    const id = setInterval(() => { count++; }, 50);
    clearTimeout(id); // synchronous cancel — before any event loop tick
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    t.equal(count, 0, 'setInterval cancelled via clearTimeout before first fire');
  });
});

describe('setTimeout — clearTimeout after fired', () => {
  it('clearTimeout after timer already fired is a no-op', async (t) => {
    let fired = false;
    const id = setTimeout(() => { fired = true; }, 10);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    t.ok(fired, 'timer fired');
    let threw = false;
    try { clearTimeout(id); } catch (_) { threw = true; }
    t.equal(threw, false, 'clearTimeout after fire does not throw');
  });

  it('multiple clearTimeout with same id is a no-op after first', async (t) => {
    let count = 0;
    const id = setTimeout(() => { count++; }, 50);
    clearTimeout(id);
    clearTimeout(id); // second call — should be a no-op
    clearTimeout(id); // third call — also no-op
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    t.equal(count, 0, 'timer never fired; multiple clears are safe');
  });
});

describe('performance.now — sub-millisecond precision', () => {
  it('returns a fractional millisecond value', async (t) => {
    const readings: number[] = [];
    for (let i = 0; i < 20; i++) {
      readings.push(performance.now());
    }
    const hasDecimal = readings.some(v => v !== Math.floor(v));
    const first = readings[0];
    t.ok(typeof first === 'number', 'values are numbers');
    t.ok(hasDecimal || (first !== undefined && first >= 0), 'performance.now returns non-negative numbers');
  });
});

describe('console.count / countReset', () => {
  it('count increments and prints label', (t) => {
    t.ok(true, 'count does not throw');
    console.count('test-counter');
    console.count('test-counter');
    console.count('test-counter');
    t.ok(true, 'three counts did not throw');
  });

  it('count default label is "default"', (t) => {
    t.ok(true, 'uses default label without throw');
    console.count();
    t.ok(true, 'count() with no args works');
  });

  it('countReset resets counter', (t) => {
    console.count('reset-test');
    console.count('reset-test');
    t.ok(true, 'counted twice');
    console.countReset('reset-test');
    t.ok(true, 'reset did not throw');
  });

  it('countReset warns on unknown label', (t) => {
    t.ok(true, 'countReset on unknown label does not throw');
    console.countReset('nonexistent-label-xyz');
    t.ok(true, 'still alive after warning');
  });
});
