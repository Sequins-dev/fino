# mock

fino:test/mock — scoped test doubles for runtime globals and builtins.

This module starts with fetch mocking, but the structure is intentionally
generic so more scoped mocks can live here later without inventing another
ad-hoc test surface.

The API is closure-scoped on purpose:

```ts
await mockFetch(async (mock) => {
  mock.get('https://example.com/data').reply(200, 'ok');
  const res = await fetch('https://example.com/data');
});

await mockFetch('https://collector.example', async (mock) => {
  mock.post('/v1/traces').header('content-type', /json/).reply(202);
});
```

The original global is always restored in `finally`, even if the callback
throws or an expectation fails.

## MockFetchCall

```ts
interface MockFetchCall {
```

Captured fetch call passed to mock matchers and response factories.

Calls are recorded before expectation matching, so a failed expectation still
appears in `MockFetchScope.calls`. `body` contains the raw bytes and `text`
is decoded with UTF-8 for convenient string/RegExp matching.

```ts
import { mockFetch, type MockFetchCall } from 'fino:test/mock';

await mockFetch(async (mock) => {
  mock.post('https://api.example/items')
    .replyWith((call: MockFetchCall) => new Response(call.text));
  await fetch('https://api.example/items', { method: 'POST', body: 'x' });
});
```

### callIndex

```ts
callIndex: number
```

One-based call number for this scoped mock.

```ts
const index = call.callIndex;
```

### input

```ts
input: FetchInput
```

Original `fetch()` input value.

```ts
const originalInput = call.input;
```

### init

```ts
init: FetchInit | undefined
```

Original `fetch()` init object, if provided.

```ts
const originalInit = call.init;
```

### request

```ts
request: Request
```

Normalized `Request` constructed from input and init.

```ts
const method = call.request.method;
```

### url

```ts
url: URL
```

Parsed request URL.

```ts
const pathname = call.url.pathname;
```

### method

```ts
method: string
```

Uppercase request method.

```ts
if (call.method === 'POST') {
  // inspect call.body
}
```

### headers

```ts
headers: Headers
```

Headers from the normalized request.

```ts
const token = call.headers.get('authorization');
```

### body

```ts
body: Uint8Array
```

Raw request body bytes.

```ts
const size = call.body.byteLength;
```

### text

```ts
text: string
```

UTF-8 decoded request body.

```ts
const payload = JSON.parse(call.text || '{}');
```

## MockFetchExpectation

```ts
class MockFetchExpectation {
```

Chainable expectation for one mocked fetch call pattern.

Expectations are matched in registration order. Add header/body matchers,
adjust the expected call count, then provide a response with `reply()` or
`replyWith()`.

```ts
import { mockFetch } from 'fino:test/mock';

await mockFetch(async (mock) => {
  mock.get('https://api.example/me')
    .header('authorization', /^Bearer /)
    .once()
    .reply(200, '{"id":1}');
  await fetch('https://api.example/me', {
    headers: { authorization: 'Bearer token' },
  });
});
```

### header

```ts
header(name: string, matcher: HeaderMatcher): this
```

Require a request header to match before the response is used.

Header names are normalized to lowercase. Matchers may be exact strings,
regular expressions, or functions that inspect the header value and call.

```ts
mock.get('https://api.example/me')
  .header('authorization', /^Bearer /)
  .reply(200);
```

### body

```ts
body(matcher: BodyMatcher): this
```

Require the request body to match before the response is used.

String and RegExp matchers use the UTF-8 decoded body. `Uint8Array` matches
raw bytes, and function matchers receive both forms plus the full call.

```ts
mock.post('https://api.example/items')
  .body(/\"name\":\"Ada\"/)
  .reply(201);
```

### times

```ts
times(count: number): this
```

Expect this request pattern `count` times.

The count must be a positive integer. The expectation remains at the front
of the queue until all calls have matched.

```ts
mock.get('https://api.example/ping').times(3).reply(204);
```

### once

```ts
once(): this
```

Expect this request pattern exactly once.

```ts
mock.get('https://api.example/ping').once().reply(204);
```

### twice

```ts
twice(): this
```

Expect this request pattern exactly twice.

```ts
mock.get('https://api.example/ping').twice().reply(204);
```

### reply

```ts
reply(status = 200, body?: unknown, init: { headers?: unknown; statusText?: string } = {}): this
```

Respond with a new `Response` using the provided status, body, and init.

This is the simple static-response path. Use `replyWith()` when the
response needs to inspect the matched request.

