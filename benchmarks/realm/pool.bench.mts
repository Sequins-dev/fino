/**
 * Benchmarks for fino:realm/pool
 *
 * Run with: cargo run -- bench benchmarks/realm/pool.bench.mts
 */

import { correlationIdContext } from 'fino:realm/pool';
import { bench } from 'fino:bench';

bench('realm pool context', (b) => {
  b.measure('correlation context get', () => correlationIdContext.get());
});
