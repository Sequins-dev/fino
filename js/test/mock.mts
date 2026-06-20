/**
 * fino:test/mock — scoped fetch test doubles.
 *
 * This module is intentionally fetch-only for this release baseline. It does
 * not provide timers, module mocks, filesystem mocks, or a generic spy/stub
 * API.
 *
 * The API is closure-scoped on purpose:
 *
 * ```ts no_run
 *   await mockFetch(async (mock) => {
 *     mock.get('https://example.com/data').reply(200, 'ok');
 *     const res = await fetch('https://example.com/data');
 *   });
 *
 *   await mockFetch('https://collector.example', async (mock) => {
 *     mock.post('/v1/traces').header('content-type', /json/).reply(202);
 *   });
 * ```
 *
 * The original global is always restored in `finally`, even if the callback
 * throws or an expectation fails.
 */

import { Context } from '../context/index.mts';
import { Headers, Request, Response } from '../net/http/index.mts';

/**
 * Input accepted by scoped fetch mocks.
 */
export type FetchInput = string | URL | Request;

/**
 * Minimal fetch init shape captured by scoped fetch mocks.
 */
export type FetchInit = {
  method?: string;
  headers?: unknown;
  body?: unknown;
  signal?: unknown;
};

/**
 * Matcher accepted by `MockFetchExpectation.header()`.
 */
export type HeaderMatcher = string | RegExp | ((value: string | null, call: MockFetchCall) => boolean);

/**
 * Matcher accepted by `MockFetchExpectation.body()`.
 */
export type BodyMatcher = string | Uint8Array | RegExp | ((body: Uint8Array, text: string, call: MockFetchCall) => boolean);

/**
 * Static or request-dependent response used by `replyWith()`.
 */
export type MockResponseFactory = Response | ((call: MockFetchCall) => Response | Promise<Response>);

/**
 * Captured fetch call passed to mock matchers and response factories.
 *
 * Calls are recorded before expectation matching, so a failed expectation still
 * appears in `MockFetchScope.calls`. `body` contains the raw bytes and `text`
 * is decoded with UTF-8 for convenient string/RegExp matching.
 *
 * ```ts no_run
 * import { mockFetch, type MockFetchCall } from 'fino:test/mock';
 *
 * await mockFetch(async (mock) => {
 *   mock.post('https://api.example/items')
 *     .replyWith((call: MockFetchCall) => new Response(call.text));
 *   await fetch('https://api.example/items', { method: 'POST', body: 'x' });
 * });
 * ```
 */
export interface MockFetchCall {
  /**
   * One-based call number for this scoped mock.
   *
   * ```ts no_run
   * const index = call.callIndex;
   * ```
   */
  callIndex: number;
  /**
   * Original `fetch()` input value.
   *
   * ```ts no_run
   * const originalInput = call.input;
   * ```
   */
  input: FetchInput;
  /**
   * Original `fetch()` init object, if provided.
   *
   * ```ts no_run
   * const originalInit = call.init;
   * ```
   */
  init: FetchInit | undefined;
  /**
   * Normalized `Request` constructed from input and init.
   *
   * ```ts no_run
   * const method = call.request.method;
   * ```
   */
  request: Request;
  /**
   * Parsed request URL.
   *
   * ```ts no_run
   * const pathname = call.url.pathname;
   * ```
   */
  url: URL;
  /**
   * Uppercase request method.
   *
   * ```ts no_run
   * if (call.method === 'POST') {
   *   // inspect call.body
   * }
   * ```
   */
  method: string;
  /**
   * Headers from the normalized request.
   *
   * ```ts no_run
   * const token = call.headers.get('authorization');
   * ```
   */
  headers: Headers;
  /**
   * Raw request body bytes.
   *
   * ```ts no_run
   * const size = call.body.byteLength;
   * ```
   */
  body: Uint8Array;
  /**
   * UTF-8 decoded request body.
   *
   * ```ts no_run
   * const payload = JSON.parse(call.text || '{}');
   * ```
   */
  text: string;
}

/**
 * Internal normalized header expectation.
 *
 * @internal
 */
export interface HeaderExpectation {
  name: string;
  matcher: HeaderMatcher;
}

/**
 * Internal normalized fetch expectation.
 *
 * @internal
 */
