/**
 * Benchmarks for fino:realm/self
 *
 * Run with: cargo run -- bench benchmarks/runtime/realm/self.bench.mts
 */

import { port } from 'fino:realm/self';
import { bench } from 'fino:bench';

bench('realm self port', (b) => {
  b.measure('port check', () => port === undefined);
});
