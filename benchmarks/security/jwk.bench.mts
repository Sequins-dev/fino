/**
 * Benchmarks for fino:security/jwk
 */

import { jwkFromSecret, jwkThumbprint, selectJwk } from 'fino:security/jwk';
import { bench } from 'fino:bench';

const key = jwkFromSecret('secret', 'HS256', 'bench');

bench('security/jwk', (b) => {
  b.measure('jwkFromSecret()', () => jwkFromSecret('secret'));
  b.measure('selectJwk()', () => selectJwk({ keys: [key] }, { kid: 'bench' }));
  b.measure('jwkThumbprint reference', () => jwkThumbprint);
});
