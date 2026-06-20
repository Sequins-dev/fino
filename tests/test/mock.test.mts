import { describe, it } from 'fino:test/test';
import { mockFetch } from 'fino:test/mock';
import { Request, Response } from 'fino:net/http';

describe('fino:test/mock', () => {
  it('scopes fetch mocks and restores fetch after the callback throws', async (t) => {
    const originalFetch = globalThis.fetch;
    let thrown: unknown;

    try {
      await mockFetch(async (mock) => {
        mock
          .post('http://collector.example/v1/traces')
          .header('x-test-header', 'present')
          .body('payload')
          .reply(202, 'ok');

        const response = await fetch('http://collector.example/v1/traces', {
          method: 'POST',
          headers: { 'x-test-header': 'present' },
          body: 'payload',
        });

        t.equal(response.status, 202, 'configured response returned');
        t.equal(await response.text(), 'ok', 'response body returned');

        throw new Error('boom');
      });
    } catch (error) {
      thrown = error;
    }

    t.equal(thrown instanceof Error ? thrown.message : String(thrown), 'boom', 'callback error propagated');
    t.equal(globalThis.fetch, originalFetch, 'fetch restored after scope exits');
  });

  it('fails when expected fetch calls are missing', async (t) => {
    const originalFetch = globalThis.fetch;

    await t.rejects(
      () => mockFetch(async (mock) => {
        mock.get('http://collector.example/v1/logs').reply(200, 'ok');
      }),
      /expected 1 more fetch mock call/,
      'missing mock calls fail the scope',
    );

    t.equal(globalThis.fetch, originalFetch, 'fetch restored after verification failure');
  });

  it('fails on unexpected extra fetch calls', async (t) => {
    await t.rejects(
      () => mockFetch(async () => {
        await fetch('http://collector.example/v1/metrics');
      }),
      /unexpected fetch call #1/,
      'unexpected calls fail immediately',
    );
  });

  it('reports method, header, and body mismatches', async (t) => {
    await t.rejects(
      () => mockFetch(async (mock) => {
        mock.get('http://api.example/items').reply(200);
        await fetch('http://api.example/items', { method: 'POST' });
      }),
      /method mismatch: expected GET, got POST/,
      'method mismatch is reported',
    );

    await t.rejects(
      () => mockFetch(async (mock) => {
        mock.get('http://api.example/items').header('x-mode', 'test').reply(200);
        await fetch('http://api.example/items', { headers: { 'x-mode': 'prod' } });
      }),
      /header mismatch for x-mode/,
      'header mismatch is reported',
    );

    await t.rejects(
      () => mockFetch(async (mock) => {
        mock.post('http://api.example/items').body('expected').reply(200);
        await fetch('http://api.example/items', { method: 'POST', body: 'actual' });
      }),
      /body mismatch/,
      'body mismatch is reported',
    );
  });

  it('supports times, base URLs, Request inputs, binary bodies, and response factories', async (t) => {
    const binary = new Uint8Array([1, 2, 3, 4]);

    await mockFetch('http://api.example', async (mock) => {
      mock.get('/ping').times(2).reply(204);
      mock
        .post('/echo')
        .header('content-type', /octet-stream/)
        .body(binary)
        .replyWith((call) => {
          t.equal(call.callIndex, 3, 'factory sees third call');
          t.deepEqual(Array.from(call.body), Array.from(binary), 'factory sees binary request body');
          return new Response(call.body, { status: 201, headers: { 'x-method': call.method } });
        });

      const first = await fetch('http://api.example/ping');
      const second = await fetch(new Request('http://api.example/ping'));
      const echo = await fetch(new Request('http://api.example/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: binary,
      }));

      t.equal(first.status, 204, 'first counted call matched');
      t.equal(second.status, 204, 'second counted call matched');
      t.equal(echo.status, 201, 'factory response status returned');
      t.equal(echo.headers.get('x-method'), 'POST', 'factory response headers returned');
      t.deepEqual(Array.from(await echo.bytes()), Array.from(binary), 'factory response body returned');
    });
  });

  it('routes nested mockFetch scopes to the innermost active scope', async (t) => {
    await mockFetch(async (outer) => {
      outer.get('http://api.example/outer-before').reply(200, 'outer-before');
      outer.get('http://api.example/outer-after').reply(200, 'outer-after');

      const before = await fetch('http://api.example/outer-before');
      t.equal(await before.text(), 'outer-before', 'outer scope handles first call');

      await mockFetch(async (inner) => {
        inner.get('http://api.example/inner').reply(201, 'inner');
        const response = await fetch('http://api.example/inner');
        t.equal(response.status, 201, 'inner scope handles nested call');
        t.equal(await response.text(), 'inner', 'inner response returned');
      });

      const after = await fetch('http://api.example/outer-after');
      t.equal(await after.text(), 'outer-after', 'outer scope restored after nested scope');
    });
  });

  it('isolates concurrent mockFetch scopes across awaits', async (t) => {
    const first = mockFetch(async (mock) => {
      mock.get('http://api.example/first').reply(200, 'first');
      await Promise.resolve();
      const response = await fetch('http://api.example/first');
      return await response.text();
    });

    const second = mockFetch(async (mock) => {
      mock.get('http://api.example/second').reply(200, 'second');
      await Promise.resolve();
      const response = await fetch('http://api.example/second');
      return await response.text();
    });

    t.deepEqual(await Promise.all([first, second]), ['first', 'second'], 'overlapping scopes stay isolated');
  });

  it('supports passthrough responses to the original fetch', async (t) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      return new Response('passthrough:' + String(input), { status: 203 });
    }) as typeof fetch;

    try {
      await mockFetch(async (mock) => {
        mock.get('http://api.example/live').passthrough();
        const response = await fetch('http://api.example/live');
        t.equal(response.status, 203, 'original fetch response status returned');
        t.equal(await response.text(), 'passthrough:http://api.example/live', 'original fetch body returned');
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('supports forced network errors', async (t) => {
    await mockFetch(async (mock) => {
      mock.get('http://api.example/down').networkError('socket hang up');
      await t.rejects(
        () => fetch('http://api.example/down'),
        /socket hang up/,
        'network error rejects fetch',
      );
    });
  });

  it('supports forced abort responses', async (t) => {
    await mockFetch(async (mock) => {
      mock.get('http://api.example/slow').abort();
      await t.rejects(
        () => fetch('http://api.example/slow'),
        /abort/i,
        'abort helper rejects fetch',
      );
    });
  });

  it('rejects pre-aborted fetch calls without consuming expectations', async (t) => {
    const controller = new AbortController();
    controller.abort();

    await mockFetch(async (mock) => {
      mock.get('http://api.example/after-abort').reply(200, 'ok');
      await t.rejects(
        () => fetch('http://api.example/after-abort', { signal: controller.signal }),
        /abort/i,
        'aborted signal rejects before dispatch',
      );

      const response = await fetch('http://api.example/after-abort');
      t.equal(await response.text(), 'ok', 'expectation remains available after aborted call');
    });
  });
});
