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
 * notification flow from JSON-RPC 2.0. Batch requests are not implemented.
 * Single-message envelopes require `jsonrpc: "2.0"`, a string method, a
 * string/number/null request id when present, and structured params when
 * present. Methods named with the reserved `rpc.` prefix are not blocked by
 * the registry.
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
/** ACP/LSP-compatible cancellation code for an aborted JSON-RPC request. */
export const REQUEST_CANCELLED = -32800;
/**
 * Error type that lets handlers choose the JSON-RPC error code and optional
 * `data` value returned to a caller.
 *
 * Throw this from a `JsonRpcService` handler when an application-level failure
 * should be represented as a JSON-RPC error response instead of the default
 * `INTERNAL_ERROR`. On the calling side, `JsonRpcPeer.call()` also rejects with a
 * `JsonRpcError` reconstructed from an inbound error response, so the same type
 * carries failures in both directions.
 *
 * ```ts no_run
 * import { JsonRpcService, JsonRpcError } from 'fino:jsonrpc';
 *
 * const service = new JsonRpcService();
 * service.method('account.withdraw').handle((params) => {
 *   const { amount, balance } = params as { amount: number; balance: number };
 *   if (amount > balance) {
 *     throw new JsonRpcError('Insufficient funds', -32001, { balance });
 *   }
 *   return balance - amount;
 * });
 * ```
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
 *
 * Implement this interface to bridge any duplex byte or message stream into
 * `JsonRpcPeer` or `JsonRpcServer`. The example below adapts a WebSocket-like
 * object that already delivers discrete text frames, so no extra framing is
 * needed.
 *
 * ```ts no_run
 * import { JsonRpcPeer } from 'fino:jsonrpc';
 * import type { Transport } from 'fino:jsonrpc';
 *
 * function wsTransport(ws: {
 *   send(data: string): void;
 *   close(): void;
 *   messages(): AsyncIterable<string>;
 * }): Transport {
 *   return {
 *     send: (message) => ws.send(message),
 *     receive: () => ws.messages(),
 *     close: () => ws.close(),
 *   };
 * }
 *
 * const peer = new JsonRpcPeer(wsTransport(socket));
 * const result = await peer.call('ping');
 * ```
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
 *
 * The second argument to every `JsonRpcHandler` carries the current request `id`
 * (or `undefined` for notifications) and an `AbortSignal` that fires when the
 * dispatch or underlying HTTP request is cancelled. Handlers should forward
 * `signal` to downstream async work so long-running methods can be aborted.
 *
 * ```ts no_run
 * import { JsonRpcService } from 'fino:jsonrpc';
 *
 * const service = new JsonRpcService();
 * service.method('fetch.upstream').handle(async (params, ctx) => {
 *   const { url } = params as { url: string };
 *   const res = await fetch(url, { signal: ctx.signal });
 *   return res.status;
 * });
 * ```
 */
export interface RequestContext {
  /** Request id, notification marker, or `undefined` for notifications. */
  id: number | string | null | undefined;
  /** Abort signal associated with the current dispatch or HTTP request. */
  signal: AbortSignal;
  /** Stable connection signal when a peer derives a cancellable per-request signal. */
  connectionSignal?: AbortSignal;
}
/**
 * JSON-RPC method implementation.
 *
 * `params` is the raw request `params` value after optional schema validation.
 * The return value is serialized as the response `result` for requests. For
 * notifications, returned values are ignored. Throwing a `JsonRpcError` controls
 * the error code sent to the caller; any other thrown value becomes an
 * `INTERNAL_ERROR` response.
 *
 * ```ts no_run
 * import { JsonRpcService } from 'fino:jsonrpc';
 * import type { JsonRpcHandler } from 'fino:jsonrpc';
 *
 * const greet: JsonRpcHandler = (params) => {
 *   const { name } = params as { name: string };
 *   return `Hello, ${name}`;
 * };
 *
 * new JsonRpcService().method('greet').handle(greet);
 * ```
 */
