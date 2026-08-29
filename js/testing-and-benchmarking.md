---
weight: 50
---
# Testing and Benchmarking

Fino includes its own test and benchmark modules so runtime features can be
tested without depending on another JavaScript runtime. Tests emit TAP-13.
Benchmarks use adaptive measurement loops and print throughput-oriented results.

## Writing Tests

Use `test` for standalone cases or grouped `suite` tests:

```ts
import { suite, test } from 'fino:test/test';

suite('math', () => {
  test('adds numbers', (t) => {
    t.equal(1 + 1, 2);
  });

  test('supports async work', async (t) => {
    const value = await Promise.resolve('ready');
    t.equal(value, 'ready');
  });
});
```

Use `describe` and `it` when lifecycle hooks make the test clearer:

```ts
import { beforeEach, describe, it } from 'fino:test/test';

describe('cache', () => {
  let cache: Map<string, string>;

  beforeEach(() => {
    cache = new Map();
  });

  it('stores values', (t) => {
    cache.set('name', 'fino');
    t.equal(cache.get('name'), 'fino');
  });
});
```

Do not mix the two grouping styles in the same group. Use `suite` with `test`,
or use `describe` with `it` and lifecycle hooks.

The runner provides TAP-13 output, `--filter` name matching, skip reasons,
`before`/`after`/`beforeEach`/`afterEach` hooks, and captured stdout/stderr for
failures. It is not a Node `node:test` compatibility layer, so `only`, `todo`,
per-test timeouts, assertion-object subtests, and pluggable reporters are not
included. Serial runs execute groups sequentially; `--parallel` may overlap
top-level groups from different file Realms while preserving their TAP output
blocks and serial semantics within each file.

Use `fino test --parallel` to run each matched file in an isolated Realm. A
rolling window retains at most the configured concurrency of file Realms;
finishing one file admits the next in discovery order. The default admission
limit is ten top-level groups per reactor thread, and `FINO_TEST_CONCURRENCY`
sets that positive-integer per-reactor amount. `FINO_REACTOR_THREADS` controls
the pool size, which otherwise reserves one online processor for main-thread
coordination while retaining at least two reactors on multi-processor hosts. At
most one group per file Realm executes at a time. Structured group results are
buffered and merged into one
top-level TAP stream in completion order by default. Each group emits as an
atomic block as soon as it settles. Pass `--ordered` to emit those blocks in
deterministic registration order instead. The aggregate plan is emitted at the
end, after every rolling registration is known. Failure details follow the
final summary, and process-level stdout/stderr is suppressed so raw Realm or
child process writes cannot interleave with TAP.

Groups that exercise process-global state or strict scheduling deadlines can
use `{ exclusive: true }`. The parallel runner drains active work before the
containing top-level group starts, runs it alone, and resumes ordinary bounded
admission as soon as it settles.

## Running Tests

Run specific files:

```sh
fino test tests/net/serve.test.ts
```

Run all tests in a directory:

```sh
fino test tests/net
```

Filter by registered test name:

```sh
fino test --filter websocket tests/net
```

Directory arguments expand to `*.test.ts` files. Keep tests close to the
system they cover: networking tests under `tests/net`, runtime tests under
`tests/runtime`, file tests under `tests/file`, and so on.

## Assertions

The test callback receives an assertion object:

```ts
test('response status', async (t) => {
  const response = new Response('created', { status: 201 });

  t.equal(response.status, 201);
  t.ok(response.headers instanceof Headers);
});
```

Prefer focused assertions that describe the behavior being protected. Broad
end-to-end tests are useful for integration paths, but narrow regression tests
are easier to diagnose.

## Mocks

Use mock helpers when the behavior under test depends on replaceable runtime
APIs. Keep the mocked surface small. Scoped helpers restore the original
behavior when the callback finishes.

```ts
import { test } from 'fino:test/test';
import { mockFetch } from 'fino:test/mock';

test('fetches data', async (t) => {
  await mockFetch(async (mock) => {
    mock
      .get('https://example.com/data')
      .reply(200, JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });

    const response = await fetch('https://example.com/data');
    const data = await response.json();

    t.equal(data.ok, true);
    t.equal(mock.calls.length, 1);
  });
});
```

## Writing Benchmarks

Benchmarks register named measurements:

```ts
import { bench } from 'fino:test/bench';
import { parse } from 'fino:format/csv';

bench('csv', (b) => {
  const source = 'name,count\nalpha,1\nbeta,2\n';

  b.measure('parse with headers', () => {
    parse(source, { header: true });
  });
});
```

Use setup and teardown when resource creation should not be part of the timed
body:

```ts
b.measure('lookup', {
  setup() {
    return new Map([['name', 'fino']]);
  },
  fn(cache) {
    cache.get('name');
  },
});
```

Run benchmarks in the same environment when comparing performance:

```sh
fino bench benchmarks
```

The benchmark harness prints human, benc.h-style text output. It uses an
adaptive minimum-duration measurement loop and supports sync or async measured
functions plus setup/teardown outside the timed body. It does not currently
provide JSON output, machine-readable result objects, public warmup or
fixed-iteration controls, fixed sample counts, variance thresholds, pluggable
reporters, or CI regression gates.

Use stable machines for numbers you intend to keep or compare.

## Testing AI Behavior

Prompts, tool routing, and agent behavior are tested with evals, which run as
ordinary test cases with scorers and reporters. See
[Evals and OpenTelemetry](./ai/evals-opentelemetry.md).
