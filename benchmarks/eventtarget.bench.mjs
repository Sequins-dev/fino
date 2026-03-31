/**
 * Benchmarks for surge:eventtarget
 *
 * Run with: cargo run -- --bench benchmarks/eventtarget.bench.mjs
 */

import { EventTarget, Event, CustomEvent } from 'surge:eventtarget';
import { bench } from 'surge:bench';

bench('Event construction', (b) => {
  b.measure('Event bare',            () => new Event('click'));
  b.measure('Event cancelable',      () => new Event('submit', { cancelable: true }));
  b.measure('Event bubbles',         () => new Event('change', { bubbles: true, cancelable: true }));
  b.measure('CustomEvent no detail', () => new CustomEvent('data'));
  b.measure('CustomEvent detail',    () => new CustomEvent('data', { detail: { x: 1, y: 2 } }));
});

bench('Event property access', (b) => {
  const ev = new Event('test', { bubbles: true, cancelable: true });
  b.measure('type',            () => ev.type);
  b.measure('bubbles',         () => ev.bubbles);
  b.measure('cancelable',      () => ev.cancelable);
  b.measure('defaultPrevented', () => ev.defaultPrevented);
  b.measure('timeStamp',       () => ev.timeStamp);
});

bench('EventTarget.addEventListener', (b) => {
  const noop = () => {};
  b.measure('add 1st listener',     { setup: () => new EventTarget(), fn: (t) => t.addEventListener('test', noop) });
  b.measure('add to populated (5)', { setup: () => { const t = new EventTarget(); for (let i = 0; i < 5; i++) t.addEventListener('test', () => {}); return t; }, fn: (t) => t.addEventListener('test', noop) });
  b.measure('add once listener',    { setup: () => new EventTarget(), fn: (t) => t.addEventListener('test', noop, { once: true }) });
});

bench('EventTarget.dispatchEvent', (b) => {
  const ev = new Event('test');

  b.group('by listener count', (g) => {
    const t0 = new EventTarget();
    const t1 = new EventTarget(); t1.addEventListener('test', () => {});
    const t5 = new EventTarget(); for (let i = 0; i < 5; i++) t5.addEventListener('test', () => {});
    const t10 = new EventTarget(); for (let i = 0; i < 10; i++) t10.addEventListener('test', () => {});

    g.measure('0 listeners',  () => t0.dispatchEvent(new Event('test')));
    g.measure('1 listener',   () => t1.dispatchEvent(new Event('test')));
    g.measure('5 listeners',  () => t5.dispatchEvent(new Event('test')));
    g.measure('10 listeners', () => t10.dispatchEvent(new Event('test')));
  });

  b.measure('wrong event type (miss)', { setup: () => { const t = new EventTarget(); t.addEventListener('click', () => {}); return t; }, fn: (t) => t.dispatchEvent(new Event('keydown')) });
});

bench('EventTarget add+remove cycle', (b) => {
  const noop = () => {};
  b.measure('add + remove',   { setup: () => new EventTarget(), fn: (t) => { t.addEventListener('x', noop); t.removeEventListener('x', noop); } });
  b.measure('remove missing', { setup: () => new EventTarget(), fn: (t) => t.removeEventListener('x', noop) });
});
