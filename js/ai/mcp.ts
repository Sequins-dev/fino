/**
* fino:ai/mcp — Model Context Protocol client and server adapters for agents.
*
* Useful references:
*
* - Model Context Protocol: https://modelcontextprotocol.io/
* - Lifecycle: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
* - Streamable HTTP transport: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
* - Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
* - Resources: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
* - Prompts: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
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
* ## Current protocol coverage
*
* The implementation covers MCP 2025-06-18 initialization, tools, resources,
* resource templates, prompts, stdio-style transports, Streamable HTTP POST and
* GET SSE, client-side roots, sampling, elicitation handlers, cursor-aware
* list methods, list-change notifications, and resource subscriptions. OAuth
* and authorization policy stay with application middleware around the mounted
* endpoint.
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
import { JsonRpcPeer, JsonRpcError, JsonRpcService, JsonRpcServer, INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, PARSE_ERROR } from 'fino:jsonrpc';
import type { ListenOptions, ServerHandle, Transport } from 'fino:jsonrpc';
import type { ContentPart, ModelMessage } from 'fino:ai/model';
import { Tool } from 'fino:ai/tool';
import type { ToolRunContext } from 'fino:ai/tool';
import type { Task } from 'fino:task';
import { Process } from 'fino:process';
import { HttpClient } from 'fino:net/http/client';
import { parseEventStream } from 'fino:net/http/eventstream';
import { serveHttp } from 'fino:net/http/server';
import type { ServeServer } from 'fino:net/http/server';
import { Channel } from 'internal:stream';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = {
  name: 'fino',
  version: '0.1.0'
};
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
    ...opts.env ? { env: opts.env } : {},
    ...opts.cwd ? { cwd: opts.cwd } : {}
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
    }
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
async function drainSse(body: AsyncIterable<Uint8Array>, ch: Channel<string>, onEventId?: (id: string) => void): Promise<void> {
  try {
    for await (const event of parseEventStream(body)) {
      if (event.id) onEventId?.(event.id);
      if (event.data && event.data !== '[DONE]') await ch.writer.write(event.data);
    }
  } catch {}
}
/**
* Create an HTTP or SSE transport for an MCP server.
*/
export function httpTransport(opts: HttpTransportOptions): Transport {
  const ch = new Channel<string>();
  const client = new HttpClient({ baseUrl: opts.url });
  const extraHeaders = opts.headers ?? {};
  let sessionId: string | undefined;
  let lastEventId: string | undefined;
  let sseStarted = false;
  const openSse = (): void => {
    if (!opts.sseChannel || sseStarted || !sessionId) return;
    sseStarted = true;
    void (async () => {
      try {
        const res = await client.request('', {
          method: 'GET',
          headers: {
            accept: 'text/event-stream',
            'mcp-session-id': sessionId!,
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            ...lastEventId ? { 'last-event-id': lastEventId } : {},
            ...extraHeaders
          }
        });
        if (res.status === 200 && res.body) {
          await drainSse(res.body, ch, (id) => {
            lastEventId = id;
          });
        }
      } catch {} finally {
        sseStarted = false;
      }
    })();
  };
  return {
    async send(message: string): Promise<void> {
      const res = await client.request('', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          ...sessionId ? { 'mcp-session-id': sessionId } : {},
          ...extraHeaders
        },
        body: message
      });
      if (res.status < 200 || res.status >= 300) {
        throw new JsonRpcError(`HTTP ${res.status}`, INTERNAL_ERROR);
      }
      const nextSessionId = res.headers.get('mcp-session-id');
      if (nextSessionId) {
        sessionId = nextSessionId;
        openSse();
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (contentType === 'text/event-stream' && res.body) {
        // Server chose to stream the response as SSE — drain asynchronously
        void drainSse(res.body, ch, (id) => {
          lastEventId = id;
        });
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
    }
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
  roots?: McpRoot[] | (() => McpRoot[] | Promise<McpRoot[]>);
  sampling?: (params: McpSamplingRequest) => McpSamplingResult | Promise<McpSamplingResult>;
  elicitation?: (params: McpElicitationRequest) => McpElicitationResult | Promise<McpElicitationResult>;
  onToolsChanged?: () => void | Promise<void>;
  onResourcesChanged?: () => void | Promise<void>;
  onPromptsChanged?: () => void | Promise<void>;
  onResourceUpdated?: (uri: string) => void | Promise<void>;
}
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
interface McpCallResult {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}
/**
* Content part used by MCP prompts, sampling, and tool/resource responses.
*/
export type McpContent = {
  type: 'text';
  text: string;
} | {
  type: 'image';
  data: string;
  mimeType: string;
} | {
  type: 'resource';
  resource: McpResourceContent;
};
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
* Resource template descriptor returned by an MCP server.
*/
export interface McpResourceTemplate {
  uriTemplate: string;
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
* Prompt argument descriptor returned by an MCP server.
*/
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}
/**
* Prompt descriptor returned by an MCP server.
*/
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}
/**
* Prompt message returned by `getPrompt()`.
*/
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpContent;
}
/**
* Prompt content returned by `getPrompt()`.
*/
export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}
/**
* Root URI exposed by an MCP client.
*/
export interface McpRoot {
  uri: string;
  name?: string;
}
/**
* Server-initiated sampling request delivered to an MCP client.
*/
export interface McpSamplingRequest {
  messages: McpPromptMessage[];
  maxTokens?: number;
  systemPrompt?: string;
  includeContext?: string;
  temperature?: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
  modelPreferences?: Record<string, unknown>;
}
/**
* Sampling result returned by an MCP client.
*/
export interface McpSamplingResult {
  role: 'assistant' | 'user';
  content: McpContent;
  model?: string;
  stopReason?: string;
}
/**
* Server-initiated elicitation request delivered to an MCP client.
*/
export interface McpElicitationRequest {
  message: string;
  requestedSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
/**
* Elicitation result returned by an MCP client.
*/
export interface McpElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}
/**
* Cursor accepted by MCP list methods.
*/
export interface McpListParams {
  cursor?: string;
}
/**
* Optional MCP list cursor returned when more items are available.
*/
export interface McpListPage<T> {
  items: T[];
  nextCursor?: string;
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
  tools?: Task[] | ((params: McpListParams) => Task[] | McpListPage<Task> | Promise<Task[] | McpListPage<Task>>);
  /**
  * Static or lazy resource descriptors returned from `resources/list`.
  */
  resources?: McpResource[] | ((params: McpListParams) => McpResource[] | McpListPage<McpResource> | Promise<McpResource[] | McpListPage<McpResource>>);
  /**
  * Static or lazy resource templates returned from `resources/templates/list`.
  */
  resourceTemplates?: McpResourceTemplate[] | ((params: McpListParams) => McpResourceTemplate[] | McpListPage<McpResourceTemplate> | Promise<McpResourceTemplate[] | McpListPage<McpResourceTemplate>>);
  /**
  * Reader used by `resources/read`.
  *
  * Throw `JsonRpcError` for protocol failures, or return one or more content
  * objects for the requested URI.
  */
  readResource?: (uri: string, ctx: MCPServerContext) => McpResourceContent | McpResourceContent[] | Promise<McpResourceContent | McpResourceContent[]>;
  /**
  * Static or lazy prompt descriptors returned from `prompts/list`.
  */
  prompts?: McpPrompt[] | ((params: McpListParams) => McpPrompt[] | McpListPage<McpPrompt> | Promise<McpPrompt[] | McpListPage<McpPrompt>>);
  /**
  * Prompt renderer used by `prompts/get`.
  */
  getPrompt?: (name: string, args: Record<string, unknown>, ctx: MCPServerContext) => McpPromptResult | Promise<McpPromptResult>;
  /**
  * Streamable HTTP `Origin` policy.
  *
  * By default requests with no `Origin` are allowed and requests with an
  * `Origin` must match the request URL origin. Pass an allow-list or predicate
  * when mounting behind a trusted cross-origin gateway.
  */
  allowedOrigins?: string[] | ((origin: string, request: Request) => boolean | Promise<boolean>);
  /**
  * Advertise and emit MCP list-changed notifications.
  */
  listChanged?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
}
/**
* Minimal route target accepted by `mountMcp()`.
*
* `App` and `Router` both satisfy this shape.
*/
export interface MCPRouteTarget {
  /**
  * Start a GET method branch for the MCP endpoint.
  */
  get(path: string): MCPRouteMethod;
  /**
  * Start a POST method branch for the MCP endpoint.
  */
  post(path: string): MCPRouteMethod;
  /**
  * Start a DELETE method branch for the MCP endpoint.
  */
  delete(path: string): MCPRouteMethod;
}
/**
* Method branch returned by an `MCPRouteTarget` verb; `handle()` registers.
*/
export interface MCPRouteMethod {
  /**
  * Register the MCP endpoint handler for this method.
  */
  handle(handler: (ctx: {
    request: Request;
  }) => Response | Promise<Response>): unknown;
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
  return JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code,
      message
    },
    id
  });
}
function randomSessionId(): string {
  const cryptoLike = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
    };
  }).crypto;
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
  const unsafe = request as Request & {
    _getUnsafeHeader?: (name: string) => string | null;
  };
  return unsafe._getUnsafeHeader?.('origin') ?? null;
}
function contentPartsToMcpContent(content: string | ContentPart[]): McpContent[] {
  if (typeof content === 'string') return [{
    type: 'text',
    text: content
  }];
  const out: McpContent[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      out.push({
        type: 'text',
        text: part.text
      });
    } else if (part.type === 'image') {
      out.push({
        type: 'image',
        data: part.data,
        mimeType: part.mediaType
      });
    } else if (part.type === 'document') {
      out.push({
        type: 'resource',
        resource: {
          uri: part.name ? `document://${encodeURIComponent(part.name)}` : 'document://inline',
          mimeType: part.mediaType,
          blob: part.data
        }
      });
    }
  }
  if (out.length === 0) out.push({
    type: 'text',
    text: ''
  });
  return out;
}
function normalizeResourceContent(uri: string, value: McpResourceContent | McpResourceContent[]): McpResourceContent[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => ({
    ...item,
    uri: item.uri ?? uri
  }));
}
interface SseEvent {
  id: string;
  data: string;
}
interface McpConnectionRecord {
  id: string;
  peer?: JsonRpcPeer;
  outbox?: Channel<SseEvent>;
  outboxes: Set<Channel<SseEvent>>;
  replay: SseEvent[];
  subscriptions: Set<string>;
  closed: boolean;
  eventSeq: number;
}
function isPage<T>(value: T[] | McpListPage<T>): value is McpListPage<T> {
  return isRecord(value) && Array.isArray(value.items);
}
function pageResult<
  T,
  K extends string
