/**
 * fino:assert — assertion library with configurable pass/fail callbacks.
 *
 * This module provides the assertion primitives used by `fino:test`. It is
 * also usable as a standalone library for any code that needs structured
 * assertions.
 *
 * The key design decision is that pass/fail behavior is injectable via
 * constructor callbacks rather than hard-coded. This allows `fino:test` to
 * use collect-then-throw semantics (all assertions run before any failure is
 * reported) while standalone users get the default throw-immediately behavior.
 *
 *
 * ## The Assert class
 *
 * `new Assert({ onPass, onFail })` creates a configurable assertion instance.
 *
 * - `onPass`: called with no arguments on each passing assertion. Default is
 *   a no-op. `fino:test` uses this to count passing assertions.
 * - `onFail`: called with an `AssertionError` on each failing assertion.
 *   Default throws the error immediately. `fino:test` overrides this to
 *   push errors into an array for later `AggregateError` reporting.
 *
 * Because both callbacks are injectable, a single `Assert` class handles
 * all use cases without subclassing.
 *
 *
 * ## AssertionError
 *
 * Extends `Error` with `actual`, `expected`, and `operator` fields, matching
 * the shape of Node.js's `assert.AssertionError`. The `operator` field
 * names the assertion that failed (e.g. `"equal"`, `"throws"`).
 *
 *
 * ## Deep equality
 *
 * `deepEqual(actual, expected)` uses `_deepEqual()`, which recursively
 * compares own enumerable keys of plain objects and arrays. It uses strict
 * equality (`===`) at the leaves and short-circuits on reference identity.
 * It does NOT handle:
 * - `Map`, `Set`, `Date`, `RegExp` — only plain `{}` and `[]`
 * - Symbol keys
 * - Non-enumerable properties
 *
 * This covers the vast majority of test assertions. Add special cases if
 * concrete tests require them.
 *
 *
 * ## throws / rejects
 *
 * Both accept an optional `check` argument:
 * - If `check` is a function `(err) => boolean`, it must return true.
 * - If `check` is a RegExp, it is tested against `err.message`.
 * - If `check` is omitted, any throw/rejection passes.
 *
 *
 * ## Default instance and named exports
 *
 * A module-level `_default = new Assert()` instance is exported as the
 * default export and also as named free functions (`ok`, `equal`, `throws`,
 * etc.). This lets callers choose between:
 *
 * ```ts no_run
 *   import assert from './assert.mts';        // default instance
 *   assert.ok(value);
 *
 *   import { ok, equal } from './assert.mts'; // named free functions
 *   ok(value);
 *   equal(got, expected);
 * ```
 *
 *
 * ```ts no_run
 * import { Assert, AssertionError } from './assert.mts';
 *
 * const assert = new Assert({
 *   onFail(err) { myFailures.push(err); },
 * });
 * assert.ok(value, 'must be truthy');
 * assert.equal(got, expected, 'same value');
 * assert.deepEqual({ a: 1 }, { a: 1 }, 'same shape');
 * await assert.rejects(async () => { throw new Error('oops'); }, /oops/);
 * ```
 */

// ---------------------------------------------------------------------------
// AssertionError
// ---------------------------------------------------------------------------

/**
 * Thrown (or passed to `onFail`) when an assertion fails.
 *
 * Mirrors the Node.js AssertionError shape: `actual`, `expected`, `operator`.
 */
interface AssertionErrorOptions {
  message?: string;
  actual?: unknown;
  expected?: unknown;
  operator?: string;
}

interface AssertCallbacks {
  onPass?: () => void;
  onFail?: (err: AssertionError) => void;
}

type ErrorCheck = ((e: unknown) => boolean) | RegExp | null;
type IndexableRecord = Record<string, unknown>;

function _isRecord(value: unknown): value is IndexableRecord {
  return typeof value === 'object' && value !== null;
}

function _messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (_isRecord(err) && typeof err.message === 'string') return err.message;
  return String(err);
}

/**
 * Error thrown by failed assertions, including actual, expected, and operator metadata.
 *
 * Assertion methods create this error and either throw it immediately or pass
 * it to a custom `onFail` callback. The metadata fields are useful for TAP
 * output, custom reporters, and debugging failed test expectations.
 *
 * ```ts no_run
 * import { AssertionError } from 'fino:test/assert';
 *
 * const err = new AssertionError({
 *   message: 'expected count',
 *   actual: 1,
 *   expected: 2,
 *   operator: 'equal',
 * });
 * ```
 */
