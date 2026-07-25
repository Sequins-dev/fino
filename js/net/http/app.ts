/**
* fino:net/http/app — middleware, routing, and OpenAPI for HTTP services.
*
* This module builds a small application framework on top of Fino's existing
* `Request`, `Response`, and `serve()` APIs. It is intended for APIs that need
* composable middleware, URLPattern routing, request-scoped values, and a
* machine-readable OpenAPI document without giving up direct access to the
* underlying Fetch-compatible HTTP primitives.
*
* The middleware model has two explicit forms. `use()` installs one-way branch
* middleware that may short-circuit by returning a `Response` or continue by
* returning nothing. `layer()` installs Koa-style wrappers that receive
* `(ctx, next)` and can run before and after downstream dispatch. Builders
* (`App`, `Router`, `RouteBuilder`, and `MethodBuilder`) share `.use()`,
* `.layer()`, `.value()`, and `.meta()` as immutable enrichments of a routing
* tree: each call records a node, terminals such as `.handle()` resolve the
* branch they hang off, and a later `value()` with the same name shadows an
* earlier one. Everything that binds a routing path goes through `route()` —
* HTTP verbs fork method branches finished by `.handle()`, while `websocket()`,
* `sse()`, `webtransport()`, `rpc()`, and `mount()` are terminals that register
* directly.
*
* Routing uses the platform `URLPattern` implementation with pathname patterns
* such as `/users/:id`. Path parameters are available through the built-in
* `schema.params()` producer, which reserves the usual `params` slot and
* validates the matched parameter object. `app.context()` returns the active
* request context from anywhere in the async call chain by using
* `fino:context`.
*
* Server sessions are part of this same application surface. `sessions()`
* accepts a caller-owned `RevisionedCache` directly, seals browser identifiers,
* supports key rotation and fixed or rolling expiry, and uses conditional
* writes so stale requests cannot silently overwrite newer state. Applications
* choose and close their cache backend; the middleware owns only session
* lifecycle and cookie policy.
*
* OpenAPI generation targets OpenAPI 3.1 and embeds JSON Schema objects from
* `fino:validate` directly. Middleware can describe documentation effects with
* `defineMiddleware(fn, meta)` and `defineProducer(fn, meta)`, making runtime
* logic independent from documentation generation.
*
* ```ts no_run
* import { App, body, schema } from 'fino:net/http/app';
* import { v } from 'fino:validate';
*
* const app = new App({ name: 'Example API' });
* const api = app.layer(errorHandler());
* api.route('/users/:id')
*   .meta({ tags: ['users'] })
*   .value('params', schema.params(v.object({ id: v.string() })))
*   .post()
*   .value('body', body.json(v.object({ name: v.string() })))
*   .handle((ctx) => Response.json({ id: ctx.params.id, name: ctx.body.name }));
*
* app.get('/openapi.json').handle(app.openapiHandler({ version: '1.0.0' }));
* app.listen({ port: 3000 });
* ```
*
* Learn more:
* - OpenAPI 3.1: https://spec.openapis.org/oas/v3.1.0
* - URLPattern: https://wicg.github.io/urlpattern/
* - HTTP cookies: https://www.rfc-editor.org/rfc/rfc6265
*/
import { Context } from '../../context/index.ts';
import { DiskFileSystem } from '../../file/fs.ts';
import { join, normalize } from '../../file/path.ts';
import { CookieJar } from '../../security/cookie.ts';
import { compile } from '../../validate.ts';
import { Headers, Request, Response } from './index.ts';
import { serve } from './server.ts';
import type { AcceptedHttpRequest, HttpHandlerResult, HttpSession, HttpProtocol, IncomingHttp, IncomingHttpRequest, IncomingWebSocketRequest, IncomingWebTransportRequest } from './server.ts';
import { WebSocketConnection } from './websocket.ts';
import { WebTransport } from './webtransport.ts';
import { EventSourceWriter } from './eventstream.ts';
import { Channel } from '../../internal/stream.ts';
export { CookieJar } from '../../security/cookie.ts';
export { SessionConflictError, sessions } from './session.ts';
export type { Session, SessionClock, SessionKey, SessionOptions, SessionRecord } from './session.ts';
/**
* Standard HTTP methods supported by route builders.
*
* ```ts no_run
* const method: HttpMethod = 'GET';
* ```
*/
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
/**
* Request context object passed through app middleware and handlers.
*
* Producers can add additional keys, so application-specific context values are
* exposed through the index signature. Built-in helpers commonly add `params`,
* `query`, `headers`, `body`, `cookies`, and `session`.
*
* ```ts no_run
* const handler: Handler = (ctx) => Response.json({ route: ctx.route });
* ```
*/
export interface HttpContext {
  /** Fetch-compatible request being handled.
  *
  * ```ts no_run
  * console.log(ctx.request.method);
  * ```
  */
  request: Request;
  /** App instance that is dispatching this request.
  *
  * ```ts no_run
  * console.log(ctx.app.context());
  * ```
  */
  app: App;
  /** Matched route pathname pattern, such as `/users/:id`.
  *
  * ```ts no_run
  * console.log(ctx.route);
  * ```
  */
  route: string;
  /** Matched HTTP method.
  *
  * ```ts no_run
  * console.log(ctx.method);
  * ```
  */
  method: string;
  /** Protocol carrying the current request. */
  protocol: HttpProtocol;
  /** Transport session carrying the current request. */
  session?: HttpSession;
  /** Accept object that produced this request, when dispatched by `App.listen()`. */
  incoming?: IncomingHttp;
  /** URLPattern path parameters when a route matched.
  *
  * ```ts no_run
  * console.log(ctx.params?.id);
  * ```
  */
  params?: Record<string, string>;
  /** Application-defined values populated by producers.
  *
  * ```ts no_run
  * console.log(ctx.user);
  * ```
  */
  [key: string]: unknown;
}
/**
* Request context passed to WebSocket route handlers.
*
* Identical to `HttpContext` except that `incoming` is narrowed to the pending
* WebSocket upgrade, which the route framework accepts on the handler's behalf
* before the handler runs. Middleware on the branch still sees the request as a
* plain `HttpContext`, so producers and values populate this context the same
* way they do for HTTP routes.
*
* ```ts no_run
* app.route('/chat').websocket((socket, ctx: WebSocketContext) => {
*   console.log('upgraded', ctx.route, ctx.params);
*   socket.addEventListener('message', (e) => socket.send(e.data));
* });
* ```
*/
export interface WebSocketContext extends HttpContext {
  /** Pending WebSocket upgrade the route accepted to produce `socket`. */
  incoming: IncomingWebSocketRequest;
}
/**
* Request context passed to WebTransport route handlers.
*
* Like `WebSocketContext`, this narrows `incoming` to the pending WebTransport
* upgrade the route accepts before the handler runs. All other context values
* — matched `route`, `params`, and anything added by producers on the branch —
* are populated exactly as they are for HTTP routes.
*
* ```ts no_run
* app.route('/wt/:room').webtransport(async (session, ctx: WebTransportContext) => {
*   console.log('room', ctx.params?.room);
*   await session.ready;
* });
* ```
*/
export interface WebTransportContext extends HttpContext {
  /** Pending WebTransport upgrade the route accepted to produce `session`. */
  incoming: IncomingWebTransportRequest;
}
/**
* Request context passed to server-sent events route handlers.
*
* SSE is not an HTTP upgrade. It is an ordinary HTTP request whose response
* body remains open with `text/event-stream`, so `incoming` is narrowed to the
* plain request variant when the app is dispatching from `listen()`. Middleware
* can still reject before the SSE stream starts by returning a `Response`.
*
* ```ts no_run
* app.route('/events').sse(async (events, ctx: SseContext) => {
*   console.log(ctx.request.headers.get('last-event-id'));
*   await events.write({ data: 'connected' });
* });
* ```
*/
export interface SseContext extends HttpContext {
  /**
  * Incoming plain HTTP request, when dispatched by `App.listen()`.
  *
  * This is not an upgrade request; it has already been accepted as ordinary
  * HTTP before the route handler starts streaming.
  */
  incoming?: IncomingHttpRequest;
}
/**
* What a handler or middleware may ultimately resolve to.
*
* Re-exported from the server module so app code can name the return type of
* `Handler` and `Middleware` without a second import. The value is either a
* `Response` (the normal case) or a protocol-takeover object — a
* `WebSocketConnection` or `WebTransport` — when a route has upgraded the
* connection and is speaking a different protocol from there on.
*
* ```ts no_run
* import type { HttpHandlerResult } from 'fino:net/http/app';
*
* async function log(res: Promise<HttpHandlerResult>): Promise<HttpHandlerResult> {
*   const value = await res;
*   if (value instanceof Response) console.log(value.status);
*   return value;
* }
* ```
*/
export type { HttpHandlerResult } from './server.ts';
/**
* One-way branch middleware run before downstream handlers.
*
* Each middleware receives the shared request context. Returning a
* `HttpHandlerResult` short-circuits the chain and skips everything downstream;
* returning `undefined` (or nothing) continues to the next branch item. Use
* `LayerMiddleware` with `.layer()` when code needs a `next` callback or needs
* to inspect the downstream response.
*
* ```ts no_run
* const requireUser: Middleware = async (ctx) => {
*   if (ctx.user === undefined) return Response.json({ error: 'Unauthorized' }, { status: 401 });
* };
* app.route('/account').use(requireUser).get().handle(showAccount);
* ```
*/
export type Middleware = (ctx: HttpContext) => HttpHandlerResult | void | Promise<HttpHandlerResult | void>;
/**
* Koa-style wrapper layer run around downstream dispatch.
*
* A layer receives the shared request context and a `next` callback. Calling
* `await next()` continues dispatch and yields the downstream result, which the
* layer may inspect or mutate before returning. Returning a response without
* calling `next()` short-circuits the rest of dispatch.
*
* `next()` must be called at most once per invocation — calling it a second
* time throws `next() called multiple times`.
*
* ```ts no_run
* const timing: LayerMiddleware = async (ctx, next) => {
*   const res = await next();
*   if (res instanceof Response) res.headers.set('x-route', ctx.route);
*   return res;
* };
* app.layer(timing);
* ```
*/
export type LayerMiddleware = (ctx: HttpContext, next: () => Promise<HttpHandlerResult>) => HttpHandlerResult | void | Promise<HttpHandlerResult | void>;
/**
* Terminal route handler.
*
* Handlers must return a `Response` or a protocol takeover such as a WebSocket
* connection. Throwing is normally handled by `errorHandler()`.
*
* ```ts no_run
* const handler: Handler = (ctx) => Response.json({ id: ctx.params?.id });
* ```
*/
export type Handler = (ctx: HttpContext) => HttpHandlerResult | Promise<HttpHandlerResult>;
/**
* Terminal handler for a WebSocket route.
*
* The upgrade is already accepted by the time the handler runs, so it receives
* a live `WebSocketConnection` and the request context. Register event
* listeners and start reading before the handler returns; returning does not
* close the socket, so keep the promise pending only as long as setup requires.
*
* ```ts no_run
* const echo: WebSocketHandler = (socket) => {
*   socket.addEventListener('message', (event) => socket.send(event.data));
* };
* app.route('/echo').websocket(echo);
* ```
*/
export type WebSocketHandler = (socket: WebSocketConnection, ctx: WebSocketContext) => void | Promise<void>;
/**
* Terminal handler for a WebTransport route.
*
* Runs after the session upgrade is accepted, receiving a live `WebTransport`
* session and the request context. Await `session.ready` before opening or
* accepting streams; as with WebSocket handlers, returning does not close the
* session.
*
* ```ts no_run
* const handler: WebTransportHandler = async (session) => {
*   await session.ready;
* };
* app.route('/wt').webtransport(handler);
* ```
*/
export type WebTransportHandler = (session: WebTransport, ctx: WebTransportContext) => void | Promise<void>;
/**
* Terminal handler for a server-sent events route.
*
* The handler receives an `EventSourceWriter` connected to the response body.
* The response streams while the handler runs and ends when it returns. Unlike
* WebSocket and WebTransport handlers, there is no protocol upgrade to accept:
* SSE is a normal HTTP response with a long-lived body.
*
* ```ts no_run
* const clock: SseHandler = async (events) => {
*   await events.write({ event: 'tick', data: new Date().toISOString() });
* };
* app.route('/clock').sse(clock);
* ```
*/
export type SseHandler = (events: EventSourceWriter, ctx: SseContext) => void | Promise<void>;
/**
* Context value producer used by `.value(name, producer)`.
*
* The producer runs at its position in the middleware stack and stores its
* return value under the declared context key.
*
* ```ts no_run
* const currentUser: Producer = async (ctx) => loadUser(ctx.request);
* ```
*/
export type Producer = (ctx: HttpContext) => unknown | Promise<unknown>;
/**
* OpenAPI metadata that can be attached to builders, middleware, or producers.
*
* Metadata is merged as routes are built. Later metadata overrides earlier
* metadata key by key: parameters replace by `(in, name)`, request bodies and
* per-status responses replace outright.
*
* ```ts no_run
* app.route('/users').meta({ tags: ['users'], summary: 'List users' });
* ```
*/
export interface OperationMeta {
  /** Explicit OpenAPI operationId.
  *
  * ```ts no_run
  * route.meta({ operationId: 'getUser' });
  * ```
  */
  operationId?: string;
  /** Short OpenAPI summary.
  *
  * ```ts no_run
  * route.meta({ summary: 'Create a user' });
  * ```
  */
  summary?: string;
  /** Longer OpenAPI description.
  *
  * ```ts no_run
  * route.meta({ description: 'Creates a user account.' });
  * ```
  */
  description?: string;
  /** OpenAPI tags for grouping operations.
  *
  * ```ts no_run
  * route.meta({ tags: ['users'] });
  * ```
  */
  tags?: string[];
  /** OpenAPI security requirement object or array.
  *
  * ```ts no_run
  * route.meta({ security: [{ bearerAuth: [] }] });
  * ```
  */
  security?: unknown;
  /** Additional OpenAPI parameters.
  *
  * ```ts no_run
  * route.meta({ parameters: [{ name: 'id', in: 'path', required: true }] });
  * ```
  */
  parameters?: OpenApiParameter[];
  /** OpenAPI requestBody metadata.
  *
  * ```ts no_run
  * route.meta({ requestBody: { required: true, content: { 'application/json': { schema } } } });
  * ```
  */
  requestBody?: OpenApiRequestBody;
  /** OpenAPI responses keyed by status code.
  *
  * ```ts no_run
  * route.meta({ responses: { '200': { description: 'OK' } } });
  * ```
  */
  responses?: Record<string, OpenApiResponse>;
}
/**
* Options passed to `App.openapi()`.
*
* `version` is required and becomes `info.version`. `title` defaults to the app
* name passed to `new App()`.
*
* ```ts no_run
* const doc = app.openapi({ version: '1.0.0', title: 'Admin API' });
* ```
*/
export interface OpenApiOptions {
  /** OpenAPI info title; defaults to the app name.
  *
  * ```ts no_run
  * app.openapi({ title: 'Example API', version: '1.0.0' });
  * ```
  */
  title?: string;
  /** OpenAPI info version.
  *
  * ```ts no_run
  * app.openapi({ version: '1.0.0' });
  * ```
  */
  version: string;
  /** Optional OpenAPI servers array.
  *
  * ```ts no_run
  * app.openapi({ version: '1.0.0', servers: [{ url: 'https://api.example.com' }] });
  * ```
  */
  servers?: Array<Record<string, unknown>>;
}
/**
* OpenAPI parameter object accepted by `OperationMeta.parameters`.
*
* Parameters are merged by `(in, name)` when metadata from builders,
* middleware, and producers is combined. `schema` should be an OpenAPI 3.1 JSON
* Schema object or a `fino:validate` schema converted through `toJSON()`.
*
* ```ts no_run
* const parameter: OpenApiParameter = {
*   name: 'id',
*   in: 'path',
*   required: true,
*   schema: { type: 'string' },
* };
* ```
*/
export interface OpenApiParameter {
  /** Parameter name as it appears in the path, query string, header, or cookie. */
  name: string;
  /** Location of the parameter in the HTTP request. */
  in: 'path' | 'query' | 'header' | 'cookie';
  /** Whether the parameter is required. Path parameters should set this true. */
  required?: boolean;
  /** OpenAPI 3.1 schema for the parameter value. */
  schema?: unknown;
  /** Human-readable parameter description. */
  description?: string;
}
/**
* OpenAPI request body object accepted by `OperationMeta.requestBody`.
*
* The `content` map is keyed by media type. Each entry carries a schema object
* that is copied into the generated OpenAPI document.
*
* ```ts no_run
* const body: OpenApiRequestBody = {
*   required: true,
*   content: {
*     'application/json': { schema: { type: 'object' } },
*   },
* };
* ```
*/
export interface OpenApiRequestBody {
  /** Whether the request body is required. */
  required?: boolean;
  /** Human-readable request body description. */
  description?: string;
  /** Media-type map for request body schemas. */
  content: Record<string, {
    /** OpenAPI 3.1 schema for this media type. */
    schema: unknown;
  }>;
}
/**
* OpenAPI response object accepted by `OperationMeta.responses`.
*
* Responses are keyed by status code in `OperationMeta.responses`. `content` is
* optional for status codes that do not return a body.
*
* ```ts no_run
* const response: OpenApiResponse = {
*   description: 'OK',
*   content: {
*     'application/json': { schema: { type: 'object' } },
*   },
* };
* ```
*/
export interface OpenApiResponse {
  /** Required human-readable response description. */
  description: string;
  /** Optional media-type map for response body schemas. */
  content?: Record<string, {
    /** OpenAPI 3.1 schema for this media type. */
    schema: unknown;
  }>;
}
type StackItem = {
  type: 'middleware';
  fn: Middleware;
  meta?: OperationMeta;
} | {
  type: 'layer';
  fn: LayerMiddleware;
  meta?: OperationMeta;
} | {
  type: 'producer';
  name: string;
  fn: Producer;
  meta?: OperationMeta;
};
type OperationKind = 'http' | 'websocket' | 'webtransport' | 'sse';
type Operation = {
  kind: OperationKind;
  method?: HttpMethod;
  path: string;
  pattern: URLPattern;
  stack: StackItem[];
  slots: string[];
  meta: OperationMeta;
  handler: Handler;
};
type BuilderNode = {
  kind: 'root';
  owner: RouterBase<unknown>;
} | {
  kind: 'middleware';
  fn: Middleware;
  meta?: OperationMeta;
  parent: BuilderNode;
} | {
  kind: 'layer';
  fn: LayerMiddleware;
  meta?: OperationMeta;
  parent: BuilderNode;
} | {
  kind: 'value';
  name: string;
  fn: Producer;
  meta?: OperationMeta;
  parent: BuilderNode;
} | {
  kind: 'meta';
  meta: OperationMeta;
  parent: BuilderNode;
} | {
  kind: 'path';
  fragment: string;
  parent: BuilderNode;
} | {
  kind: 'op';
  method: HttpMethod;
  parent: BuilderNode;
};
const middlewareMeta = Symbol('fino.http.app.middlewareMeta');
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function cloneSchema(schema: unknown): unknown {
  if (schema && typeof (schema as {
    toJSON?: unknown;
  }).toJSON === 'function') return (schema as {
    toJSON(): unknown;
  }).toJSON();
  return schema;
}
function cloneMeta(meta: OperationMeta): OperationMeta {
  return {
    ...meta,
    tags: meta.tags?.slice(),
    parameters: meta.parameters?.map((p) => ({
      ...p,
      schema: cloneSchema(p.schema)
    })),
    requestBody: meta.requestBody === undefined ? undefined : cloneRequestBody(meta.requestBody),
    responses: meta.responses === undefined ? undefined : cloneResponses(meta.responses)
  };
}
function cloneRequestBody(body: OpenApiRequestBody): OpenApiRequestBody {
  const content: Record<string, {
    schema: unknown;
  }> = {};
  for (const type of Object.keys(body.content)) content[type] = { schema: cloneSchema(body.content[type]!.schema) };
  return {
    ...body,
    content
  };
}
function cloneResponses(responses: Record<string, OpenApiResponse>): Record<string, OpenApiResponse> {
  const out: Record<string, OpenApiResponse> = {};
  for (const status of Object.keys(responses)) {
    const response = responses[status]!;
    const content: Record<string, {
      schema: unknown;
    }> = {};
    if (response.content !== undefined) {
      for (const type of Object.keys(response.content)) content[type] = { schema: cloneSchema(response.content[type]!.schema) };
    }
    out[status] = response.content === undefined ? { description: response.description } : {
      description: response.description,
      content
    };
  }
  return out;
}
function mergeMeta(base: OperationMeta, next: OperationMeta): OperationMeta {
  const out = cloneMeta(base);
  if (next.operationId !== undefined) out.operationId = next.operationId;
  if (next.summary !== undefined) out.summary = next.summary;
  if (next.description !== undefined) out.description = next.description;
  if (next.security !== undefined) out.security = next.security;
  if (next.tags !== undefined) out.tags = next.tags.slice();
  if (next.parameters !== undefined) {
    out.parameters ??= [];
    for (const parameter of next.parameters) {
      out.parameters = out.parameters.filter((current) => current.in !== parameter.in || current.name !== parameter.name);
      out.parameters.push({
        ...parameter,
        schema: cloneSchema(parameter.schema)
      });
    }
  }
  if (next.requestBody !== undefined) out.requestBody = cloneRequestBody(next.requestBody);
  if (next.responses !== undefined) {
    out.responses ??= {};
    for (const status of Object.keys(next.responses)) out.responses[status] = cloneResponses({ [status]: next.responses[status]! })[status]!;
  }
  return out;
}
function metadataOf(fn: unknown): OperationMeta | undefined {
  return (fn as Record<symbol, OperationMeta | undefined>)[middlewareMeta];
}
function methodName(method: string): HttpMethod {
  return method.toUpperCase() as HttpMethod;
}
type ResolvedChain = {
  owner: RouterBase<unknown>;
  path: string;
  hasPath: boolean;
  method?: HttpMethod;
  stack: StackItem[];
  slots: string[];
  meta: OperationMeta;
};
function resolveChain(node: BuilderNode): ResolvedChain {
  const nodes: Array<Exclude<BuilderNode, {
    kind: 'root';
  }>> = [];
  let current: BuilderNode = node;
  while (current.kind !== 'root') {
    nodes.push(current);
    current = current.parent;
  }
  nodes.reverse();
  let path = '';
  let hasPath = false;
  let method: HttpMethod | undefined;
  const stack: StackItem[] = [];
  const slots: string[] = [];
  let meta: OperationMeta = {};
  for (const item of nodes) {
    if (item.kind === 'middleware') {
      stack.push({
        type: 'middleware',
        fn: item.fn,
        meta: item.meta
      });
    } else if (item.kind === 'layer') {
      stack.push({
        type: 'layer',
        fn: item.fn,
        meta: item.meta
      });
    } else if (item.kind === 'value') {
      stack.push({
        type: 'producer',
        name: item.name,
        fn: item.fn,
        meta: item.meta
      });
      if (!slots.includes(item.name)) slots.push(item.name);
    } else if (item.kind === 'meta') {
      meta = mergeMeta(meta, item.meta);
    } else if (item.kind === 'path') {
      hasPath = true;
      path = appendPath(path === '' ? '/' : path, item.fragment);
    } else {
      method = item.method;
    }
  }
  return {
    owner: current.owner,
    path: path === '' ? '/' : path,
    hasPath,
    method,
    stack,
    slots,
    meta
  };
}
function registerOperation(node: BuilderNode, kind: OperationKind, handler: Handler): void {
  const chain = resolveChain(node);
  chain.owner._register({
    kind,
    method: kind === 'http' ? chain.method : undefined,
    path: chain.path,
    pattern: new URLPattern({ pathname: chain.path }),
    stack: chain.stack,
    slots: chain.slots,
    meta: chain.meta,
    handler
  });
}
/**
* Shared immutable enrichment base for app, router, route, and method builders.
*
* Application code usually works with `App`, `Router`, `RouteBuilder`, or
* `MethodBuilder` directly. This base class is exported so shared builder
* helpers can accept any fluent builder while preserving the return type.
*
* ```ts no_run
* type ValueBuilder<T extends BuilderBranch<T>> =
*   T & { value(name: string, producer: Producer): T };
*
* function withRequestId<T extends BuilderBranch<T>>(builder: ValueBuilder<T>): T {
*   return builder.value('requestId', () => crypto.randomUUID());
* }
* ```
*/
const builderBranchFactories = new WeakMap<object, (node: BuilderNode) => object>();
export abstract class BuilderBranch<TSelf extends BuilderBranch<TSelf>> {
  /** @internal */
  protected readonly _node: BuilderNode;
  /** @internal */
  protected constructor(node: BuilderNode) {
    this._node = node;
  }
  /** Return a new builder with one-way middleware appended to this branch.
  *
  * The middleware runs only when dispatch is flowing toward a candidate
  * terminal below this branch. Returning a response short-circuits; returning
  * nothing continues.
  *
  * ```ts no_run
  * const authed = app.use(requireUser);
  * authed.get('/account').handle(showAccount);
  * ```
  */
  use(...middleware: Middleware[]): TSelf {
    resolveChain(this._node).owner._assertMutable();
    let node = this._node;
    for (const fn of middleware) node = {
      kind: 'middleware',
      fn,
      meta: metadataOf(fn),
      parent: node
    };
    return this.#createBranch(node);
  }
  /** Return a new builder with wrapper layers appended to this branch.
  *
  * Layers receive `(ctx, next)` and may wrap downstream dispatch, including
  * fallback responses when this branch's routing constraints match.
  *
  * ```ts no_run
  * const logged = app.layer(accessLog);
  * ```
  */
  layer(...layers: LayerMiddleware[]): TSelf {
    resolveChain(this._node).owner._assertMutable();
    let node = this._node;
    for (const fn of layers) {
      node = {
        kind: 'layer',
        fn,
        meta: metadataOf(fn),
        parent: node
      };
      resolveChain(node).owner._registerLayer(node);
    }
    return this.#createBranch(node);
  }
  /** Return a new builder with a context value appended to this branch.
  *
  * ```ts no_run
  * const withSession = app.value('session', sessions(sessionOptions));
  * ```
  */
  value(name: string, producer: Producer): TSelf {
    resolveChain(this._node).owner._assertMutable();
    return this.#createBranch({
      kind: 'value',
      name,
      fn: producer,
      meta: metadataOf(producer),
      parent: this._node
    });
  }
  /** Return a new builder with OpenAPI metadata appended to this branch.
  *
  * ```ts no_run
  * const users = app.meta({ tags: ['users'] });
  * ```
  */
  meta(meta: OperationMeta): TSelf {
    resolveChain(this._node).owner._assertMutable();
    return this.#createBranch({
      kind: 'meta',
      meta: cloneMeta(meta),
      parent: this._node
    });
  }
  #createBranch(node: BuilderNode): TSelf {
    const create = builderBranchFactories.get(this);
    if (create === undefined) throw new TypeError('BuilderBranch subclass is not initialized');
    return create(node) as TSelf;
  }
}
function assertPathOnly(verb: string, rest: readonly unknown[]): void {
  if (rest.length > 0) {
    throw new TypeError(`${verb}() takes only a path; register the handler with .handle()`);
  }
}
function assertNoArgs(verb: string, rest: readonly unknown[]): void {
  if (rest.length > 0) {
    throw new TypeError(`${verb}() takes no arguments; register the handler with .handle()`);
  }
}
function duplicateOperationMessage(op: Operation): string {
  if (op.kind === 'websocket') return `Duplicate WebSocket route ${op.path}`;
  if (op.kind === 'webtransport') return `Duplicate WebTransport route ${op.path}`;
  if (op.kind === 'sse') return `Duplicate SSE route ${op.path}`;
  return `Duplicate route ${op.method} ${op.path}`;
}
type NearMisses = {
  allowed: Set<HttpMethod>;
  upgrade?: 'websocket' | 'webtransport';
};
function fallbackResponse(near: NearMisses): Response {
  if (near.allowed.size > 0) {
    return Response.json({ error: 'Method Not Allowed' }, {
      status: 405,
      headers: { allow: [...near.allowed].sort().join(', ') }
    });
  }
  if (near.upgrade !== undefined) {
    return new Response('Upgrade Required', {
      status: 426,
      headers: {
        upgrade: near.upgrade,
        connection: 'Upgrade'
      }
    });
  }
  return defaultNotFound();
}
function chainMatches(chain: ResolvedChain, path: string, method: HttpMethod): boolean {
  if (chain.hasPath && new URLPattern({ pathname: chain.path }).exec({ pathname: path }) === null) return false;
  if (chain.method !== undefined && chain.method !== method) return false;
  return true;
}
function fallbackStack(owner: RouterBase<unknown>, path: string, method: HttpMethod): StackItem[] {
  const stack: StackItem[] = [];
  const seen = new Set<StackItem>();
  for (const node of owner._layers) {
    const chain = resolveChain(node);
    if (!chainMatches(chain, path, method)) continue;
    for (const item of chain.stack) {
      if (seen.has(item)) continue;
      seen.add(item);
      stack.push(item);
    }
  }
  return stack;
}
function wrapWebSocket(handler: WebSocketHandler): Handler {
  return async (ctx) => {
    const incoming = ctx.incoming as IncomingWebSocketRequest;
    const socket = await incoming.accept();
    ctx.__upgraded = socket;
    await handler(socket, ctx as WebSocketContext);
    return socket;
  };
}
function wrapWebTransport(handler: WebTransportHandler): Handler {
  return async (ctx) => {
    const incoming = ctx.incoming as IncomingWebTransportRequest;
    const session = await incoming.accept();
    ctx.__upgraded = session;
    await handler(session, ctx as WebTransportContext);
    return session;
  };
}
function wrapSse(handler: SseHandler): Handler {
  return (ctx) => {
    const channel = new Channel<Uint8Array>();
    const events = new EventSourceWriter(channel.writer);
    void (async () => {
      try {
        await handler(events, ctx as SseContext);
        await events.close();
        await channel.writer.close();
      } catch (err) {
        channel.writer.fail(err);
      }
    })();
    return new Response(channel.reader, { headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store'
    } });
  };
}
function closeUpgraded(upgraded: unknown): void {
  try {
    if (upgraded instanceof WebSocketConnection) {
      void upgraded.close();
    } else if (upgraded instanceof WebTransport) {
      upgraded.close();
    }
  } catch {}
}
function routePathToOpenApi(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}
function generatedOperationId(method: string, path: string): string {
  const parts = path.split('/').filter(Boolean).map((part) => {
    const clean = part.startsWith(':') ? `by-${part.slice(1)}` : part;
    return clean.split(/[^A-Za-z0-9]+/).filter(Boolean).map((segment) => segment[0]!.toUpperCase() + segment.slice(1)).join('');
  });
  return method.toLowerCase() + parts.join('');
}
function defaultNotFound(): Response {
  return Response.json({ error: 'Not Found' }, { status: 404 });
}
function appendPath(prefix: string, path: string): string {
  const left = prefix === '/' ? '' : prefix.replace(/\/$/, '');
  const right = path === '/' ? '' : path.startsWith('/') ? path : `/${path}`;
  return `${left}${right}` || '/';
}
interface HandleInfo {
  protocol?: HttpProtocol;
  session?: HttpSession;
  incoming?: IncomingHttp;
}
function seedSlots(ctx: HttpContext, slots: string[]): void {
  for (const slot of slots) ctx[slot] = undefined;
}
function makeInitialContext(app: App, op: Operation, req: Request, params: Record<string, string>, info: HandleInfo, method: HttpMethod): HttpContext {
  const ctx: HttpContext = {
    request: req,
    app,
    route: op.path,
    method: op.method ?? method,
    protocol: info.protocol ?? 'http/1.1'
  };
  if (info.session !== undefined) ctx.session = info.session;
  if (info.incoming !== undefined) ctx.incoming = info.incoming;
  seedSlots(ctx, op.slots);
  ctx.params = params;
  return ctx;
}
function makeFallbackContext(app: App, req: Request, path: string, method: HttpMethod, slots: string[], info: HandleInfo): HttpContext {
  const ctx: HttpContext = {
    request: req,
    app,
    route: path,
    method,
    protocol: info.protocol ?? 'http/1.1'
  };
  if (info.session !== undefined) ctx.session = info.session;
  if (info.incoming !== undefined) ctx.incoming = info.incoming;
  seedSlots(ctx, slots);
  ctx.params = {};
  return ctx;
}
function makeUpgradeContext(app: App, op: Operation, incoming: IncomingWebSocketRequest | IncomingWebTransportRequest, params: Record<string, string>): HttpContext {
  const ctx = {
    request: incoming.request,
    app,
    route: op.path,
    method: op.kind === 'websocket' ? 'WEBSOCKET' : 'WEBTRANSPORT',
    protocol: incoming.protocol,
    session: incoming.session,
    incoming,
    params
  } as HttpContext;
  seedSlots(ctx, op.slots);
  return ctx;
}
async function runStack(ctx: HttpContext, stack: StackItem[], handler: Handler): Promise<HttpHandlerResult> {
  let index = -1;
  async function dispatch(i: number): Promise<HttpHandlerResult> {
    if (i <= index) throw new Error('next() called multiple times');
    index = i;
    if (i === stack.length) return handler(ctx);
    const item = stack[i]!;
    if (item.type === 'producer') {
      ctx[item.name] = await item.fn(ctx);
      return dispatch(i + 1);
    }
    if (item.type === 'middleware') {
      const result = await item.fn(ctx);
      if (result !== undefined) return result;
      return dispatch(i + 1);
    }
    let downstream: HttpHandlerResult | undefined;
    const result = await item.fn(ctx, async () => {
      downstream = await dispatch(i + 1);
      return downstream;
    });
    if (result === undefined) return downstream ?? defaultNotFound();
    return result;
  }
  return dispatch(0);
}
async function finalize(ctx: HttpContext, res: HttpHandlerResult): Promise<void> {
  if (res instanceof Response) {
    const applySession = ctx.__sessionApply as undefined | ((res: Response) => Promise<void>);
    await applySession?.(res);
    if (ctx.cookies instanceof CookieJar) ctx.cookies._apply(res);
  }
}
async function compose(ctx: HttpContext, stack: StackItem[], handler: Handler): Promise<HttpHandlerResult> {
  const res = await runStack(ctx, stack, handler);
  await finalize(ctx, res);
  return res;
}
function pathFromRequest(req: Request): string {
  const trusted = (req as {
    _trustedPath?: () => string | null;
  })._trustedPath?.();
  if (trusted !== undefined && trusted !== null) {
    const query = trusted.indexOf('?');
    return query < 0 ? trusted : trusted.slice(0, query);
  }
  try {
    return new URL(req.url).pathname;
  } catch {
    return req.url.startsWith('/') ? req.url.split('?')[0]! : '/';
  }
}
function queryFromRequest(req: Request): URLSearchParams {
  try {
    return new URL(req.url).searchParams;
  } catch {
    return new URLSearchParams('');
  }
}
function objectSchemaProperties(schema: unknown): Record<string, unknown> {
  const actual = cloneSchema(schema);
  return isRecord(actual) && isRecord(actual.properties) ? actual.properties : {};
}
function objectSchemaRequired(schema: unknown): Set<string> {
  const actual = cloneSchema(schema);
  return new Set(isRecord(actual) && Array.isArray(actual.required) ? actual.required.map(String) : []);
}
function parametersFromObject(schemaValue: unknown, location: 'path' | 'query' | 'header'): OpenApiParameter[] {
  const properties = objectSchemaProperties(schemaValue);
  const required = objectSchemaRequired(schemaValue);
  return Object.keys(properties).map((name) => ({
    name: location === 'header' ? name.toLowerCase() : name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: cloneSchema(properties[name])
  }));
}
function parseQueryObject(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const current = out[key];
      out[key] = Array.isArray(current) ? current.concat(value) : [current, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}
function parseHeaderObject(headers: Headers): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of headers) out[name] = value;
  return out;
}
function contentType(req: Request): string {
  return (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
}
function responseWithBody(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
/**
* Attach static OpenAPI metadata to a middleware or layer function.
*
* The returned function is the original function with non-enumerable metadata
* attached. Metadata is read when the middleware is installed in a route stack.
*
* ```ts no_run
* const auth = defineMiddleware((ctx) => {
*   if (ctx.user === undefined) return Response.json({ error: 'Unauthorized' }, { status: 401 });
* }, {
*   security: [{ bearerAuth: [] }],
* });
* ```
*/
export function defineMiddleware<T extends Middleware | LayerMiddleware>(fn: T, meta: OperationMeta = {}): T {
  Object.defineProperty(fn, middlewareMeta, {
    value: cloneMeta(meta),
    configurable: true
  });
  return fn;
}
/**
* Attach static OpenAPI metadata to a context value producer.
*
* The returned producer is the original function with metadata attached. Use
* this for reusable body, params, query, or session producers.
*
* ```ts no_run
* const user = defineProducer(async (ctx) => loadUser(ctx), {
*   parameters: [{ name: 'user-id', in: 'header' }],
* });
* ```
*/
export function defineProducer<T extends Producer>(fn: T, meta: OperationMeta = {}): T {
  Object.defineProperty(fn, middlewareMeta, {
    value: cloneMeta(meta),
    configurable: true
  });
  return fn;
}
/**
* Shared route-container surface for `App`, `Router`, and immutable root
* branches.
*
* Container builders can start path branches with `route()` or path-taking verb
* shortcuts. Enrichments such as `use()`, `layer()`, `value()`, and `meta()` are
* inherited from `BuilderBranch` and return immutable branch builders; they do
* not mutate the original container.
*/
export abstract class RouterBase<TSelf> extends BuilderBranch<RouterBranch> {
  /**
  * Resolved operations registered on this container.
  *
  * @internal
  */
  _operations: Operation[] = [];
  /**
  * Layer branch nodes that can wrap fallback dispatch.
  *
  * @internal
  */
  _layers: BuilderNode[] = [];
  constructor() {
    const root = {
      kind: 'root',
      owner: (undefined as unknown) as RouterBase<unknown>
    };
    super(root);
    root.owner = this as RouterBase<unknown>;
    builderBranchFactories.set(this, (next) => new RouterBranch(next));
  }
  /** Start a route branch for one URLPattern pathname.
  *
  * ```ts no_run
  * app.route('/users/:id').get().handle((ctx) => Response.json(ctx.params));
  * ```
  */
  route(path: string): RouteBuilder {
    this._assertMutable();
    return new RouteBuilder({
      kind: 'path',
      fragment: path,
      parent: this._node
    });
  }
  /** Start a GET method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.get('/health').handle(() => Response.json({ ok: true }));
  * ```
  */
  get(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('get', rest);
    return this.route(path).get();
  }
  /** Start a POST method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.post('/users').handle((ctx) => Response.json({}, { status: 201 }));
  * ```
  */
  post(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('post', rest);
    return this.route(path).post();
  }
  /** Start a PUT method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.put('/users/:id').handle((ctx) => Response.json(ctx.params));
  * ```
  */
  put(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('put', rest);
    return this.route(path).put();
  }
  /** Start a PATCH method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.patch('/users/:id').handle((ctx) => Response.json(ctx.params));
  * ```
  */
  patch(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('patch', rest);
    return this.route(path).patch();
  }
  /** Start a DELETE method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.delete('/users/:id').handle(() => new Response(null, { status: 204 }));
  * ```
  */
  delete(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('delete', rest);
    return this.route(path).delete();
  }
  /** Start a HEAD method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.head('/health').handle(() => new Response(null, { status: 204 }));
  * ```
  */
  head(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('head', rest);
    return this.route(path).head();
  }
  /** Start an OPTIONS method branch; register the handler with `.handle()`.
  *
  * ```ts no_run
  * app.options('/users').handle(() => new Response(null, { status: 204 }));
  * ```
  */
  options(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('options', rest);
    return this.route(path).options();
  }
  /**
  * Register a resolved operation, rejecting duplicates.
  *
  * @internal
  */
  _register(op: Operation): void {
    this._assertMutable();
    const exists = this._operations.some((current) => current.kind === op.kind && current.method === op.method && current.path === op.path);
    if (exists) throw new Error(duplicateOperationMessage(op));
    this._operations.push(op);
  }
  /**
  * Register a layer branch so fallback dispatch can wrap through it.
  *
  * @internal
  */
  _registerLayer(node: BuilderNode): void {
    this._assertMutable();
    this._layers.push(node);
  }
  /**
  * Guard invoked before any mutation; mounted routers throw.
  *
  * @internal
  */
  _assertMutable(): void {}
}
/**
* Immutable app/router branch with path-taking route helpers.
*
* Instances are returned by root-level enrichments such as `app.use(auth)` or
* `router.layer(log)`. Hold the returned branch to register multiple routes
* under the same inherited chain.
*
* ```ts no_run
* const authed = app.use(requireUser);
* authed.get('/account').handle(showAccount);
* authed.post('/logout').handle(logout);
* ```
*/
export class RouterBranch extends BuilderBranch<RouterBranch> {
  /**
  * Create a branch around a routing-tree node.
  *
  * @internal
  */
  constructor(node: BuilderNode) {
    super(node);
    builderBranchFactories.set(this, (next) => new RouterBranch(next));
  }
  /** Start a route branch for one URLPattern pathname.
  *
  * ```ts no_run
  * branch.route('/users/:id').get().handle((ctx) => Response.json(ctx.params));
  * ```
  */
  route(path: string): RouteBuilder {
    return new RouteBuilder({
      kind: 'path',
      fragment: path,
      parent: this._node
    });
  }
  /** Start a GET method branch; register the handler with `.handle()`. */
  get(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('get', rest);
    return this.route(path).get();
  }
  /** Start a POST method branch; register the handler with `.handle()`. */
  post(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('post', rest);
    return this.route(path).post();
  }
  /** Start a PUT method branch; register the handler with `.handle()`. */
  put(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('put', rest);
    return this.route(path).put();
  }
  /** Start a PATCH method branch; register the handler with `.handle()`. */
  patch(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('patch', rest);
    return this.route(path).patch();
  }
  /** Start a DELETE method branch; register the handler with `.handle()`. */
  delete(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('delete', rest);
    return this.route(path).delete();
  }
  /** Start a HEAD method branch; register the handler with `.handle()`. */
  head(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('head', rest);
    return this.route(path).head();
  }
  /** Start an OPTIONS method branch; register the handler with `.handle()`. */
  options(path: string, ...rest: never[]): MethodBuilder {
    assertPathOnly('options', rest);
    return this.route(path).options();
  }
}
/**
* HTTP application with middleware, routes, async context, serving, and docs.
*
* ```ts no_run
* const app = new App({ name: 'Example API' });
* app.get('/').handle(() => new Response('ok'));
* ```
*/
export class App extends RouterBase<App> {
  #name: string;
  #requestContext = new Context<HttpContext>('fino:http:app');
  constructor(options: {
    name?: string;
  } = {}) {
    super();
    this.#name = options.name ?? 'Fino API';
  }
  /** Return the active request context from anywhere in the async call chain.
  *
  * ```ts no_run
  * const ctx = app.context();
  * ```
  */
  context(): HttpContext | undefined {
    return this.#requestContext.get();
  }
  /** Dispatch one request through the matching operation chain.
  *
  * A path that matches with no matching method returns 405 with an `Allow`
  * header. A path served only by WebSocket or WebTransport operations returns
  * 426 Upgrade Required. Otherwise unmatched requests return a JSON 404 after
  * running the app-level middleware chain.
  *
  * ```ts no_run
  * const response = await app.handle(new Request('http://local/health'));
  * ```
  */
  async handle(req: Request, info: HandleInfo = {}): Promise<HttpHandlerResult> {
    const path = pathFromRequest(req);
    const method = methodName(req.method);
    const near: NearMisses = { allowed: new Set() };
    for (const op of this._operations) {
      const match = op.pattern.exec({ pathname: path });
      if (match === null) continue;
      if (op.kind === 'websocket' || op.kind === 'webtransport') {
        near.upgrade ??= op.kind;
        continue;
      }
      if (op.kind === 'http' && op.method !== method) {
        near.allowed.add(op.method!);
        continue;
      }
      if (op.kind === 'sse' && method !== 'GET' && method !== 'POST') {
        near.allowed.add('GET');
        near.allowed.add('POST');
        continue;
      }
      const ctx = makeInitialContext(this, op, req, { ...match.pathname.groups }, info, method);
      return this.#requestContext.runWithValue(ctx, () => compose(ctx, op.stack, op.handler));
    }
    const stack = fallbackStack(this, path, method);
    if (stack.length === 0) return fallbackResponse(near);
    const slots = stack.flatMap((item) => item.type === 'producer' ? [item.name] : []);
    const ctx = makeFallbackContext(this, req, path, method, [...new Set(slots)], info);
    return this.#requestContext.runWithValue(ctx, () => compose(ctx, stack, () => fallbackResponse(near)));
  }
  async #handleUpgrade(incoming: IncomingWebSocketRequest | IncomingWebTransportRequest): Promise<void> {
    const path = pathFromRequest(incoming.request);
    for (const op of this._operations) {
      if (op.kind !== incoming.kind) continue;
      const match = op.pattern.exec({ pathname: path });
      if (match === null) continue;
      const ctx = makeUpgradeContext(this, op, incoming, { ...match.pathname.groups });
      await this.#requestContext.runWithValue(ctx, async () => {
        let res: HttpHandlerResult;
        try {
          res = await runStack(ctx, op.stack, op.handler);
        } catch {
          if (ctx.__upgraded === undefined) {
            await incoming.reject(new Response('Bad Request', { status: 400 }));
          } else {
            closeUpgraded(ctx.__upgraded);
          }
          return;
        }
        if (res instanceof Response) {
          if (ctx.__upgraded === undefined) {
            await finalize(ctx, res);
            await incoming.reject(res);
          } else {
            closeUpgraded(ctx.__upgraded);
          }
        }
      });
      return;
    }
    await incoming.reject();
  }
  /**
  * Dispatch a synthetic upgrade request for focused app tests.
  *
  * @internal
  */
  _handleWebTransportForTest(incoming: IncomingWebTransportRequest): Promise<void> {
    return this.#handleUpgrade(incoming);
  }
  /** Start an HTTP server that dispatches requests to this app.
  *
  * The returned server is the same object returned by `serve()`.
  *
  * ```ts no_run
  * const server = app.listen({ port: 3000 });
  * ```
  */
  listen(options: Parameters<typeof serve>[0]): ReturnType<typeof serve> {
    return serve(options, async (incoming, session) => {
      if (incoming.kind === 'websocket' || incoming.kind === 'webtransport') {
        await this.#handleUpgrade(incoming);
        return;
      }
      const accepted: AcceptedHttpRequest = await incoming.accept();
      const result = await this.handle(accepted.request, {
        protocol: accepted.protocol,
        session,
        incoming
      });
      await accepted.respond(result);
    });
  }
  /** Generate an OpenAPI 3.1 document from registered operations and metadata.
  *
  * HTTP and SSE operations are documented; SSE paths emit GET and POST
  * operations with a `text/event-stream` response. WebSocket and WebTransport
  * operations are not part of the OpenAPI surface. Throws when generated or
  * explicit operation IDs collide.
  *
  * ```ts no_run
  * const doc = app.openapi({ version: '1.0.0' });
  * ```
  */
  openapi(options: OpenApiOptions): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    const operationIds = new Set<string>();
    const emit = (op: Operation, method: string, baseline?: OperationMeta): void => {
      let meta = baseline === undefined ? {} : cloneMeta(baseline);
      meta = mergeMeta(meta, op.meta);
      for (const item of op.stack) {
        if (item.meta !== undefined) meta = mergeMeta(meta, item.meta);
      }
      if (op.kind === 'sse') meta.operationId = generatedOperationId(method, op.path);
      meta.operationId ??= generatedOperationId(method, op.path);
      if (operationIds.has(meta.operationId)) throw new Error(`Duplicate OpenAPI operationId "${meta.operationId}"`);
      operationIds.add(meta.operationId);
      const openPath = routePathToOpenApi(op.path);
      paths[openPath] ??= {};
      const operation: Record<string, unknown> = { operationId: meta.operationId };
      if (meta.summary !== undefined) operation.summary = meta.summary;
      if (meta.description !== undefined) operation.description = meta.description;
      if (meta.tags !== undefined) operation.tags = meta.tags;
      if (meta.security !== undefined) operation.security = meta.security;
      if (meta.parameters !== undefined && meta.parameters.length > 0) operation.parameters = meta.parameters;
      if (meta.requestBody !== undefined) operation.requestBody = meta.requestBody;
      operation.responses = meta.responses ?? { '200': { description: 'OK' } };
      paths[openPath]![method.toLowerCase()] = operation;
    };
    const sseBaseline: OperationMeta = { responses: { '200': {
      description: 'Server-sent event stream',
      content: { 'text/event-stream': { schema: { type: 'string' } } }
    } } };
    for (const op of this._operations) {
      if (op.kind === 'http') {
        emit(op, op.method!);
      } else if (op.kind === 'sse') {
        emit(op, 'GET', sseBaseline);
        emit(op, 'POST', sseBaseline);
      }
    }
    const doc: Record<string, unknown> = {
      openapi: '3.1.0',
      info: {
        title: options.title ?? this.#name,
        version: options.version
      },
      paths
    };
    if (options.servers !== undefined) doc.servers = options.servers;
    return doc;
  }
  /** Return a handler that serves this app's OpenAPI document as JSON.
  *
  * ```ts no_run
  * app.get('/openapi.json').handle(app.openapiHandler({ version: '1.0.0' }));
  * ```
  */
  openapiHandler(options: OpenApiOptions): Handler {
    return () => Response.json(this.openapi(options));
  }
}
/**
* Reusable route collection mountable under a route prefix.
*
* Mounting resolves the router's operations into the target; a router cannot
* be changed after it has been mounted.
*
* ```ts no_run
* const router = new Router();
* router.get('/users').handle(() => Response.json([]));
* app.route('/api').mount(router);
* ```
*/
export class Router extends RouterBase<Router> {
  /**
  * Route prefix this router was mounted under, once mounted.
  *
  * @internal
  */
  _mountedAt: string | undefined;
  override _assertMutable(): void {
    if (this._mountedAt !== undefined) {
      throw new Error(`Router already mounted under "${this._mountedAt}"; register routes before mounting`);
    }
  }
}
/**
* Builder for one URLPattern pathname and its enrichment branch.
*
* Enrichment methods return a new builder; a held reference is a fixed point
* in the routing tree, so chain or reassign to accumulate. Verb methods start
* HTTP method branches finished by `.handle()`; `websocket()`, `sse()`,
* `webtransport()`, `rpc()`, and `mount()` are terminals that register
* directly.
*
* ```ts no_run
* app.route('/users/:id').meta({ tags: ['users'] }).get().handle((ctx) => Response.json(ctx.params));
* ```
*/
export class RouteBuilder extends BuilderBranch<RouteBuilder> {
  /**
  * Create a route builder around a routing-tree node.
  *
  * This is normally created through `app.route()` or `router.route()`.
  *
  * @internal
  */
  constructor(node: BuilderNode) {
    super(node);
    builderBranchFactories.set(this, (next) => new RouteBuilder(next));
  }
  /** Return a new builder with middleware appended to this branch.
  *
  * ```ts no_run
  * app.route('/admin').use(requireAdmin).get().handle(showAdmin);
  * ```
  */
  use(...middleware: Middleware[]): RouteBuilder {
    return super.use(...middleware);
  }
  /** Return a new builder with wrapper layers appended to this branch.
  *
  * ```ts no_run
  * app.route('/admin').layer(auditLog).get().handle(showAdmin);
  * ```
  */
  layer(...layers: LayerMiddleware[]): RouteBuilder {
    return super.layer(...layers);
  }
  /** Return a new builder with a context value appended to this branch.
  *
  * ```ts no_run
  * app.route('/users/:id').value('params', schema.params(idSchema));
  * ```
  */
  value(name: string, producer: Producer): RouteBuilder {
    return super.value(name, producer);
  }
  /** Return a new builder with OpenAPI metadata appended to this branch.
  *
  * ```ts no_run
  * app.route('/users').meta({ tags: ['users'] });
  * ```
  */
  meta(meta: OperationMeta): RouteBuilder {
    return super.meta(meta);
  }
  /** Start a nested route branch under this one.
  *
  * The nested path appends to this route's path and the nested branch
  * inherits everything accumulated above it.
  *
  * ```ts no_run
  * const users = app.route('/users');
  * users.get().handle(listUsers);
  * users.route('/:id').get().handle(showUser);
  * ```
  */
  route(path: string): RouteBuilder {
    return new RouteBuilder({
      kind: 'path',
      fragment: path,
      parent: this._node
    });
  }
  /** Start a GET method branch on this route.
  *
  * ```ts no_run
  * app.route('/items').get().handle(() => Response.json([]));
  * ```
  */
  get(...rest: never[]): MethodBuilder {
    assertNoArgs('get', rest);
    return this.#method('GET');
  }
  /** Start a POST method branch on this route.
  *
  * ```ts no_run
  * app.route('/items').post().value('body', body.json()).handle((ctx) => Response.json(ctx.body));
  * ```
  */
  post(...rest: never[]): MethodBuilder {
    assertNoArgs('post', rest);
    return this.#method('POST');
  }
  /** Start a PUT method branch on this route.
  *
  * ```ts no_run
  * app.route('/items/:id').put().handle((ctx) => Response.json(ctx.params));
  * ```
  */
  put(...rest: never[]): MethodBuilder {
    assertNoArgs('put', rest);
    return this.#method('PUT');
  }
  /** Start a PATCH method branch on this route.
  *
  * ```ts no_run
  * app.route('/items/:id').patch().handle((ctx) => Response.json(ctx.params));
  * ```
  */
  patch(...rest: never[]): MethodBuilder {
    assertNoArgs('patch', rest);
    return this.#method('PATCH');
  }
  /** Start a DELETE method branch on this route.
  *
  * ```ts no_run
  * app.route('/items/:id').delete().handle(() => new Response(null, { status: 204 }));
  * ```
  */
  delete(...rest: never[]): MethodBuilder {
    assertNoArgs('delete', rest);
    return this.#method('DELETE');
  }
  /** Start a HEAD method branch on this route.
  *
  * ```ts no_run
  * app.route('/items').head().handle(() => new Response(null, { status: 204 }));
  * ```
  */
  head(...rest: never[]): MethodBuilder {
    assertNoArgs('head', rest);
    return this.#method('HEAD');
  }
  /** Start an OPTIONS method branch on this route.
  *
  * ```ts no_run
  * app.route('/items').options().handle(() => new Response(null, { status: 204 }));
  * ```
  */
  options(...rest: never[]): MethodBuilder {
    assertNoArgs('options', rest);
    return this.#method('OPTIONS');
  }
  #method(method: HttpMethod): MethodBuilder {
    return new MethodBuilder({
      kind: 'op',
      method,
      parent: this._node
    }, this);
  }
  /** Register a WebSocket operation at this route. Terminal.
  *
  * Middleware on the branch runs before the upgrade is accepted and can
  * reject it by returning a `Response`.
  *
  * ```ts no_run
  * app.route('/chat').websocket(async (socket, ctx) => {
  *   socket.addEventListener('message', (event) => socket.send(event.data));
  * });
  * ```
  */
  websocket(handler: WebSocketHandler): RouteBuilder {
    registerOperation(this._node, 'websocket', wrapWebSocket(handler));
    return this;
  }
  /** Register a WebTransport operation at this route. Terminal.
  *
  * ```ts no_run
  * app.route('/wt').webtransport(async (session, ctx) => {
  *   await session.ready;
  * });
  * ```
  */
  webtransport(handler: WebTransportHandler): RouteBuilder {
    registerOperation(this._node, 'webtransport', wrapWebTransport(handler));
    return this;
  }
  /** Register a server-sent events operation at this route. Terminal.
  *
  * The handler receives an `EventSourceWriter` wired to the response body.
  * The route responds with `text/event-stream` immediately, streams every
  * event the handler writes, and ends the stream when the handler returns.
  * This uses the ordinary HTTP request path rather than the WebSocket or
  * WebTransport upgrade path.
  * The operation matches GET (for `EventSource` clients) and POST (for
  * fetch-based clients that send a request body).
  *
  * ```ts no_run
  * app.route('/events').sse(async (events, ctx) => {
  *   await events.write({ data: 'connected' });
  * });
  * ```
  */
  sse(handler: SseHandler): RouteBuilder {
    registerOperation(this._node, 'sse', wrapSse(handler));
    return this;
  }
  /** Mount a JSON-RPC service at this route. Terminal.
  *
  * POST requests dispatch as JSON-RPC 2.0 messages; other methods return 405
  * with an `Allow` header.
  *
  * ```ts no_run
  * import { JsonRpcService } from 'fino:jsonrpc';
  * const svc = new JsonRpcService();
  * svc.method('add').handle((p) => (p as { a: number; b: number }).a + (p as { a: number; b: number }).b);
  * app.route('/rpc').rpc(svc);
  * ```
  */
  rpc(service: {
    httpHandler(): (req: Request) => Promise<Response>;
  }): RouteBuilder {
    const handler = service.httpHandler();
    registerOperation({
      kind: 'op',
      method: 'POST',
      parent: this._node
    }, 'http', (ctx) => handler(ctx.request));
    return this;
  }
  /** Mount a router's operations under this route. Terminal.
  *
  * The router's operations are resolved into the owning container with this
  * route's path prefixed and this branch's chain prepended. The router cannot
  * be changed afterwards.
  *
  * ```ts no_run
  * const api = new Router();
  * api.get('/users').handle(() => Response.json([]));
  * app.route('/v1').mount(api);
  * ```
  */
  mount(router: Router): RouteBuilder {
    router._assertMutable();
    const chain = resolveChain(this._node);
    router._mountedAt = chain.path;
    for (const op of router._operations) {
      const path = appendPath(chain.path, op.path);
      chain.owner._register({
        kind: op.kind,
        method: op.method,
        path,
        pattern: new URLPattern({ pathname: path }),
        stack: [...chain.stack, ...op.stack],
        slots: [...new Set([...chain.slots, ...op.slots])],
        meta: mergeMeta(chain.meta, op.meta),
        handler: op.handler
      });
    }
    return this;
  }
}
/**
* Builder for one HTTP method branch. Call `.handle()` to register.
*
* ```ts no_run
* app.route('/items').post().value('body', body.json()).handle((ctx) => Response.json(ctx.body));
* ```
*/
export class MethodBuilder extends BuilderBranch<MethodBuilder> {
  #route: RouteBuilder;
  /**
  * Create a method builder around a routing-tree node.
  *
  * This is normally created by a `RouteBuilder` verb such as `.get()`.
  *
  * @internal
  */
  constructor(node: BuilderNode, route: RouteBuilder) {
    super(node);
    builderBranchFactories.set(this, (next) => new MethodBuilder(next, route));
    this.#route = route;
  }
  /** Return a new builder with middleware appended to this method branch.
  *
  * ```ts no_run
  * app.route('/items').post().use(rateLimit).handle(createItem);
  * ```
  */
  use(...middleware: Middleware[]): MethodBuilder {
    return super.use(...middleware);
  }
  /** Return a new builder with wrapper layers appended to this method branch.
  *
  * ```ts no_run
  * app.route('/items').get().layer(cacheHeaders).handle(listItems);
  * ```
  */
  layer(...layers: LayerMiddleware[]): MethodBuilder {
    return super.layer(...layers);
  }
  /** Return a new builder with a context value appended to this method branch.
  *
  * ```ts no_run
  * app.route('/items').post().value('body', body.json());
  * ```
  */
  value(name: string, producer: Producer): MethodBuilder {
    return super.value(name, producer);
  }
  /** Return a new builder with OpenAPI metadata appended to this method branch.
  *
  * ```ts no_run
  * app.route('/items').get().meta({ summary: 'List items' });
  * ```
  */
  meta(meta: OperationMeta): MethodBuilder {
    return super.meta(meta);
  }
  /** Register the handler for this method branch. Terminal.
  *
  * Resolves the branch into a frozen operation and returns the parent route
  * builder for further registrations on the same route.
  *
  * ```ts no_run
  * app.route('/items').get().handle(() => Response.json([]));
  * ```
  */
  handle(handler: Handler): RouteBuilder {
    registerOperation(this._node, 'http', handler);
    return this.#route;
  }
}
/**
* Validation and OpenAPI helpers for parameters and responses.
*
* These helpers wrap `fino:validate` schemas and attach matching OpenAPI
* metadata. Runtime validation failures throw from middleware or producer
* execution.
*
* ```ts no_run
* app.get('/users').use(schema.query(v.object({ q: v.string() }))).handle((ctx) => Response.json(ctx.query));
* ```
*/
export const schema = {
  params(schemaValue: unknown): Producer {
    const validator = compile<Record<string, string>>(schemaValue);
    return defineProducer((ctx) => validator.parse(ctx.params ?? {}), { parameters: parametersFromObject(schemaValue, 'path') });
  },
  query(schemaValue: unknown): Middleware {
    const validator = compile<Record<string, unknown>>(schemaValue);
    return defineMiddleware((ctx) => {
      ctx.query = validator.parse(parseQueryObject(queryFromRequest(ctx.request)));
    }, { parameters: parametersFromObject(schemaValue, 'query') });
  },
  headers(schemaValue: unknown): Middleware {
    const validator = compile<Record<string, unknown>>(schemaValue);
    return defineMiddleware((ctx) => {
      ctx.headers = validator.parse(parseHeaderObject(ctx.request.headers));
    }, { parameters: parametersFromObject(schemaValue, 'header') });
  },
  response(schemaValue: unknown, opts: {
    status?: number;
    description?: string;
    contentType?: string;
  } = {}): LayerMiddleware {
    const status = String(opts.status ?? 200);
    const content = opts.contentType ?? 'application/json';
    const validator = compile(schemaValue);
    return defineMiddleware(async (_ctx, next) => {
      const res = await next();
      if (res instanceof Response && res.status === Number(status) && contentTypeFromResponse(res) === content) {
        const clone = res.clone();
        validator.parse(await clone.json());
      }
      return res;
    }, { responses: { [status]: {
      description: opts.description ?? 'OK',
      content: { [content]: { schema: cloneSchema(schemaValue) } }
    } } });
  }
};
function contentTypeFromResponse(res: Response): string {
  return (res.headers.get('content-type') ?? 'application/json').split(';')[0]!.trim().toLowerCase();
}
/**
* Request body producers for `.value('body', body.json(...))` and friends.
*
* Body producers consume the request body exactly once. Install them at the
* point in the stack where the parsed body should become available.
*
* ```ts no_run
* app.post('/items').value('body', body.json()).handle((ctx) => Response.json(ctx.body));
* ```
*/
export const body = {
  json(schemaValue?: unknown): Producer {
    const validator = schemaValue === undefined ? null : compile(schemaValue);
    return defineProducer(async (ctx) => {
      if (contentType(ctx.request) !== '' && contentType(ctx.request) !== 'application/json') {
        throw new Error(`Expected application/json body, got ${contentType(ctx.request)}`);
      }
      const parsed = await ctx.request.json();
      return validator === null ? parsed : validator.parse(parsed);
    }, { requestBody: {
      required: true,
      content: { 'application/json': { schema: schemaValue === undefined ? {} : cloneSchema(schemaValue) } }
    } });
  },
  text(): Producer {
    return defineProducer((ctx) => ctx.request.text(), { requestBody: {
      required: true,
      content: { 'text/plain': { schema: { type: 'string' } } }
    } });
  },
  bytes(): Producer {
    return defineProducer((ctx) => ctx.request.bytes(), { requestBody: {
      required: true,
      content: { 'application/octet-stream': { schema: {
        type: 'string',
        format: 'binary'
      } } }
    } });
  },
  form(): Producer {
    return defineProducer(async (ctx) => {
      const req = ctx.request as Request & {
        formData?: () => Promise<unknown>;
      };
      if (typeof req.formData !== 'function') throw new Error('Request.formData() is not available');
      return req.formData();
    }, { requestBody: {
      required: true,
      content: {
        'application/x-www-form-urlencoded': { schema: { type: 'object' } },
        'multipart/form-data': { schema: { type: 'object' } }
      }
    } });
  }
};
/** Producer that creates a `CookieJar` and appends queued cookies downstream.
*
* Use with `.value('cookies', cookies())` so handlers can read and mutate
* cookies through `ctx.cookies`.
*
* ```ts no_run
* app.value('cookies', cookies());
* ```
*/
export function cookies(): Producer {
  return defineProducer((ctx) => {
    const unsafeCookie = (ctx.request as Request & {
      _getUnsafeHeader?: (name: string) => string | null;
    })._getUnsafeHeader?.('cookie') ?? null;
    return new CookieJar(ctx.request.headers.get('cookie') ?? unsafeCookie);
  });
}
/** Middleware that converts uncaught errors to a JSON error response.
*
* By default, error messages are hidden. Pass `{ expose: true }` for development
* or trusted internal APIs.
*
* ```ts no_run
* app.layer(errorHandler({ expose: false }));
* ```
*/
export function errorHandler(opts: {
  expose?: boolean;
} = {}): LayerMiddleware {
  return defineMiddleware(async (_ctx, next) => {
    try {
      return await next();
    } catch (err) {
      const message = opts.expose && err instanceof Error ? err.message : 'Internal Server Error';
      return Response.json({ error: message }, { status: 500 });
    }
  });
}
/** Serve files from a local root directory, short-circuiting matched requests.
*
* The request path must start with `opts.prefix` (default `/`). Paths are
* normalized and `..` traversal is rejected with 403. Missing files fall
* through to downstream middleware.
*
* ```ts no_run
* app.layer(staticFiles('/var/www', { index: 'index.html', prefix: '/' }));
* ```
*/
export function staticFiles(root: string, opts: {
  index?: string;
  prefix?: string;
} = {}): LayerMiddleware {
  const index = opts.index ?? 'index.html';
  const prefix = opts.prefix ?? '/';
  const fs = new DiskFileSystem();
  return defineMiddleware(async (ctx, next) => {
    const pathname = pathFromRequest(ctx.request);
    if (!pathname.startsWith(prefix)) return next();
    const relative = pathname.slice(prefix.length).replace(/^\/+/, '') || index;
    const normalized = normalize(relative).toString();
    if (normalized.startsWith('..')) return responseWithBody(403, 'Forbidden');
    const file = join(root, normalized);
    try {
      const info = await fs.stat(file);
      if (!info.isFile()) return next();
      const handle = await fs.open(file);
      try {
        return new Response(await handle.bytes());
      } finally {
        handle.close();
      }
    } catch {
      return next();
    }
  });
}
