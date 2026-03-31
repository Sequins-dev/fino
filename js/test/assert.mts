/**
 * boats:assert — assertion library with configurable pass/fail callbacks.
 *
 * This module provides the assertion primitives used by `boats:test`. It is
 * also usable as a standalone library for any code that needs structured
 * assertions.
 *
 * The key design decision is that pass/fail behavior is injectable via
 * constructor callbacks rather than hard-coded. This allows `boats:test` to
 * use collect-then-throw semantics (all assertions run before any failure is
 * reported) while standalone users get the default throw-immediately behavior.
 *
 *
 * ## The Assert class
 *
 * `new Assert({ onPass, onFail })` creates a configurable assertion instance.
 *
 * - `onPass`: called with no arguments on each passing assertion. Default is
 *   a no-op. `boats:test` uses this to count passing assertions.
 * - `onFail`: called with an `AssertionError` on each failing assertion.
 *   Default throws the error immediately. `boats:test` overrides this to
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
 *   import assert from 'boats:test/assert';        // default instance
 *   assert.ok(value);
 *
 *   import { ok, equal } from 'boats:test/assert'; // named free functions
 *   ok(value);
 *   equal(got, expected);
 *
 *
 * @example
 * import { Assert, AssertionError } from 'boats:test/assert';
 *
 * const assert = new Assert({
 *   onFail(err) { myFailures.push(err); },
 * });
 * assert.ok(value, 'must be truthy');
 * assert.equal(got, expected, 'same value');
 * assert.deepEqual({ a: 1 }, { a: 1 }, 'same shape');
 * await assert.rejects(async () => { throw new Error('oops'); }, /oops/);
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

export class AssertionError extends Error {
  #actual: unknown;
  #expected: unknown;
  #operator: string | undefined;

  constructor({ message, actual, expected, operator }: AssertionErrorOptions = {}) {
    super(message || 'Assertion failed');
    this.name = 'AssertionError';
    this.#actual   = actual;
    this.#expected = expected;
    this.#operator = operator;
  }

  get actual()   { return this.#actual;   }
  get expected() { return this.#expected; }
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
  if (typeof a !== 'object') return false;

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
function _checkErr(err: unknown, check: ((e: unknown) => boolean) | RegExp): boolean {
  if (typeof check === 'function') return check(err);
  if (check instanceof RegExp)     return check.test(err && err.message);
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
 */
export class Assert {
  #onPass: () => void;
  #onFail: (err: AssertionError) => void;

  constructor({ onPass, onFail }: AssertCallbacks = {}) {
    this.#onPass = onPass || (() => {});
    this.#onFail = onFail || ((err) => { throw err; });
  }

  #pass() {
    this.#onPass();
  }

  #fail(message, actual, expected, operator) {
    this.#onFail(new AssertionError({ message, actual, expected, operator }));
  }

  /** Assert that `value` is truthy. */
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

  /** Assert that `value` is falsy. */
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

  /** Assert strict equality (===). */
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

  /** Assert strict inequality (!==). */
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

  /** Assert deep equality of two plain objects/arrays. */
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

  /** Unconditionally fail with a message. */
  fail(msg?: string): void {
    this.#fail(msg || 'fail called', undefined, undefined, 'fail');
  }

  /**
   * Assert that `fn` throws synchronously. Optionally validate the thrown
   * value with a `check` function `(err) => boolean` or a RegExp tested
   * against `err.message`.
   */
  throws(fn: () => void, check?: ((e: unknown) => boolean) | RegExp, msg?: string): void {
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
   */
  async rejects(fn: () => Promise<unknown>, check?: ((e: unknown) => boolean) | RegExp, msg?: string): Promise<void> {
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

export const ok        = (value, msg)            => _default.ok(value, msg);
export const notOk     = (value, msg)            => _default.notOk(value, msg);
export const equal     = (actual, expected, msg) => _default.equal(actual, expected, msg);
export const notEqual  = (actual, expected, msg) => _default.notEqual(actual, expected, msg);
export const deepEqual = (actual, expected, msg) => _default.deepEqual(actual, expected, msg);
export const fail      = (msg)                   => _default.fail(msg);
export const throws    = (fn, check, msg)        => _default.throws(fn, check, msg);
export const rejects   = (fn, check, msg)        => _default.rejects(fn, check, msg);
