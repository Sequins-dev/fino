/**
 * Benchmarks for fino:file/watch
 *
 * Run with: cargo run -- bench benchmarks/file/watch.bench.mts
 */

import { Watcher } from 'fino:file/watch';
import { bench } from 'fino:bench';

bench('file/watch', (b) => {
  b.measure('Watcher construct/close', () => {
    const watcher = new Watcher();
    watcher.close();
  });
});
