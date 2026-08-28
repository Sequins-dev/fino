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
  version: '0.1.0',
};
/**
 * Re-export of the JSON-RPC `Transport` interface from `fino:jsonrpc`.
 *
 * An MCP transport only sends JSON-RPC strings, yields received strings, and
 * closes. `stdioTransport()` and `httpTransport()` are the bundled
 * implementations; supply a custom object with the same three members for
 * in-memory peers, embedded servers, or tests.
 */
export type { Transport };
// ---------------------------------------------------------------------------
// stdioTransport
// ---------------------------------------------------------------------------
/**
 * Options for launching an MCP server over stdio.
 *
 * The command is spawned as a child process and JSON-RPC messages travel as
 * newline-delimited JSON over its stdin/stdout, matching the MCP stdio
 * transport convention.
 *
 * ```ts no_run
 * import { stdioTransport } from 'fino:ai/mcp';
 *
 * const transport = stdioTransport({
 *   command: 'mcp-filesystem',
 *   args: ['--root', '/srv/data'],
 *   env: { LOG_LEVEL: 'warn' },
 *   cwd: '/srv',
 * });
 * ```
 */
export interface StdioTransportOptions {
  /**
   * Executable to spawn.
   */
  command: string;
  /**
   * Arguments passed to the executable.
   */
  args?: string[];
  /**
   * Environment variables for the child process.
   */
  env?: Record<string, string>;
  /**
   * Working directory for the child process.
   */
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
 *
 * The process is spawned immediately. Each `send()` writes one
 * newline-terminated JSON-RPC message to the child's stdin, and `receive()`
 * yields non-empty lines from its stdout. `close()` closes the child's stdin —
 * the conventional shutdown signal for stdio MCP servers, which are expected
 * to exit once their input ends.
 *
 * ```ts no_run
 * import { MCPClient, stdioTransport } from 'fino:ai/mcp';
 *
 * const client = new MCPClient({
 *   transport: stdioTransport({
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/data'],
 *   }),
 * });
 * await client.connect();
 * const tools = await client.listTools();
 * ```
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
      await proc.stdin.flush();
    },
    receive(): AsyncIterable<string> {
      return splitLines(proc.stdout);
    },
    async close(): Promise<void> {
      await proc.stdin.close();
    },
  };
}
// ---------------------------------------------------------------------------
// httpTransport
// ---------------------------------------------------------------------------
/**
 * Options for connecting to an MCP server over HTTP.
 *
 * ```ts no_run
 * import { httpTransport } from 'fino:ai/mcp';
 *
 * const transport = httpTransport({
 *   url: 'https://tools.example.com/mcp',
 *   headers: { authorization: 'Bearer <token>' },
 *   sseChannel: true,
 * });
 * ```
 */
export interface HttpTransportOptions {
  /**
   * MCP endpoint URL; every JSON-RPC message is POSTed here.
   */
  url: string;
  /**
   * Extra headers sent on every request — typically authorization.
   */
  headers?: Record<string, string>;
  /**
   * Open a GET SSE channel to receive server-initiated messages.
   *
   * The channel opens only after the server issues an `Mcp-Session-Id`, and
   * resumes with `Last-Event-ID` when the stream drops.
   */
  sseChannel?: boolean;
}
async function drainSse(
  body: AsyncIterable<Uint8Array>,
  ch: Channel<string>,
  onEventId?: (id: string) => void,
): Promise<void> {
  try {
    for await (const event of parseEventStream(body)) {
      if (event.id) onEventId?.(event.id);
      if (event.data && event.data !== '[DONE]') await ch.writer.write(event.data);
    }
  } catch {}
}
/**
 * Create a Streamable HTTP transport for an MCP server.
 *
 * Every outgoing message is POSTed to the endpoint with the MCP protocol
 * version header. When a response carries an `Mcp-Session-Id` header the
 * transport pins that session id on all subsequent requests and, if
 * `sseChannel` is set, opens a GET `text/event-stream` channel for
 * server-initiated messages. Servers may answer a POST with either a JSON body
 * or an SSE stream; both are folded into the single `receive()` iterable.
 *
 * Throws `JsonRpcError` from `send()` when the endpoint responds with a
 * non-2xx status.
 *
 * ```ts no_run
 * import { MCPClient, httpTransport } from 'fino:ai/mcp';
 *
 * const client = new MCPClient({
 *   transport: httpTransport({
 *     url: 'https://tools.example.com/mcp',
 *     headers: { authorization: 'Bearer <token>' },
 *     sseChannel: true,
 *   }),
 * });
 * await client.connect();
 * ```
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
            ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
            ...extraHeaders,
          },
        });
        if (res.status === 200 && res.body) {
          await drainSse(res.body, ch, (id) => {
            lastEventId = id;
          });
        }
      } catch {
      } finally {
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
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...extraHeaders,
        },
        body: message,
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
    },
  };
}

// ---------------------------------------------------------------------------
// sseTransport (legacy MCP HTTP+SSE)
// ---------------------------------------------------------------------------
/** Minimal HTTP response consumed by the injectable legacy SSE request effect. */
export interface SseHttpResponse {
  /** HTTP status code. */
  status: number;
  /** Streaming response body, when present. */
  body: AsyncIterable<Uint8Array> | null;
}
/** Injectable HTTP effect used by the legacy SSE transport. */
export type SseHttpRequest = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<SseHttpResponse>;
/** Options for the deprecated MCP HTTP+SSE transport used by ACP v1. */
export interface SseTransportOptions {
  /** URL whose GET response is the MCP event stream. */
  url: string;
  /** Extra headers sent with the event-stream GET and message POSTs. */
  headers?: Record<string, string>;
  /** Injectable HTTP request effect for simulation and custom networking policy. */
  request?: SseHttpRequest;
  /** Cleanup paired with an injected `request` effect. */
  close?(): void | Promise<void>;
}

/**
 * Create the legacy MCP HTTP+SSE client transport.
 *
 * The transport opens `opts.url` as an event stream, waits for its required
 * `endpoint` event, POSTs outgoing JSON-RPC messages to that endpoint, and
 * yields `message` event payloads to `MCPClient`. ACP v1 still negotiates this
 * transport even though newer MCP revisions deprecate it in favor of
 * Streamable HTTP.
 */
