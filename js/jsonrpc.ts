/**
* fino:jsonrpc - JSON-RPC 2.0 request dispatch and peer transports.
*
* Useful references:
*
* - JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
*
* This module provides the common JSON-RPC pieces used by Fino integrations:
* a method registry for request handling, a bidirectional peer for request and
* notification exchange over string transports, and a small HTTP server adapter
* for services that only need a JSON-RPC endpoint.
*
* ## Protocol model
*
* `JsonRpcService` handles one JSON-RPC message string at a time. Requests with
* an `id` produce a JSON response string, while notifications without an `id`
* run the handler in the background and return `null`. The dispatcher emits the
* standard error codes exported by this module and can validate `params` with
* `fino:validate` schemas before calling a method.
*
* `JsonRpcPeer` builds on the same service model for long-lived, bidirectional
* transports. The transport contract is deliberately minimal: framing can be
* newline-delimited streams, pipes, WebSockets, stdio processes, or in-memory
* queues as long as the transport sends and receives complete JSON-RPC strings.
*
* ## Current coverage
*
* The implementation targets the single-message request, response, error, and
* notification flow from JSON-RPC 2.0. Batch requests are not implemented, and
* callers that require strict preflight validation of every JSON-RPC envelope
* field should validate before dispatch. Methods named with the reserved
* `rpc.` prefix are not blocked by the registry.
*
* ```ts no_run
* import { JsonRpcService, JsonRpcServer } from 'fino:jsonrpc';
* import { v } from 'fino:validate';
*
* const service = new JsonRpcService();
* service.method('math.add')
*   .description('Add two numbers.')
*   .params(v.object({ a: v.number(), b: v.number() }))
*   .handle((params) => {
*     const { a, b } = params as { a: number; b: number };
*     return a + b;
*   });
*
* const server = new JsonRpcServer(service).listen({ port: 3000, path: '/rpc' });
* await server.ready;
* ```
*/
import { serveHttp } from 'fino:net/http/server';
import type { ServeServer } from 'fino:net/http/server';
import { compile } from 'fino:validate';
import type { JsonSchema, SchemaBuilder } from 'fino:validate';
/** Standard JSON-RPC parse error code for invalid JSON payloads. */
export const PARSE_ERROR = -32700;
/** Standard JSON-RPC invalid request code for malformed request objects. */
export const INVALID_REQUEST = -32600;
/** Standard JSON-RPC method lookup failure code. */
export const METHOD_NOT_FOUND = -32601;
/** Standard JSON-RPC parameter validation failure code. */
export const INVALID_PARAMS = -32602;
/** Standard JSON-RPC internal error code for unexpected handler failures. */
export const INTERNAL_ERROR = -32603;
/**
* Error type that lets handlers choose the JSON-RPC error code and optional
* `data` value returned to a caller.
*
* Throw this from a `JsonRpcService` handler when an application-level failure
* should be represented as a JSON-RPC error response instead of the default
* `INTERNAL_ERROR`.
*/
export class JsonRpcError extends Error {
  /** JSON-RPC error code to serialize in the response. */
  code: number;
  /** Optional application-specific error details for the response `data` field. */
  data?: unknown;
  /**
  * Create an error response payload.
  *
  * `message` is also used as the JavaScript `Error.message`; `code` is copied
  * into the JSON-RPC error object; `data`, when present, is serialized as the
  * JSON-RPC error `data` member.
  */
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}
/**
* Minimal bidirectional carrier for complete JSON-RPC message strings.
*
* A transport owns framing. `send()` must write one complete JSON-RPC message,
* `receive()` must yield complete JSON-RPC messages, and `close()` should stop
* both directions. The peer and server do not impose newline, WebSocket, or
* stream framing by themselves.
*/
export interface Transport {
  /** Send one complete JSON-RPC message string. */
  send(message: string): void | Promise<void>;
  /** Yield complete JSON-RPC message strings until the connection closes. */
  receive(): AsyncIterable<string>;
  /** Close the transport and unblock pending receivers when possible. */
  close(): void | Promise<void>;
}
/**
* Request-scoped data passed to method handlers.
*/
export interface RequestContext {
  /** Request id, notification marker, or `undefined` for notifications. */
  id: number | string | null | undefined;
  /** Abort signal associated with the current dispatch or HTTP request. */
  signal: AbortSignal;
}
/**
* JSON-RPC method implementation.
*
* `params` is the raw request `params` value after optional schema validation.
* The return value is serialized as the response `result` for requests. For
* notifications, returned values are ignored.
*/
export type JsonRpcHandler = (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
/**
* Optional metadata attached to a registered method.
*
* Metadata is returned by `JsonRpcService.list()` and is also used for automatic
* `params` validation when a schema is provided.
*/
export interface MethodMeta {
  /** Human-readable method description for registries or discovery endpoints. */
  description?: string;
  /** JSON Schema or `fino:validate` builder used to validate request params. */
  params?: JsonSchema | SchemaBuilder;
}
// ---------------------------------------------------------------------------
// JsonRpcService — structured method registry and single-message dispatcher
// ---------------------------------------------------------------------------
type MethodEntry = {
  handler: JsonRpcHandler;
  meta: MethodMeta;
};
class MethodBuilder {
  #commit: (handler: JsonRpcHandler, meta: MethodMeta) => JsonRpcService;
  #meta: MethodMeta = {};
  constructor(commit: (handler: JsonRpcHandler, meta: MethodMeta) => JsonRpcService) {
    this.#commit = commit;
  }
  /** Attach a human-readable description to the method being registered. */
  description(desc: string): this {
    this.#meta = {
      ...this.#meta,
      description: desc
    };
    return this;
  }
  /** Attach a params schema that is checked before the handler is called. */
  params(schema: JsonSchema | SchemaBuilder): this {
    this.#meta = {
      ...this.#meta,
      params: schema
    };
    return this;
  }
  /** Finish registration with the handler and return the owning service. */
  handle(fn: JsonRpcHandler): JsonRpcService {
    return this.#commit(fn, this.#meta);
  }
}
/**
* Registry and dispatcher for JSON-RPC methods.
*
* A service maps method names to handlers and handles one inbound JSON-RPC
* message string at a time. It is transport-agnostic: callers can feed messages
* from HTTP, stdio, sockets, test queues, or `JsonRpcPeer`.
*/
export class JsonRpcService {
  #methods = new Map<string, MethodEntry>();
  /**
  * Start registering a method by name.
  *
  * Chain `.description()` or `.params()` before `.handle()` when the method
  * needs registry metadata or input validation.
  */
  method(name: string): MethodBuilder {
    return new MethodBuilder((handler, meta) => {
      this.#methods.set(name, {
        handler,
        meta
      });
      return this;
    });
  }
  /**
  * Return the registered method metadata in insertion order.
  *
  * The result is useful for local discovery endpoints, MCP-style tool
  * conversion, or diagnostics. Handler functions are intentionally omitted.
  */
  list(): Array<{
    name: string;
    description?: string;
    params?: Record<string, unknown>;
  }> {
    return Array.from(this.#methods.entries()).map(([name, { meta }]) => ({
      name,
      ...meta.description !== undefined ? { description: meta.description } : {},
      ...meta.params !== undefined ? { params: meta.params } : {}
    }));
  }
  /**
  * Dispatch one JSON-RPC message string.
  *
  * Invalid JSON returns a `PARSE_ERROR` response. Malformed single request
  * objects return `INVALID_REQUEST`. Unknown methods return `METHOD_NOT_FOUND`
  * for requests and no response for notifications. When method metadata
  * includes a params schema, failed validation returns `INVALID_PARAMS`.
  *
  * The return value is a serialized JSON-RPC response for requests, or `null`
  * when no response should be sent.
  */
  async handle(raw: string, signal?: AbortSignal): Promise<string | null> {
    const sig = signal ?? new AbortController().signal;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: PARSE_ERROR,
          message: 'Parse error'
        },
        id: null
      });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: INVALID_REQUEST,
          message: 'Invalid request'
        },
        id: null
      });
    }
    const m = msg as Record<string, unknown>;
    if (typeof m.method !== 'string') {
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: INVALID_REQUEST,
          message: 'Invalid request'
        },
        id: null
      });
    }
    const id = 'id' in m ? m.id as number | string | null : undefined;
    const entry = this.#methods.get(m.method);
    if (!entry) {
      if (id != null) {
        return JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: METHOD_NOT_FOUND,
            message: `Method not found: ${m.method}`
          },
          id
        });
      }
      return null;
    }
    if (entry.meta.params !== undefined) {
      const check = compile(entry.meta.params).safeParse(m.params);
      if (!check.success) {
        if (id == null) return null;
        return JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: INVALID_PARAMS,
            message: 'Invalid params',
            data: check.issues
          },
          id
        });
      }
    }
    // Notification (no id) — fire and forget
    if (id === undefined) {
      void Promise.resolve(entry.handler(m.params, {
        id: undefined,
        signal: sig
      })).catch(() => {});
      return null;
    }
    try {
      const result = await entry.handler(m.params, {
        id,
        signal: sig
      });
      return JSON.stringify({
        jsonrpc: '2.0',
        result,
        id
      });
    } catch (err: unknown) {
      const code = err instanceof JsonRpcError ? err.code : INTERNAL_ERROR;
      const data = err instanceof JsonRpcError ? err.data : undefined;
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code,
          message: String(err),
          ...data !== undefined ? { data } : {}
        },
        id
      });
    }
  }
  /**
  * Create a Fetch-compatible HTTP handler for this service.
  *
  * Only `POST` requests are accepted. Requests that dispatch to notifications
  * receive `204 No Content`; request messages receive an `application/json`
  * response body containing the serialized JSON-RPC response.
  */
  httpHandler(): (req: Request) => Promise<Response> {
    const svc = this;
    return async (req: Request) => {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const body = await req.text();
      const response = await svc.handle(body, req.signal);
      if (response === null) return new Response(null, { status: 204 });
      return new Response(response, { headers: { 'content-type': 'application/json' } });
    };
  }
}
// ---------------------------------------------------------------------------
// JsonRpcPeer — bidirectional connection over a Transport
// ---------------------------------------------------------------------------
/**
* Bidirectional JSON-RPC endpoint over a `Transport`.
*
* The peer starts reading as soon as it is constructed. It resolves pending
* calls from inbound responses and dispatches inbound requests to the optional
* local service. Use `done` to observe the receive loop and `close()` to stop
* the transport.
*/
export class JsonRpcPeer {
  #transport: Transport;
  #service: JsonRpcService | null;
  #signal?: AbortSignal;
  #pending = new Map<number, {
    resolve(v: unknown): void;
    reject(e: unknown): void;
  }>();
  #idSeq = 0;
  #closed = false;
  #readLoop: Promise<void>;
  /**
  * Create a peer over `transport`.
  *
  * `service`, when provided, handles inbound requests and notifications from
  * the same connection. `opts.signal` is passed through to those handlers.
  */
  constructor(transport: Transport, service?: JsonRpcService, opts: {
    signal?: AbortSignal;
  } = {}) {
    this.#transport = transport;
    this.#service = service ?? null;
    this.#signal = opts.signal;
    this.#readLoop = this.#startLoop();
  }
  async #startLoop(): Promise<void> {
    try {
      for await (const raw of this.#transport.receive()) {
        if (this.#closed) break;
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
        const m = msg as Record<string, unknown>;
        if (('result' in m || 'error' in m) && 'id' in m) {
          const id = m.id as number;
          const p = this.#pending.get(id);
          if (!p) continue;
          this.#pending.delete(id);
          if ('error' in m) {
            const e = m.error as Record<string, unknown>;
            p.reject(new JsonRpcError(e.message as string ?? 'Unknown error', e.code as number ?? INTERNAL_ERROR, e.data));
          } else {
            p.resolve(m.result);
          }
          continue;
        }
        if (this.#service && typeof m.method === 'string') {
          void this.#service.handle(raw, this.#signal).then((response) => {
            if (response !== null) void this.#transport.send(response);
          });
        }
      }
    } catch {
      const err = new JsonRpcError('Connection closed', INTERNAL_ERROR);
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    }
  }
  /**
  * Send a request and wait for its response result.
  *
  * Request ids are generated as increasing numbers local to this peer. Rejected
  * JSON-RPC responses become `JsonRpcError` instances.
  */
  call(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#idSeq;
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      id
    };
    if (params !== undefined) body.params = params;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve,
        reject
      });
      Promise.resolve(this.#transport.send(JSON.stringify(body))).catch(reject);
    });
  }
  /**
  * Send a notification.
  *
  * Notifications do not include an id, so no response is expected and remote
  * handler failures are not reported to this peer.
  */
  async notify(method: string, params?: unknown): Promise<void> {
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method
    };
    if (params !== undefined) body.params = params;
    await this.#transport.send(JSON.stringify(body));
  }
  /**
  * Promise for the background receive loop.
  *
  * It settles when the transport receive iterator ends or throws.
  */
  get done(): Promise<void> {
    return this.#readLoop;
  }
  /**
  * Mark the peer closed and close the underlying transport.
  */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#transport.close();
  }
}
// ---------------------------------------------------------------------------
// JsonRpcServer — serve a JsonRpcService over connections
// ---------------------------------------------------------------------------
/**
* Options for serving JSON-RPC over HTTP.
*/
export interface ListenOptions {
  /** TCP port for the HTTP listener. Use `0` to request an ephemeral port. */
  port: number;
  /** Optional bind host passed to the HTTP server. */
  host?: string;
  /** URL pathname that should receive JSON-RPC POST requests. Defaults to `/`. */
  path?: string;
}
/**
* Handle returned by `JsonRpcServer.listen()`.
*/
export interface ServerHandle {
  /** Actual bound port, including the assigned ephemeral port when `0` was used. */
  readonly port: number;
  /** Stop accepting HTTP requests and release the listener. */
  close(): Promise<void>;
  /** Settles when the HTTP listener is ready to accept requests. */
  readonly ready: Promise<void>;
}
/**
* Serve a `JsonRpcService` over transports or a convenience HTTP listener.
*
* For composed HTTP applications, prefer `JsonRpcService.httpHandler()` or the
* `App.rpc()` helper so authentication, routing, and middleware can live in the
* application layer. `JsonRpcServer` is useful for tests, local tools, and simple
* standalone JSON-RPC endpoints.
*/
export class JsonRpcServer {
  #service: JsonRpcService;
  /** Wrap a service for transport or HTTP serving. */
  constructor(service: JsonRpcService) {
    this.#service = service;
  }
  /**
  * Serve a service over one message-string transport until it closes.
  */
  async serve(transport: Transport): Promise<void> {
    for await (const raw of transport.receive()) {
      const response = await this.#service.handle(raw);
      if (response !== null) await transport.send(response);
    }
  }
  /**
  * Start a standalone HTTP JSON-RPC endpoint.
  *
  * Only requests whose pathname matches `opts.path` are dispatched; all other
  * paths return `404`. Method filtering and response formatting are delegated
  * to `JsonRpcService.httpHandler()`.
  */
  listen(opts: ListenOptions): ServerHandle {
    const path = opts.path ?? '/';
    const handler = this.#service.httpHandler();
    const inner: ServeServer = serveHttp({
      port: opts.port,
      ...opts.host ? { host: opts.host } : {}
    }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response('Not found', { status: 404 });
      return handler(req);
    });
    return {
      get port() {
        return inner.port;
      },
      close: () => inner.close(),
      get ready() {
        return inner.ready;
      }
    };
  }
}
