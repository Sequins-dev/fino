/**
 * Benchmarks for fino:security
 */

import { createSecurityHeaders, randomToken } from 'fino:security';
import { bench } from 'fino:bench';

bench('security', (b) => {
  b.measure('randomToken()', () => randomToken(16));
  b.measure('createSecurityHeaders()', () => createSecurityHeaders());
});
