/**
 * Tests for the console global.
 *
 * Since console output goes directly to fd 1/2 via libc (not capturable in
 * tests), these tests focus on behavioral correctness: functions are callable,
 * don't throw, maintain correct state, and handle edge cases like circular
 * references without crashing.
 */

import { describe, it } from 'fino:test/test';
import { _pushConsoleCapture, type ConsoleCaptureRecord } from 'internal:globals/console';

const { console } = globalThis;
const consoleRecord = console as unknown as Record<string | symbol, unknown>;

function captureConsole(fn: () => void): ConsoleCaptureRecord[] {
  const records: ConsoleCaptureRecord[] = [];
  const release = _pushConsoleCapture((record) => records.push(record));
  try {
    fn();
  } finally {
    release();
  }
  return records;
}

describe('console exists and has expected methods', () => {
  it('has all required methods', (t) => {
    const methods = ['log', 'info', 'debug', 'warn', 'error', 'assert', 'dir',
      'table', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd',
      'timeLog', 'count', 'countReset', 'clear'];
    for (const m of methods) {
      t.equal(typeof consoleRecord[m], 'function', `console.${m} is a function`);
    }
  });

  it('[Symbol.toStringTag] is "console"', (t) => {
    t.equal(consoleRecord[Symbol.toStringTag], 'console');
  });

  it('has namespace-object prototype and toStringTag descriptors', (t) => {
    const prototype = Object.getPrototypeOf(console);
    t.deepEqual(Object.getOwnPropertyNames(prototype), [], 'console prototype has no own properties');
    t.equal(Object.getPrototypeOf(prototype), Object.prototype, 'console prototype inherits from Object.prototype');

    const descriptor = Object.getOwnPropertyDescriptor(console, Symbol.toStringTag);
    t.ok(descriptor, 'toStringTag descriptor exists');
    if (descriptor === undefined) throw new Error('descriptor should exist');
    t.equal(descriptor.value, 'console', 'toStringTag value');
    t.equal(descriptor.writable, false, 'toStringTag is not writable');
    t.equal(descriptor.enumerable, false, 'toStringTag is not enumerable');
    t.equal(descriptor.configurable, true, 'toStringTag is configurable');
  });
});