export function sseTransport(opts: SseTransportOptions): Transport {
  const ch = new Channel<string>();
  const headers = opts.headers ?? {};
  const httpClient = opts.request ? null : new HttpClient();
  const request: SseHttpRequest = opts.request ?? ((url, init) => httpClient!.request(url, init));
  let endpointResolve!: (endpoint: string) => void;
  let endpointReject!: (error: unknown) => void;
  let endpointSettled = false;
  let closed = false;
  let body: (AsyncIterable<Uint8Array> & { close?(): Promise<void> | void }) | null = null;
  const endpoint = new Promise<string>((resolve, reject) => {
    endpointResolve = resolve;
    endpointReject = reject;
  });
  void endpoint.catch(() => {});
  void (async () => {
    try {
      const response = await request(opts.url, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...headers,
        },
      });
      if (response.status < 200 || response.status >= 300 || !response.body) {
        throw new JsonRpcError(`SSE HTTP ${response.status}`, INTERNAL_ERROR);
      }
      body = response.body as typeof body;
      for await (const event of parseEventStream(response.body)) {
        if (closed) break;
        if (event.type === 'endpoint') {
          if (!endpointSettled) {
            endpointSettled = true;
            endpointResolve(new URL(event.data, opts.url).toString());
          }
        } else if (event.type === 'message' && event.data) {
          await ch.writer.write(event.data);
        }
      }
      if (!closed && !endpointSettled) {
        throw new JsonRpcError('MCP SSE stream closed before endpoint event', INTERNAL_ERROR);
      }
    } catch (error) {
      if (!endpointSettled) {
        endpointSettled = true;
        endpointReject(error);
      }
    } finally {
      await ch.writer.close();
    }
  })();
  return {
    async send(message: string): Promise<void> {
      if (closed) throw new JsonRpcError('MCP SSE transport is closed', INTERNAL_ERROR);
      const messageUrl = await endpoint;
      const response = await request(messageUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: message,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new JsonRpcError(`SSE message HTTP ${response.status}`, INTERNAL_ERROR);
      }
    },
    receive(): AsyncIterable<string> {
      return ch.reader;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (!endpointSettled) {
        endpointSettled = true;
        endpointReject(new JsonRpcError('MCP SSE transport is closed', INTERNAL_ERROR));
      }
      await body?.close?.();
      await ch.writer.close();
      await Promise.all([httpClient?.close(), opts.close?.()]);
    },
  };
}
// ---------------------------------------------------------------------------
// MCPClient
// ---------------------------------------------------------------------------
/**
 * Options for `MCPClient`.
 *
 * Only `transport` is required. Providing `roots`, `sampling`, or
 * `elicitation` also advertises the matching client capability during the
 * `initialize` handshake so the server knows it may call back; a server that
 * calls an unconfigured handler receives a JSON-RPC error. The `on*` callbacks
 * observe server notifications after the client has already scheduled a
 * refresh of its retained list signals.
 *
 * ```ts no_run
 * import { MCPClient, httpTransport } from 'fino:ai/mcp';
 *
 * const client = new MCPClient({
 *   transport: httpTransport({ url: 'https://tools.example.com/mcp' }),
 *   roots: [{ uri: 'file:///srv/project', name: 'project' }],
 *   elicitation: async ({ message }) => ({ action: 'decline' }),
 *   onToolsChanged: () => console.log('remote tool list changed'),
 * });
 * ```
 */
export interface MCPClientOptions {
  /**
   * Transport used to exchange JSON-RPC messages with the server.
   */
  transport: Transport;
  /**
   * Root URIs, or a provider for them, answered to server `roots/list` calls.
   */
  roots?: McpRoot[] | (() => McpRoot[] | Promise<McpRoot[]>);
  /**
   * Handler for server-initiated `sampling/createMessage` requests.
   */
  sampling?: (params: McpSamplingRequest) => McpSamplingResult | Promise<McpSamplingResult>;
  /**
   * Handler for server-initiated `elicitation/create` requests.
   */
  elicitation?: (
    params: McpElicitationRequest,
  ) => McpElicitationResult | Promise<McpElicitationResult>;
  /**
   * Called after the server signals that its tool list changed.
   */
  onToolsChanged?: () => void | Promise<void>;
  /**
   * Called after the server signals that its resource list changed.
   */
  onResourcesChanged?: () => void | Promise<void>;
  /**
   * Called after the server signals that its prompt list changed.
   */
  onPromptsChanged?: () => void | Promise<void>;
  /**
   * Called when a resource URI subscribed via `subscribeResource()` updates.
   */
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
 *
 * `text` carries plain text, `image` carries base64-encoded data with a MIME
 * type, and `resource` embeds a full `McpResourceContent` object inline.
 */
export type McpContent =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      data: string;
      mimeType: string;
    }
  | {
      type: 'resource';
      resource: McpResourceContent;
    };
/**
 * Resource descriptor returned by an MCP server.
 *
 * Descriptors identify what a server can serve; pass the `uri` to
 * `MCPClient.readResource()` to fetch the content itself.
 *
 * ```ts no_run
 * const resources = await client.listResources();
 * for (const res of resources) {
 *   console.log(res.uri, res.mimeType ?? 'unknown type');
 * }
 * ```
 */
export interface McpResource {
  /**
   * Unique URI identifying the resource.
   */
  uri: string;
  /**
   * Human-readable resource name.
   */
  name?: string;
  /**
   * Description of what the resource contains.
   */
  description?: string;
  /**
   * MIME type of the resource content.
   */
  mimeType?: string;
}
/**
 * Resource template descriptor returned by an MCP server.
 *
 * Templates describe parameterized URIs (RFC 6570) that clients expand
 * themselves before calling `readResource()`.
 *
 * ```ts no_run
 * const templates = await client.listResourceTemplates();
 * const uri = templates[0].uriTemplate.replace('{name}', 'report');
 * const contents = await client.readResource(uri);
 * ```
 */
export interface McpResourceTemplate {
  /**
   * RFC 6570 URI template, e.g. `file:///data/{name}.txt`.
   */
  uriTemplate: string;
  /**
   * Human-readable template name.
   */
  name?: string;
  /**
   * Description of the resources the template expands to.
   */
  description?: string;
  /**
   * MIME type shared by resources matching the template.
   */
  mimeType?: string;
}
/**
 * Resource content returned from `readResource()`.
 *
 * A content object carries either `text` (for textual resources) or `blob`
 * (base64-encoded binary), not both.
 *
 * ```ts no_run
 * const [content] = await client.readResource('file:///data/report.txt');
 * if (content.text !== undefined) console.log(content.text);
 * ```
 */
export interface McpResourceContent {
  /**
   * URI of the resource this content belongs to.
   */
  uri: string;
  /**
   * MIME type of the content.
   */
  mimeType?: string;
  /**
   * Textual content, when the resource is text.
   */
  text?: string;
  /**
   * Base64-encoded binary content, when the resource is binary.
   */
  blob?: string;
}
/**
 * Prompt argument descriptor returned by an MCP server.
 *
 * ```ts no_run
 * const [prompt] = await client.listPrompts();
 * const required = (prompt.arguments ?? []).filter((arg) => arg.required);
 * ```
 */
