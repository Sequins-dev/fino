/**
 * Benchmarks for fino:compress
 *
 * Run with: cargo run -- bench benchmarks/compress.bench.mts
 */

import { compress, decompress } from 'fino:compress';
import { bench } from 'fino:bench';

const payload = new TextEncoder().encode('hello '.repeat(128));
const compressed = compress(payload, { format: 'gzip' });

bench('compress', (b) => {
  b.measure('gzip compress', () => compress(payload, { format: 'gzip' }));
  b.measure('gzip decompress', () => decompress(compressed, { format: 'gzip' }));
});
