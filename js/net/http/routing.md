---
weight: 12
---
# Routing and Middleware

`fino:net/http/app` provides `App` and `Router` — a composable routing and middleware framework built on top of `fino:net/http/server`. It targets APIs that need URLPattern routing, request-scoped values, middleware composition, and a machine-readable OpenAPI document without abandoning direct access to `Request` and `Response`.

## The middleware model

Middleware is Koa-style: each function receives `(ctx, next)` and can short-circuit by returning a `Response`, or call `await next()` and optionally mutate the downstream response. The order is: app-level middleware runs first, then route-level middleware, then the terminal handler.

```ts
import { App, defineMiddleware } from 'fino:net/http/app';

const app = new App({ name: 'Example API' });

const timing = defineMiddleware(async (ctx, next) => {
  const start = Date.now();
  const res = await next();
  res.headers.set('x-response-time', `${Date.now() - start}ms`);
  return res;
});

app.use(timing);
app.get('/health', () => Response.json({ ok: true }));

const server = app.listen({ port: 3000 });
await server.close();
```

`use()` accepts one or more middleware functions and appends them in call order. Middleware installed on `app` runs before any route. Middleware installed on a `router` or `route` builder runs only for requests matched by that scope.

## Registering routes

The verb methods `get`, `post`, `put`, `patch`, `delete`, `head`, and `options` accept a path and an optional inline handler. When a handler is provided the route is registered immediately and the method returns the `App` for chaining:

```ts
app.get('/users', (ctx) => Response.json([]));
app.post('/users', async (ctx) => {
  const body = await ctx.request.json();
  return Response.json(body, { status: 201 });
});
```

When no handler is provided, the verb method returns a `MethodBuilder` that lets you attach middleware and producers before calling `.handle()`:

```ts
import { App, body, schema } from 'fino:net/http/app';
import { v } from 'fino:validate';

app.route('/users/:id')
  .meta({ tags: ['users'] })
  .value('params', schema.params(v.object({ id: v.string() })))
  .put()
  .value('body', body.json(v.object({ name: v.string() })))
  .handle((ctx) => {
    return Response.json({ id: ctx.params.id, name: (ctx.body as { name: string }).name });
  });
```

## Context values and producers

A producer is an async function that runs at its position in the middleware stack and stores its result under a named slot in `HttpContext`. Duplicate slot names in the same inherited stack throw at build time, not at request time.

```ts
import { defineProducer } from 'fino:net/http/app';

const currentUser = defineProducer(async (ctx) => {
  const token = ctx.request.headers.get('authorization') ?? '';
  return verifyToken(token); // returns a user object or throws
});

app.route('/account')
  .value('user', currentUser)
  .get()
  .handle((ctx) => Response.json(ctx.user));
```

`app.context()` returns the active `HttpContext` for the current request from anywhere in the async call chain, using `fino:context` propagation:

```ts
function getUser() {
  const ctx = app.context();
  return ctx?.user;
}
```

## Schema helpers

`schema.params`, `schema.query`, `schema.headers`, and `schema.response` wrap `fino:validate` schemas and generate matching OpenAPI metadata automatically:

```ts
import { App, schema } from 'fino:net/http/app';
import { v } from 'fino:validate';

app.route('/search')
  .use(schema.query(v.object({ q: v.string(), limit: v.optional(v.number()) })))
  .get()
  .handle((ctx) => {
    const { q, limit } = ctx.query as { q: string; limit?: number };
    return Response.json({ q, limit: limit ?? 10 });
  });
```

`schema.response` validates downstream JSON responses and contributes the response schema to OpenAPI:

```ts
app.route('/status')
  .get()
  .use(schema.response(v.object({ ok: v.boolean() })))
  .handle(() => Response.json({ ok: true }));
```

## Body producers

`body.json`, `body.text`, `body.bytes`, and `body.form` consume the request body exactly once and contribute request body metadata to OpenAPI:

```ts
import { App, body } from 'fino:net/http/app';
import { v } from 'fino:validate';

app.route('/messages')
  .post()
  .value('body', body.json(v.object({ text: v.string() })))
  .handle((ctx) => {
    const message = ctx.body as { text: string };
    return Response.json({ id: crypto.randomUUID(), text: message.text }, { status: 201 });
  });
```

