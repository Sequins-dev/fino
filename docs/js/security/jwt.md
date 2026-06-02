# jwt

fino:security/jwt - compact JWT/JWS and JWE helpers backed by JWK keys.

This module signs and verifies compact JWTs with HMAC, RSA, RSASSA-PSS, and
ECDSA algorithms, and encrypts or decrypts compact JWE payloads with direct
symmetric keys or RSA-OAEP key wrapping. Key inputs may be single JWKs, arrays
of JWKs, or JWKS containers; verification and decryption select compatible
keys from token headers.

The helpers validate common registered claims such as issuer, audience,
expiration, and not-before when options request them. They do not fetch remote
JWKS documents or implement application authorization policy.

```ts
import { jwkFromSecret } from 'fino:security/jwk';
import { jwtSign, jwtVerify } from 'fino:security/jwt';

const key = jwkFromSecret(sessionSecret, 'HS256', 'current');
const token = await jwtSign({ sub: 'user-123' }, key, {
  algorithm: 'HS256',
  expiresIn: 900,
});
const { payload } = await jwtVerify(token, key, { clockTolerance: 30 });
```

## JwtAlgorithm

```ts
type JwtAlgorithm = | 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512'
```

Supported compact JWS algorithms.

`none` is intentionally unsupported. HMAC algorithms require `oct` keys, RSA
algorithms require RSA keys, and ECDSA algorithms require EC keys with a
compatible curve.

```ts
import type { JwtAlgorithm } from 'fino:security/jwt';

const algorithm: JwtAlgorithm = 'HS256';
```

## JweAlgorithm

```ts
type JweAlgorithm = 'dir' | 'RSA-OAEP' | 'RSA-OAEP-256'
```

Supported compact JWE key-management algorithms.

`dir` uses the supplied symmetric key directly as the content-encryption key.
RSA-OAEP variants wrap a fresh content-encryption key for each token.

```ts
import type { JweAlgorithm } from 'fino:security/jwt';

const algorithm: JweAlgorithm = 'RSA-OAEP-256';
```

## JweEncryption

```ts
type JweEncryption = 'A128GCM' | 'A256GCM'
```

Supported compact JWE content-encryption algorithms.

`A128GCM` uses a 16-byte content-encryption key; `A256GCM` uses 32 bytes.

```ts
import type { JweEncryption } from 'fino:security/jwt';

const encryption: JweEncryption = 'A256GCM';
```

## JwtKeyInput

```ts
type JwtKeyInput = JsonWebKeyLike | JsonWebKeySet | JsonWebKeyLike[]
```

Key input accepted by verification and decryption helpers.

A single JWK is used directly. Arrays and JWKS containers are searched by
header `kid` and `alg`, returning the first matching key or throwing when no
key matches.

```ts
import type { JwtKeyInput } from 'fino:security/jwt';

const keys: JwtKeyInput = { keys: [{ kty: 'oct', kid: 'current', k: 'secret' }] };
```

## JwtSignOptions

```ts
interface JwtSignOptions {
```

Options for signing a compact JWT.

The algorithm is required. `iat` is added by default, and `expiresIn` or
`notBefore` add relative `exp` and `nbf` claims based on the current Unix
time in seconds.

```ts
import type { JwtSignOptions } from 'fino:security/jwt';

const options: JwtSignOptions = { algorithm: 'HS256', expiresIn: 3600 };
```

### algorithm

```ts
algorithm: JwtAlgorithm
```

JWS signing algorithm.

The key must be compatible with the selected algorithm. `none` is not part
of this type and is rejected defensively at runtime.

```ts
import type { JwtSignOptions } from 'fino:security/jwt';

const options: JwtSignOptions = { algorithm: 'RS256' };
```

### header

```ts
header?: Record<string, unknown>
```

Additional protected header fields.

These fields are merged after the default `{ typ: 'JWT', alg }`, so they
can add values such as `kid`. Avoid overriding `alg`.

```ts
import type { JwtSignOptions } from 'fino:security/jwt';

const options: JwtSignOptions = { algorithm: 'HS256', header: { kid: 'current' } };
```

### expiresIn

```ts
expiresIn?: number
```

Lifetime in seconds from signing time.

When provided, `exp` is set to `now + expiresIn`. Omit it to leave the JWT
without an expiration claim.

