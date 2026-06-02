# jwt

## JwtAlgorithm

```ts
type JwtAlgorithm = | 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512'
```

Supported compact JWS algorithms; `none` is intentionally not supported.

## JweAlgorithm

```ts
type JweAlgorithm = 'dir' | 'RSA-OAEP' | 'RSA-OAEP-256'
```

Supported compact JWE key-management algorithms.

## JweEncryption

```ts
type JweEncryption = 'A128GCM' | 'A256GCM'
```

Supported compact JWE content-encryption algorithms.

## JwtKeyInput

```ts
type JwtKeyInput = JsonWebKeyLike | JsonWebKeySet | JsonWebKeyLike[]
```

Key input accepted by verification and decryption helpers.

## JwtSignOptions

```ts
interface JwtSignOptions {
```

Options for signing a compact JWT.

### algorithm

```ts
algorithm: JwtAlgorithm
```

### header

```ts
header?: Record<string, unknown>
```

### expiresIn

```ts
expiresIn?: number
```

### notBefore

```ts
notBefore?: number
```

### issuedAt

```ts
issuedAt?: number | false
```

## JwtVerifyOptions

```ts
interface JwtVerifyOptions {
```

Claim checks and clock controls used during JWT verification.

### audience

```ts
audience?: string | string[]
```

### issuer

```ts
issuer?: string
```

### subject

```ts
subject?: string
```

### clockTolerance

```ts
clockTolerance?: number
```

### now

```ts
now?: number
```

## JwtEncryptOptions

```ts
interface JwtEncryptOptions {
```

Options for encrypting a compact JWE with a JSON payload.

### algorithm

```ts
algorithm: JweAlgorithm
```

### encryption

```ts
encryption: JweEncryption
```

### header

```ts
header?: Record<string, unknown>
```

## JwtResult

```ts
interface JwtResult {
```

Decoded compact JWT or JWE result.

### header

```ts
header: Record<string, unknown>
```

### payload

```ts
payload: Record<string, unknown>
```

## jwtSign

```ts
async function jwtSign(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtSignOptions): Promise<string>
```

Sign a compact JWS/JWT, adding `iat` by default and optional `exp`/`nbf` claims.

## jwtVerify

```ts
async function jwtVerify(token: string, keys: JwtKeyInput, options: JwtVerifyOptions = {}): Promise<JwtResult>
```

Verify a compact JWS/JWT and return decoded header and payload or throw on failure.

## jwtEncrypt

```ts
async function jwtEncrypt(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtEncryptOptions): Promise<string>
```

Encrypt a compact JWE with a JSON payload using AES-GCM content encryption.

## jwtDecrypt

```ts
async function jwtDecrypt(token: string, keys: JwtKeyInput): Promise<JwtResult>
```

Decrypt a compact JWE and return decoded header and JSON payload or throw on failure.