export class AssertionError extends Error {
  /**
   * Private property `#actual` used by `AssertionError`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #actual = undefined;
   *
   *   readInternalState() {
   *     return this.#actual;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #actual: unknown;
  /**
   * Private property `#expected` used by `AssertionError`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #expected = undefined;
   *
   *   readInternalState() {
   *     return this.#expected;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #expected: unknown;
  /**
   * Private property `#operator` used by `AssertionError`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #operator = undefined;
   *
   *   readInternalState() {
   *     return this.#operator;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #operator: string | undefined;

  /**
   * Create an assertion error.
   *
   * Omitted fields stay `undefined`, and the message defaults to
   * `"Assertion failed"`. The constructor does not inspect or format values;
   * assertion methods prepare human-readable messages before constructing it.
   *
   * ```ts no_run
   * import { AssertionError } from 'fino:test/assert';
   *
   * throw new AssertionError({ message: 'custom failure', operator: 'fail' });
   * ```
   */
  constructor({ message, actual, expected, operator }: AssertionErrorOptions = {}) {
    super(message || 'Assertion failed');
    this.name = 'AssertionError';
    this.#actual   = actual;
    this.#expected = expected;
    this.#operator = operator;
  }

  /**
   * Value produced by the code under test.
   *
   * ```ts no_run
   * import { AssertionError } from 'fino:test/assert';
   *
   * const err = new AssertionError({ actual: 1 });
   * err.actual; // 1
   * ```
   */
  get actual()   { return this.#actual;   }
  /**
   * Value the assertion expected.
   *
   * ```ts no_run
   * import { AssertionError } from 'fino:test/assert';
   *
   * const err = new AssertionError({ expected: 2 });
   * err.expected; // 2
   * ```
   */
  get expected() { return this.#expected; }
  /**
   * Assertion operator that failed, such as `equal` or `throws`.
   *
   * ```ts no_run
   * import { AssertionError } from 'fino:test/assert';
   *
   * const err = new AssertionError({ operator: 'equal' });
   * err.operator; // 'equal'
   * ```
   */
  get operator() { return this.#operator; }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _fmt(v: unknown): string {
  if (v === null)      return 'null';
  if (v === undefined) return 'undefined';
  const type = typeof v;
  if (type === 'bigint') return v.toString() + 'n';
  if (type === 'string') return JSON.stringify(v);
  if (type === 'object') {
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
}

function _deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (!_isRecord(a) || !_isRecord(b)) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!_deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Validate a thrown/rejected value against a check function or RegExp. */
function _checkErr(err: unknown, check: Exclude<ErrorCheck, null>): boolean {
  if (typeof check === 'function') return check(err);
  if (check instanceof RegExp)     return check.test(_messageOf(err));
  return true;
}

// ---------------------------------------------------------------------------
// Assert class
// ---------------------------------------------------------------------------

/**
 * Configurable assertion helper. Each method calls `onPass` on success or
 * `onFail(AssertionError)` on failure.
 *
 * @param {object}   [options]
 * @param {function} [options.onPass]  Called with no args on a passing assertion.
 *                                     Default: no-op.
 * @param {function} [options.onFail]  Called with AssertionError on a failing assertion.
 *                                     Default: throws the error.
 *
 * ```ts no_run
 * import { Assert } from 'fino:test/assert';
 *
 * const failures: Error[] = [];
 * const assert = new Assert({ onFail: (err) => failures.push(err) });
 * assert.ok(false);
 * failures.length; // 1
 * ```
 */
export class Assert {
  /**
   * Private property `#onPass` used by `Assert`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onPass = undefined;
   *
   *   readInternalState() {
   *     return this.#onPass;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onPass: () => void;
  /**
   * Private property `#onFail` used by `Assert`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onFail = undefined;
   *
   *   readInternalState() {
   *     return this.#onFail;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onFail: (err: AssertionError) => void;

  /**
   * Create an assertion helper with optional pass/fail callbacks.
   *
   * The default `onFail` throws immediately. Test runners can collect errors by
   * providing `onFail` and count successful assertions with `onPass`.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * let passed = 0;
   * const assert = new Assert({ onPass: () => passed++ });
   * assert.equal(1, 1);
   * ```
   */
  constructor({ onPass, onFail }: AssertCallbacks = {}) {
    this.#onPass = onPass || function noopPass() {};
    this.#onFail = onFail || function defaultFail(err) { throw err; };
  }

  /**
   * Private method `#pass` used by `Assert`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pass() {
   *     return 'pass';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#pass();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pass() {
    this.#onPass();
  }

  /**
   * Private method `#fail` used by `Assert`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fail() {
   *     return 'fail';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#fail();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fail(message: string, actual: unknown, expected: unknown, operator: string): void {
    this.#onFail(new AssertionError({ message, actual, expected, operator }));
  }

  /**
   * Assert that `value` is truthy.
   *
   * Fails for JavaScript-falsy values (`false`, `0`, `''`, `null`,
   * `undefined`, and `NaN`). The optional message prefixes the generated
   * failure text.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.ok('non-empty');
   * ```
   */
  ok(value: unknown, msg?: string): void {
    if (value) {
      this.#pass();
    } else {
      this.#fail(
        (msg || 'ok') + ': expected truthy, got ' + _fmt(value),
        value, true, 'ok',
      );
    }
  }

  /**
   * Assert that `value` is falsy.
   *
   * Use this for explicit negative conditions. Passing a truthy value fails
   * with `operator` set to `notOk`.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.notOk('');
   * ```
   */
  notOk(value: unknown, msg?: string): void {
    if (!value) {
      this.#pass();
    } else {
      this.#fail(
        (msg || 'notOk') + ': expected falsy, got ' + _fmt(value),
        value, false, 'notOk',
      );
    }
  }

  /**
   * Assert strict equality using `===`.
   *
   * This does not coerce types and does not perform deep comparison. Use
   * `deepEqual()` for plain object or array structure checks.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.equal(1 + 1, 2);
   * ```
   */
  equal(actual: unknown, expected: unknown, msg?: string): void {
    if (actual === expected) {
      this.#pass();
    } else {
      this.#fail(
        (msg || 'equal') + ': expected ' + _fmt(expected) + ', got ' + _fmt(actual),
        actual, expected, 'equal',
      );
    }
  }

  /**
   * Assert strict inequality using `!==`.
   *
   * Fails when the two values are strictly equal.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.notEqual('1', 1);
   * ```
   */
  notEqual(actual: unknown, expected: unknown, msg?: string): void {
    if (actual !== expected) {
      this.#pass();
    } else {
      this.#fail(
        (msg || 'notEqual') + ': expected !== ' + _fmt(expected) + ', but got the same value',
        actual, expected, 'notEqual',
      );
    }
  }

