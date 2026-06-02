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

## suite

```ts
function suite(name: string, optsOrFn: GroupFn | RegisterOptions, maybeFn?: GroupFn): void
```

Register a group of tests. Can be nested inside other `suite()` calls.
Throws inside `describe()`.

## describe

```ts
function describe(name: string, optsOrFn: GroupFn | RegisterOptions, maybeFn?: GroupFn): void
```

Register a BDD-style test group with optional lifecycle hooks.
Can be nested inside other `describe()` calls.
Throws inside `suite()`.

## it

```ts
function it(name: string, optsOrFn: TestFn | RegisterOptions, maybeFn?: TestFn): void
```

Register a test case inside `describe()`. Throws outside `describe()`.

## before

```ts
function before(fn: HookFn): void
```

Run `fn` once before the first `it` in this `describe` block.
Throws outside `describe()`.

## after

```ts
function after(fn: HookFn): void
```

Run `fn` once after the last `it` in this `describe` block.
Always runs even if tests fail. Throws outside `describe()`.

## beforeEach

```ts
function beforeEach(fn: HookFn): void
```

Run `fn` before each `it` in this `describe` block.
Throws outside `describe()`.

## afterEach

```ts
function afterEach(fn: HookFn): void
```

Run `fn` after each `it` in this `describe` block.
Always runs even if the test fails. Throws outside `describe()`.

## run

```ts
async function run(options: RunOptions = {}): Promise<void>
```

Run all registered tests and print TAP-13 output.

Called automatically by the fino CLI in `--test` mode. User test files
only need to call `test()` / `suite()` / `describe()` — never `run()`.
