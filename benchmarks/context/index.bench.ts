/**
* Benchmarks for fino:context
*
* Run with: cargo run -- --bench benchmarks/context.bench.mjs
*/
import { Context, Snapshot, snapshotAll } from 'fino:context';
import { bench } from 'fino:bench';
const ctx1 = new Context('ctx1');
const ctx2 = new Context('ctx2');
bench('Context creation', (b) => {
  b.measure('new Context', () => new Context('bench'));
});
bench('Context.get()', (b) => {
  b.measure('get (no value set)', () => ctx1.get());
  b.measure('get (inside runWithValue)', () => ctx1.runWithValue(42, () => ctx1.get()));
});
bench('Context.runWithValue()', (b) => {
  b.measure('sync, depth 1', () => ctx1.runWithValue(1, () => ctx1.get()));
  b.measure('sync, depth 2', () => ctx1.runWithValue(1, () => ctx2.runWithValue(2, () => {
    ctx1.get();
    ctx2.get();
  })));
  b.measure('sync, nested same ctx', () => ctx1.runWithValue(1, () => ctx1.runWithValue(2, () => ctx1.get())));
  b.measure('no-op (undefined)', () => ctx1.runWithValue(undefined, () => {}));
});
bench('Context.runClear()', (b) => {
  b.measure('runClear clears value', () => ctx1.runWithValue(42, () => ctx1.runClear(() => ctx1.get())));
  b.measure('runClear no prior value', () => ctx1.runClear(() => ctx1.get()));
});
bench('snapshotAll()', (b) => {
  b.measure('no contexts set', () => snapshotAll());
  b.measure('one context set', () => ctx1.runWithValue(1, () => snapshotAll()));
  b.measure('two contexts set', () => ctx1.runWithValue(1, () => ctx2.runWithValue(2, () => snapshotAll())));
});
bench('Snapshot.runWithValue()', (b) => {
  const noCtxSnap = snapshotAll();
  const oneCtxSnap = ctx1.runWithValue(42, () => snapshotAll());
  b.measure('run with empty snapshot', () => noCtxSnap.runWithValue(() => {}));
  b.measure('run with one-ctx snapshot', () => oneCtxSnap.runWithValue(() => ctx1.get()));
  b.measure('run with snapshot + nesting', () => oneCtxSnap.runWithValue(() => ctx1.runWithValue(99, () => ctx1.get())));
});
