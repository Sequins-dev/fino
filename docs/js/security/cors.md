# cors

## CorsOptions

```ts
interface CorsOptions {
```

Inputs for building CORS response headers for a request origin.

### origin

```ts
origin?: string | null
```

### allowOrigins

```ts
allowOrigins: string[] | '*' | ((origin: string) => boolean)
```

### methods

```ts
methods?: string[]
```

### allowHeaders

```ts
allowHeaders?: string[]
```

### exposeHeaders

```ts
exposeHeaders?: string[]
```

### credentials

```ts
credentials?: boolean
```

### maxAge

```ts
maxAge?: number
```

## buildCorsHeaders

```ts
function buildCorsHeaders(options: CorsOptions): HeaderMap
```

Build CORS response headers for an explicit request origin.
