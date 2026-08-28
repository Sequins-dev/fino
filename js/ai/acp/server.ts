/**
 * internal:ai/acp/server — stateful ACP v1 agent server orchestration.
 *
 * `AcpServer` owns one live JSON-RPC peer at a time, active prompt
 * cancellation, negotiated MCP clients, and session activation. Persisted
 * records remain in the caller-owned store after connection shutdown.
 */
import { env as processEnv } from 'fino:process';
import {
  INTERNAL_ERROR,
  INVALID_REQUEST,
  JsonRpcError,
  JsonRpcPeer,
  JsonRpcService,
} from 'fino:jsonrpc';
import type { RequestContext, Transport } from 'fino:jsonrpc';
import type { Agent, AgentEvent } from 'fino:ai/agent';
import { MessageHistory } from 'fino:ai/context';
import type { ContentPart, Usage } from 'fino:ai/model';
import type { ToolApprovalRequest } from 'fino:ai/runtime';
import {
  commitConversationThread,
  deleteConversationThread,
  listConversationThreads,
  loadConversationHistory,
  loadConversationThread,
} from 'fino:ai/session';
import {
  MCPClient,
  httpTransport as mcpHttpTransport,
  sseTransport as mcpSseTransport,
  stdioTransport as mcpStdioTransport,
} from 'fino:ai/mcp';
import { tool, type Tool } from 'fino:ai/tool';
import { memoryStore, type AtomicStore } from 'fino:store';
import { AcpClient } from 'internal:ai/acp/client';
import {
  abortError,
  acpStopReason,
  connectionClosed,
  filterConfigOptions,
  inferToolKind,
  invalidParams,
  isRecord,
  modelPartToAcp,
  normalizeClientCapabilities,
  parseAbsolutePaths,
  parseContent,
  parseMcpServer,
  promptMessage,
  requireAbsolutePath,
  requireRecord,
  requireString,
  supportsBooleanConfig,
} from 'internal:ai/acp/codec';
import {
  ACP_AUTH_REQUIRED,
  ACP_PROTOCOL_VERSION,
  ACP_RESOURCE_NOT_FOUND,
  type AcpAuthMethod,
  type AcpAvailableCommand,
  type AcpClientCapabilities,
  type AcpImplementation,
  type AcpMcpServer,
  type AcpMeta,
  type AcpSessionConfigOption,
  type AcpSessionModeState,
  type AcpTextContent,
  type AcpToolCallContent,
} from 'internal:ai/acp/schema';
import {
  acpThreadMetadata,
  storedSession,
  threadMetadata,
  type AcpStoredSession,
} from 'internal:ai/acp/storage';

/** Context passed to an MCP connection policy. */
export interface AcpMcpServerPolicyContext {
  /** Session receiving the MCP server. */
  sessionId: string;
  /** Session working directory. */
  cwd: string;
  /** Additional workspace roots. */
  additionalDirectories: string[];
}
/** Authentication policy and methods exposed by the server. */
export interface AcpAuthenticationOptions {
  /** Authentication methods advertised at initialization. */
  methods: AcpAuthMethod[];
  /** Authenticate one agent-managed method. */
  authenticate(
    methodId: string,
    context: {
      clientInfo?: AcpImplementation;
      meta?: AcpMeta;
      signal: AbortSignal;
    },
  ): boolean | void | Promise<boolean | void>;
  /** Recheck shared credentials after client-launched terminal authentication. */
  isAuthenticated?(context: {
    clientInfo?: AcpImplementation;
    signal: AbortSignal;
  }): boolean | Promise<boolean>;
  /** Clear connection authentication and application credentials. */
  logout?(context: { signal: AbortSignal }): void | Promise<void>;
}
/** Dynamic agent-selection and session-policy context. */
export interface AcpAgentContext {
  /** Active session id. */
  sessionId: string;
  /** Session working directory. */
  cwd: string;
  /** Additional workspace roots. */
  additionalDirectories: string[];
  /** Current legacy mode id. */
  modeId?: string;
  /** Current session configuration. */
  configOptions: AcpSessionConfigOption[];
  /** Session-bound negotiated client. */
  client: AcpClient;
}
/** Options for a complete ACP v1 agent server. */
export interface AcpServerOptions {
  /** Reusable agent definition or per-prompt agent factory. */
  agent: Agent | ((context: AcpAgentContext) => Agent | Promise<Agent>);
  /** Machine-readable implementation name. */
  name?: string;
  /** Optional display title. */
  title?: string;
  /** Implementation version. */
  version?: string;
  /**
   * Shared atomic store; defaults to a fresh `memoryStore()`.
   * Caller-supplied stores remain caller-owned and are not closed by the server.
   */
  store?: AtomicStore;
  /** Maximum sessions returned per ACP list page. Defaults to `50`. */
  sessionListPageSize?: number;
  /** Rich prompt types accepted by the configured application. */
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  /** Context window size reported in usage updates. */
  contextWindowSize?: number;
  /** Optional authentication policy. */
  authentication?: AcpAuthenticationOptions;
  /** Optional legacy session modes. */
  modes?: AcpSessionModeState;
  /** Initial session configuration options. */
  configOptions?: AcpSessionConfigOption[];
  /** Commands announced to clients for every activated session. */
  commands?: AcpAvailableCommand[];
  /** Apply application policy after a valid mode selection. */
  onModeChange?(context: AcpAgentContext, modeId: string): void | Promise<void>;
  /** Apply application policy after a valid configuration selection. */
  onConfigOptionChange?(
    context: AcpAgentContext,
    option: AcpSessionConfigOption,
  ): void | Promise<void>;
  /** Authorize each client-supplied MCP connection descriptor. */
  allowMcpServer?(
    server: AcpMcpServer,
    context: AcpMcpServerPolicyContext,
  ): boolean | Promise<boolean>;
  /** Underscore-prefixed agent extension request handlers. */
  extensions?: Record<
    string,
    (
      params: unknown,
      context: RequestContext & {
        clientInfo?: AcpImplementation;
        clientCapabilities: AcpClientCapabilities;
      },
    ) => unknown | Promise<unknown>
  >;
  /** Opaque metadata attached to advertised agent capabilities. */
  capabilityMeta?: Record<string, unknown>;
}
interface ActiveSession {
  stored: AcpStoredSession;
  history: MessageHistory;
  mcpClients: MCPClient[];
  mcpTools: Tool[];
  clientTools: Tool[];
  client: AcpClient;
  persistentPermissions: Map<string, boolean>;
  activeController: AbortController | null;
  activeDone: Promise<void> | null;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}
