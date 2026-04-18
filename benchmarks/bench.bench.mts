/**
 * Smoke-test for fino:bench — exercises sync, async, object-form, and
 * sub-group measurements. Run with:
 *
 *   cargo run -- --bench benchmarks/bench.bench.mjs
 */

import { bench } from 'fino:bench';
import * as loop from 'fino:loop';

bench('sync measurements', (b) => {
  b.measure('parseInt', () => { parseInt('42', 10); });
  b.measure('Number()', () => { Number('42'); });
});

bench('async measurements', (b) => {
  // Promise-only: no I/O, should settle after drainMicrotasks alone.
  b.measure('resolved promise', async () => {
    await Promise.resolve(42);
  });

  // Multiple awaits.
  b.measure('promise chain', async () => {
    let v = await Promise.resolve(1);
    v = await Promise.resolve(v + 1);
    await Promise.resolve(v + 1);
  });
});

bench('object form', (b) => {
  b.measure('with setup', {
    setup() { return { base: 'hello' }; },
    fn({ base }) { return base + ' world'; },
  });

  b.measure('with teardown', {
    setup() { return { count: 0 }; },
    fn(ctx) { ctx.count++; },
    teardown(ctx) {
      if (ctx.count === 0) throw new Error('teardown: fn was never called');
    },
  });
});

bench('sub-groups', (b) => {
  b.group('string ops', (g) => {
    g.measure('concat', () => { 'hello' + ' world'; });
    g.measure('template', () => { `hello ${'world'}`; });
  });

  b.group('async vs sync', (g) => {
    g.measure('sync add', () => { 1 + 1; });
    g.measure('async add', async () => { await Promise.resolve(1 + 1); });
  });
});

bench('loop.current() in async bench', (b) => {
  b.measure('current() is set', async () => {
    const lp = loop.current();
    if (!lp) throw new Error('loop.current() returned undefined inside async bench');
    await Promise.resolve();
    // Verify it's still set after await (context propagation).
    const lp2 = loop.current();
    if (!lp2) throw new Error('loop.current() lost after await');
    if (lp !== lp2) throw new Error('loop.current() changed after await');
  });
});
