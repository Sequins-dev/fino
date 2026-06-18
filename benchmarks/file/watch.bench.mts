/**
 * Benchmarks for fino:file/watch
 *
 * Run with: cargo run -- bench benchmarks/file/watch.bench.mts
 */

import { Watcher } from 'fino:file/watch';
import { bench } from 'fino:bench';

const ROOT = '/tmp/fino-watch-bench-' + Math.floor(Math.random() * 1_000_000);
const MISSING_PATH = ROOT + '/missing.txt';

bench('file/watch', (b) => {
  b.measure('Watcher construct/close', () => {
    const watcher = new Watcher();
    watcher.close();
  });

  b.measure('recursive Watcher construct/close', () => {
    const watcher = new Watcher({ recursive: true });
    watcher.close();
  });

  b.measure('watch() after close throws', () => {
    const watcher = new Watcher();
    watcher.close();
    try { watcher.watch(MISSING_PATH); } catch {}
  });

  b.measure('watch missing path + close', () => {
    const watcher = new Watcher();
    try { watcher.watch(MISSING_PATH); } catch {}
    finally { watcher.close(); }
  });
});