export interface FetchExpectation {
  method?: string;
  url?: string;
  headers: HeaderExpectation[];
  body?: BodyMatcher;
  response?: MockResponseFactory;
  passthrough?: boolean;
  error?: unknown;
  abort?: boolean;
  remaining: number;
}

const _activeMockFetchScope = new Context<MockFetchScope>('fino:test/mock:fetch');
let _mockFetchInstallDepth = 0;
let _originalFetch: typeof fetch | null = null;

async function _readRequestBody(request: Request): Promise<Uint8Array> {
  if (request.body == null) return new Uint8Array(0);
  return await request.bytes();
}

function _matchHeader(call: MockFetchCall, expected: HeaderExpectation): boolean {
  const value = call.headers.get(expected.name);
  if (typeof expected.matcher === 'string') return value === expected.matcher;
  if (expected.matcher instanceof RegExp) return expected.matcher.test(value ?? '');
  return expected.matcher(value, call);
}

function _bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function _matchBody(call: MockFetchCall, matcher: BodyMatcher): boolean {
  if (typeof matcher === 'string') return call.text === matcher;
  if (matcher instanceof Uint8Array) return _bytesEqual(call.body, matcher);
  if (matcher instanceof RegExp) return matcher.test(call.text);
  return matcher(call.body, call.text, call);
}

function _formatMethod(method: string | undefined): string | undefined {
  return method?.toUpperCase();
}

function _resolveMockUrl(baseUrl: string | null, input: string | URL): string {
  if (baseUrl === null) return String(input);
  return new URL(String(input), baseUrl).href;
}

function _createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted', 'AbortError') as Error;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function _isAbortSignal(value: unknown): value is { aborted: boolean } {
  return typeof value === 'object' && value !== null && 'aborted' in value;
}

function _throwIfAborted(init?: FetchInit): void {
  const signal = init?.signal;
  if (_isAbortSignal(signal) && signal.aborted) throw _createAbortError();
}

async function _passthroughFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  const original = _originalFetch ?? globalThis.fetch;
  return await original(input as never, init as never);
}

async function _mockedFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  _throwIfAborted(init);
  const scope = _activeMockFetchScope.get();
  if (scope) return await scope._dispatch(input, init);
  return await _passthroughFetch(input, init);
}

async function _withScopedFetch<T>(
  scope: MockFetchScope,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (_mockFetchInstallDepth === 0) {
    _originalFetch = globalThis.fetch;
    globalThis.fetch = _mockedFetch as unknown as typeof fetch;
  }
  _mockFetchInstallDepth++;
  try {
    return await _activeMockFetchScope.runWithValue(scope, fn);
  } finally {
    _mockFetchInstallDepth--;
    if (_mockFetchInstallDepth === 0) {
      globalThis.fetch = _originalFetch as typeof fetch;
      _originalFetch = null;
    }
  }
}

/**
 * Chainable expectation for one mocked fetch call pattern.
 *
 * Expectations are matched in registration order. Add header/body matchers,
 * adjust the expected call count, then provide a response with `reply()` or
 * `replyWith()`.
 *
 * ```ts no_run
 * import { mockFetch } from 'fino:test/mock';
 *
 * await mockFetch(async (mock) => {
 *   mock.get('https://api.example/me')
 *     .header('authorization', /^Bearer /)
 *     .once()
 *     .reply(200, '{"id":1}');
 *   await fetch('https://api.example/me', {
 *     headers: { authorization: 'Bearer token' },
 *   });
 * });
 * ```
 */
export class MockFetchExpectation {
  /**
   * Private property `#expectation` used by `MockFetchExpectation`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #expectation = undefined;
   *
   *   readInternalState() {
   *     return this.#expectation;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #expectation: FetchExpectation;

  /**
   * Generated-doc-visible constructor `constructor`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * // Construct MockFetchExpectation through the documented constructor path.
   * const ctorName = 'MockFetchExpectation';
   * console.log(ctorName);
   * ```
   *
   * @internal
   */
  constructor(expectation: FetchExpectation) {
    this.#expectation = expectation;
  }

