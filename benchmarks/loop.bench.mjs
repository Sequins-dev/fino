/**
 * Benchmarks for surge:loop
 *
 * Run with: cargo run -- --bench benchmarks/loop.bench.mjs
 *
 * Note: loop.create()/destroy() and nested runWith() cannot be benchmarked
 * inside the bench framework because the framework itself uses runWith() to
 * manage the measurement loop. Only independent operations are measured here.
 */

import * as loop from 'surge:loop';
import { bench } from 'surge:bench';

bench('loop.current()', (b) => {
  b.measure('current() in sync context',  () => loop.current());
  b.measure('current() in async context', async () => {
    const lp = loop.current();
    await Promise.resolve();
    loop.current(); // still set after await
  });
});

bench('loop.timeout()', (b) => {
  b.measure('timeout(0)',   async () => { await loop.timeout(loop.current(), 0); });
  b.measure('timeout(1ms)', async () => { await loop.timeout(loop.current(), 1); });
});

bench('loop.spin()', (b) => {
  // spin() runs a loop until a promise settles — benchmark with an already-resolved promise
  b.measure('spin resolved promise', () => {
    const lp = loop.current();
    loop.spin(lp, Promise.resolve(42));
  });
});