```ts
mock.get('https://api.example/me')
  .reply(200, JSON.stringify({ id: 1 }), {
    headers: { 'content-type': 'application/json' },
  });
```

### replyWith

```ts
replyWith(response: MockResponseFactory): this
```

Respond with a `Response` or response factory.

Factories may be async and receive the captured call, which makes this
useful for echo responses or request-dependent status codes.

```ts
mock.post('https://api.example/echo')
  .replyWith((call) => new Response(call.text, { status: 200 }));
```

## MockFetchScope

```ts
class MockFetchScope {
```

Scoped fetch mock that records calls and verifies queued expectations.

A scope does not replace `globalThis.fetch` until `run()` is called. Each
expected request is matched in order, and `verify()` fails if any expected
calls remain.

```ts
import { MockFetchScope } from 'fino:test/mock';

const scope = new MockFetchScope('https://api.example');
scope.get('/health').reply(200, 'ok');
await scope.run(async () => {
  await fetch('https://api.example/health');
});
```

### constructor

```ts
constructor(baseUrl: string | URL | null = null)
```

Create a mock scope with an optional base URL for relative expectations.

When `baseUrl` is provided, expectation URLs such as `/v1/items` are
resolved against it. Actual `fetch()` calls still use normal absolute URLs.

```ts
import { MockFetchScope } from 'fino:test/mock';

const mock = new MockFetchScope('https://api.example');
mock.get('/v1/items').reply(200);
```

### calls

```ts
get calls(): readonly MockFetchCall[]
```

Captured calls made while the scope was active.

The array is read-only to callers but updates as requests are dispatched.
It includes calls that failed expectation matching.

```ts
await mockFetch(async (mock) => {
  mock.get('https://api.example').reply(200);
  await fetch('https://api.example');
  mock.calls[0]?.method; // 'GET'
});
```

### get

```ts
get(input: string | URL): MockFetchExpectation
```

Register an expected GET request.

```ts
mock.get('https://api.example/items').reply(200, '[]');
```

### post

```ts
post(input: string | URL): MockFetchExpectation
```

Register an expected POST request.

```ts
mock.post('https://api.example/items').body('{"name":"Ada"}').reply(201);
```

### put

```ts
put(input: string | URL): MockFetchExpectation
```

Register an expected PUT request.

```ts
mock.put('https://api.example/items/1').reply(200);
```

### patch

```ts
patch(input: string | URL): MockFetchExpectation
```

Register an expected PATCH request.

```ts
mock.patch('https://api.example/items/1').reply(200);
```

### delete

```ts
delete(input: string | URL): MockFetchExpectation
```

Register an expected DELETE request.

```ts
mock.delete('https://api.example/items/1').reply(204);
```

### head

```ts
head(input: string | URL): MockFetchExpectation
```

Register an expected HEAD request.

```ts
mock.head('https://api.example/items/1').reply(200);
```

### options

```ts
options(input: string | URL): MockFetchExpectation
```

Register an expected OPTIONS request.

```ts
mock.options('https://api.example/items').reply(204);
```

### verify

```ts
verify(): void
```

Verify that all registered expectations were consumed.

`run()` calls this automatically after the callback. Call it manually only
when dispatching through lower-level scope plumbing.

```ts
const scope = new MockFetchScope();
scope.verify(); // passes when no calls remain
```

### run

```ts
async run<T>(fn: (mock: MockFetchScope) => T | Promise<T>): Promise<T>
```

Replace global `fetch` while `fn` runs and verify expectations afterwards.

The original fetch function is restored in `finally`, even if the callback
throws or verification fails. The callback's return value is returned.

```ts
const scope = new MockFetchScope();
scope.get('https://api.example').reply(200);
await scope.run(async () => {
  await fetch('https://api.example');
});
```

## mockFetch

```ts
async function mockFetch<T>( baseUrlOrFn: string | URL | ((mock: MockFetchScope) => T | Promise<T>), maybeFn?: (mock: MockFetchScope) => T | Promise<T>, ): Promise<T>
```

Temporarily replace global `fetch` while `fn` runs and verify expectations afterwards.

Pass a callback directly for absolute URLs, or pass a base URL first to make
expectation URLs relative. The original `fetch` is always restored.

```ts
import { mockFetch } from 'fino:test/mock';

await mockFetch('https://api.example', async (mock) => {
  mock.get('/health').reply(200, 'ok');
  await fetch('https://api.example/health');
});
```
