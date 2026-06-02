# app

fino:net/http/app — middleware, routing, and OpenAPI for HTTP services.

This module builds a small application framework on top of Fino's existing
`Request`, `Response`, and `serve()` APIs. It is intended for APIs that need
composable middleware, URLPattern routing, request-scoped values, and a
machine-readable OpenAPI document without giving up direct access to the
underlying Fetch-compatible HTTP primitives.

The middleware model is Koa-style: each middleware receives `(ctx, next)` and
may short-circuit by returning a `Response`, or may `await next()` and mutate
the downstream response. Builders (`App`, `Router`, `RouteBuilder`, and
`MethodBuilder`) share `.use()`, `.value()`, and `.meta()`. A value producer
declares a context slot and populates it only when that point in the
middleware stack is reached; duplicate slot declarations throw while the app
is being built.

Routing uses the platform `URLPattern` implementation with pathname patterns
such as `/users/:id`. Path parameters are available through the built-in
`schema.params()` producer, which reserves the usual `params` slot and
validates the matched parameter object. `app.context()` returns the active
request context from anywhere in the async call chain by using
`fino:context`.

OpenAPI generation targets OpenAPI 3.1 and embeds JSON Schema objects from
`fino:validate` directly. Middleware can describe documentation effects with
`defineMiddleware(fn, meta)` and `defineProducer(fn, meta)`, making runtime
logic independent from documentation generation.

```ts
import { App, body, schema } from 'fino:net/http/app';
import { v } from 'fino:validate';

const app = new App({ name: 'Example API' });
app.route('/users/:id')
  .meta({ tags: ['users'] })
  .value('params', schema.params(v.object({ id: v.string() })))
  .post()
  .value('body', body.json(v.object({ name: v.string() })))
  .handle((ctx) => Response.json({ id: ctx.params.id, name: ctx.body.name }));

app.get('/openapi.json', app.openapiHandler({ version: '1.0.0' }));
app.listen({ port: 3000 });
```

Learn more:
- OpenAPI 3.1: https://spec.openapis.org/oas/v3.1.0
- URLPattern: https://wicg.github.io/urlpattern/
- HTTP cookies: https://www.rfc-editor.org/rfc/rfc6265

## HttpMethod

```ts
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
```

Standard HTTP methods supported by route builders.

```ts
const method: HttpMethod = 'GET';
```

## HttpContext

```ts
interface HttpContext {
```

Request context object passed through app middleware and handlers.

Producers can add additional keys, so application-specific context values are
exposed through the index signature. Built-in helpers commonly add `params`,
`query`, `headers`, `body`, `cookies`, and `session`.

```ts
const handler: Handler = (ctx) => Response.json({ route: ctx.route });
```

### request

```ts
request: Request
```

Fetch-compatible request being handled.

```ts
console.log(ctx.request.method);
```

### app

```ts
app: App
```

App instance that is dispatching this request.

```ts
console.log(ctx.app.context());
```

### route

```ts
route: string
```

Matched route pathname pattern, such as `/users/:id`.

```ts
console.log(ctx.route);
```

### method

```ts
method: string
```

Matched HTTP method.

```ts
console.log(ctx.method);
```

### params

```ts
params?: Record<string, string>
```

URLPattern path parameters when a route matched.

```ts
console.log(ctx.params?.id);
```

## Middleware

```ts
type Middleware = (
  ctx: HttpContext,
  next: (
  ) => Promise<Response | ConnectionTakeover>
) => Response | ConnectionTakeover | void | Promise<Response | ConnectionTakeover | void>
```

Koa-style middleware. Return a response to short-circuit or call `next()`.

Returning `undefined` after calling `next()` uses the downstream response.
Calling `next()` more than once throws at runtime.

```ts
const timing: Middleware = async (ctx, next) => {
  const res = await next();
  res.headers.set('x-route', ctx.route);
  return res;
};
```

## Handler

```ts
type Handler = (
  ctx: HttpContext
) => Response | ConnectionTakeover | Promise<Response | ConnectionTakeover>
```

Terminal route handler.

Handlers must return a `Response` or a protocol takeover such as a WebSocket
connection. Throwing is normally handled by `errorHandler()`.

```ts
const handler: Handler = (ctx) => Response.json({ id: ctx.params?.id });
```

## Producer

```ts
type Producer = (ctx: HttpContext) => unknown | Promise<unknown>
```

Context value producer used by `.value(name, producer)`.

The producer runs at its position in the middleware stack and stores its
return value under the declared context key.

