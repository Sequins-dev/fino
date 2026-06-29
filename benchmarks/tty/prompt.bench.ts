/**
 * Benchmarks for fino:tty/prompt
 *
 * Run with: cargo run -- bench benchmarks/tty/prompt.bench.ts
 */

import { PromptSession } from 'fino:tty/prompt';
import { bench } from 'fino:bench';

const prompt = new PromptSession({ isInteractive: false });

bench('tty/prompt', (b) => {
  b.measure('PromptSession construct', () => new PromptSession({ isInteractive: false }));
  b.measure('prompt method references', () => {
    void prompt.text;
    void prompt.confirm;
    void prompt.select;
  });
});
