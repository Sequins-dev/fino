/**
 * Benchmarks for fino:archive
 *
 * Run with: cargo run -- bench benchmarks/archive.bench.mts
 */

import { Archive } from 'fino:archive';
import { bench } from 'fino:bench';

bench('archive', (b) => {
  b.measure('Archive construct', () => new Archive('/tmp/fino-bench.tar', 'tar'));
  b.measure('Archive.create reference', () => Archive.create);
});