```ts
import type { JwtSignOptions } from 'fino:security/jwt';

const options: JwtSignOptions = { algorithm: 'HS256', expiresIn: 900 };
```

### notBefore

```ts
notBefore?: number
```

Delay in seconds before the JWT becomes valid.

When provided, `nbf` is set to `now + notBefore`.

```ts
import type { JwtSignOptions } from 'fino:security/jwt';

const options: JwtSignOptions = { algorithm: 'HS256', notBefore: 30 };
```

### issuedAt

```ts
issuedAt?: number | false
```

Issued-at claim value, or `false` to omit `iat`.

Defaults to the current Unix time in seconds. Numeric values are used as-is.

```ts
import type { JwtSignOptions } from 'fino:security/jwt';

const options: JwtSignOptions = { algorithm: 'HS256', issuedAt: false };
```

## JwtVerifyOptions

```ts
interface JwtVerifyOptions {
```

Claim checks and clock controls used during JWT verification.

All supplied checks must pass after signature verification. Failures throw
errors from `jwtVerify()` rather than returning `null`.

```ts
import type { JwtVerifyOptions } from 'fino:security/jwt';

const options: JwtVerifyOptions = { issuer: 'https://issuer.example', audience: 'api' };
```

### audience

```ts
audience?: string | string[]
```

Expected `aud` claim.

A string or any value in the provided list may match. JWT payload `aud` can
be a string or array of strings.

```ts
import type { JwtVerifyOptions } from 'fino:security/jwt';

const options: JwtVerifyOptions = { audience: ['api', 'admin'] };
```

### issuer

```ts
issuer?: string
```

Expected `iss` claim.

When supplied, payload `iss` must be exactly equal or verification throws.

```ts
import type { JwtVerifyOptions } from 'fino:security/jwt';

const options: JwtVerifyOptions = { issuer: 'https://issuer.example' };
```

### subject

```ts
subject?: string
```

Expected `sub` claim.

When supplied, payload `sub` must be exactly equal or verification throws.

```ts
import type { JwtVerifyOptions } from 'fino:security/jwt';

const options: JwtVerifyOptions = { subject: 'user-123' };
```

### clockTolerance

```ts
clockTolerance?: number
```

Clock tolerance in seconds for `exp` and `nbf`.

Defaults to `0`. Positive values allow small clock skew during validation.

```ts
import type { JwtVerifyOptions } from 'fino:security/jwt';

const options: JwtVerifyOptions = { clockTolerance: 30 };
```

### now

```ts
now?: number
```

Current Unix time in seconds for claim checks.

Defaults to the current wall clock. Supplying it is useful for tests.

```ts
import type { JwtVerifyOptions } from 'fino:security/jwt';

const options: JwtVerifyOptions = { now: 1_700_000_000 };
```

## JwtEncryptOptions

```ts
interface JwtEncryptOptions {
```

Options for encrypting a compact JWE with a JSON payload.

The algorithm controls key management and `encryption` controls AES-GCM
content encryption. Additional header fields are protected by authenticated
encryption.

```ts
import type { JwtEncryptOptions } from 'fino:security/jwt';

const options: JwtEncryptOptions = { algorithm: 'dir', encryption: 'A256GCM' };
```

### algorithm

```ts
algorithm: JweAlgorithm
```

JWE key-management algorithm.

`dir` requires an `oct` JWK whose decoded `k` length matches `encryption`.
RSA-OAEP variants use a public RSA key to encrypt a fresh CEK.

```ts
import type { JwtEncryptOptions } from 'fino:security/jwt';

const options: JwtEncryptOptions = { algorithm: 'RSA-OAEP-256', encryption: 'A256GCM' };
```

### encryption

```ts
encryption: JweEncryption
```

JWE content-encryption algorithm.

`A128GCM` requires a 16-byte CEK and `A256GCM` requires a 32-byte CEK.

```ts
import type { JwtEncryptOptions } from 'fino:security/jwt';

const options: JwtEncryptOptions = { algorithm: 'dir', encryption: 'A128GCM' };
```

### header

```ts
header?: Record<string, unknown>
```

Additional protected JWE header fields.

Fields are merged after `typ`, `alg`, and `enc`, so use this for values
such as `kid`. Avoid overriding algorithm fields.

