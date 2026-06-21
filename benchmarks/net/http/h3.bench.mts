/**
 * Benchmarks for internal HTTP/3 helper implementation
 *
 * Run with: cargo run -- bench benchmarks/net/http/h3.bench.mts
 */

import { fetch, h3Available, requireH3, serve } from '../../../js/net/http/h3.mts';
import { bench } from 'fino:bench';

bench('net/http h3', (b) => {
  b.measure('availability flag', () => h3Available);
  b.measure('function references', () => {
    fetch;
    serve;
    requireH3;
  });

  b.measure('requireH3 unavailable failure path', () => {
    if (h3Available) {
      void requireH3();
      return;
    }
    try {
      requireH3();
      throw new Error('requireH3 unexpectedly succeeded while unavailable');
    } catch (err) {
      if (String((err as Error).message ?? err).includes('unexpectedly succeeded')) throw err;
    }
  });
});
