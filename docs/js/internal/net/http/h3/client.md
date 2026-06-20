# js/internal/net/http/h3/client

## H3RequestInit

```ts
interface H3RequestInit extends RequestInit {
```

### trailers

```ts
trailers?: Array<[string, string]>
```

## H3ClientSession

```ts
class H3ClientSession {
```

### create

```ts
static async create(conn: QuicConnection): Promise<H3ClientSession>
```

### request

```ts
async request(url: string | URL, init?: H3RequestInit): Promise<Response>
```

### close

```ts
close(): void
```
