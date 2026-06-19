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
});