export type JsonRpcHandler = (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
/**
 * Optional metadata attached to a registered method.
 *
 * Metadata is returned by `JsonRpcService.list()` and is also used for automatic
 * `params` validation when a schema is provided. Metadata is accumulated through
 * the `MethodBuilder` returned by `JsonRpcService.method()` rather than
 * constructed directly, but the shape is exported so discovery code that consumes
 * `list()` can type the entries it reads.
 *
 * ```ts no_run
 * import { JsonRpcService } from 'fino:jsonrpc';
 * import { v } from 'fino:validate';
 *
 * const service = new JsonRpcService();
 * service.method('user.rename')
 *   .description('Change a user display name.')
 *   .params(v.object({ id: v.string(), name: v.string() }))
 *   .handle((params) => params);
 *
 * for (const method of service.list()) {
 *   console.log(method.name, method.description);
 * }
 * ```
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
      description: desc,
    };
    return this;
  }
  /** Attach a params schema that is checked before the handler is called. */
  params(schema: JsonSchema | SchemaBuilder): this {
    this.#meta = {
      ...this.#meta,
      params: schema,
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
 *
 * Register methods with the `method(name)` builder, then dispatch raw message
 * strings through `handle()`. The same service can be mounted onto HTTP via
 * `httpHandler()`, served standalone through `JsonRpcServer`, or attached to a
 * bidirectional `JsonRpcPeer` to answer inbound requests.
 *
 * ```ts no_run
 * import { JsonRpcService } from 'fino:jsonrpc';
 * import { v } from 'fino:validate';
 *
 * const service = new JsonRpcService();
 * service.method('math.add')
 *   .params(v.object({ a: v.number(), b: v.number() }))
 *   .handle((params) => {
 *     const { a, b } = params as { a: number; b: number };
 *     return a + b;
 *   });
 *
 * const response = await service.handle(JSON.stringify({
 *   jsonrpc: '2.0',
 *   method: 'math.add',
 *   params: { a: 2, b: 3 },
 *   id: 1,
 * }));
 * // response === '{"jsonrpc":"2.0","result":5,"id":1}'
 * ```
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
        meta,
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
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.params !== undefined ? { params: meta.params } : {}),
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
  async handle(
    raw: string,
    signal?: AbortSignal,
    connectionSignal?: AbortSignal,
  ): Promise<string | null> {
    const sig = signal ?? new AbortController().signal;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: PARSE_ERROR,
          message: 'Parse error',
        },
        id: null,
      });
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: INVALID_REQUEST,
          message: 'Invalid request',
        },
        id: null,
      });
    }
    const m = msg as Record<string, unknown>;
    const invalidId =
      'id' in m && m.id !== null && typeof m.id !== 'string' && typeof m.id !== 'number';
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string' || invalidId) {
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: INVALID_REQUEST,
          message: 'Invalid request',
        },
        id: null,
      });
    }
    const id = 'id' in m ? (m.id as number | string | null) : undefined;
    if ('params' in m && m.params !== undefined && (!m.params || typeof m.params !== 'object')) {
      if (id === undefined) return null;
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: INVALID_PARAMS,
          message: 'Invalid params',
        },
        id,
      });
    }
    const entry = this.#methods.get(m.method);
    if (!entry) {
      if (id !== undefined) {
        return JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: METHOD_NOT_FOUND,
            message: `Method not found: ${m.method}`,
          },
          id,
        });
      }
      return null;
    }
    if (entry.meta.params !== undefined) {
      const check = compile(entry.meta.params).safeParse(m.params);
      if (!check.success) {
        if (id === undefined) return null;
        return JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: INVALID_PARAMS,
            message: 'Invalid params',
            data: check.issues,
          },
          id,
        });
      }
    }
    // Notification (no id) — fire and forget
    if (id === undefined) {
      void Promise.resolve(
        entry.handler(m.params, {
          id: undefined,
          signal: sig,
          ...(connectionSignal ? { connectionSignal } : {}),
        }),
      ).catch(() => {});
      return null;
    }
    try {
      const result = await entry.handler(m.params, {
        id,
        signal: sig,
        ...(connectionSignal ? { connectionSignal } : {}),
      });
      return JSON.stringify({
        jsonrpc: '2.0',
        result,
        id,
      });
    } catch (err: unknown) {
      const code =
        err instanceof JsonRpcError
          ? err.code
          : (err as Error)?.name === 'AbortError'
            ? REQUEST_CANCELLED
            : INTERNAL_ERROR;
      const data = err instanceof JsonRpcError ? err.data : undefined;
      return JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code,
          message: String(err),
          ...(data !== undefined ? { data } : {}),
        },
        id,
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
 *
 * Unlike `JsonRpcService`, a peer can originate traffic: `call()` sends a request
 * and awaits its result, while `notify()` sends a fire-and-forget notification.
 * Passing a `JsonRpcService` makes the connection symmetric so both ends can call
 * each other over the single transport.
 *
 * ```ts no_run
 * import { JsonRpcPeer, JsonRpcService } from 'fino:jsonrpc';
 * import type { Transport } from 'fino:jsonrpc';
 *
 * declare const transport: Transport;
 *
 * const local = new JsonRpcService();
 * local.method('log').handle((params) => { console.log(params); });
 *
 * const peer = new JsonRpcPeer(transport, local);
 * const sum = await peer.call('math.add', { a: 1, b: 2 });
 * await peer.notify('log', { level: 'info', message: 'done' });
 * await peer.close();
 * ```
 */
