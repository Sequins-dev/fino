/**
 * internal:ai/acp/schema — stable ACP v1 wire constants and data shapes.
 *
 * These declarations mirror the schema pinned by `fino:ai/acp` and contain no
 * transport, persistence, or connection lifecycle policy.
 *
 * Useful reference:
 *
 * - Stable ACP v1 schema: https://github.com/agentclientprotocol/agent-client-protocol/blob/ae596e13351e1196b8b83b73f19beca51355732e/schema/v1/schema.json
 */
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
