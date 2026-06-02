# jwk

fino:security/jwk - JSON Web Key generation, import, export, and selection.

Use this module when JOSE helpers need keys in JWK or JWKS form. It can
generate symmetric, RSA, and EC keys, import JWKs into WebCrypto keys,
export public key material, compute RFC 7638 thumbprints, and select keys
from a key set by `kid`, `alg`, `kty`, and `use`.

Private JWK fields and symmetric `k` values are secret material. Keep them
out of logs and client responses. For public discovery endpoints, export or
publish only public JWK fields.

```ts
import {
  generateJwk,
  exportPublicJwk,
  jwkThumbprint,
} from 'fino:security/jwk';

const privateKey = await generateJwk({ kty: 'RSA', alg: 'RS256', kid: 'signing-1' });
const publicKey = await exportPublicJwk(privateKey);
const thumbprint = await jwkThumbprint(publicKey);
```

## JsonWebKeyLike

```ts
type JsonWebKeyLike = Record<string, unknown>
```

JSON Web Key object accepted by the security helpers.

The map follows the JOSE JWK shape and may contain public, private, or
symmetric key material depending on `kty`. Callers are responsible for
keeping private fields such as `d` and symmetric `k` values secret.

```ts
import type { JsonWebKeyLike } from 'fino:security/jwk';

const key: JsonWebKeyLike = { kty: 'oct', k: 'base64url-secret', alg: 'HS256' };
```

## JsonWebKeySet

```ts
interface JsonWebKeySet {
```

JSON Web Key Set container.

The `keys` array is searched in order by `selectJwk()` and JWT/JWE helpers.
Use `kid` values when multiple keys can validate the same algorithm.

```ts
import type { JsonWebKeySet } from 'fino:security/jwk';

const jwks: JsonWebKeySet = { keys: [{ kty: 'oct', k: 'base64url-secret', kid: 'current' }] };
```

### keys

```ts
keys: JsonWebKeyLike[]
```

Keys included in the set.

Selection returns the first matching key. Empty arrays are valid but cannot
satisfy a selector.

```ts
import type { JsonWebKeySet } from 'fino:security/jwk';

const jwks: JsonWebKeySet = { keys: [] };
```

## GenerateJwkOptions

```ts
interface GenerateJwkOptions {
```

Options for generating symmetric, RSA, or EC JSON Web Keys.

Defaults depend on `kty`: `oct` uses a 256-bit HMAC key, `RSA` uses a
2048-bit modulus, and `EC` uses `P-256`. Generated keys are extractable so
they can be returned as JWK objects; protect private or symmetric output.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'RSA', alg: 'RS256', kid: 'signing-1' };
```

### kty

```ts
kty: 'oct' | 'RSA' | 'EC'
```

Key type to generate.

Use `oct` for shared secrets, `RSA` for RSA signatures or RSA-OAEP, and
`EC` for ECDSA. Unsupported values are rejected by the type and runtime
algorithm selection.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'oct' };
```

### alg

```ts
alg?: string
```

Optional JOSE algorithm identifier.

The algorithm influences hash selection and generated key usages. If
omitted, helpers choose defaults such as SHA-256 based on key type.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'EC', alg: 'ES256' };
```

### kid

```ts
kid?: string
```

Optional key identifier copied into the generated JWK.

Use stable `kid` values for rotation and JWKS selection.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'RSA', kid: '2026-06' };
```

### use

```ts
use?: string
```

Optional JWK `use` value.

Common values include `sig` and `enc`. The helper copies it without
validation.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'RSA', use: 'sig' };
```

### key_ops

```ts
key_ops?: string[]
```

Optional JWK `key_ops` list.

The list is copied into the returned JWK. WebCrypto generation usages are
still inferred from `kty` and `alg`.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'oct', key_ops: ['sign', 'verify'] };
```

### length

```ts
length?: number
```

Symmetric key length in bits for `oct` keys.

Defaults to `256`. The value is divided by 8 to generate random key bytes.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'oct', length: 512 };
```

### namedCurve

```ts
namedCurve?: 'P-256' | 'P-384' | 'P-521'
```

Named curve for `EC` keys.

Defaults to `P-256`. It is ignored for non-EC key generation.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'EC', namedCurve: 'P-384' };
```

### modulusLength

```ts
modulusLength?: number
```

RSA modulus length in bits.

Defaults to `2048`. Larger values increase signing and decryption cost.

```ts
import type { GenerateJwkOptions } from 'fino:security/jwk';

const options: GenerateJwkOptions = { kty: 'RSA', modulusLength: 3072 };
```

## JwkSelector

```ts
interface JwkSelector {
```

Criteria used to select a key from a JWKS or key array.

All supplied fields must match. Missing fields on a candidate are permissive
for `alg`, `use`, and `key_ops`, so include `kid` when exact key selection is
important.

```ts
import type { JwkSelector } from 'fino:security/jwk';

const selector: JwkSelector = { kid: 'current', alg: 'RS256' };
```

### kid

