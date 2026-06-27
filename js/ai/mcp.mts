/**
 * Model Context Protocol client adapters.
 *
 * `MCPClient` connects to an MCP server, lists remote tools/resources, and
 * converts MCP tools into Fino `Tool` instances that can be passed to agents.
 * Transports are intentionally small so applications can provide stdio, HTTP,
 * or custom JSON-RPC wiring.
 *
 * MCP protocol reference: https://modelcontextprotocol.io/
 */

import { JsonRpcPeer, JsonRpcError, INTERNAL_ERROR } from 'fino:jsonrpc';
import type { Transport } from 'fino:jsonrpc';
import { Tool } from 'fino:ai/tool';
import { Process } from 'fino:process';
import { HttpClient } from 'fino:net/http/client';
import { parseEventStream } from 'fino:net/http/eventstream';
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
