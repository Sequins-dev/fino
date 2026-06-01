/**
 * Benchmarks for fino:module
 *
 * Run with: cargo run -- bench benchmarks/runtime/module.bench.mts
 */

import { SyntheticModule } from 'fino:module';
import { bench } from 'fino:bench';

bench('SyntheticModule', (b) => {
  b.measure('construct', () => new SyntheticModule('bench-module', { value: 42 }));
});
