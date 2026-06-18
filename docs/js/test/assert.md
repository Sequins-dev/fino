# assert

fino:assert — assertion library with configurable pass/fail callbacks.

This module provides the assertion primitives used by `fino:test`. It is
also usable as a standalone library for any code that needs structured
assertions.

The key design decision is that pass/fail behavior is injectable via
constructor callbacks rather than hard-coded. This allows `fino:test` to
use collect-then-throw semantics (all assertions run before any failure is
reported) while standalone users get the default throw-immediately behavior.

## The Assert class

`new Assert({ onPass, onFail })` creates a configurable assertion instance.

- `onPass`: called with no arguments on each passing assertion. Default is
  a no-op. `fino:test` uses this to count passing assertions.
- `onFail`: called with an `AssertionError` on each failing assertion.
  Default throws the error immediately. `fino:test` overrides this to
  push errors into an array for later `AggregateError` reporting.

Because both callbacks are injectable, a single `Assert` class handles
all use cases without subclassing.

## AssertionError

Extends `Error` with `actual`, `expected`, and `operator` fields, matching
the shape of Node.js's `assert.AssertionError`. The `operator` field
names the assertion that failed (e.g. `"equal"`, `"throws"`).

## Deep equality

`deepEqual(actual, expected)` uses `_deepEqual()`, which recursively
compares own enumerable keys of plain objects and arrays. It uses strict
equality (`===`) at the leaves and short-circuits on reference identity.
It does NOT handle:
- `Map`, `Set`, `Date`, `RegExp` — only plain `{}` and `[]`
- Symbol keys
- Non-enumerable properties

This covers the vast majority of test assertions. Add special cases if
concrete tests require them.

## throws / rejects

Both accept an optional `check` argument:
- If `check` is a function `(err) => boolean`, it must return true.
- If `check` is a RegExp, it is tested against `err.message`.
- If `check` is omitted, any throw/rejection passes.

## Default instance and named exports

A module-level `_default = new Assert()` instance is exported as the
default export and also as named free functions (`ok`, `equal`, `throws`,
etc.). This lets callers choose between:

```ts
import assert from './assert.mts';        // default instance
assert.ok(value);

import { ok, equal } from './assert.mts'; // named free functions
ok(value);
equal(got, expected);
```

```ts
import { Assert, AssertionError } from './assert.mts';

const assert = new Assert({
  onFail(err) { myFailures.push(err); },
});
assert.ok(value, 'must be truthy');
assert.equal(got, expected, 'same value');
assert.deepEqual({ a: 1 }, { a: 1 }, 'same shape');
await assert.rejects(async () => { throw new Error('oops'); }, /oops/);
```

## AssertionErrorOptions

```ts
interface AssertionErrorOptions {
```

Constructor options for `AssertionError`.

### message

```ts
message?: string
```

### actual

```ts
actual?: unknown
```

### expected

```ts
expected?: unknown
```

### operator

```ts
operator?: string
```

## AssertCallbacks

```ts
interface AssertCallbacks {
```

Callback hooks used by `Assert` to report pass and fail events.

### onPass

```ts
onPass?: () => void
```

### onFail

```ts
onFail?: (err: AssertionError) => void
```

## ErrorCheck

```ts
type ErrorCheck = ((e: unknown) => boolean) | RegExp | null
```

Matcher accepted by `throws()` and `rejects()`.

A function receives the thrown value and must return true. A regular
expression is tested against the error message. `null` and `undefined`
accept any thrown or rejected value.

## AssertionError

```ts
class AssertionError extends Error {
```

Error thrown by failed assertions, including actual, expected, and operator metadata.

Assertion methods create this error and either throw it immediately or pass
it to a custom `onFail` callback. The metadata fields are useful for TAP
output, custom reporters, and debugging failed test expectations.

```ts
import { AssertionError } from 'fino:test/assert';

const err = new AssertionError({
  message: 'expected count',
  actual: 1,
  expected: 2,
  operator: 'equal',
});
```

### constructor

```ts
constructor({ message, actual, expected, operator }: AssertionErrorOptions = {})
```

Create an assertion error.

Omitted fields stay `undefined`, and the message defaults to
`"Assertion failed"`. The constructor does not inspect or format values;
assertion methods prepare human-readable messages before constructing it.

```ts
import { AssertionError } from 'fino:test/assert';

throw new AssertionError({ message: 'custom failure', operator: 'fail' });
```

### actual

```ts
get actual()
```

Value produced by the code under test.

```ts
import { AssertionError } from 'fino:test/assert';

const err = new AssertionError({ actual: 1 });
err.actual; // 1
```

### expected

```ts
get expected()
```

Value the assertion expected.

```ts
import { AssertionError } from 'fino:test/assert';

const err = new AssertionError({ expected: 2 });
err.expected; // 2
```

### operator

```ts
get operator()
```

Assertion operator that failed, such as `equal` or `throws`.

