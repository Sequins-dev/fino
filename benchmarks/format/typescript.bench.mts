/**
 * Benchmarks for fino:format/typescript
 *
 * Run with: cargo run -- bench benchmarks/format/typescript.bench.mts
 */

import { parse, transpile } from 'fino:format/typescript';
import { bench } from 'fino:bench';

const typescript = [
  'export interface User { name: string; active?: boolean }',
  'export const user: User = { name: "fino", active: true };',
].join('\n');

bench('format/typescript', (b) => {
  b.measure('parse TypeScript', () => parse(typescript, { sourceType: 'ts' }));
  b.measure('transpile TypeScript', () => transpile(typescript, { sourceType: 'ts' }));
});
