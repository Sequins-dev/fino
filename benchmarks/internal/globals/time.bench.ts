/**
* Benchmarks for timer and performance globals
*
* Run with: cargo run -- --bench benchmarks/time.bench.ts
*/
import { bench } from 'fino:bench';
bench('performance.now()', (b) => {
  b.measure('now()', () => performance.now());
  b.measure('two consecutive now() calls', () => {
    performance.now();
    performance.now();
  });
  b.measure('now() diff', () => {
    const t0 = performance.now();
    const t1 = performance.now();
    return t1 - t0;
  });
});
bench('setTimeout / clearTimeout', (b) => {
  b.measure('setTimeout + clearTimeout (0ms)', () => {
    const id = setTimeout(() => {}, 0);
    clearTimeout(id);
  });
  b.measure('setTimeout + clearTimeout (100ms)', () => {
    const id = setTimeout(() => {}, 100);
    clearTimeout(id);
  });
  b.measure('setTimeout(0) fire', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  b.measure('nested setTimeout(0)', async () => {
    await new Promise<void>((resolve) => {
      setTimeout(() => setTimeout(resolve, 0), 0);
    });
  });
});
bench('setInterval / clearInterval', (b) => {
  b.measure('setInterval + clearInterval', () => {
    const id = setInterval(() => {}, 100);
    clearInterval(id);
  });
  b.measure('setInterval fire once', async () => {
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        clearInterval(id);
        resolve();
      }, 0);
    });
  });
});
bench('queueMicrotask vs setTimeout(0)', (b) => {
  b.measure('queueMicrotask fire', async () => {
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  });
  b.measure('setTimeout(0) fire', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});
