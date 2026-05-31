/**
 * fino:test/mock — scoped test doubles for runtime globals and builtins.
 *
 * This module starts with fetch mocking, but the structure is intentionally
 * generic so more scoped mocks can live here later without inventing another
 * ad-hoc test surface.
 *
 * The API is closure-scoped on purpose:
 *
 * ```ts
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

import { Headers, Request, Response } from '../net/http.mts';

type FetchInput = string | URL | Request;
type FetchInit = {
  method?: string;
  headers?: unknown;
  body?: unknown;
  signal?: unknown;
};
type HeaderMatcher = string | RegExp | ((value: string | null, call: MockFetchCall) => boolean);
type BodyMatcher = string | Uint8Array | RegExp | ((body: Uint8Array, text: string, call: MockFetchCall) => boolean);
type MockResponseFactory = Response | ((call: MockFetchCall) => Response | Promise<Response>);

export interface MockFetchCall {
  callIndex: number;
  input: FetchInput;
  init: FetchInit | undefined;
  request: Request;
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array;
  text: string;
}

interface HeaderExpectation {
  name: string;
  matcher: HeaderMatcher;
}

interface FetchExpectation {
  method?: string;
  url?: string;
  headers: HeaderExpectation[];
  body?: BodyMatcher;
  response?: MockResponseFactory;
  remaining: number;
}

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

async function _withScopedFetch<T>(
  replacement: (input: FetchInput, init?: FetchInit) => Promise<Response>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

export class MockFetchExpectation {
  #expectation: FetchExpectation;

  constructor(expectation: FetchExpectation) {
    this.#expectation = expectation;
  }

  header(name: string, matcher: HeaderMatcher): this {
    this.#expectation.headers.push({ name: name.toLowerCase(), matcher });
    return this;
  }

  body(matcher: BodyMatcher): this {
    this.#expectation.body = matcher;
    return this;
  }

  times(count: number): this {
    if (!Number.isInteger(count) || count < 1) {
      throw new TypeError('mockFetch.times() count must be a positive integer');
    }
    this.#expectation.remaining = count;
    return this;
  }

  once(): this {
    return this.times(1);
  }

  twice(): this {
    return this.times(2);
  }

  reply(status = 200, body?: unknown, init: { headers?: unknown; statusText?: string } = {}): this {
    this.#expectation.response = new Response(body as never, { ...init, status });
    return this;
  }

  replyWith(response: MockResponseFactory): this {
    this.#expectation.response = response;
    return this;
  }
}

export class MockFetchScope {
  #baseUrl: string | null;
  #expectations: FetchExpectation[] = [];
  #calls: MockFetchCall[] = [];

  constructor(baseUrl: string | URL | null = null) {
    this.#baseUrl = baseUrl == null ? null : String(baseUrl);
  }

  get calls(): readonly MockFetchCall[] {
    return this.#calls;
  }

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

  get(input: string | URL): MockFetchExpectation { return this.#expect('GET', input); }
  post(input: string | URL): MockFetchExpectation { return this.#expect('POST', input); }
  put(input: string | URL): MockFetchExpectation { return this.#expect('PUT', input); }
  patch(input: string | URL): MockFetchExpectation { return this.#expect('PATCH', input); }
  delete(input: string | URL): MockFetchExpectation { return this.#expect('DELETE', input); }
  head(input: string | URL): MockFetchExpectation { return this.#expect('HEAD', input); }
  options(input: string | URL): MockFetchExpectation { return this.#expect('OPTIONS', input); }

  async #dispatch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const request = input instanceof Request
      ? new Request(input, init)
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

    if (typeof expectation.response === 'function') {
      return await expectation.response(call);
    }

    return expectation.response ?? new Response('{}', { status: 200 });
  }

  verify(): void {
    const remaining = this.#expectations.reduce((sum, expectation) => sum + expectation.remaining, 0);
    if (remaining > 0) {
      throw new Error(`expected ${remaining} more fetch mock call${remaining === 1 ? '' : 's'}`);
    }
  }

  async run<T>(fn: (mock: MockFetchScope) => T | Promise<T>): Promise<T> {
    return await _withScopedFetch(this.#dispatch.bind(this), async () => {
      const result = await fn(this);
      this.verify();
      return result;
    });
  }
}

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
