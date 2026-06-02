# password

fino:security/password - PBKDF2 password hashing and verification.

This module stores passwords as self-describing PBKDF2 records containing the
digest, iteration count, random salt, and derived key. Verification parses the
stored record and derives the candidate password with the same parameters, so
records can keep working after defaults are raised.

PBKDF2 is intentionally slow. Tune iteration counts against your deployment
latency budget and periodically rehash older records with stronger settings
after a successful login.

```ts
import { hashPassword, verifyPassword } from 'fino:security/password';

const record = hashPassword(password, { iterations: 300_000, hash: 'sha-512' });
const ok = verifyPassword(passwordAttempt, record);
```

## HashPasswordOptions

```ts
interface HashPasswordOptions {
```

PBKDF2 password hashing options.

Omitted fields use the module defaults: 210,000 iterations, 16 random salt
bytes, a 32-byte derived key, and SHA-256. Tune these values only with an
understanding of your deployment latency budget and password storage policy.

```ts
import type { HashPasswordOptions } from 'fino:security/password';

const options: HashPasswordOptions = { iterations: 300_000, hash: 'sha-512' };
```

### iterations

```ts
iterations?: number
```

PBKDF2 iteration count.

Defaults to `210_000`. Values must be positive safe integers or
`hashPassword()` throws `RangeError`.

```ts
import type { HashPasswordOptions } from 'fino:security/password';

const options: HashPasswordOptions = { iterations: 250_000 };
```

### saltLength

```ts
saltLength?: number
```

Random salt length in bytes.

Defaults to `16`. The salt is generated with cryptographically secure
random bytes and stored in the returned record.

```ts
import type { HashPasswordOptions } from 'fino:security/password';

const options: HashPasswordOptions = { saltLength: 24 };
```

### keyLength

```ts
keyLength?: number
```

Derived key length in bytes.

Defaults to `32`. The verifier derives the same length from the stored
record, so this only needs to be supplied during hashing.

```ts
import type { HashPasswordOptions } from 'fino:security/password';

const options: HashPasswordOptions = { keyLength: 32 };
```

### hash

```ts
hash?: 'sha-256' | 'sha-384' | 'sha-512'
```

Digest used by PBKDF2.

Defaults to `sha-256`. The selected digest name is stored in the record and
reused during verification.

```ts
import type { HashPasswordOptions } from 'fino:security/password';

const options: HashPasswordOptions = { hash: 'sha-512' };
```

## hashPassword

```ts
function hashPassword(password: string, options: HashPasswordOptions = {}): string
```

Hash a password as `pbkdf2$hash$iterations$salt$derived`.

Generates a fresh random salt for every call. Invalid iteration counts throw
`RangeError`; cryptographic backend failures propagate as errors. Store the
returned record verbatim and compare passwords with `verifyPassword()`.

```ts
import { hashPassword } from 'fino:security/password';

const record = hashPassword('correct horse battery staple');
```

## verifyPassword

```ts
function verifyPassword(password: string, record: string): boolean
```

Verify a PBKDF2 password record.

Returns `true` only when the password derives to the stored value. Malformed
records, unsupported parameters, base64url decode failures, and mismatches
return `false`. Comparison is timing-safe after derivation.

```ts
import { hashPassword, verifyPassword } from 'fino:security/password';

const record = hashPassword('secret');
const ok = verifyPassword('secret', record);
```
