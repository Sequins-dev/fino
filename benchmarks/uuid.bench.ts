/**
 * Benchmarks for fino:uuid
 *
 * Run with: cargo run -- bench benchmarks/uuid.bench.ts
 */

import { parse, v4, validate } from 'fino:uuid';
import { bench } from 'fino:bench';

const parsedUuid = v4().toString();

bench('uuid', (b) => {
  b.measure('v4()', () => v4());
  b.measure('parse()', () => parse(parsedUuid));
  b.measure('validate()', () => validate(parsedUuid));
});
