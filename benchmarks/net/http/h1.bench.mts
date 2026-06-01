/**
 * Benchmarks for fino:net/http/h1
 *
 * Run with: cargo run -- bench benchmarks/net/http/h1.bench.mts
 */

import { H1ClientDriver, H1ServerDriver } from 'fino:net/http/h1';
import { bench } from 'fino:bench';

bench('net/http h1', (b) => {
  b.measure('H1 drivers construct', () => {
    new H1ServerDriver();
    new H1ClientDriver();
  });
});
