# jwk

## JsonWebKeyLike

```ts
type JsonWebKeyLike = Record<string, unknown>
```

JSON Web Key object accepted by the security helpers.

## JsonWebKeySet

```ts
interface JsonWebKeySet {
```

JSON Web Key Set container.

### keys

```ts
keys: JsonWebKeyLike[]
```

## GenerateJwkOptions

```ts
interface GenerateJwkOptions {
```

Options for generating symmetric, RSA, or EC JSON Web Keys.

### kty

```ts
kty: 'oct' | 'RSA' | 'EC'
```

### alg

```ts
alg?: string
```

### kid

```ts
kid?: string
```

### use

```ts
use?: string
```

### key_ops

```ts
key_ops?: string[]
```

### length

```ts
length?: number
```

### namedCurve

```ts
namedCurve?: 'P-256' | 'P-384' | 'P-521'
```

### modulusLength

```ts
modulusLength?: number
```

## JwkSelector

```ts
interface JwkSelector {
```

Criteria used to select a key from a JWKS or key array.

### kid

```ts
kid?: string
```

### alg

```ts
alg?: string
```

### kty

```ts
kty?: string
```

### use

```ts
use?: string
```

### key_ops

```ts
key_ops?: string[]
```

## generateJwk

```ts
async function generateJwk(options: GenerateJwkOptions): Promise<JsonWebKeyLike>
```

Generate an extractable JSON Web Key using the runtime crypto backend.

## importJwk

```ts
async function importJwk(jwk: JsonWebKeyLike, usages: string[] = []): Promise<CryptoKey>
```

Import a JWK as a WebCrypto `CryptoKey` for the requested usages.

## exportPublicJwk

```ts
async function exportPublicJwk(key: JsonWebKeyLike | CryptoKey): Promise<JsonWebKeyLike>
```

Export a public JWK from a JWK or `CryptoKey`, stripping private or symmetric key material.

## jwkThumbprint

```ts
async function jwkThumbprint(jwk: JsonWebKeyLike): Promise<string>
```

Compute a stable SHA-256 thumbprint for a JWK-like object.

## selectJwk

```ts
function selectJwk(jwks: JsonWebKeySet | JsonWebKeyLike[], selector: JwkSelector): JsonWebKeyLike | undefined
```

Select the first matching key from a JWKS or key array, returning `undefined` if none matches.

## jwkFromSecret

```ts
function jwkFromSecret(secret: string | Uint8Array, alg = 'HS256', kid?: string): JsonWebKeyLike
```

Build an `oct` JWK from a shared secret for HMAC or direct encryption use.
