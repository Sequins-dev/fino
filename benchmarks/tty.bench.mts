/**
 * Benchmarks for fino:tty
 *
 * Run with: cargo run -- bench benchmarks/tty.bench.mts
 */

import { isatty, stderrIsTTY, stdinIsTTY, stdoutIsTTY } from 'fino:tty';
import { bench } from 'fino:bench';

bench('tty', (b) => {
  b.measure('isatty stdin', () => isatty(0));
  b.measure('TTY flags', () => stdinIsTTY || stdoutIsTTY || stderrIsTTY);
});
