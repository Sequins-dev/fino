/**
 * Benchmarks for fino:security/jwt
 */

import { jwtDecrypt, jwtEncrypt, jwtSign, jwtVerify } from 'fino:security/jwt';
import { bench } from 'fino:bench';

bench('security/jwt', (b) => {
  b.measure('jwtSign reference', () => jwtSign);
  b.measure('jwtVerify reference', () => jwtVerify);
  b.measure('jwtEncrypt reference', () => jwtEncrypt);
  b.measure('jwtDecrypt reference', () => jwtDecrypt);
});
