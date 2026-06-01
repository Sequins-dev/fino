/**
 * Benchmarks for fino:test/test
 *
 * Run with: cargo run -- bench benchmarks/test/test.bench.mts
 */

import { describe, it, test } from 'fino:test/test';
import { bench } from 'fino:bench';

bench('test/test', (b) => {
  b.measure('registration function references', () => {
    void test;
    void describe;
    void it;
  });
});
