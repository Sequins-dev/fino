/**
 * Benchmarks for fino:profiler
 *
 * Run with: cargo run -- bench benchmarks/profiler.bench.mts
 */

import { startProfiling, stopProfiling } from 'fino:profiler';
import { bench } from 'fino:bench';

bench('profiler surface', (b) => {
  b.measure('function references', () => {
    void startProfiling;
    void stopProfiling;
  });
});
