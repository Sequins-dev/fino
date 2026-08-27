/**
 * fino:ai/acp — complete Agent Client Protocol v1 agent adapter.
 *
 * Useful references:
 *
 * - ACP v1 overview: https://agentclientprotocol.com/protocol/v1/overview
 * - Initialization: https://agentclientprotocol.com/protocol/v1/initialization
 * - Session lifecycle: https://agentclientprotocol.com/protocol/v1/session-setup
 * - Content: https://agentclientprotocol.com/protocol/v1/content
 * - Elicitation: https://agentclientprotocol.com/protocol/v1/elicitation
 * - Cancellation: https://agentclientprotocol.com/protocol/v1/cancellation
 * - Stable schema audited at ae596e1: https://github.com/agentclientprotocol/agent-client-protocol/blob/ae596e13351e1196b8b83b73f19beca51355732e/schema/v1/schema.json
 *
 * `AcpServer` implements every stable ACP v1 method, notification, content
 * variant, MCP transport, session update, and extension point. Capabilities
 * remain negotiated as ACP requires: application-policy features such as
 * authentication, modes, configuration, commands, and custom extensions are
 * advertised when their backing option is configured. Session lifecycle,
 * additional roots, rich prompts, HTTP/SSE MCP, and automatic client tools
 * are supported by default.
 *
 * Each prompt uses a fresh `AgentSession` seeded from immutable persisted
 * history. Active sessions own MCP connections and cancellation; stored
 * records survive `session/close` and connection shutdown. The default store
 * is in-memory, and `AcpSessionStore` permits a durable backend.
 *
 * ```ts no_run
 * import { acpServer, acpStdioTransport } from 'fino:ai/acp';
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 *
 * await acpServer({
 *   agent: agent({ model: openai({ model: 'gpt-4o' }) }),
 * }).serve(acpStdioTransport());
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
import type { RequestContext, Transport } from 'fino:jsonrpc';
import type { Agent, AgentEvent } from 'fino:ai/agent';
import type { ToolApprovalRequest } from 'fino:ai/runtime';
import type { ContentPart, ModelMessage, StopReason, Usage } from 'fino:ai/model';
import { MessageHistory } from 'fino:ai/context';
import type { MessageHistorySnapshot } from 'fino:ai/context';
import {
  MCPClient,
  httpTransport as mcpHttpTransport,
  sseTransport as mcpSseTransport,
  stdioTransport as mcpStdioTransport,
} from 'fino:ai/mcp';
import { tool } from 'fino:ai/tool';
import type { Tool } from 'fino:ai/tool';

/** ACP major protocol version implemented by this module. */
export const ACP_PROTOCOL_VERSION = 1;
/** ACP authentication-required error code. */
export const ACP_AUTH_REQUIRED = -32000;
/** ACP resource-not-found error code. */
export const ACP_RESOURCE_NOT_FOUND = -32002;
/** Extension metadata reserved by ACP. */
export type AcpMeta = Record<string, unknown> | null;

