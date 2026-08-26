/**
 * fino:ai/acp — Agent Client Protocol v1 adapter for Fino agents.
 *
 * Useful references:
 *
 * - ACP v1 overview: https://agentclientprotocol.com/protocol/v1/overview
 * - Initialization: https://agentclientprotocol.com/protocol/v1/initialization
 * - Session setup: https://agentclientprotocol.com/protocol/v1/session-setup
 * - Prompt turns: https://agentclientprotocol.com/protocol/v1/prompt-turn
 * - Tool calls: https://agentclientprotocol.com/protocol/v1/tool-calls
 * - Transports: https://agentclientprotocol.com/protocol/v1/transports
 * - Schema: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json
 *
 * `AcpServer` exposes a reusable `Agent` to editor and IDE clients. Each ACP
 * `session/new` request creates one isolated `AgentSession`; prompts within that
 * session retain history, while different sessions may execute concurrently.
 * The baseline adapter supports ACP v1 initialization, new sessions, prompts,
 * streamed message and tool updates, cancellation, text and resource-link
 * input, inline tool permission requests, and session-provided MCP servers over
 * stdio.
 *
 * ACP stdio gives the client permission to launch this agent process and supply
 * MCP subprocess commands. `allowMcpServer` is the policy boundary for hosts
 * that need to restrict those commands. The adapter does not provide ACP
 * authentication, persistent session load/list/delete, client filesystem or
 * terminal calls, HTTP transport, images, audio, or embedded resources, and it
 * does not advertise those optional capabilities.
 *
 * ```ts no_run
 * import { acpServer, acpStdioTransport } from 'fino:ai/acp';
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 *
 * const server = acpServer({
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 *   allowMcpServer: ({ command }) => command.startsWith('/usr/local/bin/'),
 * });
 * await server.serve(acpStdioTransport());
 * ```
 */
import { env as processEnv, stdin, stdout } from 'fino:process';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  JsonRpcError,
  JsonRpcPeer,
  JsonRpcService,
} from 'fino:jsonrpc';
import type { Transport } from 'fino:jsonrpc';
import type { Agent, AgentEvent, AgentSession } from 'fino:ai/agent';
import type { ToolApprovalRequest } from 'fino:ai/runtime';
import type { ContentPart, ModelMessage, StopReason } from 'fino:ai/model';
import { MCPClient, stdioTransport as mcpStdioTransport } from 'fino:ai/mcp';
import type { Tool } from 'fino:ai/tool';

/** ACP major protocol version implemented by this module. */
export const ACP_PROTOCOL_VERSION = 1;

/** Text prompt or streamed display content. */
export interface AcpTextContent {
  /** Content-block discriminator. */
  type: 'text';
  /** UTF-8 text shown to the model or client. */
  text: string;
  /** Optional ACP display and routing annotations. */
  annotations?: unknown;
  /** Extension metadata reserved by ACP. */
  _meta?: Record<string, unknown> | null;
}

/** A resource URI that the agent is expected to be able to reference. */
export interface AcpResourceLink {
  /** Content-block discriminator. */
  type: 'resource_link';
  /** Human-readable resource name. */
  name: string;
  /** URI identifying the linked resource. */
  uri: string;
  /** Optional user-facing title. */
  title?: string | null;
  /** Optional description included in the model-facing representation. */
  description?: string | null;
  /** Optional media type reported by the client. */
  mimeType?: string | null;
  /** Optional resource size in bytes. */
  size?: number | null;
  /** Optional ACP display and routing annotations. */
  annotations?: unknown;
  /** Extension metadata reserved by ACP. */
  _meta?: Record<string, unknown> | null;
}

/** Baseline ACP prompt content accepted by Fino. */
export type AcpPromptContent = AcpTextContent | AcpResourceLink;

/** Environment variable passed to a session-provided MCP process. */
export interface AcpEnvVariable {
  /** Environment variable name. */
  name: string;
  /** Environment variable value. */
  value: string;
}

/** ACP stdio MCP server descriptor. */
export interface AcpMcpServerStdio {
  /** Human-readable server name. */
  name: string;
  /** Absolute MCP server executable path. */
  command: string;
  /** Arguments passed to the MCP server executable. */
  args: string[];
  /** Environment additions and overrides for the MCP process. */
  env: AcpEnvVariable[];
  /** Extension metadata reserved by ACP. */
  _meta?: Record<string, unknown> | null;
}

/** Context passed to `allowMcpServer`. */
export interface AcpMcpServerPolicyContext {
  /** Session working directory supplied by the ACP client. */
  cwd: string;
}

