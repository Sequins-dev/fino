/**
 * Benchmarks for fino:template
 *
 * Run with: cargo run -- bench benchmarks/template.bench.mts
 */

import { compile, render } from 'fino:template';
import { bench } from 'fino:bench';

const template = compile('Hello {{name}}, port={{port}}');

bench('template', (b) => {
  b.measure('compile', () => compile('Hello {{name}}'));
  b.measure('render compiled', () => template({ name: 'fino', port: 3030 }));
  b.measure('render direct', () => render('Hello {{name}}', { name: 'fino' }));
});
