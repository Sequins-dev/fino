---
weight: 12
---
# Routing and Middleware

`fino:net/http/app` provides `App` and `Router` — a composable routing and middleware framework built on top of `fino:net/http/server`. It targets APIs that need URLPattern routing, request-scoped values, middleware composition, and a machine-readable OpenAPI document without abandoning direct access to `Request` and `Response`.

## The routing tree

Route configuration is an **immutable enrichment tree**. Every non-terminal call — `use()`, `layer()`, `value()`, `meta()`, `route()`, and the verb methods — records a node pointing at its parent and returns a new builder around that node. A terminal — `.handle()` for HTTP methods, or `websocket()`, `sse()`, `webtransport()`, `rpc()`, and `mount()` on a route — resolves the branch it hangs off by walking back to the root and freezing the result into an operation.

Two properties follow:

- **A held builder reference is a fixed point in the tree.** `const r = app.route('/x'); r.value('a', p)` does not change `r` — the enriched builder is the *return value*. Chain calls, or reassign, to accumulate.
- **Root enrichments are immutable too.** `const authed = app.use(auth); authed.get('/account')` applies `auth` to `/account`; `app.get('/public')` does not inherit it unless it is registered through the returned branch.

A later `value()` with the same name shadows an earlier one along a branch, and later `meta()` overrides earlier metadata key by key — last wins.

## The middleware model

There are two middleware forms:

- `use()` installs one-way branch middleware. It receives `ctx`, can short-circuit by returning a `Response`, and continues by returning nothing.
- `layer()` installs Koa-style wrappers. It receives `(ctx, next)`, can run before and after downstream dispatch, and can wrap fallback responses when its branch constraints match.

```ts
import { App, defineMiddleware } from 'fino:net/http/app';

const app = new App({ name: 'Example API' });

const timing = defineMiddleware(async (ctx, next) => {
  const start = Date.now();
  const res = await next();
  res.headers.set('x-response-time', `${Date.now() - start}ms`);
  return res;
});

const timed = app.layer(timing);
timed.get('/health').handle(() => Response.json({ ok: true }));

const server = app.listen({ port: 3000 });
await server.close();
```

`use()` and `layer()` accept one or more functions and append them in call order. Middleware is never passed inline to a verb — it always attaches through the branch it should cover.

## Registering routes

The verb methods `get`, `post`, `put`, `patch`, `delete`, `head`, and `options` take only a path and return a `MethodBuilder`; the handler always registers through the explicit `.handle()` terminal:

```ts
app.get('/users').handle((ctx) => Response.json([]));
app.post('/users').handle(async (ctx) => {
  const body = await ctx.request.json();
  return Response.json(body, { status: 201 });
});
```

For fluent configuration, start from `route()` and enrich the branch before the terminal:

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

`.handle()` returns the parent route builder, so sibling methods chain on the same route:

```ts
app.route('/items')
  .get().handle(() => Response.json([]))
  .post().handle((ctx) => Response.json({}, { status: 201 }));
```

A request that matches a route's path with no matching method returns **405 Method Not Allowed** with an `Allow` header listing the methods that would have matched.

## Nested routes

`route()` on a route builder nests: the child path appends to the parent's, and the child branch inherits everything accumulated above it. This is the natural shape for REST controllers:

```ts
const users = app.route('/users').value('db', openDatabase);
users.get().handle(listUsers);                       // GET /users
users.post().handle(createUser);                     // POST /users

const user = users.route('/:id')
  .value('params', schema.params(v.object({ id: v.string() })));
user.get().handle(showUser);                         // GET /users/:id
user.delete().handle(removeUser);                    // DELETE /users/:id
```

## Context values and producers

A producer is an async function that runs at its position in the middleware chain and stores its result under a named slot in `HttpContext`:

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
  .layer(schema.response(v.object({ ok: v.boolean() })))
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

`cookies()` parses the request `Cookie` header into a mutable `CookieJar` and applies queued `Set-Cookie` headers to the response automatically. Production server sessions live in `fino:security/session`:

```ts
import { App, cookies } from 'fino:net/http/app';
import { sessions, sqliteSessionStore } from 'fino:security/session';

const store = await sqliteSessionStore({ path: './sessions.db' });

const stateful = app.value('cookies', cookies())
  .value('session', sessions({
    store,
    keys: [{ id: '2026-07', secret: process.env.SESSION_SECRET! }],
    ttlMs: 24 * 60 * 60_000,
    rolling: true,
  }));

stateful.get('/me').handle((ctx) => {
  const session = ctx.session as { id: string; data: Record<string, unknown>; isNew: boolean };
  session.data.visits = Number(session.data.visits ?? 0) + 1;
  return Response.json({ visits: session.data.visits });
});
```