```ts
const currentUser: Producer = async (ctx) => loadUser(ctx.request);
```

## OperationMeta

```ts
interface OperationMeta {
```

OpenAPI metadata that can be attached to builders, middleware, or producers.

Metadata is merged as routes are built. Duplicate parameters or request
bodies throw unless `replaceRequestBody` is set.

```ts
app.route('/users').meta({ tags: ['users'], summary: 'List users' });
```

### operationId

```ts
operationId?: string
```

Explicit OpenAPI operationId.

```ts
route.meta({ operationId: 'getUser' });
```

### summary

```ts
summary?: string
```

Short OpenAPI summary.

```ts
route.meta({ summary: 'Create a user' });
```

### description

```ts
description?: string
```

Longer OpenAPI description.

```ts
route.meta({ description: 'Creates a user account.' });
```

### tags

```ts
tags?: string[]
```

OpenAPI tags for grouping operations.

```ts
route.meta({ tags: ['users'] });
```

### security

```ts
security?: unknown
```

OpenAPI security requirement object or array.

```ts
route.meta({ security: [{ bearerAuth: [] }] });
```

### parameters

```ts
parameters?: OpenApiParameter[]
```

Additional OpenAPI parameters.

```ts
route.meta({ parameters: [{ name: 'id', in: 'path', required: true }] });
```

### requestBody

```ts
requestBody?: OpenApiRequestBody
```

OpenAPI requestBody metadata.

```ts
route.meta({ requestBody: { required: true, content: { 'application/json': { schema } } } });
```

### responses

```ts
responses?: Record<string, OpenApiResponse>
```

OpenAPI responses keyed by status code.

```ts
route.meta({ responses: { '200': { description: 'OK' } } });
```

### replaceRequestBody

```ts
replaceRequestBody?: boolean
```

Replace an inherited requestBody instead of throwing on duplication.

```ts
route.meta({ replaceRequestBody: true, requestBody });
```

## OpenApiOptions

```ts
interface OpenApiOptions {
```

Options passed to `App.openapi()`.

`version` is required and becomes `info.version`. `title` defaults to the app
name passed to `new App()`.

```ts
const doc = app.openapi({ version: '1.0.0', title: 'Admin API' });
```

### title

```ts
title?: string
```

OpenAPI info title; defaults to the app name.

```ts
app.openapi({ title: 'Example API', version: '1.0.0' });
```

### version

```ts
version: string
```

OpenAPI info version.

```ts
app.openapi({ version: '1.0.0' });
```

### servers

```ts
servers?: Array<Record<string, unknown>>
```

Optional OpenAPI servers array.

```ts
app.openapi({ version: '1.0.0', servers: [{ url: 'https://api.example.com' }] });
```

## defineMiddleware

```ts
function defineMiddleware<T extends Middleware>(fn: T, meta: OperationMeta = {}): T
```

Attach static OpenAPI metadata to a middleware function.

The returned function is the original function with non-enumerable metadata
attached. Metadata is read when the middleware is installed in a route stack.

```ts
const auth = defineMiddleware(async (ctx, next) => next(), {
  security: [{ bearerAuth: [] }],
});
```

## defineProducer

```ts
function defineProducer<T extends Producer>(fn: T, meta: OperationMeta = {}): T
```

Attach static OpenAPI metadata to a context value producer.

The returned producer is the original function with metadata attached. Use
this for reusable body, params, query, or session producers.

```ts
const user = defineProducer(async (ctx) => loadUser(ctx), {
  parameters: [{ name: 'user-id', in: 'header' }],
});
```

## App

```ts
class App extends BuilderBase<App> {
```

HTTP application with middleware, routes, async context, serving, and docs.

```ts
const app = new App({ name: 'Example API' });
app.get('/', () => new Response('ok'));
```

### constructor

```ts
constructor(options: {
  name?: string;
} = {})
```

Create an application. `name` becomes the default OpenAPI title.

```ts
const app = new App({ name: 'Billing API' });
```

### context

```ts
context(): HttpContext | undefined
```

Return the current request context, or `undefined` outside app handling.

This uses async context propagation, so it can be called from helpers
invoked by a handler.

```ts
const ctx = app.context();
```

### route

```ts
route(path: string): RouteBuilder
```

Create a route builder for one URLPattern pathname.

```ts
app.route('/users/:id').get((ctx) => Response.json(ctx.params));
```

### mount

```ts
mount(prefix: string, router: Router): this
```

Mount all routes from a router under a prefix.

Router middleware is combined with current app middleware at mount time.