```ts
import type { JwtEncryptOptions } from 'fino:security/jwt';

const options: JwtEncryptOptions = { algorithm: 'dir', encryption: 'A256GCM', header: { kid: 'enc-1' } };
```

## JwtResult

```ts
interface JwtResult {
```

Decoded compact JWT or JWE result.

Verification and decryption return the protected header and JSON payload as
plain records. Claim validation is performed only by `jwtVerify()`.

```ts
import type { JwtResult } from 'fino:security/jwt';

const result: JwtResult = { header: { alg: 'HS256' }, payload: { sub: 'user-123' } };
```

### header

```ts
header: Record<string, unknown>
```

Decoded protected header.

Values are parsed from JSON and are not narrowed beyond the record shape.

```ts
import type { JwtResult } from 'fino:security/jwt';

const result: JwtResult = { header: { alg: 'HS256' }, payload: {} };
const alg = result.header.alg;
```

### payload

```ts
payload: Record<string, unknown>
```

Decoded JSON payload.

Values are parsed from JSON. JWT registered claims remain in this object
after verification.

```ts
import type { JwtResult } from 'fino:security/jwt';

const result: JwtResult = { header: { alg: 'HS256' }, payload: { sub: 'user-123' } };
const sub = result.payload.sub;
```

## jwtSign

```ts
async function jwtSign(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtSignOptions): Promise<string>
```

Sign a compact JWS/JWT.

Adds `iat` by default and optional relative `exp` and `nbf` claims. The
returned string is `header.payload.signature`. Key import, unsupported
algorithms, and crypto signing failures reject the promise.

```ts
import { jwtSign } from 'fino:security/jwt';
import { jwkFromSecret } from 'fino:security/jwk';

const key = jwkFromSecret('shared-secret', 'HS256');
const token = await jwtSign({ sub: 'user-123' }, key, { algorithm: 'HS256' });
```

## jwtVerify

```ts
async function jwtVerify(token: string, keys: JwtKeyInput, options: JwtVerifyOptions = {}): Promise<JwtResult>
```

Verify a compact JWS/JWT and return decoded header and payload.

Throws for malformed compact tokens, unsupported algorithms, missing matching
keys, failed signatures, and failed claim checks. The helper selects keys
from JWKS input using protected header `kid` and `alg`.

```ts
import { jwtSign, jwtVerify } from 'fino:security/jwt';
import { jwkFromSecret } from 'fino:security/jwk';

const key = jwkFromSecret('shared-secret', 'HS256');
const token = await jwtSign({ sub: 'user-123' }, key, { algorithm: 'HS256' });
const result = await jwtVerify(token, key, { subject: 'user-123' });
```

## jwtEncrypt

```ts
async function jwtEncrypt(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtEncryptOptions): Promise<string>
```

Encrypt a compact JWE with a JSON payload using AES-GCM content encryption.

The returned string is the five-part compact JWE form. With `dir`, the
symmetric key is used directly as the CEK. With RSA-OAEP, a fresh CEK is
generated and encrypted for the recipient. Key import and crypto failures
reject the promise.

```ts
import { jwtEncrypt } from 'fino:security/jwt';
import { generateJwk } from 'fino:security/jwk';

const key = await generateJwk({ kty: 'oct', alg: 'dir', length: 256 });
const token = await jwtEncrypt({ sub: 'user-123' }, key, { algorithm: 'dir', encryption: 'A256GCM' });
```

## jwtDecrypt

```ts
async function jwtDecrypt(token: string, keys: JwtKeyInput): Promise<JwtResult>
```

Decrypt a compact JWE and return decoded header and JSON payload.

Throws for malformed compact tokens, missing matching keys, CEK length
mismatches, AES-GCM authentication failures, and JSON decode failures. The
thrown error message is prefixed with `JWE decryption failed:` for inner
decryption errors.

```ts
import { jwtDecrypt, jwtEncrypt } from 'fino:security/jwt';
import { generateJwk } from 'fino:security/jwk';

const key = await generateJwk({ kty: 'oct', alg: 'dir', length: 256 });
const token = await jwtEncrypt({ sub: 'user-123' }, key, { algorithm: 'dir', encryption: 'A256GCM' });
const result = await jwtDecrypt(token, key);
```
