# headers

Case-insensitive HTTP header map represented with lower-case names.

## HeaderMap

```ts
type HeaderMap = Record<string, string>
```

Case-insensitive HTTP header map represented with lower-case names.

## SecurityHeadersOptions

```ts
interface SecurityHeadersOptions {
```

Options controlling the default backend security headers.

### contentSecurityPolicy

```ts
contentSecurityPolicy?: string | false
```

### frameOptions

```ts
frameOptions?: 'DENY' | 'SAMEORIGIN' | false
```

### referrerPolicy

```ts
referrerPolicy?: string | false
```

### strictTransportSecurity

```ts
strictTransportSecurity?: string | false
```

### permissionsPolicy

```ts
permissionsPolicy?: string | false
```

### crossOriginOpenerPolicy

```ts
crossOriginOpenerPolicy?: string | false
```

### extra

```ts
extra?: HeaderMap
```

## createSecurityHeaders

```ts
function createSecurityHeaders(options: SecurityHeadersOptions = {}): HeaderMap
```

Build conservative security headers for backend HTTP responses.

## mergeHeaders

```ts
function mergeHeaders(...sets: Array<HeaderMap | undefined>): HeaderMap
```

Merge header maps using lowercase names and later values taking precedence.
