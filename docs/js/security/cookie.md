# cookie

## CookieOptions

```ts
interface CookieOptions {
```

Options used when serializing a single `Set-Cookie` header value.

### domain

```ts
domain?: string
```

### path

```ts
path?: string
```

### expires

```ts
expires?: Date
```

### maxAge

```ts
maxAge?: number
```

### httpOnly

```ts
httpOnly?: boolean
```

### secure

```ts
secure?: boolean
```

### sameSite

```ts
sameSite?: 'Strict' | 'Lax' | 'None'
```

## serializeCookie

```ts
function serializeCookie(name: string, value: string, options: CookieOptions = {}): string
```

Serialize one `Set-Cookie` header value, URI-encoding the cookie value.

## parseCookieHeader

```ts
function parseCookieHeader(header: string): Record<string, string>
```

Parse a `Cookie` request header into a plain object, skipping malformed pairs.

## signCookie

```ts
function signCookie(value: string, secret: BufferLike): string
```

Sign a cookie value with HMAC-SHA-256 and return `payload.signature`.

## verifyCookie

```ts
function verifyCookie(signed: string, secret: BufferLike): string | null
```

Verify a signed cookie value, returning `null` on tamper or malformed input.

## sealCookie

```ts
function sealCookie(value: string, secret: BufferLike): string
```

Encrypt and authenticate a cookie value using AES-256-GCM and a random IV.

## unsealCookie

```ts
function unsealCookie(sealed: string, secret: BufferLike): string | null
```

Decrypt a sealed cookie value, returning `null` on tamper or malformed input.
