/**
 * Benchmarks for fino:net/tls
 *
 * Run with: cargo run -- bench benchmarks/net/tls.bench.ts
 */

import { TlsSocket } from 'fino:net/tls';
import { Socket } from 'fino:net/socket';
import { bench } from 'fino:bench';

bench('net/tls', (b) => {
  b.measure('TlsSocket static surface', () => {
    void TlsSocket.connect;
    void TlsSocket.upgrade;
    void TlsSocket.accept;
  });

  b.measure('failed TLS connect rejects', async () => {
    let server: ReturnType<typeof Socket.listen>;
    try {
      server = Socket.listen({ family: 'ipv4', ip: '127.0.0.1', port: 0 });
    } catch (_) {
      return;
    }
    const accepted = server.accept().then((sock) => sock?.close());
    try {
      await TlsSocket.connect(server.address, { hostname: 'localhost', rejectUnauthorized: false });
      throw new Error('failed TLS connect unexpectedly succeeded');
    } catch (err) {
      if (String((err as Error).message ?? err).includes('unexpectedly succeeded')) throw err;
    } finally {
      server.close();
      await accepted.catch(() => {});
    }
  });
});