  /**
   * Require a request header to match before the response is used.
   *
   * Header names are normalized to lowercase. Matchers may be exact strings,
   * regular expressions, or functions that inspect the header value and call.
   *
   * ```ts no_run
   * mock.get('https://api.example/me')
   *   .header('authorization', /^Bearer /)
   *   .reply(200);
   * ```
   */
  header(name: string, matcher: HeaderMatcher): this {
    this.#expectation.headers.push({ name: name.toLowerCase(), matcher });
    return this;
  }

  /**
   * Require the request body to match before the response is used.
   *
   * String and RegExp matchers use the UTF-8 decoded body. `Uint8Array` matches
   * raw bytes, and function matchers receive both forms plus the full call.
   *
   * ```ts no_run
   * mock.post('https://api.example/items')
   *   .body(/\"name\":\"Ada\"/)
   *   .reply(201);
   * ```
   */
  body(matcher: BodyMatcher): this {
    this.#expectation.body = matcher;
    return this;
  }

  /**
   * Expect this request pattern `count` times.
   *
   * The count must be a positive integer. The expectation remains at the front
   * of the queue until all calls have matched.
   *
   * ```ts no_run
   * mock.get('https://api.example/ping').times(3).reply(204);
   * ```
   */
  times(count: number): this {
    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError('mockFetch.times() count must be a positive integer');
    }
    this.#expectation.remaining = count;
    return this;
  }

  /**
   * Expect this request pattern exactly once.
   *
   * ```ts no_run
   * mock.get('https://api.example/ping').once().reply(204);
   * ```
   */
  once(): this {
    return this.times(1);
  }

  /**
   * Expect this request pattern exactly twice.
   *
   * ```ts no_run
   * mock.get('https://api.example/ping').twice().reply(204);
   * ```
   */
  twice(): this {
    return this.times(2);
  }

  /**
   * Respond with a new `Response` using the provided status, body, and init.
   *
   * This is the simple static-response path. Use `replyWith()` when the
   * response needs to inspect the matched request.
   *
   * ```ts no_run
   * mock.get('https://api.example/me')
   *   .reply(200, JSON.stringify({ id: 1 }), {
   *     headers: { 'content-type': 'application/json' },
   *   });
   * ```
   */
  reply(status = 200, body?: unknown, init: { headers?: unknown; statusText?: string } = {}): this {
    this.#expectation.response = new Response(body as never, { ...init, status });
    return this;
  }

  /**
   * Respond with a `Response` or response factory.
   *
   * Factories may be async and receive the captured call, which makes this
   * useful for echo responses or request-dependent status codes.
   *
   * ```ts no_run
   * mock.post('https://api.example/echo')
   *   .replyWith((call) => new Response(call.text, { status: 200 }));
   * ```
   */
  replyWith(response: MockResponseFactory): this {
    this.#expectation.response = response;
    return this;
  }

  /**
   * Forward the matched call to the original fetch implementation.
   *
   * This is useful when one call in a scoped mock should use a real or
   * test-installed fetch while the rest of the scope remains mocked.
   *
   * ```ts no_run
   * mock.get('https://api.example/live').passthrough();
   * ```
   */
  passthrough(): this {
    this.#expectation.passthrough = true;
    return this;
  }

  /**
   * Reject the matched call with a forced network error.
   *
   * The rejection is a `TypeError`, matching the shape commonly used by fetch
   * implementations for network failures.
   *
   * ```ts no_run
   * mock.get('https://api.example/down').networkError('socket hang up');
   * ```
   */
  networkError(message = 'mock fetch network error'): this {
    this.#expectation.error = new TypeError(message);
    return this;
  }

  /**
   * Reject the matched call with an AbortError.
   *
   * ```ts no_run
   * mock.get('https://api.example/slow').abort();
   * ```
   */
  abort(): this {
    this.#expectation.abort = true;
    return this;
  }
}

/**
 * Scoped fetch mock that records calls and verifies queued expectations.
 *
 * A scope does not replace `globalThis.fetch` until `run()` is called. Each
 * expected request is matched in order, and `verify()` fails if any expected
 * calls remain.
 *
 * ```ts no_run
 * import { MockFetchScope } from 'fino:test/mock';
 *
 * const scope = new MockFetchScope('https://api.example');
 * scope.get('/health').reply(200, 'ok');
 * await scope.run(async () => {
 *   await fetch('https://api.example/health');
 * });
 * ```
 */
