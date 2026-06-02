# js/security

fino:security provides compact helpers for common backend security tasks.

The module includes cryptographic random bytes and tokens, security and CORS
header builders, signed or sealed cookies, PBKDF2 password records, JWK/JWKS
utilities, compact JWT/JWE helpers, and signed opaque JSON tokens.

```ts
import { createSecurityHeaders, randomToken } from 'fino:security';

const headers = createSecurityHeaders();
const token = randomToken();
```

## randomBytes

```ts
function randomBytes(length: number): Uint8Array
```

Re-exported from `random.randomBytes`.

## randomBase64Url

```ts
function randomBase64Url(length = 32): string
```

Re-exported from `random.randomBase64Url`.

## randomToken

```ts
function randomToken(bytes = 32): string
```

Re-exported from `random.randomToken`.

## randomInt

```ts
function randomInt(min: number, max: number): number
```

Re-exported from `random.randomInt`.

## HeaderMap

```ts
type HeaderMap = Record<string, string>
```

Re-exported from `headers.HeaderMap`.

## SecurityHeadersOptions

```ts
interface SecurityHeadersOptions {
```

Re-exported from `headers.SecurityHeadersOptions`.

## createSecurityHeaders

```ts
function createSecurityHeaders(options: SecurityHeadersOptions = {}): HeaderMap
```

Re-exported from `headers.createSecurityHeaders`.

## mergeHeaders

```ts
function mergeHeaders(...sets: Array<HeaderMap | undefined>): HeaderMap
```

Re-exported from `headers.mergeHeaders`.

## CorsOptions

```ts
interface CorsOptions {
```

Re-exported from `cors.CorsOptions`.

## buildCorsHeaders

```ts
function buildCorsHeaders(options: CorsOptions): HeaderMap
```

Re-exported from `cors.buildCorsHeaders`.

## CookieOptions

```ts
interface CookieOptions {
```

Re-exported from `cookie.CookieOptions`.

## serializeCookie

```ts
function serializeCookie(name: string, value: string, options: CookieOptions = {}): string
```

Re-exported from `cookie.serializeCookie`.

## parseCookieHeader

```ts
function parseCookieHeader(header: string): Record<string, string>
```

Re-exported from `cookie.parseCookieHeader`.

## signCookie

```ts
function signCookie(value: string, secret: BufferLike): string
```

Re-exported from `cookie.signCookie`.

## verifyCookie

```ts
function verifyCookie(signed: string, secret: BufferLike): string | null
```

Re-exported from `cookie.verifyCookie`.

## sealCookie

```ts
function sealCookie(value: string, secret: BufferLike): string
```

Re-exported from `cookie.sealCookie`.

## unsealCookie

```ts
function unsealCookie(sealed: string, secret: BufferLike): string | null
```

Re-exported from `cookie.unsealCookie`.

## IssueTokenOptions

```ts
interface IssueTokenOptions {
```

Re-exported from `token.IssueTokenOptions`.

## VerifyTokenOptions

```ts
interface VerifyTokenOptions {
```

Re-exported from `token.VerifyTokenOptions`.

## issueToken

```ts
function issueToken(payload: Record<string, unknown>, secret: BufferLike, options: IssueTokenOptions = {}): string
```

Re-exported from `token.issueToken`.

## verifyToken

```ts
function verifyToken(token: string, secret: BufferLike, options: VerifyTokenOptions = {}): Record<string, unknown> | null
```

Re-exported from `token.verifyToken`.

## HashPasswordOptions

```ts
interface HashPasswordOptions {
```

Re-exported from `password.HashPasswordOptions`.

## hashPassword

```ts
function hashPassword(password: string, options: HashPasswordOptions = {}): string
```

Re-exported from `password.hashPassword`.

## verifyPassword

```ts
function verifyPassword(password: string, record: string): boolean
```

Re-exported from `password.verifyPassword`.

## JsonWebKeyLike

```ts
type JsonWebKeyLike = Record<string, unknown>
```

Re-exported from `jwk.JsonWebKeyLike`.

## JsonWebKeySet

```ts
interface JsonWebKeySet {
```

Re-exported from `jwk.JsonWebKeySet`.

## GenerateJwkOptions

```ts
interface GenerateJwkOptions {
```

Re-exported from `jwk.GenerateJwkOptions`.

## JwkSelector

```ts
interface JwkSelector {
```

Re-exported from `jwk.JwkSelector`.

## generateJwk

```ts
async function generateJwk(options: GenerateJwkOptions): Promise<JsonWebKeyLike>
```

Re-exported from `jwk.generateJwk`.

## importJwk

```ts
async function importJwk(jwk: JsonWebKeyLike, usages: string[] = []): Promise<CryptoKey>
```

Re-exported from `jwk.importJwk`.

## exportPublicJwk

```ts
async function exportPublicJwk(key: JsonWebKeyLike | CryptoKey): Promise<JsonWebKeyLike>
```

Re-exported from `jwk.exportPublicJwk`.

## jwkThumbprint

```ts
async function jwkThumbprint(jwk: JsonWebKeyLike): Promise<string>
```

Re-exported from `jwk.jwkThumbprint`.

## selectJwk

```ts
function selectJwk(jwks: JsonWebKeySet | JsonWebKeyLike[], selector: JwkSelector): JsonWebKeyLike | undefined
```

Re-exported from `jwk.selectJwk`.

## jwkFromSecret

```ts
function jwkFromSecret(secret: string | Uint8Array, alg = 'HS256', kid?: string): JsonWebKeyLike
```

Re-exported from `jwk.jwkFromSecret`.

## JwtAlgorithm

```ts
type JwtAlgorithm = | 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512'
```

Re-exported from `jwt.JwtAlgorithm`.

## JweAlgorithm

```ts
type JweAlgorithm = 'dir' | 'RSA-OAEP' | 'RSA-OAEP-256'
```

Re-exported from `jwt.JweAlgorithm`.

## JweEncryption

```ts
type JweEncryption = 'A128GCM' | 'A256GCM'
```

Re-exported from `jwt.JweEncryption`.

## JwtKeyInput

```ts
type JwtKeyInput = JsonWebKeyLike | JsonWebKeySet | JsonWebKeyLike[]
```

Re-exported from `jwt.JwtKeyInput`.

## JwtSignOptions

```ts
interface JwtSignOptions {
```

Re-exported from `jwt.JwtSignOptions`.

## JwtVerifyOptions

```ts
interface JwtVerifyOptions {
```

Re-exported from `jwt.JwtVerifyOptions`.

## JwtEncryptOptions

```ts
interface JwtEncryptOptions {
```

Re-exported from `jwt.JwtEncryptOptions`.

## JwtResult

```ts
interface JwtResult {
```

Re-exported from `jwt.JwtResult`.

## jwtSign

```ts
async function jwtSign(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtSignOptions): Promise<string>
```

Re-exported from `jwt.jwtSign`.

## jwtVerify

```ts
async function jwtVerify(token: string, keys: JwtKeyInput, options: JwtVerifyOptions = {}): Promise<JwtResult>
```

Re-exported from `jwt.jwtVerify`.

## jwtEncrypt

```ts
async function jwtEncrypt(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtEncryptOptions): Promise<string>
```

Re-exported from `jwt.jwtEncrypt`.

## jwtDecrypt

```ts
async function jwtDecrypt(token: string, keys: JwtKeyInput): Promise<JwtResult>
```

Re-exported from `jwt.jwtDecrypt`.
