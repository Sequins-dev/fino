/**
 * Benchmarks for fino:security/random
 */

import { randomBase64Url, randomBytes, randomInt } from 'fino:security/random';
import { bench } from 'fino:bench';

bench('security/random', (b) => {
  b.measure('randomBytes()', () => randomBytes(32));
  b.measure('randomBase64Url()', () => randomBase64Url(32));
  b.measure('randomInt()', () => randomInt(0, 1000));
});
