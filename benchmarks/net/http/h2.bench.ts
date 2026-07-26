/**
 * Benchmarks for internal HTTP/2 capability helpers
 *
 * Run with: cargo run -- bench benchmarks/net/http/h2.bench.ts
 */
import { h2Available, h2Version } from '../../../js/net/http/h2.ts';
import { bench } from 'fino:bench';
bench('net/http h2', (b) => {
  b.measure('H2 availability flags', () => (h2Available ? h2Version : null));
});
