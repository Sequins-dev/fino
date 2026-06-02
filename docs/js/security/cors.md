# cors

fino:security/cors - build CORS response headers from an origin policy.

This module centralizes the small but easy-to-get-wrong rules around
reflected origins, wildcard origins, credentialed requests, preflight method
lists, and exposed response headers. It returns a plain header map so callers
can merge the result into any HTTP response type.

The builder is intentionally policy-only: it does not inspect methods,
reject requests, or short-circuit preflight handling. Application code should
decide when to return a preflight response and should pass the incoming
`Origin` value to this module.

```ts
import { buildCorsHeaders } from 'fino:security/cors';

const headers = buildCorsHeaders({
  origin: request.headers.get('origin'),
  allowOrigins: ['https://app.example'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['authorization'],
  credentials: true,
});
```

## CorsOptions

```ts
interface CorsOptions {
```

Inputs for building CORS response headers for a request origin.

The builder only reflects an origin when that origin is explicitly allowed.
Use it with the request `Origin` header for both simple responses and
preflight responses. Missing optional lists omit the related headers.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = {
  origin: 'https://app.example',
  allowOrigins: ['https://app.example'],
  credentials: true,
};
```

### origin

```ts
origin?: string | null
```

Request origin to evaluate.

`null`, `undefined`, or an empty string means no origin is reflected. Pass
the exact `Origin` header value from the incoming request.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { origin: request.headers.origin, allowOrigins: '*' };
```

### allowOrigins

```ts
allowOrigins: string[] | '*' | ((origin: string) => boolean)
```

Allowed origins as `*`, an exact-match list, or a predicate.

When credentials are enabled, wildcard allowance reflects the request
origin instead of returning `*`, matching browser CORS requirements.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { allowOrigins: (origin) => origin.endsWith('.example'), origin: 'https://api.example' };
```

### methods

```ts
methods?: string[]
```

Methods advertised in `access-control-allow-methods`.

Omit or pass an empty array to leave the header out.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', methods: ['GET', 'POST'] };
```

### allowHeaders

```ts
allowHeaders?: string[]
```

Request headers advertised in `access-control-allow-headers`.

Omit or pass an empty array to leave the header out. Values are joined with
comma and space without further validation.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', allowHeaders: ['authorization'] };
```

### exposeHeaders

```ts
exposeHeaders?: string[]
```

Response headers advertised in `access-control-expose-headers`.

Omit or pass an empty array to leave the header out.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', exposeHeaders: ['x-request-id'] };
```

### credentials

```ts
credentials?: boolean
```

Whether to emit `access-control-allow-credentials: true`.

Defaults to omitted. Browsers reject credentialed responses with wildcard
origins, so wildcard allowance reflects the request origin when enabled.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', credentials: true };
```

### maxAge

```ts
maxAge?: number
```

Preflight cache duration in seconds.

`undefined` omits `access-control-max-age`; zero emits `0`.

```ts
import type { CorsOptions } from 'fino:security/cors';

const options: CorsOptions = { origin: 'https://app.example', allowOrigins: '*', maxAge: 600 };
```

## buildCorsHeaders

```ts
function buildCorsHeaders(options: CorsOptions): HeaderMap
```

Build CORS response headers for an explicit request origin.

The returned map always includes `vary: Origin`. It includes
`access-control-allow-origin` only when `origin` is non-empty and allowed.
List options are joined with comma and space. The function does not throw for
denied origins; it simply omits the allow-origin header.

```ts
import { buildCorsHeaders } from 'fino:security/cors';

const headers = buildCorsHeaders({
  origin: 'https://app.example',
  allowOrigins: ['https://app.example'],
  methods: ['GET', 'POST'],
});
```
