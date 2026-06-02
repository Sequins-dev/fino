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

## AssertionError

```ts
class AssertionError extends Error {
```

Error thrown by failed assertions, including actual, expected, and operator metadata.

### constructor

```ts
constructor({ message, actual, expected, operator }: AssertionErrorOptions = {})
```

### actual

```ts
get actual()
```

### expected

```ts
get expected()
```

### operator

```ts
get operator()
```

## Assert

```ts
class Assert {
```

Configurable assertion helper. Each method calls `onPass` on success or
`onFail(AssertionError)` on failure.

                                    Default: no-op.
                                    Default: throws the error.

### constructor

```ts
constructor({ onPass, onFail }: AssertCallbacks = {})
```

### ok

```ts
ok(value: unknown, msg?: string): void
```

Assert that `value` is truthy.

### notOk

```ts
notOk(value: unknown, msg?: string): void
```

Assert that `value` is falsy.

### equal

```ts
equal(actual: unknown, expected: unknown, msg?: string): void
```

Assert strict equality (===).

### notEqual

```ts
notEqual(actual: unknown, expected: unknown, msg?: string): void
```

Assert strict inequality (!==).

### deepEqual

```ts
deepEqual(actual: unknown, expected: unknown, msg?: string): void
```

Assert deep equality of two plain objects/arrays.

### fail

```ts
fail(msg?: string): void
```

Unconditionally fail with a message.

### throws

```ts
throws(fn: () => void, check?: ErrorCheck, msg?: string): void
```

Assert that `fn` throws synchronously. Optionally validate the thrown
value with a `check` function `(err) => boolean` or a RegExp tested
against `err.message`.

### rejects

```ts
async rejects(fn: () => Promise<unknown>, check?: ErrorCheck, msg?: string): Promise<void>
```

Assert that `fn` returns a promise that rejects. Optionally validate the
rejection value with a `check` function or RegExp.

Must be awaited: `await assert.rejects(async () => { ... })`.

## ok

```ts
const ok
```

Assert that a value is truthy.

## notOk

```ts
const notOk
```

Assert that a value is falsy.

## equal

```ts
const equal
```

Assert strict equality with `Object.is` semantics.

## notEqual

```ts
const notEqual
```

Assert strict inequality with `Object.is` semantics.

## deepEqual

```ts
const deepEqual
```

Assert structural equality for plain object and array-like values.

## fail

```ts
const fail
```

Unconditionally fail an assertion.

## throws

```ts
const throws
```

Assert that a synchronous function throws, optionally matching the error.

## rejects

```ts
const rejects
```

Assert that an async function rejects, optionally matching the error.
