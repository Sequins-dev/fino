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

### callIndex

```ts
callIndex: number
```

### input

```ts
input: FetchInput
```

### init

```ts
init: FetchInit | undefined
```

### request

```ts
request: Request
```

### url

```ts
url: URL
```

### method

```ts
method: string
```

### headers

```ts
headers: Headers
```

### body

```ts
body: Uint8Array
```

### text

```ts
text: string
```

## MockFetchExpectation

```ts
class MockFetchExpectation {
```

Chainable expectation for one mocked fetch call pattern.

### constructor

```ts
constructor(expectation: FetchExpectation)
```

### header

```ts
header(name: string, matcher: HeaderMatcher): this
```

### body

```ts
body(matcher: BodyMatcher): this
```

### times

```ts
times(count: number): this
```

### once

```ts
once(): this
```

### twice

```ts
twice(): this
```

### reply

```ts
reply(status = 200, body?: unknown, init: { headers?: unknown; statusText?: string } = {}): this
```

### replyWith

```ts
replyWith(response: MockResponseFactory): this
```

## MockFetchScope

```ts
class MockFetchScope {
```

Scoped fetch mock that records calls and verifies queued expectations.

### constructor

```ts
constructor(baseUrl: string | URL | null = null)
```

### calls

```ts
get calls(): readonly MockFetchCall[]
```

### get

```ts
get(input: string | URL): MockFetchExpectation
```

### post

```ts
post(input: string | URL): MockFetchExpectation
```

### put

```ts
put(input: string | URL): MockFetchExpectation
```

### patch

```ts
patch(input: string | URL): MockFetchExpectation
```

### delete

```ts
delete(input: string | URL): MockFetchExpectation
```

### head

```ts
head(input: string | URL): MockFetchExpectation
```

### options

```ts
options(input: string | URL): MockFetchExpectation
```

### verify

```ts
verify(): void
```

### run

```ts
async run<T>(fn: (mock: MockFetchScope) => T | Promise<T>): Promise<T>
```

## mockFetch

```ts
async function mockFetch<T>( baseUrlOrFn: string | URL | ((mock: MockFetchScope) => T | Promise<T>), maybeFn?: (mock: MockFetchScope) => T | Promise<T>, ): Promise<T>
```

Temporarily replace global `fetch` while `fn` runs and verify expectations afterwards.