Use `memorySessionStore()` from `fino:security/session` for tests and local applications. SQLite provides durable single-node records; `cacheSessionStore()` adapts any revision-capable cache. Distributed stores must preserve atomic revision-conditional writes and read-after-write behavior so logout and regeneration cannot be undone by stale requests. The unsealed session helpers still exported by `fino:net/http/app` remain only for compatibility.

## Error handling middleware

`errorHandler` converts uncaught errors to a JSON `500` response. Install it early so it wraps all downstream middleware:

```ts
import { App, errorHandler } from 'fino:net/http/app';

const guarded = app.layer(errorHandler({ expose: false })); // set expose: true in development
```

## Static files

`staticFiles` serves files from a local directory and falls through to downstream middleware on misses:

```ts
import { App, staticFiles } from 'fino:net/http/app';

const assets = app.layer(staticFiles('/var/www', { index: 'index.html', prefix: '/static/' }));
```

## Routers and mounting

`Router` is a reusable route collection. `mount()` is a terminal on a route builder: it resolves the router's operations into the target under the route's path, with anything accumulated on the branch prepended. A mounted router carries all of its operations — protocol routes included — and cannot be changed afterwards; registering on an already-mounted router throws.

```ts
import { App, Router } from 'fino:net/http/app';

const usersRouter = new Router();
const tenantUsers = usersRouter.value('tenant', () => 'default');

tenantUsers.route('/users').get().handle(() => Response.json([]));

const app = new App({ name: 'API' });
app.route('/v1').mount(usersRouter);
```

Routers mount into other routers the same way, so route trees compose:

```ts
const admin = new Router();
admin.route('/stats').get().handle(showStats);

const api = new Router();
api.route('/admin').mount(admin);

app.route('/v2').mount(api);                         // GET /v2/admin/stats
```

## WebSocket, SSE, and WebTransport routes

The protocol methods are terminals on a route builder — they take the handler directly, and everything enriched on the branch (middleware, values) runs before the connection is established. Middleware can reject an upgrade by returning a `Response` instead of calling `next()`.

`sse()` registers a server-sent events operation. The handler receives an `EventSourceWriter` wired to the response body; the stream ends when the handler returns. One operation matches both GET and POST:

```ts
import { App } from 'fino:net/http/app';

const app = new App();

app.route('/events').sse(async (events, ctx) => {
  await events.write({ data: 'connected' });
  await events.write({ event: 'done', data: '{}' });
});
```

See the [server-sent events guide](./server-sent-events.md) for the event format, heartbeats, and client-side parsing.

`websocket()` registers a WebSocket operation. The handler receives the `WebSocketConnection` and the context:

```ts
app.route('/chat')
  .use(requireSession)
  .websocket(async (socket, ctx) => {
    socket.addEventListener('message', (e) => socket.send((e as MessageEvent).data));
  });
```

`webtransport()` registers a WebTransport operation. The session is already accepted when the handler is called:

```ts
app.route('/session').webtransport(async (session, ctx) => {
  const stream = await session.createBidirectionalStream();
  // ... use stream.readable and stream.writable
});
```

A plain HTTP request to a path served only by WebSocket or WebTransport operations returns **426 Upgrade Required** with an `Upgrade` header.

## JSON-RPC

`rpc()` is a terminal that mounts a `JsonRpcService` as a POST operation. Other methods on the same path return 405 with `Allow: POST`:

```ts
import { App } from 'fino:net/http/app';
import { JsonRpcService } from 'fino:jsonrpc';

const svc = new JsonRpcService();
svc.method('ping').handle(() => 'pong');

app.route('/rpc').rpc(svc);
```

## Dispatching manually

`app.handle()` dispatches a synthetic request for testing or embedding inside another handler:

```ts
const res = await app.handle(new Request('http://internal/health'));
console.log(res.status);
```

## OpenAPI

`app.openapi()` generates an OpenAPI 3.1 document from all registered operations and accumulated metadata. Metadata from `defineMiddleware` and `defineProducer` is merged automatically; HTTP, SSE, and RPC operations are documented (SSE paths emit GET and POST operations with a `text/event-stream` response), while WebSocket and WebTransport operations are not part of the OpenAPI surface.

```ts
const doc = app.openapi({ version: '1.0.0', title: 'My API' });
```

`app.openapiHandler()` returns a `Handler` that serves the document as JSON:

```ts
app.get('/openapi.json').handle(app.openapiHandler({ version: '1.0.0' }));
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
  .get()
  .handle((ctx) => Response.json({ id: ctx.params?.id }));
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