/** Options for an ACP agent server. */
export interface AcpServerOptions {
  /** Reusable agent definition used to create isolated ACP sessions. */
  agent: Agent;
  /** Stable implementation name reported during initialization. Defaults to `fino`. */
  name?: string;
  /** Optional user-facing implementation title. */
  title?: string;
  /** Implementation version reported to clients. Defaults to `0.1.0`. */
  version?: string;
  /**
   * Authorize an MCP subprocess supplied by the ACP client.
   *
   * Omit this callback for the normal trusted-local-editor model. Returning
   * `false` rejects session creation before the command is launched.
   */
  allowMcpServer?: (
    server: AcpMcpServerStdio,
    context: AcpMcpServerPolicyContext,
  ) => boolean | Promise<boolean>;
}

interface AcpSessionRecord {
  agent: AgentSession;
  mcpClients: MCPClient[];
  activeController: AbortController | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidParams(message: string): never {
  throw new JsonRpcError(message, INVALID_PARAMS);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) invalidParams(`${name} must be an object`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') invalidParams(`${name} must be a string`);
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidParams(`${name} must be an array of strings`);
  }
  return value as string[];
}

function requireAbsolutePath(value: unknown, name: string): string {
  const path = requireString(value, name);
  if (!path.startsWith('/')) invalidParams(`${name} must be an absolute path`);
  return path;
}

function parseMcpServer(value: unknown, index: number): AcpMcpServerStdio {
  const server = requireRecord(value, `mcpServers[${index}]`);
  if ('type' in server) invalidParams(`mcpServers[${index}] transport is not supported`);
  const command = requireAbsolutePath(server.command, `mcpServers[${index}].command`);
  const envValue = server.env;
  if (!Array.isArray(envValue)) invalidParams(`mcpServers[${index}].env must be an array`);
  const seen = new Set<string>();
  const env = envValue.map((value, envIndex) => {
    const item = requireRecord(value, `mcpServers[${index}].env[${envIndex}]`);
    const name = requireString(item.name, `mcpServers[${index}].env[${envIndex}].name`);
    if (seen.has(name)) invalidParams(`mcpServers[${index}].env contains duplicate ${name}`);
    seen.add(name);
    return {
      name,
      value: requireString(item.value, `mcpServers[${index}].env[${envIndex}].value`),
    };
  });
  return {
    name: requireString(server.name, `mcpServers[${index}].name`),
    command,
    args: requireStringArray(server.args, `mcpServers[${index}].args`),
    env,
    ...(isRecord(server._meta) ? { _meta: server._meta } : {}),
  };
}

function parsePromptContent(value: unknown, index: number): AcpPromptContent {
  const block = requireRecord(value, `prompt[${index}]`);
  if (block.type === 'text') {
    return {
      type: 'text',
      text: requireString(block.text, `prompt[${index}].text`),
    };
  }
  if (block.type === 'resource_link') {
    return {
      type: 'resource_link',
      name: requireString(block.name, `prompt[${index}].name`),
      uri: requireString(block.uri, `prompt[${index}].uri`),
      ...(typeof block.title === 'string' ? { title: block.title } : {}),
      ...(typeof block.description === 'string' ? { description: block.description } : {}),
      ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
      ...(typeof block.size === 'number' ? { size: block.size } : {}),
    };
  }
  return invalidParams(`prompt[${index}].type is not supported`);
}

function promptMessage(blocks: AcpPromptContent[]): ModelMessage {
  const content: ContentPart[] = blocks.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    const label = block.title ?? block.name;
    const description = block.description ? ` — ${block.description}` : '';
    return {
      type: 'text',
      text: `[${label}](${block.uri})${description}`,
    };
  });
  return {
    role: 'user',
    content,
  };
}

function toolOutputText(output: string | ContentPart[]): string {
  if (typeof output === 'string') return output;
  return output.map((part) => (part.type === 'text' ? part.text : JSON.stringify(part))).join('\n');
}

function acpStopReason(
  reason: StopReason,
): 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'max_turn_requests';
    case 'refusal':
    case 'content_filter':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'error':
      throw new JsonRpcError('Agent stopped with an error', INTERNAL_ERROR);
  }
}

async function* splitLines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  for await (const chunk of source) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
  buffered += decoder.decode();
  if (buffered.length > 0) yield buffered;
}

/**
 * Create the ACP newline-delimited JSON transport over this process's stdio.
 *
 * Writes are serialized and suffixed with exactly one newline. Applications
 * serving this transport must reserve stdout exclusively for ACP messages and
 * send diagnostics to stderr.
 */
export function acpStdioTransport(): Transport {
  const encoder = new TextEncoder();
  const input = stdin();
  const output = stdout();
  let writes = Promise.resolve();
  return {
    send(message: string): Promise<void> {
      writes = writes.then(async () => {
        await output.write(encoder.encode(`${message}\n`));
        await output.flush();
      });
      return writes;
    },
    receive(): AsyncIterable<string> {
      return splitLines(input);
    },
    async close(): Promise<void> {
      // Closing the borrowed reader unblocks serve(); the underlying fd remains process-owned.
      await input.close();
    },
  };
}