>(key: K, value: T[] | McpListPage<T>): Record<K, T[]> & {
  nextCursor?: string;
} {
  const page = isPage(value) ? value : { items: value };
  return {
    [key]: page.items,
    ...page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}
  } as Record<K, T[]> & {
    nextCursor?: string;
  };
}
function parseListParams(params: unknown): McpListParams {
  if (params === undefined) return {};
  if (!isRecord(params)) throw new JsonRpcError('Invalid list params', INVALID_PARAMS);
  if (params.cursor !== undefined && typeof params.cursor !== 'string') {
    throw new JsonRpcError('Invalid list cursor', INVALID_PARAMS);
  }
  return params.cursor !== undefined ? { cursor: params.cursor } : {};
}
function ssePayload(event: SseEvent): Uint8Array {
  return new TextEncoder().encode(`id: ${event.id}\nevent: message\ndata: ${event.data}\n\n`);
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
  #tools: NonNullable<MCPServerOptions['tools']>;
  #resources: MCPServerOptions['resources'];
  #resourceTemplates: MCPServerOptions['resourceTemplates'];
  #readResource?: MCPServerOptions['readResource'];
  #prompts: MCPServerOptions['prompts'];
  #getPrompt?: MCPServerOptions['getPrompt'];
  #allowedOrigins?: MCPServerOptions['allowedOrigins'];
  #listChanged: NonNullable<MCPServerOptions['listChanged']>;
  #sessions = new Map<string, McpConnectionRecord>();
  #peers = new Set<McpConnectionRecord>();
  #terminatedSessions = new Set<string>();
  #sessionBySignal = new WeakMap<AbortSignal, string>();
  #recordBySignal = new WeakMap<AbortSignal, McpConnectionRecord>();
  constructor(opts: MCPServerOptions = {}) {
    this.#tools = opts.tools ?? [];
    this.#resources = opts.resources;
    this.#resourceTemplates = opts.resourceTemplates;
    this.#readResource = opts.readResource;
    this.#prompts = opts.prompts;
    this.#getPrompt = opts.getPrompt;
    this.#allowedOrigins = opts.allowedOrigins;
    this.#listChanged = opts.listChanged ?? {};
    const serverInfo = {
      name: opts.name ?? 'fino',
      version: opts.version ?? '0.1.0'
    };
    this.#service = new JsonRpcService().method('initialize').handle((params) => {
      const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      const result: Record<string, unknown> = {
        protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
        capabilities: this.#capabilities(),
        serverInfo
      };
      if (opts.instructions !== undefined) result.instructions = opts.instructions;
      return result;
    }).method('notifications/initialized').handle(() => undefined).method('tools/list').handle(async (params) => this.#toolsListResult(parseListParams(params))).method('tools/call').handle(async (params, ctx) => {
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
        }
      };
      const result = await selected.invoke(params.arguments ?? {}, toolCtx);
      return {
        content: contentPartsToMcpContent(result.content),
        ...result.isError !== undefined ? { isError: result.isError } : {}
      };
    }).method('resources/list').handle(async (params) => this.#resourcesListResult(parseListParams(params))).method('resources/templates/list').handle(async (params) => this.#resourceTemplatesListResult(parseListParams(params))).method('resources/read').handle(async (params, ctx) => {
      if (!isRecord(params) || typeof params.uri !== 'string') {
        throw new JsonRpcError('Invalid resources/read params', INVALID_PARAMS);
      }
      if (!this.#readResource) throw new JsonRpcError(`Unknown resource: ${params.uri}`, INVALID_PARAMS);
      const content = await this.#readResource(params.uri, {
        signal: ctx.signal,
        sessionId: this.#sessionBySignal.get(ctx.signal)
      });
      return { contents: normalizeResourceContent(params.uri, content) };
    }).method('resources/subscribe').handle((params, ctx) => {
      if (!isRecord(params) || typeof params.uri !== 'string') {
        throw new JsonRpcError('Invalid resources/subscribe params', INVALID_PARAMS);
      }
      const record = this.#recordBySignal.get(ctx.signal) ?? (this.#peers.size === 1 ? [...this.#peers][0] : undefined);
      if (record) record.subscriptions.add(params.uri);
      return {};
    }).method('resources/unsubscribe').handle((params, ctx) => {
      if (!isRecord(params) || typeof params.uri !== 'string') {
        throw new JsonRpcError('Invalid resources/unsubscribe params', INVALID_PARAMS);
      }
      const record = this.#recordBySignal.get(ctx.signal) ?? (this.#peers.size === 1 ? [...this.#peers][0] : undefined);
      if (record) record.subscriptions.delete(params.uri);
      return {};
    }).method('prompts/list').handle(async (params) => this.#promptsListResult(parseListParams(params))).method('prompts/get').handle(async (params, ctx) => {
      if (!isRecord(params) || typeof params.name !== 'string') {
        throw new JsonRpcError('Invalid prompts/get params', INVALID_PARAMS);
      }
      if (!this.#getPrompt) throw new JsonRpcError(`Unknown prompt: ${params.name}`, INVALID_PARAMS);
      return this.#getPrompt(params.name, isRecord(params.arguments) ? params.arguments : {}, {
        signal: ctx.signal,
        sessionId: this.#sessionBySignal.get(ctx.signal)
      });
    });
  }
  #capabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {};
    const toolsList = Array.isArray(this.#tools) ? this.#tools : [];
    if (toolsList.length > 0 || typeof this.#tools === 'function') capabilities.tools = this.#listChanged.tools ? { listChanged: true } : {};
    if (this.#resources !== undefined || this.#resourceTemplates !== undefined || this.#readResource !== undefined) capabilities.resources = {};
    if (capabilities.resources && this.#listChanged.resources) capabilities.resources = {
      listChanged: true,
      subscribe: true
    };
    if (this.#prompts !== undefined || this.#getPrompt !== undefined) capabilities.prompts = this.#listChanged.prompts ? { listChanged: true } : {};
    return capabilities;
  }
  async #listTools(params: McpListParams): Promise<Task[] | McpListPage<Task>> {
    return typeof this.#tools === 'function' ? await this.#tools(params) : this.#tools;
  }
  async #toolsListResult(params: McpListParams): Promise<{
    tools: McpToolDef[];
    nextCursor?: string;
  }> {
    const page = await this.#listTools(params);
    const normalized = isPage(page) ? page : { items: page };
    return {
      tools: normalized.items.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters
      })),
      ...normalized.nextCursor !== undefined ? { nextCursor: normalized.nextCursor } : {}
    };
  }
  async #listResources(params: McpListParams): Promise<McpResource[] | McpListPage<McpResource>> {
    const resources = typeof this.#resources === 'function' ? await this.#resources(params) : this.#resources;
    return resources ?? [];
  }
  async #resourcesListResult(params: McpListParams): Promise<{
    resources: McpResource[];
    nextCursor?: string;
  }> {
    return pageResult('resources', await this.#listResources(params));
  }
  async #listResourceTemplates(params: McpListParams): Promise<McpResourceTemplate[] | McpListPage<McpResourceTemplate>> {
    const templates = typeof this.#resourceTemplates === 'function' ? await this.#resourceTemplates(params) : this.#resourceTemplates;
    return templates ?? [];
  }
  async #resourceTemplatesListResult(params: McpListParams): Promise<{
    resourceTemplates: McpResourceTemplate[];
    nextCursor?: string;
  }> {
    return pageResult('resourceTemplates', await this.#listResourceTemplates(params));
  }
  async #listPrompts(params: McpListParams): Promise<McpPrompt[] | McpListPage<McpPrompt>> {
    const prompts = typeof this.#prompts === 'function' ? await this.#prompts(params) : this.#prompts;
    return prompts ?? [];
  }
  async #promptsListResult(params: McpListParams): Promise<{
    prompts: McpPrompt[];
    nextCursor?: string;
  }> {
    return pageResult('prompts', await this.#listPrompts(params));
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
    if (sessionId) {
      this.#sessionBySignal.set(signal, sessionId);
      const record = this.#sessions.get(sessionId);
      if (record) this.#recordBySignal.set(signal, record);
    }
    return this.#service.handle(JSON.stringify(message), signal);
  }
  #newRecord(id: string): McpConnectionRecord {
    return {
      id,
      outboxes: new Set(),
      replay: [],
      subscriptions: new Set(),
      closed: false,
      eventSeq: 0
    };
  }
  async #sendToRecord(record: McpConnectionRecord, method: string, params?: unknown): Promise<void> {
    if (record.closed) return;
    if (record.peer) {
      await record.peer.notify(method, params);
      return;
    }
    const event: SseEvent = {
      id: `${record.id}-${++record.eventSeq}`,
      data: JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...params !== undefined ? { params } : {}
      })
    };
    record.replay.push(event);
    if (record.replay.length > 32) record.replay.shift();
    const outbox = record.outbox ?? [...record.outboxes][0];
    if (outbox) await outbox.writer.write(event);
  }
  async #broadcast(method: string, params?: unknown, filter?: (record: McpConnectionRecord) => boolean): Promise<void> {
    const records = [...this.#sessions.values(), ...this.#peers];
    await Promise.all(records.filter((record) => !filter || filter(record)).map((record) => this.#sendToRecord(record, method, params)));
  }
  async #handleGet(request: Request): Promise<Response> {
    const id = request.headers.get('mcp-session-id');
    if (!id) return new Response('Missing Mcp-Session-Id', { status: 400 });
    const record = this.#sessions.get(id);
    if (!record || record.closed) return new Response('Unknown MCP session', { status: 404 });
    const accept = request.headers.get('accept') ?? '';
    if (!accept.includes('text/event-stream')) return new Response('Not acceptable', { status: 406 });
    const lastId = request.headers.get('last-event-id');
    const outbox = new Channel<SseEvent>();
    record.outbox = outbox;
    record.outboxes.add(outbox);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          try {
            const replay = lastId ? record.replay.slice(record.replay.findIndex((event) => event.id === lastId) + 1) : [];
            for (const event of replay) controller.enqueue(ssePayload(event));
            for await (const event of outbox.reader) {
              controller.enqueue(ssePayload(event));
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          } finally {
            record.outboxes.delete(outbox);
            if (record.outbox === outbox) record.outbox = [...record.outboxes][0];
          }
        })();
      },
      cancel: () => {
        record.outboxes.delete(outbox);
        if (record.outbox === outbox) record.outbox = [...record.outboxes][0];
        void outbox.writer.close();
      }
    });
    return new Response(stream, { headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    } });
  }
  async #handlePost(request: Request): Promise<Response> {
    let message: unknown;
    try {
      message = JSON.parse(await request.text());
    } catch {
      return new Response(jsonRpcError(PARSE_ERROR, 'Parse error'), { headers: { 'content-type': 'application/json' } });
    }
    if (Array.isArray(message) && message.some(isInitializeRequest)) {
      return new Response(jsonRpcError(INVALID_REQUEST, 'initialize cannot be batched'), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    const status = this.#sessionStatus(request, message);
    if (status === 'missing') return new Response('Missing Mcp-Session-Id', { status: 400 });
    if (status === 'unknown') return new Response('Unknown MCP session', { status: 404 });
    const sessionId = request.headers.get('mcp-session-id') ?? undefined;
    if (Array.isArray(message)) {
      if (!message.some(isRequest)) {
        await Promise.all(message.filter(isNotification).map((item) => this.#dispatchMessage(item, request.signal, sessionId)));
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
      this.#sessions.set(id, this.#newRecord(id));
      headers.set('mcp-session-id', id);
    }
    return new Response(response, { headers });
  }
  /**
  * Notify clients that the server tool list changed.
  */
  async notifyToolsChanged(): Promise<void> {
    if (!this.#listChanged.tools) return;
    await this.#broadcast('notifications/tools/list_changed');
  }
  /**
  * Notify clients that the server resource list changed.
  */
  async notifyResourcesChanged(): Promise<void> {
    if (!this.#listChanged.resources) return;
    await this.#broadcast('notifications/resources/list_changed');
  }
  /**
  * Notify clients that the server prompt list changed.
  */
  async notifyPromptsChanged(): Promise<void> {
    if (!this.#listChanged.prompts) return;
    await this.#broadcast('notifications/prompts/list_changed');
  }
  /**
  * Notify subscribed clients that a resource URI was updated.
  */
  async notifyResourceUpdated(uri: string): Promise<void> {
    await this.#broadcast('notifications/resources/updated', { uri }, (record) => record.subscriptions.has(uri));
  }
  /**
  * Serve this MCP endpoint over any JSON-RPC string transport.
  */
  async serve(transport: Transport): Promise<void> {
    const record = this.#newRecord(`transport-${randomSessionId()}`);
    const controller = new AbortController();
    this.#recordBySignal.set(controller.signal, record);
    const peer = new JsonRpcPeer(transport, this.#service, { signal: controller.signal });
    record.peer = peer;
    this.#peers.add(record);
    try {
      await peer.done;
    } finally {
      controller.abort();
      record.closed = true;
      this.#peers.delete(record);
    }
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
      if (request.method === 'GET') return this.#handleGet(request);
      if (request.method === 'DELETE') {
        const id = request.headers.get('mcp-session-id');
        if (!id) return new Response('Missing Mcp-Session-Id', { status: 400 });
        const record = this.#sessions.get(id);
        if (!record) return new Response('Unknown MCP session', { status: 404 });
        record.closed = true;
        await Promise.all([...record.outboxes].map((outbox) => outbox.writer.close()));
        this.#sessions.delete(id);
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
    const inner: ServeServer = serveHttp({
      port: opts.port,
      ...opts.host ? { host: opts.host } : {}
    }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== path) return new Response('Not found', { status: 404 });
      return handler(request);
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
  target.get(path).handle((ctx) => handler(ctx.request));
  target.post(path).handle((ctx) => handler(ctx.request));
  target.delete(path).handle((ctx) => handler(ctx.request));
  return target;
}
/**
* Client for MCP tools and resources.
*/
export class MCPClient {
  #peer: JsonRpcPeer;
  #connected = false;
  #opts: MCPClientOptions;
  #toolSetters = new Set<(items: Tool[]) => void>();
  #resourceSetters = new Set<(items: McpResource[]) => void>();
  #resourceTemplateSetters = new Set<(items: McpResourceTemplate[]) => void>();
  #promptSetters = new Set<(items: McpPrompt[]) => void>();
  #toolsSignal = lazy<Tool[]>([], (set) => {
    this.#toolSetters.add(set);
    void this.#refreshTools(set);
    return () => {
      this.#toolSetters.delete(set);
    };
  });
  #resourcesSignal = lazy<McpResource[]>([], (set) => {
    this.#resourceSetters.add(set);
    void this.#refreshResources(set);
    return () => {
      this.#resourceSetters.delete(set);
    };
  });
  #resourceTemplatesSignal = lazy<McpResourceTemplate[]>([], (set) => {
    this.#resourceTemplateSetters.add(set);
    void this.#refreshResourceTemplates(set);
    return () => {
      this.#resourceTemplateSetters.delete(set);
    };
  });
  #promptsSignal = lazy<McpPrompt[]>([], (set) => {
    this.#promptSetters.add(set);
    void this.#refreshPrompts(set);
    return () => {
      this.#promptSetters.delete(set);
    };
  });
  constructor(opts: MCPClientOptions) {
    this.#opts = opts;
    const service = new JsonRpcService().method('roots/list').handle(async (params) => {
      if (params !== undefined) throw new JsonRpcError('Invalid roots/list params', INVALID_PARAMS);
      const roots = typeof opts.roots === 'function' ? await opts.roots() : opts.roots;
      return { roots: roots ?? [] };
    }).method('sampling/createMessage').handle(async (params) => {
      if (!isRecord(params) || !Array.isArray(params.messages)) {
        throw new JsonRpcError('Invalid sampling params', INVALID_PARAMS);
      }
      if (!opts.sampling) throw new JsonRpcError('Sampling is not configured', INVALID_REQUEST);
      return await opts.sampling(params as McpSamplingRequest);
    }).method('elicitation/create').handle(async (params) => {
      if (!isRecord(params) || typeof params.message !== 'string') {
        throw new JsonRpcError('Invalid elicitation params', INVALID_PARAMS);
      }
      if (!opts.elicitation) throw new JsonRpcError('Elicitation is not configured', INVALID_REQUEST);
      return await opts.elicitation(params as McpElicitationRequest);
    }).method('notifications/tools/list_changed').handle(async () => {
      void this.#refreshTools();
      await opts.onToolsChanged?.();
    }).method('notifications/resources/list_changed').handle(async () => {
      void Promise.all([
        this.#refreshResources(),
        this.#refreshResourceTemplates()
      ]);
      await opts.onResourcesChanged?.();
    }).method('notifications/prompts/list_changed').handle(async () => {
      void this.#refreshPrompts();
      await opts.onPromptsChanged?.();
    }).method('notifications/resources/updated').handle(async (params) => {
      if (!isRecord(params) || typeof params.uri !== 'string') {
        throw new JsonRpcError('Invalid resource update params', INVALID_PARAMS);
      }
      await opts.onResourceUpdated?.(params.uri);
    });
    this.#peer = new JsonRpcPeer(opts.transport, service);
  }
  /** Retained first-page list of remote tools. */
  get tools(): ReadonlySignal<Tool[]> {
    return this.#toolsSignal;
  }
  /** Retained first-page list of remote resources. */
  get resources(): ReadonlySignal<McpResource[]> {
    return this.#resourcesSignal;
  }
  /** Retained first-page list of remote resource templates. */
  get resourceTemplates(): ReadonlySignal<McpResourceTemplate[]> {
    return this.#resourceTemplatesSignal;
  }
  /** Retained first-page list of remote prompts. */
  get prompts(): ReadonlySignal<McpPrompt[]> {
    return this.#promptsSignal;
  }
  async #refreshTools(one?: (items: Tool[]) => void): Promise<void> {
    if (!this.#connected) return;
    const items = await this.listTools();
    if (one) one(items);
    else for (const set of this.#toolSetters) set(items);
  }
  async #refreshResources(one?: (items: McpResource[]) => void): Promise<void> {
    if (!this.#connected) return;
    const items = await this.listResources();
    if (one) one(items);
    else for (const set of this.#resourceSetters) set(items);
  }
  async #refreshResourceTemplates(one?: (items: McpResourceTemplate[]) => void): Promise<void> {
    if (!this.#connected) return;
    const items = await this.listResourceTemplates();
    if (one) one(items);
    else for (const set of this.#resourceTemplateSetters) set(items);
  }
  async #refreshPrompts(one?: (items: McpPrompt[]) => void): Promise<void> {
    if (!this.#connected) return;
    const items = await this.listPrompts();
    if (one) one(items);
    else for (const set of this.#promptSetters) set(items);
  }
  async connect(): Promise<void> {
    const capabilities: Record<string, unknown> = {};
    if (this.#opts.roots !== undefined) capabilities.roots = {};
    if (this.#opts.sampling !== undefined) capabilities.sampling = {};
    if (this.#opts.elicitation !== undefined) capabilities.elicitation = {};
    await this.#peer.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities,
      clientInfo: CLIENT_INFO
    });
    await this.#peer.notify('notifications/initialized');
    this.#connected = true;
  }
  #assertConnected(): void {
    if (!this.#connected) throw new Error('MCPClient: call connect() first');
  }
  async listTools(params: McpListParams = {}): Promise<Tool[]> {
    return (await this.listToolsPage(params)).items;
  }
  /**
  * Return one MCP `tools/list` page with the server-provided cursor metadata.
  *
  * Use this when a remote server may paginate large tool lists. `listTools()`
  * remains the compatibility helper for one-page servers and returns only the
  * current page's `Tool` instances.
  */
  async listToolsPage(params: McpListParams = {}): Promise<McpListPage<Tool>> {
    this.#assertConnected();
    const result = await this.#peer.call('tools/list', params) as {
      tools?: McpToolDef[];
      nextCursor?: string;
    };
    const defs = result.tools ?? [];
    return {
      items: defs.map((def) => new Tool({
        name: def.name,
        description: def.description ?? '',
        parameters: def.inputSchema ?? {
          type: 'object',
          properties: {}
        },
        execute: async (args) => {
          const res = await this.#peer.call('tools/call', {
            name: def.name,
            arguments: args
          }) as McpCallResult;
          const text = res.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
          if (res.isError) return {
            content: text,
            isError: true
          };
          return text;
        }
      })),
      ...result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}
    };
  }
  async listResources(params: McpListParams = {}): Promise<McpResource[]> {
    return (await this.listResourcesPage(params)).items;
  }
  /**
  * Return one MCP `resources/list` page with cursor metadata.
  */
  async listResourcesPage(params: McpListParams = {}): Promise<McpListPage<McpResource>> {
    this.#assertConnected();
    const result = await this.#peer.call('resources/list', params) as {
      resources?: McpResource[];
      nextCursor?: string;
    };
    return {
      items: result.resources ?? [],
      ...result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}
    };
  }
  async listResourceTemplates(params: McpListParams = {}): Promise<McpResourceTemplate[]> {
    return (await this.listResourceTemplatesPage(params)).items;
  }
  /**
  * Return one MCP `resources/templates/list` page with cursor metadata.
  */
  async listResourceTemplatesPage(params: McpListParams = {}): Promise<McpListPage<McpResourceTemplate>> {
    this.#assertConnected();
    const result = await this.#peer.call('resources/templates/list', params) as {
      resourceTemplates?: McpResourceTemplate[];
      nextCursor?: string;
    };
    return {
      items: result.resourceTemplates ?? [],
      ...result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}
    };
  }
  async readResource(uri: string): Promise<McpResourceContent[]> {
    this.#assertConnected();
    const result = await this.#peer.call('resources/read', { uri }) as {
      contents?: McpResourceContent[];
    };
    return result.contents ?? [];
  }
  async listPrompts(params: McpListParams = {}): Promise<McpPrompt[]> {
    return (await this.listPromptsPage(params)).items;
  }
  /**
  * Return one MCP `prompts/list` page with cursor metadata.
  */
  async listPromptsPage(params: McpListParams = {}): Promise<McpListPage<McpPrompt>> {
    this.#assertConnected();
    const result = await this.#peer.call('prompts/list', params) as {
      prompts?: McpPrompt[];
      nextCursor?: string;
    };
    return {
      items: result.prompts ?? [],
      ...result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}
    };
  }
  async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<McpPromptResult> {
    this.#assertConnected();
    return await this.#peer.call('prompts/get', {
      name,
      arguments: args
    }) as McpPromptResult;
  }
  async subscribeResource(uri: string): Promise<void> {
    this.#assertConnected();
    await this.#peer.call('resources/subscribe', { uri });
  }
  async unsubscribeResource(uri: string): Promise<void> {
    this.#assertConnected();
    await this.#peer.call('resources/unsubscribe', { uri });
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
