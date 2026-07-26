/**
 * Benchmarks for fino:security/token
 */
import { issueToken, verifyToken } from 'fino:security/token';
import { bench } from 'fino:bench';
const secret = 'benchmark-secret';
const token = issueToken({ sub: 'user-1' }, secret);
bench('security/token', (b) => {
  b.measure('issueToken()', () => issueToken({ sub: 'user-1' }, secret));
  b.measure('verifyToken()', () => verifyToken(token, secret));
});
