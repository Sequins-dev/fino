/**
 * Benchmarks for fino:net/http/server
 *
 * Run with: cargo run -- bench benchmarks/net/http/server.bench.mts
 */

import { serve } from 'fino:net/http/server';
import { bench } from 'fino:bench';

bench('net/http server', (b) => {
  b.measure('serve function reference', () => serve);
});
