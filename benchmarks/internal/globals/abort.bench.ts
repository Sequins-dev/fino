/**
 * Benchmarks for AbortController and AbortSignal globals
 *
 * Run with: cargo run -- --bench benchmarks/abort.bench.mjs
 */
import { bench } from 'fino:bench';
bench('AbortController / AbortSignal creation', (b) => {
  b.measure('new AbortController', () => new AbortController());
  b.measure('controller.signal', {
    setup: () => new AbortController(),
    fn: (ac) => ac.signal,
  });
  b.measure('AbortSignal.abort()', () => AbortSignal.abort());
  b.measure('AbortSignal.abort(reason)', () => AbortSignal.abort(new Error('cancelled')));
});
bench('abort() cycle', (b) => {
  b.measure('create + abort', () => {
    const ac = new AbortController();
    ac.abort();
  });
  b.measure('create + abort twice', () => {
    const ac = new AbortController();
    ac.abort();
    ac.abort();
  });
  b.measure('abort with reason', () => {
    const ac = new AbortController();
    ac.abort(new Error('done'));
  });
  b.measure('create + listen + abort', () => {
    const ac = new AbortController();
    ac.signal.addEventListener('abort', () => {});
    ac.abort();
  });
  b.measure('3 listeners + abort', () => {
    const ac = new AbortController();
    ac.signal.addEventListener('abort', () => {});
    ac.signal.addEventListener('abort', () => {});
    ac.signal.addEventListener('abort', () => {});
    ac.abort();
  });
});
bench('AbortSignal property access', (b) => {
  const live = new AbortController().signal;
  const aborted = AbortSignal.abort();
  b.measure('.aborted (false)', () => live.aborted);
  b.measure('.aborted (true)', () => aborted.aborted);
  b.measure('.reason', () => aborted.reason);
  b.measure('throwIfAborted (no-op)', () => live.throwIfAborted());
});
bench('AbortSignal.any()', (b) => {
  const live1 = new AbortController().signal;
  const live2 = new AbortController().signal;
  const live3 = new AbortController().signal;
  const live5 = Array.from({ length: 5 }, () => new AbortController().signal);
  const pre = AbortSignal.abort();
  b.measure('any([1 live])', () => AbortSignal.any([live1]));
  b.measure('any([2 live])', () => AbortSignal.any([live1, live2]));
  b.measure('any([3 live])', () => AbortSignal.any([live1, live2, live3]));
  b.measure('any([5 live])', () => AbortSignal.any(live5));
  b.measure('any([pre-aborted])', () => AbortSignal.any([pre]));
  b.measure('any([mixed 1+1])', () => AbortSignal.any([live1, pre]));
});
