/**
* Benchmarks for fino:file/watch
*
* Run with: cargo run -- bench benchmarks/file/watch.bench.ts
*/
import { Watcher } from 'fino:file/watch';
import { bench } from 'fino:bench';
import { DiskFileSystem } from 'fino:file';
const ROOT = '/tmp/fino-watch-bench-' + Math.floor(Math.random() * 1e6);
const MISSING_PATH = ROOT + '/missing.txt';
const fs = new DiskFileSystem();
let eventCounter = 0;
try {
  await fs.mkdir(ROOT);
} catch {}
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('watch event timed out')), ms));
}
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
    try {
      watcher.watch(MISSING_PATH);
    } catch {}
  });
  b.measure('watch missing path + close', () => {
    const watcher = new Watcher();
    try {
      watcher.watch(MISSING_PATH);
    } catch {} finally {
      watcher.close();
    }
  });
  b.measure('directory event delivery', async () => {
    const watcher = new Watcher();
    const file = `${ROOT}/event-${eventCounter++}.txt`;
    try {
      watcher.watch(ROOT);
      const next = watcher[Symbol.asyncIterator]().next();
      await fs.writeFile(file, 'changed');
      const event = await Promise.race([next, timeout(1e3)]);
      if (event.done === true) throw new Error('watch closed before event delivery');
    } finally {
      watcher.close();
      try {
        await fs.unlink(file);
      } catch {}
    }
  });
});
