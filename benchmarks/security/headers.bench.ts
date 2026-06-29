/**
 * Benchmarks for fino:security/headers
 */

import { createSecurityHeaders, mergeHeaders } from 'fino:security/headers';
import { bench } from 'fino:bench';

bench('security/headers', (b) => {
  b.measure('createSecurityHeaders()', () => createSecurityHeaders());
  b.measure('mergeHeaders()', () => mergeHeaders({ a: '1' }, { A: '2' }));
});
