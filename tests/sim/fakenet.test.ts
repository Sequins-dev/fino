/**
 * A simulated realm's ambient `fetch` is served from a route table, so code
 * that calls the network needs no injection point to become testable.
 */
import { describe, it } from 'fino:test/test';
import { FakeNet, simulate } from 'fino:sim';
const HTTP_GUEST = new URL('./fixtures/http-guest.ts', import.meta.url).pathname;
describe('FakeNet', () => {
  it('answers ambient fetch and 502s routes the simulation never described', async (t) => {
    const net = new FakeNet({
      'https://api.example.com/health': { status: 200, body: 'ok!' },
    });
    const report = await simulate({
      entry: HTTP_GUEST,
      seed: 1,
      world: { ...net.world() },
    });
    t.deepEqual(report.result, { health: 'ok!', missing: 502 }, 'routed and unrouted requests');
    const calls = report.journal.calls(FakeNet.specifier);
    t.equal(calls.length, 2, 'both requests journaled');
    t.equal(
      (calls[0]!.args[0] as { url: string }).url,
      'https://api.example.com/health',
      'request details captured',
    );
  });
  it('a route function sees the request and can vary its answer', async (t) => {
    const net = new FakeNet({
      'https://api.example.com/health': (request) => ({
        status: 200,
        body: `saw ${request.method}`,
      }),
      'https://api.example.com/nowhere': { status: 404 },
    });
    const report = await simulate({
      entry: HTTP_GUEST,
      seed: 1,
      world: { ...net.world() },
    });
    t.deepEqual(report.result, { health: 'saw GET', missing: 404 }, 'handler answered');
  });
});