```ts
import { AssertionError } from 'fino:test/assert';

const err = new AssertionError({ operator: 'equal' });
err.operator; // 'equal'
```

## Assert

```ts
class Assert {
```

Configurable assertion helper. Each method calls `onPass` on success or
`onFail(AssertionError)` on failure.

                                    Default: no-op.
                                    Default: throws the error.

```ts
import { Assert } from 'fino:test/assert';

const failures: Error[] = [];
const assert = new Assert({ onFail: (err) => failures.push(err) });
assert.ok(false);
failures.length; // 1
```

### constructor

```ts
constructor({ onPass, onFail }: AssertCallbacks = {})
```

Create an assertion helper with optional pass/fail callbacks.

The default `onFail` throws immediately. Test runners can collect errors by
providing `onFail` and count successful assertions with `onPass`.

```ts
import { Assert } from 'fino:test/assert';

let passed = 0;
const assert = new Assert({ onPass: () => passed++ });
assert.equal(1, 1);
```

### ok

```ts
ok(value: unknown, msg?: string): void
```

Assert that `value` is truthy.

Fails for JavaScript-falsy values (`false`, `0`, `''`, `null`,
`undefined`, and `NaN`). The optional message prefixes the generated
failure text.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.ok('non-empty');
```

### notOk

```ts
notOk(value: unknown, msg?: string): void
```

Assert that `value` is falsy.

Use this for explicit negative conditions. Passing a truthy value fails
with `operator` set to `notOk`.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.notOk('');
```

### equal

```ts
equal(actual: unknown, expected: unknown, msg?: string): void
```

Assert strict equality using `===`.

This does not coerce types and does not perform deep comparison. Use
`deepEqual()` for plain object or array structure checks.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.equal(1 + 1, 2);
```

### notEqual

```ts
notEqual(actual: unknown, expected: unknown, msg?: string): void
```

Assert strict inequality using `!==`.

Fails when the two values are strictly equal.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.notEqual('1', 1);
```

### deepEqual

```ts
deepEqual(actual: unknown, expected: unknown, msg?: string): void
```

Assert deep equality of plain objects and arrays.

The comparison walks own enumerable string keys and uses strict equality at
leaves. It intentionally does not special-case `Map`, `Set`, `Date`,
`RegExp`, symbol keys, or non-enumerable properties.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.deepEqual({ tags: ['a'] }, { tags: ['a'] });
```

### fail

```ts
fail(msg?: string): void
```

Unconditionally fail with a message.

This is useful for unreachable branches or callbacks that should not run.
The failure uses `operator` set to `fail`.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.fail('unreachable');
```

### throws

```ts
throws(fn: () => void, check?: ErrorCheck, msg?: string): void
```

Assert that `fn` throws synchronously. Optionally validate the thrown
value with a `check` function `(err) => boolean` or a RegExp tested
against `err.message`.

The function is called immediately and must throw before returning. Use
`rejects()` for promise-returning code.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
assert.throws(() => JSON.parse('{'), /JSON/);
```

### rejects

```ts
async rejects(fn: () => Promise<unknown>, check?: ErrorCheck, msg?: string): Promise<void>
```

Assert that `fn` returns a promise that rejects. Optionally validate the
rejection value with a `check` function or RegExp.

Must be awaited: `await assert.rejects(async () => { ... })`.

```ts
import { Assert } from 'fino:test/assert';

const assert = new Assert();
await assert.rejects(async () => {
  throw new Error('network');
}, /network/);
```

## ok

```ts
const ok
```

Assert that a value is truthy using the default `Assert` instance.

```ts
import { ok } from 'fino:test/assert';

ok(true);
```

## notOk

```ts
const notOk
```

Assert that a value is falsy using the default `Assert` instance.

```ts
import { notOk } from 'fino:test/assert';

notOk(false);
```

## equal

```ts
const equal
```

Assert strict equality using the default `Assert` instance.

```ts
import { equal } from 'fino:test/assert';

equal(1 + 1, 2);
```

## notEqual

```ts
const notEqual
```

Assert strict inequality using the default `Assert` instance.

```ts
import { notEqual } from 'fino:test/assert';

notEqual('1', 1);
```

## deepEqual

```ts
const deepEqual
```

Assert structural equality for plain object and array values.

```ts
import { deepEqual } from 'fino:test/assert';

deepEqual({ a: [1] }, { a: [1] });
```

## fail

```ts
const fail
```

Unconditionally fail an assertion.

```ts
import { fail } from 'fino:test/assert';

fail('expected branch not reached');
```

## throws

```ts
const throws
```

Assert that a synchronous function throws, optionally matching the error.

```ts
import { throws } from 'fino:test/assert';

throws(() => JSON.parse('{'), /JSON/);
```

## rejects

```ts
const rejects
```

Assert that an async function rejects, optionally matching the error.

```ts
import { rejects } from 'fino:test/assert';

await rejects(async () => { throw new Error('boom'); }, /boom/);
```
