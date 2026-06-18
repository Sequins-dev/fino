/**
 * Benchmarks for fino:net/http/h3
 *
 * Run with: cargo run -- bench benchmarks/net/http/h3.bench.mts
 */

import { fetch, h3Available, requireH3, serve } from 'fino:net/http/h3';
import { bench } from 'fino:bench';

bench('net/http h3', (b) => {
  b.measure('availability flag', () => h3Available);
  b.measure('function references', () => {
    fetch;
    serve;
    requireH3;
  });
});