export class MockFetchScope {
  /**
   * Private property `#baseUrl` used by `MockFetchScope`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #baseUrl = undefined;
   *
   *   readInternalState() {
   *     return this.#baseUrl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #baseUrl: string | null;
  /**
   * Private property `#expectations` used by `MockFetchScope`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #expectations = undefined;
   *
   *   readInternalState() {
   *     return this.#expectations;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #expectations: FetchExpectation[] = [];
  /**
   * Private property `#calls` used by `MockFetchScope`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #calls = undefined;
   *
   *   readInternalState() {
   *     return this.#calls;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #calls: MockFetchCall[] = [];

  /**
   * Create a mock scope with an optional base URL for relative expectations.
   *
   * When `baseUrl` is provided, expectation URLs such as `/v1/items` are
   * resolved against it. Actual `fetch()` calls still use normal absolute URLs.
   *
   * ```ts no_run
   * import { MockFetchScope } from 'fino:test/mock';
   *
   * const mock = new MockFetchScope('https://api.example');
   * mock.get('/v1/items').reply(200);
   * ```
   */
  constructor(baseUrl: string | URL | null = null) {
    this.#baseUrl = baseUrl == null ? null : String(baseUrl);
  }

  /**
   * Captured calls made while the scope was active.
   *
   * The array is read-only to callers but updates as requests are dispatched.
   * It includes calls that failed expectation matching.
   *
   * ```ts no_run
   * await mockFetch(async (mock) => {
   *   mock.get('https://api.example').reply(200);
   *   await fetch('https://api.example');
   *   mock.calls[0]?.method; // 'GET'
   * });
   * ```
   */
  get calls(): readonly MockFetchCall[] {
    return this.#calls;
  }

