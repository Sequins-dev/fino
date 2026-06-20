# js/internal/net/http/h3/server

## H3Handler

```ts
type H3Handler = (request: Request) => Response | Promise<Response>
```

## H3ServerDriver

```ts
class H3ServerDriver {
```

### run

```ts
async run(conn: QuicConnection, handler: H3Handler): Promise<void>
```