`body.json()` without a schema argument accepts any JSON value without validation.

## Cookies and sessions

`cookies()` parses the request `Cookie` header into a mutable `CookieJar` and applies queued `Set-Cookie` headers to the response automatically:

```ts
import { App, cookies, sessions, memorySessionStore } from 'fino:net/http/app';

const store = memorySessionStore();

app.value('cookies', cookies())
   .value('session', sessions({ store }));

app.get('/me', (ctx) => {
  const session = ctx.session as { id: string; data: Record<string, unknown>; isNew: boolean };
  session.data.visits = Number(session.data.visits ?? 0) + 1;
  return Response.json({ visits: session.data.visits });
});
```

`memorySessionStore()` is suitable for single-process apps and tests. For production use, implement `SessionStore` with a shared backing store.

## Error handling middleware

`errorHandler` converts uncaught errors to a JSON `500` response. Install it early so it wraps all downstream middleware:

```ts
import { App, errorHandler } from 'fino:net/http/app';

app.use(errorHandler({ expose: false })); // set expose: true in development
```

## Static files

`staticFiles` serves files from a local directory and falls through to downstream middleware on misses:

```ts
import { App, staticFiles } from 'fino:net/http/app';

app.use(staticFiles('/var/www', { index: 'index.html', prefix: '/static/' }));
```

## Routers and mounting

`Router` is a reusable route collection that mounts under a path prefix. Router middleware combines with app-level middleware at mount time:

```ts
import { App, Router, body } from 'fino:net/http/app';

const usersRouter = new Router()
  .value('tenant', () => 'default');

usersRouter.route('/users').get(() => Response.json([]));

const app = new App({ name: 'API' });
app.mount('/v1', usersRouter);
```

## WebSocket and WebTransport routes

`app.websocket()` registers a WebSocket route. The handler receives the `WebSocketConnection` and a context:

```ts
import { App } from 'fino:net/http/app';

const app = new App();

app.websocket('/chat', async (socket) => {
  socket.addEventListener('message', (e) => socket.send((e as MessageEvent).data));
});
```

`app.webtransport()` registers a WebTransport route. The session is already accepted when the handler is called:

```ts
app.webtransport('/session', async (session) => {
  const stream = await session.createBidirectionalStream();
  // ... use stream.readable and stream.writable
});
```

## JSON-RPC

`rpc()` mounts a `JsonRpcService` as a POST endpoint. HTTP GET requests to the same path return 405:

```ts
import { App } from 'fino:net/http/app';
import { JsonRpcService } from 'fino:jsonrpc';

const svc = new JsonRpcService();
svc.method('ping').handle(() => 'pong');

app.rpc('/rpc', svc);
```

## Dispatching manually

`app.handle()` dispatches a synthetic request for testing or embedding inside another handler:

```ts
const res = await app.handle(new Request('http://internal/health'));
console.log(res.status);
```

## OpenAPI

`app.openapi()` generates an OpenAPI 3.1 document from all registered routes and accumulated metadata. Metadata from `defineMiddleware` and `defineProducer` is merged automatically:

```ts
const doc = app.openapi({ version: '1.0.0', title: 'My API' });
```

`app.openapiHandler()` returns a `Handler` that serves the document as JSON:

```ts
app.get('/openapi.json', app.openapiHandler({ version: '1.0.0' }));
```

Route-level metadata is added with `.meta()`:

```ts
app.route('/users/:id')
  .meta({
    tags: ['users'],
    summary: 'Get a user by ID',
    responses: {
      '200': { description: 'User found' },
      '404': { description: 'Not found' },
    },
  })
  .get((ctx) => Response.json({ id: ctx.params?.id }));
```

## Starting the server

`app.listen()` is a shortcut for `serve()` that dispatches requests through the app:

```ts
const server = app.listen({ port: 3000, hostname: '127.0.0.1' });
await server.ready;
// ... server is running
await server.close();
```

All `ServeOptions` — `tls`, `h3`, `headersTimeoutMs`, `idleTimeoutMs`, `reuseAddr`, `reusePort` — work the same as with `serve()` directly.
