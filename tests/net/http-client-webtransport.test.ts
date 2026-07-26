import { describe, it } from 'fino:test/test';
import { HttpClient } from 'fino:net/http/client';
describe('HttpClient WebTransport helper', () => {
  it('validates HTTPS URLs and enforces H3 sessions', async (t) => {
    const client = new HttpClient({ baseUrl: 'https://example.test' });
    try {
      await t.rejects(
        () => client.webtransport('http://example.test/wt'),
        /WebTransport requires https:/,
      );
      const h1Session = await client.session('https://example.test', { protocol: 'http/1.1' });
      await t.rejects(
        () => h1Session.webtransport('/wt'),
        /WebTransport over http\/1\.1 is not supported; use an h3 session/,
      );
      t.ok(typeof client.webtransport === 'function', 'client exposes WebTransport helper');
    } finally {
      await client.close();
    }
  });
});