/** ACP content display annotations. */
export interface AcpAnnotations {
  /** Intended content audiences. */
  audience?: Array<'assistant' | 'user'>;
  /** Relative display priority. */
  priority?: number;
  /** ISO 8601 last-modified timestamp. */
  lastModified?: string;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP text content. */
export interface AcpTextContent {
  /** Content discriminant. */
  type: 'text';
  /** Markdown-compatible text. */
  text: string;
  /** Optional display annotations. */
  annotations?: AcpAnnotations | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP image content with base64 bytes. */
export interface AcpImageContent {
  /** Content discriminant. */
  type: 'image';
  /** Base64-encoded image bytes. */
  data: string;
  /** Image MIME type. */
  mimeType: string;
  /** Optional source URI. */
  uri?: string | null;
  /** Optional display annotations. */
  annotations?: AcpAnnotations | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP audio content with base64 bytes. */
export interface AcpAudioContent {
  /** Content discriminant. */
  type: 'audio';
  /** Base64-encoded audio bytes. */
  data: string;
  /** Audio MIME type. */
  mimeType: string;
  /** Optional display annotations. */
  annotations?: AcpAnnotations | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Text resource embedded directly in content. */
export interface AcpTextResource {
  /** Resource URI. */
  uri: string;
  /** Embedded text. */
  text: string;
  /** Optional text MIME type. */
  mimeType?: string | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Binary resource embedded directly in content. */
export interface AcpBlobResource {
  /** Resource URI. */
  uri: string;
  /** Base64-encoded resource bytes. */
  blob: string;
  /** Optional binary MIME type. */
  mimeType?: string | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP embedded-resource content. */
export interface AcpEmbeddedResource {
  /** Content discriminant. */
  type: 'resource';
  /** Embedded text or binary resource. */
  resource: AcpTextResource | AcpBlobResource;
  /** Optional display annotations. */
  annotations?: AcpAnnotations | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP resource-link content. */
export interface AcpResourceLink {
  /** Content discriminant. */
  type: 'resource_link';
  /** Resource name. */
  name: string;
  /** Resource URI. */
  uri: string;
  /** Optional display title. */
  title?: string | null;
  /** Optional resource description. */
  description?: string | null;
  /** Optional resource MIME type. */
  mimeType?: string | null;
  /** Optional resource size in bytes. */
  size?: number | null;
  /** Optional display annotations. */
  annotations?: AcpAnnotations | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Every stable ACP v1 content block. */
export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpAudioContent
  | AcpEmbeddedResource
  | AcpResourceLink;
/** Content accepted by `session/prompt`. */
export type AcpPromptContent = AcpContentBlock;

/** ACP name/value environment entry. */
export interface AcpEnvVariable {
  /** Environment variable name. */
  name: string;
  /** Environment variable value. */
  value: string;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP name/value HTTP header. */
export interface AcpHttpHeader {
  /** Header name. */
  name: string;
  /** Header value. */
  value: string;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP stdio MCP descriptor. */
export interface AcpMcpServerStdio {
  /** Human-readable server name. */
  name: string;
  /** Absolute executable path. */
  command: string;
  /** Process arguments. */
  args: string[];
  /** Process environment overrides. */
  env: AcpEnvVariable[];
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP Streamable HTTP MCP descriptor. */
export interface AcpMcpServerHttp {
  /** Transport discriminant. */
  type: 'http';
  /** Human-readable server name. */
  name: string;
  /** Streamable HTTP endpoint. */
  url: string;
  /** Request headers. */
  headers: AcpHttpHeader[];
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP legacy HTTP+SSE MCP descriptor. */
export interface AcpMcpServerSse {
  /** Transport discriminant. */
  type: 'sse';
  /** Human-readable server name. */
  name: string;
  /** Legacy SSE endpoint. */
  url: string;
  /** Request headers. */
  headers: AcpHttpHeader[];
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Every stable ACP v1 MCP server descriptor. */
export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

/** Client capabilities negotiated during initialization. */
export interface AcpClientCapabilities {
  /** Client-hosted filesystem operations. */
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
    _meta?: AcpMeta;
  };
  /** Whether client-hosted terminals are available. */
  terminal?: boolean;
  /** Client authentication capabilities. */
  auth?: { terminal?: boolean; _meta?: AcpMeta };
  /** Structured user-input capabilities. */
  elicitation?: {
    form?: Record<string, unknown> | null;
    url?: Record<string, unknown> | null;
    _meta?: AcpMeta;
  } | null;
  /** Session-level client capabilities. */
  session?: {
    configOptions?: {
      boolean?: Record<string, unknown> | null;
      _meta?: AcpMeta;
    } | null;
    _meta?: AcpMeta;
  } | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Implementation identity exchanged during initialization. */
export interface AcpImplementation {
  /** Machine-readable implementation name. */
  name: string;
  /** Optional display title. */
  title?: string | null;
  /** Implementation version. */
  version: string;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Agent-managed authentication method. */
export interface AcpAuthMethodAgent {
  /** Authentication method id. */
  id: string;
  /** Display name. */
  name: string;
  /** Agent-managed method discriminant. */
  type?: 'agent';
  /** Optional instructions. */
  description?: string | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Client-launched interactive authentication method. */
export interface AcpAuthMethodTerminal {
  /** Authentication method id. */
  id: string;
  /** Display name. */
  name: string;
  /** Client-launched method discriminant. */
  type: 'terminal';
  /** Optional instructions. */
  description?: string | null;
  /** Arguments appended to the configured agent command. */
  args?: string[];
  /** Environment overrides for the authentication process. */
  env?: Record<string, string>;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP authentication method. */
export type AcpAuthMethod = AcpAuthMethodAgent | AcpAuthMethodTerminal;

/** One stable ACP legacy session mode. */
export interface AcpSessionMode {
  /** Mode id. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional mode description. */
  description?: string | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Current and available session modes. */
export interface AcpSessionModeState {
  /** Selected mode id. */
  currentModeId: string;
  /** Modes available in the session. */
  availableModes: AcpSessionMode[];
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** One select configuration value. */
export interface AcpSessionConfigSelectOption {
  /** Wire value id. */
  value: string;
  /** Display name. */
  name: string;
  /** Optional value description. */
  description?: string | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Grouped select configuration values. */
export interface AcpSessionConfigSelectGroup {
  /** Group id. */
  group: string;
  /** Display name. */
  name: string;
  /** Values in this group. */
  options: AcpSessionConfigSelectOption[];
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP select session configuration. */
export interface AcpSessionConfigSelect {
  /** Configuration type discriminant. */
  type: 'select';
  /** Configuration id. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional configuration description. */
  description?: string | null;
  /** Standard or custom UI category. */
  category?: 'mode' | 'model' | 'thought_level' | string | null;
  /** Selected value id. */
  currentValue: string;
  /** Available values and groups. */
  options: Array<AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup>;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP boolean session configuration. */
export interface AcpSessionConfigBoolean {
  /** Configuration type discriminant. */
  type: 'boolean';
  /** Configuration id. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional configuration description. */
  description?: string | null;
  /** Standard or custom UI category. */
  category?: 'mode' | 'model' | 'thought_level' | string | null;
  /** Current boolean value. */
  currentValue: boolean;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Every stable ACP v1 session configuration option. */
export type AcpSessionConfigOption = AcpSessionConfigSelect | AcpSessionConfigBoolean;
/** Slash-command descriptor. */
export interface AcpAvailableCommand {
  /** Slash-command name without a leading slash. */
  name: string;
  /** Command description. */
  description: string;
  /** Optional input hint. */
  input?: { hint: string; _meta?: AcpMeta } | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP tool display category. */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';
/** ACP execution-plan entry. */
export interface AcpPlanEntry {
  /** Plan step text. */
  content: string;
  /** Relative step priority. */
  priority: 'high' | 'medium' | 'low';
  /** Current step state. */
  status: 'pending' | 'in_progress' | 'completed';
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** File location affected by an ACP tool call. */
export interface AcpToolCallLocation {
  /** Absolute file path. */
  path: string;
  /** Optional zero-based line number. */
  line?: number | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Content displayed beneath an ACP tool call. */
export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock; _meta?: AcpMeta }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string; _meta?: AcpMeta }
  | { type: 'terminal'; terminalId: string; _meta?: AcpMeta };
/** Every stable ACP v1 session-update shape. */
export type AcpSessionUpdate =
  | {
      sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
      content: AcpContentBlock;
      messageId?: string | null;
      _meta?: AcpMeta;
    }
  | {
      sessionUpdate: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: AcpToolKind | null;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
      content?: AcpToolCallContent[] | null;
      locations?: AcpToolCallLocation[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      _meta?: AcpMeta;
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      title?: string | null;
      kind?: AcpToolKind | null;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
      content?: AcpToolCallContent[] | null;
      locations?: AcpToolCallLocation[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
      _meta?: AcpMeta;
    }
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[]; _meta?: AcpMeta }
  | {
      sessionUpdate: 'available_commands_update';
      availableCommands: AcpAvailableCommand[];
      _meta?: AcpMeta;
    }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string; _meta?: AcpMeta }
  | {
      sessionUpdate: 'config_option_update';
      configOptions: AcpSessionConfigOption[];
      _meta?: AcpMeta;
    }
  | {
      sessionUpdate: 'session_info_update';
      title?: string | null;
      updatedAt?: string | null;
      _meta?: AcpMeta;
    }
  | {
      sessionUpdate: 'usage_update';
      used: number;
      size: number;
      cost?: { amount: number; currency: string; _meta?: AcpMeta } | null;
      _meta?: AcpMeta;
    };

/** Terminal creation options excluding the bound session id. */
export interface AcpCreateTerminalOptions {
  /** Command to execute. */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Environment overrides. */
  env?: AcpEnvVariable[];
  /** Absolute working directory. */
  cwd?: string | null;
  /** Maximum retained output bytes. */
  outputByteLimit?: number | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Terminal output and optional exit status. */
export interface AcpTerminalOutput {
  /** Captured terminal output. */
  output: string;
  /** Whether leading output was truncated. */
  truncated: boolean;
  /** Process status when it has exited. */
  exitStatus?: {
    exitCode?: number | null;
    signal?: string | null;
    _meta?: AcpMeta;
  } | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Implementation-specific elicitation request. */
export interface AcpCustomElicitationRequest extends Record<string, unknown> {
  /** Underscore-prefixed extension mode. */
  mode: `_${string}`;
  /** Human-readable request. */
  message: string;
  /** Session scope, when applicable. */
  sessionId?: string;
  /** Tool-call scope, when applicable. */
  toolCallId?: string | null;
  /** Non-session request scope, when applicable. */
  requestId?: number | string | null;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** ACP form, URL, or implementation-specific elicitation request. */
export type AcpElicitationRequest =
  | {
      mode: 'form';
      message: string;
      requestedSchema: Record<string, unknown>;
      sessionId?: string;
      toolCallId?: string | null;
      requestId?: number | string | null;
      _meta?: AcpMeta;
    }
  | {
      mode: 'url';
      message: string;
      elicitationId: string;
      url: string;
      sessionId?: string;
      toolCallId?: string | null;
      requestId?: number | string | null;
      _meta?: AcpMeta;
    }
  | AcpCustomElicitationRequest;
/** ACP elicitation result. */
export type AcpElicitationResponse =
  | { action: 'accept'; content?: Record<string, unknown> | null; _meta?: AcpMeta }
  | { action: 'decline' | 'cancel'; _meta?: AcpMeta }
  | ({ action: string; _meta?: AcpMeta } & Record<string, unknown>);

/** Serializable session record used by `AcpSessionStore`. */
export interface AcpStoredSession {
  /** Stable ACP session id. */
  sessionId: string;
  /** Absolute working directory. */
  cwd: string;
  /** Additional absolute workspace roots. */
  additionalDirectories: string[];
  /** Optional display title. */
  title?: string;
  /** ISO 8601 last-activity timestamp. */
  updatedAt: string;
  /** Serializable immutable message history. */
  history: MessageHistorySnapshot;
  /** Session mode state, when configured. */
  modes?: AcpSessionModeState;
  /** Current session configuration. */
  configOptions: AcpSessionConfigOption[];
  /** Cumulative model usage. */
  usage: Usage;
  /** Cumulative cost in USD, when available. */
  cost?: number;
  /** Optimistic store revision. */
  revision: number;
  /** Opaque extension metadata. */
  _meta?: AcpMeta;
}
/** Cursor page returned by an ACP session store. */
export interface AcpStoredSessionPage {
  /** Stored sessions in this page. */
  sessions: AcpStoredSession[];
  /** Cursor for the next page. */
  nextCursor?: string;
}
/** Persistence contract for ACP session lifecycle methods. */
export interface AcpSessionStore {
  /** Load one session, or return `null` when absent. */
  load(sessionId: string): Promise<AcpStoredSession | null>;
  /** List one cursor page, optionally filtered by working directory. */
  list(opts: { cwd?: string; cursor?: string }): Promise<AcpStoredSessionPage>;
  /** Atomically save if `expectedRevision` still matches. */
  save(session: AcpStoredSession, expectedRevision: number | null): Promise<AcpStoredSession>;
  /** Delete one stored session and report whether it existed. */
  delete(sessionId: string): Promise<boolean>;
}
/** Raised when concurrent servers update one stored ACP session. */
export class AcpSessionConflictError extends Error {
  /** Conflicting session id. */
  sessionId: string;
  /** Revision expected by the writer. */
  expectedRevision: number | null;
  /** Revision currently in the store. */
  actualRevision: number | null;
  /** Create an optimistic concurrency error. */
  constructor(sessionId: string, expectedRevision: number | null, actualRevision: number | null) {
    super(
      `ACP session ${sessionId} changed from ${expectedRevision ?? '<new>'} to ${actualRevision ?? '<new>'}`,
    );
    this.name = 'AcpSessionConflictError';
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}
function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
/** In-memory ACP persistence with cursor pages and optimistic commits. */
export class InMemoryAcpSessionStore implements AcpSessionStore {
  #sessions = new Map<string, AcpStoredSession>();
  #pageSize: number;
  /** Create a store with at most `pageSize` records per list response. */
  constructor(pageSize = 50) {
    if (!Number.isInteger(pageSize) || pageSize <= 0)
      throw new RangeError('pageSize must be positive');
    this.#pageSize = pageSize;
  }
  /** Load a defensive copy of one stored session. */
  async load(sessionId: string): Promise<AcpStoredSession | null> {
    const value = this.#sessions.get(sessionId);
    return value ? cloneValue(value) : null;
  }
  /** List a deterministic, newest-first cursor page. */
  async list(opts: { cwd?: string; cursor?: string }): Promise<AcpStoredSessionPage> {
    const offset = opts.cursor === undefined ? 0 : Number(opts.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== (opts.cursor ?? '0')) {
      throw new JsonRpcError('Invalid session list cursor', INVALID_PARAMS);
    }
    const sessions = [...this.#sessions.values()]
      .filter((session) => opts.cwd === undefined || session.cwd === opts.cwd)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const page = sessions.slice(offset, offset + this.#pageSize).map(cloneValue);
    const next = offset + page.length;
    return {
      sessions: page,
      ...(next < sessions.length ? { nextCursor: String(next) } : {}),
    };
  }
  /** Save with optimistic revision checking and return the committed copy. */
  async save(
    session: AcpStoredSession,
    expectedRevision: number | null,
  ): Promise<AcpStoredSession> {
    const current = this.#sessions.get(session.sessionId);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== expectedRevision) {
      throw new AcpSessionConflictError(session.sessionId, expectedRevision, actualRevision);
    }
    const saved = cloneValue({ ...session, revision: (actualRevision ?? 0) + 1 });
    this.#sessions.set(saved.sessionId, saved);
    return cloneValue(saved);
  }
  /** Delete a stored session. */
  async delete(sessionId: string): Promise<boolean> {
    return this.#sessions.delete(sessionId);
  }
}

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
  /** Durable session backend; defaults to isolated in-memory storage. */
  store?: AcpSessionStore;
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
function requireAbsolutePath(value: unknown, name: string): string {
  const path = requireString(value, name);
  if (!path.startsWith('/')) invalidParams(`${name} must be an absolute path`);
  return path;
}
function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidParams(`${name} must be an array of strings`);
  }
  return [...(value as string[])];
}
function parseAbsolutePaths(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  return parseStringArray(value, name).map((path, index) =>
    requireAbsolutePath(path, `${name}[${index}]`),
  );
}
function parsePairs(
  value: unknown,
  name: string,
): Array<{ name: string; value: string; _meta?: AcpMeta }> {
  if (!Array.isArray(value)) invalidParams(`${name} must be an array`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = requireRecord(raw, `${name}[${index}]`);
    const pairName = requireString(item.name, `${name}[${index}].name`);
    if (seen.has(pairName)) invalidParams(`${name} contains duplicate ${pairName}`);
    seen.add(pairName);
    return {
      name: pairName,
      value: requireString(item.value, `${name}[${index}].value`),
      ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
    };
  });
}
function parseUrl(value: unknown, name: string): string {
  const url = requireString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalidParams(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    invalidParams(`${name} must use HTTP or HTTPS`);
  }
  return url;
}
function parseMcpServer(value: unknown, index: number): AcpMcpServer {
  const server = requireRecord(value, `mcpServers[${index}]`);
  const name = requireString(server.name, `mcpServers[${index}].name`);
  if (server.type === 'http' || server.type === 'sse') {
    return {
      type: server.type,
      name,
      url: parseUrl(server.url, `mcpServers[${index}].url`),
      headers: parsePairs(server.headers, `mcpServers[${index}].headers`),
      ...(isRecord(server._meta) ? { _meta: server._meta } : {}),
    };
  }
  if (server.type !== undefined) invalidParams(`mcpServers[${index}].type is unsupported`);
  return {
    name,
    command: requireAbsolutePath(server.command, `mcpServers[${index}].command`),
    args: parseStringArray(server.args, `mcpServers[${index}].args`),
    env: parsePairs(server.env ?? [], `mcpServers[${index}].env`),
    ...(isRecord(server._meta) ? { _meta: server._meta } : {}),
  };
}
function parseContent(value: unknown, index: number): AcpContentBlock {
  const name = `prompt[${index}]`;
  const block = requireRecord(value, name);
  switch (block.type) {
    case 'text':
      requireString(block.text, `${name}.text`);
      break;
    case 'image':
    case 'audio':
      requireString(block.data, `${name}.data`);
      requireString(block.mimeType, `${name}.mimeType`);
      break;
    case 'resource': {
      const resource = requireRecord(block.resource, `${name}.resource`);
      requireString(resource.uri, `${name}.resource.uri`);
      const hasText = typeof resource.text === 'string';
      const hasBlob = typeof resource.blob === 'string';
      if (hasText === hasBlob) {
        invalidParams(`${name}.resource must contain exactly one of text or blob`);
      }
      break;
    }
    case 'resource_link':
      requireString(block.name, `${name}.name`);
      requireString(block.uri, `${name}.uri`);
      break;
    default:
      invalidParams(`${name}.type is not supported`);
  }
  return cloneValue(block) as AcpContentBlock;
}
function promptMessage(blocks: AcpContentBlock[]): ModelMessage {
  const content: ContentPart[] = blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
        return { type: 'image', mediaType: block.mimeType, data: block.data };
      case 'audio':
        return { type: 'audio', mediaType: block.mimeType, data: block.data };
      case 'resource':
        if ('text' in block.resource) {
          return {
            type: 'text',
            text: `<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`,
          };
        }
        return {
          type: 'document',
          mediaType: block.resource.mimeType ?? 'application/octet-stream',
          data: block.resource.blob,
          name: block.resource.uri,
        };
      case 'resource_link': {
        const label = block.title ?? block.name;
        const description = block.description ? ` — ${block.description}` : '';
        return { type: 'text', text: `[${label}](${block.uri})${description}` };
      }
    }
  });
  return { role: 'user', content };
}
function modelPartToAcp(part: ContentPart): AcpContentBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image', data: part.data, mimeType: part.mediaType };
    case 'audio':
      return { type: 'audio', data: part.data, mimeType: part.mediaType };
    case 'document':
      return {
        type: 'resource',
        resource: {
          uri: part.name ? `file://${part.name}` : 'document://inline',
          mimeType: part.mediaType,
          blob: part.data,
        },
      };
    case 'tool_use':
    case 'tool_result':
      return { type: 'text', text: JSON.stringify(part) };
  }
}
function modelContentToAcp(content: string | ContentPart[]): AcpContentBlock[] {
  return typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content.map(modelPartToAcp);
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
function normalizeClientCapabilities(value: unknown): AcpClientCapabilities {
  const input = isRecord(value) ? value : {};
  const fs = isRecord(input.fs) ? input.fs : {};
  const auth = isRecord(input.auth) ? input.auth : {};
  const elicitation = isRecord(input.elicitation) ? input.elicitation : null;
  const session = isRecord(input.session) ? input.session : null;
  const configOptions = session && isRecord(session.configOptions) ? session.configOptions : null;
  return {
    fs: {
      readTextFile: fs.readTextFile === true,
      writeTextFile: fs.writeTextFile === true,
      ...(isRecord(fs._meta) ? { _meta: fs._meta } : {}),
    },
    terminal: input.terminal === true,
    auth: {
      terminal: auth.terminal === true,
      ...(isRecord(auth._meta) ? { _meta: auth._meta } : {}),
    },
    ...(elicitation
      ? {
          elicitation: {
            ...(isRecord(elicitation.form) ? { form: elicitation.form } : {}),
            ...(isRecord(elicitation.url) ? { url: elicitation.url } : {}),
            ...(isRecord(elicitation._meta) ? { _meta: elicitation._meta } : {}),
          },
        }
      : {}),
    ...(session
      ? {
          session: {
            ...(configOptions
              ? {
                  configOptions: {
                    ...(isRecord(configOptions.boolean) ? { boolean: configOptions.boolean } : {}),
                    ...(isRecord(configOptions._meta) ? { _meta: configOptions._meta } : {}),
                  },
                }
              : {}),
            ...(isRecord(session._meta) ? { _meta: session._meta } : {}),
          },
        }
      : {}),
    ...(isRecord(input._meta) ? { _meta: input._meta } : {}),
  };
}
function supportsBooleanConfig(capabilities: AcpClientCapabilities): boolean {
  return isRecord(capabilities.session?.configOptions?.boolean);
}
function filterConfigOptions(
  options: AcpSessionConfigOption[],
  capabilities: AcpClientCapabilities,
): AcpSessionConfigOption[] {
  return cloneValue(
    options.filter((option) => option.type !== 'boolean' || supportsBooleanConfig(capabilities)),
  );
}
function inferToolKind(name: string): AcpToolKind {
  const lower = name.toLowerCase();
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'edit';
  if (lower.includes('delete') || lower.includes('remove')) return 'delete';
  if (lower.includes('move') || lower.includes('rename')) return 'move';
  if (lower.includes('search') || lower.includes('find')) return 'search';
  if (lower.includes('terminal') || lower.includes('exec') || lower.includes('run'))
    return 'execute';
  if (lower.includes('fetch') || lower.includes('http')) return 'fetch';
  if (lower.includes('think') || lower.includes('plan')) return 'think';
  return 'other';
}
function hasSensitiveFormField(schema: Record<string, unknown>): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!isRecord(value) || seen.has(value)) return false;
    seen.add(value);
    if (
      isRecord(value.properties) &&
      Object.keys(value.properties).some((name) =>
        /password|passcode|secret|token|api.?key|private.?key|recovery|payment|card/i.test(name),
      )
    ) {
      return true;
    }
    return Object.values(value).some((child) =>
      Array.isArray(child) ? child.some(visit) : visit(child),
    );
  };
  return visit(schema);
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
 * Create ACP newline-delimited JSON over process stdio.
 *
 * Writes are serialized and flushed. Reserve stdout for ACP diagnostics-free.
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
    receive: () => splitLines(input),
    close: () => input.close(),
  };
}

function connectionClosed(): JsonRpcError {
  return new JsonRpcError('ACP connection is closed', INTERNAL_ERROR);
}
function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * Agent-side view of one negotiated ACP client.
 *
 * Instances are session-bound. Besides exposing every client request in the
 * stable protocol, the ACP server automatically converts negotiated file,
 * terminal, and elicitation capabilities into model tools.
 */
export class AcpClient {
  #sessionId: string;
  #capabilities: AcpClientCapabilities;
  #peer: () => JsonRpcPeer | null;
  #urlElicitations: Set<string>;
  /** @internal Constructed by `AcpServer`. */
  constructor(
    sessionId: string,
    capabilities: AcpClientCapabilities,
    peer: () => JsonRpcPeer | null,
    urlElicitations: Set<string>,
  ) {
    this.#sessionId = sessionId;
    this.#capabilities = capabilities;
    this.#peer = peer;
    this.#urlElicitations = urlElicitations;
  }
  /** Negotiated client capabilities. */
  get capabilities(): AcpClientCapabilities {
    return cloneValue(this.#capabilities);
  }
  /** Session id automatically attached to session-scoped client requests. */
  get sessionId(): string {
    return this.#sessionId;
  }
  #requirePeer(): JsonRpcPeer {
    const peer = this.#peer();
    if (!peer) throw connectionClosed();
    return peer;
  }
  #requireCapability(enabled: boolean, name: string): void {
    if (!enabled) throw new JsonRpcError(`ACP client does not support ${name}`, INVALID_REQUEST);
  }
  /** Send any stable session update. */
  async update(update: AcpSessionUpdate, meta?: AcpMeta): Promise<void> {
    await this.#requirePeer().notify('session/update', {
      sessionId: this.#sessionId,
      update: cloneValue(update),
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
  }
  /** Read a text file through the negotiated client filesystem capability. */
  async readTextFile(
    path: string,
    opts: { line?: number; limit?: number; meta?: AcpMeta; signal?: AbortSignal } = {},
  ): Promise<{ content: string; _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.fs?.readTextFile === true, 'fs.readTextFile');
    requireAbsolutePath(path, 'path');
    return (await this.#requirePeer().call(
      'fs/read_text_file',
      {
        sessionId: this.#sessionId,
        path,
        ...(opts.line !== undefined ? { line: opts.line } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.meta !== undefined ? { _meta: opts.meta } : {}),
      },
      { signal: opts.signal },
    )) as { content: string; _meta?: AcpMeta };
  }
  /** Write a text file through the negotiated client filesystem capability. */
  async writeTextFile(
    path: string,
    content: string,
    opts: { meta?: AcpMeta; signal?: AbortSignal } = {},
  ): Promise<{ _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.fs?.writeTextFile === true, 'fs.writeTextFile');
    requireAbsolutePath(path, 'path');
    return (await this.#requirePeer().call(
      'fs/write_text_file',
      {
        sessionId: this.#sessionId,
        path,
        content,
        ...(opts.meta !== undefined ? { _meta: opts.meta } : {}),
      },
      { signal: opts.signal },
    )) as { _meta?: AcpMeta };
  }
  /** Create a client-hosted terminal. */
  async createTerminal(
    opts: AcpCreateTerminalOptions,
    signal?: AbortSignal,
  ): Promise<{ terminalId: string; _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    if (opts.cwd !== undefined && opts.cwd !== null) requireAbsolutePath(opts.cwd, 'cwd');
    return (await this.#requirePeer().call(
      'terminal/create',
      { sessionId: this.#sessionId, ...cloneValue(opts) },
      { signal },
    )) as { terminalId: string; _meta?: AcpMeta };
  }
  /** Read current output from a client-hosted terminal. */
  async terminalOutput(terminalId: string, signal?: AbortSignal): Promise<AcpTerminalOutput> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    return (await this.#requirePeer().call(
      'terminal/output',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    )) as AcpTerminalOutput;
  }
  /** Wait until a client-hosted terminal exits. */
  async waitForTerminalExit(
    terminalId: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode?: number | null; signal?: string | null; _meta?: AcpMeta }> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    return (await this.#requirePeer().call(
      'terminal/wait_for_exit',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    )) as { exitCode?: number | null; signal?: string | null; _meta?: AcpMeta };
  }
  /** Kill a client-hosted terminal process. */
  async killTerminal(terminalId: string, signal?: AbortSignal): Promise<void> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    await this.#requirePeer().call(
      'terminal/kill',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    );
  }
  /** Release a client-hosted terminal and its retained output. */
  async releaseTerminal(terminalId: string, signal?: AbortSignal): Promise<void> {
    this.#requireCapability(this.#capabilities.terminal === true, 'terminal');
    await this.#requirePeer().call(
      'terminal/release',
      { sessionId: this.#sessionId, terminalId },
      { signal },
    );
  }
  /** Request negotiated structured user input. */
  async elicit(
    request: AcpElicitationRequest,
    signal?: AbortSignal,
  ): Promise<AcpElicitationResponse> {
    if (request.mode === 'form') {
      this.#requireCapability(isRecord(this.#capabilities.elicitation?.form), 'elicitation.form');
      if (hasSensitiveFormField(request.requestedSchema)) {
        throw new JsonRpcError(
          'ACP form elicitation must not request sensitive credentials',
          INVALID_REQUEST,
        );
      }
    } else if (request.mode === 'url') {
      this.#requireCapability(isRecord(this.#capabilities.elicitation?.url), 'elicitation.url');
      parseUrl(request.url, 'url');
      if (this.#urlElicitations.has(request.elicitationId)) {
        throw new JsonRpcError(
          `Duplicate elicitation id: ${request.elicitationId}`,
          INVALID_REQUEST,
        );
      }
      this.#urlElicitations.add(request.elicitationId);
    } else if (!request.mode.startsWith('_')) {
      invalidParams('Custom ACP elicitation modes must begin with _');
    }
    const scoped =
      request.sessionId === undefined && request.requestId === undefined
        ? { ...request, sessionId: this.#sessionId }
        : request;
    try {
      return (await this.#requirePeer().call('elicitation/create', scoped, {
        signal,
      })) as AcpElicitationResponse;
    } catch (error) {
      if (request.mode === 'url') this.#urlElicitations.delete(request.elicitationId);
      throw error;
    }
  }
  /** Tell the client that a URL elicitation has completed. */
  async completeElicitation(elicitationId: string, meta?: AcpMeta): Promise<void> {
    if (!this.#urlElicitations.delete(elicitationId)) {
      throw new JsonRpcError(`Unknown elicitation id: ${elicitationId}`, INVALID_PARAMS);
    }
    await this.#requirePeer().notify('elicitation/complete', {
      elicitationId,
      ...(meta !== undefined ? { _meta: meta } : {}),
    });
  }
  /** Call a client extension method. Extension names must begin with `_`. */
  extension(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!method.startsWith('_')) invalidParams('ACP extension methods must begin with _');
    return this.#requirePeer().call(method, params, { signal });
  }
  /** Send a client extension notification. Extension names must begin with `_`. */
  async notifyExtension(method: string, params?: unknown): Promise<void> {
    if (!method.startsWith('_')) invalidParams('ACP extension methods must begin with _');
    await this.#requirePeer().notify(method, params);
  }
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
    ...(record.stored.modes ? { modes: cloneValue(record.stored.modes) } : {}),
    ...(record.stored.configOptions.length > 0
      ? { configOptions: filterConfigOptions(record.stored.configOptions, capabilities) }
      : {}),
  };
}

/** Complete stable ACP v1 server for reusable Fino agent definitions. */
export class AcpServer {
  #opts: AcpServerOptions;
  #store: AcpSessionStore;
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
    this.#store = opts.store ?? new InMemoryAcpSessionStore();
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
          clientCapabilities: cloneValue(this.#clientCapabilities),
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
      this.#clientInfo = cloneValue(value.clientInfo) as unknown as AcpImplementation;
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
        ...(this.#opts.capabilityMeta ? { _meta: cloneValue(this.#opts.capabilityMeta) } : {}),
      },
      authMethods: cloneValue(authMethods),
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
      stored: cloneValue(stored),
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
        availableCommands: cloneValue(this.#opts.commands),
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
    const expected = record.stored.revision;
    record.stored = await this.#store.save(
      {
        ...record.stored,
        history: record.history.toSnapshot(),
        updatedAt: new Date().toISOString(),
      },
      expected,
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
    const now = new Date().toISOString();
    const history = new MessageHistory();
    const stored = await this.#store.save(
      {
        sessionId,
        cwd,
        additionalDirectories,
        updatedAt: now,
        history: history.toSnapshot(),
        ...(this.#opts.modes ? { modes: cloneValue(this.#opts.modes) } : {}),
        configOptions: cloneValue(this.#opts.configOptions ?? []),
        usage: emptyUsage(),
        revision: 0,
        ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
      },
      null,
    );
    try {
      const record = await this.#activate(stored, servers);
      return { sessionId, ...sessionResponse(record, this.#clientCapabilities) };
    } catch (error) {
      await this.#store.delete(sessionId).catch(() => {});
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
    const stored = await this.#store.load(sessionId);
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
    const page = await this.#store.list({ cwd, cursor });
    return {
      sessions: page.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        additionalDirectories: [...session.additionalDirectories],
        ...(session.title !== undefined ? { title: session.title } : {}),
        updatedAt: session.updatedAt,
        ...(session._meta !== undefined ? { _meta: cloneValue(session._meta) } : {}),
      })),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }
  async #deleteSession(params: unknown, ctx: RequestContext): Promise<Record<string, never>> {
    await this.#assertAuthenticated(ctx.signal);
    const value = requireRecord(params, 'session/delete params');
    const sessionId = requireString(value.sessionId, 'sessionId');
    await this.#closeActive(sessionId);
    if (!(await this.#store.delete(sessionId))) {
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
      configOptions: cloneValue(record.stored.configOptions),
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
    await this.#opts.onConfigOptionChange?.(this.#context(record), cloneValue(next));
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