function addUsage(total: Usage, next: Usage): Usage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...((total.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0) > 0
      ? {
          cacheReadInputTokens:
            (total.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0),
        }
      : {}),
    ...((total.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0) > 0
      ? {
          cacheCreationInputTokens:
            (total.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0),
        }
      : {}),
    ...((total.localCacheReadInputTokens ?? 0) + (next.localCacheReadInputTokens ?? 0) > 0
      ? {
          localCacheReadInputTokens:
            (total.localCacheReadInputTokens ?? 0) + (next.localCacheReadInputTokens ?? 0),
        }
      : {}),
    ...((total.localCacheReadOutputTokens ?? 0) + (next.localCacheReadOutputTokens ?? 0) > 0
      ? {
          localCacheReadOutputTokens:
            (total.localCacheReadOutputTokens ?? 0) + (next.localCacheReadOutputTokens ?? 0),
        }
      : {}),
  };
}
function toolContent(result: string | ContentPart[]): AcpToolCallContent[] {
  const parts = typeof result === 'string' ? [{ type: 'text' as const, text: result }] : result;
  return parts.map((part) => ({ type: 'content', content: modelPartToAcp(part) }));
}
function sessionResponse(
  record: ActiveSession,
  capabilities: AcpClientCapabilities,
): Record<string, unknown> {
  return {
    ...(record.stored.modes ? { modes: structuredClone(record.stored.modes) } : {}),
    ...(record.stored.configOptions.length > 0
      ? { configOptions: filterConfigOptions(record.stored.configOptions, capabilities) }
      : {}),
  };
}

