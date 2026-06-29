/**
 * fino:ai — first-stop exports for Fino AI applications.
 *
 * This module gathers the stable, application-facing AI APIs into one import
 * surface. Use it when building agents, tools, sessions, memory-backed
 * conversations, local or remote model calls, and evals. Specialized modules
 * such as `fino:ai/model`, `fino:ai/mcp`, and `fino:ai/context` remain
 * available when an application needs narrower imports or advanced types.
 *
 * ## Design
 *
 * The facade does not add behavior. It re-exports the same symbols from the
 * underlying modules so users can start with one import and later split imports
 * by subsystem without changing runtime semantics.
 *
 * ```ts no_run
 * import { agent, openai, streamText, tool } from 'fino:ai';
 * import { v } from 'fino:validate';
 *
 * const lookup = tool({
 *   name: 'lookup',
 *   description: 'Look up a record by id.',
 *   parameters: v.object({ id: v.string() }),
 *   execute: async ({ id }: { id: string }) => `record:${id}`,
 * });
 *
 * const bot = agent({
 *   model: openai({ model: 'gpt-4o' }),
 *   tools: [lookup],
 * });
 *
 * for await (const text of streamText(bot.stream('lookup A-1'))) {
 *   console.log(text);
 * }
 * ```
 */

export {
  Agent,
  agent,
  streamText,
} from 'fino:ai/agent';
export type {
  AgentOptions,
  AgentEvent,
  AgentResult,
  AgentState,
  AgentStream,
  RunInput,
  StepResult,
} from 'fino:ai/agent';

export {
  anthropic,
  anthropicProvider,
  assembleResult,
  hasLlamaCpp,
  local,
  LocalModelLibraryError,
  LocalModelUnsupportedError,
  localProvider,
  ModelError,
  ModelListingUnsupportedError,
  ModelRegistry,
  modelRegistry,
  openai,
  openaiProvider,
} from 'fino:ai/model';
export type {
  ContentPart,
  DocumentPart,
  ChatModel,
  EmbeddingModel,
  GenerateRequest,
  GenerateResult,
  ImagePart,
  LocalModelOptions,
  LocalModelProviderEntry,
  LocalModelSource,
  LocalProviderOptions,
  Model,
  ModelCapabilities,
  ModelCreateOptions,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  ModelStream,
  ProviderOptions,
  ResponseFormat,
  Role,
  StopReason,
  StreamEvent,
  TextPart,
  ToolCall,
  ToolDefinition,
  ToolResultPart,
  ToolUsePart,
  Usage,
  EmbeddingCapabilities,
} from 'fino:ai/model';

export {
  task,
  Task,
  toTaskToolDefinition,
} from 'fino:task';
export type {
  TaskCliOption,
  TaskCliPositional,
  TaskCliSpec,
  TaskContext,
  TaskEffect,
  TaskHandler,
  TaskJsonValue,
  TaskOptions,
  TaskOutputMode,
  TaskOutputWriter,
  TaskParseOptions,
  TaskRequestedOutputMode,
  TaskRunContext,
  TaskRunOptions,
  TaskToolResult,
} from 'fino:task';

export {
  SuspendSignal,
  tool,
  Tool,
  toToolDefinition,
} from 'fino:ai/tool';
export type {
  ToolOptions,
  ToolResult,
  ToolRunContext,
} from 'fino:ai/tool';

export {
  GuardrailError,
  maxSteps,
  runContext,
} from 'fino:ai/runtime';
export type {
  GuardrailResult,
  Guardrails,
  RetryOptions,
  StopCondition,
  StrategyMemorySink,
  ToolApprovalRequest,
} from 'fino:ai/runtime';

export {
  InMemorySessionStore,
  session,
  Session,
  SqliteSessionStore,
} from 'fino:ai/session';
export type {
  RunResult,
  RunState,
  RunStatus,
  SessionOptions,
  SessionStore,
  SuspendReason,
  ThreadState,
  ToolApprovalDecision,
} from 'fino:ai/session';

export {
  memory,
  retriever,
  SqliteMemory,
} from 'fino:ai/memory';
export type {
  ChunkOptions,
  Embedder,
  Memory,
  MemoryMessage,
  MemoryQuery,
  RecalledContext,
  RecallHit,
  Retriever,
  SqliteMemoryOptions,
} from 'fino:ai/memory';

export {
  contains,
  EvalReporter,
  evaluate,
  exactMatch,
  JsonEvalReporter,
  llmJudge,
  OpenTelemetryReporter,
  schemaScorer,
  semanticSimilarity,
} from 'fino:ai/eval';
export type {
  EvalCase,
  EvalCaseReport,
  EvalOptions,
  EvalSummary,
  JsonEvalReport,
  JsonEvalReporterOptions,
  OpenTelemetryReporterOptions,
  ScoreResult,
  Scorer,
} from 'fino:ai/eval';

export {
  skill,
  skillRegistry,
} from 'fino:ai/skill';
export type {
  LocalSkillDefinition,
  RemoteSkillDefinition,
  Skill,
  SkillRegistry,
  SkillResource,
  SkillsMdOptions,
} from 'fino:ai/skill';

export {
  httpTransport,
  MCPClient,
  mcpClient,
  MCPServer,
  mcpServer,
  mountMcp,
  stdioTransport,
} from 'fino:ai/mcp';
export type {
  MCPClientOptions,
  MCPRouteTarget,
  MCPServerContext,
  MCPServerOptions,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpPromptResult,
  McpContent,
  McpElicitationRequest,
  McpElicitationResult,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
  McpRoot,
  McpSamplingRequest,
  McpSamplingResult,
  McpListPage,
  McpListParams,
  StdioTransportOptions,
  HttpTransportOptions,
  Transport,
} from 'fino:ai/mcp';
