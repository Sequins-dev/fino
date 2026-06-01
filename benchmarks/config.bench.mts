/**
 * Benchmarks for fino:config
 *
 * Run with: cargo run -- bench benchmarks/config.bench.mts
 */

import { loadConfig } from 'fino:config';
import { bench } from 'fino:bench';

bench('config', (b) => {
  b.measure('loadConfig reference', () => loadConfig);
});
