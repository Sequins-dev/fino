/**
* Smoke-test for fino:bench — exercises sync, object-form, and
* sub-group measurements. Run with:
*
*   cargo run -- --bench benchmarks/bench.bench.mjs
*/
import { bench } from 'fino:bench';
bench('sync measurements', (b) => {
  b.measure('parseInt', () => {
    parseInt('42', 10);
  });
  b.measure('Number()', () => {
    Number('42');
  });
});
bench('object form', (b) => {
  b.measure('with setup', {
    setup() {
      return { base: 'hello' };
    },
    fn({ base }) {
      return base + ' world';
    }
  });
  b.measure('with teardown', {
    setup() {
      return { count: 0 };
    },
    fn(ctx) {
      ctx.count++;
    },
    teardown(ctx) {
      if (ctx.count === 0) throw new Error('teardown: fn was never called');
    }
  });
});
bench('sub-groups', (b) => {
  b.group('string ops', (g) => {
    g.measure('concat', () => {
      'hello' + ' world';
    });
    g.measure('template', () => {
      `hello ${'world'}`;
    });
  });
  b.group('numeric ops', (g) => {
    g.measure('sync add', () => {
      1 + 1;
    });
    g.measure('sync multiply', () => {
      2 * 2;
    });
  });
});