/** ACP v1 server that adapts protocol sessions to isolated Fino agent sessions. */
export class AcpServer {
  #opts: AcpServerOptions;
  #service: JsonRpcService;
  #peer: JsonRpcPeer | null = null;
  #initialized = false;
  #sessions = new Map<string, AcpSessionRecord>();
  /** Create a server. Call `serve()` with stdio or another message transport. */
  constructor(opts: AcpServerOptions) {
    this.#opts = opts;
    this.#service = new JsonRpcService()
      .method('initialize')
      .handle((params) => this.#initialize(params))
      .method('session/new')
      .handle((params) => this.#newSession(params))
      .method('session/prompt')
      .handle((params) => this.#prompt(params))
      .method('session/cancel')
      .handle((params) => this.#cancel(params));
  }
  #assertInitialized(): void {
    if (!this.#initialized)
      throw new JsonRpcError('Connection is not initialized', INVALID_REQUEST);
  }
  #initialize(params: unknown): Record<string, unknown> {
    if (this.#initialized)
      throw new JsonRpcError('Connection is already initialized', INVALID_REQUEST);
    const value = requireRecord(params, 'initialize params');
    if (typeof value.protocolVersion !== 'number' || !Number.isInteger(value.protocolVersion)) {
      invalidParams('protocolVersion must be an integer');
    }
    if (value.clientCapabilities !== undefined && !isRecord(value.clientCapabilities)) {
      invalidParams('clientCapabilities must be an object');
    }
    this.#initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {},
        auth: {},
      },
      authMethods: [],
      agentInfo: {
        name: this.#opts.name ?? 'fino',
        ...(this.#opts.title ? { title: this.#opts.title } : {}),
        version: this.#opts.version ?? '0.1.0',
      },
    };
  }
  async #newSession(params: unknown): Promise<{ sessionId: string }> {
    this.#assertInitialized();
    const value = requireRecord(params, 'session/new params');
    const cwd = requireAbsolutePath(value.cwd, 'cwd');
    if (
      value.additionalDirectories !== undefined &&
      (!Array.isArray(value.additionalDirectories) || value.additionalDirectories.length > 0)
    ) {
      invalidParams('additionalDirectories are not supported');
    }
    if (!Array.isArray(value.mcpServers)) invalidParams('mcpServers must be an array');
    const servers = value.mcpServers.map(parseMcpServer);
    const clients: MCPClient[] = [];
    const tools: Tool[] = [];
    try {
      for (const server of servers) {
        if (this.#opts.allowMcpServer && !(await this.#opts.allowMcpServer(server, { cwd }))) {
          throw new JsonRpcError(`MCP server rejected by policy: ${server.name}`, INVALID_REQUEST);
        }
        const client = new MCPClient({
          transport: mcpStdioTransport({
            command: server.command,
            args: server.args,
            env: {
              ...processEnv,
              ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
            },
            cwd,
          }),
          roots: [{ uri: `file://${cwd}`, name: 'workspace' }],
        });
        clients.push(client);
        await client.connect();
        tools.push(...(await client.listTools()));
      }
      const sessionId = crypto.randomUUID();
      const persistentPermissions = new Map<string, boolean>();
      this.#sessions.set(sessionId, {
        agent: this.#opts.agent.createSession({
          tools,
          requestToolApproval: (request, { signal }) =>
            this.#requestPermission(sessionId, request, persistentPermissions, signal),
        }),
        mcpClients: clients,
        activeController: null,
      });
      return { sessionId };
    } catch (error) {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      throw error;
    }
  }
  async #notify(sessionId: string, update: Record<string, unknown>): Promise<void> {
    if (!this.#peer) throw new JsonRpcError('ACP connection is closed', INTERNAL_ERROR);
    await this.#peer.notify('session/update', {
      sessionId,
      update,
    });
  }
  async #requestPermission(
    sessionId: string,
    request: ToolApprovalRequest,
    persistent: Map<string, boolean>,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string }> {
    const remembered = persistent.get(request.toolName);
    if (remembered !== undefined) {
      return remembered ? { approved: true } : { approved: false, reason: 'always rejected' };
    }
    if (signal.aborted) throw signal.reason;
    if (!this.#peer) throw new JsonRpcError('ACP connection is closed', INTERNAL_ERROR);
    const response = (await this.#peer.call('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: request.toolCallId,
        title: request.toolName,
        status: 'pending',
        rawInput: request.args,
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
      ],
    })) as {
      outcome?: {
        outcome?: unknown;
        optionId?: unknown;
      };
    };
    if (signal.aborted || response.outcome?.outcome === 'cancelled') {
      if (signal.aborted) throw signal.reason;
      const error = new Error('Permission request cancelled');
      error.name = 'AbortError';
      throw error;
    }
    if (response.outcome?.outcome !== 'selected' || typeof response.outcome.optionId !== 'string') {
      throw new JsonRpcError('Invalid permission response', INTERNAL_ERROR);
    }
    switch (response.outcome.optionId) {
      case 'allow_once':
        return { approved: true };
      case 'allow_always':
        persistent.set(request.toolName, true);
        return { approved: true };
      case 'reject_once':
        return { approved: false, reason: 'rejected by user' };
      case 'reject_always':
        persistent.set(request.toolName, false);
        return { approved: false, reason: 'always rejected by user' };
      default:
        throw new JsonRpcError('Unknown permission option', INTERNAL_ERROR);
    }
  }
  async #event(sessionId: string, event: AgentEvent): Promise<void> {
    if (event.type === 'model_event' && event.event.type === 'text_delta') {
      await this.#notify(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: event.event.text,
        },
      });
      return;
    }
    if (event.type === 'tool_start') {
      await this.#notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: event.id,
        title: event.name,
        kind: 'other',
        status: event.awaitingApproval ? 'pending' : 'in_progress',
        rawInput: event.args,
      });
      return;
    }
    if (event.type === 'tool_result') {
      const text = toolOutputText(event.result);
      await this.#notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: event.isError ? 'failed' : 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text,
            },
          },
        ],
        rawOutput: event.result,
      });
      return;
    }
    if (event.type === 'tool_error') {
      await this.#notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: event.message,
            },
          },
        ],
        rawOutput: { error: event.message },
      });
    }
  }
  async #prompt(params: unknown): Promise<{ stopReason: string }> {
    this.#assertInitialized();
    const value = requireRecord(params, 'session/prompt params');
    const sessionId = requireString(value.sessionId, 'sessionId');
    const record = this.#sessions.get(sessionId);
    if (!record) throw new JsonRpcError(`Unknown session: ${sessionId}`, INVALID_PARAMS);
    if (!Array.isArray(value.prompt)) invalidParams('prompt must be an array');
    const prompt = value.prompt.map(parsePromptContent);
    if (record.activeController) {
      throw new JsonRpcError(`Session already has an active prompt: ${sessionId}`, INVALID_REQUEST);
    }
    const controller = new AbortController();
    record.activeController = controller;
    let resultPromise: Promise<unknown> | null = null;
    try {
      const stream = record.agent.stream({
        messages: [promptMessage(prompt)],
        signal: controller.signal,
      });
      resultPromise = stream.result;
      for await (const event of stream.reader) await this.#event(sessionId, event);
      const result = await stream.result;
      return { stopReason: acpStopReason(result.stopReason) };
    } catch (error) {
      await resultPromise?.catch(() => {});
      if (controller.signal.aborted || (error as Error)?.name === 'AbortError') {
        return { stopReason: 'cancelled' };
      }
      throw error;
    } finally {
      if (record.activeController === controller) record.activeController = null;
    }
  }
  #cancel(params: unknown): void {
    this.#assertInitialized();
    const value = requireRecord(params, 'session/cancel params');
    const sessionId = requireString(value.sessionId, 'sessionId');
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    const reason = new Error('ACP prompt cancelled');
    reason.name = 'AbortError';
    record.activeController?.abort(reason);
    record.agent.cancel(reason);
  }
  async #closeSessions(): Promise<void> {
    const records = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const record of records) record.agent.close();
    await Promise.all(
      records.flatMap((record) =>
        record.mcpClients.map((client) => client.close().catch(() => {})),
      ),
    );
  }
  /**
   * Serve one bidirectional ACP connection until its transport reaches EOF.
   *
   * Calling `serve()` while another connection is active throws. All agent
   * sessions and MCP subprocesses are closed when the connection ends.
   */
  async serve(transport: Transport): Promise<void> {
    if (this.#peer) throw new Error('AcpServer is already serving a connection');
    this.#initialized = false;
    const peer = new JsonRpcPeer(transport, this.#service);
    this.#peer = peer;
    try {
      await peer.done;
    } finally {
      await this.#closeSessions();
      if (this.#peer === peer) this.#peer = null;
      this.#initialized = false;
    }
  }
  /** Close the active connection and all associated sessions. */
  async close(): Promise<void> {
    const peer = this.#peer;
    if (peer) await peer.close();
    await this.#closeSessions();
    if (this.#peer === peer) this.#peer = null;
    this.#initialized = false;
  }
}

/** Create an ACP server for a reusable Fino agent definition. */
export function acpServer(opts: AcpServerOptions): AcpServer {
  return new AcpServer(opts);
}