```ts
kid?: string
```

Required key identifier.

When supplied, candidate keys must have the same `kid`.

```ts
import type { JwkSelector } from 'fino:security/jwk';

const selector: JwkSelector = { kid: 'current' };
```

### alg

```ts
alg?: string
```

Required algorithm when the candidate declares `alg`.

Keys without an `alg` field are allowed to match, which supports generic
keys in a JWKS.

```ts
import type { JwkSelector } from 'fino:security/jwk';

const selector: JwkSelector = { alg: 'HS256' };
```

### kty

```ts
kty?: string
```

Required JWK key type.

Use it to distinguish symmetric, RSA, and EC keys in mixed sets.

```ts
import type { JwkSelector } from 'fino:security/jwk';

const selector: JwkSelector = { kty: 'RSA' };
```

### use

```ts
use?: string
```

Required JWK `use` value when the candidate declares `use`.

Keys without `use` are allowed to match.

```ts
import type { JwkSelector } from 'fino:security/jwk';

const selector: JwkSelector = { use: 'sig' };
```

### key_ops

```ts
key_ops?: string[]
```

Required key operations when the candidate declares `key_ops`.

Every requested operation must be present in the candidate list. Keys
without `key_ops` are allowed to match.

```ts
import type { JwkSelector } from 'fino:security/jwk';

const selector: JwkSelector = { key_ops: ['verify'] };
```

## generateJwk

```ts
async function generateJwk(options: GenerateJwkOptions): Promise<JsonWebKeyLike>
```

Generate an extractable JSON Web Key using the runtime crypto backend.

For `oct` keys the helper returns random key bytes directly as a symmetric
JWK. For RSA and EC keys it generates a WebCrypto key pair and exports the
private key JWK, including private fields. Unsupported key options or crypto
backend failures reject the promise.

```ts
import { generateJwk } from 'fino:security/jwk';

const key = await generateJwk({ kty: 'RSA', alg: 'RS256', kid: 'signing-1' });
```

## importJwk

```ts
async function importJwk(jwk: JsonWebKeyLike, usages: string[] = []): Promise<CryptoKey>
```

Import a JWK as a WebCrypto `CryptoKey` for the requested usages.

The algorithm is inferred from `kty`, `alg`, and requested usages. The
returned key is extractable. Unsupported key types, malformed JWK fields, or
incompatible usages reject the promise.

```ts
import { generateJwk, importJwk } from 'fino:security/jwk';

const jwk = await generateJwk({ kty: 'oct', alg: 'HS256' });
const key = await importJwk(jwk, ['sign']);
```

## exportPublicJwk

```ts
async function exportPublicJwk(key: JsonWebKeyLike | CryptoKey): Promise<JsonWebKeyLike>
```

Export a public JWK from a JWK or `CryptoKey`.

Private RSA/EC fields and symmetric `k` material are removed from the
returned object. Passing a symmetric JWK therefore returns metadata without
usable key bytes. Crypto export failures reject the promise.

```ts
import { exportPublicJwk, generateJwk } from 'fino:security/jwk';

const privateJwk = await generateJwk({ kty: 'RSA', alg: 'RS256' });
const publicJwk = await exportPublicJwk(privateJwk);
```

## jwkThumbprint

```ts
async function jwkThumbprint(jwk: JsonWebKeyLike): Promise<string>
```

Compute a stable SHA-256 thumbprint for a JWK-like object.

The helper canonicalizes all defined JWK fields except `kid`, `use`,
`key_ops`, and `alg`, then returns an unpadded base64url SHA-256 digest. This
is useful for stable identifiers but does not validate that the JWK is
complete or safe for a given algorithm.

```ts
import { generateJwk, jwkThumbprint } from 'fino:security/jwk';

const jwk = await generateJwk({ kty: 'oct' });
const thumbprint = await jwkThumbprint(jwk);
```

## selectJwk

```ts
function selectJwk(
  jwks: JsonWebKeySet | JsonWebKeyLike[],
  selector: JwkSelector
): JsonWebKeyLike | undefined
```

Select the first matching key from a JWKS or key array.

Returns `undefined` when no candidate satisfies the selector. The search is
order-preserving, so put the preferred or current key first when several keys
could match.

```ts
import { selectJwk } from 'fino:security/jwk';

const key = selectJwk({ keys: [{ kid: 'current', kty: 'oct' }] }, { kid: 'current' });
```

## jwkFromSecret

```ts
function jwkFromSecret(secret: string | Uint8Array, alg = 'HS256', kid?: string): JsonWebKeyLike
```

Build an `oct` JWK from a shared secret for HMAC or direct encryption use.

String secrets are encoded as UTF-8 before base64url storage. The default
algorithm is `HS256`; pass `dir`, `A128GCM`, or `A256GCM` for direct JWE/AES
use when the secret length matches that algorithm's needs.

```ts
import { jwkFromSecret } from 'fino:security/jwk';

const jwk = jwkFromSecret('shared-secret', 'HS256', 'signing-1');
```
