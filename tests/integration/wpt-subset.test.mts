/**
 * Web Platform Tests subset runner.
 *
 * This is a pinned in-repository fixture subset for web-global behavior Fino
 * currently supports. The adapter accepts `testharness.js`-style `.any.js`
 * source, discovers `test()` and `promise_test()` subtests, and registers every
 * subtest as its own Fino test using the WPT path plus subtest name.
 *
 * Browser-only policy and lifecycle areas are intentionally outside this lane:
 * cookies, BFCache, mixed content, navigation, DOM document integration,
 * service workers, XHR, and browser CORS policy.
 */

import { describe, it, after } from 'fino:test/test';
import { serve } from 'fino:net/http/server';
import { WPT_SUBSET, type WptFixture } from './fixtures/wpt-subset.mts';

interface HarnessSubtest {
  name: string;
  promise: boolean;
}

interface HarnessAssert {
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
  throws(fn: () => unknown, matcher?: RegExp | null, message?: string): void;
}

interface WptContext {
  wsUrl: string;
  collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array>;
  event(target: EventTarget, name: string): Promise<any>;
}

const websocketFixturePath = 'websockets/';
let wsServer: ReturnType<typeof serve> | null = null;
let wsSkip: string | false = false;

try {
  wsServer = serve({ port: 0 }, async (incoming) => {
    if (incoming.kind !== 'websocket') {
      await incoming.reject(new Response('', { status: 404 }));
      return;
    }
    const ws = await incoming.accept();
    (async () => {
      for await (const message of ws) {
        if (message.type === 'text' || message.type === 'binary') ws.send(message.data as any);
      }
    })().catch(() => {});
  });
} catch (err) {
  wsSkip = `requires loopback WebSocket server (${err instanceof Error ? err.message : String(err)})`;
}

const wptContext: WptContext = {
  wsUrl: wsServer ? `ws://127.0.0.1:${wsServer.port}/` : 'ws://127.0.0.1:0/',
  async collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  },
  event(target: EventTarget, name: string): Promise<any> {
    return new Promise((resolve) => target.addEventListener(name, resolve as EventListener, { once: true }));
  },
};

function discoverSubtests(fixture: WptFixture): HarnessSubtest[] {
  const subtests: HarnessSubtest[] = [];
  evaluateHarness(fixture.source, {
    test(_fn: () => unknown, name: string) {
      subtests.push({ name, promise: false });
    },
    promise_test(_fn: () => Promise<unknown>, name: string) {
      subtests.push({ name, promise: true });
    },
  });
  return subtests;
}

async function runSubtest(fixture: WptFixture, name: string, assert: HarnessAssert): Promise<void> {
  let found = false;
  const harness = {
    test(fn: () => unknown, subtestName: string) {
      if (subtestName !== name) return;
      found = true;
      fn();
    },
    async promise_test(fn: () => Promise<unknown>, subtestName: string) {
      if (subtestName !== name) return;
      found = true;
      await fn();
    },
  };
  const pending = evaluateHarness(fixture.source, harness, assert);
  await Promise.all(pending);
  if (!found) throw new Error(`WPT subtest not found: ${fixture.path} - ${name}`);
}

function evaluateHarness(
  source: string,
  harness: {
    test(fn: () => unknown, name: string): unknown;
    promise_test(fn: () => Promise<unknown>, name: string): unknown;
  },
  assert: HarnessAssert = throwingAssert,
): Promise<unknown>[] {
  const pending: Promise<unknown>[] = [];
  const test = harness.test;
  const promise_test = (fn: () => Promise<unknown>, name: string) => {
    const result = harness.promise_test(fn, name);
    if (result instanceof Promise) pending.push(result);
  };
  const fn = new Function(
    'test',
    'promise_test',
    'assert_equals',
    'assert_true',
    'assert_false',
    'assert_array_equals',
    'assert_throws_js',
    '__wpt',
    source,
  );
  fn(
    test,
    promise_test,
    (actual: unknown, expected: unknown, message?: string) => assert.equal(actual, expected, message),
    (value: unknown, message?: string) => assert.ok(value, message),
    (value: unknown, message?: string) => assert.equal(value, false, message),
    (actual: unknown, expected: unknown, message?: string) => assert.deepEqual(actual, expected, message),
    (constructor: Function, callback: () => unknown, message?: string) => {
      assert.throws(callback, null, message);
      try {
        callback();
      } catch (err) {
        if (!(err instanceof (constructor as any))) {
          throw new Error(message ?? `expected ${constructor.name}, got ${err instanceof Error ? err.name : typeof err}`);
        }
      }
    },
    wptContext,
  );
  return pending;
}

const throwingAssert: HarnessAssert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  ok(value: unknown, message?: string) {
    if (!value) throw new Error(message ?? `expected truthy value, got ${String(value)}`);
  },
  throws(fn: () => unknown, matcher?: RegExp | null, message?: string) {
    try {
      fn();
    } catch (err) {
      if (matcher && !matcher.test(err instanceof Error ? err.message : String(err))) {
        throw new Error(message ?? `throw message did not match ${matcher}`);
      }
      return;
    }
    throw new Error(message ?? 'expected function to throw');
  },
};

function subtestSkip(fixture: WptFixture): string | false {
  if (fixture.path.startsWith(websocketFixturePath)) return wsSkip;
  return false;
}

describe('WPT subset — web globals', () => {
  after(async () => {
    if (wsServer !== null) await wsServer.close();
  });

  for (const fixture of WPT_SUBSET) {
    describe(`${fixture.area} — ${fixture.path}`, () => {
      for (const subtest of discoverSubtests(fixture)) {
        it(subtest.name, { skip: subtestSkip(fixture) }, async (t) => {
          await runSubtest(fixture, subtest.name, {
            equal: (actual, expected, message) => t.equal(actual, expected, message),
            deepEqual: (actual, expected, message) => t.deepEqual(actual, expected, message),
            ok: (value, message) => t.ok(value, message),
            throws: (fn, matcher, message) => t.throws(fn, matcher, message),
          });
        });
      }
    });
  }
});
