/**
 * Benchmarks for fino:net/tls
 *
 * Run with: cargo run -- bench benchmarks/net/tls.bench.mts
 */

import { TlsSocket } from 'fino:net/tls';
import { bench } from 'fino:bench';

bench('net/tls', (b) => {
  b.measure('TlsSocket static surface', () => {
    void TlsSocket.connect;
    void TlsSocket.upgrade;
    void TlsSocket.accept;
  });
});
