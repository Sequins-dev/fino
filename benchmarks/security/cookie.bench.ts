/**
 * Benchmarks for fino:security/cookie
 */

import { parseCookieHeader, serializeCookie, signCookie, verifyCookie } from 'fino:security/cookie';
import { bench } from 'fino:bench';

const secret = 'benchmark-secret';
const signed = signCookie('value', secret);

bench('security/cookie', (b) => {
  b.measure('serializeCookie()', () => serializeCookie('sid', 'value', { httpOnly: true }));
  b.measure('parseCookieHeader()', () => parseCookieHeader('sid=value; theme=dark'));
  b.measure('signCookie()', () => signCookie('value', secret));
  b.measure('verifyCookie()', () => verifyCookie(signed, secret));
});
