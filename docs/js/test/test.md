# js/test/test

fino:test — TAP-13 test framework with nesting and BDD-style describe/it.

Two equivalent but non-mixable patterns:

  **Pattern 1: suite + test**

```js
import { test, suite } from './test.mts';

test('standalone', (t) => { t.ok(true); });

suite('math', () => {
  test('adds', (t) => { t.equal(1 + 1, 2); });
  test('subs', (t) => { t.equal(2 - 1, 1); });
});
```

  **Pattern 2: describe + it + lifecycle hooks**

```js
import { describe, it } from './test.mts';

describe('math', () => {
  before(async () => { ... });       // once, before first it
  beforeEach(async () => { ... });   // before each it
  afterEach(async () => { ... });    // after each it (always runs)
  after(async () => { ... });        // once, after last it (always runs)

  it('adds', (t) => { t.equal(1 + 1, 2); });
  it('subs', (t) => { t.equal(2 - 1, 1); });
});
```

Mixing is forbidden: `it()` inside `suite()`, `test()` inside `describe()`,
`suite()` inside `describe()`, or `describe()` inside `suite()` all throw.
`it()` and hook functions throw if used at the top level.

## TAP-13 output

Nested groups produce standard TAP subtests (indented 4 spaces per level):

  TAP version 13
  1..2
  ok 1 - standalone
  # Subtest: math
      1..2
      ok 1 - adds
      ok 2 - subs
  ok 2 - math
  # tests 2
  # pass  2

## Internal representation

Both APIs share a tree of nodes:

  Leaf:  { name, fn, children: null, skip: string|null }
  Group: { name, kind: 'suite'|'describe', children: [],
           before, beforeEach, after, afterEach,
           skip: string|null }

`_current` points at the group being registered into (`null` = top level).
The unified runner `_runEntries(entries, depth, parentNode)` recurses the tree,
applying hooks from `parentNode` to each leaf inside a `describe` group.

## test

```ts
function test(name: string, optsOrFn: TestFn | RegisterOptions, maybeFn?: TestFn): void
```

Register a test case. Can be top-level or inside `suite()`.
Throws inside `describe()`.

The callback receives an `Assert` instance that collects all assertion
failures before the runner reports the test result. Pass `{ skip: true }` or
`{ skip: 'reason' }` as the middle argument to mark the test skipped.

```ts
import { test } from 'fino:test/test';

test('adds numbers', (t) => {
  t.equal(1 + 1, 2);
});
```

## suite

```ts
function suite(name: string, optsOrFn: GroupFn | RegisterOptions, maybeFn?: GroupFn): void
```

Register a group of tests. Can be nested inside other `suite()` calls.
Throws inside `describe()`.

Suites are grouping-only; they do not support lifecycle hooks. Use
`describe()` when tests need `before`, `after`, `beforeEach`, or
`afterEach`.

```ts
import { suite, test } from 'fino:test/test';

suite('math', () => {
  test('adds', (t) => t.equal(1 + 1, 2));
});
```

## describe

```ts
function describe(name: string, optsOrFn: GroupFn | RegisterOptions, maybeFn?: GroupFn): void
```

Register a BDD-style test group with optional lifecycle hooks.
Can be nested inside other `describe()` calls.
Throws inside `suite()`.

The registration callback runs immediately and should only register tests and
hooks. Runtime work belongs inside `it()` callbacks or lifecycle hooks.

```ts
import { describe, it } from 'fino:test/test';

describe('api', () => {
  it('responds', (t) => t.ok(true));
});
```

## it

```ts
function it(name: string, optsOrFn: TestFn | RegisterOptions, maybeFn?: TestFn): void
```

Register a test case inside `describe()`. Throws outside `describe()`.

The callback may be synchronous or async and receives the same assertion
helper used by `test()`. A parent `describe({ skip })` propagates to all
child `it()` calls.

```ts
import { describe, it } from 'fino:test/test';

describe('user lookup', () => {
  it('returns a user', async (t) => {
    t.ok(await Promise.resolve({ id: 1 }));
  });
});
```

## before

```ts
function before(fn: HookFn): void
```

Run `fn` once before the first `it` in this `describe` block.
Throws outside `describe()`.

A failing `before()` marks each entry in the group failed. Use it for shared
setup that every test in the block requires.

```ts
import { before, describe, it } from 'fino:test/test';

describe('database', () => {
  before(async () => {
    // connect
  });
  it('queries', (t) => t.ok(true));
});
```

## after

```ts
function after(fn: HookFn): void
```

Run `fn` once after the last `it` in this `describe` block.
Always runs even if tests fail. Throws outside `describe()`.

Errors thrown by `after()` are swallowed so cleanup does not mask test
failures. Keep assertions inside `it()` or `afterEach()` when failures should
be reported.

```ts
import { after, describe, it } from 'fino:test/test';

describe('server', () => {
  after(async () => {
    // close server
  });
  it('starts', (t) => t.ok(true));
});
```

## beforeEach

```ts
function beforeEach(fn: HookFn): void
```

Run `fn` before each `it` in this `describe` block.
Throws outside `describe()`.

If `beforeEach()` fails, the test body is skipped and the entry is reported
failed. Use it for per-test state that must be fresh.

```ts
import { beforeEach, describe, it } from 'fino:test/test';

describe('counter', () => {
  let value = 0;
  beforeEach(() => { value = 0; });
  it('increments', (t) => t.equal(++value, 1));
});
```

## afterEach

```ts
function afterEach(fn: HookFn): void
```

Run `fn` after each `it` in this `describe` block.
Always runs even if the test fails. Throws outside `describe()`.

Failures from `afterEach()` are collected with assertion failures from the
same test. Use it for cleanup that should be visible when it fails.

```ts
import { afterEach, describe, it } from 'fino:test/test';

describe('temp files', () => {
  afterEach(async () => {
    // remove temp files
  });
  it('writes', (t) => t.ok(true));
});
```

## run

```ts
async function run(options: RunOptions = {}): Promise<void>
```

Run all registered tests and print TAP-13 output.

Called automatically by the fino CLI in `--test` mode. User test files
only need to call `test()` / `suite()` / `describe()` — never `run()`.

```ts
import { run, test } from 'fino:test/test';

test('manual runner', (t) => t.ok(true));
await run({ filter: 'manual' });
```
