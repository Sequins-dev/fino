/**
 * Benchmarks for fino:util/prompt
 *
 * Run with: cargo run -- bench benchmarks/util/prompt.bench.mts
 */

import { PromptSession } from 'fino:util/prompt';
import { bench } from 'fino:bench';

const prompt = new PromptSession({ isInteractive: false });

bench('util/prompt', (b) => {
  b.measure('PromptSession construct', () => new PromptSession({ isInteractive: false }));
  b.measure('prompt method references', () => {
    void prompt.text;
    void prompt.confirm;
    void prompt.select;
  });
});