describe('console output methods do not throw', () => {
  it('log, info, debug accept various types', (t) => {
    let threw = false;
    try {
      console.log();
      console.log('string');
      console.log(42, true, null, undefined);
      console.log({ a: 1 }, [1, 2, 3]);
      console.log(Symbol('s'), 42n);
      console.info('info');
      console.debug('debug');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('warn and error do not throw', (t) => {
    let threw = false;
    try {
      console.warn('warning');
      console.error('error', new Error('boom'));
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('dir does not throw', (t) => {
    let threw = false;
    try {
      console.dir({ a: { b: { c: 1 } } });
      console.dir(null);
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('table does not throw', (t) => {
    let threw = false;
    try {
      console.table([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
      console.table({ x: 1, y: 2 });
      console.table(null);
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('clear does not throw', (t) => {
    let threw = false;
    try { console.clear(); } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });
});

describe('console.assert', () => {
  it('does not throw when condition is true', (t) => {
    let threw = false;
    try { console.assert(true, 'should not log'); } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw on truthy condition');
  });

  it('does not throw when condition is false (just logs)', (t) => {
    let threw = false;
    try {
      console.assert(false, 'assertion message');
      console.assert(false);
      console.assert(0 as any, 'falsy number');
      console.assert(null as any, 'null');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw on falsy condition');
  });
});

describe('console.group / groupEnd', () => {
  it('group and groupEnd balance without throwing', (t) => {
    let threw = false;
    try {
      console.group('outer');
      console.log('inside group');
      console.group('inner');
      console.log('inside nested group');
      console.groupEnd();
      console.groupEnd();
      console.groupEnd(); // extra — should clamp at 0, not throw
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('groupCollapsed is identical to group', (t) => {
    let threw = false;
    try {
      console.groupCollapsed('collapsed');
      console.groupEnd();
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });
});

describe('console.time / timeEnd / timeLog', () => {
  it('time and timeEnd work for same label', (t) => {
    let threw = false;
    try {
      console.time('myTimer');
      console.timeEnd('myTimer');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('timeEnd with nonexistent label warns but does not throw', (t) => {
    let threw = false;
    try { console.timeEnd('nonexistent-timer-xyz'); } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw on missing label');
  });

  it('timeLog works', (t) => {
    let threw = false;
    try {
      console.time('log-test');
      console.timeLog('log-test', 'extra', 'data');
      console.timeEnd('log-test');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('default label is "default"', (t) => {
    let threw = false;
    try {
      console.time();
      console.timeEnd();
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw with default label');
  });
});

describe('console label conversion', () => {
  it('converts object labels to strings', (t) => {
    for (const method of ['count', 'countReset', 'time', 'timeLog', 'timeEnd']) {
      let called = false;
      const label = {
        toString() {
          called = true;
          return `label-${method}`;
        },
      };
      captureConsole(() => {
        (consoleRecord[method] as (label: unknown) => void)(label);
      });
      t.equal(called, true, `${method} converted label`);
    }
  });

  it('rethrows label conversion errors', (t) => {
    for (const method of ['count', 'countReset', 'time', 'timeLog', 'timeEnd']) {
      t.throws(
        () => (consoleRecord[method] as (label: unknown) => void)({
          toString() {
            throw new Error('conversion error');
          },
        }),
        /conversion error/,
        `${method} rethrows conversion error`,
      );
    }
  });
});

describe('console.count / countReset', () => {
  it('count increments per label', (t) => {
    // We can't capture output, but can verify no throw and state reset works.
    let threw = false;
    try {
      console.count('myLabel');
      console.count('myLabel');
      console.countReset('myLabel');
      console.count('myLabel'); // should restart from 1
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });

  it('countReset with nonexistent label warns but does not throw', (t) => {
    let threw = false;
    try { console.countReset('no-such-label-xyz'); } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw on missing label');
  });

  it('default label is "default"', (t) => {
    let threw = false;
    try {
      console.count();
      console.countReset();
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw with default label');
  });
});

describe('console circular reference protection', () => {
  it('logging a circular object does not stack overflow', (t) => {
    const obj: any = { a: 1 };
    obj.self = obj;
    let threw = false;
    try { console.log(obj); } catch (_) { threw = true; }
    t.equal(threw, false, 'circular ref does not crash');
  });

  it('logging a circular array does not stack overflow', (t) => {
    const arr: any[] = [1, 2];
    arr.push(arr);
    let threw = false;
    try { console.log(arr); } catch (_) { threw = true; }
    t.equal(threw, false, 'circular array does not crash');
  });

  it('logging deeply nested objects respects depth limit', (t) => {
    const deep = { a: { b: { c: { d: { e: 'leaf' } } } } };
    let threw = false;
    try { console.log(deep); } catch (_) { threw = true; }
    t.equal(threw, false, 'deep nesting does not crash');
  });
});

describe('console.trace', () => {
  it('console.trace does not throw', (t) => {
    t.ok(typeof console.trace === 'function', 'console.trace is a function');
    let threw = false;
    try { console.trace('stack trace test'); } catch (_) { threw = true; }
    t.equal(threw, false, 'console.trace does not throw');
  });

  it('console.trace with no args does not throw', (t) => {
    let threw = false;
    try { console.trace(); } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });
});

describe('console.dirxml', () => {
  it('console.dirxml does not throw', (t) => {
    t.ok(typeof console.dirxml === 'function', 'console.dirxml is a function');
    let threw = false;
    try { console.dirxml({ foo: 'bar' }); } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });
});

describe('console.timeStamp', () => {
  it('console.timeStamp does not throw', (t) => {
    t.ok(typeof console.timeStamp === 'function', 'console.timeStamp is a function');
    let threw = false;
    try {
      console.timeStamp();
      console.timeStamp('my label');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });
});

describe('console format specifiers', () => {
  it('%%s and %d substitution do not throw', (t) => {
    let threw = false;
    try {
      console.log('hello %s', 'world');
      console.log('count: %d', 42);
      console.log('%i integer', 3.7);
      console.log('%f float', 3.14);
      console.log('%% escaped percent');
      console.log('extra %s args', 'one', 'two', 'three');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'no throw');
  });
});

describe('console.time — duplicate label behavior', () => {
  it('calling time() twice with the same label does not throw', (t) => {
    let threw = false;
    try {
      console.time('dup-label');
      console.time('dup-label'); // second call should warn, not throw
      console.timeEnd('dup-label');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'duplicate time() label does not throw');
  });
});

describe('console.assert — format string', () => {
  it('console.assert with format string does not throw', (t) => {
    let threw = false;
    try {
      console.assert(false, 'value is %d', 42);
      console.assert(false, '%s error', 'type');
    } catch (_) { threw = true; }
    t.equal(threw, false, 'assert with format string does not throw');
  });
});

describe('console.dir — options support (F6)', () => {
  it('dir with depth option does not throw', (t) => {
    let threw = false;
    try {
      console.dir({ a: { b: { c: 1 } } }, { depth: 1 });
      console.dir({ x: 1 }, { depth: 0 });
      console.dir({ y: 2 }, { depth: 10 });
    } catch (_) { threw = true; }
    t.equal(threw, false, 'dir with depth option does not throw');
  });

  it('dir with colors option does not throw', (t) => {
    let threw = false;
    try {
      console.dir({ a: 1 }, { colors: true });
      console.dir({ a: 1 }, { colors: false });
    } catch (_) { threw = true; }
    t.equal(threw, false, 'dir with colors option does not throw');
  });

  it('dir with no options uses default depth', (t) => {
    let threw = false;
    try { console.dir({ a: { b: { c: { d: 1 } } } }); } catch (_) { threw = true; }
    t.equal(threw, false, 'dir with no options does not throw');
  });
});

describe('console format %c specifier (F7)', () => {
  it('%c consumes its argument without throwing', (t) => {
    let threw = false;
    try {
      console.log('%cred text', 'color: red');
      console.log('before %c after', 'color: blue; font-weight: bold');
      console.log('%c%c two styles', 'color: red', 'color: blue');
    } catch (_) { threw = true; }
    t.equal(threw, false, '%c does not throw');
  });

  it('%c with no corresponding arg leaves specifier in place', (t) => {
    // When no arg is available for %c, it should not consume a later arg
    let threw = false;
    try { console.log('%c no style arg'); } catch (_) { threw = true; }
    t.equal(threw, false, '%c with no arg does not throw');
  });
});

describe('console capture output', () => {
  it('captures formatting and stdout routing', (t) => {
    const records = captureConsole(() => {
      console.log('hello %s %d %%', 'world', 3.7);
      console.info({ a: 1 }, ['x']);
    });

    t.deepEqual(records, [
      { fd: 1, text: 'hello world 3 %' },
      { fd: 1, text: '{ a: 1 } [ "x" ]' },
    ], 'stdout records include formatted text');
  });

  it('captures stderr routing for warnings, errors, and assertions', (t) => {
    const records = captureConsole(() => {
      console.warn('careful');
      console.error('boom');
      console.assert(false, 'bad %s', 'state');
    });

    t.deepEqual(records, [
      { fd: 2, text: '[warn] careful' },
      { fd: 2, text: '[error] boom' },
      { fd: 2, text: '[assert] bad state' },
    ], 'stderr records include expected prefixes');
  });

  it('captures groups and collapsed groups with indentation', (t) => {
    const records = captureConsole(() => {
      console.group('outer');
      console.log('inside');
      console.groupCollapsed('inner');
      console.log('deep');
      console.groupEnd();
      console.groupEnd();
    });

    t.deepEqual(records, [
      { fd: 1, text: 'outer' },
      { fd: 1, text: '  inside' },
      { fd: 1, text: '  inner' },
      { fd: 1, text: '    deep' },
    ], 'group indentation is captured');
  });

  it('captures counters and missing counter warnings', (t) => {
    const records = captureConsole(() => {
      console.count('capture-count');
      console.count('capture-count');
      console.countReset('capture-count');
      console.countReset('capture-count-missing');
    });

    t.deepEqual(records, [
      { fd: 1, text: 'capture-count: 1' },
      { fd: 1, text: 'capture-count: 2' },
      { fd: 2, text: "[warn] Count for 'capture-count-missing' does not exist" },
    ], 'counter records are captured');
  });

  it('captures timer output and missing timer warnings', (t) => {
    const records = captureConsole(() => {
      console.time('capture-timer');
      console.timeLog('capture-timer', 'half');
      console.timeEnd('capture-timer');
      console.timeEnd('capture-timer-missing');
    });

    t.equal(records.length, 3, 'three timer records');
    t.equal(records[0]!.fd, 1, 'timeLog uses stdout');
    t.ok(/^capture-timer: [0-9.]+ms half$/.test(records[0]!.text), 'timeLog includes elapsed and args');
    t.equal(records[1]!.fd, 1, 'timeEnd uses stdout');
    t.ok(/^capture-timer: [0-9.]+ms$/.test(records[1]!.text), 'timeEnd includes elapsed');
    t.deepEqual(records[2], {
      fd: 2,
      text: "[warn] Timer 'capture-timer-missing' does not exist",
    }, 'missing timer warning uses stderr');
  });

  it('captures table JSON output', (t) => {
    const records = captureConsole(() => {
      console.table([{ name: 'a', n: 1 }]);
    });

    t.equal(records.length, 1, 'one table record');
    t.equal(records[0]!.fd, 1, 'table uses stdout');
    t.equal(records[0]!.text, '[\n  {\n    "name": "a",\n    "n": 1\n  }\n]', 'table uses JSON output');
  });

  it('captures table fallback output when JSON serialization fails', (t) => {
    const row: any = { name: 'loop' };
    row.self = row;
    const records = captureConsole(() => {
      console.table(row);
    });

    t.deepEqual(records, [
      { fd: 1, text: '{ name: "loop", self: [Circular *] }' },
    ], 'table falls back to inspect output for circular data');
  });
});