```ts
app.mount('/api', router);
```

### get

```ts
get(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register a GET route directly or return a method builder.

```ts
app.get('/health', () => new Response('ok'));
```

### post

```ts
post(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register a POST route directly or return a method builder.

```ts
app.post('/users', body.json(), (ctx) => Response.json(ctx.body));
```

### put

```ts
put(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register a PUT route directly or return a method builder.

```ts
app.put('/users/:id', (ctx) => Response.json(ctx.params));
```

### patch

```ts
patch(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register a PATCH route directly or return a method builder.

```ts
app.patch('/users/:id', (ctx) => Response.json(ctx.params));
```

### delete

```ts
delete(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register a DELETE route directly or return a method builder.

```ts
app.delete('/users/:id', () => new Response(null, { status: 204 }));
```

### head

```ts
head(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register a HEAD route directly or return a method builder.

```ts
app.head('/health', () => new Response(null, { status: 204 }));
```

### options

```ts
options(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder
```

Register an OPTIONS route directly or return a method builder.

```ts
app.options('/users', () => new Response(null, { status: 204 }));
```

### handle

```ts
async handle(req: Request): Promise<Response | ConnectionTakeover>
```

Dispatch one request through the matching route stack.

Returns a JSON 404 response when no method/path pair matches. Matching is
based on the URL pathname and the request method.

```ts
const response = await app.handle(new Request('http://local/health'));
```

### listen

```ts
listen(options: Parameters<typeof serve>[0]): ReturnType<typeof serve>
```

Start an HTTP server that dispatches requests to this app.

The returned server is the same object returned by `serve()`.

```ts
const server = app.listen({ port: 3000 });
```

### openapi

```ts
openapi(options: OpenApiOptions): Record<string, unknown>
```

Generate an OpenAPI 3.1 document from registered routes and metadata.

Throws when generated or explicit operation IDs collide.

```ts
const doc = app.openapi({ version: '1.0.0' });
```

### openapiHandler

```ts
openapiHandler(options: OpenApiOptions): Handler
```

Return a handler that serves this app's OpenAPI document as JSON.

```ts
app.get('/openapi.json', app.openapiHandler({ version: '1.0.0' }));
```

## Router

```ts
class Router extends BuilderBase<Router> {
```

Reusable route collection mountable into an `App`.

```ts
const router = new Router();
router.get('/users', () => Response.json([]));
app.mount('/api', router);
```

### route

```ts
route(path: string): RouteBuilder
```

Create a route builder inside this router.

```ts
router.route('/users/:id').get((ctx) => Response.json(ctx.params));
```

### get

```ts
get(path: string, ...stack: Array<Middleware | Handler>): this
```

Register a GET route directly.

```ts
router.get('/items', () => Response.json([]));
```

### post

```ts
post(path: string, ...stack: Array<Middleware | Handler>): this
```

Register a POST route directly.

```ts
router.post('/items', (ctx) => Response.json(ctx.body));
```

### put

```ts
put(path: string, ...stack: Array<Middleware | Handler>): this
```

Register a PUT route directly.

```ts
router.put('/items/:id', (ctx) => Response.json(ctx.params));
```

### patch

```ts
patch(path: string, ...stack: Array<Middleware | Handler>): this
```

Register a PATCH route directly.

```ts
router.patch('/items/:id', (ctx) => Response.json(ctx.params));
```

### delete

```ts
delete(path: string, ...stack: Array<Middleware | Handler>): this
```

Register a DELETE route directly.

```ts
router.delete('/items/:id', () => new Response(null, { status: 204 }));
```

### head

```ts
head(path: string, ...stack: Array<Middleware | Handler>): this
```

Register a HEAD route directly.

```ts
router.head('/items', () => new Response(null, { status: 204 }));
```

### options

```ts
options(path: string, ...stack: Array<Middleware | Handler>): this
```

Register an OPTIONS route directly.

```ts
router.options('/items', () => new Response(null, { status: 204 }));
```

## RouteBuilder

```ts
class RouteBuilder extends BuilderBase<RouteBuilder> {
```

Builder for one URLPattern pathname and shared route-level metadata.

```ts
app.route('/users/:id').meta({ tags: ['users'] }).get((ctx) => Response.json(ctx.params));
```

### constructor

```ts
constructor(owner: App | Router, path: string, state: BuildState)
```

Create a route builder.

This is normally created through `app.route()` or `router.route()`.

```ts
const route = new RouteBuilder(app, '/items', state);
```

### get

```ts
get(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build GET endpoint.

```ts
app.route('/items').get((ctx) => Response.json([]));
```

### post

```ts
post(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build POST endpoint.

```ts
app.route('/items').post().handle((ctx) => Response.json(ctx.body));
```

### put

```ts
put(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build PUT endpoint.

```ts
app.route('/items/:id').put((ctx) => Response.json(ctx.params));
```

### patch

```ts
patch(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build PATCH endpoint.

```ts
app.route('/items/:id').patch((ctx) => Response.json(ctx.params));
```

### delete

```ts
delete(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build DELETE endpoint.

```ts
app.route('/items/:id').delete(() => new Response(null, { status: 204 }));
```

### head

```ts
head(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build HEAD endpoint.

```ts
app.route('/items').head(() => new Response(null, { status: 204 }));
```

### options

```ts
options(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder
```

Register or build OPTIONS endpoint.

```ts
app.route('/items').options(() => new Response(null, { status: 204 }));
```

## MethodBuilder

```ts
class MethodBuilder extends BuilderBase<MethodBuilder> {
```

Builder for one method endpoint. Call `.handle()` to finalize the endpoint.

```ts
app.route('/items').post().value('body', body.json()).handle((ctx) => Response.json(ctx.body));
```

### constructor

```ts
constructor(route: RouteBuilder, method: HttpMethod, state: BuildState)
```

Create a method builder.

This is normally created by a `RouteBuilder` method such as `.get()`.

```ts
const method = new MethodBuilder(route, 'GET', state);
```

### handle

```ts
handle(handler: Handler): RouteBuilder
```

Finalize the endpoint and return the parent route builder for chaining.

Calling this registers the endpoint on the owning app or router.

```ts
app.route('/items').get().handle(() => Response.json([]));
```

## schema

```ts
const schema
```

Validation and OpenAPI helpers for parameters and responses.

These helpers wrap `fino:validate` schemas and attach matching OpenAPI
metadata. Runtime validation failures throw from middleware or producer
execution.

```ts
app.get('/users', schema.query(v.object({ q: v.string() })), (ctx) => Response.json(ctx.query));
```

### params

```ts
params(schemaValue: unknown): Producer
```

Validate route params and contribute OpenAPI path parameters.

The parsed value is produced for the context key selected by `.value()`.

```ts
app.route('/users/:id').value('params', schema.params(v.object({ id: v.string() })));
```

### query

```ts
query(schemaValue: unknown): Middleware
```

Validate query parameters and contribute OpenAPI query parameters.

Parsed query values are stored as `ctx.query`. Repeated query keys are
represented as arrays before validation.

```ts
app.get('/search', schema.query(v.object({ q: v.string() })), (ctx) => Response.json(ctx.query));
```

### headers

```ts
headers(schemaValue: unknown): Middleware
```

Validate headers and contribute OpenAPI header parameters.

Parsed headers are stored as `ctx.headers` using lowercase header names.

```ts
app.get('/secure', schema.headers(v.object({ authorization: v.string() })), handler);
```

### response

```ts
response(schemaValue: unknown, opts: {
  status?: number;
  description?: string;
  contentType?: string;
} = {}): Middleware
```

Validate downstream response bodies and contribute OpenAPI responses.

The middleware clones matching `Response` objects before reading JSON, so
the original response body remains available for serialization. Only the
configured status and content type are validated.

```ts
app.get('/health', schema.response(v.object({ ok: v.boolean() })), () => Response.json({ ok: true }));
```

## body

```ts
const body
```

Request body producers for `.value('body', body.json(...))` and friends.

Body producers consume the request body exactly once. Install them at the
point in the stack where the parsed body should become available.

```ts
app.post('/items').value('body', body.json()).handle((ctx) => Response.json(ctx.body));
```

### json

```ts
json(schemaValue?: unknown): Producer
```

Read and optionally validate a JSON request body.

Accepts an empty content type or `application/json`. Other content types
throw before the body is read.

```ts
route.post().value('body', body.json(v.object({ name: v.string() })));
```

### text

```ts
text(): Producer
```

Read the request body as text.

```ts
route.post().value('body', body.text()).handle((ctx) => new Response(String(ctx.body)));
```

### bytes

```ts
bytes(): Producer
```

Read the request body as bytes.

```ts
route.post().value('body', body.bytes()).handle((ctx) => new Response(ctx.body as Uint8Array));
```

### form

```ts
form(): Producer
```

Read the request body as form data when the Request implementation supports it.

Throws when `Request.formData()` is not available in the runtime.

```ts
route.post().value('form', body.form());
```

## CookieJar

```ts
class CookieJar {
```

Mutable cookie jar populated from the request and applied to the response.

Queue cookie changes with `set()` or `delete()`. The app middleware pipeline
applies queued `Set-Cookie` headers after a `Response` is produced.

```ts
const jar = new CookieJar('sid=123');
jar.set('theme', 'dark', { path: '/' });
```

### constructor

```ts
constructor(header: string | null)
```

Parse a Cookie header into a mutable jar.

`null` creates an empty jar. Invalid cookie parsing behavior follows
`parseCookieHeader`.

```ts
const jar = new CookieJar(ctx.request.headers.get('cookie'));
```

### get

```ts
get(name: string): string | undefined
```

Read one request cookie.

Returns `undefined` when the cookie was not present or was deleted locally.

```ts
const sid = jar.get('sid');
```

### all

```ts
all(): Record<string, string>
```

Return all request cookies as a plain object copy.

```ts
const values = jar.all();
```

### set

```ts
set(name: string, value: string, options: CookieOptions = {}): void
```

Queue a `Set-Cookie` header and update this jar's current value.

Cookie options are passed to `serializeCookie`.

```ts
jar.set('sid', session.id, { httpOnly: true, path: '/' });
```

### delete

```ts
delete(name: string, options: CookieOptions = {}): void
```

Queue an expired `Set-Cookie` header and remove this jar's current value.

```ts
jar.delete('sid', { path: '/' });
```

## cookies

```ts
function cookies(): Producer
```

Producer that creates a `CookieJar` and appends queued cookies downstream.

Use with `.value('cookies', cookies())` so handlers can read and mutate
cookies through `ctx.cookies`.

```ts
app.value('cookies', cookies());
```

## Session

```ts
interface Session {
```

Session data persisted by a `SessionStore`.

```ts
session.data.userId = 'u_123';
```

### id

```ts
id: string
```

Stable session ID.

```ts
console.log(session.id);
```

### data

```ts
data: Record<string, unknown>
```

Mutable session payload.

```ts
session.data.count = Number(session.data.count ?? 0) + 1;
```

### isNew

```ts
isNew: boolean
```

True when this session was created for the current request.

```ts
if (session.isNew) console.log('new session');
```

## SessionStore

```ts
interface SessionStore {
```

Minimal async session store interface.

Store methods may be synchronous or async. Returned sessions should be safe
for request-local mutation.

```ts
const store = memorySessionStore();
```

### get

```ts
get(id: string): Session | null | Promise<Session | null>
```

Load a session by ID, or return `null` when missing.

```ts
const session = await store.get(id);
```

### set

```ts
set(id: string, session: Session): void | Promise<void>
```

Persist a session by ID.

```ts
await store.set(session.id, session);
```

### delete

```ts
delete(id: string): void | Promise<void>
```

Delete a session by ID.

```ts
await store.delete(id);
```

## memorySessionStore

```ts
function memorySessionStore(): SessionStore
```

Create an in-memory session store suitable for tests and single-process apps.

Data is lost when the process exits and is not shared across workers.

```ts
const store = memorySessionStore();
app.value('session', sessions({ store }));
```

## sessions

```ts
function sessions(opts: {
  store: SessionStore;
  cookie?: string;
  cookieOptions?: CookieOptions;
}): Producer
```

Producer that loads a cookie-backed session and saves it after response creation.

Expects `ctx.cookies` to be a `CookieJar` when installed after
`.value('cookies', cookies())`; otherwise it creates a private jar. New
sessions are assigned UUIDs and persisted after the response is produced.

```ts
app.value('cookies', cookies()).value('session', sessions({ store: memorySessionStore() }));
```

## errorHandler

```ts
function errorHandler(opts: {
  expose?: boolean;
} = {}): Middleware
```

Middleware that converts uncaught errors to a JSON error response.

By default, error messages are hidden. Pass `{ expose: true }` for development
or trusted internal APIs.

```ts
app.use(errorHandler({ expose: false }));
```

## staticFiles

```ts
function staticFiles(root: string, opts: {
  index?: string;
  prefix?: string;
} = {}): Middleware
```

Serve files from a local root directory, short-circuiting matched requests.

The request path must start with `opts.prefix` (default `/`). Paths are
normalized and `..` traversal is rejected with 403. Missing files fall
through to downstream middleware.

```ts
app.use(staticFiles('/var/www', { index: 'index.html', prefix: '/' }));
```
