/**
 * Benchmarks for fino:format/markdown
 *
 * Run with: cargo run -- bench benchmarks/format/markdown.bench.ts
 */

import { parseMarkdown, renderMarkdown, renderMarkdownInline } from 'fino:format/markdown';
import { bench } from 'fino:bench';

const markdown = [
  '# Title',
  '',
  'Hello **world**.',
  '',
  '- one',
  '- two',
].join('\n');

bench('format/markdown', (b) => {
  b.measure('parseMarkdown', () => parseMarkdown(markdown));
  b.measure('renderMarkdown', () => renderMarkdown(markdown));
  b.measure('renderMarkdownInline', () => renderMarkdownInline('Hello **world**'));
});