  /**
   * Assert deep equality of plain objects and arrays.
   *
   * The comparison walks own enumerable string keys and uses strict equality at
   * leaves. It intentionally does not special-case `Map`, `Set`, `Date`,
   * `RegExp`, symbol keys, or non-enumerable properties.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.deepEqual({ tags: ['a'] }, { tags: ['a'] });
   * ```
   */
  deepEqual(actual: unknown, expected: unknown, msg?: string): void {
    if (_deepEqual(actual, expected)) {
      this.#pass();
    } else {
      this.#fail(
        (msg || 'deepEqual') + ': expected ' + _fmt(expected) + ', got ' + _fmt(actual),
        actual, expected, 'deepEqual',
      );
    }
  }

  /**
   * Unconditionally fail with a message.
   *
   * This is useful for unreachable branches or callbacks that should not run.
   * The failure uses `operator` set to `fail`.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.fail('unreachable');
   * ```
   */
  fail(msg?: string): void {
    this.#fail(msg || 'fail called', undefined, undefined, 'fail');
  }

  /**
   * Assert that `fn` throws synchronously. Optionally validate the thrown
   * value with a `check` function `(err) => boolean` or a RegExp tested
   * against `err.message`.
   *
   * The function is called immediately and must throw before returning. Use
   * `rejects()` for promise-returning code.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * assert.throws(() => JSON.parse('{'), /JSON/);
   * ```
   */
  throws(fn: () => void, check?: ErrorCheck, msg?: string): void {
    let threw = false;
    let thrownErr;
    try {
      fn();
    } catch (err) {
      threw = true;
      thrownErr = err;
    }
    if (!threw) {
      this.#fail(
        (msg || 'throws') + ': expected an exception to be thrown',
        undefined, undefined, 'throws',
      );
      return;
    }
    if (check && !_checkErr(thrownErr, check)) {
      this.#fail(
        (msg || 'throws') + ': thrown value did not satisfy check: ' + _fmt(thrownErr),
        thrownErr, check, 'throws',
      );
      return;
    }
    this.#pass();
  }

  /**
   * Assert that `fn` returns a promise that rejects. Optionally validate the
   * rejection value with a `check` function or RegExp.
   *
   * Must be awaited: `await assert.rejects(async () => { ... })`.
   *
   * ```ts no_run
   * import { Assert } from 'fino:test/assert';
   *
   * const assert = new Assert();
   * await assert.rejects(async () => {
   *   throw new Error('network');
   * }, /network/);
   * ```
   */
  async rejects(fn: () => Promise<unknown>, check?: ErrorCheck, msg?: string): Promise<void> {
    let rejected = false;
    let rejectedWith;
    try {
      await fn();
    } catch (err) {
      rejected = true;
      rejectedWith = err;
    }
    if (!rejected) {
      this.#fail(
        (msg || 'rejects') + ': expected a rejection but promise resolved',
        undefined, undefined, 'rejects',
      );
      return;
    }
    if (check && !_checkErr(rejectedWith, check)) {
      this.#fail(
        (msg || 'rejects') + ': rejection did not satisfy check: ' + _fmt(rejectedWith),
        rejectedWith, check, 'rejects',
      );
      return;
    }
    this.#pass();
  }
}

