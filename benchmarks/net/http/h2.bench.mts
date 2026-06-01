/**
 * Benchmarks for fino:net/http/h2
 *
 * Run with: cargo run -- bench benchmarks/net/http/h2.bench.mts
 */

import { h2Available, h2Version } from 'fino:net/http/h2';
import { bench } from 'fino:bench';

bench('net/http h2', (b) => {
  b.measure('H2 availability flags', () => h2Available ? h2Version : null);
});
