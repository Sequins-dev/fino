/**
 * fino:ai/mcp — Model Context Protocol client and server adapters for agents.
 *
 * Useful references:
 *
 * - Model Context Protocol: https://modelcontextprotocol.io/
 * - Lifecycle: https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle
 * - Streamable HTTP transport: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * - Tools: https://modelcontextprotocol.io/specification/2025-03-26/server/tools
 * - Resources: https://modelcontextprotocol.io/specification/2025-03-26/server/resources
 *
 * `MCPClient` connects to an MCP server, performs the initialize handshake,
 * lists remote tools and resources, and converts remote MCP tools into Fino
 * `Tool` instances that can be passed directly to an `Agent`. `MCPServer`
 * exposes local Fino tools and resources to MCP-compatible clients over stdio,
 * custom transports, or a Streamable HTTP endpoint.
 *
 * ## Protocol model
 *
 * Transports are intentionally small: a transport only sends JSON-RPC strings,
 * receives JSON-RPC strings, and closes. The bundled transports cover stdio
 * server processes and HTTP/SSE endpoints; applications can provide custom
 * transports for embedded servers, test peers, or nonstandard deployment
 * environments.
 *
 * The server API is endpoint-first. Mount `server.httpHandler()` in an
 * application router when you need auth, CORS, logging, sessions, or other
 * middleware around the MCP endpoint. `listen()` is only a convenience wrapper
 * for local tools and tests; it should not replace the application router in a
 * composed service.
 *
 * ## Implemented subset
 *
 * The server implements MCP 2025-03-26 initialization, tools, resources, stdio
 * style transports, and non-streaming Streamable HTTP. HTTP GET SSE streams,
 * prompts, resource templates, subscriptions, sampling, and list-changed
 * notifications are intentionally left to future focused APIs.
 *
 * ```ts no_run
 * import { App } from 'fino:net/http/app';
 * import { mcpServer, mountMcp } from 'fino:ai/mcp';
 * import { tool } from 'fino:ai/tool';
 * import { v } from 'fino:validate';
 *
 * const server = mcpServer({
 *   name: 'support-tools',
 *   tools: [tool({
 *     name: 'lookup_ticket',
 *     description: 'Look up a support ticket by id.',
 *     parameters: v.object({ id: v.string().describe('Support ticket id') }),
 *     execute: async ({ id }: { id: string }) => `ticket:${id}`,
 *   })],
 * });
 *
 * const app = new App();
 * mountMcp(app, '/mcp', server);
 * ```
 */

import {
  JsonRpcPeer,
  JsonRpcError,
  JsonRpcService,
  JsonRpcServer,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
} from 'fino:jsonrpc';
import type { ListenOptions, ServerHandle, Transport } from 'fino:jsonrpc';
import type { ContentPart, ModelMessage } from 'fino:ai/model';
import { Tool } from 'fino:ai/tool';
import type { ToolRunContext } from 'fino:ai/tool';
import { Process } from 'fino:process';
import { HttpClient } from 'fino:net/http/client';
import { parseEventStream } from 'fino:net/http/eventstream';
import { serveHttp } from 'fino:net/http/server';
import type { ServeServer } from 'fino:net/http/server';
import { Channel } from 'internal:stream';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'fino', version: '0.1.0' };

export type { Transport };

// ---------------------------------------------------------------------------
// stdioTransport
// ---------------------------------------------------------------------------

/**
 * Options for launching an MCP server over stdio.
 */
export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

async function* splitLines(source: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of source) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop()!;
    for (const line of parts) {
      const t = line.trim();
      if (t) yield t;
    }
  }
  if (buf.trim()) yield buf.trim();
}

/**
 * Create a stdio transport for an MCP server process.
 */