export interface McpPromptArgument {
  /**
   * Argument name, used as a key in the `getPrompt()` args object.
   */
  name: string;
  /**
   * Description of what the argument controls.
   */
  description?: string;
  /**
   * Whether the argument must be supplied to `getPrompt()`.
   */
  required?: boolean;
}
/**
 * Prompt descriptor returned by an MCP server.
 *
 * Descriptors come from `listPrompts()`; render one into messages with
 * `getPrompt()`.
 *
 * ```ts no_run
 * const prompts = await client.listPrompts();
 * const summarize = prompts.find((p) => p.name === 'summarize');
 * ```
 */
export interface McpPrompt {
  /**
   * Prompt name passed to `getPrompt()`.
   */
  name: string;
  /**
   * Description of what the prompt produces.
   */
  description?: string;
  /**
   * Arguments the prompt accepts.
   */
  arguments?: McpPromptArgument[];
}
/**
 * Prompt message returned by `getPrompt()`.
 *
 * ```ts no_run
 * const { messages } = await client.getPrompt('summarize', { text: '...' });
 * for (const msg of messages) {
 *   if (msg.content.type === 'text') console.log(msg.role, msg.content.text);
 * }
 * ```
 */
export interface McpPromptMessage {
  /**
   * Conversation role the message belongs to.
   */
  role: 'user' | 'assistant';
  /**
   * Message content part.
   */
  content: McpContent;
}
/**
 * Prompt content returned by `getPrompt()`.
 *
 * ```ts no_run
 * const result = await client.getPrompt('summarize', { text: 'long text' });
 * console.log(result.description, result.messages.length);
 * ```
 */
export interface McpPromptResult {
  /**
   * Description of the rendered prompt.
   */
  description?: string;
  /**
   * Rendered conversation messages, ready to feed to a model.
   */
  messages: McpPromptMessage[];
}
/**
 * Root URI exposed by an MCP client.
 *
 * Roots tell a server which locations the client considers in scope. They are
 * served to the peer when it calls `roots/list`.
 *
 * ```ts no_run
 * const client = new MCPClient({
 *   transport,
 *   roots: [{ uri: 'file:///srv/project', name: 'project' }],
 * });
 * ```
 */
export interface McpRoot {
  /**
   * Root URI, typically a `file://` URL.
   */
  uri: string;
  /**
   * Human-readable root name.
   */
  name?: string;
}
/**
 * Server-initiated sampling request delivered to an MCP client.
 *
 * Sampling lets a server borrow the client's model access: the server sends a
 * conversation and generation parameters, and the client's `sampling` handler
 * decides whether and how to run the completion.
 *
 * ```ts no_run
 * const client = new MCPClient({
 *   transport,
 *   sampling: async (req) => {
 *     const answer = await runModel(req.messages, { maxTokens: req.maxTokens });
 *     return { role: 'assistant', content: { type: 'text', text: answer } };
 *   },
 * });
 * ```
 */
export interface McpSamplingRequest {
  /**
   * Conversation to complete.
   */
  messages: McpPromptMessage[];
  /**
   * Maximum tokens the server wants generated.
   */
  maxTokens?: number;
  /**
   * System prompt requested by the server.
   */
  systemPrompt?: string;
  /**
   * How much MCP context to include, per the MCP sampling spec.
   */
  includeContext?: string;
  /**
   * Requested sampling temperature.
   */
  temperature?: number;
  /**
   * Sequences that should stop generation.
   */
  stopSequences?: string[];
  /**
   * Provider-specific metadata passed through unchanged.
   */
  metadata?: Record<string, unknown>;
  /**
   * Model selection hints from the server.
   */
  modelPreferences?: Record<string, unknown>;
}
/**
 * Sampling result returned by an MCP client.
 *
 * ```ts no_run
 * const result: McpSamplingResult = {
 *   role: 'assistant',
 *   content: { type: 'text', text: 'Paris is the capital of France.' },
 *   model: 'gpt-4o',
 *   stopReason: 'endTurn',
 * };
 * ```
 */
export interface McpSamplingResult {
  /**
   * Role of the generated message.
   */
  role: 'assistant' | 'user';
  /**
   * Generated content.
   */
  content: McpContent;
  /**
   * Name of the model that produced the completion.
   */
  model?: string;
  /**
   * Why generation stopped.
   */
  stopReason?: string;
}
/**
 * Server-initiated elicitation request delivered to an MCP client.
 *
 * Elicitation lets a server ask the user for structured input mid-operation.
 * The client's `elicitation` handler surfaces the message, collects a
 * response, and reports whether the user accepted, declined, or cancelled.
 *
 * ```ts no_run
 * const client = new MCPClient({
 *   transport,
 *   elicitation: async ({ message }) => {
 *     const email = await askUser(message);
 *     if (email === null) return { action: 'cancel' };
 *     return { action: 'accept', content: { email } };
 *   },
 * });
 * ```
 */
export interface McpElicitationRequest {
  /**
   * Human-readable request to show the user.
   */
  message: string;
  /**
   * JSON schema the accepted `content` should conform to.
   */
  requestedSchema?: Record<string, unknown>;
  /**
   * Provider-specific metadata passed through unchanged.
   */
  metadata?: Record<string, unknown>;
}
/**
 * Elicitation result returned by an MCP client.
 *
 * ```ts no_run
 * const accepted: McpElicitationResult = {
 *   action: 'accept',
 *   content: { email: 'user@example.com' },
 * };
 * ```
 */
export interface McpElicitationResult {
  /**
   * Whether the user accepted, declined, or cancelled the request.
   */
  action: 'accept' | 'decline' | 'cancel';
  /**
   * User-provided values when the action is `accept`.
   */
  content?: Record<string, unknown>;
}
/**
 * Cursor accepted by MCP list methods.
 *
 * Pass the `nextCursor` from a previous `McpListPage` to fetch the following
 * page; omit it to start from the beginning.
 *
 * ```ts no_run
 * let cursor: string | undefined;
 * do {
 *   const page = await client.listToolsPage(cursor ? { cursor } : {});
 *   use(page.items);
 *   cursor = page.nextCursor;
 * } while (cursor !== undefined);
 * ```
 */
export interface McpListParams {
  /**
   * Opaque cursor from a previous page's `nextCursor`.
   */
  cursor?: string;
}
/**
 * One page of an MCP list result.
 *
 * `nextCursor` is present only when more items are available; feed it back as
 * `McpListParams.cursor` to continue. Server option callbacks (`tools`,
 * `resources`, `prompts`, ...) may also return this shape to serve paginated
 * lists.
 *
 * ```ts no_run
 * const page = await client.listResourcesPage();
 * if (page.nextCursor !== undefined) {
 *   const more = await client.listResourcesPage({ cursor: page.nextCursor });
 * }
 * ```
 */
