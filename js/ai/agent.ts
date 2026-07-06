/**
* fino:ai/agent — high-level model loop with tools and strategy-owned history.
*
* This module is the primary entry point for agent applications. An `Agent`
* owns the model loop: it sends curated messages to a `Model`, executes tool
* calls, accumulates usage and cost, applies guardrails, and stops when the
* model finishes or a configured stop condition fires. Use this module when an
* application wants a complete LLM interaction loop instead of calling provider
* adapters directly.
*
* ## Design
*
* History policy is intentionally external. The agent appends incoming,
* assistant, and tool-result messages through a `HistoryStrategy`, then asks
* that strategy for the model-facing view before each request. The default is
* append-only in-memory history. Durable sessions, summarization, selective
* retrieval, and memory emission are supplied by strategies and session stores,
* not by hidden agent state.
*
* Tools are ordinary `Tool` values. They receive abort/run context and may
* throw `SuspendSignal` to pause a durable session. Agents can also be wrapped
* as tools with `asTool()` for simple composition; more structured branching or
* checkpointed orchestration belongs in `fino:workflow`.
*
* Runs are resilient by configuration: `retry` adds backoff for provider
* failures, `fallback` tries alternate models in order, and `guardrails` can
* block a run or redact content on the way in and out. A run ends when the
* model stops without requesting tools, a `stopWhen` condition fires (the
* default is eight model steps), or a tool suspends. Every step and run emits
* OpenTelemetry `gen_ai` spans, metrics, and log records.
*
* ```ts no_run
* import { agent, streamText } from 'fino:ai/agent';
* import { openai } from 'fino:ai/model';
* import { tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const bot = agent({
*   model: openai({ model: 'gpt-4o' }),
*   instructions: 'Answer briefly.',
*   tools: [tool({
*     name: 'lookup',
*     description: 'Look up a value by key.',
*     parameters: v.object({ key: v.string().describe('Lookup key') }),
*     execute: ({ key }: { key: string }) => `value for ${key}`,
*   })],
* });
*
* const stream = bot.stream('lookup account status');
* for await (const text of streamText(stream)) console.log(text);
* const result = await stream.result;
* ```
*/
import { AgentRuntime, streamText as runtimeStreamText } from 'internal:ai/runtime';
import type { AgentRuntimeOptions, AgentState, StepResult, RunInput, AgentResult, AgentStream, AgentEvent, AgentRunView, ToolApprovalRequest } from 'internal:ai/runtime';
import { appendOnlyHistoryStrategy } from 'fino:ai/context';
import type { HistoryStrategy } from 'fino:ai/context';
import { tool } from 'fino:ai/tool';
import type { SchemaBuilder } from 'fino:validate';
function normalizeInput(input: string | RunInput): RunInput {
  if (typeof input === 'string') {
    return { messages: [{
      role: 'user',
      content: input
    }] };
  }
  return input;
}
/**
* Runtime types re-exported for application code.
*
* These describe the values that flow through a run: `AgentState` is the
* per-run state threaded through `Agent.step()`, `StepResult` reports one
* step's outcome, `RunInput` is the message-list input form accepted by
* `generate()` and `stream()`, `AgentResult` is a run's final result, and
* `AgentStream`, `AgentEvent`, and `AgentRunView` describe streaming.
* Importing them from here avoids a separate dependency on `fino:ai/runtime`.
*/
export type { AgentState, StepResult, RunInput, AgentResult, AgentStream, AgentEvent, AgentRunView };
/**
* Iterate over only the text deltas from an agent stream.
*
* Filters the stream's event reader down to `model_event` text deltas and
* yields each fragment as it arrives. Every other event — tool activity,
* retries, guardrails, step boundaries — is consumed and discarded, so use
* the raw `stream.reader` instead when those matter. The generator finishes
* when the run completes and rethrows the run's error if it fails. Because it
* consumes `stream.reader`, do not also iterate the reader yourself.
*
* ```ts no_run
* import { agent, streamText } from 'fino:ai/agent';
* import { anthropic } from 'fino:ai/model';
*
* const bot = agent({ model: anthropic({ model: 'claude-sonnet-4-6' }) });
* const stream = bot.stream('Tell me a short story.');
* for await (const text of streamText(stream)) console.log(text);
* const result = await stream.result;
* ```
*/
export function streamText(stream: AgentStream): AsyncGenerator<string> {
  return runtimeStreamText(stream);
}
/**
* Options for `Agent` and `agent()`.
*
* `model` is the only required field. `instructions` becomes the system
* prompt. `tools` and `skills` define what the model may call; a skill
* registry adds a manifest of available skills to the instructions plus a
* `load_skill` tool that pulls in a skill's instructions and tools on demand.
* `stopWhen` takes one or more `StopCondition`s and defaults to stopping
* after eight model steps. `output` requests structured output — a
* `fino:validate` builder or plain JSON Schema — surfaced as
* `AgentResult.object`. `retry`, `fallback`, and `guardrails` control
* resilience and content policy.
*
* `history` defaults to an append-only in-memory strategy. Supplying a strategy
* gives that strategy complete ownership of append and read-time curation —
* summarization, selective retrieval, and durable persistence all live there.
*
* ```ts no_run
* import { agent, type AgentOptions } from 'fino:ai/agent';
* import { anthropic, openai } from 'fino:ai/model';
* import { maxSteps } from 'fino:ai/runtime';
*
* const opts: AgentOptions = {
*   model: anthropic({ model: 'claude-sonnet-4-6' }),
*   instructions: 'You are a careful analyst.',
*   stopWhen: maxSteps(4),
*   fallback: [openai({ model: 'gpt-4o' })],
*   retry: { maxRetries: 2 },
* };
* const bot = agent(opts);
* ```
*/
export type AgentOptions = Omit<AgentRuntimeOptions, 'history'> & {
  history?: HistoryStrategy;
};
/**
* Runs an agent loop against a model.
*
* Each step curates history through the configured strategy, sends the
* model-facing view to the model, executes any requested tool calls, and
* appends the results. The loop repeats until the model stops without
* requesting tools, a `stopWhen` condition fires, or a tool throws
* `SuspendSignal`. Usage and cost accumulate across steps and are reported on
* the final `AgentResult`.
*
* `generate()` and `stream()` are the usual entry points. `step()` and
* `approveTool()` are lower-level hooks used by `fino:ai/session` for
* durable, resumable runs that checkpoint between steps.
*
* ```ts no_run
* import { Agent } from 'fino:ai/agent';
* import { anthropic } from 'fino:ai/model';
*
* const bot = new Agent({
*   model: anthropic({ model: 'claude-sonnet-4-6' }),
*   instructions: 'You are a terse assistant.',
* });
* const result = await bot.generate('What is the capital of France?');
* console.log(result.text, result.usage.outputTokens);
* ```
*/
export class Agent {
  #runtime: AgentRuntime;
  /**
  * Optional display name.
  *
  * Recorded as the `gen_ai.agent.name` telemetry attribute on run spans and
  * used as the default tool name by `asTool()`.
  */
  name?: string;
  /**
  * Create an agent from `AgentOptions`, installing the default append-only
  * in-memory history strategy when none is supplied.
  */
  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.#runtime = new AgentRuntime({
      history: appendOnlyHistoryStrategy(),
      ...opts
    });
  }
  /**
  * Run one model/tool step from an existing state.
  *
  * Sends the state's messages to the model, executes any tool calls the
  * model requests, and returns the advanced state. `done` is true when the
  * model stopped without requesting tools; `suspend` carries the
  * `SuspendSignal` when a tool paused the run. Messages the history strategy
  * has not yet seen are appended before the request. The caller owns the
  * loop: feed `result.state` back into the next call and apply stop
  * conditions itself — `stopWhen` is only consulted by `generate()` and
  * `stream()`.
  *
  * Most applications should use `generate()` or `stream()`; `step()` exists
  * for custom loop control, such as sessions checkpointing between steps.
  *
  * ```ts no_run
  * import type { AgentState } from 'fino:ai/agent';
  *
  * let state: AgentState = {
  *   messages: [{ role: 'user', content: 'hi' }],
  *   stepIndex: 0,
  *   usage: { inputTokens: 0, outputTokens: 0 },
  * };
  * for (let i = 0; i < 8; i++) {
  *   const r = await bot.step(state);
  *   state = r.state;
  *   if (r.done || r.suspend) break;
  * }
  * ```
  */
  step(state: AgentState): Promise<StepResult> {
    return this.#runtime.step(state);
  }
  /**
  * Execute or reject a pending approval-required tool call.
  *
  * Resumes a run that suspended because a tool required approval. When
  * `approval` is `true` or `{ approved: true }` the tool executes with the
  * original arguments; any other value records an error tool result of the
  * form `Tool call rejected: <reason>`. Either way the outcome is appended
  * to history as a tool-result message and the returned `StepResult` carries
  * the advanced state, ready for the next `step()`.
  *
  * Throws if `request.toolCallId` is not the pending, unresolved tool call
  * at the end of history — for example when it was already resolved or the
  * conversation has moved on.
  *
  * Sessions call this after validating a resume token. Application code
  * should usually use `Session.approveTool()` or `Session.rejectTool()`
  * instead so the decision and resulting tool output are checkpointed
  * durably.
  */
  approveTool(state: AgentState, request: ToolApprovalRequest, approval: unknown): Promise<StepResult> {
    return this.#runtime.approveTool(state, request, approval);
  }
  /**
  * Run until the agent reaches a stop condition, suspension, or error.
  *
  * A plain string is wrapped as a single user message; pass a `RunInput` to
  * supply multiple messages or an abort signal. The resolved `AgentResult`
  * carries the final assistant text, the full message transcript, per-step
  * states, accumulated usage and cost, and the final stop reason. When an
  * `output` schema is configured the validated structured value is on
  * `result.object`.
  *
  * Throws `GuardrailError` when a guardrail blocks input or output, and
  * rethrows the last provider error once retries and fallback models are
  * exhausted.
  *
  * ```ts no_run
  * const result = await bot.generate('Summarize the release notes.');
  * console.log(result.text);
  * console.log(result.usage.inputTokens, result.usage.outputTokens);
  * ```
  */
  generate(input: string | RunInput): Promise<AgentResult> {
    return this.#runtime.generate(normalizeInput(input));
  }
  /**
  * Start a streamed run.
  *
  * The run begins immediately. The returned `AgentStream` exposes three
  * views: `reader` yields every `AgentEvent` (model deltas, tool activity,
  * retries, guardrails, suspension, and the final result); `result` resolves
  * to the same `AgentResult` that `generate()` would return; and `state` is
  * a signal holding a coarse `AgentRunView` for progress display without
  * consuming the reader. Awaiting `result` without ever reading events is
  * fine. A failed run rejects `result` and fails the reader with the same
  * error.
  *
  * ```ts no_run
  * const stream = bot.stream('Plan my week.');
  * for await (const ev of stream.reader) {
  *   if (ev.type === 'tool_start') console.log('calling', ev.name);
  *   if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
  *     console.log(ev.event.text);
  *   }
  * }
  * const result = await stream.result;
  * ```
  */
  stream(input: string | RunInput): AgentStream {
    return this.#runtime.stream(normalizeInput(input));
  }
  /**
  * Expose this agent as a tool for composition with another agent.
  *
  * The wrapper tool runs `generate()` on this agent and returns the run's
  * final text. Its name defaults to `opts.name`, then the agent's `name`,
  * then `'agent'`. `input` may be a `fino:validate` builder or plain JSON
  * Schema describing the arguments the calling model should supply; when
  * omitted the tool accepts an empty object. Non-empty arguments are
  * JSON-stringified into the sub-agent's user message, and empty arguments
  * become the prompt `'Please respond.'`. The caller's abort signal is
  * forwarded to the sub-agent run.
  *
  * This is the simple composition primitive — for branching, checkpointing,
  * or parallel orchestration, use `fino:workflow` instead.
  *
  * ```ts no_run
  * import { agent } from 'fino:ai/agent';
  * import { openai } from 'fino:ai/model';
  * import { v } from 'fino:validate';
  *
  * const researcher = agent({
  *   model: openai({ model: 'gpt-4o' }),
  *   name: 'researcher',
  *   instructions: 'Research the topic and report findings.',
  * });
  *
  * const writer = agent({
  *   model: openai({ model: 'gpt-4o' }),
  *   instructions: 'Write articles. Use the researcher for facts.',
  *   tools: [researcher.asTool({
  *     description: 'Research a topic and return findings.',
  *     input: v.object({ topic: v.string().describe('Topic to research') }),
  *   })],
  * });
  *
  * const article = await writer.generate('Write about deep-sea vents.');
  * ```
  */
  asTool(opts: {
    name?: string;
    description: string;
    input?: SchemaBuilder | Record<string, unknown>;
  }): ReturnType<typeof tool> {
    const toolName = opts.name ?? this.name ?? 'agent';
    const parameters = opts.input && typeof opts.input === 'object' && 'schema' in opts.input ? (opts.input as SchemaBuilder).schema : opts.input as Record<string, unknown> | undefined ?? {
      type: 'object',
      properties: {}
    };
    return tool({
      name: toolName,
      description: opts.description,
      parameters,
      execute: async (args, ctx) => {
        const input = typeof args === 'object' && args !== null && Object.keys(args as object).length > 0 ? JSON.stringify(args) : 'Please respond.';
        const result = await this.generate({
          messages: [{
            role: 'user',
            content: input
          }],
          signal: ctx.signal
        });
        return result.text;
      }
    });
  }
}
/**
* Create an `Agent`.
*
* Convenience factory equivalent to `new Agent(opts)`.
*
* ```ts no_run
* import { agent } from 'fino:ai/agent';
* import { anthropic } from 'fino:ai/model';
*
* const bot = agent({
*   model: anthropic({ model: 'claude-sonnet-4-6' }),
*   instructions: 'Answer briefly.',
* });
* const result = await bot.generate('hello');
* ```
*/
export function agent(opts: AgentOptions): Agent {
  return new Agent(opts);
}
