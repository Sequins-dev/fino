import { describe, it } from 'fino:test/test';
import { mockFetch } from 'fino:test/mock';

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
    await t.rejects(
      () => mockFetch(async (mock) => {
        mock.get('http://collector.example/v1/logs').reply(200, 'ok');
      }),
      /expected 1 more fetch mock call/,
      'missing mock calls fail the scope',
    );
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
});
