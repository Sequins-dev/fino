import { describe, it } from 'fino:test/test';
import { batch, computed, createSignal, effect, fromIterable, lazy, observeReads, type ReadonlySignal } from 'fino:signals';
import { createSignal as createUiSignal, batch as uiBatch } from 'fino:ui';
describe('fino:signals basics', () => {
  it('dedupes writes and notifies batched subscribers once', (t) => {
    const count = createSignal(0);
    const seen: Array<[number, number]> = [];
    const dispose = count.subscribe((value, previous) => seen.push([value, previous]));
    count.set(0);
    count.set(1);
    batch(() => {
      count.set(2);
      count.set((value) => value + 1);
    });
    dispose();
    count.set(4);
    t.equal(count.get(), 4, 'value updates after unsubscribe');
    t.deepEqual(seen, [[1, 0], [3, 1]], 'batch reports previous and final values once');
  });
  it('tracks reads for computed values and effects with dynamic dependencies', (t) => {
    const useA = createSignal(true);
    const a = createSignal(1);
    const b = createSignal(10);
    const selected = computed(() => useA.get() ? a.get() : b.get());
    const values: number[] = [];
    const stop = effect(() => {
      values.push(selected.get());
    });
    a.set(2);
    useA.set(false);
    a.set(3);
    b.set(11);
    stop();
    b.set(12);
    t.deepEqual(values, [
      1,
      2,
      10,
      11
    ], 'computed values re-track dependencies after each run');
  });
  it('exposes observeReads for render-time dependency tracking', (t) => {
    const a = createSignal('a');
    const b = createSignal('b');
    const reads = observeReads(() => `${a.get()}-${b.get()}`);
    t.equal(reads.value, 'a-b', 'returns callback value');
    t.equal(reads.signals.length, 2, 'captures both read signals');
    t.ok(reads.signals.every((sig) => typeof sig.subscribe === 'function'), 'captures readonly signal handles');
  });
  it('starts lazy producers only while subscribed', (t) => {
    let starts = 0;
    let stops = 0;
    let push: ((value: number) => void) | undefined;
    const state = lazy(0, (set) => {
      starts++;
      push = set;
      return () => {
        stops++;
        push = undefined;
      };
    });
    t.equal(state.get(), 0, 'initial value is readable while cold');
    t.equal(starts, 0, 'cold signal does not start without subscribers');
    const seen: number[] = [];
    const disposeA = state.subscribe((value) => seen.push(value));
    const disposeB = state.subscribe((value) => seen.push(value * 10));
    push?.(1);
    disposeA();
    push?.(2);
    disposeB();
    t.equal(starts, 1, 'producer starts once for first subscriber');
    t.equal(stops, 1, 'producer stops after last subscriber');
    t.deepEqual(seen, [
      1,
      10,
      20
    ], 'all active subscribers see lazy updates');
  });
  it('folds async iterables while hot and calls return on dispose', async (t) => {
    let iteratorCreated = 0;
    let returned = 0;
    let release: (() => void) | undefined;
    async function* source() {
      iteratorCreated++;
      try {
        yield 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield 2;
      } finally {
        returned++;
      }
    }
    const folded = fromIterable(source(), (acc, item) => acc + item, 0);
    t.equal(iteratorCreated, 0, 'iterator is cold before subscription');
    const seen: number[] = [];
    const dispose = folded.subscribe((value) => seen.push(value));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    dispose();
    release?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    t.equal(iteratorCreated, 1, 'iterator starts on first subscription');
    t.equal(returned, 1, 'iterator return runs on unsubscribe');
    t.deepEqual(seen, [1], 'fold publishes retained state while subscribed');
  });
});
describe('fino:ui signal compatibility', () => {
  it('re-exports the signal kernel', (t) => {
    const count: ReadonlySignal<number> = createUiSignal(0);
    const seen: number[] = [];
    count.subscribe((value) => seen.push(value));
    uiBatch(() => {
      (count as ReturnType<typeof createUiSignal<number>>).set(1);
      (count as ReturnType<typeof createUiSignal<number>>).set(2);
    });
    t.deepEqual(seen, [2], 'fino:ui batch and createSignal use the shared kernel');
  });
});