/** Complete stable ACP v1 server for reusable Fino agent definitions. */
export class AcpServer {
  #opts: AcpServerOptions;
  #store: AtomicStore;
  #sessionListPageSize: number;
  #peer: JsonRpcPeer | null = null;
  #initialized = false;
  #authenticated: boolean;
  #clientInfo?: AcpImplementation;
  #clientCapabilities: AcpClientCapabilities = normalizeClientCapabilities({});
  #sessions = new Map<string, ActiveSession>();
  #urlElicitations = new Set<string>();
  /** Create a server. Each `serve()` call owns one isolated ACP connection. */
  constructor(opts: AcpServerOptions) {
    this.#opts = opts;
    this.#store = opts.store ?? memoryStore();
    this.#sessionListPageSize = opts.sessionListPageSize ?? 50;
    if (!Number.isInteger(this.#sessionListPageSize) || this.#sessionListPageSize <= 0) {
      throw new RangeError('sessionListPageSize must be positive');
    }
    this.#authenticated = opts.authentication === undefined;
    for (const name of Object.keys(opts.extensions ?? {})) {
      if (!name.startsWith('_')) throw new TypeError('ACP extension methods must begin with _');
    }
    if (
      opts.authentication?.methods.some((method) => method.type === 'terminal') &&
      !opts.authentication.isAuthenticated
    ) {
      throw new TypeError('ACP terminal authentication requires authentication.isAuthenticated');
    }
  }
  #assertInitialized(): void {
    if (!this.#initialized)
      throw new JsonRpcError('ACP connection is not initialized', INVALID_REQUEST);
  }
  async #assertAuthenticated(signal?: AbortSignal): Promise<void> {
    this.#assertInitialized();
    if (!this.#authenticated && this.#opts.authentication?.isAuthenticated) {
      this.#authenticated = await this.#opts.authentication.isAuthenticated({
        clientInfo: this.#clientInfo,
        signal: signal ?? new AbortController().signal,
      });
    }
    if (!this.#authenticated) throw new JsonRpcError('Authentication required', ACP_AUTH_REQUIRED);
  }
  #service(): JsonRpcService {
    const service = new JsonRpcService();
    service.method('initialize').handle((params, ctx) => this.#initialize(params, ctx));
    service.method('authenticate').handle((params, ctx) => this.#authenticate(params, ctx));
    service.method('logout').handle((params, ctx) => this.#logout(params, ctx));
    service.method('session/new').handle((params, ctx) => this.#newSession(params, ctx));
    service.method('session/load').handle((params, ctx) => this.#loadSession(params, true, ctx));
    service.method('session/resume').handle((params, ctx) => this.#loadSession(params, false, ctx));
    service.method('session/list').handle((params, ctx) => this.#listSessions(params, ctx));
    service.method('session/delete').handle((params, ctx) => this.#deleteSession(params, ctx));
    service.method('session/close').handle((params, ctx) => this.#closeSession(params, ctx));
    service.method('session/set_mode').handle((params, ctx) => this.#setMode(params, ctx));
    service
      .method('session/set_config_option')
      .handle((params, ctx) => this.#setConfigOption(params, ctx));
    service.method('session/prompt').handle((params, ctx) => this.#prompt(params, ctx));
    service.method('session/cancel').handle((params, ctx) => this.#cancel(params, ctx));
    for (const [name, handler] of Object.entries(this.#opts.extensions ?? {})) {
      service.method(name).handle((params, ctx) => {
        this.#assertInitialized();
        return handler(params, {
          ...ctx,
          clientInfo: this.#clientInfo,
          clientCapabilities: structuredClone(this.#clientCapabilities),
        });
      });
    }
    return service;
  }
  #initialize(params: unknown, _ctx: RequestContext): Record<string, unknown> {
    if (this.#initialized)
      throw new JsonRpcError('ACP connection is already initialized', INVALID_REQUEST);
    const value = requireRecord(params, 'initialize params');
    if (!Number.isInteger(value.protocolVersion))
      invalidParams('protocolVersion must be an integer');
    this.#clientCapabilities = normalizeClientCapabilities(value.clientCapabilities);
    if (isRecord(value.clientInfo))
      this.#clientInfo = structuredClone(value.clientInfo) as unknown as AcpImplementation;
    this.#initialized = true;
    const authentication = this.#opts.authentication;
    const authMethods = (authentication?.methods ?? []).filter(
      (method) => method.type !== 'terminal' || this.#clientCapabilities.auth?.terminal === true,
    );
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: this.#opts.promptCapabilities?.image ?? true,
          audio: this.#opts.promptCapabilities?.audio ?? true,
          embeddedContext: this.#opts.promptCapabilities?.embeddedContext ?? true,
        },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: {
          list: {},
          delete: {},
          additionalDirectories: {},
          resume: {},
          close: {},
        },
        auth: {
          ...(authentication?.logout ? { logout: {} } : {}),
        },
        ...(this.#opts.capabilityMeta ? { _meta: structuredClone(this.#opts.capabilityMeta) } : {}),
      },
      authMethods: structuredClone(authMethods),
      agentInfo: {
        name: this.#opts.name ?? 'fino',
        ...(this.#opts.title ? { title: this.#opts.title } : {}),
        version: this.#opts.version ?? '0.1.0',
      },
    };
  }
  async #authenticate(params: unknown, ctx: RequestContext): Promise<Record<string, never>> {
    this.#assertInitialized();
    const authentication = this.#opts.authentication;
    if (!authentication)
      throw new JsonRpcError('Authentication is not configured', INVALID_REQUEST);
    const value = requireRecord(params, 'authenticate params');
    const methodId = requireString(value.methodId, 'methodId');
    const method = authentication.methods.find((candidate) => candidate.id === methodId);
    if (!method || method.type === 'terminal')
      invalidParams(`Unknown agent authentication method: ${methodId}`);
    const accepted = await authentication.authenticate(methodId, {
      clientInfo: this.#clientInfo,
      meta: isRecord(value._meta) ? value._meta : undefined,
      signal: ctx.signal,
    });
    if (accepted === false) throw new JsonRpcError('Authentication failed', ACP_AUTH_REQUIRED);
    this.#authenticated = true;
    return {};
  }
  async #logout(params: unknown, ctx: RequestContext): Promise<Record<string, never>> {
    await this.#assertAuthenticated(ctx.signal);
    requireRecord(params ?? {}, 'logout params');
    if (!this.#opts.authentication?.logout)
      throw new JsonRpcError('Logout is not supported', INVALID_REQUEST);
    await this.#opts.authentication.logout({ signal: ctx.signal });
    await this.#closeSessions();
    this.#authenticated = false;
    return {};
  }
  async #connectMcp(
    sessionId: string,
    cwd: string,
    additionalDirectories: string[],
    servers: AcpMcpServer[],
  ): Promise<{ clients: MCPClient[]; tools: Tool[] }> {
    const clients: MCPClient[] = [];
    const tools: Tool[] = [];
    try {
      for (const server of servers) {
        const context = { sessionId, cwd, additionalDirectories: [...additionalDirectories] };
        if (this.#opts.allowMcpServer && !(await this.#opts.allowMcpServer(server, context))) {
          throw new JsonRpcError(`MCP server rejected by policy: ${server.name}`, INVALID_REQUEST);
        }
        const roots = [
          { uri: `file://${cwd}`, name: 'workspace' },
          ...additionalDirectories.map((path) => ({ uri: `file://${path}` })),
        ];
        let transport: Transport;
        if ('type' in server && server.type === 'http') {
          transport = mcpHttpTransport({
            url: server.url,
            headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
          });
        } else if ('type' in server && server.type === 'sse') {
          transport = mcpSseTransport({
            url: server.url,
            headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
          });
        } else {
          transport = mcpStdioTransport({
            command: server.command,
            args: server.args,
            env: {
              ...processEnv,
              ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
            },
            cwd,
          });
        }
        const client = new MCPClient({ transport, roots });
        clients.push(client);
        await client.connect();
        let cursor: string | undefined;
        do {
          const page = await client.listToolsPage(cursor ? { cursor } : {});
          tools.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      }
      return { clients, tools };
    } catch (error) {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      throw error;
    }
  }
  #makeClientTools(client: AcpClient): Tool[] {
    const tools: Tool[] = [];
    if (client.capabilities.fs?.readTextFile) {
      tools.push(
        tool({
          name: 'acp_read_text_file',
          description: 'Read a text file through the ACP client.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 0 },
            },
            required: ['path'],
            additionalProperties: false,
          },
          execute: async (args: { path: string; line?: number; limit?: number }, ctx) =>
            (
              await client.readTextFile(args.path, {
                line: args.line,
                limit: args.limit,
                signal: ctx.signal,
              })
            ).content,
        }),
      );
    }
    if (client.capabilities.fs?.writeTextFile) {
      tools.push(
        tool({
          name: 'acp_write_text_file',
          description: 'Write a text file through the ACP client.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
          sideEffects: true,
          execute: async (args: { path: string; content: string }, ctx) => {
            await client.writeTextFile(args.path, args.content, { signal: ctx.signal });
            return 'File written';
          },
        }),
      );
    }
    if (client.capabilities.terminal) {
      tools.push(
        tool({
          name: 'acp_terminal',
          description: 'Run a command in an ACP client terminal and return its captured output.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
              outputByteLimit: { type: 'integer', minimum: 0 },
            },
            required: ['command'],
            additionalProperties: false,
          },
          sideEffects: true,
          execute: async (args: AcpCreateTerminalOptions, ctx) => {
            const { terminalId } = await client.createTerminal(args, ctx.signal);
            try {
              await client.update({
                sessionUpdate: 'tool_call_update',
                toolCallId: ctx.toolCallId,
                content: [{ type: 'terminal', terminalId }],
              });
              await client.waitForTerminalExit(terminalId, ctx.signal);
              const output = await client.terminalOutput(terminalId, ctx.signal);
              return output.output;
            } catch (error) {
              if (ctx.signal.aborted) await client.killTerminal(terminalId).catch(() => {});
              throw error;
            } finally {
              await client.releaseTerminal(terminalId).catch(() => {});
            }
          },
        }),
      );
    }
    if (isRecord(client.capabilities.elicitation?.form)) {
      tools.push(
        tool({
          name: 'acp_elicit_form',
          description:
            'Ask the user for structured, non-sensitive information through the ACP client.',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              requestedSchema: { type: 'object' },
            },
            required: ['message', 'requestedSchema'],
            additionalProperties: false,
          },
          execute: async (
            args: { message: string; requestedSchema: Record<string, unknown> },
            ctx,
          ) =>
            JSON.stringify(
              await client.elicit(
                {
                  mode: 'form',
                  message: args.message,
                  requestedSchema: args.requestedSchema,
                  toolCallId: ctx.toolCallId,
                },
                ctx.signal,
              ),
            ),
        }),
      );
    }
    return tools;
  }
  async #loadStored(sessionId: string): Promise<AcpStoredSession | null> {
    const thread = await loadConversationThread(this.#store, sessionId);
    if (!thread?.historyRevisionId) return null;
    const history = await loadConversationHistory(this.#store, thread.historyRevisionId);
    if (!history) return null;
    return storedSession(thread, history);
  }
  async #commitStored(
    session: AcpStoredSession,
    history: MessageHistory,
    expectedStoreVersion: string | null,
    baseRevisionId?: string,
  ): Promise<AcpStoredSession> {
    const updatedAt = Date.parse(session.updatedAt);
    const saved = await commitConversationThread(this.#store, {
      thread: {
        threadId: session.sessionId,
        historyRevisionId: history.revisionId,
        createdAt: session.createdAt,
        updatedAt,
        metadata: threadMetadata(session),
      },
      history,
      expectedStoreVersion,
      ...(baseRevisionId !== undefined ? { baseRevisionId } : {}),
    });
    return storedSession(saved, history)!;
  }
  async #activate(stored: AcpStoredSession, servers: AcpMcpServer[]): Promise<ActiveSession> {
    if (this.#sessions.has(stored.sessionId)) {
      await this.#closeActive(stored.sessionId);
    }
    const connected = await this.#connectMcp(
      stored.sessionId,
      stored.cwd,
      stored.additionalDirectories,
      servers,
    );
    const client = new AcpClient(
      stored.sessionId,
      this.#clientCapabilities,
      () => this.#peer,
      this.#urlElicitations,
    );
    const record: ActiveSession = {
      stored: structuredClone(stored),
      history: MessageHistory.fromSnapshot(stored.history),
      mcpClients: connected.clients,
      mcpTools: connected.tools,
      clientTools: this.#makeClientTools(client),
      client,
      persistentPermissions: new Map(),
      activeController: null,
      activeDone: null,
    };
    this.#sessions.set(stored.sessionId, record);
    await this.#announce(record);
    return record;
  }
  async #announce(record: ActiveSession): Promise<void> {
    if (this.#opts.commands) {
      await record.client.update({
        sessionUpdate: 'available_commands_update',
        availableCommands: structuredClone(this.#opts.commands),
      });
    }
    if (record.stored.modes) {
      await record.client.update({
        sessionUpdate: 'current_mode_update',
        currentModeId: record.stored.modes.currentModeId,
      });
    }
    const configs = filterConfigOptions(record.stored.configOptions, this.#clientCapabilities);
    if (configs.length > 0) {
      await record.client.update({ sessionUpdate: 'config_option_update', configOptions: configs });
    }
  }
  async #persist(record: ActiveSession): Promise<void> {
    const previousHistoryRevisionId = record.stored.history.head;
    const storeVersion = record.stored.storeVersion;
    if (storeVersion === undefined) throw new Error('ACP session has no backing-store version');
    record.stored = await this.#commitStored(
      { ...record.stored, updatedAt: new Date().toISOString() },
      record.history,
      storeVersion,
      previousHistoryRevisionId,
    );
  }
  async #newSession(params: unknown, ctx: RequestContext): Promise<Record<string, unknown>> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/new params');
    const cwd = requireAbsolutePath(value.cwd, 'cwd');
    const additionalDirectories = parseAbsolutePaths(
      value.additionalDirectories,
      'additionalDirectories',
    );
    if (!Array.isArray(value.mcpServers)) invalidParams('mcpServers must be an array');
    const servers = value.mcpServers.map(parseMcpServer);
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    const now = new Date(createdAt).toISOString();
    const history = new MessageHistory();
    const stored = await this.#commitStored(
      {
        sessionId,
        cwd,
        additionalDirectories,
        createdAt,
        updatedAt: now,
        history: history.toSnapshot(),
        ...(this.#opts.modes ? { modes: structuredClone(this.#opts.modes) } : {}),
        configOptions: structuredClone(this.#opts.configOptions ?? []),
        usage: emptyUsage(),
        ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
      },
      history,
      null,
    );
    try {
      const record = await this.#activate(stored, servers);
      return { sessionId, ...sessionResponse(record, this.#clientCapabilities) };
    } catch (error) {
      await deleteConversationThread(this.#store, sessionId).catch(() => {});
      throw error;
    }
  }
  async #loadSession(
    params: unknown,
    replay: boolean,
    ctx: RequestContext,
  ): Promise<Record<string, unknown>> {
    await this.#assertAuthenticated(ctx.signal);
    const method = replay ? 'session/load' : 'session/resume';
    const value = requireRecord(params, `${method} params`);
    const sessionId = requireString(value.sessionId, 'sessionId');
    const cwd = requireAbsolutePath(value.cwd, 'cwd');
    const stored = await this.#loadStored(sessionId);
    if (!stored) throw new JsonRpcError(`Unknown session: ${sessionId}`, ACP_RESOURCE_NOT_FOUND);
    if (stored.cwd !== cwd) invalidParams('cwd does not match the stored session');
    const additionalDirectories = parseAbsolutePaths(
      value.additionalDirectories,
      'additionalDirectories',
    );
    const servers =
      value.mcpServers === undefined
        ? []
        : Array.isArray(value.mcpServers)
          ? value.mcpServers.map(parseMcpServer)
          : invalidParams('mcpServers must be an array');
    stored.additionalDirectories = additionalDirectories;
    const record = await this.#activate(stored, servers);
    await this.#persist(record);
    if (replay) await this.#replay(record);
    return sessionResponse(record, this.#clientCapabilities);
  }
  async #replay(record: ActiveSession): Promise<void> {
    for (const entry of record.history.refs()) {
      const message = entry.message;
      const messageId = entry.id;
      const parts =
        typeof message.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : message.content;
      if (message.role === 'assistant') {
        for (const part of parts) {
          if (part.type === 'tool_use') {
            await record.client.update({
              sessionUpdate: 'tool_call',
              toolCallId: part.id,
              title: part.name,
              kind: inferToolKind(part.name),
              status: 'in_progress',
              rawInput: part.args,
            });
          } else {
            await record.client.update({
              sessionUpdate: 'agent_message_chunk',
              content: modelPartToAcp(part),
              messageId,
            });
          }
        }
      } else if (message.role === 'user') {
        for (const part of parts) {
          if (part.type === 'tool_result') {
            const output = typeof part.content === 'string' ? part.content : part.content;
            await record.client.update({
              sessionUpdate: 'tool_call_update',
              toolCallId: part.toolCallId,
              status: part.isError ? 'failed' : 'completed',
              content: toolContent(output),
              rawOutput: output,
            });
          } else {
            await record.client.update({
              sessionUpdate: 'user_message_chunk',
              content: modelPartToAcp(part),
              messageId,
            });
          }
        }
      }
    }
  }
  async #listSessions(params: unknown, ctx: RequestContext): Promise<Record<string, unknown>> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params ?? {}, 'session/list params');
    const cwd =
      value.cwd === undefined || value.cwd === null
        ? undefined
        : requireAbsolutePath(value.cwd, 'cwd');
    const cursor =
      value.cursor === undefined || value.cursor === null
        ? undefined
        : requireString(value.cursor, 'cursor');
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== (cursor ?? '0')) {
      invalidParams('Invalid session list cursor');
    }
    const sessions = (await listConversationThreads(this.#store))
      .map((thread) => {
        const metadata = acpThreadMetadata(thread.metadata);
        if (!metadata) return null;
        return {
          sessionId: thread.threadId,
          cwd: metadata.cwd,
          additionalDirectories: [...metadata.additionalDirectories],
          ...(metadata.title !== undefined ? { title: metadata.title } : {}),
          updatedAt: new Date(thread.updatedAt).toISOString(),
          ...(metadata._meta !== undefined ? { _meta: structuredClone(metadata._meta) } : {}),
        };
      })
      .filter((session): session is NonNullable<typeof session> => session !== null)
      .filter((session) => cwd === undefined || session.cwd === cwd);
    const page = sessions.slice(offset, offset + this.#sessionListPageSize);
    const next = offset + page.length;
    return {
      sessions: page,
      ...(next < sessions.length ? { nextCursor: String(next) } : {}),
    };
  }
  async #deleteSession(params: unknown, ctx: RequestContext): Promise<Record<string, never>> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/delete params');
    const sessionId = requireString(value.sessionId, 'sessionId');
    if (!(await this.#loadStored(sessionId))) {
      throw new JsonRpcError(`Unknown session: ${sessionId}`, ACP_RESOURCE_NOT_FOUND);
    }
    await this.#closeActive(sessionId);
    if (!(await deleteConversationThread(this.#store, sessionId))) {
      throw new JsonRpcError(`Unknown session: ${sessionId}`, ACP_RESOURCE_NOT_FOUND);
    }
    return {};
  }
  async #closeSession(params: unknown, ctx: RequestContext): Promise<Record<string, never>> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/close params');
    const sessionId = requireString(value.sessionId, 'sessionId');
    if (!this.#sessions.has(sessionId)) {
      throw new JsonRpcError(`Session is not active: ${sessionId}`, ACP_RESOURCE_NOT_FOUND);
    }
    await this.#closeActive(sessionId);
    return {};
  }
  #context(record: ActiveSession): AcpAgentContext {
    return {
      sessionId: record.stored.sessionId,
      cwd: record.stored.cwd,
      additionalDirectories: [...record.stored.additionalDirectories],
      ...(record.stored.modes ? { modeId: record.stored.modes.currentModeId } : {}),
      configOptions: structuredClone(record.stored.configOptions),
      client: record.client,
    };
  }
  async #setMode(params: unknown, ctx: RequestContext): Promise<Record<string, never>> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/set_mode params');
    const record = this.#requireSession(requireString(value.sessionId, 'sessionId'));
    const modeId = requireString(value.modeId, 'modeId');
    if (!record.stored.modes)
      throw new JsonRpcError('Session modes are not configured', INVALID_REQUEST);
    if (!record.stored.modes.availableModes.some((mode) => mode.id === modeId)) {
      invalidParams(`Unknown session mode: ${modeId}`);
    }
    record.stored.modes.currentModeId = modeId;
    await this.#opts.onModeChange?.(this.#context(record), modeId);
    await this.#persist(record);
    await record.client.update({ sessionUpdate: 'current_mode_update', currentModeId: modeId });
    return {};
  }
  async #setConfigOption(
    params: unknown,
    ctx: RequestContext,
  ): Promise<{ configOptions: AcpSessionConfigOption[] }> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/set_config_option params');
    const record = this.#requireSession(requireString(value.sessionId, 'sessionId'));
    const configId = requireString(value.configId, 'configId');
    const index = record.stored.configOptions.findIndex((option) => option.id === configId);
    if (index < 0) invalidParams(`Unknown session configuration: ${configId}`);
    const current = record.stored.configOptions[index]!;
    let next: AcpSessionConfigOption;
    if (current.type === 'boolean') {
      if (!supportsBooleanConfig(this.#clientCapabilities)) {
        throw new JsonRpcError(
          'Client did not negotiate boolean session configuration',
          INVALID_REQUEST,
        );
      }
      if (value.type !== 'boolean' || typeof value.value !== 'boolean') {
        invalidParams(`${configId} requires a boolean value`);
      }
      next = { ...current, currentValue: value.value };
    } else {
      const selected = requireString(value.value, 'value');
      const values = current.options.flatMap((option) =>
        'options' in option ? option.options : [option],
      );
      if (!values.some((option) => option.value === selected))
        invalidParams(`Unknown value for ${configId}: ${selected}`);
      next = { ...current, currentValue: selected };
    }
    record.stored.configOptions[index] = next;
    await this.#opts.onConfigOptionChange?.(this.#context(record), structuredClone(next));
    await this.#persist(record);
    const visible = filterConfigOptions(record.stored.configOptions, this.#clientCapabilities);
    await record.client.update({ sessionUpdate: 'config_option_update', configOptions: visible });
    return { configOptions: visible };
  }
  #requireSession(sessionId: string): ActiveSession {
    const record = this.#sessions.get(sessionId);
    if (!record)
      throw new JsonRpcError(`Session is not active: ${sessionId}`, ACP_RESOURCE_NOT_FOUND);
    return record;
  }
  async #agentFor(record: ActiveSession): Promise<Agent> {
    return typeof this.#opts.agent === 'function'
      ? await this.#opts.agent(this.#context(record))
      : this.#opts.agent;
  }
  async #requestPermission(
    record: ActiveSession,
    request: ToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string }> {
    const remembered = record.persistentPermissions.get(request.toolName);
    if (remembered !== undefined)
      return remembered ? { approved: true } : { approved: false, reason: 'always rejected' };
    const response = (await this.#requirePeer().call(
      'session/request_permission',
      {
        sessionId: record.stored.sessionId,
        toolCall: {
          toolCallId: request.toolCallId,
          title: request.toolName,
          kind: inferToolKind(request.toolName),
          status: 'pending',
          rawInput: request.args,
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
        ],
      },
      { signal },
    )) as { outcome?: { outcome?: unknown; optionId?: unknown } };
    if (response.outcome?.outcome === 'cancelled') throw abortError('Permission request cancelled');
    if (response.outcome?.outcome !== 'selected' || typeof response.outcome.optionId !== 'string') {
      throw new JsonRpcError('Invalid permission response', INTERNAL_ERROR);
    }
    switch (response.outcome.optionId) {
      case 'allow_once':
        return { approved: true };
      case 'allow_always':
        record.persistentPermissions.set(request.toolName, true);
        return { approved: true };
      case 'reject_once':
        return { approved: false, reason: 'rejected by user' };
      case 'reject_always':
        record.persistentPermissions.set(request.toolName, false);
        return { approved: false, reason: 'always rejected by user' };
      default:
        throw new JsonRpcError('Unknown permission option', INTERNAL_ERROR);
    }
  }
  #requirePeer(): JsonRpcPeer {
    if (!this.#peer) throw connectionClosed();
    return this.#peer;
  }
  async #event(record: ActiveSession, event: AgentEvent): Promise<void> {
    if (event.type === 'model_event' && event.event.type === 'text_delta') {
      await record.client.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.event.text },
      });
    } else if (event.type === 'tool_start') {
      await record.client.update({
        sessionUpdate: 'tool_call',
        toolCallId: event.id,
        title: event.name,
        kind: inferToolKind(event.name),
        status: event.awaitingApproval ? 'pending' : 'in_progress',
        rawInput: event.args,
      });
    } else if (event.type === 'tool_result') {
      await record.client.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: event.isError ? 'failed' : 'completed',
        content: toolContent(event.result),
        rawOutput: event.result,
      });
    } else if (event.type === 'tool_error') {
      await record.client.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: event.message } }],
        rawOutput: { error: event.message },
      });
    }
  }
  async #prompt(params: unknown, ctx: RequestContext): Promise<{ stopReason: string }> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/prompt params');
    const record = this.#requireSession(requireString(value.sessionId, 'sessionId'));
    if (!Array.isArray(value.prompt)) invalidParams('prompt must be an array');
    const prompt = value.prompt.map(parseContent);
    if (record.activeController)
      throw new JsonRpcError('Session already has an active prompt', INVALID_REQUEST);
    const controller = new AbortController();
    record.activeController = controller;
    let markDone!: () => void;
    record.activeDone = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const signal = AbortSignal.any([controller.signal, ctx.signal]);
    let execution: ReturnType<Agent['createSession']> | null = null;
    let resultPromise: Promise<unknown> | null = null;
    try {
      const definition = await this.#agentFor(record);
      execution = definition.createSession({
        history: record.history,
        tools: [...record.mcpTools, ...record.clientTools],
        requestToolApproval: (request, requestContext) =>
          this.#requestPermission(record, request, requestContext.signal),
      });
      const stream = execution.stream({ messages: [promptMessage(prompt)], signal });
      resultPromise = stream.result;
      for await (const event of stream.reader) await this.#event(record, event);
      const result = await stream.result;
      record.history = execution.history;
      record.stored.usage = addUsage(record.stored.usage, result.usage);
      if (result.cost !== undefined) record.stored.cost = (record.stored.cost ?? 0) + result.cost;
      if (!record.stored.title) {
        const firstText = prompt.find((block): block is AcpTextContent => block.type === 'text');
        if (firstText) record.stored.title = firstText.text.slice(0, 80);
      }
      await this.#persist(record);
      if (this.#opts.contextWindowSize !== undefined) {
        await record.client.update({
          sessionUpdate: 'usage_update',
          used: record.history.estimateTokens(),
          size: this.#opts.contextWindowSize,
          ...(record.stored.cost !== undefined
            ? { cost: { amount: record.stored.cost, currency: 'USD' } }
            : {}),
        });
      }
      await record.client.update({
        sessionUpdate: 'session_info_update',
        ...(record.stored.title ? { title: record.stored.title } : {}),
        updatedAt: record.stored.updatedAt,
      });
      return { stopReason: acpStopReason(result.stopReason) };
    } catch (error) {
      await resultPromise?.catch(() => {});
      if (execution) record.history = execution.history;
      if (
        controller.signal.aborted ||
        ctx.signal.aborted ||
        (error as Error)?.name === 'AbortError'
      ) {
        await this.#persist(record);
        return { stopReason: 'cancelled' };
      }
      throw error;
    } finally {
      execution?.close();
      if (record.activeController === controller) record.activeController = null;
      markDone();
      record.activeDone = null;
    }
  }
  async #cancel(params: unknown, ctx: RequestContext): Promise<void> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/cancel params');
    const sessionId = requireString(value.sessionId, 'sessionId');
    this.#sessions.get(sessionId)?.activeController?.abort(abortError('ACP prompt cancelled'));
  }
  async #closeActive(sessionId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    this.#sessions.delete(sessionId);
    record.activeController?.abort(abortError('ACP session closed'));
    await record.activeDone?.catch(() => {});
    await Promise.all(record.mcpClients.map((client) => client.close().catch(() => {})));
  }
  async #closeSessions(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.#closeActive(id)));
    this.#urlElicitations.clear();
  }
  /** Serve one bidirectional ACP connection until EOF. */
  async serve(transport: Transport): Promise<void> {
    if (this.#peer) throw new Error('AcpServer is already serving a connection');
    this.#initialized = false;
    this.#authenticated = this.#opts.authentication === undefined;
    this.#clientInfo = undefined;
    this.#clientCapabilities = normalizeClientCapabilities({});
    const peer = new JsonRpcPeer(transport, this.#service());
    this.#peer = peer;
    try {
      await peer.done;
    } finally {
      await this.#closeSessions();
      if (this.#peer === peer) this.#peer = null;
      this.#initialized = false;
    }
  }
  /** Close the active connection and its live resources; persisted sessions remain. */
  async close(): Promise<void> {
    const peer = this.#peer;
    if (peer) await peer.close();
    await this.#closeSessions();
    if (this.#peer === peer) this.#peer = null;
    this.#initialized = false;
  }
}

/** Create a complete stable ACP v1 server. */
export function acpServer(opts: AcpServerOptions): AcpServer {
  return new AcpServer(opts);
}
