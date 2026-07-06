/**
* internal:ai/runtime — implementation of the agent model loop.
*
* This module contains the mutable runtime behind `fino:ai/agent`: model
* request assembly, tool execution, structured-output capture and repair,
* guardrail checks, fallback/retry behavior, telemetry, and stream plumbing.
* Public application code should import `Agent` from `fino:ai/agent` and
* integration helpers from `fino:ai/runtime` instead of constructing
* `AgentRuntime` directly.
*
* ## Loop shape
*
* A run is a sequence of steps. Each step asks the configured
* `HistoryStrategy` for the model-facing view, applies the input guardrail,
* streams one model turn (with per-model retry and cross-model fallback),
* applies the output guardrail to the assistant text, then executes any
* requested tool calls in parallel. Tool results are folded back through the
* history strategy and the loop continues until the model stops on its own, a
* `StopCondition` fires, or a tool suspends the run by throwing
* `SuspendSignal` (for example to request human approval).
*
* The implementation deliberately keeps history policy out of the runtime. It
* calls `HistoryStrategy.onAppend()` when messages are recorded and
* `HistoryStrategy.onRead()` before model requests; all compaction, retrieval,
* summarization, and memory emission decisions belong to the strategy.
*
* Every run, step, and tool execution is traced and metered using the
* OpenTelemetry GenAI semantic conventions (`invoke_agent`, `chat`, and
* `execute_tool` spans with `gen_ai.*` attributes, duration and token-usage
* histograms, and an inference-details log record per step).
*
* ```ts no_run
* // Builtins may construct the runtime directly; applications use fino:ai/agent.
* import { AgentRuntime, maxSteps } from 'internal:ai/runtime';
*
* const runtime = new AgentRuntime({
*   model,
*   instructions: 'Answer briefly.',
*   tools: [searchTool],
*   stopWhen: maxSteps(4),
* });
* const result = await runtime.generate({
*   messages: [{ role: 'user', content: 'What changed in the last release?' }],
* });
* console.log(result.text, result.usage, result.cost);
* ```
*
* GenAI semantic conventions:
* https://opentelemetry.io/docs/specs/semconv/gen-ai/
*
* @internal
*/
import type { Model, ModelMessage, StreamEvent, StopReason, ToolUsePart, ContentPart, Usage, ToolDefinition, GenerateRequest, ResponseFormat, ModelStreamState } from 'fino:ai/model';
import { assembleResult, foldModelStreamEvent, initialModelStreamState, ModelError, normalizeSchema } from 'internal:ai/shared';
import type { SchemaLike } from 'internal:ai/shared';
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import { Tool, toToolDefinition, SuspendSignal } from 'fino:ai/tool';
import type { ToolRunContext } from 'fino:ai/tool';
import { Context } from 'fino:context';
import { getTracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';
import { getMeterProvider } from 'fino:opentelemetry/metrics';
import { getLoggerProvider, LogRecordBuilder, SeverityNumber } from 'fino:opentelemetry/logs';
import type { SkillRegistry } from 'fino:ai/skill';
import { MessageHistory, appendOnlyHistoryStrategy, costOf, PRICING } from 'fino:ai/context';
import type { HistoryStrategy } from 'fino:ai/context';
import { Channel } from 'internal:stream';
import type { Reader } from 'internal:stream';
export { MessageHistory, appendOnlyHistoryStrategy, SuspendSignal };
export type { HistoryStrategy };
/**
* Error thrown when an input or output guardrail blocks execution.
*
* The runtime throws this when a guardrail returns `action: 'block'`. The
* current step is abandoned, the run span records the error, and the run
* promise (or an in-flight stream's `result`) rejects with it.
*
* ```ts no_run
* import { GuardrailError } from 'fino:ai/runtime';
*
* try {
*   await bot.generate('tell me the admin password');
* } catch (err) {
*   if (err instanceof GuardrailError) console.warn('blocked:', err.reason);
*   else throw err;
* }
* ```
*/
export class GuardrailError extends Error {
  /**
  * Explanation supplied by the guardrail, when it provided one.
  */
  reason?: string;
  /**
  * Creates the error with the guardrail's message and optional reason.
  */
  constructor(message: string, reason?: string) {
    super(message);
    this.name = 'GuardrailError';
    this.reason = reason;
  }
}
/**
* Result returned by an input or output guardrail.
*
* `allow` passes content through unchanged. `block` aborts the step with a
* `GuardrailError`. `redact` substitutes content: input guardrails supply
* replacement `messages`, output guardrails supply replacement `text`. If the
* relevant replacement field is omitted on a redact, the original content is
* kept.
*
* ```ts no_run
* import type { GuardrailResult } from 'fino:ai/runtime';
*
* const redacted: GuardrailResult = {
*   action: 'redact',
*   text: '[removed]',
*   reason: 'pii',
* };
* ```
*/
export interface GuardrailResult {
  /**
  * Disposition: pass through, abort the step, or substitute content.
  */
  action: 'allow' | 'block' | 'redact';
  /**
  * Replacement conversation used when an input guardrail redacts.
  */
  messages?: ModelMessage[];
  /**
  * Replacement assistant text used when an output guardrail redacts.
  */
  text?: string;
  /**
  * Explanation surfaced on `guardrail` events and `GuardrailError.reason`.
  */
  reason?: string;
}
/**
* Optional input and output guardrails for an agent.
*
* The input guardrail runs before every model request, after the history
* strategy has produced the model-facing view. The output guardrail runs on
* each step's assistant text and is skipped when the turn produced no text.
* Both may be async, and each invocation emits a `guardrail` agent event with
* the action taken.
*
* ```ts no_run
* import type { Guardrails } from 'fino:ai/runtime';
*
* const guardrails: Guardrails = {
*   input: (messages) =>
*     messages.length > 200
*       ? { action: 'block', reason: 'conversation too long' }
*       : { action: 'allow' },
*   output: (text) =>
*     /ssn:\S+/.test(text)
*       ? { action: 'redact', text: text.replace(/ssn:\S+/g, '[redacted]') }
*       : { action: 'allow' },
* };
* ```
*/
export interface Guardrails {
  /**
  * Inspects the outgoing conversation before each model request.
  */
  input?: (messages: ModelMessage[]) => GuardrailResult | Promise<GuardrailResult>;
  /**
  * Inspects each step's assistant text before it is recorded.
  */
  output?: (text: string) => GuardrailResult | Promise<GuardrailResult>;
}
/**
* Async context for the active agent or workflow run.
*
* The runtime populates this context for the duration of `generate()`,
* `stream()`, `step()`, and `approveTool()` calls, so any code on the async
* call chain — most usefully tool `execute` functions — can read the current
* `runId`, the zero-based `stepIndex` (updated in place as the loop advances),
* and the run's abort signal. Calls that already execute inside a run context
* (for example `step()` driven by a session) reuse the existing run instead of
* minting a new id.
*
* ```ts no_run
* import { runContext } from 'fino:ai/runtime';
*
* function logProgress(label: string) {
*   const run = runContext.get();
*   if (run) console.log(`[${run.runId} step ${run.stepIndex}] ${label}`);
* }
* ```
*/
export const runContext = new Context<{
  runId: string;
  stepIndex: number;
  signal?: AbortSignal;
}>('fino:ai/run');
/**
* Mutable state passed through one agent run.
*
* Each step consumes a state and produces the next one: `messages` is the
* model-facing conversation rendered by the history strategy, `usage` and
* `cost` accumulate across steps, and `stepIndex` counts completed model
* turns. Harnesses that drive the loop manually with `step()` keep threading
* the returned state back in.
*
* ```ts no_run
* import type { AgentState } from 'fino:ai/runtime';
*
* let state: AgentState = {
*   messages: [{ role: 'user', content: 'Summarize the report.' }],
*   stepIndex: 0,
*   usage: { inputTokens: 0, outputTokens: 0 },
* };
* ```
*/
export interface AgentState {
  /**
  * Model-facing conversation, as rendered by the history strategy.
  */
  messages: ModelMessage[];
  /**
  * Number of completed model steps in this run.
  */
  stepIndex: number;
  /**
  * Token usage accumulated across all steps so far.
  */
  usage: Usage;
  /**
  * Running USD cost derived from usage and the pricing table, when known.
  */
  cost?: number;
  /**
  * History handle backing `messages`; present once a step has run.
  */
  history?: MessageHistory;
  /**
  * Abort signal observed by model requests and tool executions.
  */
  signal?: AbortSignal;
}
/**
* Result of one agent step.
*
* `done` is true when the model finished without requesting tool calls, so
* the loop has nothing further to execute. When a tool suspended the step,
* `suspend` carries the `SuspendSignal` (with its payload, such as a
* `ToolApprovalRequest`) and the run should be checkpointed for later
* resumption.
*
* ```ts no_run
* import type { StepResult } from 'fino:ai/runtime';
*
* let r: StepResult = await agent.step(state);
* while (!r.done && !r.suspend) r = await agent.step(r.state);
* ```
*/
export interface StepResult {
  /**
  * State after the step, including appended messages and updated usage.
  */
  state: AgentState;
  /**
  * True when the model stopped without requesting tool calls.
  */
  done: boolean;
  /**
  * Present when a tool paused the run; resume via a session or `approveTool()`.
  */
  suspend?: SuspendSignal;
  /**
  * Why the model stopped this turn.
  */
  stopReason: StopReason;
}
/**
* Persisted approval request for a tool call that suspended before execution.
*
* When a tool declares `requiresApproval`, the runtime does not execute it;
* instead the step suspends with a `SuspendSignal` whose payload is this
* shape. Sessions persist the payload and later pass it back to
* `approveTool()` along with the human decision. `risk` and `sideEffects`
* mirror the tool's own annotations so approval UIs can render them without
* loading the tool.
*
* ```ts no_run
* import type { ToolApprovalRequest } from 'fino:ai/runtime';
*
* const request = r.suspend?.payload as ToolApprovalRequest;
* if (request?.type === 'tool_approval') {
*   console.log(`Approve ${request.toolName}?`, request.args);
* }
* ```
*/
export interface ToolApprovalRequest {
  /**
  * Discriminant identifying the suspend payload as a tool approval.
  */
  type: 'tool_approval';
  /**
  * Id of the pending `tool_use` part awaiting a result.
  */
  toolCallId: string;
  /**
  * Name of the tool the model asked to run.
  */
  toolName: string;
  /**
  * Arguments the model supplied for the call.
  */
  args: unknown;
  /**
  * Tool-declared risk annotation, for approval UIs.
  */
  risk?: string;
  /**
  * Whether the tool declares side effects.
  */
  sideEffects?: boolean;
}
/**
* Agent-level streaming event.
*
* Provider `StreamEvent` values are wrapped in `model_event`. Lifecycle events
* add run-loop context around model streaming, retries, fallback, tool
* execution, guardrails, suspension, and final completion. Every run emits
* `step_start`/`step_end` pairs per model turn and exactly one `final` event
* (carrying the same `AgentResult` that `AgentStream.result` resolves with)
* when it completes successfully.
*
* ```ts no_run
* for await (const ev of stream.reader) {
*   switch (ev.type) {
*     case 'model_event':
*       if (ev.event.type === 'text_delta') render(ev.event.text);
*       break;
*     case 'tool_start':
*       console.log(`running ${ev.name}`);
*       break;
*     case 'final':
*       console.log('cost:', ev.result.cost);
*   }
* }
* ```
*/
export type AgentEvent = {
  type: 'model_event';
  event: StreamEvent;
} | {
  type: 'step_start';
  stepIndex: number;
  model: string;
  provider: string;
} | {
  type: 'step_end';
  stepIndex: number;
  stopReason: StopReason;
  model: string;
  provider: string;
} | {
  type: 'tool_start';
  stepIndex: number;
  id: string;
  name: string;
} | {
  type: 'tool_result';
  stepIndex: number;
  id: string;
  name: string;
  isError?: boolean;
} | {
  type: 'tool_error';
  stepIndex: number;
  id: string;
  name: string;
  message: string;
} | {
  type: 'retry';
  attempt: number;
  model: string;
  provider: string;
  delayMs: number;
} | {
  type: 'fallback';
  model: string;
  provider: string;
} | {
  type: 'guardrail';
  stage: 'input' | 'output';
  action: GuardrailResult['action'];
  reason?: string;
} | {
  type: 'suspend';
  stepIndex: number;
  reason?: string;
  payload?: unknown;
} | {
  type: 'final';
  result: AgentResult;
};
/**
* Predicate that decides whether an agent run should stop.
*
* Conditions are checked after every completed step, including tool-execution
* steps; the run ends as soon as any configured condition returns true. When
* no `stopWhen` is configured, the runtime defaults to `maxSteps(8)`.
*
* ```ts no_run
* import type { StopCondition } from 'fino:ai/runtime';
*
* const budgetCap: StopCondition = (state) => (state.cost ?? 0) > 0.5;
* ```
*/
export type StopCondition = (state: AgentState, info: {
  stopReason: StopReason;
}) => boolean;
/**
* Stop after `n` model steps.
*
* This is the most common stop condition and the default (with `n = 8`) when
* no `stopWhen` is configured. It bounds runaway tool loops: a step is one
* model turn, so tool-heavy conversations reach the limit faster than plain
* chats.
*
* ```ts no_run
* import { agent } from 'fino:ai/agent';
* import { maxSteps } from 'fino:ai/runtime';
*
* const bot = agent({ model, stopWhen: maxSteps(4) });
* ```
*/
export function maxSteps(n: number): StopCondition {
  return (state) => state.stepIndex >= n;
}
/**
* Input accepted by `Agent.generate()` and `Agent.stream()`.
*
* Messages are appended to the run's history before the first step. The
* signal, when provided, aborts in-flight model requests and is passed to
* tool executions.
*
* ```ts no_run
* import type { RunInput } from 'fino:ai/runtime';
*
* const controller = new AbortController();
* const input: RunInput = {
*   messages: [{ role: 'user', content: 'Plan the release.' }],
*   signal: controller.signal,
* };
* ```
*/
export interface RunInput {
  /**
  * Conversation to append before the first model request.
  */
  messages: ModelMessage[];
  /**
  * Cancels the run: model streaming and tool calls observe this signal.
  */
  signal?: AbortSignal;
}
/**
* Final result of an agent run.
*
* `text` is the assistant text from the last completed step, `messages` is
* the full conversation as rendered by the history strategy, and `steps`
* records the state after each step for inspection. `object` is set only on
* structured-output runs.
*
* ```ts no_run
* const result = await bot.generate('Name three sorting algorithms.');
* console.log(result.text);
* console.log(result.usage.inputTokens, result.usage.outputTokens);
* console.log(result.stopReason); // 'end_turn'
* ```
*/
export interface AgentResult {
  /**
  * Assistant text from the final step.
  */
  text: string;
  /**
  * Parsed structured output; present only when an output schema was set.
  */
  object?: unknown;
  /**
  * Full conversation, including tool calls and results.
  */
  messages: ModelMessage[];
  /**
  * Per-step state snapshots, in order.
  */
  steps: AgentState[];
  /**
  * Token usage summed across all steps.
  */
  usage: Usage;
  /**
  * Estimated USD cost when pricing for the models used is known.
  */
  cost?: number;
  /**
  * Stop reason from the final model turn.
  */
  stopReason: StopReason;
}
/**
* Retry policy for provider failures.
*
* Retries apply per model before fallback advances: each model in
* `[model, ...fallback]` gets the full retry budget. Delays use exponential
* backoff with full jitter, capped at `maxDelayMs`, except when the provider
* supplied an explicit retry-after delay, which is honored verbatim. Errors
* thrown after streaming has begun are never retried — partial output cannot
* be safely replayed.
*
* ```ts no_run
* const bot = agent({
*   model,
*   retry: { maxRetries: 3, baseDelayMs: 250 },
*   fallback: [backupModel],
* });
* ```
*/
export interface RetryOptions {
  /**
  * Additional attempts per model after the first failure. Default 0.
  */
  maxRetries?: number;
  /**
  * Base backoff delay in milliseconds. Default 500.
  */
  baseDelayMs?: number;
  /**
  * Upper bound on any backoff delay, in milliseconds. Default 30000.
  */
  maxDelayMs?: number;
  /**
  * Overrides which errors are retryable. By default only `ModelError`s with
  * status 429 or 5xx are retried.
  */
  retryOn?: (err: unknown) => boolean;
}
/**
* Minimal sink a history strategy can use to emit durable memory.
*
* Matches the ingest surface of `fino:ai/memory` stores so strategies can
* archive summarized or evicted conversation content without depending on a
* concrete store type. Hosts such as sessions hand a sink to their strategy,
* which calls it as part of compaction.
*
* ```ts no_run
* import type { StrategyMemorySink } from 'fino:ai/runtime';
*
* async function archive(sink: StrategyMemorySink, summary: string) {
*   await sink.ingest([{ text: summary, metadata: { kind: 'summary' } }]);
* }
* ```
*/
export interface StrategyMemorySink {
  /**
  * Stores the given documents durably.
  */
  ingest(docs: {
    text: string;
    metadata?: Record<string, unknown>;
  }[]): Promise<void>;
}
/**
* Internal options consumed by the runtime implementation.
*
* Application code should use `AgentOptions` from `fino:ai/agent`, which is
* this shape with `history` optional. Defaults applied by the runtime:
* `stopWhen` falls back to `maxSteps(8)`, `history` to an append-only
* in-memory strategy, `budgetTokens` to 200000, `structuredOutputMode` to
* `'tool'`, and `captureContent` to false.
*
* ```ts no_run
* import { AgentRuntime } from 'internal:ai/runtime';
*
* const runtime = new AgentRuntime({
*   model,
*   name: 'triage',
*   instructions: 'Route each report to the right team.',
*   tools: [routeTool],
*   retry: { maxRetries: 2 },
*   budgetTokens: 100000,
* });
* ```
*/
export interface AgentRuntimeOptions {
  /**
  * Primary model used for every step until fallback engages.
  */
  model: Model;
  /**
  * Agent name recorded as `gen_ai.agent.name` on run spans.
  */
  name?: string;
  /**
  * System prompt. When `skills` is set, a skill manifest section is appended.
  */
  instructions?: string;
  /**
  * Tools offered to the model on every step.
  */
  tools?: Tool[];
  /**
  * Skill registry. Registers its `load_skill` loader tool and, once the model
  * loads a skill, augments later steps with that skill's instructions and
  * tools.
  */
  skills?: SkillRegistry;
  /**
  * Stop condition(s) checked after each step. Defaults to `maxSteps(8)`.
  */
  stopWhen?: StopCondition | StopCondition[];
  /**
  * Constrains model tool selection on every request.
  */
  toolChoice?: 'auto' | 'any' | 'none' | {
    name: string;
  };
  /**
  * Request parameter defaults merged into every model request.
  */
  defaults?: {
    temperature?: number;
    topP?: number;
    seed?: number;
    maxTokens?: number;
    stopSequences?: string[];
    providerOptions?: Record<string, unknown>;
  };
  /**
  * Structured output schema used to produce `AgentResult.object`.
  *
  * The schema may be a `fino:validate` builder or plain JSON Schema.
  */
  output?: SchemaLike;
  /**
  * Structured output transport.
  *
  * The default `tool` mode uses a synthetic `respond` tool and works across
  * providers. `native` sends a provider response-format request only when the
  * model declares `capabilities.structuredOutput.native`.
  */
  structuredOutputMode?: 'tool' | 'native';
  /**
  * Record full prompt content on inference log records. Off by default;
  * enable only where conversation content is acceptable in telemetry.
  */
  captureContent?: boolean;
  /**
  * Per-model retry policy for provider failures.
  */
  retry?: RetryOptions;
  /**
  * Models tried in order after the primary exhausts its retries or refuses.
  */
  fallback?: Model[];
  /**
  * Input/output guardrails applied around each step.
  */
  guardrails?: Guardrails;
  /**
  * History strategy owning append and read-time curation of the conversation.
  */
  history?: HistoryStrategy;
  /**
  * Token budget passed to the history strategy when producing the model-facing
  * view. Default 200000.
  */
  budgetTokens?: number;
}
let runCounter = 0;
function newRunId(): string {
  return `run_${++runCounter}_${Math.random().toString(36).slice(2, 7)}`;
}
async function* asyncOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}
/**
* Stream handle returned by `Agent.stream()`.
*
* Offers three views of one run: `reader` yields every `AgentEvent` in order,
* `state` is a retained signal holding a coarse `AgentRunView` snapshot, and
* `result` settles with the final `AgentResult`. The run starts immediately;
* if it throws, the reader fails with the error and `result` rejects.
*
* ```ts no_run
* const stream = bot.stream('Draft the changelog.');
* for await (const ev of stream.reader) {
*   if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
*     render(ev.event.text);
*   }
* }
* const result = await stream.result;
* ```
*/
export interface AgentStream {
  /**
  * Ordered stream of every agent event; closes when the run finishes.
  */
  reader: Reader<AgentEvent>;
  /**
  * Settles with the final result; rejects if the run throws.
  */
  result: Promise<AgentResult>;
  /**
  * Retained coarse view of the run, updated as events arrive.
  */
  state: ReadonlySignal<AgentRunView>;
}
/**
* Retained current view of an agent stream.
*
* This signal-shaped read model is intentionally coarse and lossy — it folds
* the event stream into a single "what is happening now" snapshot suitable
* for binding to UI. Keep using `AgentStream.reader` when every event is
* significant.
*
* ```ts no_run
* const stream = bot.stream('Investigate the failure.');
* const unsubscribe = stream.state.subscribe((view) => {
*   setStatus(view.status === 'tool' ? `running ${view.currentTool?.name}` : view.status);
* });
* ```
*/
export interface AgentRunView {
  /**
  * Coarse run phase; `error` is set on model errors, tool errors, and run
  * failure, `done` once the final result is known.
  */
  status: 'streaming' | 'tool' | 'suspended' | 'done' | 'error';
  /**
  * Assistant text accumulated for the current turn, replaced by the final
  * text when the run completes.
  */
  text: string;
  /**
  * Tool currently executing, or null between tool calls.
  */
  currentTool: {
    id: string;
    name: string;
  } | null;
  /**
  * Token usage observed so far.
  */
  usage: Usage;
  /**
  * Estimated USD cost, populated when the run completes.
  */
  cost?: number;
  /**
  * Index of the step currently in flight.
  */
  stepIndex: number;
}
/**
* Iterate over only text deltas from an agent stream.
*
* Filters the event stream down to `text_delta` payloads, discarding tool
* activity, lifecycle events, and the final result. Await `stream.result`
* separately when the run outcome matters.
*
* ```ts no_run
* const stream = bot.stream('Write a haiku about kqueue.');
* let out = '';
* for await (const text of streamText(stream)) out += text;
* ```
*/
export async function* streamText(stream: AgentStream): AsyncGenerator<string> {
  for await (const ev of stream.reader) {
    if (ev.type === 'model_event' && ev.event.type === 'text_delta') yield ev.event.text;
  }
}
function initialAgentRunView(): AgentRunView {
  return {
    status: 'streaming',
    text: '',
    currentTool: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0
    },
    stepIndex: 0
  };
}
function foldAgentEvent(state: AgentRunView, modelState: ModelStreamState, event: AgentEvent, textByIndex: Map<number, string>): AgentRunView {
  switch (event.type) {
    case 'model_event': {
      const nextModel = foldModelStreamEvent(modelState, event.event, textByIndex);
      modelState.text = nextModel.text;
      modelState.usage = nextModel.usage;
      modelState.stopReason = nextModel.stopReason;
      return {
        ...state,
        status: event.event.type === 'error' ? 'error' : state.status,
        text: nextModel.text,
        usage: nextModel.usage
      };
    }
    case 'step_start':
      return {
        ...state,
        status: 'streaming',
        currentTool: null,
        stepIndex: event.stepIndex
      };
    case 'step_end':
      return {
        ...state,
        status: 'streaming',
        stepIndex: event.stepIndex + 1
      };
    case 'tool_start':
      return {
        ...state,
        status: 'tool',
        currentTool: {
          id: event.id,
          name: event.name
        },
        stepIndex: event.stepIndex
      };
    case 'tool_result':
    case 'tool_error':
      return {
        ...state,
        status: event.type === 'tool_error' ? 'error' : 'streaming',
        currentTool: null,
        stepIndex: event.stepIndex
      };
    case 'suspend':
      return {
        ...state,
        status: 'suspended',
        currentTool: null,
        stepIndex: event.stepIndex
      };
    case 'final':
      return {
        ...state,
        status: 'done',
        currentTool: null,
        text: event.result.text,
        usage: event.result.usage,
        cost: event.result.cost,
        stepIndex: event.result.steps.length
      };
    default:
      return state;
  }
}
function providerName(model: Model): string {
  return model.provider ?? 'unknown';
}
function modelId(model: Model): string {
  return model.id ?? model.name;
}
function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...a.cacheReadInputTokens != null || b.cacheReadInputTokens != null ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) } : {},
    ...a.cacheCreationInputTokens != null || b.cacheCreationInputTokens != null ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) } : {},
    ...a.localCacheReadInputTokens != null || b.localCacheReadInputTokens != null ? { localCacheReadInputTokens: (a.localCacheReadInputTokens ?? 0) + (b.localCacheReadInputTokens ?? 0) } : {},
    ...a.localCacheReadOutputTokens != null || b.localCacheReadOutputTokens != null ? { localCacheReadOutputTokens: (a.localCacheReadOutputTokens ?? 0) + (b.localCacheReadOutputTokens ?? 0) } : {}
  };
}
function subUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    ...a.cacheReadInputTokens != null || b.cacheReadInputTokens != null ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) - (b.cacheReadInputTokens ?? 0) } : {},
    ...a.cacheCreationInputTokens != null || b.cacheCreationInputTokens != null ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) - (b.cacheCreationInputTokens ?? 0) } : {},
    ...a.localCacheReadInputTokens != null || b.localCacheReadInputTokens != null ? { localCacheReadInputTokens: (a.localCacheReadInputTokens ?? 0) - (b.localCacheReadInputTokens ?? 0) } : {},
    ...a.localCacheReadOutputTokens != null || b.localCacheReadOutputTokens != null ? { localCacheReadOutputTokens: (a.localCacheReadOutputTokens ?? 0) - (b.localCacheReadOutputTokens ?? 0) } : {}
  };
}
function defaultRetryable(err: unknown): boolean {
  if (err instanceof ModelError) return err.status === 429 || err.status >= 500;
  return false;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function historyReadCtx(model: Model, budgetTokens: number, signal?: AbortSignal) {
  return {
    model,
    budgetTokens,
    signal
  };
}
/**
* Internal implementation behind `Agent`.
*
* Owns the run loop: request assembly from history and skills, per-model
* retry and cross-model fallback, guardrails, parallel tool execution,
* structured-output capture and repair, approval suspension, cost accounting,
* and GenAI telemetry. This class is not part of the public `fino:ai/runtime`
* surface; applications construct an `Agent` from `fino:ai/agent`, which
* delegates every call here.
*
* ```ts no_run
* import { AgentRuntime } from 'internal:ai/runtime';
*
* const runtime = new AgentRuntime({ model, instructions: 'Be terse.' });
* const result = await runtime.generate({
*   messages: [{ role: 'user', content: 'ping' }],
* });
* console.log(result.text);
* ```
*/
export class AgentRuntime {
  #model: Model;
  #agentName?: string;
  #instructions?: string;
  #captureContent: boolean;
  #tools: Map<string, Tool>;
  #baseToolDefs: ToolDefinition[];
  #stopWhen: StopCondition[];
  #toolChoice?: 'auto' | 'any' | 'none' | {
    name: string;
  };
  #defaults: {
    temperature?: number;
    topP?: number;
    seed?: number;
    maxTokens?: number;
    stopSequences?: string[];
    providerOptions?: Record<string, unknown>;
  };
  #output?: Record<string, unknown>;
  #structuredOutputMode: 'tool' | 'native';
  #skills?: SkillRegistry;
  #skillLoadCache: Map<string, {
    instructions: string;
    tools: Record<string, Tool>;
  }> = new Map();
  #retry?: RetryOptions;
  #fallback: Model[];
  #guardrails?: Guardrails;
  #historyStrategy: HistoryStrategy;
  #budgetTokens: number;
  /**
  * Builds the runtime from resolved options.
  *
  * When a skill registry is supplied, the constructor appends the skill
  * manifest to the instructions and registers the registry's `load_skill`
  * loader tool alongside the configured tools.
  */
  constructor(opts: AgentRuntimeOptions) {
    this.#model = opts.model;
    this.#agentName = opts.name;
    this.#captureContent = opts.captureContent ?? false;
    this.#skills = opts.skills;
    this.#retry = opts.retry;
    this.#fallback = opts.fallback ?? [];
    this.#guardrails = opts.guardrails;
    this.#historyStrategy = opts.history ?? appendOnlyHistoryStrategy();
    this.#budgetTokens = opts.budgetTokens ?? 2e5;
    let baseInstructions = opts.instructions;
    const baseTools = [...opts.tools ?? []];
    if (opts.skills) {
      const manifest = opts.skills.manifest();
      if (manifest.length > 0) {
        const manifestBlock = '\n\n## Available skills\n' + manifest.map((s) => `- **${s.name}**: ${s.description}`).join('\n') + '\n\nCall the `load_skill` tool to load a skill\'s instructions and tools before using its capabilities.';
        baseInstructions = (baseInstructions ?? '') + manifestBlock;
      }
      baseTools.push(opts.skills.asLoaderTool());
    }
    this.#instructions = baseInstructions;
    this.#tools = new Map(baseTools.map((t) => [t.name, t]));
    this.#baseToolDefs = baseTools.map(toToolDefinition);
    this.#stopWhen = opts.stopWhen ? Array.isArray(opts.stopWhen) ? opts.stopWhen : [opts.stopWhen] : [maxSteps(8)];
    this.#toolChoice = opts.toolChoice;
    this.#defaults = opts.defaults ?? {};
    this.#output = opts.output ? normalizeSchema(opts.output) : undefined;
    this.#structuredOutputMode = opts.structuredOutputMode ?? 'tool';
  }
  async #streamWithRetryAndFallback(req: GenerateRequest, onEvent: ((ev: AgentEvent) => void) | undefined): Promise<{
    events: StreamEvent[];
    activeModel: Model;
  }> {
    const maxRetries = this.#retry?.maxRetries ?? 0;
    const baseDelayMs = this.#retry?.baseDelayMs ?? 500;
    const maxDelayMs = this.#retry?.maxDelayMs ?? 3e4;
    const retryOn = this.#retry?.retryOn;
    const models = [this.#model, ...this.#fallback];
    let lastErr: unknown;
    for (const activeModel of models) {
      if (activeModel !== this.#model) {
        onEvent?.({
          type: 'fallback',
          model: modelId(activeModel),
          provider: providerName(activeModel)
        });
      }
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          if (req.signal?.aborted) throw req.signal.reason;
          const retryAfterMs = lastErr instanceof ModelError && lastErr.retryAfterMs != null ? lastErr.retryAfterMs : Math.floor(Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
          onEvent?.({
            type: 'retry',
            attempt,
            model: modelId(activeModel),
            provider: providerName(activeModel),
            delayMs: retryAfterMs
          });
          await sleep(retryAfterMs);
        }
        const events: StreamEvent[] = [];
        let midStream = false;
        try {
          for await (const ev of activeModel.stream(req)) {
            midStream = true;
            events.push(ev);
            onEvent?.({
              type: 'model_event',
              event: ev
            });
          }
        } catch (err) {
          if (midStream) throw err;
          lastErr = err;
          const retryable = retryOn ? retryOn(err) : defaultRetryable(err);
          if (retryable && attempt < maxRetries) continue;
          break;
        }
        const stop = events.find((e): e is Extract<StreamEvent, {
          type: 'stop';
        }> => e.type === 'stop');
        if (stop && (stop.reason === 'refusal' || stop.reason === 'content_filter')) {
          lastErr = new ModelError(`Model refused: ${stop.reason}`, { status: 0 });
          break;
        }
        return {
          events,
          activeModel
        };
      }
    }
    throw lastErr ?? new Error('All models exhausted');
  }
  async #buildSkillAugmentation(messages: ModelMessage[], toolsMap: Map<string, Tool>, toolDefs: ToolDefinition[]): Promise<{
    toolsMap: Map<string, Tool>;
    toolDefs: ToolDefinition[];
    extraInstructions: string;
  }> {
    const loadedNames = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      const loadCalls = content.filter((p) => p['type'] === 'tool_use' && p['name'] === 'load_skill');
      if (!loadCalls.length) continue;
      const next = messages[i + 1];
      if (!next || next.role !== 'user') continue;
      const nextContent = Array.isArray(next.content) ? next.content as Array<Record<string, unknown>> : [];
      for (const call of loadCalls) {
        const result = nextContent.find((p) => p['type'] === 'tool_result' && p['toolCallId'] === call['id']);
        if (result && !result['isError']) {
          const args = call['args'] as Record<string, unknown> | undefined;
          if (typeof args?.['name'] === 'string') {
            loadedNames.add(args['name']);
          }
        }
      }
    }
    if (loadedNames.size === 0) {
      return {
        toolsMap,
        toolDefs,
        extraInstructions: ''
      };
    }
    const augToolsMap = new Map(toolsMap);
    const augToolDefs = [...toolDefs];
    let extraInstructions = '';
    for (const name of loadedNames) {
      let loaded = this.#skillLoadCache.get(name);
      if (!loaded) {
        loaded = await this.#skills!.load(name);
        this.#skillLoadCache.set(name, loaded);
      }
      for (const [k, v] of Object.entries(loaded.tools)) {
        if (!augToolsMap.has(k)) {
          augToolsMap.set(k, v);
          augToolDefs.push(toToolDefinition(v));
        }
      }
      extraInstructions += '\n\n' + loaded.instructions;
    }
    return {
      toolsMap: augToolsMap,
      toolDefs: augToolDefs,
      extraInstructions
    };
  }
  async #step(state: AgentState, toolsMap: Map<string, Tool>, toolDefs: ToolDefinition[], toolChoice: 'auto' | 'any' | 'none' | {
    name: string;
  } | undefined, onEvent: ((ev: AgentEvent) => void) | undefined, runId: string, responseFormat?: ResponseFormat): Promise<StepResult & {
    turn: {
      text: string;
      toolUseParts: ToolUsePart[];
    };
    activeModel: Model;
    appendedMessages: ModelMessage[];
  }> {
    let activeToolsMap = toolsMap;
    let activeToolDefs = toolDefs;
    let system = this.#instructions;
    if (this.#skills) {
      const aug = await this.#buildSkillAugmentation(state.messages, toolsMap, toolDefs);
      activeToolsMap = aug.toolsMap;
      activeToolDefs = aug.toolDefs;
      if (aug.extraInstructions) {
        system = (system ?? '') + aug.extraInstructions;
      }
    }
    let effectiveMessages = state.messages;
    const view = await this.#historyStrategy.onRead(historyReadCtx(this.#model, this.#budgetTokens, state.signal));
    this.#historyStrategy.history = view.history;
    effectiveMessages = view.messages;
    if (this.#guardrails?.input) {
      const gr = await this.#guardrails.input(effectiveMessages);
      onEvent?.({
        type: 'guardrail',
        stage: 'input',
        action: gr.action,
        reason: gr.reason
      });
      if (gr.action === 'block') throw new GuardrailError(gr.reason ?? 'Input blocked by guardrail', gr.reason);
      if (gr.action === 'redact') effectiveMessages = gr.messages ?? effectiveMessages;
    }
    const provider = providerName(this.#model);
    const requestModel = modelId(this.#model);
    const tracer = getTracerProvider().getTracer('fino.ai');
    const startAttrs: Record<string, unknown> = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': requestModel,
      'gen_ai.request.stream': true
    };
    if (this.#defaults.temperature != null) {
      startAttrs['gen_ai.request.temperature'] = this.#defaults.temperature;
    }
    if (this.#defaults.maxTokens != null) {
      startAttrs['gen_ai.request.max_tokens'] = this.#defaults.maxTokens;
    }
    const stepSpan = tracer.startSpan(`chat ${requestModel}`, { attributes: startAttrs });
    try {
      return await runWithActiveSpan(stepSpan, async () => {
        if (state.signal?.aborted) throw state.signal.reason;
        const req = {
          messages: effectiveMessages,
          ...system ? { system } : {},
          ...activeToolDefs.length > 0 ? { tools: activeToolDefs } : {},
          ...toolChoice !== undefined ? { toolChoice } : {},
          ...this.#defaults,
          ...responseFormat ? { responseFormat } : {},
          ...state.signal ? { signal: state.signal } : {}
        };
        const t0 = Date.now();
        const { events: buf, activeModel } = await this.#streamWithRetryAndFallback(req, onEvent);
        const rawTurn = await assembleResult(asyncOf(buf));
        const elapsed = (Date.now() - t0) / 1e3;
        let turnText = rawTurn.text;
        if (this.#guardrails?.output && turnText) {
          const gr = await this.#guardrails.output(turnText);
          onEvent?.({
            type: 'guardrail',
            stage: 'output',
            action: gr.action,
            reason: gr.reason
          });
          if (gr.action === 'block') throw new GuardrailError(gr.reason ?? 'Output blocked by guardrail', gr.reason);
          if (gr.action === 'redact') turnText = gr.text ?? turnText;
        }
        const turn = {
          ...rawTurn,
          text: turnText
        };
        const activeProvider = providerName(activeModel);
        const activeModelId = modelId(activeModel);
        if (activeModel !== this.#model) {
          stepSpan.setAttribute('gen_ai.request.model', activeModelId);
          stepSpan.setAttribute('gen_ai.provider.name', activeProvider);
        }
        const chatAttrs = {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': activeProvider,
          'gen_ai.request.model': activeModelId
        };
        const meter = getMeterProvider().getMeter('fino.ai');
        meter.createHistogram('gen_ai.client.operation.duration', {
          unit: 's',
          description: 'GenAI operation duration'
        }).record(elapsed, chatAttrs);
        meter.createHistogram('gen_ai.client.token.usage', {
          unit: '{token}',
          description: 'Measures number of input and output tokens used'
        }).record(turn.usage.inputTokens, {
          ...chatAttrs,
          'gen_ai.token.type': 'input'
        });
        meter.createHistogram('gen_ai.client.token.usage', {
          unit: '{token}',
          description: 'Measures number of input and output tokens used'
        }).record(turn.usage.outputTokens, {
          ...chatAttrs,
          'gen_ai.token.type': 'output'
        });
        const logAttrs: Record<string, unknown> = {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': activeProvider,
          'gen_ai.request.model': activeModelId,
          'gen_ai.response.finish_reasons': [turn.stopReason]
        };
        if (this.#captureContent) {
          logAttrs['gen_ai.input.messages'] = req.messages;
          if (system) logAttrs['gen_ai.system_instructions'] = system;
        }
        getLoggerProvider().getLogger('fino.ai').emitRecord(new LogRecordBuilder().setEventName('gen_ai.client.inference.operation.details').setSeverity('INFO', SeverityNumber.INFO).setAttributes(logAttrs));
        const toolUseParts: ToolUsePart[] = turn.toolCalls.map((tc) => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          args: tc.args
        }));
        const assistantContent: ContentPart[] = [];
        if (turn.text) assistantContent.push({
          type: 'text',
          text: turn.text
        });
        assistantContent.push(...toolUseParts);
        const newMessages: ModelMessage[] = [...effectiveMessages, {
          role: 'assistant',
          content: assistantContent.length === 1 && turnText && !toolUseParts.length ? turnText : assistantContent
        }];
        const newUsage = addUsage(state.usage, turn.usage);
        const stepIndex = state.stepIndex + 1;
        const stopReason: StopReason = turn.stopReason;
        stepSpan.setAttribute('gen_ai.response.finish_reasons', [stopReason]);
        stepSpan.setAttribute('gen_ai.usage.input_tokens', turn.usage.inputTokens);
        stepSpan.setAttribute('gen_ai.usage.output_tokens', turn.usage.outputTokens);
        if (turn.usage.cacheReadInputTokens != null) {
          stepSpan.setAttribute('gen_ai.usage.cache_read.input_tokens', turn.usage.cacheReadInputTokens);
        }
        if (turn.usage.cacheCreationInputTokens != null) {
          stepSpan.setAttribute('gen_ai.usage.cache_creation.input_tokens', turn.usage.cacheCreationInputTokens);
        }
        if (turn.usage.localCacheReadInputTokens != null) {
          stepSpan.setAttribute('gen_ai.usage.local_cache_read.input_tokens', turn.usage.localCacheReadInputTokens);
        }
        if (turn.usage.localCacheReadOutputTokens != null) {
          stepSpan.setAttribute('gen_ai.usage.local_cache_read.output_tokens', turn.usage.localCacheReadOutputTokens);
        }
        if (stopReason !== 'tool_use') {
          const nextState: AgentState = {
            messages: newMessages,
            stepIndex,
            usage: newUsage,
            signal: state.signal
          };
          stepSpan.end({ status: { code: 'OK' } });
          return {
            state: nextState,
            done: true,
            stopReason,
            turn: {
              text: turn.text,
              toolUseParts: []
            },
            activeModel,
            appendedMessages: [newMessages[newMessages.length - 1]!]
          };
        }
        const { toolResults, suspend } = await this.#runTools(toolUseParts, newMessages, state, runId, activeToolsMap, onEvent);
        const toolResultParts: ContentPart[] = toolResults.map(({ part, result }) => ({
          type: 'tool_result',
          toolCallId: part.id,
          content: result.content,
          ...result.isError ? { isError: true } : {}
        }));
        const messagesWithResults: ModelMessage[] = [...newMessages, ...toolResultParts.length > 0 ? [{
          role: 'user' as const,
          content: toolResultParts
        }] : []];
        const nextState: AgentState = {
          messages: messagesWithResults,
          stepIndex,
          usage: newUsage,
          signal: state.signal
        };
        stepSpan.end({ status: { code: 'OK' } });
        if (suspend) {
          onEvent?.({
            type: 'suspend',
            stepIndex: state.stepIndex,
            reason: suspend.message,
            payload: suspend.payload
          });
          return {
            state: nextState,
            done: false,
            suspend,
            stopReason,
            turn: {
              text: turn.text,
              toolUseParts
            },
            activeModel,
            appendedMessages: messagesWithResults.slice(newMessages.length - 1)
          };
        }
        return {
          state: nextState,
          done: false,
          stopReason,
          turn: {
            text: turn.text,
            toolUseParts
          },
          activeModel,
          appendedMessages: messagesWithResults.slice(newMessages.length - 1)
        };
      });
    } catch (err) {
      stepSpan.recordException?.(err);
      stepSpan.setAttribute('error.type', (err as Error)?.name ?? 'Error');
      stepSpan.end({ status: {
        code: 'ERROR',
        message: String(err)
      } });
      throw err;
    }
  }
  async #runTools(toolUseParts: ToolUsePart[], newMessages: ModelMessage[], state: AgentState, runId: string, toolsMap: Map<string, Tool>, onEvent: ((ev: AgentEvent) => void) | undefined): Promise<{
    toolResults: Array<{
      part: ToolUsePart;
      result: {
        content: string | ContentPart[];
        isError?: boolean;
      };
    }>;
    suspend?: SuspendSignal;
  }> {
    const tracer = getTracerProvider().getTracer('fino.ai');
    const sig = state.signal ?? new AbortController().signal;
    const settled = await Promise.allSettled(toolUseParts.map(async (part) => {
      const toolSpan = tracer.startSpan(`execute_tool ${part.name}`, { attributes: {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': part.name,
        'gen_ai.tool.call.id': part.id,
        'gen_ai.tool.type': 'function'
      } });
      const t = toolsMap.get(part.name);
      if (!t) {
        toolSpan.setAttribute('error.type', 'UnknownToolError');
        toolSpan.end({ status: { code: 'ERROR' } });
        return {
          part,
          result: {
            content: `Unknown tool: ${part.name}`,
            isError: true as const
          }
        };
      }
      onEvent?.({
        type: 'tool_start',
        stepIndex: state.stepIndex,
        id: part.id,
        name: part.name
      });
      if (t.requiresApproval) {
        throw new SuspendSignal(`Approval required for tool: ${part.name}`, {
          type: 'tool_approval',
          toolCallId: part.id,
          toolName: part.name,
          args: part.args,
          risk: t.risk,
          sideEffects: t.sideEffects
        });
      }
      const ctx: ToolRunContext = {
        signal: sig,
        toolCallId: part.id,
        step: state.stepIndex,
        runId,
        messages: newMessages,
        history: state.history,
        suspend: (sOpts?) => {
          throw new SuspendSignal(sOpts?.reason, sOpts?.payload);
        }
      };
      const toolT0 = Date.now();
      try {
        const result = await runWithActiveSpan(toolSpan, () => t.invoke(part.args, ctx));
        const toolElapsed = (Date.now() - toolT0) / 1e3;
        getMeterProvider().getMeter('fino.ai').createHistogram('gen_ai.client.operation.duration', {
          unit: 's',
          description: 'GenAI operation duration'
        }).record(toolElapsed, {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': part.name
        });
        if (result.isError) {
          toolSpan.recordException?.(new Error(typeof result.content === 'string' ? result.content : 'tool error'));
          toolSpan.setAttribute('error.type', 'ToolError');
          toolSpan.end({ status: { code: 'ERROR' } });
        } else {
          toolSpan.end({ status: { code: 'OK' } });
        }
        onEvent?.({
          type: 'tool_result',
          stepIndex: state.stepIndex,
          id: part.id,
          name: part.name,
          ...result.isError ? { isError: true } : {}
        });
        return {
          part,
          result
        };
      } catch (err) {
        const toolElapsed = (Date.now() - toolT0) / 1e3;
        getMeterProvider().getMeter('fino.ai').createHistogram('gen_ai.client.operation.duration', {
          unit: 's',
          description: 'GenAI operation duration'
        }).record(toolElapsed, {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': part.name,
          'error.type': (err as Error)?.name ?? 'Error'
        });
        toolSpan.recordException?.(err);
        toolSpan.setAttribute('error.type', (err as Error)?.name ?? 'Error');
        toolSpan.end({ status: {
          code: 'ERROR',
          message: String(err)
        } });
        if ((err as Error)?.name !== 'SuspendSignal') {
          onEvent?.({
            type: 'tool_error',
            stepIndex: state.stepIndex,
            id: part.id,
            name: part.name,
            message: (err as Error)?.message ?? String(err)
          });
        }
        throw err;
      }
    }));
    let suspend: SuspendSignal | undefined;
    const toolResults: Array<{
      part: ToolUsePart;
      result: {
        content: string | ContentPart[];
        isError?: boolean;
      };
    }> = [];
    for (const s of settled) {
      if (s.status === 'rejected') {
        const err = s.reason as Error;
        if (err.name === 'SuspendSignal') {
          if (!suspend) suspend = s.reason as SuspendSignal;
        } else {
          throw err;
        }
      } else {
        toolResults.push(s.value);
      }
    }
    return {
      toolResults,
      suspend
    };
  }
  async #invokeApprovedTool(request: ToolApprovalRequest, approval: unknown, state: AgentState, runId: string): Promise<{
    part: ToolUsePart;
    result: {
      content: string | ContentPart[];
      isError?: boolean;
    };
  }> {
    const approved = approval === true || typeof approval === 'object' && approval !== null && (approval as {
      approved?: unknown;
    }).approved === true;
    const reason = typeof approval === 'object' && approval !== null && typeof (approval as {
      reason?: unknown;
    }).reason === 'string' ? (approval as {
      reason: string;
    }).reason : 'not approved';
    const part: ToolUsePart = {
      type: 'tool_use',
      id: request.toolCallId,
      name: request.toolName,
      args: request.args
    };
    if (!approved) {
      return {
        part,
        result: {
          content: `Tool call rejected: ${reason}`,
          isError: true
        }
      };
    }
    const tool = this.#tools.get(request.toolName);
    if (!tool) {
      return {
        part,
        result: {
          content: `Unknown tool: ${request.toolName}`,
          isError: true
        }
      };
    }
    const signal = state.signal ?? new AbortController().signal;
    const ctx: ToolRunContext = {
      signal,
      toolCallId: request.toolCallId,
      step: state.stepIndex,
      runId,
      messages: state.messages,
      history: state.history,
      suspend: (sOpts?) => {
        throw new SuspendSignal(sOpts?.reason, sOpts?.payload);
      }
    };
    return {
      part,
      result: await tool.invoke(request.args, ctx)
    };
  }
  #hasPendingToolCall(messages: ModelMessage[], request: ToolApprovalRequest): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      if (msg.content.some((part) => part.type === 'tool_use' && part.id === request.toolCallId && part.name === request.toolName)) {
        const next = messages[i + 1];
        if (!next || next.role !== 'user' || !Array.isArray(next.content)) return true;
        return !next.content.some((part) => part.type === 'tool_result' && part.toolCallId === request.toolCallId);
      }
    }
    return false;
  }
  async #foldStep(raw: {
    state: AgentState;
    activeModel: Model;
    appendedMessages?: ModelMessage[];
  }, prevState: AgentState, history: MessageHistory, runningCost: number): Promise<{
    state: AgentState;
    history: MessageHistory;
    cost: number;
  }> {
    const delta = subUsage(raw.state.usage, prevState.usage);
    const newCost = runningCost + costOf(delta, raw.activeModel.name, PRICING);
    const newMessages = raw.appendedMessages ?? raw.state.messages.slice(prevState.messages.length);
    for (const msg of newMessages) {
      await this.#historyStrategy.onAppend(msg, {
        model: raw.activeModel,
        budgetTokens: this.#budgetTokens,
        signal: raw.state.signal,
        stepIndex: raw.state.stepIndex
      });
    }
    const nextHistory = this.#historyStrategy.history;
    return {
      state: {
        ...raw.state,
        messages: nextHistory.render(),
        cost: newCost,
        history: nextHistory
      },
      history: nextHistory,
      cost: newCost
    };
  }
  async #runLoop(initialState: AgentState, onEvent: ((ev: AgentEvent) => void) | undefined, toolsMap: Map<string, Tool>, toolDefs: ToolDefinition[], toolChoice: 'auto' | 'any' | 'none' | {
    name: string;
  } | undefined, responseFormat?: ResponseFormat, outputSchema?: Record<string, unknown>): Promise<AgentResult> {
    const runId = newRunId();
    const provider = providerName(this.#model);
    const requestModel = modelId(this.#model);
    const tracer = getTracerProvider().getTracer('fino.ai');
    const runAttrs: Record<string, unknown> = {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': requestModel,
      'gen_ai.conversation.id': runId
    };
    if (this.#agentName) runAttrs['gen_ai.agent.name'] = this.#agentName;
    const runSpan = tracer.startSpan('invoke_agent', { attributes: runAttrs });
    const runT0 = Date.now();
    let activeToolsMap = toolsMap;
    let activeToolDefs = toolDefs;
    let activeToolChoice = toolChoice;
    const capture = outputSchema !== undefined ? {
      captured: false,
      args: undefined as unknown,
      retried: false
    } : null;
    if (capture) {
      const respondTool = new Tool({
        name: 'respond',
        description: 'Provide the final structured response.',
        parameters: outputSchema,
        execute: (args) => {
          capture.captured = true;
          capture.args = args;
          return 'OK';
        }
      });
      activeToolsMap = new Map([...toolsMap, ['respond', respondTool]]);
      activeToolDefs = [...toolDefs, toToolDefinition(respondTool)];
      activeToolChoice = { name: 'respond' };
    }
    let history = initialState.history ?? this.#historyStrategy.history;
    this.#historyStrategy.history = history;
    for (const msg of initialState.messages) {
      await this.#historyStrategy.onAppend(msg, {
        model: this.#model,
        budgetTokens: this.#budgetTokens,
        signal: initialState.signal,
        stepIndex: initialState.stepIndex
      });
    }
    history = this.#historyStrategy.history;
    let runningCost = initialState.cost ?? 0;
    try {
      return await runWithActiveSpan(runSpan, async () => {
        const runState = {
          runId,
          stepIndex: 0,
          signal: initialState.signal
        };
        return runContext.runWithValue(runState, async () => {
          let state = {
            ...initialState,
            history
          };
          const steps: AgentState[] = [];
          let finalText = '';
          let finalStopReason: StopReason = 'end_turn';
          while (true) {
            runState.stepIndex = state.stepIndex;
            const prevState = state;
            onEvent?.({
              type: 'step_start',
              stepIndex: state.stepIndex,
              model: requestModel,
              provider
            });
            const r = await this.#step(state, activeToolsMap, activeToolDefs, activeToolChoice, onEvent, runId, responseFormat);
            onEvent?.({
              type: 'step_end',
              stepIndex: state.stepIndex,
              stopReason: r.stopReason,
              model: modelId(r.activeModel),
              provider: providerName(r.activeModel)
            });
            steps.push(r.state);
            const folded = await this.#foldStep(r, prevState, history, runningCost);
            runningCost = folded.cost;
            history = folded.history;
            state = folded.state;
            finalStopReason = r.stopReason;
            finalText = r.turn.text;
            if (capture) {
              if (capture.captured) break;
              if (r.done) throw new Error('Model did not call respond tool for structured output');
              if (r.suspend) throw new Error('Structured output run suspended before respond was called');
              if (capture.retried) throw new Error('Structured output validation failed after repair');
              capture.retried = true;
            } else if (r.suspend || r.done || this.#stopWhen.some((c) => c(state, { stopReason: r.stopReason }))) {
              break;
            }
          }
          const runElapsed = (Date.now() - runT0) / 1e3;
          getMeterProvider().getMeter('fino.ai').createHistogram('gen_ai.client.operation.duration', {
            unit: 's',
            description: 'GenAI operation duration'
          }).record(runElapsed, {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.provider.name': provider,
            'gen_ai.request.model': requestModel
          });
          runSpan.setAttribute('gen_ai.response.finish_reasons', [finalStopReason]);
          runSpan.setAttribute('gen_ai.usage.input_tokens', state.usage.inputTokens);
          runSpan.setAttribute('gen_ai.usage.output_tokens', state.usage.outputTokens);
          if (state.usage.localCacheReadInputTokens != null) {
            runSpan.setAttribute('gen_ai.usage.local_cache_read.input_tokens', state.usage.localCacheReadInputTokens);
          }
          if (state.usage.localCacheReadOutputTokens != null) {
            runSpan.setAttribute('gen_ai.usage.local_cache_read.output_tokens', state.usage.localCacheReadOutputTokens);
          }
          runSpan.end({ status: { code: 'OK' } });
          const result: AgentResult = {
            text: finalText,
            messages: state.messages,
            steps,
            usage: state.usage,
            cost: runningCost,
            stopReason: finalStopReason
          };
          if (capture) result.object = capture.args;
          onEvent?.({
            type: 'final',
            result
          });
          return result;
        });
      });
    } catch (err) {
      const runElapsed = (Date.now() - runT0) / 1e3;
      getMeterProvider().getMeter('fino.ai').createHistogram('gen_ai.client.operation.duration', {
        unit: 's',
        description: 'GenAI operation duration'
      }).record(runElapsed, {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': provider,
        'gen_ai.request.model': requestModel,
        'error.type': (err as Error)?.name ?? 'Error'
      });
      runSpan.recordException?.(err);
      runSpan.setAttribute('error.type', (err as Error)?.name ?? 'Error');
      runSpan.end({ status: {
        code: 'ERROR',
        message: String(err)
      } });
      throw err;
    }
  }
  /**
  * Run one model/tool step from an existing state.
  *
  * Seeds the history strategy first: when `state.history` is present, any
  * `state.messages` beyond what that history renders are appended; for a
  * fresh (empty) strategy, all of `state.messages` are appended. The step
  * itself emits no agent events. An ambient run context is reused when
  * present; otherwise a new run id is minted for this call. Harnesses such as
  * `fino:ai/session` drive the loop step-by-step with this method so each
  * transition can be checkpointed.
  *
  * ```ts no_run
  * let r = await runtime.step({
  *   messages: [{ role: 'user', content: 'What is 2 + 2?' }],
  *   stepIndex: 0,
  *   usage: { inputTokens: 0, outputTokens: 0 },
  * });
  * while (!r.done && !r.suspend) r = await runtime.step(r.state);
  * ```
  */
  step(state: AgentState): Promise<StepResult> {
    const existing = runContext.get();
    const runId = existing?.runId ?? newRunId();
    const doStep = async (): Promise<StepResult> => {
      if (state.history) {
        this.#historyStrategy.history = state.history;
        const baseLen = state.history.render().length;
        for (const msg of state.messages.slice(baseLen)) {
          await this.#historyStrategy.onAppend(msg, {
            model: this.#model,
            budgetTokens: this.#budgetTokens,
            signal: state.signal,
            stepIndex: state.stepIndex,
            runId
          });
        }
      } else if (this.#historyStrategy.history.size === 0) {
        for (const msg of state.messages) {
          await this.#historyStrategy.onAppend(msg, {
            model: this.#model,
            budgetTokens: this.#budgetTokens,
            signal: state.signal,
            stepIndex: state.stepIndex,
            runId
          });
        }
      }
      const raw = await this.#step(state, this.#tools, this.#baseToolDefs, this.#toolChoice, undefined, runId);
      const { state: foldedState } = await this.#foldStep(raw, state, this.#historyStrategy.history, state.cost ?? 0);
      return {
        state: foldedState,
        done: raw.done,
        suspend: raw.suspend,
        stopReason: raw.stopReason
      };
    };
    if (existing) return doStep();
    const runState = {
      runId,
      stepIndex: state.stepIndex,
      signal: state.signal
    };
    return runContext.runWithValue(runState, doStep);
  }
  /**
  * Execute or reject a pending approval-required tool call.
  *
  * `approval` may be `true` or `{ approved: true }` to execute the tool;
  * anything else records a rejection tool result (using `reason` from the
  * approval object when present) so the model sees the denial. The resulting
  * `tool_result` message is appended through the history strategy, and the
  * returned step has `done: false` and `stopReason: 'tool_use'`, ready for
  * the next `step()` call.
  *
  * Throws if the referenced tool call is not actually pending — no matching
  * `tool_use` exists in history, or it already has a `tool_result` — which
  * makes approval tokens effectively single-use.
  *
  * ```ts no_run
  * const request = r.suspend!.payload as ToolApprovalRequest;
  * const next = await runtime.approveTool(r.state, request, { approved: true });
  * const resumed = await runtime.step(next.state);
  * ```
  */
  async approveTool(state: AgentState, request: ToolApprovalRequest, approval: unknown): Promise<StepResult> {
    const existing = runContext.get();
    const runId = existing?.runId ?? newRunId();
    const doApprove = async (): Promise<StepResult> => {
      const history = state.history ?? this.#historyStrategy.history;
      this.#historyStrategy.history = history;
      const messages = history.render();
      if (!this.#hasPendingToolCall(messages, request)) {
        throw new Error(`Pending tool call ${request.toolCallId} was not found`);
      }
      const { part, result } = await this.#invokeApprovedTool(request, approval, {
        ...state,
        messages,
        history
      }, runId);
      const toolResultMessage: ModelMessage = {
        role: 'user',
        content: [{
          type: 'tool_result',
          toolCallId: part.id,
          content: result.content,
          ...result.isError ? { isError: true } : {}
        }]
      };
      await this.#historyStrategy.onAppend(toolResultMessage, {
        model: this.#model,
        budgetTokens: this.#budgetTokens,
        signal: state.signal,
        stepIndex: state.stepIndex,
        runId
      });
      const nextHistory = this.#historyStrategy.history;
      return {
        state: {
          ...state,
          messages: nextHistory.render(),
          history: nextHistory
        },
        done: false,
        stopReason: 'tool_use'
      };
    };
    if (existing) return doApprove();
    const runState = {
      runId,
      stepIndex: state.stepIndex,
      signal: state.signal
    };
    return runContext.runWithValue(runState, doApprove);
  }
  #runWithOutput(state: AgentState, onEvent: ((ev: AgentEvent) => void) | undefined): Promise<AgentResult> {
    if (!this.#output) {
      return this.#runLoop(state, onEvent, this.#tools, this.#baseToolDefs, this.#toolChoice);
    }
    const supportsNative = this.#model.capabilities?.structuredOutput?.native === true;
    if (this.#structuredOutputMode === 'native' && supportsNative) {
      const responseFormat: ResponseFormat = {
        type: 'json_schema',
        name: 'response',
        schema: this.#output
      };
      return this.#runLoop(state, onEvent, new Map(), [], 'none', responseFormat).then((r) => {
        try {
          return {
            ...r,
            object: JSON.parse(r.text)
          };
        } catch {
          throw new Error('Model returned invalid JSON for native structured output');
        }
      });
    }
    return this.#runLoop(state, onEvent, this.#tools, this.#baseToolDefs, this.#toolChoice, undefined, this.#output);
  }
  /**
  * Run the loop to completion and return the final result.
  *
  * Starts a fresh state from the input messages and loops until the model
  * finishes, a stop condition fires, a tool suspends the run, or an error is
  * thrown. This is `stream()` without event delivery — the same loop runs,
  * only the observers differ.
  *
  * ```ts no_run
  * const result = await runtime.generate({
  *   messages: [{ role: 'user', content: 'Summarize HTTP/3 in one line.' }],
  * });
  * console.log(result.text, result.stopReason);
  * ```
  */
  generate(input: RunInput): Promise<AgentResult> {
    return this.#runWithOutput({
      messages: input.messages,
      stepIndex: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0
      },
      signal: input.signal
    }, undefined);
  }
  /**
  * Start a streamed run.
  *
  * Runs the same loop as `generate()` while delivering every `AgentEvent`
  * through the returned handle's `reader` and folding events into its
  * retained `state` signal. The run begins immediately; on failure the reader
  * is failed with the error and `result` rejects, so callers should consume
  * the reader, await `result`, or both.
  *
  * ```ts no_run
  * const stream = runtime.stream({
  *   messages: [{ role: 'user', content: 'Stream a limerick.' }],
  * });
  * for await (const ev of stream.reader) {
  *   if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
  *     render(ev.event.text);
  *   }
  * }
  * const final = await stream.result;
  * ```
  */
  stream(input: RunInput): AgentStream {
    const ch = new Channel<AgentEvent>();
    const w = ch.writer;
    const state = createSignal<AgentRunView>(initialAgentRunView());
    const modelState = initialModelStreamState();
    const textByIndex = new Map<number, string>();
    const onEvent = (ev: AgentEvent) => {
      state.set((current) => foldAgentEvent(current, modelState, ev, textByIndex));
      void w.write(ev);
    };
    const result = this.#runWithOutput({
      messages: input.messages,
      stepIndex: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0
      },
      signal: input.signal
    }, onEvent).then((r) => {
      state.set((current) => current.status === 'done' ? current : {
        ...current,
        status: 'done',
        currentTool: null,
        text: r.text,
        usage: r.usage,
        cost: r.cost,
        stepIndex: r.steps.length
      });
      void w.close();
      return r;
    }, (err) => {
      state.set((current) => ({
        ...current,
        status: 'error',
        currentTool: null
      }));
      w.fail(err);
      throw err;
    });
    return {
      reader: ch.reader,
      result,
      state
    };
  }
}
