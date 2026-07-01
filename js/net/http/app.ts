/**
* fino:net/http/app — middleware, routing, and OpenAPI for HTTP services.
*
* This module builds a small application framework on top of Fino's existing
* `Request`, `Response`, and `serve()` APIs. It is intended for APIs that need
* composable middleware, URLPattern routing, request-scoped values, and a
* machine-readable OpenAPI document without giving up direct access to the
* underlying Fetch-compatible HTTP primitives.
*
* The middleware model is Koa-style: each middleware receives `(ctx, next)` and
* may short-circuit by returning a `Response`, or may `await next()` and mutate
* the downstream response. Builders (`App`, `Router`, `RouteBuilder`, and
* `MethodBuilder`) share `.use()`, `.value()`, and `.meta()`. A value producer
* declares a context slot and populates it only when that point in the
* middleware stack is reached; duplicate slot declarations throw while the app
* is being built.
*
* Routing uses the platform `URLPattern` implementation with pathname patterns
* such as `/users/:id`. Path parameters are available through the built-in
* `schema.params()` producer, which reserves the usual `params` slot and
* validates the matched parameter object. `app.context()` returns the active
* request context from anywhere in the async call chain by using
* `fino:context`.
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
* app.route('/users/:id')
*   .meta({ tags: ['users'] })
*   .value('params', schema.params(v.object({ id: v.string() })))
*   .post()
*   .value('body', body.json(v.object({ name: v.string() })))
*   .handle((ctx) => Response.json({ id: ctx.params.id, name: ctx.body.name }));
*
* app.get('/openapi.json', app.openapiHandler({ version: '1.0.0' }));
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
import { v4 as uuidv4 } from '../../uuid.ts';
import { parseCookieHeader, serializeCookie, type CookieOptions } from '../../security/cookie.ts';
import { compile } from '../../validate.ts';
import { Headers, Request, Response } from './index.ts';
import { serve } from './server.ts';
import type { AcceptedHttpRequest, HttpSession, HttpProtocol, IncomingHttp, IncomingWebSocketRequest, IncomingWebTransportRequest } from './server.ts';
import { WebSocketConnection } from '../../globals/websocket.ts';
import { WebTransport } from './webtransport.ts';
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
export interface WebSocketContext extends HttpContext {
  incoming: IncomingWebSocketRequest;
}
/**
* Request context passed to WebTransport route handlers.
*/
export interface WebTransportContext extends HttpContext {
  /** Incoming WebTransport request accepted by the route. */
  incoming: IncomingWebTransportRequest;
}
/**
* Koa-style middleware. Return a response to short-circuit or call `next()`.
*
* Returning `undefined` after calling `next()` uses the downstream response.
* Calling `next()` more than once throws at runtime.
*
* ```ts no_run
* const timing: Middleware = async (ctx, next) => {
*   const res = await next();
*   res.headers.set('x-route', ctx.route);
*   return res;
* };
* ```
*/
export type HttpHandlerResult = Response | WebSocketConnection | WebTransport;
export type Middleware = (ctx: HttpContext, next: () => Promise<HttpHandlerResult>) => HttpHandlerResult | void | Promise<HttpHandlerResult | void>;
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
export type WebSocketHandler = (socket: WebSocketConnection, ctx: WebSocketContext) => void | Promise<void>;
/**
* Terminal handler for a WebTransport route.
*/
export type WebTransportHandler = (session: WebTransport, ctx: WebTransportContext) => void | Promise<void>;
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
* Metadata is merged as routes are built. Duplicate parameters or request
* bodies throw unless `replaceRequestBody` is set.
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
  /** Replace an inherited requestBody instead of throwing on duplication.
  *
  * ```ts no_run
  * route.meta({ replaceRequestBody: true, requestBody });
  * ```
  */
  replaceRequestBody?: boolean;
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
type OpenApiParameter = {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: unknown;
  description?: string;
};
type OpenApiRequestBody = {
  required?: boolean;
  description?: string;
  content: Record<string, {
    schema: unknown;
  }>;
};
type OpenApiResponse = {
  description: string;
  content?: Record<string, {
    schema: unknown;
  }>;
};
type StackItem = {
  type: 'middleware';
  fn: Middleware;
  meta?: OperationMeta;
} | {
  type: 'producer';
  name: string;
  fn: Producer;
  meta?: OperationMeta;
};
type Endpoint = {
  method: HttpMethod;
  path: string;
  pattern: URLPattern;
  stack: StackItem[];
  slots: string[];
  handler: Handler;
  meta: OperationMeta;
};
type WebSocketEndpoint = {
  path: string;
  pattern: URLPattern;
  stack: StackItem[];
  slots: string[];
  handler: WebSocketHandler;
};
type WebTransportEndpoint = {
  path: string;
  pattern: URLPattern;
  stack: StackItem[];
  slots: string[];
  handler: WebTransportHandler;
};
type BuildState = {
  stack: StackItem[];
  slots: Set<string>;
  meta: OperationMeta;
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
      const exists = out.parameters.some((current) => current.in === parameter.in && current.name === parameter.name);
      if (exists) throw new Error(`Duplicate OpenAPI parameter ${parameter.in}:${parameter.name}`);
      out.parameters.push({
        ...parameter,
        schema: cloneSchema(parameter.schema)
      });
    }
  }
  if (next.requestBody !== undefined) {
    if (out.requestBody !== undefined && next.replaceRequestBody !== true) throw new Error('Duplicate OpenAPI request body');
    out.requestBody = cloneRequestBody(next.requestBody);
  }
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
function forkState(state: BuildState): BuildState {
  return {
    stack: state.stack.slice(),
    slots: new Set(state.slots),
    meta: cloneMeta(state.meta)
  };
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
function makeInitialContext(app: App, endpoint: Endpoint, req: Request, params: Record<string, string>, info: HandleInfo): HttpContext {
  const ctx: HttpContext = {
    request: req,
    app,
    route: endpoint.path,
    method: endpoint.method,
    protocol: info.protocol ?? 'http/1.1'
  };
  if (info.session !== undefined) ctx.session = info.session;
  if (info.incoming !== undefined) ctx.incoming = info.incoming;
  for (const slot of endpoint.slots) ctx[slot] = undefined;
  ctx.params = params;
  return ctx;
}
function makeInitialWebSocketContext(app: App, endpoint: WebSocketEndpoint, incoming: IncomingWebSocketRequest, params: Record<string, string>): WebSocketContext {
  const ctx = {
    request: incoming.request,
    app,
    route: endpoint.path,
    method: 'WEBSOCKET',
    protocol: incoming.protocol,
    session: incoming.session,
    incoming,
    params
  } as WebSocketContext;
  for (const slot of endpoint.slots) ctx[slot] = undefined;
  return ctx;
}
function makeInitialWebTransportContext(app: App, endpoint: WebTransportEndpoint, incoming: IncomingWebTransportRequest, params: Record<string, string>): WebTransportContext {
  const ctx = {
    request: incoming.request,
    app,
    route: endpoint.path,
    method: 'WEBTRANSPORT',
    protocol: incoming.protocol,
    session: incoming.session,
    incoming,
    params
  } as WebTransportContext;
  for (const slot of endpoint.slots) ctx[slot] = undefined;
  return ctx;
}
async function compose(ctx: HttpContext, stack: StackItem[], handler: Handler): Promise<HttpHandlerResult> {
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
    let downstream: HttpHandlerResult | undefined;
    const result = await item.fn(ctx, async () => {
      downstream = await dispatch(i + 1);
      return downstream;
    });
    if (result === undefined) return downstream ?? defaultNotFound();
    return result;
  }
  const res = await dispatch(0);
  if (res instanceof Response) {
    const applySession = ctx.__sessionApply as undefined | ((res: Response) => Promise<void>);
    await applySession?.(res);
    if (ctx.cookies instanceof CookieJar) ctx.cookies._apply(res);
  }
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
* Attach static OpenAPI metadata to a middleware function.
*
* The returned function is the original function with non-enumerable metadata
* attached. Metadata is read when the middleware is installed in a route stack.
*
* ```ts no_run
* const auth = defineMiddleware(async (ctx, next) => next(), {
*   security: [{ bearerAuth: [] }],
* });
* ```
*/
export function defineMiddleware<T extends Middleware>(fn: T, meta: OperationMeta = {}): T {
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
class BuilderBase<TSelf> {
  protected _state: BuildState;
  constructor(state?: BuildState) {
    this._state = state ?? {
      stack: [],
      slots: new Set(),
      meta: {}
    };
  }
  /** Install middleware on this builder.
  *
  * Middleware is appended in call order and inherited by child route builders.
  *
  * ```ts no_run
  * app.use(errorHandler());
  * ```
  */
  use(...middleware: Middleware[]): TSelf {
    for (const fn of middleware) this._state.stack.push({
      type: 'middleware',
      fn,
      meta: metadataOf(fn)
    });
    return (this as unknown) as TSelf;
  }
  /** Declare and populate a request context value.
  *
  * Duplicate value names in the same inherited stack throw during app build.
  *
  * ```ts no_run
  * app.value('cookies', cookies());
  * ```
  */
  value(name: string, producer: Producer): TSelf {
    if (this._state.slots.has(name)) throw new Error(`Duplicate context value "${name}"`);
    this._state.slots.add(name);
    this._state.stack.push({
      type: 'producer',
      name,
      fn: producer,
      meta: metadataOf(producer)
    });
    return (this as unknown) as TSelf;
  }
  /** Attach OpenAPI operation metadata inherited by child builders.
  *
  * ```ts no_run
  * app.route('/users').meta({ tags: ['users'] });
  * ```
  */
  meta(meta: OperationMeta): TSelf {
    this._state.meta = mergeMeta(this._state.meta, meta);
    return (this as unknown) as TSelf;
  }
}
/**
* HTTP application with middleware, routes, async context, serving, and docs.
*
* ```ts no_run
* const app = new App({ name: 'Example API' });
* app.get('/', () => new Response('ok'));
* ```
*/
export class App extends BuilderBase<App> {
  /**
  * Private property `#name` used by `App`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #name = undefined;
  *
  *   readInternalState() {
  *     return this.#name;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #name: string;
  /**
  * Private property `#endpoints` used by `App`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #endpoints = undefined;
  *
  *   readInternalState() {
  *     return this.#endpoints;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #endpoints: Endpoint[] = [];
  #webSocketEndpoints: WebSocketEndpoint[] = [];
  #webTransportEndpoints: WebTransportEndpoint[] = [];
  /**
  * Private property `#requestContext` used by `App`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #requestContext = undefined;
  *
  *   readInternalState() {
  *     return this.#requestContext;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #requestContext = new Context<HttpContext>('fino:http:app');
  /** Create an application. `name` becomes the default OpenAPI title.
  *
  * ```ts no_run
  * const app = new App({ name: 'Billing API' });
  * ```
  */
  constructor(options: {
    name?: string;
  } = {}) {
    super();
    this.#name = options.name ?? 'Fino API';
  }
  /** Return the current request context, or `undefined` outside app handling.
  *
  * This uses async context propagation, so it can be called from helpers
  * invoked by a handler.
  *
  * ```ts no_run
  * const ctx = app.context();
  * ```
  */
  context(): HttpContext | undefined {
    return this.#requestContext.get();
  }
  /** Create a route builder for one URLPattern pathname.
  *
  * ```ts no_run
  * app.route('/users/:id').get((ctx) => Response.json(ctx.params));
  * ```
  */
  route(path: string): RouteBuilder {
    return new RouteBuilder(this, path, forkState(this._state));
  }
  /** Mount all routes from a router under a prefix.
  *
  * Router middleware is combined with current app middleware at mount time.
  *
  * ```ts no_run
  * app.mount('/api', router);
  * ```
  */
  mount(prefix: string, router: Router): this {
    router._install(this, prefix, this._state);
    return this;
  }
  /** Register a GET route directly or return a method builder.
  *
  * ```ts no_run
  * app.get('/health', () => new Response('ok'));
  * ```
  */
  get(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('GET', path, stack);
  }
  /** Register a POST route directly or return a method builder.
  *
  * ```ts no_run
  * app.post('/users', body.json(), (ctx) => Response.json(ctx.body));
  * ```
  */
  post(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('POST', path, stack);
  }
  /** Register a PUT route directly or return a method builder.
  *
  * ```ts no_run
  * app.put('/users/:id', (ctx) => Response.json(ctx.params));
  * ```
  */
  put(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('PUT', path, stack);
  }
  /** Register a PATCH route directly or return a method builder.
  *
  * ```ts no_run
  * app.patch('/users/:id', (ctx) => Response.json(ctx.params));
  * ```
  */
  patch(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('PATCH', path, stack);
  }
  /** Register a DELETE route directly or return a method builder.
  *
  * ```ts no_run
  * app.delete('/users/:id', () => new Response(null, { status: 204 }));
  * ```
  */
  delete(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('DELETE', path, stack);
  }
  /** Register a HEAD route directly or return a method builder.
  *
  * ```ts no_run
  * app.head('/health', () => new Response(null, { status: 204 }));
  * ```
  */
  head(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('HEAD', path, stack);
  }
  /** Register an OPTIONS route directly or return a method builder.
  *
  * ```ts no_run
  * app.options('/users', () => new Response(null, { status: 204 }));
  * ```
  */
  options(path: string, ...stack: Array<Middleware | Handler>): this | MethodBuilder {
    return this.#direct('OPTIONS', path, stack);
  }
  /** Mount a JSON-RPC service at `path`. All POST requests to `path` are
  * dispatched as JSON-RPC 2.0 messages; other methods return 405. App
  * middleware runs normally before the RPC handler.
  *
  * ```ts no_run
  * import { JsonRpcService } from 'fino:jsonrpc';
  * const svc = new JsonRpcService();
  * svc.method('add').handle((p) => (p as { a: number; b: number }).a + (p as { a: number; b: number }).b);
  * app.rpc('/rpc', svc);
  * ```
  */
  rpc(path: string, service: {
    httpHandler(): (req: Request) => Promise<Response>;
  }): this {
    const handler = service.httpHandler();
    return this.post(path, (ctx) => handler(ctx.request)) as this;
  }
  /** Register a WebSocket route.
  *
  * ```ts no_run
  * app.websocket('/chat', async (socket) => {
  *   socket.addEventListener('message', (event) => socket.send(event.data));
  * });
  * ```
  */
  websocket(path: string, ...stack: Array<Middleware | WebSocketHandler>): this {
    if (stack.length === 0) throw new Error('WebSocket route requires a handler');
    const handler = stack[stack.length - 1] as WebSocketHandler;
    const middleware = stack.slice(0, -1) as Middleware[];
    const state = forkState(this._state);
    for (const fn of middleware) state.stack.push({
      type: 'middleware',
      fn,
      meta: metadataOf(fn)
    });
    const endpoint: WebSocketEndpoint = {
      path,
      pattern: new URLPattern({ pathname: path }),
      stack: state.stack,
      slots: [...state.slots],
      handler
    };
    if (this.#webSocketEndpoints.some((current) => current.path === path)) {
      throw new Error(`Duplicate WebSocket route ${path}`);
    }
    this.#webSocketEndpoints.push(endpoint);
    return this;
  }
  /** Register a WebTransport route.
  *
  * ```ts no_run
  * app.webtransport('/wt', async (session) => {
  *   await session.ready;
  * });
  * ```
  */
  webtransport(path: string, ...stack: Array<Middleware | WebTransportHandler>): this {
    if (stack.length === 0) throw new Error('WebTransport route requires a handler');
    const handler = stack[stack.length - 1] as WebTransportHandler;
    const middleware = stack.slice(0, -1) as Middleware[];
    const state = forkState(this._state);
    for (const fn of middleware) state.stack.push({
      type: 'middleware',
      fn,
      meta: metadataOf(fn)
    });
    const endpoint: WebTransportEndpoint = {
      path,
      pattern: new URLPattern({ pathname: path }),
      stack: state.stack,
      slots: [...state.slots],
      handler
    };
    if (this.#webTransportEndpoints.some((current) => current.path === path)) {
      throw new Error(`Duplicate WebTransport route ${path}`);
    }
    this.#webTransportEndpoints.push(endpoint);
    return this;
  }
  /**
  * Private method `#direct` used by `App`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #direct() {
  *     return 'direct';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#direct();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #direct(method: HttpMethod, path: string, stack: Array<Middleware | Handler>): this | MethodBuilder {
    const route = this.route(path);
    const builder = route._method(method, stack);
    return stack.length > 0 ? this : builder;
  }
  /**
  * Internal method `_addEndpoint` used by `App`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _addEndpoint() {
  *     return '_addEndpoint';
  *   },
  * };
  * includePrivateExample._addEndpoint();
  * ```
  *
  * @internal
  */
  _addEndpoint(endpoint: Endpoint): void {
    if (this.#endpoints.some((current) => current.method === endpoint.method && current.path === endpoint.path)) {
      throw new Error(`Duplicate route ${endpoint.method} ${endpoint.path}`);
    }
    this.#endpoints.push(endpoint);
  }
  /** Dispatch one request through the matching route stack.
  *
  * Returns a JSON 404 response when no method/path pair matches. Matching is
  * based on the URL pathname and the request method.
  *
  * ```ts no_run
  * const response = await app.handle(new Request('http://local/health'));
  * ```
  */
  async handle(req: Request, info: HandleInfo = {}): Promise<HttpHandlerResult> {
    const path = pathFromRequest(req);
    const method = methodName(req.method);
    for (const endpoint of this.#endpoints) {
      if (endpoint.method !== method) continue;
      const match = endpoint.pattern.exec({ pathname: path });
      if (match === null) continue;
      const ctx = makeInitialContext(this, endpoint, req, { ...match.pathname.groups }, info);
      return this.#requestContext.runWithValue(ctx, () => compose(ctx, endpoint.stack, endpoint.handler));
    }
    for (const endpoint of this.#webSocketEndpoints) {
      if (endpoint.pattern.exec({ pathname: path }) !== null) {
        return new Response('Bad Request', { status: 400 });
      }
    }
    return defaultNotFound();
  }
  async #handleWebSocket(incoming: IncomingWebSocketRequest): Promise<void> {
    const path = pathFromRequest(incoming.request);
    for (const endpoint of this.#webSocketEndpoints) {
      const match = endpoint.pattern.exec({ pathname: path });
      if (match === null) continue;
      const ctx = makeInitialWebSocketContext(this, endpoint, incoming, { ...match.pathname.groups });
      await this.#requestContext.runWithValue(ctx, async () => {
        let socket: WebSocketConnection;
        try {
          socket = await incoming.accept();
        } catch {
          await incoming.reject(new Response('Bad Request', { status: 400 }));
          return;
        }
        for (const item of endpoint.stack) {
          if (item.type === 'producer') ctx[item.name] = await item.fn(ctx);
        }
        await endpoint.handler(socket, ctx);
      });
      return;
    }
    await incoming.reject();
  }
  async #handleWebTransport(incoming: IncomingWebTransportRequest): Promise<void> {
    const path = pathFromRequest(incoming.request);
    for (const endpoint of this.#webTransportEndpoints) {
      const match = endpoint.pattern.exec({ pathname: path });
      if (match === null) continue;
      const ctx = makeInitialWebTransportContext(this, endpoint, incoming, { ...match.pathname.groups });
      await this.#requestContext.runWithValue(ctx, async () => {
        let session: WebTransport;
        try {
          session = await incoming.accept();
        } catch {
          await incoming.reject(new Response('Bad Request', { status: 400 }));
          return;
        }
        for (const item of endpoint.stack) {
          if (item.type === 'producer') ctx[item.name] = await item.fn(ctx);
        }
        await endpoint.handler(session, ctx);
      });
      return;
    }
    await incoming.reject();
  }
  /**
  * Dispatch a synthetic WebTransport incoming request for focused app tests.
  *
  * @internal
  */
  _handleWebTransportForTest(incoming: IncomingWebTransportRequest): Promise<void> {
    return this.#handleWebTransport(incoming);
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
      if (incoming.kind === 'websocket') {
        await this.#handleWebSocket(incoming);
        return;
      }
      if (incoming.kind === 'webtransport') {
        await this.#handleWebTransport(incoming);
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
  /** Generate an OpenAPI 3.1 document from registered routes and metadata.
  *
  * Throws when generated or explicit operation IDs collide.
  *
  * ```ts no_run
  * const doc = app.openapi({ version: '1.0.0' });
  * ```
  */
  openapi(options: OpenApiOptions): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    const operationIds = new Set<string>();
    for (const endpoint of this.#endpoints) {
      let meta = cloneMeta(endpoint.meta);
      for (const item of endpoint.stack) {
        if (item.meta !== undefined) meta = mergeMeta(meta, item.meta);
      }
      meta.operationId ??= generatedOperationId(endpoint.method, endpoint.path);
      if (operationIds.has(meta.operationId)) throw new Error(`Duplicate OpenAPI operationId "${meta.operationId}"`);
      operationIds.add(meta.operationId);
      const openPath = routePathToOpenApi(endpoint.path);
      paths[openPath] ??= {};
      const operation: Record<string, unknown> = { operationId: meta.operationId };
      if (meta.summary !== undefined) operation.summary = meta.summary;
      if (meta.description !== undefined) operation.description = meta.description;
      if (meta.tags !== undefined) operation.tags = meta.tags;
      if (meta.security !== undefined) operation.security = meta.security;
      if (meta.parameters !== undefined && meta.parameters.length > 0) operation.parameters = meta.parameters;
      if (meta.requestBody !== undefined) operation.requestBody = meta.requestBody;
      operation.responses = meta.responses ?? { '200': { description: 'OK' } };
      paths[openPath]![endpoint.method.toLowerCase()] = operation;
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
  * app.get('/openapi.json', app.openapiHandler({ version: '1.0.0' }));
  * ```
  */
  openapiHandler(options: OpenApiOptions): Handler {
    return () => Response.json(this.openapi(options));
  }
}
/**
* Reusable route collection mountable into an `App`.
*
* ```ts no_run
* const router = new Router();
* router.get('/users', () => Response.json([]));
* app.mount('/api', router);
* ```
*/
export class Router extends BuilderBase<Router> {
  /**
  * Private property `#routes` used by `Router`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #routes = undefined;
  *
  *   readInternalState() {
  *     return this.#routes;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #routes: RouteBuilder[] = [];
  /** Create a route builder inside this router.
  *
  * ```ts no_run
  * router.route('/users/:id').get((ctx) => Response.json(ctx.params));
  * ```
  */
  route(path: string): RouteBuilder {
    const route = new RouteBuilder(this, path, forkState(this._state));
    this.#routes.push(route);
    return route;
  }
  /** Register a GET route directly.
  *
  * ```ts no_run
  * router.get('/items', () => Response.json([]));
  * ```
  */
  get(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('GET', stack);
    return this;
  }
  /** Register a POST route directly.
  *
  * ```ts no_run
  * router.post('/items', (ctx) => Response.json(ctx.body));
  * ```
  */
  post(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('POST', stack);
    return this;
  }
  /** Register a PUT route directly.
  *
  * ```ts no_run
  * router.put('/items/:id', (ctx) => Response.json(ctx.params));
  * ```
  */
  put(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('PUT', stack);
    return this;
  }
  /** Register a PATCH route directly.
  *
  * ```ts no_run
  * router.patch('/items/:id', (ctx) => Response.json(ctx.params));
  * ```
  */
  patch(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('PATCH', stack);
    return this;
  }
  /** Register a DELETE route directly.
  *
  * ```ts no_run
  * router.delete('/items/:id', () => new Response(null, { status: 204 }));
  * ```
  */
  delete(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('DELETE', stack);
    return this;
  }
  /** Register a HEAD route directly.
  *
  * ```ts no_run
  * router.head('/items', () => new Response(null, { status: 204 }));
  * ```
  */
  head(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('HEAD', stack);
    return this;
  }
  /** Register an OPTIONS route directly.
  *
  * ```ts no_run
  * router.options('/items', () => new Response(null, { status: 204 }));
  * ```
  */
  options(path: string, ...stack: Array<Middleware | Handler>): this {
    this.route(path)._method('OPTIONS', stack);
    return this;
  }
  /** Mount a JSON-RPC service at `path`. Delegates to `App.rpc()` semantics.
  *
  * ```ts no_run
  * import { JsonRpcService } from 'fino:jsonrpc';
  * const svc = new JsonRpcService();
  * svc.method('ping').handle(() => 'pong');
  * router.rpc('/rpc', svc);
  * ```
  */
  rpc(path: string, service: {
    httpHandler(): (req: Request) => Promise<Response>;
  }): this {
    const handler = service.httpHandler();
    this.route(path)._method('POST', [(ctx: HttpContext) => handler(ctx.request)]);
    return this;
  }
  /**
  * Internal method `_install` used by `Router`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _install() {
  *     return '_install';
  *   },
  * };
  * includePrivateExample._install();
  * ```
  *
  * @internal
  */
  _install(app: App, prefix: string, parentState: BuildState): void {
    for (const route of this.#routes) route._install(app, prefix, parentState);
  }
}
/**
* Builder for one URLPattern pathname and shared route-level metadata.
*
* ```ts no_run
* app.route('/users/:id').meta({ tags: ['users'] }).get((ctx) => Response.json(ctx.params));
* ```
*/
export class RouteBuilder extends BuilderBase<RouteBuilder> {
  /**
  * Private property `#owner` used by `RouteBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #owner = undefined;
  *
  *   readInternalState() {
  *     return this.#owner;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #owner: App | Router;
  /**
  * Private property `#path` used by `RouteBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #path = undefined;
  *
  *   readInternalState() {
  *     return this.#path;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #path: string;
  /**
  * Private property `#methods` used by `RouteBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #methods = undefined;
  *
  *   readInternalState() {
  *     return this.#methods;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #methods: MethodBuilder[] = [];
  /**
  * Create a route builder.
  *
  * This is normally created through `app.route()` or `router.route()`.
  *
  * ```ts no_run
  * const route = new RouteBuilder(app, '/items', state);
  * ```
  */
  constructor(owner: App | Router, path: string, state: BuildState) {
    super(state);
    this.#owner = owner;
    this.#path = path;
  }
  /** Register or build GET endpoint.
  *
  * ```ts no_run
  * app.route('/items').get((ctx) => Response.json([]));
  * ```
  */
  get(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('GET', stack);
    return stack.length > 0 ? this : builder;
  }
  /** Register or build POST endpoint.
  *
  * ```ts no_run
  * app.route('/items').post().handle((ctx) => Response.json(ctx.body));
  * ```
  */
  post(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('POST', stack);
    return stack.length > 0 ? this : builder;
  }
  /** Register or build PUT endpoint.
  *
  * ```ts no_run
  * app.route('/items/:id').put((ctx) => Response.json(ctx.params));
  * ```
  */
  put(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('PUT', stack);
    return stack.length > 0 ? this : builder;
  }
  /** Register or build PATCH endpoint.
  *
  * ```ts no_run
  * app.route('/items/:id').patch((ctx) => Response.json(ctx.params));
  * ```
  */
  patch(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('PATCH', stack);
    return stack.length > 0 ? this : builder;
  }
  /** Register or build DELETE endpoint.
  *
  * ```ts no_run
  * app.route('/items/:id').delete(() => new Response(null, { status: 204 }));
  * ```
  */
  delete(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('DELETE', stack);
    return stack.length > 0 ? this : builder;
  }
  /** Register or build HEAD endpoint.
  *
  * ```ts no_run
  * app.route('/items').head(() => new Response(null, { status: 204 }));
  * ```
  */
  head(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('HEAD', stack);
    return stack.length > 0 ? this : builder;
  }
  /** Register or build OPTIONS endpoint.
  *
  * ```ts no_run
  * app.route('/items').options(() => new Response(null, { status: 204 }));
  * ```
  */
  options(...stack: Array<Middleware | Handler>): MethodBuilder | RouteBuilder {
    const builder = this._method('OPTIONS', stack);
    return stack.length > 0 ? this : builder;
  }
  /**
  * Internal method `_method` used by `RouteBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _method() {
  *     return '_method';
  *   },
  * };
  * includePrivateExample._method();
  * ```
  *
  * @internal
  */
  _method(method: HttpMethod, stack: Array<Middleware | Handler>): MethodBuilder {
    const builder = new MethodBuilder(this, method, forkState(this._state));
    this.#methods.push(builder);
    if (stack.length > 0) {
      const handler = stack[stack.length - 1] as Handler;
      const middleware = stack.slice(0, -1) as Middleware[];
      builder.use(...middleware).handle(handler);
    }
    return builder;
  }
  /**
  * Internal method `_complete` used by `RouteBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _complete() {
  *     return '_complete';
  *   },
  * };
  * includePrivateExample._complete();
  * ```
  *
  * @internal
  */
  _complete(builder: MethodBuilder, endpoint: Omit<Endpoint, 'path' | 'pattern'>): RouteBuilder {
    if (this.#owner instanceof App) {
      this.#owner._addEndpoint({
        ...endpoint,
        path: this.#path,
        pattern: new URLPattern({ pathname: this.#path })
      });
    }
    return this;
  }
  /**
  * Internal method `_install` used by `RouteBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _install() {
  *     return '_install';
  *   },
  * };
  * includePrivateExample._install();
  * ```
  *
  * @internal
  */
  _install(app: App, prefix: string, parentState: BuildState): void {
    for (const method of this.#methods) method._install(app, appendPath(prefix, this.#path), parentState);
  }
}
/**
* Builder for one method endpoint. Call `.handle()` to finalize the endpoint.
*
* ```ts no_run
* app.route('/items').post().value('body', body.json()).handle((ctx) => Response.json(ctx.body));
* ```
*/
export class MethodBuilder extends BuilderBase<MethodBuilder> {
  /**
  * Private property `#route` used by `MethodBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #route = undefined;
  *
  *   readInternalState() {
  *     return this.#route;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #route: RouteBuilder;
  /**
  * Private property `#method` used by `MethodBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #method = undefined;
  *
  *   readInternalState() {
  *     return this.#method;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #method: HttpMethod;
  /**
  * Private property `#handler` used by `MethodBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #handler = undefined;
  *
  *   readInternalState() {
  *     return this.#handler;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #handler: Handler | null = null;
  /**
  * Create a method builder.
  *
  * This is normally created by a `RouteBuilder` method such as `.get()`.
  *
  * ```ts no_run
  * const method = new MethodBuilder(route, 'GET', state);
  * ```
  */
  constructor(route: RouteBuilder, method: HttpMethod, state: BuildState) {
    super(state);
    this.#route = route;
    this.#method = method;
  }
  /** Finalize the endpoint and return the parent route builder for chaining.
  *
  * Calling this registers the endpoint on the owning app or router.
  *
  * ```ts no_run
  * app.route('/items').get().handle(() => Response.json([]));
  * ```
  */
  handle(handler: Handler): RouteBuilder {
    this.#handler = handler;
    return this.#route._complete(this, {
      method: this.#method,
      stack: this._state.stack.slice(),
      slots: [...this._state.slots],
      handler,
      meta: cloneMeta(this._state.meta)
    });
  }
  /**
  * Internal method `_install` used by `MethodBuilder`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _install() {
  *     return '_install';
  *   },
  * };
  * includePrivateExample._install();
  * ```
  *
  * @internal
  */
  _install(app: App, path: string, parentState: BuildState): void {
    if (this.#handler === null) return;
    const state = forkState(parentState);
    for (const item of this._state.stack) {
      if (item.type === 'producer') {
        if (state.slots.has(item.name)) throw new Error(`Duplicate context value "${item.name}"`);
        state.slots.add(item.name);
      }
      state.stack.push(item);
    }
    state.meta = mergeMeta(state.meta, this._state.meta);
    app._addEndpoint({
      method: this.#method,
      path,
      pattern: new URLPattern({ pathname: path }),
      stack: state.stack.slice(),
      slots: [...state.slots],
      handler: this.#handler,
      meta: state.meta
    });
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
* app.get('/users', schema.query(v.object({ q: v.string() })), (ctx) => Response.json(ctx.query));
* ```
*/
export const schema = {
  params(schemaValue: unknown): Producer {
    const validator = compile<Record<string, string>>(schemaValue);
    return defineProducer((ctx) => validator.parse(ctx.params ?? {}), { parameters: parametersFromObject(schemaValue, 'path') });
  },
  query(schemaValue: unknown): Middleware {
    const validator = compile<Record<string, unknown>>(schemaValue);
    return defineMiddleware((ctx, next) => {
      ctx.query = validator.parse(parseQueryObject(queryFromRequest(ctx.request)));
      return next();
    }, { parameters: parametersFromObject(schemaValue, 'query') });
  },
  headers(schemaValue: unknown): Middleware {
    const validator = compile<Record<string, unknown>>(schemaValue);
    return defineMiddleware((ctx, next) => {
      ctx.headers = validator.parse(parseHeaderObject(ctx.request.headers));
      return next();
    }, { parameters: parametersFromObject(schemaValue, 'header') });
  },
  response(schemaValue: unknown, opts: {
    status?: number;
    description?: string;
    contentType?: string;
  } = {}): Middleware {
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
/**
* Mutable cookie jar populated from the request and applied to the response.
*
* Queue cookie changes with `set()` or `delete()`. The app middleware pipeline
* applies queued `Set-Cookie` headers after a `Response` is produced.
*
* ```ts no_run
* const jar = new CookieJar('sid=123');
* jar.set('theme', 'dark', { path: '/' });
* ```
*/
export class CookieJar {
  /**
  * Private property `#values` used by `CookieJar`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #values = undefined;
  *
  *   readInternalState() {
  *     return this.#values;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #values: Record<string, string>;
  /**
  * Private property `#out` used by `CookieJar`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #out = undefined;
  *
  *   readInternalState() {
  *     return this.#out;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #out: string[] = [];
  /**
  * Parse a Cookie header into a mutable jar.
  *
  * `null` creates an empty jar. Invalid cookie parsing behavior follows
  * `parseCookieHeader`.
  *
  * ```ts no_run
  * const jar = new CookieJar(ctx.request.headers.get('cookie'));
  * ```
  */
  constructor(header: string | null) {
    this.#values = header === null ? {} : parseCookieHeader(header);
  }
  /** Read one request cookie.
  *
  * Returns `undefined` when the cookie was not present or was deleted locally.
  *
  * ```ts no_run
  * const sid = jar.get('sid');
  * ```
  */
  get(name: string): string | undefined {
    return this.#values[name];
  }
  /** Return all request cookies as a plain object copy.
  *
  * ```ts no_run
  * const values = jar.all();
  * ```
  */
  all(): Record<string, string> {
    return { ...this.#values };
  }
  /** Queue a `Set-Cookie` header and update this jar's current value.
  *
  * Cookie options are passed to `serializeCookie`.
  *
  * ```ts no_run
  * jar.set('sid', session.id, { httpOnly: true, path: '/' });
  * ```
  */
  set(name: string, value: string, options: CookieOptions = {}): void {
    this.#values[name] = value;
    this.#out.push(serializeCookie(name, value, options));
  }
  /** Queue an expired `Set-Cookie` header and remove this jar's current value.
  *
  * ```ts no_run
  * jar.delete('sid', { path: '/' });
  * ```
  */
  delete(name: string, options: CookieOptions = {}): void {
    delete this.#values[name];
    this.#out.push(serializeCookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0
    }));
  }
  /**
  * Internal method `_apply` used by `CookieJar`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _apply() {
  *     return '_apply';
  *   },
  * };
  * includePrivateExample._apply();
  * ```
  *
  * @internal
  */
  _apply(res: Response): void {
    for (const value of this.#out) (res.headers as Headers & {
      _appendTrusted(name: string, value: string): void;
    })._appendTrusted('set-cookie', value);
  }
}
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
/** Session data persisted by a `SessionStore`.
*
* ```ts no_run
* session.data.userId = 'u_123';
* ```
*/
export interface Session {
  /** Stable session ID.
  *
  * ```ts no_run
  * console.log(session.id);
  * ```
  */
  id: string;
  /** Mutable session payload.
  *
  * ```ts no_run
  * session.data.count = Number(session.data.count ?? 0) + 1;
  * ```
  */
  data: Record<string, unknown>;
  /** True when this session was created for the current request.
  *
  * ```ts no_run
  * if (session.isNew) console.log('new session');
  * ```
  */
  isNew: boolean;
}
/** Minimal async session store interface.
*
* Store methods may be synchronous or async. Returned sessions should be safe
* for request-local mutation.
*
* ```ts no_run
* const store = memorySessionStore();
* ```
*/
export interface SessionStore {
  /** Load a session by ID, or return `null` when missing.
  *
  * ```ts no_run
  * const session = await store.get(id);
  * ```
  */
  get(id: string): Session | null | Promise<Session | null>;
  /** Persist a session by ID.
  *
  * ```ts no_run
  * await store.set(session.id, session);
  * ```
  */
  set(id: string, session: Session): void | Promise<void>;
  /** Delete a session by ID.
  *
  * ```ts no_run
  * await store.delete(id);
  * ```
  */
  delete(id: string): void | Promise<void>;
}
/** Create an in-memory session store suitable for tests and single-process apps.
*
* Data is lost when the process exits and is not shared across workers.
*
* ```ts no_run
* const store = memorySessionStore();
* app.value('session', sessions({ store }));
* ```
*/
export function memorySessionStore(): SessionStore {
  const map = new Map<string, Session>();
  return {
    get(id) {
      const session = map.get(id);
      return session === undefined ? null : {
        id: session.id,
        isNew: false,
        data: { ...session.data }
      };
    },
    set(id, session) {
      map.set(id, {
        id,
        isNew: false,
        data: { ...session.data }
      });
    },
    delete(id) {
      map.delete(id);
    }
  };
}
/** Producer that loads a cookie-backed session and saves it after response creation.
*
* Expects `ctx.cookies` to be a `CookieJar` when installed after
* `.value('cookies', cookies())`; otherwise it creates a private jar. New
* sessions are assigned UUIDs and persisted after the response is produced.
*
* ```ts no_run
* app.value('cookies', cookies()).value('session', sessions({ store: memorySessionStore() }));
* ```
*/
export function sessions(opts: {
  store: SessionStore;
  cookie?: string;
  cookieOptions?: CookieOptions;
}): Producer {
  const cookie = opts.cookie ?? 'sid';
  return defineProducer(async (ctx) => {
    const jar = ctx.cookies instanceof CookieJar ? ctx.cookies : new CookieJar(ctx.request.headers.get('cookie'));
    const existing = jar.get(cookie);
    let session = existing === undefined ? null : await opts.store.get(existing);
    if (session === null) session = {
      id: uuidv4().toString(),
      data: {},
      isNew: true
    };
    const currentNext = ctx.__sessionApply as undefined | ((res: Response) => Promise<void>);
    ctx.__sessionApply = async (res: Response) => {
      await currentNext?.(res);
      await opts.store.set(session!.id, session!);
      if (session!.isNew || existing === undefined) jar.set(cookie, session!.id, {
        path: '/',
        httpOnly: true,
        ...opts.cookieOptions
      });
    };
    return session;
  });
}
/** Middleware that converts uncaught errors to a JSON error response.
*
* By default, error messages are hidden. Pass `{ expose: true }` for development
* or trusted internal APIs.
*
* ```ts no_run
* app.use(errorHandler({ expose: false }));
* ```
*/
export function errorHandler(opts: {
  expose?: boolean;
} = {}): Middleware {
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
* app.use(staticFiles('/var/www', { index: 'index.html', prefix: '/' }));
* ```
*/
export function staticFiles(root: string, opts: {
  index?: string;
  prefix?: string;
} = {}): Middleware {
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