export interface McpListPage<T> {
  /**
   * Items in this page.
   */
  items: T[];
  /**
   * Cursor for the next page, absent on the final page.
   */
  nextCursor?: string;
}
/**
 * Context passed to MCP server resource readers and prompt renderers.
 *
 * ```ts no_run
 * const server = mcpServer({
 *   readResource: async (uri, ctx) => {
 *     const text = await loadDocument(uri, ctx.signal);
 *     return { uri, mimeType: 'text/plain', text };
 *   },
 * });
 * ```
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
 *
 * Every capability is optional; the server only advertises what is configured.
 * `tools`, `resources`, `resourceTemplates`, and `prompts` accept either a
 * static array or a callback receiving `McpListParams`, which allows
 * cursor-based pagination by returning an `McpListPage`.
 *
 * ```ts no_run
 * import { mcpServer } from 'fino:ai/mcp';
 * import { tool } from 'fino:ai/tool';
 * import { v } from 'fino:validate';
 *
 * const server = mcpServer({
 *   name: 'docs',
 *   instructions: 'Read-only access to project documentation.',
 *   tools: [tool({
 *     name: 'search_docs',
 *     description: 'Search documentation by keyword.',
 *     parameters: v.object({ query: v.string().describe('Search query') }),
 *     execute: async ({ query }: { query: string }) => searchDocs(query),
 *   })],
 *   resources: [{ uri: 'doc://readme', name: 'README', mimeType: 'text/markdown' }],
 *   readResource: (uri) => ({ uri, mimeType: 'text/markdown', text: loadDoc(uri) }),
 *   listChanged: { tools: true, resources: true },
 * });
 * ```
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
  tools?:
    | Task[]
    | ((params: McpListParams) => Task[] | McpListPage<Task> | Promise<Task[] | McpListPage<Task>>);
  /**
   * Static or lazy resource descriptors returned from `resources/list`.
   */
  resources?:
    | McpResource[]
    | ((
        params: McpListParams,
      ) =>
        | McpResource[]
        | McpListPage<McpResource>
        | Promise<McpResource[] | McpListPage<McpResource>>);
  /**
   * Static or lazy resource templates returned from `resources/templates/list`.
   */
  resourceTemplates?:
    | McpResourceTemplate[]
    | ((
        params: McpListParams,
      ) =>
        | McpResourceTemplate[]
        | McpListPage<McpResourceTemplate>
        | Promise<McpResourceTemplate[] | McpListPage<McpResourceTemplate>>);
  /**
   * Reader used by `resources/read`.
   *
   * Throw `JsonRpcError` for protocol failures, or return one or more content
   * objects for the requested URI.
   */
  readResource?: (
    uri: string,
    ctx: MCPServerContext,
  ) =>
    | McpResourceContent
    | McpResourceContent[]
    | Promise<McpResourceContent | McpResourceContent[]>;
  /**
   * Static or lazy prompt descriptors returned from `prompts/list`.
   */
  prompts?:
    | McpPrompt[]
    | ((
        params: McpListParams,
      ) => McpPrompt[] | McpListPage<McpPrompt> | Promise<McpPrompt[] | McpListPage<McpPrompt>>);
  /**
   * Prompt renderer used by `prompts/get`.
   */
  getPrompt?: (
    name: string,
    args: Record<string, unknown>,
    ctx: MCPServerContext,
  ) => McpPromptResult | Promise<McpPromptResult>;
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
 * `App` and `Router` from `fino:net/http/app` both satisfy this shape, so MCP
 * endpoints can be mounted at the application root or inside a nested router
 * with its own middleware stack.
 *
 * ```ts no_run
 * import { App } from 'fino:net/http/app';
 * import { mcpServer, mountMcp } from 'fino:ai/mcp';
 *
 * const app = new App();
 * mountMcp(app, '/mcp', mcpServer({ name: 'tools' }));
 * ```
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
 *
 * This mirrors the fluent `app.get(path).handle(fn)` route-registration shape
 * of `fino:net/http/app`, so `mountMcp()` can register the same handler for
 * each HTTP method without depending on the full router API.
 *
 * ```ts no_run
 * const handler = server.httpHandler();
 * app.post('/mcp').handle((ctx) => handler(ctx.request));
 * ```
 */
