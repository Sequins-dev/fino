import { serveHttp } from 'fino:net/http/server';
import type { ServeServer } from 'fino:net/http/server';
import { compile } from 'fino:validate';
import type { JsonSchema, SchemaBuilder } from 'fino:validate';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export class JsonRpcError extends Error {
  code: number;
  data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export interface Transport {
  send(message: string): void | Promise<void>;
  receive(): AsyncIterable<string>;
  close(): void | Promise<void>;
}

export interface RequestContext {
  id: number | string | null | undefined;
  signal: AbortSignal;
}

export type JsonRpcHandler = (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;

export interface MethodMeta {
  description?: string;
  params?: JsonSchema | SchemaBuilder;
}

// ---------------------------------------------------------------------------
// JsonRpcService — structured method registry and single-message dispatcher
// ---------------------------------------------------------------------------

type MethodEntry = { handler: JsonRpcHandler; meta: MethodMeta };

class MethodBuilder {
  #commit: (handler: JsonRpcHandler, meta: MethodMeta) => JsonRpcService;
  #meta: MethodMeta = {};

  constructor(commit: (handler: JsonRpcHandler, meta: MethodMeta) => JsonRpcService) {
    this.#commit = commit;
  }

  description(desc: string): this {
    this.#meta = { ...this.#meta, description: desc };
    return this;
  }

  params(schema: JsonSchema | SchemaBuilder): this {
    this.#meta = { ...this.#meta, params: schema };
    return this;
  }

  handle(fn: JsonRpcHandler): JsonRpcService {
    return this.#commit(fn, this.#meta);
  }
}

export class JsonRpcService {
  #methods = new Map<string, MethodEntry>();

  method(name: string): MethodBuilder {
    return new MethodBuilder((handler, meta) => {
      this.#methods.set(name, { handler, meta });
      return this;
    });
  }

  list(): Array<{ name: string; description?: string; params?: Record<string, unknown> }> {
    return Array.from(this.#methods.entries()).map(([name, { meta }]) => ({
      name,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.params !== undefined ? { params: meta.params } : {}),
    }));
  }

  async handle(raw: string, signal?: AbortSignal): Promise<string | null> {
    const sig = signal ?? new AbortController().signal;

    let msg: unknown;
    try { msg = JSON.parse(raw); }
    catch { return JSON.stringify({ jsonrpc: '2.0', error: { code: PARSE_ERROR, message: 'Parse error' }, id: null }); }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return JSON.stringify({ jsonrpc: '2.0', error: { code: INVALID_REQUEST, message: 'Invalid request' }, id: null });
    }

    const m = msg as Record<string, unknown>;
    if (typeof m.method !== 'string') {
      return JSON.stringify({ jsonrpc: '2.0', error: { code: INVALID_REQUEST, message: 'Invalid request' }, id: null });
    }

    const id = 'id' in m ? m.id as number | string | null : undefined;
    const entry = this.#methods.get(m.method);

    if (!entry) {
      if (id != null) {
        return JSON.stringify({ jsonrpc: '2.0', error: { code: METHOD_NOT_FOUND, message: `Method not found: ${m.method}` }, id });
      }
      return null;
    }

    if (entry.meta.params !== undefined) {
      const check = compile(entry.meta.params).safeParse(m.params);
      if (!check.success) {
        if (id == null) return null;
        return JSON.stringify({ jsonrpc: '2.0', error: { code: INVALID_PARAMS, message: 'Invalid params', data: check.issues }, id });
      }
    }

    // Notification (no id) — fire and forget
    if (id === undefined) {
      void Promise.resolve(entry.handler(m.params, { id: undefined, signal: sig })).catch(() => {});
      return null;
    }

    try {
      const result = await entry.handler(m.params, { id, signal: sig });
      return JSON.stringify({ jsonrpc: '2.0', result, id });
    } catch (err: unknown) {
      const code = err instanceof JsonRpcError ? err.code : INTERNAL_ERROR;
      const data = err instanceof JsonRpcError ? err.data : undefined;
      return JSON.stringify({
        jsonrpc: '2.0',
        error: { code, message: String(err), ...(data !== undefined ? { data } : {}) },
        id,
      });
    }
  }

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

export class JsonRpcPeer {
  #transport: Transport;
  #service: JsonRpcService | null;
  #signal?: AbortSignal;
  #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  #idSeq = 0;
  #closed = false;
  #readLoop: Promise<void>;

  constructor(transport: Transport, service?: JsonRpcService, opts: { signal?: AbortSignal } = {}) {
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
        try { msg = JSON.parse(raw); } catch { continue; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
        const m = msg as Record<string, unknown>;

        if (('result' in m || 'error' in m) && 'id' in m) {
          const id = m.id as number;
          const p = this.#pending.get(id);
          if (!p) continue;
          this.#pending.delete(id);
          if ('error' in m) {
            const e = m.error as Record<string, unknown>;
            p.reject(new JsonRpcError(
              (e.message as string) ?? 'Unknown error',
              (e.code as number) ?? INTERNAL_ERROR,
              e.data,
            ));
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

  call(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#idSeq;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, id };
    if (params !== undefined) body.params = params;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      Promise.resolve(this.#transport.send(JSON.stringify(body))).catch(reject);
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    await this.#transport.send(JSON.stringify(body));
  }

  get done(): Promise<void> {
    return this.#readLoop;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#transport.close();
  }
}

// ---------------------------------------------------------------------------
// JsonRpcServer — serve a JsonRpcService over connections
// ---------------------------------------------------------------------------

export interface ListenOptions {
  port: number;
  host?: string;
  path?: string;
}

export interface ServerHandle {
  readonly port: number;
  close(): Promise<void>;
  readonly ready: Promise<void>;
}

export class JsonRpcServer {
  #service: JsonRpcService;

  constructor(service: JsonRpcService) {
    this.#service = service;
  }

  async serve(transport: Transport): Promise<void> {
    for await (const raw of transport.receive()) {
      const response = await this.#service.handle(raw);
      if (response !== null) await transport.send(response);
    }
  }

  listen(opts: ListenOptions): ServerHandle {
    const path = opts.path ?? '/';
    const handler = this.#service.httpHandler();
    const inner: ServeServer = serveHttp(
      { port: opts.port, ...(opts.host ? { host: opts.host } : {}) },
      async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== path) return new Response('Not found', { status: 404 });
        return handler(req);
      },
    );

    return {
      get port() { return inner.port; },
      close: () => inner.close(),
      get ready() { return inner.ready; },
    };
  }
}
