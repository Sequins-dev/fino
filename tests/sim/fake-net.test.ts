/**
 * Public `FakeNet` route-table adapter coverage.
 */
import { describe, it } from 'fino:test/test';
import { FakeNet, simulate, type FakeRequest } from 'fino:sim';

const GUEST = new URL('./fixtures/fake-net-guest.ts', import.meta.url).pathname;

describe('FakeNet', { exclusive: true }, () => {
  it('rejects fetch when the simulation world has no network capability', async (t) => {
    await t.rejects(
      () => simulate({ entry: GUEST }),
      /fino:sim — fetch requires a Facade at fino:net\/fetch/,
    );
  });

  it('serves static, method-specific, and unmatched routes through fetch', async (t) => {
    const requests: FakeRequest[] = [];
    const net = new FakeNet({
      'https://api.example.com/health': {
        headers: { 'x-source': 'fixture' },
        body: 'ok',
      },
      'POST https://api.example.com/orders': (request) => {
        requests.push(request);
        return {
          status: 201,
          headers: { location: '/orders/1' },
          body: request.body!,
        };
      },
      'https://api.example.com/missing': () => undefined,
    });

    const report = await simulate({
      entry: GUEST,
      world: net.world(),
    });

    t.deepEqual(report.result, {
      health: { status: 200, body: 'ok', source: 'fixture' },
      created: { status: 201, body: 'one widget', location: '/orders/1' },
      missing: {
        status: 502,
        body: 'fino:sim — no route for GET https://api.example.com/missing',
      },
    });
    t.deepEqual(requests, [
      {
        url: 'https://api.example.com/orders',
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-request-id': 'req-1',
        },
        body: new TextEncoder().encode('one widget'),
      },
    ]);
    t.equal(report.journal.calls(FakeNet.specifier, 'handleRequest').length, 3);
  });

  it('prefers a method-specific route over the URL fallback', async (t) => {
    const net = new FakeNet({
      'https://api.example.com/orders': { status: 418, body: 'fallback' },
    }).route('POST https://api.example.com/orders', { status: 202, body: 'specific' });

    const report = await simulate({ entry: GUEST, world: net.world() });
    const result = report.result as { created: { status: number; body: string } };

    t.deepEqual(result.created, { status: 202, body: 'specific', location: null });
  });
});