// ---------------------------------------------------------------------------
// Default instance + named exports
// ---------------------------------------------------------------------------

/** Default Assert instance — throws AssertionError on failure. */
const _default = new Assert();

export default _default;

/**
 * Assert that a value is truthy using the default `Assert` instance.
 *
 * ```ts no_run
 * import { ok } from 'fino:test/assert';
 *
 * ok(true);
 * ```
 */
export const ok = (value: unknown, msg?: string): void => _default.ok(value, msg);
/**
 * Assert that a value is falsy using the default `Assert` instance.
 *
 * ```ts no_run
 * import { notOk } from 'fino:test/assert';
 *
 * notOk(false);
 * ```
 */
export const notOk = (value: unknown, msg?: string): void => _default.notOk(value, msg);
/**
 * Assert strict equality using the default `Assert` instance.
 *
 * ```ts no_run
 * import { equal } from 'fino:test/assert';
 *
 * equal(1 + 1, 2);
 * ```
 */
export const equal = (actual: unknown, expected: unknown, msg?: string): void => _default.equal(actual, expected, msg);
/**
 * Assert strict inequality using the default `Assert` instance.
 *
 * ```ts no_run
 * import { notEqual } from 'fino:test/assert';
 *
 * notEqual('1', 1);
 * ```
 */
export const notEqual = (actual: unknown, expected: unknown, msg?: string): void => _default.notEqual(actual, expected, msg);
/**
 * Assert structural equality for plain object and array values.
 *
 * ```ts no_run
 * import { deepEqual } from 'fino:test/assert';
 *
 * deepEqual({ a: [1] }, { a: [1] });
 * ```
 */
export const deepEqual = (actual: unknown, expected: unknown, msg?: string): void => _default.deepEqual(actual, expected, msg);
/**
 * Unconditionally fail an assertion.
 *
 * ```ts no_run
 * import { fail } from 'fino:test/assert';
 *
 * fail('expected branch not reached');
 * ```
 */
export const fail = (msg?: string): void => _default.fail(msg);
/**
 * Assert that a synchronous function throws, optionally matching the error.
 *
 * ```ts no_run
 * import { throws } from 'fino:test/assert';
 *
 * throws(() => JSON.parse('{'), /JSON/);
 * ```
 */
export const throws = (fn: () => void, check?: ErrorCheck, msg?: string): void => _default.throws(fn, check, msg);
/**
 * Assert that an async function rejects, optionally matching the error.
 *
 * ```ts no_run
 * import { rejects } from 'fino:test/assert';
 *
 * await rejects(async () => { throw new Error('boom'); }, /boom/);
 * ```
 */
export const rejects = (fn: () => Promise<unknown>, check?: ErrorCheck, msg?: string): Promise<void> => _default.rejects(fn, check, msg);