export interface MCPRouteMethod {
  /**
   * Register the MCP endpoint handler for this method.
   */
  handle(handler: (ctx: { request: Request }) => Response | Promise<Response>): unknown;
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
      message,
    },
    id,
  });
}
function randomSessionId(): string {
  const cryptoLike = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
      };
    }
  ).crypto;
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
  if (typeof content === 'string')
    return [
      {
        type: 'text',
        text: content,
      },
    ];
  const out: McpContent[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      out.push({
        type: 'text',
        text: part.text,
      });
    } else if (part.type === 'image') {
      out.push({
        type: 'image',
        data: part.data,
        mimeType: part.mediaType,
      });
    } else if (part.type === 'audio') {
      out.push({
        type: 'resource',
        resource: {
          uri: 'audio://inline',
          mimeType: part.mediaType,
          blob: part.data,
        },
      });
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
  if (out.length === 0)
    out.push({
      type: 'text',
      text: '',
    });
  return out;
}
function normalizeResourceContent(
  uri: string,
  value: McpResourceContent | McpResourceContent[],
): McpResourceContent[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => ({
    ...item,
    uri: item.uri ?? uri,
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
function pageResult<T, K extends string>(
  key: K,
  value: T[] | McpListPage<T>,
): Record<K, T[]> & {
  nextCursor?: string;
} {
  const page = isPage(value) ? value : { items: value };
  return {
    [key]: page.items,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
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
 * sessions are tracked in memory and are scoped to this server instance, so a
 * load-balanced deployment must pin clients to the instance that created
 * their session.
 *
 * Tool calls dispatch to `Tool.invoke()` with a synthetic run context whose
 * `suspend()` throws — MCP has no suspension protocol, so suspendable tools
 * fail the call instead of pausing. Tool results are converted from Fino
 * content parts to MCP content (text, image, and document-as-resource parts).
 *
 * ```ts no_run
 * import { MCPServer } from 'fino:ai/mcp';
 * import { tool } from 'fino:ai/tool';
 * import { v } from 'fino:validate';
 *
 * const server = new MCPServer({
 *   name: 'support-tools',
 *   tools: [tool({
 *     name: 'lookup_ticket',
 *     description: 'Look up a support ticket by id.',
 *     parameters: v.object({ id: v.string().describe('Ticket id') }),
 *     execute: async ({ id }: { id: string }) => `ticket:${id}`,
 *   })],
 * });
 *
 * const handle = server.listen({ port: 8080, path: '/mcp' });
 * await handle.ready;
 * ```
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
  /**
   * Create an MCP server from the given capabilities.
   *
   * The advertised MCP capabilities are derived from which options are
   * present: configuring `tools` advertises tools, any of `resources` /
   * `resourceTemplates` / `readResource` advertises resources, and `prompts` /
   * `getPrompt` advertises prompts. `listChanged` flags add the corresponding
   * `listChanged` (and, for resources, `subscribe`) capability markers.
   */
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
      version: opts.version ?? '0.1.0',
    };
    this.#service = new JsonRpcService()
      .method('initialize')
      .handle((params) => {
        const requested =
          isRecord(params) && typeof params.protocolVersion === 'string'
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
      .method('notifications/initialized')
      .handle(() => undefined)
      .method('tools/list')
      .handle(async (params) => this.#toolsListResult(parseListParams(params)))
      .method('tools/call')
      .handle(async (params, ctx) => {
        if (!isRecord(params) || typeof params.name !== 'string') {
          throw new JsonRpcError('Invalid tools/call params', INVALID_PARAMS);
        }
        const selected = this.#tools.find((tool) => tool.name === params.name);
        if (!selected) throw new JsonRpcError(`Unknown tool: ${params.name}`, INVALID_PARAMS);
        const toolCtx: ToolRunContext = {
          signal: ctx.signal,
          toolCallId:
            typeof ctx.id === 'string' || typeof ctx.id === 'number' ? String(ctx.id) : params.name,
          step: 0,
          runId: this.#sessionBySignal.get(ctx.connectionSignal ?? ctx.signal) ?? 'mcp',
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
      .method('resources/list')
      .handle(async (params) => this.#resourcesListResult(parseListParams(params)))
      .method('resources/templates/list')
      .handle(async (params) => this.#resourceTemplatesListResult(parseListParams(params)))
      .method('resources/read')
      .handle(async (params, ctx) => {
        if (!isRecord(params) || typeof params.uri !== 'string') {
          throw new JsonRpcError('Invalid resources/read params', INVALID_PARAMS);
        }
        if (!this.#readResource)
          throw new JsonRpcError(`Unknown resource: ${params.uri}`, INVALID_PARAMS);
        const content = await this.#readResource(params.uri, {
          signal: ctx.signal,
          sessionId: this.#sessionBySignal.get(ctx.connectionSignal ?? ctx.signal),
        });
        return { contents: normalizeResourceContent(params.uri, content) };
      })
      .method('resources/subscribe')
      .handle((params, ctx) => {
        if (!isRecord(params) || typeof params.uri !== 'string') {
          throw new JsonRpcError('Invalid resources/subscribe params', INVALID_PARAMS);
        }
        const record =
          this.#recordBySignal.get(ctx.connectionSignal ?? ctx.signal) ??
          (this.#peers.size === 1 ? [...this.#peers][0] : undefined);
        if (record) record.subscriptions.add(params.uri);
        return {};
      })
      .method('resources/unsubscribe')
      .handle((params, ctx) => {
        if (!isRecord(params) || typeof params.uri !== 'string') {
          throw new JsonRpcError('Invalid resources/unsubscribe params', INVALID_PARAMS);
        }
        const record =
          this.#recordBySignal.get(ctx.connectionSignal ?? ctx.signal) ??
          (this.#peers.size === 1 ? [...this.#peers][0] : undefined);
        if (record) record.subscriptions.delete(params.uri);
        return {};
      })
      .method('prompts/list')
      .handle(async (params) => this.#promptsListResult(parseListParams(params)))
      .method('prompts/get')
      .handle(async (params, ctx) => {
        if (!isRecord(params) || typeof params.name !== 'string') {
          throw new JsonRpcError('Invalid prompts/get params', INVALID_PARAMS);
        }
        if (!this.#getPrompt)
          throw new JsonRpcError(`Unknown prompt: ${params.name}`, INVALID_PARAMS);
        return this.#getPrompt(params.name, isRecord(params.arguments) ? params.arguments : {}, {
          signal: ctx.signal,
          sessionId: this.#sessionBySignal.get(ctx.connectionSignal ?? ctx.signal),
        });
      });
  }
  #capabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {};
    const toolsList = Array.isArray(this.#tools) ? this.#tools : [];
    if (toolsList.length > 0 || typeof this.#tools === 'function')
      capabilities.tools = this.#listChanged.tools ? { listChanged: true } : {};
    if (
      this.#resources !== undefined ||
      this.#resourceTemplates !== undefined ||
      this.#readResource !== undefined
    )
      capabilities.resources = {};
    if (capabilities.resources && this.#listChanged.resources)
      capabilities.resources = {
        listChanged: true,
        subscribe: true,
      };
    if (this.#prompts !== undefined || this.#getPrompt !== undefined)
      capabilities.prompts = this.#listChanged.prompts ? { listChanged: true } : {};
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
        inputSchema: tool.parameters,
      })),
      ...(normalized.nextCursor !== undefined ? { nextCursor: normalized.nextCursor } : {}),
    };
  }
  async #listResources(params: McpListParams): Promise<McpResource[] | McpListPage<McpResource>> {
    const resources =
      typeof this.#resources === 'function' ? await this.#resources(params) : this.#resources;
    return resources ?? [];
  }
  async #resourcesListResult(params: McpListParams): Promise<{
    resources: McpResource[];
    nextCursor?: string;
  }> {
    return pageResult('resources', await this.#listResources(params));
  }
  async #listResourceTemplates(
    params: McpListParams,
  ): Promise<McpResourceTemplate[] | McpListPage<McpResourceTemplate>> {
    const templates =
      typeof this.#resourceTemplates === 'function'
        ? await this.#resourceTemplates(params)
        : this.#resourceTemplates;
    return templates ?? [];
  }
  async #resourceTemplatesListResult(params: McpListParams): Promise<{
    resourceTemplates: McpResourceTemplate[];
    nextCursor?: string;
  }> {
    return pageResult('resourceTemplates', await this.#listResourceTemplates(params));
  }
  async #listPrompts(params: McpListParams): Promise<McpPrompt[] | McpListPage<McpPrompt>> {
    const prompts =
      typeof this.#prompts === 'function' ? await this.#prompts(params) : this.#prompts;
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
  async #dispatchMessage(
    message: unknown,
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<string | null> {
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
      eventSeq: 0,
    };
  }
  async #sendToRecord(
    record: McpConnectionRecord,
    method: string,
    params?: unknown,
  ): Promise<void> {
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
        ...(params !== undefined ? { params } : {}),
      }),
    };
    record.replay.push(event);
    if (record.replay.length > 32) record.replay.shift();
    const outbox = record.outbox ?? [...record.outboxes][0];
    if (outbox) await outbox.writer.write(event);
  }
  async #broadcast(
    method: string,
    params?: unknown,
    filter?: (record: McpConnectionRecord) => boolean,
  ): Promise<void> {
    const records = [...this.#sessions.values(), ...this.#peers];
    await Promise.all(
      records
        .filter((record) => !filter || filter(record))
        .map((record) => this.#sendToRecord(record, method, params)),
    );
  }
  async #handleGet(request: Request): Promise<Response> {
    const id = request.headers.get('mcp-session-id');
    if (!id) return new Response('Missing Mcp-Session-Id', { status: 400 });
    const record = this.#sessions.get(id);
    if (!record || record.closed) return new Response('Unknown MCP session', { status: 404 });
    const accept = request.headers.get('accept') ?? '';
    if (!accept.includes('text/event-stream'))
      return new Response('Not acceptable', { status: 406 });
    const lastId = request.headers.get('last-event-id');
    const outbox = new Channel<SseEvent>();
    record.outbox = outbox;
    record.outboxes.add(outbox);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          try {
            const replay = lastId
              ? record.replay.slice(record.replay.findIndex((event) => event.id === lastId) + 1)
              : [];
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
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
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
        await Promise.all(
          message
            .filter(isNotification)
            .map((item) => this.#dispatchMessage(item, request.signal, sessionId)),
        );
        return new Response(null, { status: 202 });
      }
      const responses: string[] = [];
      for (const item of message) {
        const response = await this.#dispatchMessage(item, request.signal, sessionId);
        if (response !== null) responses.push(response);
      }
      return new Response(`[${responses.join(',')}]`, {
        headers: { 'content-type': 'application/json' },
      });
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
   *
   * Broadcasts `notifications/tools/list_changed` to every connected peer and
   * HTTP session. No-op unless `listChanged.tools` was enabled — the
   * capability must be advertised before clients can rely on the signal.
   *
   * ```ts no_run
   * const server = mcpServer({ tools: () => currentTools, listChanged: { tools: true } });
   * currentTools.push(newTool);
   * await server.notifyToolsChanged();
   * ```
   */
  async notifyToolsChanged(): Promise<void> {
    if (!this.#listChanged.tools) return;
    await this.#broadcast('notifications/tools/list_changed');
  }
  /**
   * Notify clients that the server resource list changed.
   *
   * Broadcasts `notifications/resources/list_changed` to every connected peer
   * and HTTP session. No-op unless `listChanged.resources` was enabled.
   */
  async notifyResourcesChanged(): Promise<void> {
    if (!this.#listChanged.resources) return;
    await this.#broadcast('notifications/resources/list_changed');
  }
  /**
   * Notify clients that the server prompt list changed.
   *
   * Broadcasts `notifications/prompts/list_changed` to every connected peer
   * and HTTP session. No-op unless `listChanged.prompts` was enabled.
   */
  async notifyPromptsChanged(): Promise<void> {
    if (!this.#listChanged.prompts) return;
    await this.#broadcast('notifications/prompts/list_changed');
  }
  /**
   * Notify subscribed clients that a resource URI was updated.
   *
   * Sends `notifications/resources/updated` only to connections that
   * subscribed to this exact URI via `resources/subscribe`; unlike the list
   * change notifications it is not gated on a `listChanged` flag.
   *
   * ```ts no_run
   * await saveDocument('doc://readme', updated);
   * await server.notifyResourceUpdated('doc://readme');
   * ```
   */
  async notifyResourceUpdated(uri: string): Promise<void> {
    await this.#broadcast('notifications/resources/updated', { uri }, (record) =>
      record.subscriptions.has(uri),
    );
  }
  /**
   * Serve this MCP endpoint over any JSON-RPC string transport.
   *
   * Handles one peer per call and resolves when the transport ends. Use this
   * to run the server over a stdio pair, an in-memory duplex in tests, or any
   * custom transport; server-initiated notifications flow back through the
   * same peer.
   *
   * ```ts no_run
   * const [clientSide, serverSide] = inMemoryTransportPair();
   * void server.serve(serverSide);
   *
   * const client = new MCPClient({ transport: clientSide });
   * await client.connect();
   * ```
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
   * Mount the returned handler on one path for `GET`, `POST`, and `DELETE` —
   * `mountMcp()` does exactly that. `POST` carries client JSON-RPC traffic: an
   * `initialize` request creates a session whose id is returned in the
   * `Mcp-Session-Id` response header, and every later request must echo that
   * header (missing ids get `400`, unknown ids `404`). `GET` opens the
   * standalone SSE channel for server-initiated notifications and replays
   * missed events when a client reconnects with `Last-Event-ID` (the last 32
   * events per session are retained). `DELETE` terminates the session.
   *
   * Requests failing the `allowedOrigins` policy are rejected with `403`;
   * other methods get `405`.
   *
   * ```ts no_run
   * import { App } from 'fino:net/http/app';
   *
   * const app = new App();
   * const handler = server.httpHandler();
   * app.get('/mcp').handle((ctx) => handler(ctx.request));
   * app.post('/mcp').handle((ctx) => handler(ctx.request));
   * app.delete('/mcp').handle((ctx) => handler(ctx.request));
   * ```
   */
  httpHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      if (!(await this.#originAllowed(request))) return new Response('Forbidden', { status: 403 });
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
   * Binds a bare HTTP server and dispatches only the configured path (default
   * `/`); anything else responds `404`. Prefer mounting `httpHandler()` into
   * `fino:net/http/app` for production services so application middleware
   * controls authentication and policy.
   *
   * ```ts no_run
   * const handle = server.listen({ port: 0, path: '/mcp' });
   * await handle.ready;
   * console.log(`listening on ${handle.port}`);
   * handle.close();
   * ```
   */
  listen(opts: ListenOptions): ServerHandle {
    const path = opts.path ?? '/';
    const handler = this.httpHandler();
    const inner: ServeServer = serveHttp(
      {
        port: opts.port,
        ...(opts.host ? { host: opts.host } : {}),
      },
      async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== path) return new Response('Not found', { status: 404 });
        return handler(request);
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
/**
 * Create an MCP server from local Fino tools and resource readers.
 *
 * Convenience wrapper around `new MCPServer(opts)`.
 *
 * ```ts no_run
 * import { mcpServer } from 'fino:ai/mcp';
 * import { tool } from 'fino:ai/tool';
 * import { v } from 'fino:validate';
 *
 * const server = mcpServer({
 *   name: 'calculator',
 *   tools: [tool({
 *     name: 'add',
 *     description: 'Add two numbers.',
 *     parameters: v.object({ a: v.number(), b: v.number() }),
 *     execute: ({ a, b }: { a: number; b: number }) => String(a + b),
 *   })],
 * });
 * ```
 */
export function mcpServer(opts: MCPServerOptions = {}): MCPServer {
  return new MCPServer(opts);
}
/**
 * Mount an MCP server on a Fino `App` or `Router`.
 *
 * Registers the server's Streamable HTTP handler for `GET`, `POST`, and
 * `DELETE` on the given path and returns the target for chaining. The
 * target's middleware remains responsible for authentication, authorization,
 * logging, and rate limiting around the MCP endpoint.
 *
 * ```ts no_run
 * import { App } from 'fino:net/http/app';
 * import { mcpServer, mountMcp } from 'fino:ai/mcp';
 *
 * const app = new App();
 * app.use(requireBearerToken);
 * mountMcp(app, '/mcp', mcpServer({ name: 'internal-tools' }));
 * app.listen({ port: 8080 });
 * ```
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
 *
 * Construct with a transport, call `connect()` to perform the `initialize`
 * handshake, then use the list and read methods. Remote MCP tools are
 * converted into Fino `Tool` instances whose `execute` proxies `tools/call`
 * over the transport, so they can be passed directly to an `Agent`.
 *
 * The client also answers server-initiated requests: `roots/list` when
 * `roots` is configured, `sampling/createMessage` when `sampling` is
 * configured, and `elicitation/create` when `elicitation` is configured.
 * List-changed notifications from the server refresh the retained `tools`,
 * `resources`, `resourceTemplates`, and `prompts` signals automatically.
 *
 * Every request method throws if called before `connect()`.
 *
 * ```ts no_run
 * import { MCPClient, stdioTransport } from 'fino:ai/mcp';
 * import { agent, streamText } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 *
 * const mcp = new MCPClient({
 *   transport: stdioTransport({ command: 'mcp-filesystem', args: ['/srv/data'] }),
 * });
 * await mcp.connect();
 *
 * const bot = agent({
 *   model: openai({ model: 'gpt-4o' }),
 *   tools: await mcp.listTools(),
 * });
 * const stream = bot.stream('Summarize the monthly report.');
 * for await (const text of streamText(stream)) console.log(text);
 * await mcp.close();
 * ```
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
  /**
   * Create a client on the given transport.
   *
   * The JSON-RPC peer starts reading from the transport immediately so
   * server-initiated requests and notifications can be answered, but no MCP
   * traffic is sent until `connect()` runs the `initialize` handshake.
   */
  constructor(opts: MCPClientOptions) {
    this.#opts = opts;
    const service = new JsonRpcService()
      .method('roots/list')
      .handle(async (params) => {
        if (params !== undefined)
          throw new JsonRpcError('Invalid roots/list params', INVALID_PARAMS);
        const roots = typeof opts.roots === 'function' ? await opts.roots() : opts.roots;
        return { roots: roots ?? [] };
      })
      .method('sampling/createMessage')
      .handle(async (params) => {
        if (!isRecord(params) || !Array.isArray(params.messages)) {
          throw new JsonRpcError('Invalid sampling params', INVALID_PARAMS);
        }
        if (!opts.sampling) throw new JsonRpcError('Sampling is not configured', INVALID_REQUEST);
        return await opts.sampling(params as McpSamplingRequest);
      })
      .method('elicitation/create')
      .handle(async (params) => {
        if (!isRecord(params) || typeof params.message !== 'string') {
          throw new JsonRpcError('Invalid elicitation params', INVALID_PARAMS);
        }
        if (!opts.elicitation)
          throw new JsonRpcError('Elicitation is not configured', INVALID_REQUEST);
        return await opts.elicitation(params as McpElicitationRequest);
      })
      .method('notifications/tools/list_changed')
      .handle(async () => {
        void this.#refreshTools();
        await opts.onToolsChanged?.();
      })
      .method('notifications/resources/list_changed')
      .handle(async () => {
        void Promise.all([this.#refreshResources(), this.#refreshResourceTemplates()]);
        await opts.onResourcesChanged?.();
      })
      .method('notifications/prompts/list_changed')
      .handle(async () => {
        void this.#refreshPrompts();
        await opts.onPromptsChanged?.();
      })
      .method('notifications/resources/updated')
      .handle(async (params) => {
        if (!isRecord(params) || typeof params.uri !== 'string') {
          throw new JsonRpcError('Invalid resource update params', INVALID_PARAMS);
        }
        await opts.onResourceUpdated?.(params.uri);
      });
    this.#peer = new JsonRpcPeer(opts.transport, service);
  }
  /**
   * Retained first-page list of remote tools.
   *
   * The signal starts empty, fetches lazily on first observation, and
   * refreshes automatically when the server emits
   * `notifications/tools/list_changed`. Use `listTools()` /
   * `listToolsPage()` for an explicit fetch or for pagination.
   *
   * ```ts no_run
   * import { effect } from 'fino:signals';
   *
   * effect(() => {
   *   console.log('tools:', mcp.tools.value.map((t) => t.name));
   * });
   * ```
   */
  get tools(): ReadonlySignal<Tool[]> {
    return this.#toolsSignal;
  }
  /**
   * Retained first-page list of remote resources.
   *
   * Fetches lazily on first observation and refreshes when the server emits
   * `notifications/resources/list_changed`.
   */
  get resources(): ReadonlySignal<McpResource[]> {
    return this.#resourcesSignal;
  }
  /**
   * Retained first-page list of remote resource templates.
   *
   * Fetches lazily on first observation and refreshes when the server emits
   * `notifications/resources/list_changed`.
   */
  get resourceTemplates(): ReadonlySignal<McpResourceTemplate[]> {
    return this.#resourceTemplatesSignal;
  }
  /**
   * Retained first-page list of remote prompts.
   *
   * Fetches lazily on first observation and refreshes when the server emits
   * `notifications/prompts/list_changed`.
   */
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
  /**
   * Perform the MCP `initialize` handshake.
   *
   * Advertises the client capabilities implied by the configured options
   * (`roots`, `sampling`, `elicitation`), then sends
   * `notifications/initialized`. Must complete before any list, read, or
   * subscribe method is used — those throw until the client is connected.
   */
  async connect(): Promise<void> {
    const capabilities: Record<string, unknown> = {};
    if (this.#opts.roots !== undefined) capabilities.roots = {};
    if (this.#opts.sampling !== undefined) capabilities.sampling = {};
    if (this.#opts.elicitation !== undefined) capabilities.elicitation = {};
    await this.#peer.call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities,
      clientInfo: CLIENT_INFO,
    });
    await this.#peer.notify('notifications/initialized');
    this.#connected = true;
  }
  #assertConnected(): void {
    if (!this.#connected) throw new Error('MCPClient: call connect() first');
  }
  /**
   * List remote tools as Fino `Tool` instances.
   *
   * Returns one `tools/list` page without cursor metadata — the convenience
   * form for servers that fit their tool list in a single page. Each returned
   * `Tool` proxies its execution through `tools/call` on this client; text
   * content parts of the result are concatenated, and a result flagged
   * `isError` is surfaced as a tool error rather than a thrown exception.
   *
   * Throws if called before `connect()`.
   *
   * ```ts no_run
   * const tools = await mcp.listTools();
   * const bot = agent({ model, tools });
   * ```
   */
  async listTools(params: McpListParams = {}): Promise<Tool[]> {
    return (await this.listToolsPage(params)).items;
  }
  /**
   * Return one MCP `tools/list` page with the server-provided cursor metadata.
   *
   * Use this when a remote server may paginate large tool lists. `listTools()`
   * remains the compatibility helper for one-page servers and returns only the
   * current page's `Tool` instances.
   *
   * Throws if called before `connect()`.
   *
   * ```ts no_run
   * const all: Tool[] = [];
   * let cursor: string | undefined;
   * do {
   *   const page = await mcp.listToolsPage(cursor ? { cursor } : {});
   *   all.push(...page.items);
   *   cursor = page.nextCursor;
   * } while (cursor !== undefined);
   * ```
   */
  async listToolsPage(params: McpListParams = {}): Promise<McpListPage<Tool>> {
    this.#assertConnected();
    const result = (await this.#peer.call('tools/list', params)) as {
      tools?: McpToolDef[];
      nextCursor?: string;
    };
    const defs = result.tools ?? [];
    return {
      items: defs.map(
        (def) =>
          new Tool({
            name: def.name,
            description: def.description ?? '',
            parameters: def.inputSchema ?? {
              type: 'object',
              properties: {},
            },
            execute: async (args) => {
              const res = (await this.#peer.call('tools/call', {
                name: def.name,
                arguments: args,
              })) as McpCallResult;
              const text = res.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('');
              if (res.isError)
                return {
                  content: text,
                  isError: true,
                };
              return text;
            },
          }),
      ),
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }
  /**
   * List remote resource descriptors.
   *
   * Returns one `resources/list` page without cursor metadata; use
   * `listResourcesPage()` when the server paginates. Throws if called before
   * `connect()`.
   */
  async listResources(params: McpListParams = {}): Promise<McpResource[]> {
    return (await this.listResourcesPage(params)).items;
  }
  /**
   * Return one MCP `resources/list` page with cursor metadata.
   *
   * Throws if called before `connect()`.
   */
  async listResourcesPage(params: McpListParams = {}): Promise<McpListPage<McpResource>> {
    this.#assertConnected();
    const result = (await this.#peer.call('resources/list', params)) as {
      resources?: McpResource[];
      nextCursor?: string;
    };
    return {
      items: result.resources ?? [],
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }
  /**
   * List remote resource templates.
   *
   * Returns one `resources/templates/list` page without cursor metadata; use
   * `listResourceTemplatesPage()` when the server paginates. Throws if called
   * before `connect()`.
   */
  async listResourceTemplates(params: McpListParams = {}): Promise<McpResourceTemplate[]> {
    return (await this.listResourceTemplatesPage(params)).items;
  }
  /**
   * Return one MCP `resources/templates/list` page with cursor metadata.
   *
   * Throws if called before `connect()`.
   */
  async listResourceTemplatesPage(
    params: McpListParams = {},
  ): Promise<McpListPage<McpResourceTemplate>> {
    this.#assertConnected();
    const result = (await this.#peer.call('resources/templates/list', params)) as {
      resourceTemplates?: McpResourceTemplate[];
      nextCursor?: string;
    };
    return {
      items: result.resourceTemplates ?? [],
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }
  /**
   * Read the content of a resource by URI.
   *
   * Returns the server's content list — usually one entry, but servers may
   * return several (e.g. a directory URI expanding to its files). Throws if
   * called before `connect()`; unknown URIs surface as `JsonRpcError` from the
   * server.
   *
   * ```ts no_run
   * const [content] = await mcp.readResource('file:///data/report.txt');
   * console.log(content.text);
   * ```
   */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    this.#assertConnected();
    const result = (await this.#peer.call('resources/read', { uri })) as {
      contents?: McpResourceContent[];
    };
    return result.contents ?? [];
  }
  /**
   * List remote prompt descriptors.
   *
   * Returns one `prompts/list` page without cursor metadata; use
   * `listPromptsPage()` when the server paginates. Throws if called before
   * `connect()`.
   */
  async listPrompts(params: McpListParams = {}): Promise<McpPrompt[]> {
    return (await this.listPromptsPage(params)).items;
  }
  /**
   * Return one MCP `prompts/list` page with cursor metadata.
   *
   * Throws if called before `connect()`.
   */
  async listPromptsPage(params: McpListParams = {}): Promise<McpListPage<McpPrompt>> {
    this.#assertConnected();
    const result = (await this.#peer.call('prompts/list', params)) as {
      prompts?: McpPrompt[];
      nextCursor?: string;
    };
    return {
      items: result.prompts ?? [],
      ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    };
  }
  /**
   * Render a remote prompt into conversation messages.
   *
   * Calls `prompts/get` with the given argument values. Throws if called
   * before `connect()`; unknown prompt names surface as `JsonRpcError` from
   * the server.
   *
   * ```ts no_run
   * const { messages } = await mcp.getPrompt('summarize', { text: longText });
   * ```
   */
  async getPrompt(name: string, args: Record<string, unknown> = {}): Promise<McpPromptResult> {
    this.#assertConnected();
    return (await this.#peer.call('prompts/get', {
      name,
      arguments: args,
    })) as McpPromptResult;
  }
  /**
   * Subscribe to update notifications for a resource URI.
   *
   * Updates arrive through the `onResourceUpdated` callback configured on the
   * client. Throws if called before `connect()`.
   *
   * ```ts no_run
   * const mcp = new MCPClient({
   *   transport,
   *   onResourceUpdated: (uri) => console.log('updated:', uri),
   * });
   * await mcp.connect();
   * await mcp.subscribeResource('file:///data/report.txt');
   * ```
   */
  async subscribeResource(uri: string): Promise<void> {
    this.#assertConnected();
    await this.#peer.call('resources/subscribe', { uri });
  }
  /**
   * Cancel a resource subscription made with `subscribeResource()`.
   *
   * Throws if called before `connect()`.
   */
  async unsubscribeResource(uri: string): Promise<void> {
    this.#assertConnected();
    await this.#peer.call('resources/unsubscribe', { uri });
  }
  /**
   * Close the underlying peer and transport.
   *
   * For stdio transports this closes the child's stdin so the server process
   * can exit. The client cannot be reused after closing.
   */
  async close(): Promise<void> {
    await this.#peer.close();
  }
}
/**
 * Create an `MCPClient`.
 *
 * Convenience wrapper around `new MCPClient(opts)`; the returned client still
 * needs `connect()` before use.
 *
 * ```ts no_run
 * import { mcpClient, httpTransport } from 'fino:ai/mcp';
 *
 * const client = mcpClient({
 *   transport: httpTransport({ url: 'https://tools.example.com/mcp' }),
 * });
 * await client.connect();
 * const tools = await client.listTools();
 * ```
 */
export function mcpClient(opts: MCPClientOptions): MCPClient {
  return new MCPClient(opts);
}
