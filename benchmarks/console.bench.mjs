/**
 * Benchmarks for fino:console
 *
 * Run with: cargo run -- --bench benchmarks/console.bench.mjs
 *
 * Note: Each iteration writes to stdout/stderr — this file produces significant
 * output. Run it separately from the other benchmarks if you want clean output:
 *
 *   cargo run -- --bench benchmarks/console.bench.mjs 2>/dev/null
 */

import console from 'fino:console';
import { bench } from 'fino:bench';

// Pre-build test values to isolate formatting cost from allocation
const STR       = 'hello, world';
const NUM       = 42;
const OBJ_FLAT  = { a: 1, b: 'hello', c: true };
const OBJ_DEEP  = { a: { b: { c: { d: 1 } } } };
const ARR10     = Array.from({ length: 10 }, (_, i) => i);
const ARR_MIX   = [1, 'two', true, null, { x: 1 }];
const COMPLEX   = { id: 1, name: 'test', tags: ['a', 'b'], nested: { x: 1 } };

bench('console.log value types', (b) => {
  b.measure('string',       () => console.log(STR));
  b.measure('number',       () => console.log(NUM));
  b.measure('boolean',      () => console.log(true));
  b.measure('null',         () => console.log(null));
  b.measure('undefined',    () => console.log(undefined));
  b.measure('flat object',  () => console.log(OBJ_FLAT));
  b.measure('deep object',  () => console.log(OBJ_DEEP));
  b.measure('array 10',     () => console.log(ARR10));
  b.measure('mixed array',  () => console.log(ARR_MIX));
  b.measure('complex',      () => console.log(COMPLEX));
});

bench('console.log printf format', (b) => {
  b.measure('%s',       () => console.log('name=%s', 'Alice'));
  b.measure('%d',       () => console.log('count=%d', 42));
  b.measure('%s %d',    () => console.log('name=%s age=%d', 'Alice', 30));
  b.measure('%o',       () => console.log('obj=%o', OBJ_FLAT));
  b.measure('no subs',  () => console.log('plain string with no substitutions'));
});

bench('console.error / console.warn', (b) => {
  b.measure('error string',  () => console.error('something went wrong'));
  b.measure('warn string',   () => console.warn('warning message'));
  b.measure('error object',  () => console.error('err:', OBJ_FLAT));
});

bench('console.dir', (b) => {
  b.measure('flat obj',   () => console.dir(OBJ_FLAT));
  b.measure('deep obj',   () => console.dir(OBJ_DEEP));
});

bench('console.time / timeEnd', (b) => {
  b.measure('time + timeEnd', () => { console.time('bench'); console.timeEnd('bench'); });
});

bench('console.count', (b) => {
  b.measure('count',       () => console.count('x'));
  b.measure('countReset',  () => console.countReset('x'));
});
