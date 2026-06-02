# cookie

fino:security/cookie - cookie serialization, parsing, signing, and sealing.

Use this module for HTTP cookie values that need browser-compatible
attributes or tamper-evident storage. Plain serialization and parsing handle
request and response header syntax. Signing appends an HMAC so the original
value can be recovered only when it has not been modified. Sealing encrypts
and authenticates the value for cookies that must not be readable by clients.

The helpers do not implement session storage or key rotation. Applications
should store secrets outside source code, rotate them deliberately, and avoid
putting large or highly sensitive payloads in cookies.

```ts
import {
  serializeCookie,
  signCookie,
  verifyCookie,
} from 'fino:security/cookie';

const signed = signCookie('user-123', sessionSecret);
const header = serializeCookie('sid', signed, {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
});
const value = verifyCookie(signed, sessionSecret);
```

## CookieOptions

```ts
interface CookieOptions {
```

Options used when serializing a single `Set-Cookie` header value.

Attributes are emitted only when provided or set to `true`. Values are not
validated beyond the cookie name check in `serializeCookie()`, so callers
should pass trusted domain, path, and policy strings.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
};
```

### domain

```ts
domain?: string
```

Optional `Domain` attribute.

Omit it to create a host-only cookie. The value is emitted unchanged.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { domain: 'example.com' };
```

### path

```ts
path?: string
```

Optional `Path` attribute.

Defaults to no emitted path attribute; many applications pass `/`.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { path: '/' };
```

### expires

```ts
expires?: Date
```

Optional absolute expiration time.

When provided, it is formatted with `Date.prototype.toUTCString()`.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { expires: new Date(Date.now() + 3600_000) };
```

### maxAge

```ts
maxAge?: number
```

Optional `Max-Age` value in seconds.

The value is floored before serialization. Pass `0` to expire the cookie.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { maxAge: 3600 };
```

### httpOnly

```ts
httpOnly?: boolean
```

Whether to emit the `HttpOnly` attribute.

Defaults to omitted. Enable it for cookies that client-side scripts should
not read.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { httpOnly: true };
```

### secure

```ts
secure?: boolean
```

Whether to emit the `Secure` attribute.

Defaults to omitted. Enable it for cookies that should only be sent over
HTTPS, and when using `SameSite=None`.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { secure: true };
```

### sameSite

```ts
sameSite?: 'Strict' | 'Lax' | 'None'
```

Optional `SameSite` policy.

Defaults to omitted. Use `None` only with `secure: true` for browser
compatibility.

```ts
import type { CookieOptions } from 'fino:security/cookie';

const options: CookieOptions = { sameSite: 'Lax' };
```

## serializeCookie

```ts
function serializeCookie(name: string, value: string, options: CookieOptions = {}): string
```

Serialize one `Set-Cookie` header value, URI-encoding the cookie value.

The cookie name must use valid token characters or the function throws
`Error`. The value is encoded with `encodeURIComponent()`. Attribute values
are appended as provided and are not sanitized.

```ts
import { serializeCookie } from 'fino:security/cookie';

const header = serializeCookie('sid', 'abc123', {
  path: '/',
  httpOnly: true,
  secure: true,
});
```

## parseCookieHeader

```ts
function parseCookieHeader(header: string): Record<string, string>
```

Parse a `Cookie` request header into a plain object.

Malformed segments without `=` are skipped. Names are trimmed; values are
URI-decoded with `decodeURIComponent()`, so malformed percent escapes throw.
Later duplicate cookie names overwrite earlier values.

```ts
import { parseCookieHeader } from 'fino:security/cookie';

const cookies = parseCookieHeader('sid=abc; theme=dark');
```

## signCookie

```ts
function signCookie(value: string, secret: BufferLike): string
```

Sign a cookie value with HMAC-SHA-256 and return `payload.signature`.

The payload is base64url-encoded UTF-8 text, and the signature covers the
encoded payload. This authenticates but does not encrypt the cookie value.

```ts
import { signCookie } from 'fino:security/cookie';

const signed = signCookie('user-123', 'secret');
```

## verifyCookie

```ts
function verifyCookie(signed: string, secret: BufferLike): string | null
```

Verify a signed cookie value and return the original UTF-8 value.

Returns `null` when the token is malformed, the signature does not match, or
the payload cannot be decoded. Signature comparison is timing-safe. This does
not check expiration; store and verify any expiry in the signed payload.

```ts
import { signCookie, verifyCookie } from 'fino:security/cookie';

const signed = signCookie('user-123', 'secret');
const value = verifyCookie(signed, 'secret');
```

## sealCookie

```ts
function sealCookie(value: string, secret: BufferLike): string
```

Encrypt and authenticate a cookie value using AES-256-GCM and a random IV.

The secret is normalized to a 32-byte key. The returned `v1.iv.ciphertext.tag`
value hides the plaintext and detects tampering. A fresh 96-bit IV is used
for each seal operation.

```ts
import { sealCookie } from 'fino:security/cookie';

const sealed = sealCookie(JSON.stringify({ sub: 'user-123' }), 'secret');
```

## unsealCookie

```ts
function unsealCookie(sealed: string, secret: BufferLike): string | null
```

Decrypt a sealed cookie value and return the original UTF-8 string.

Returns `null` for unsupported versions, malformed parts, decode failures, or
AES-GCM authentication failures. This authenticates and decrypts the value but
does not enforce expiration unless you include one in the plaintext.

```ts
import { sealCookie, unsealCookie } from 'fino:security/cookie';

const sealed = sealCookie('user-123', 'secret');
const value = unsealCookie(sealed, 'secret');
```