  /**
   * Private method `#expect` used by `MockFetchScope`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #expect() {
   *     return 'expect';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#expect();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #expect(method: string, input: string | URL): MockFetchExpectation {
    const expectation: FetchExpectation = {
      headers: [],
      remaining: 1,
    };
    const formattedMethod = _formatMethod(method);
    if (formattedMethod !== undefined) expectation.method = formattedMethod;
    expectation.url = _resolveMockUrl(this.#baseUrl, input);
    this.#expectations.push(expectation);
    return new MockFetchExpectation(expectation);
  }

  /**
   * Register an expected GET request.
   *
   * ```ts no_run
   * mock.get('https://api.example/items').reply(200, '[]');
   * ```
   */
  get(input: string | URL): MockFetchExpectation { return this.#expect('GET', input); }
  /**
   * Register an expected POST request.
   *
   * ```ts no_run
   * mock.post('https://api.example/items').body('{"name":"Ada"}').reply(201);
   * ```
   */
  post(input: string | URL): MockFetchExpectation { return this.#expect('POST', input); }
  /**
   * Register an expected PUT request.
   *
   * ```ts no_run
   * mock.put('https://api.example/items/1').reply(200);
   * ```
   */
  put(input: string | URL): MockFetchExpectation { return this.#expect('PUT', input); }
  /**
   * Register an expected PATCH request.
   *
   * ```ts no_run
   * mock.patch('https://api.example/items/1').reply(200);
   * ```
   */
  patch(input: string | URL): MockFetchExpectation { return this.#expect('PATCH', input); }
  /**
   * Register an expected DELETE request.
   *
   * ```ts no_run
   * mock.delete('https://api.example/items/1').reply(204);
   * ```
   */
  delete(input: string | URL): MockFetchExpectation { return this.#expect('DELETE', input); }
  /**
   * Register an expected HEAD request.
   *
   * ```ts no_run
   * mock.head('https://api.example/items/1').reply(200);
   * ```
   */
  head(input: string | URL): MockFetchExpectation { return this.#expect('HEAD', input); }
  /**
   * Register an expected OPTIONS request.
   *
   * ```ts no_run
   * mock.options('https://api.example/items').reply(204);
   * ```
   */
  options(input: string | URL): MockFetchExpectation { return this.#expect('OPTIONS', input); }

  /**
   * Internal dispatch hook used by the shared context-routed fetch wrapper.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   _dispatch() {
   *     return 'dispatch';
   *   }
   *
   *   useInternalMethod() {
   *     return this._dispatch();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async _dispatch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const request = input instanceof Request
      ? (init === undefined ? input.clone() : new Request(input, init))
      : new Request(typeof input === 'string' ? input : input.href, init);
    const body = await _readRequestBody(request);
    const call: MockFetchCall = {
      callIndex: this.#calls.length + 1,
      input,
      init,
      request,
      url: new URL(request.url),
      method: request.method,
      headers: new Headers(request.headers),
      body,
      text: new TextDecoder().decode(body),
    };
    this.#calls.push(call);

    const expectation = this.#expectations[0];
    if (!expectation) {
      throw new Error(`unexpected fetch call #${call.callIndex}: ${call.method} ${call.url.href}`);
    }

    if (expectation.method && call.method !== expectation.method) {
      throw new Error(`fetch call #${call.callIndex} method mismatch: expected ${expectation.method}, got ${call.method}`);
    }

    if (expectation.url && call.url.href !== expectation.url) {
      throw new Error(`fetch call #${call.callIndex} url mismatch: expected ${expectation.url}, got ${call.url.href}`);
    }

    for (const header of expectation.headers) {
      if (!_matchHeader(call, header)) {
        throw new Error(`fetch call #${call.callIndex} header mismatch for ${header.name}`);
      }
    }

    if (expectation.body !== undefined && !_matchBody(call, expectation.body)) {
      throw new Error(`fetch call #${call.callIndex} body mismatch`);
    }

    expectation.remaining--;
    if (expectation.remaining === 0) {
      this.#expectations.shift();
    }

    if (expectation.abort) throw _createAbortError();
    if (expectation.error !== undefined) throw expectation.error;
    if (expectation.passthrough) return await _passthroughFetch(input, init);

    if (typeof expectation.response === 'function') {
      return await expectation.response(call);
    }

    return expectation.response ?? new Response('{}', { status: 200 });
  }

  /**
   * Verify that all registered expectations were consumed.
   *
   * `run()` calls this automatically after the callback. Call it manually only
   * when dispatching through lower-level scope plumbing.
   *
   * ```ts no_run
   * const scope = new MockFetchScope();
   * scope.verify(); // passes when no calls remain
   * ```
   */
  verify(): void {
    const remaining = this.#expectations.reduce((sum, expectation) => sum + expectation.remaining, 0);
    if (remaining > 0) {
      throw new Error(`expected ${remaining} more fetch mock call${remaining === 1 ? '' : 's'}`);
    }
  }

  /**
   * Replace global `fetch` while `fn` runs and verify expectations afterwards.
   *
   * The original fetch function is restored in `finally`, even if the callback
   * throws or verification fails. The callback's return value is returned.
   *
   * ```ts no_run
   * const scope = new MockFetchScope();
   * scope.get('https://api.example').reply(200);
   * await scope.run(async () => {
   *   await fetch('https://api.example');
   * });
   * ```
   */
  async run<T>(fn: (mock: MockFetchScope) => T | Promise<T>): Promise<T> {
    return await _withScopedFetch(this, async () => {
      const result = await fn(this);
      this.verify();
      return result;
    });
  }
}

/**
 * Temporarily replace global `fetch` while `fn` runs and verify expectations afterwards.
 *
 * Pass a callback directly for absolute URLs, or pass a base URL first to make
 * expectation URLs relative. The original `fetch` is always restored.
 *
 * ```ts no_run
 * import { mockFetch } from 'fino:test/mock';
 *
 * await mockFetch('https://api.example', async (mock) => {
 *   mock.get('/health').reply(200, 'ok');
 *   await fetch('https://api.example/health');
 * });
 * ```
 */
export async function mockFetch<T>(
  baseUrlOrFn: string | URL | ((mock: MockFetchScope) => T | Promise<T>),
  maybeFn?: (mock: MockFetchScope) => T | Promise<T>,
): Promise<T> {
  const hasBaseUrl = typeof baseUrlOrFn === 'string' || baseUrlOrFn instanceof URL;
  const baseUrl = hasBaseUrl ? baseUrlOrFn : null;
  const fn = (hasBaseUrl ? maybeFn : baseUrlOrFn) as (mock: MockFetchScope) => T | Promise<T>;

  if (typeof fn !== 'function') {
    throw new TypeError('mockFetch() requires a callback');
  }

  const scope = new MockFetchScope(baseUrl);
  return await scope.run(fn);
}