export function stdioTransport(opts: StdioTransportOptions): Transport {
  const proc = new Process(opts.command, opts.args ?? [], {
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const enc = new TextEncoder();

  return {
    async send(message: string): Promise<void> {
      await proc.stdin.write(enc.encode(message + '\n'));
    },
    receive(): AsyncIterable<string> {
      return splitLines(proc.stdout);
    },
    async close(): Promise<void> {
      proc.stdin.close();
    },
  };
}

// ---------------------------------------------------------------------------
// httpTransport
// ---------------------------------------------------------------------------

/**
 * Options for connecting to an MCP server over HTTP.
 */
export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  /**
   * Open a GET SSE channel to receive server-initiated messages.
   */
  sseChannel?: boolean;
}

async function drainSse(body: AsyncIterable<Uint8Array>, ch: Channel<string>): Promise<void> {
  try {
    for await (const event of parseEventStream(body)) {
      if (event.data && event.data !== '[DONE]') await ch.writer.write(event.data);
    }
  } catch {
    // SSE channel closed — not an error
  }
}

/**
 * Create an HTTP or SSE transport for an MCP server.
 */
export function httpTransport(opts: HttpTransportOptions): Transport {
  const ch = new Channel<string>();
  const client = new HttpClient({ baseUrl: opts.url });
  const extraHeaders = opts.headers ?? {};

  // Optional GET SSE channel for server-initiated messages
  if (opts.sseChannel) {
    void (async () => {
      try {
        const res = await client.request('', {
          method: 'GET',
          headers: { accept: 'text/event-stream', ...extraHeaders },
        });
        if (res.status === 200 && res.body) {
          await drainSse(res.body, ch);
        }
      } catch {
        // Server doesn't support GET SSE channel — silently ignore
      }
    })();
  }

  return {
    async send(message: string): Promise<void> {
      const res = await client.request('', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...extraHeaders,
        },
        body: message,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new JsonRpcError(`HTTP ${res.status}`, INTERNAL_ERROR);
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (contentType === 'text/event-stream' && res.body) {
        // Server chose to stream the response as SSE — drain asynchronously
        void drainSse(res.body, ch);
      } else {
        const text = await res.text();
        if (text.trim()) await ch.writer.write(text.trim());
      }
    },
    receive(): AsyncIterable<string> {
      return ch.reader;
    },
    close(): void {
      void ch.writer.close();
    },
  };
}

// ---------------------------------------------------------------------------
// MCPClient
// ---------------------------------------------------------------------------

/**
 * Options for `MCPClient`.
 */
export interface MCPClientOptions {
  transport: Transport;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: McpResourceContent };

/**
 * Resource descriptor returned by an MCP server.
 */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/**
 * Resource content returned from `readResource()`.
 */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/**
 * Context passed to MCP server resource readers.
 */
export interface MCPServerContext {
  /**
   * Abort signal for the current MCP request.
   */
  signal: AbortSignal;
  /**
   * Streamable HTTP session id when the request arrived over HTTP.
   *
   * Custom and stdio transports do not create HTTP sessions, so this is absent
   * for those calls.
   */
  sessionId?: string;
}

/**
 * Options for exposing local Fino capabilities as an MCP server.
 */
export interface MCPServerOptions {
  /**
   * Implementation name returned from `initialize`.
   */
  name?: string;
  /**
   * Implementation version returned from `initialize`.
   */
  version?: string;
  /**
   * Optional human-readable guidance returned from `initialize`.
   */
  instructions?: string;
  /**
   * Local Fino tools exposed through MCP `tools/list` and `tools/call`.
   */
  tools?: Tool[];
  /**
   * Static or lazy resource descriptors returned from `resources/list`.
   */
  resources?: McpResource[] | (() => McpResource[] | Promise<McpResource[]>);
  /**
   * Reader used by `resources/read`.
   *
   * Throw `JsonRpcError` for protocol failures, or return one or more content
   * objects for the requested URI.
   */
  readResource?: (
    uri: string,
    ctx: MCPServerContext,
  ) => McpResourceContent | McpResourceContent[] | Promise<McpResourceContent | McpResourceContent[]>;
  /**
   * Streamable HTTP `Origin` policy.
   *
   * By default requests with no `Origin` are allowed and requests with an
   * `Origin` must match the request URL origin. Pass an allow-list or predicate
   * when mounting behind a trusted cross-origin gateway.
   */
  allowedOrigins?: string[] | ((origin: string, request: Request) => boolean | Promise<boolean>);
}

/**
 * Minimal route target accepted by `mountMcp()`.
 *
 * `App` and `Router` both satisfy this shape.
 */
export interface MCPRouteTarget {
  /**
   * Register a GET handler for the MCP endpoint.
   */
  get(path: string, handler: (ctx: { request: Request }) => Response | Promise<Response>): unknown;
  /**
   * Register a POST handler for the MCP endpoint.
   */
  post(path: string, handler: (ctx: { request: Request }) => Response | Promise<Response>): unknown;
  /**
   * Register a DELETE handler for the MCP endpoint.
   */
  delete(path: string, handler: (ctx: { request: Request }) => Response | Promise<Response>): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInitializeRequest(value: unknown): boolean {
  return isRecord(value) && value.method === 'initialize' && 'id' in value;
}

function isRequest(value: unknown): boolean {
  return isRecord(value) && typeof value.method === 'string' && 'id' in value;
}

function isNotification(value: unknown): boolean {
  return isRecord(value) && typeof value.method === 'string' && !('id' in value);
}

function jsonRpcError(code: number, message: string, id: unknown = null): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

function randomSessionId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sameOrigin(request: Request, origin: string): boolean {
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function requestOrigin(request: Request): string | null {
  const visible = request.headers.get('origin');
  if (visible) return visible;
  const unsafe = request as Request & { _getUnsafeHeader?: (name: string) => string | null };
  return unsafe._getUnsafeHeader?.('origin') ?? null;
}

function contentPartsToMcpContent(content: string | ContentPart[]): McpContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: McpContent[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      out.push({ type: 'image', data: part.data, mimeType: part.mediaType });
    } else if (part.type === 'document') {
      out.push({
        type: 'resource',
        resource: {
          uri: part.name ? `document://${encodeURIComponent(part.name)}` : 'document://inline',
          mimeType: part.mediaType,
          blob: part.data,
        },
      });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

function normalizeResourceContent(
  uri: string,
  value: McpResourceContent | McpResourceContent[],
): McpResourceContent[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => ({ ...item, uri: item.uri ?? uri }));
}

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

/**
 * MCP server backed by local Fino tools and resources.
 *
 * Use `serve()` for stdio or custom transports, `httpHandler()` for a
 * Streamable HTTP route, or `listen()` for small standalone tools. HTTP
 * sessions are tracked in memory and are scoped to this server instance.
 */
export class MCPServer {
  #service: JsonRpcService;
  #tools: Tool[];
  #resources: MCPServerOptions['resources'];
  #readResource?: MCPServerOptions['readResource'];
  #allowedOrigins?: MCPServerOptions['allowedOrigins'];
  #sessions = new Set<string>();
  #terminatedSessions = new Set<string>();
  #sessionBySignal = new WeakMap<AbortSignal, string>();

  constructor(opts: MCPServerOptions = {}) {
    this.#tools = opts.tools ?? [];
    this.#resources = opts.resources;
    this.#readResource = opts.readResource;
    this.#allowedOrigins = opts.allowedOrigins;

    const serverInfo = { name: opts.name ?? 'fino', version: opts.version ?? '0.1.0' };
    this.#service = new JsonRpcService()
      .method('initialize').handle((params) => {
        const requested = isRecord(params) && typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : MCP_PROTOCOL_VERSION;
        const result: Record<string, unknown> = {
          protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
          capabilities: this.#capabilities(),
          serverInfo,
        };
        if (opts.instructions !== undefined) result.instructions = opts.instructions;
        return result;
      })
      .method('notifications/initialized').handle(() => undefined)
      .method('tools/list').handle(() => ({
        tools: this.#tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
      }))
      .method('tools/call').handle(async (params, ctx) => {
        if (!isRecord(params) || typeof params.name !== 'string') {
          throw new JsonRpcError('Invalid tools/call params', INVALID_PARAMS);
        }
        const selected = this.#tools.find((tool) => tool.name === params.name);
        if (!selected) throw new JsonRpcError(`Unknown tool: ${params.name}`, INVALID_PARAMS);
        const toolCtx: ToolRunContext = {
          signal: ctx.signal,
          toolCallId: typeof ctx.id === 'string' || typeof ctx.id === 'number' ? String(ctx.id) : params.name,
          step: 0,
          runId: this.#sessionBySignal.get(ctx.signal) ?? 'mcp',
          messages: [] satisfies ModelMessage[],
          suspend(suspendOpts = {}): never {
            throw new Error(suspendOpts.reason ?? 'Tool suspended');
          },
        };
        const result = await selected.invoke(params.arguments ?? {}, toolCtx);
        return {
          content: contentPartsToMcpContent(result.content),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      })
      .method('resources/list').handle(async () => ({
        resources: await this.#listResources(),
      }))
      .method('resources/read').handle(async (params, ctx) => {
        if (!isRecord(params) || typeof params.uri !== 'string') {
          throw new JsonRpcError('Invalid resources/read params', INVALID_PARAMS);
        }
        if (!this.#readResource) throw new JsonRpcError(`Unknown resource: ${params.uri}`, INVALID_PARAMS);
        const content = await this.#readResource(params.uri, {
          signal: ctx.signal,
          sessionId: this.#sessionBySignal.get(ctx.signal),
        });
        return { contents: normalizeResourceContent(params.uri, content) };
      });
  }

  #capabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {};
    if (this.#tools.length > 0) capabilities.tools = {};
    if (this.#resources !== undefined || this.#readResource !== undefined) capabilities.resources = {};
    return capabilities;
  }

  async #listResources(): Promise<McpResource[]> {
    const resources = typeof this.#resources === 'function'
      ? await this.#resources()
      : this.#resources;
    return resources ?? [];
  }

  async #originAllowed(request: Request): Promise<boolean> {
    const origin = requestOrigin(request);
    if (!origin) return true;
    if (Array.isArray(this.#allowedOrigins)) return this.#allowedOrigins.includes(origin);
    if (typeof this.#allowedOrigins === 'function') return this.#allowedOrigins(origin, request);
    return sameOrigin(request, origin);
  }

  #sessionStatus(request: Request, message: unknown): 'ok' | 'missing' | 'unknown' {
    if (isInitializeRequest(message)) return 'ok';
    const sessionId = request.headers.get('mcp-session-id');
    if (!sessionId) return 'missing';
    if (this.#sessions.has(sessionId)) return 'ok';
    return 'unknown';
  }

  async #dispatchMessage(message: unknown, signal: AbortSignal, sessionId?: string): Promise<string | null> {
    if (sessionId) this.#sessionBySignal.set(signal, sessionId);
    return this.#service.handle(JSON.stringify(message), signal);
  }

  async #handlePost(request: Request): Promise<Response> {
    let message: unknown;
    try {
      message = JSON.parse(await request.text());
    } catch {
      return new Response(jsonRpcError(PARSE_ERROR, 'Parse error'), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (Array.isArray(message) && message.some(isInitializeRequest)) {
      return new Response(jsonRpcError(INVALID_REQUEST, 'initialize cannot be batched'), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const status = this.#sessionStatus(request, message);
    if (status === 'missing') return new Response('Missing Mcp-Session-Id', { status: 400 });
    if (status === 'unknown') return new Response('Unknown MCP session', { status: 404 });

    const sessionId = request.headers.get('mcp-session-id') ?? undefined;
    if (Array.isArray(message)) {
      if (!message.some(isRequest)) {
        await Promise.all(message.filter(isNotification).map((item) =>
          this.#dispatchMessage(item, request.signal, sessionId)
        ));
        return new Response(null, { status: 202 });
      }
      const responses: string[] = [];
      for (const item of message) {
        const response = await this.#dispatchMessage(item, request.signal, sessionId);
        if (response !== null) responses.push(response);
      }
      return new Response(`[${responses.join(',')}]`, { headers: { 'content-type': 'application/json' } });
    }

    if (!isRequest(message)) {
      if (isNotification(message)) await this.#dispatchMessage(message, request.signal, sessionId);
      return new Response(null, { status: 202 });
    }

    const initializing = isInitializeRequest(message);
    const response = await this.#dispatchMessage(message, request.signal, sessionId);
    if (response === null) return new Response(null, { status: 202 });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (initializing) {
      const id = randomSessionId();
      this.#sessions.add(id);
      headers.set('mcp-session-id', id);
    }
    return new Response(response, { headers });
  }

  /**
   * Serve this MCP endpoint over any JSON-RPC string transport.
   */
  async serve(transport: Transport): Promise<void> {
    await new JsonRpcServer(this.#service).serve(transport);
  }

  /**
   * Create a Streamable HTTP handler for this MCP endpoint.
   *
   * Mount the returned handler on one path for `GET`, `POST`, and `DELETE`.
   * This non-streaming implementation returns `405` for `GET` because it does
   * not yet offer an independent SSE channel.
   */
  httpHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      if (!await this.#originAllowed(request)) return new Response('Forbidden', { status: 403 });
      if (request.method === 'POST') return this.#handlePost(request);
      if (request.method === 'GET') return new Response('SSE streams are not supported', { status: 405 });
      if (request.method === 'DELETE') {
        const id = request.headers.get('mcp-session-id');
        if (!id) return new Response('Missing Mcp-Session-Id', { status: 400 });
        if (!this.#sessions.delete(id)) return new Response('Unknown MCP session', { status: 404 });
        this.#terminatedSessions.add(id);
        return new Response(null, { status: 202 });
      }
      return new Response('Method not allowed', { status: 405 });
    };
  }

  /**
   * Start a small standalone HTTP MCP server.
   *
   * Prefer mounting `httpHandler()` into `fino:net/http/app` for production
   * services so application middleware controls authentication and policy.
   */
  listen(opts: ListenOptions): ServerHandle {
    const path = opts.path ?? '/';
    const handler = this.httpHandler();
    const inner: ServeServer = serveHttp(
      { port: opts.port, ...(opts.host ? { host: opts.host } : {}) },
      async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== path) return new Response('Not found', { status: 404 });
        return handler(request);
      },
    );
    return {
      get port() { return inner.port; },
      close: () => inner.close(),
      get ready() { return inner.ready; },
    };
  }
}

/**
 * Create an MCP server from local Fino tools and resource readers.
 */
export function mcpServer(opts: MCPServerOptions = {}): MCPServer {
  return new MCPServer(opts);
}

/**
 * Mount an MCP server on a Fino `App` or `Router`.
 *
 * The target's middleware remains responsible for authentication,
 * authorization, logging, and rate limiting around the MCP endpoint.
 */
export function mountMcp(target: MCPRouteTarget, path: string, server: MCPServer): MCPRouteTarget {
  const handler = server.httpHandler();
  target.get(path, (ctx) => handler(ctx.request));
  target.post(path, (ctx) => handler(ctx.request));
  target.delete(path, (ctx) => handler(ctx.request));
  return target;
}

/**
 * Client for MCP tools and resources.
 */
export class MCPClient {
  #peer: JsonRpcPeer;
  #connected = false;

  constructor(opts: MCPClientOptions) {
    this.#peer = new JsonRpcPeer(opts.transport);
  }

  async connect(): Promise<void> {
    await this.#peer.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await this.#peer.notify('notifications/initialized');
    this.#connected = true;
  }

  #assertConnected(): void {
    if (!this.#connected) throw new Error('MCPClient: call connect() first');
  }

  async listTools(): Promise<Tool[]> {
    this.#assertConnected();
    const result = await this.#peer.call('tools/list') as { tools?: McpToolDef[] };
    const defs = result.tools ?? [];
    return defs.map((def) => new Tool({
      name: def.name,
      description: def.description ?? '',
      parameters: def.inputSchema ?? { type: 'object', properties: {} },
      execute: async (args) => {
        const res = await this.#peer.call('tools/call', { name: def.name, arguments: args }) as McpCallResult;
        const text = res.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        if (res.isError) return { content: text, isError: true };
        return text;
      },
    }));
  }

  async listResources(): Promise<McpResource[]> {
    this.#assertConnected();
    const result = await this.#peer.call('resources/list') as { resources?: McpResource[] };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<McpResourceContent[]> {
    this.#assertConnected();
    const result = await this.#peer.call('resources/read', { uri }) as { contents?: McpResourceContent[] };
    return result.contents ?? [];
  }

  async close(): Promise<void> {
    await this.#peer.close();
  }
}

/**
 * Create an `MCPClient`.
 */
export function mcpClient(opts: MCPClientOptions): MCPClient {
  return new MCPClient(opts);
}
