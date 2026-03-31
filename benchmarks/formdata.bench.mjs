/**
 * Benchmarks for surge:formdata
 *
 * Run with: cargo run -- --bench benchmarks/formdata.bench.mjs
 */

import { FormData } from 'surge:formdata';
import { bench } from 'surge:bench';

function fdWith(n) {
  const fd = new FormData();
  for (let i = 0; i < n; i++) {
    fd.append(`key${i}`, `value${i}`);
  }
  return fd;
}

bench('FormData construction', (b) => {
  b.measure('empty',    () => new FormData());
});

bench('FormData append', (b) => {
  b.measure('append to empty',  { setup: () => new FormData(), fn: (fd) => fd.append('key', 'value') });
  b.measure('append to 10',     { setup: () => fdWith(10), fn: (fd) => fd.append('newkey', 'val') });
  b.measure('duplicate key',    { setup: () => { const fd = new FormData(); fd.append('k', 'v'); return fd; }, fn: (fd) => fd.append('k', 'v2') });
});

bench('FormData lookup', (b) => {
  b.group('get', (g) => {
    const fd3 = fdWith(3);
    const fd10 = fdWith(10);
    g.measure('get first of 3',    () => fd3.get('key0'));
    g.measure('get last of 10',    () => fd10.get('key9'));
    g.measure('get missing',       () => fd10.get('nonexistent'));
  });

  b.group('has', (g) => {
    const fd = fdWith(10);
    g.measure('has existing',    () => fd.has('key5'));
    g.measure('has missing',     () => fd.has('nonexistent'));
  });

  b.group('getAll', (g) => {
    const fd = new FormData();
    for (let i = 0; i < 5; i++) fd.append('dup', `v${i}`);
    g.measure('getAll 5 dupes',  () => fd.getAll('dup'));
    g.measure('getAll missing',  () => fd.getAll('nope'));
  });
});

bench('FormData mutation', (b) => {
  b.group('set', (g) => {
    g.measure('set unique',       { setup: () => fdWith(5), fn: (fd) => fd.set('newkey', 'newval') });
    g.measure('set replaces one', { setup: () => fdWith(5), fn: (fd) => fd.set('key2', 'replaced') });
  });

  b.group('delete', (g) => {
    g.measure('delete existing',  { setup: () => fdWith(5), fn: (fd) => { fd.append('target', 'val'); fd.delete('target'); } });
    g.measure('delete missing',   { setup: () => fdWith(5), fn: (fd) => fd.delete('nonexistent') });
  });
});

bench('FormData iteration', (b) => {
  const fd5  = fdWith(5);
  const fd20 = fdWith(20);

  b.group('by size', (g) => {
    g.measure('for-of 5 entries',  () => { for (const [k, v] of fd5) { /* noop */ } });
    g.measure('for-of 20 entries', () => { for (const [k, v] of fd20) { /* noop */ } });
  });

  b.group('iteration methods', (g) => {
    g.measure('keys()',    () => { for (const k of fd5.keys()) { /* noop */ } });
    g.measure('values()',  () => { for (const v of fd5.values()) { /* noop */ } });
    g.measure('entries()', () => { for (const e of fd5.entries()) { /* noop */ } });
    g.measure('forEach()', () => fd5.forEach(() => {}));
  });
});
