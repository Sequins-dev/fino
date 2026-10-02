/**
 * Benchmarks for fino:tty/inline
 *
 * The composer runs once per keystroke in an inline app, so its cost is the
 * per-character cost of typing. Each case isolates one path: an unchanged
 * footer, a one-row edit, a transcript push, and the scroll a growing footer
 * forces on the transcript.
 *
 * Run with: cargo run -- bench benchmarks/tty/inline.bench.ts
 */
import { bench } from 'fino:bench';
import { composeInline, type InlineState } from 'fino:tty/inline';

const base: InlineState = {
  width: 100,
  height: 40,
  footerRows: 1,
  historyBottom: 0,
  lastLines: [],
  cursor: null,
};
const prompt = ['> the quick brown fox jumps over the lazy dog'];
const settled = composeInline(base, { lines: prompt, cursor: { row: 0, column: 2 } }).state;
const filled = ((): InlineState => {
  let state = settled;
  for (let i = 0; i < 60; i++) state = composeInline(state, { history: [`line ${i}`] }).state;
  return state;
})();
const grown = ['> one', '> two', '> three', '> four'];

bench('tty/inline', (b) => {
  b.measure('unchanged footer', () => composeInline(settled, { lines: prompt }));
  b.measure('one row edited', () =>
    composeInline(settled, { lines: ['> the quick brown fox jumps over the lazy dogs'] }),
  );
  b.measure('push one transcript line', () => composeInline(filled, { history: ['committed'] }));
  b.measure('push ten transcript lines', () =>
    composeInline(filled, { history: Array.from({ length: 10 }, (_, i) => `committed ${i}`) }),
  );
  b.measure('footer grows into the transcript', () => composeInline(filled, { lines: grown }));
});