export class JsonRpcPeer {
  #transport: Transport;
  #service: JsonRpcService | null;
  #signal?: AbortSignal;
  #pending = new Map<
    number,
    {
      resolve(v: unknown): void;
      reject(e: unknown): void;
      cleanup(): void;
    }
  >();
  #inflight = new Map<number | string | null, AbortController>();
  #idSeq = 0;
  #closed = false;
  #transportClosed = false;
  #readLoop: Promise<void>;
  #rejectPending(error: JsonRpcError): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }
  /**
   * Create a peer over `transport`.
   *
   * `service`, when provided, handles inbound requests and notifications from
   * the same connection. `opts.signal` is passed through to those handlers.
   */
  constructor(
    transport: Transport,
    service?: JsonRpcService,
    opts: {
      signal?: AbortSignal;
    } = {},
  ) {
    this.#transport = transport;
    this.#service = service ?? null;
    this.#signal = opts.signal;
    this.#readLoop = this.#startLoop();
  }
  async #startLoop(): Promise<void> {
    let closeError = new JsonRpcError('Connection closed', INTERNAL_ERROR);
    try {
      for await (const raw of this.#transport.receive()) {
        if (this.#closed) break;
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          if (this.#service) {
            const response = await this.#service.handle(raw, this.#signal, this.#signal);
            if (response !== null) await this.#transport.send(response);
          }
          continue;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          if (this.#service) {
            const response = await this.#service.handle(raw, this.#signal, this.#signal);
            if (response !== null) await this.#transport.send(response);
          }
          continue;
        }
        const m = msg as Record<string, unknown>;
        if (('result' in m || 'error' in m) && 'id' in m) {
          const id = m.id as number;
          const p = this.#pending.get(id);
          if (!p) continue;
          this.#pending.delete(id);
          p.cleanup();
          if ('error' in m) {
            const e = m.error as Record<string, unknown>;
            p.reject(
              new JsonRpcError(
                (e.message as string) ?? 'Unknown error',
                (e.code as number) ?? INTERNAL_ERROR,
                e.data,
              ),
            );
          } else {
            p.resolve(m.result);
          }
          continue;
        }
        if (m.method === '$/cancel_request' && !('id' in m)) {
          const params = m.params as Record<string, unknown> | undefined;
          const requestId = params?.requestId;
          if (
            requestId === null ||
            typeof requestId === 'string' ||
            typeof requestId === 'number'
          ) {
            const controller = this.#inflight.get(requestId);
            if (controller && !controller.signal.aborted) {
              const error = new Error(`JSON-RPC request ${String(requestId)} cancelled`);
              error.name = 'AbortError';
              controller.abort(error);
            }
          }
          continue;
        }
        if (this.#service && typeof m.method === 'string') {
          const id =
            'id' in m && (m.id === null || typeof m.id === 'string' || typeof m.id === 'number')
              ? m.id
              : undefined;
          const controller = id !== undefined ? new AbortController() : null;
          if (controller) this.#inflight.set(id, controller);
          const signal = controller
            ? this.#signal
              ? AbortSignal.any([this.#signal, controller.signal])
              : controller.signal
            : this.#signal;
          void this.#service
            .handle(raw, signal, this.#signal)
            .then((response) => {
              if (response !== null) return this.#transport.send(response);
            })
            .finally(() => {
              if (controller && this.#inflight.get(id!) === controller) this.#inflight.delete(id!);
            })
            .catch(() => {});
        }
      }
    } catch (error) {
      closeError =
        error instanceof JsonRpcError
          ? error
          : new JsonRpcError((error as Error)?.message ?? 'Connection closed', INTERNAL_ERROR);
    } finally {
      this.#closed = true;
      for (const controller of this.#inflight.values()) {
        if (!controller.signal.aborted) {
          const error = new Error('JSON-RPC connection closed');
          error.name = 'AbortError';
          controller.abort(error);
        }
      }
      this.#inflight.clear();
      this.#rejectPending(closeError);
    }
  }
  /**
   * Send a request and wait for its response result.
   *
   * Request ids are generated as increasing numbers local to this peer. Rejected
   * JSON-RPC responses become `JsonRpcError` instances.
   */
  call(
    method: string,
    params?: unknown,
    opts: {
      /** Abort this call and notify the remote peer with `$/cancel_request`. */
      signal?: AbortSignal;
    } = {},
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new JsonRpcError('Connection closed', INTERNAL_ERROR));
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason);
    const id = ++this.#idSeq;
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      id,
    };
    if (params !== undefined) body.params = params;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        void this.notify('$/cancel_request', { requestId: id }).catch(() => {});
        reject(opts.signal!.reason);
      };
      const cleanup = () => opts.signal?.removeEventListener('abort', onAbort);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        cleanup,
      });
      Promise.resolve(this.#transport.send(JSON.stringify(body))).catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        reject(error);
      });
    });
  }
  /**
   * Send a notification.
   *
   * Notifications do not include an id, so no response is expected and remote
   * handler failures are not reported to this peer.
   */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) throw new JsonRpcError('Connection closed', INTERNAL_ERROR);
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
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
    if (!this.#closed) {
      this.#closed = true;
      this.#rejectPending(new JsonRpcError('Connection closed', INTERNAL_ERROR));
      for (const controller of this.#inflight.values()) {
        if (!controller.signal.aborted) {
          const error = new Error('JSON-RPC connection closed');
          error.name = 'AbortError';
          controller.abort(error);
        }
      }
      this.#inflight.clear();
    }
    if (!this.#transportClosed) {
      this.#transportClosed = true;
      await this.#transport.close();
    }
  }
}
// ---------------------------------------------------------------------------
// JsonRpcServer — serve a JsonRpcService over connections
// ---------------------------------------------------------------------------
/**
 * Options for serving JSON-RPC over HTTP.
 *
 * Passed to `JsonRpcServer.listen()` to control the bound port, host, and the URL
 * pathname that accepts JSON-RPC `POST` bodies. Requests to any other pathname
 * receive `404`.
 *
 * ```ts no_run
 * import { JsonRpcServer, JsonRpcService } from 'fino:jsonrpc';
 * import type { ListenOptions } from 'fino:jsonrpc';
 *
 * const opts: ListenOptions = { port: 0, host: '127.0.0.1', path: '/rpc' };
 * const handle = new JsonRpcServer(new JsonRpcService()).listen(opts);
 * await handle.ready;
 * ```
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
 *
 * Await `ready` before sending requests, read the resolved `port` (useful when
 * `0` was requested and an ephemeral port was assigned), and call `close()` to
 * shut the listener down.
 *
 * ```ts no_run
 * import { JsonRpcServer, JsonRpcService } from 'fino:jsonrpc';
 * import type { ServerHandle } from 'fino:jsonrpc';
 *
 * const handle: ServerHandle = new JsonRpcServer(new JsonRpcService())
 *   .listen({ port: 0, path: '/rpc' });
 * await handle.ready;
 * console.log(`listening on ${handle.port}`);
 * await handle.close();
 * ```
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
 *
 * The same server can drive an arbitrary `Transport` through `serve()` or spin up
 * a dedicated HTTP listener through `listen()`.
 *
 * ```ts no_run
 * import { JsonRpcServer, JsonRpcService } from 'fino:jsonrpc';
 *
 * const service = new JsonRpcService();
 * service.method('time.now').handle(() => Date.now());
 *
 * const server = new JsonRpcServer(service);
 * const handle = server.listen({ port: 3000, path: '/rpc' });
 * await handle.ready;
 * ```
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
    const inner: ServeServer = serveHttp(
      {
        port: opts.port,
        ...(opts.host ? { host: opts.host } : {}),
      },
      async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== path) return new Response('Not found', { status: 404 });
        return handler(req);
      },
    );
    return {
      get port() {
        return inner.port;
      },
      close: () => inner.close(),
      get ready() {
        return inner.ready;
      },
    };
  }
}
