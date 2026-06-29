/**
* Benchmarks for fino:security/password
*/
import { hashPassword, verifyPassword } from 'fino:security/password';
import { bench } from 'fino:bench';
const record = hashPassword('password', { iterations: 100 });
bench('security/password', (b) => {
  b.measure('hashPassword()', () => hashPassword('password', { iterations: 100 }));
  b.measure('verifyPassword()', () => verifyPassword('password', record));
});
