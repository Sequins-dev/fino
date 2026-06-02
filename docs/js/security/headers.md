# headers

Case-insensitive HTTP header map represented with lower-case names.

Header builders in this module normalize names to lower-case and store one
string value per header. Duplicate header semantics, such as appending
multiple `Set-Cookie` values, are outside this simple map shape.

```ts
import type { HeaderMap } from 'fino:security/headers';

const headers: HeaderMap = { 'x-content-type-options': 'nosniff' };
```

## HeaderMap

```ts
type HeaderMap = Record<string, string>
```

Case-insensitive HTTP header map represented with lower-case names.

Header builders in this module normalize names to lower-case and store one
string value per header. Duplicate header semantics, such as appending
multiple `Set-Cookie` values, are outside this simple map shape.

```ts
import type { HeaderMap } from 'fino:security/headers';

const headers: HeaderMap = { 'x-content-type-options': 'nosniff' };
```

## SecurityHeadersOptions

```ts
interface SecurityHeadersOptions {
```

Options controlling the default backend security headers.

Omitted options use conservative defaults. Passing `false` disables headers
that support opt-out. `extra` is merged last, so it can override defaults or
add application-specific headers.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = {
  frameOptions: 'SAMEORIGIN',
  contentSecurityPolicy: "default-src 'self'",
};
```

### contentSecurityPolicy

```ts
contentSecurityPolicy?: string | false
```

Optional Content Security Policy value.

The default is omitted because CSP must be tailored to the application.
Pass a string to emit `content-security-policy`, or `false` to make the
opt-out explicit.

```ts
import { createSecurityHeaders } from 'fino:security/headers';

createSecurityHeaders({ contentSecurityPolicy: "default-src 'self'" });
```

### frameOptions

```ts
frameOptions?: 'DENY' | 'SAMEORIGIN' | false
```

Value for `x-frame-options`, or `false` to omit it.

Defaults to `DENY`. Use `SAMEORIGIN` when same-site framing is required.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = { frameOptions: 'SAMEORIGIN' };
```

### referrerPolicy

```ts
referrerPolicy?: string | false
```

Value for `referrer-policy`, or `false` to omit it.

Defaults to `no-referrer`. Choose a looser policy only when downstream
analytics or cross-origin flows need referrer data.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = { referrerPolicy: 'strict-origin' };
```

### strictTransportSecurity

```ts
strictTransportSecurity?: string | false
```

Value for `strict-transport-security`, or `false` to omit it.

Defaults to `max-age=31536000; includeSubDomains`. Only emit HSTS on HTTPS
origins that are ready to enforce HTTPS for the configured scope.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = { strictTransportSecurity: false };
```

### permissionsPolicy

```ts
permissionsPolicy?: string | false
```

Value for `permissions-policy`, or `false` to omit it.

The default is omitted because allowed browser features depend on the app.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = { permissionsPolicy: 'geolocation=()' };
```

### crossOriginOpenerPolicy

```ts
crossOriginOpenerPolicy?: string | false
```

Value for `cross-origin-opener-policy`, or `false` to omit it.

Defaults to `same-origin`, which helps isolate browsing contexts. Disable
or relax it only for integrations that require opener access.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = { crossOriginOpenerPolicy: 'same-origin-allow-popups' };
```

### extra

```ts
extra?: HeaderMap
```

Additional headers merged after the defaults.

Names are normalized to lower-case, and later values take precedence.

```ts
import type { SecurityHeadersOptions } from 'fino:security/headers';

const options: SecurityHeadersOptions = { extra: { 'x-robots-tag': 'noindex' } };
```

## createSecurityHeaders

```ts
function createSecurityHeaders(options: SecurityHeadersOptions = {}): HeaderMap
```

Build conservative security headers for backend HTTP responses.

Defaults include `x-content-type-options: nosniff`, `x-frame-options: DENY`,
`referrer-policy: no-referrer`, HSTS, and COOP. CSP and permissions policy
are emitted only when supplied. Header names are lower-case and `extra`
values override generated defaults.

```ts
import { createSecurityHeaders } from 'fino:security/headers';

const headers = createSecurityHeaders({
  contentSecurityPolicy: "default-src 'self'",
});
```

## mergeHeaders

```ts
function mergeHeaders(...sets: Array<HeaderMap | undefined>): HeaderMap
```

Merge header maps using lower-case names and later values taking precedence.

`undefined` sets are skipped. Values are coerced with `String()`, so pass
preformatted header values rather than arrays. This helper is best for
single-value headers, not multi-value `Set-Cookie` output.

```ts
import { mergeHeaders } from 'fino:security/headers';

const headers = mergeHeaders(
  { 'X-Content-Type-Options': 'nosniff' },
  { 'x-content-type-options': 'nosniff' },
);
```
