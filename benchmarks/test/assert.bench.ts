/**
 * Benchmarks for fino:test/assert
 *
 * Run with: cargo run -- bench benchmarks/test/assert.bench.ts
 */

import { deepEqual, equal, ok, throws } from 'fino:test/assert';
import { bench } from 'fino:bench';

bench('test/assert', (b) => {
  b.measure('ok', () => ok(true));
  b.measure('equal', () => equal(42, 42));
  b.measure('deepEqual', () => deepEqual({ a: [1, 2] }, { a: [1, 2] }));
  b.measure('throws', () => throws(() => { throw new Error('expected'); }));
});
