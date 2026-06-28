/**
 * internal:ai/runtime — implementation of the agent model loop.
 *
 * This module contains the mutable runtime behind `fino:ai/agent`: model
 * request assembly, tool execution, structured-output repair, guardrail checks,
 * fallback/retry behavior, telemetry, and stream plumbing. Public application
 * code should import `Agent` from `fino:ai/agent` and integration helpers from
 * `fino:ai/runtime` instead of constructing `AgentRuntime` directly.
 *
 * The implementation deliberately keeps history policy out of the runtime. It
 * calls `HistoryStrategy.onAppend()` when messages are recorded and
 * `HistoryStrategy.onRead()` before model requests; all compaction, retrieval,
 * summarization, and memory emission decisions belong to the strategy.
 *
 * @internal
 */

import type { Model, ModelMessage, StreamEvent, StopReason, ToolUsePart, ContentPart, Usage, ToolDefinition, GenerateRequest, ResponseFormat } from 'fino:ai/model';
import { assembleResult, ModelError, normalizeSchema } from 'internal:ai/shared';
import type { SchemaLike } from 'internal:ai/shared';
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
 */
export class GuardrailError extends Error {
  reason?: string;

  constructor(message: string, reason?: string) {
    super(message);
    this.name = 'GuardrailError';
    this.reason = reason;
  }
}

/**
 * Result returned by an input or output guardrail.
 */
export interface GuardrailResult {
  action: 'allow' | 'block' | 'redact';
  messages?: ModelMessage[];
  text?: string;
  reason?: string;
}

/**
 * Optional input and output guardrails for an agent.
 */
export interface Guardrails {
  input?: (messages: ModelMessage[]) => GuardrailResult | Promise<GuardrailResult>;
  output?: (text: string) => GuardrailResult | Promise<GuardrailResult>;
}

/**
 * Async context for the active agent or workflow run.
 */
export const runContext = new Context<{ runId: string; stepIndex: number; signal?: AbortSignal }>('fino:ai/run');

/**
 * Mutable state passed through one agent run.
 */
export interface AgentState {
  messages: ModelMessage[];
  stepIndex: number;
  usage: Usage;
  cost?: number;
  history?: MessageHistory;
  signal?: AbortSignal;
}

/**
 * Result of one agent step.
 */
export interface StepResult {
  state: AgentState;
  done: boolean;
  suspend?: SuspendSignal;
  stopReason: StopReason;
}

/**
 * Predicate that decides whether an agent run should stop.
 */
export type StopCondition = (state: AgentState, info: { stopReason: StopReason }) => boolean;

/**
 * Stop after `n` model steps.
 */
export function maxSteps(n: number): StopCondition {
  return (state) => state.stepIndex >= n;
}

/**
 * Input accepted by `Agent.generate()` and `Agent.stream()`.
 */
export interface RunInput {
  messages: ModelMessage[];
  signal?: AbortSignal;
}

/**
 * Final result of an agent run.
 */
export interface AgentResult {
  text: string;
  object?: unknown;
  messages: ModelMessage[];
  steps: AgentState[];
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
}

/**
 * Retry policy for provider failures.
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (err: unknown) => boolean;
}

/**
 * Minimal sink a history strategy can use to emit durable memory.
 */
export interface StrategyMemorySink {
  ingest(docs: { text: string; metadata?: Record<string, unknown> }[]): Promise<void>;
}

/**
 * Internal options consumed by the runtime implementation.
 *
 * Application code should use `AgentOptions` from `fino:ai/agent`.
 */
export interface AgentRuntimeOptions {
  model: Model;
  name?: string;
  instructions?: string;
  tools?: Tool[];
  skills?: SkillRegistry;
  stopWhen?: StopCondition | StopCondition[];
  toolChoice?: 'auto' | 'any' | 'none' | { name: string };
  defaults?: { temperature?: number; maxTokens?: number; stopSequences?: string[] };
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
   * model declares `capabilities.responseFormat`.
   */
  structuredOutputMode?: 'tool' | 'native';
  captureContent?: boolean;
  retry?: RetryOptions;
  fallback?: Model[];
  guardrails?: Guardrails;
  history?: HistoryStrategy;
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
 */
export interface AgentStream {
  reader: Reader<StreamEvent>;
  result: Promise<AgentResult>;
}

/**
 * Iterate over only text deltas from an agent stream.
 */
export async function* streamText(stream: AgentStream): AsyncGenerator<string> {
  for await (const ev of stream.reader) {
    if (ev.type === 'text_delta') yield ev.text;
  }
}

function deriveProvider(modelName: string): string {
  const n = modelName.toLowerCase();
  if (n.startsWith('claude')) return 'anthropic';
  if (n.startsWith('gpt') || n.startsWith('o1') || n.startsWith('o3')) return 'openai';
  return 'unknown';
}

function providerName(model: Model): string {
  return model.provider ?? deriveProvider(model.name);
}

function modelId(model: Model): string {
  return model.id ?? model.name;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadInputTokens != null || b.cacheReadInputTokens != null
      ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) }
      : {}),
    ...(a.cacheCreationInputTokens != null || b.cacheCreationInputTokens != null
      ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) }
      : {}),
  };
}

function subUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    ...(a.cacheReadInputTokens != null || b.cacheReadInputTokens != null
      ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) - (b.cacheReadInputTokens ?? 0) }
      : {}),
    ...(a.cacheCreationInputTokens != null || b.cacheCreationInputTokens != null
      ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) - (b.cacheCreationInputTokens ?? 0) }
      : {}),
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
  return { model, budgetTokens, signal };
}

/**
 * Internal implementation behind `Agent`.
 *
 * This class is not part of the public `fino:ai/runtime` surface.
 */
export class AgentRuntime {
  #model: Model;
  #agentName?: string;
  #instructions?: string;
  #captureContent: boolean;
  #tools: Map<string, Tool>;
  #baseToolDefs: ToolDefinition[];
  #stopWhen: StopCondition[];
  #toolChoice?: 'auto' | 'any' | 'none' | { name: string };
  #defaults: { temperature?: number; maxTokens?: number; stopSequences?: string[] };
  #output?: Record<string, unknown>;
  #structuredOutputMode: 'tool' | 'native';
  #skills?: SkillRegistry;
  #skillLoadCache: Map<string, { instructions: string; tools: Record<string, Tool> }> = new Map();
  #retry?: RetryOptions;
  #fallback: Model[];
  #guardrails?: Guardrails;
  #historyStrategy: HistoryStrategy;
  #budgetTokens: number;

  constructor(opts: AgentRuntimeOptions) {
    this.#model = opts.model;
    this.#agentName = opts.name;
    this.#captureContent = opts.captureContent ?? false;
    this.#skills = opts.skills;
    this.#retry = opts.retry;
    this.#fallback = opts.fallback ?? [];
    this.#guardrails = opts.guardrails;
    this.#historyStrategy = opts.history ?? appendOnlyHistoryStrategy();
    this.#budgetTokens = opts.budgetTokens ?? 200_000;

    let baseInstructions = opts.instructions;
    const baseTools = [...(opts.tools ?? [])];

    if (opts.skills) {
      const manifest = opts.skills.manifest();
      if (manifest.length > 0) {
        const manifestBlock =
          '\n\n## Available skills\n' +
          manifest.map((s) => `- **${s.name}**: ${s.description}`).join('\n') +
          '\n\nCall the `load_skill` tool to load a skill\'s instructions and tools before using its capabilities.';
        baseInstructions = (baseInstructions ?? '') + manifestBlock;
      }
      baseTools.push(opts.skills.asLoaderTool());
    }

    this.#instructions = baseInstructions;
    this.#tools = new Map(baseTools.map((t) => [t.name, t]));
    this.#baseToolDefs = baseTools.map(toToolDefinition);
    this.#stopWhen = opts.stopWhen
      ? Array.isArray(opts.stopWhen)
        ? opts.stopWhen
        : [opts.stopWhen]
      : [maxSteps(8)];
    this.#toolChoice = opts.toolChoice;
    this.#defaults = opts.defaults ?? {};
    this.#output = opts.output ? normalizeSchema(opts.output) : undefined;
    this.#structuredOutputMode = opts.structuredOutputMode ?? 'tool';
  }

  async #streamWithRetryAndFallback(
    req: GenerateRequest,
    onEvent: ((ev: StreamEvent) => void) | undefined,
  ): Promise<{ events: StreamEvent[]; activeModel: Model }> {
    const maxRetries = this.#retry?.maxRetries ?? 0;
    const baseDelayMs = this.#retry?.baseDelayMs ?? 500;
    const maxDelayMs = this.#retry?.maxDelayMs ?? 30_000;
    const retryOn = this.#retry?.retryOn;
    const models = [this.#model, ...this.#fallback];
    let lastErr: unknown;

    for (const activeModel of models) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          if (req.signal?.aborted) throw req.signal.reason;
          const retryAfterMs = (lastErr instanceof ModelError && lastErr.retryAfterMs != null)
            ? lastErr.retryAfterMs
            : Math.floor(Math.random() * Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1))));
          await sleep(retryAfterMs);
        }

        const events: StreamEvent[] = [];
        let midStream = false;
        try {
          for await (const ev of activeModel.stream(req)) {
            midStream = true;
            events.push(ev);
            onEvent?.(ev);
          }
        } catch (err) {
          if (midStream) throw err;
          lastErr = err;
          const retryable = retryOn ? retryOn(err) : defaultRetryable(err);
          if (retryable && attempt < maxRetries) continue;
          break;
        }

        const stop = events.find((e): e is Extract<StreamEvent, { type: 'stop' }> => e.type === 'stop');
        if (stop && (stop.reason === 'refusal' || stop.reason === 'content_filter')) {
          lastErr = new ModelError(`Model refused: ${stop.reason}`, { status: 0 });
          break;
        }

        return { events, activeModel };
      }
    }

    throw lastErr ?? new Error('All models exhausted');
  }

  async #buildSkillAugmentation(
    messages: ModelMessage[],
    toolsMap: Map<string, Tool>,
    toolDefs: ToolDefinition[],
  ): Promise<{ toolsMap: Map<string, Tool>; toolDefs: ToolDefinition[]; extraInstructions: string }> {
    const loadedNames = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      const loadCalls = content.filter(
        (p) => p['type'] === 'tool_use' && p['name'] === 'load_skill',
      );
      if (!loadCalls.length) continue;
      const next = messages[i + 1];
      if (!next || next.role !== 'user') continue;
      const nextContent = Array.isArray(next.content) ? next.content as Array<Record<string, unknown>> : [];
      for (const call of loadCalls) {
        const result = nextContent.find(
          (p) => p['type'] === 'tool_result' && p['toolCallId'] === call['id'],
        );
        if (result && !result['isError']) {
          const args = call['args'] as Record<string, unknown> | undefined;
          if (typeof args?.['name'] === 'string') {
            loadedNames.add(args['name']);
          }
        }
      }
    }

    if (loadedNames.size === 0) {
      return { toolsMap, toolDefs, extraInstructions: '' };
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

    return { toolsMap: augToolsMap, toolDefs: augToolDefs, extraInstructions };
  }

  async #step(
    state: AgentState,
    toolsMap: Map<string, Tool>,
    toolDefs: ToolDefinition[],
    toolChoice: 'auto' | 'any' | 'none' | { name: string } | undefined,
    onEvent: ((ev: StreamEvent) => void) | undefined,
    runId: string,
    responseFormat?: ResponseFormat,
  ): Promise<StepResult & { turn: { text: string; toolUseParts: ToolUsePart[] }; activeModel: Model; appendedMessages: ModelMessage[] }> {
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
      'gen_ai.request.stream': true,
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
          ...(system ? { system } : {}),
          ...(activeToolDefs.length > 0 ? { tools: activeToolDefs } : {}),
          ...(toolChoice !== undefined ? { toolChoice } : {}),
          ...this.#defaults,
          ...(responseFormat ? { responseFormat } : {}),
          ...(state.signal ? { signal: state.signal } : {}),
        };

        const t0 = Date.now();
        const { events: buf, activeModel } = await this.#streamWithRetryAndFallback(req, onEvent);
        const rawTurn = await assembleResult(asyncOf(buf));
        const elapsed = (Date.now() - t0) / 1000;

        let turnText = rawTurn.text;
        if (this.#guardrails?.output && turnText) {
          const gr = await this.#guardrails.output(turnText);
          if (gr.action === 'block') throw new GuardrailError(gr.reason ?? 'Output blocked by guardrail', gr.reason);
          if (gr.action === 'redact') turnText = gr.text ?? turnText;
        }

        const turn = { ...rawTurn, text: turnText };

        const activeProvider = providerName(activeModel);
        const activeModelId = modelId(activeModel);
        if (activeModel !== this.#model) {
          stepSpan.setAttribute('gen_ai.request.model', activeModelId);
          stepSpan.setAttribute('gen_ai.provider.name', activeProvider);
        }
        const chatAttrs = {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': activeProvider,
          'gen_ai.request.model': activeModelId,
        };
        const meter = getMeterProvider().getMeter('fino.ai');
        meter.createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'GenAI operation duration' })
          .record(elapsed, chatAttrs);
        meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}', description: 'Measures number of input and output tokens used' })
          .record(turn.usage.inputTokens, { ...chatAttrs, 'gen_ai.token.type': 'input' });
        meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}', description: 'Measures number of input and output tokens used' })
          .record(turn.usage.outputTokens, { ...chatAttrs, 'gen_ai.token.type': 'output' });

        const logAttrs: Record<string, unknown> = {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': activeProvider,
          'gen_ai.request.model': activeModelId,
          'gen_ai.response.finish_reasons': [turn.stopReason],
        };
        if (this.#captureContent) {
          logAttrs['gen_ai.input.messages'] = req.messages;
          if (system) logAttrs['gen_ai.system_instructions'] = system;
        }
        getLoggerProvider().getLogger('fino.ai').emitRecord(
          new LogRecordBuilder()
            .setEventName('gen_ai.client.inference.operation.details')
            .setSeverity('INFO', SeverityNumber.INFO)
            .setAttributes(logAttrs),
        );

        const toolUseParts: ToolUsePart[] = turn.toolCalls.map((tc) => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          args: tc.args,
        }));

        const assistantContent: ContentPart[] = [];
        if (turn.text) assistantContent.push({ type: 'text', text: turn.text });
        assistantContent.push(...toolUseParts);

        const newMessages: ModelMessage[] = [
          ...effectiveMessages,
          { role: 'assistant', content: assistantContent.length === 1 && turnText && !toolUseParts.length
              ? turnText
              : assistantContent },
        ];

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

        if (stopReason !== 'tool_use') {
          const nextState: AgentState = { messages: newMessages, stepIndex, usage: newUsage, signal: state.signal };
          stepSpan.end({ status: { code: 'OK' } });
          return { state: nextState, done: true, stopReason, turn: { text: turn.text, toolUseParts: [] }, activeModel, appendedMessages: [newMessages[newMessages.length - 1]!] };
        }

        const { toolResults, suspend } = await this.#runTools(toolUseParts, newMessages, state, runId, activeToolsMap);

        const toolResultParts: ContentPart[] = toolResults.map(({ part, result }) => ({
          type: 'tool_result',
          toolCallId: part.id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        }));

        const messagesWithResults: ModelMessage[] = [
          ...newMessages,
          ...(toolResultParts.length > 0 ? [{ role: 'user' as const, content: toolResultParts }] : []),
        ];

        const nextState: AgentState = {
          messages: messagesWithResults,
          stepIndex,
          usage: newUsage,
          signal: state.signal,
        };

        stepSpan.end({ status: { code: 'OK' } });

        if (suspend) {
          return { state: nextState, done: false, suspend, stopReason, turn: { text: turn.text, toolUseParts }, activeModel, appendedMessages: messagesWithResults.slice(newMessages.length - 1) };
        }

        return { state: nextState, done: false, stopReason, turn: { text: turn.text, toolUseParts }, activeModel, appendedMessages: messagesWithResults.slice(newMessages.length - 1) };
      });
    } catch (err) {
      stepSpan.recordException?.(err);
      stepSpan.setAttribute('error.type', (err as Error)?.name ?? 'Error');
      stepSpan.end({ status: { code: 'ERROR', message: String(err) } });
      throw err;
    }
  }

  async #runTools(
    toolUseParts: ToolUsePart[],
    newMessages: ModelMessage[],
    state: AgentState,
    runId: string,
    toolsMap: Map<string, Tool>,
  ): Promise<{ toolResults: Array<{ part: ToolUsePart; result: { content: string | ContentPart[]; isError?: boolean } }>; suspend?: SuspendSignal }> {
    const tracer = getTracerProvider().getTracer('fino.ai');
    const sig = state.signal ?? new AbortController().signal;

    const settled = await Promise.allSettled(
      toolUseParts.map(async (part) => {
        const toolSpan = tracer.startSpan(`execute_tool ${part.name}`, {
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': part.name,
            'gen_ai.tool.call.id': part.id,
            'gen_ai.tool.type': 'function',
          },
        });
        const t = toolsMap.get(part.name);
        if (!t) {
          toolSpan.setAttribute('error.type', 'UnknownToolError');
          toolSpan.end({ status: { code: 'ERROR' } });
          return { part, result: { content: `Unknown tool: ${part.name}`, isError: true as const } };
        }

        const ctx: ToolRunContext = {
          signal: sig,
          toolCallId: part.id,
          step: state.stepIndex,
          runId,
          messages: newMessages,
          history: state.history,
          suspend: (sOpts?) => { throw new SuspendSignal(sOpts?.reason, sOpts?.payload); },
        };

        const toolT0 = Date.now();
        try {
          const result = await runWithActiveSpan(toolSpan, () => t.invoke(part.args, ctx));
          const toolElapsed = (Date.now() - toolT0) / 1000;
          getMeterProvider().getMeter('fino.ai')
            .createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'GenAI operation duration' })
            .record(toolElapsed, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': part.name });
          if (result.isError) {
            toolSpan.recordException?.(new Error(typeof result.content === 'string' ? result.content : 'tool error'));
            toolSpan.setAttribute('error.type', 'ToolError');
            toolSpan.end({ status: { code: 'ERROR' } });
          } else {
            toolSpan.end({ status: { code: 'OK' } });
          }
          return { part, result };
        } catch (err) {
          const toolElapsed = (Date.now() - toolT0) / 1000;
          getMeterProvider().getMeter('fino.ai')
            .createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'GenAI operation duration' })
            .record(toolElapsed, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': part.name, 'error.type': (err as Error)?.name ?? 'Error' });
          toolSpan.recordException?.(err);
          toolSpan.setAttribute('error.type', (err as Error)?.name ?? 'Error');
          toolSpan.end({ status: { code: 'ERROR', message: String(err) } });
          throw err;
        }
      }),
    );

    let suspend: SuspendSignal | undefined;
    const toolResults: Array<{ part: ToolUsePart; result: { content: string | ContentPart[]; isError?: boolean } }> = [];

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

    return { toolResults, suspend };
  }

  async #foldStep(
    raw: { state: AgentState; activeModel: Model; appendedMessages?: ModelMessage[] },
    prevState: AgentState,
    history: MessageHistory,
    runningCost: number,
  ): Promise<{ state: AgentState; history: MessageHistory; cost: number }> {
    const delta = subUsage(raw.state.usage, prevState.usage);
    const newCost = runningCost + costOf(delta, raw.activeModel.name, PRICING);
    const newMessages = raw.appendedMessages ?? raw.state.messages.slice(prevState.messages.length);

    for (const msg of newMessages) {
      await this.#historyStrategy.onAppend(msg, {
        model: raw.activeModel,
        budgetTokens: this.#budgetTokens,
        signal: raw.state.signal,
        stepIndex: raw.state.stepIndex,
      });
    }
    const nextHistory = this.#historyStrategy.history;
    return {
      state: { ...raw.state, messages: nextHistory.render(), cost: newCost, history: nextHistory },
      history: nextHistory,
      cost: newCost,
    };
  }

  async #runLoop(
    initialState: AgentState,
    onEvent: ((ev: StreamEvent) => void) | undefined,
    toolsMap: Map<string, Tool>,
    toolDefs: ToolDefinition[],
    toolChoice: 'auto' | 'any' | 'none' | { name: string } | undefined,
    responseFormat?: ResponseFormat,
    outputSchema?: Record<string, unknown>,
  ): Promise<AgentResult> {
    const runId = newRunId();
    const provider = providerName(this.#model);
    const requestModel = modelId(this.#model);
    const tracer = getTracerProvider().getTracer('fino.ai');
    const runAttrs: Record<string, unknown> = {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': requestModel,
      'gen_ai.conversation.id': runId,
    };
    if (this.#agentName) runAttrs['gen_ai.agent.name'] = this.#agentName;
    const runSpan = tracer.startSpan('invoke_agent', { attributes: runAttrs });

    const runT0 = Date.now();

    let activeToolsMap = toolsMap;
    let activeToolDefs = toolDefs;
    let activeToolChoice = toolChoice;
    const capture = outputSchema !== undefined ? { captured: false, args: undefined as unknown, retried: false } : null;

    if (capture) {
      const respondTool = new Tool({
        name: 'respond',
        description: 'Provide the final structured response.',
        parameters: outputSchema,
        execute: (args) => {
          capture.captured = true;
          capture.args = args;
          return 'OK';
        },
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
        stepIndex: initialState.stepIndex,
      });
    }
    history = this.#historyStrategy.history;
    let runningCost = initialState.cost ?? 0;

    try {
      return await runWithActiveSpan(runSpan, async () => {
        const runState = { runId, stepIndex: 0, signal: initialState.signal };
        return runContext.runWithValue(runState, async () => {
          let state = { ...initialState, history };
          const steps: AgentState[] = [];
          let finalText = '';
          let finalStopReason: StopReason = 'end_turn';

          while (true) {
            runState.stepIndex = state.stepIndex;
            const prevState = state;
            const r = await this.#step(state, activeToolsMap, activeToolDefs, activeToolChoice, onEvent, runId, responseFormat);
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

          const runElapsed = (Date.now() - runT0) / 1000;
          getMeterProvider().getMeter('fino.ai')
            .createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'GenAI operation duration' })
            .record(runElapsed, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': provider, 'gen_ai.request.model': requestModel });

          runSpan.setAttribute('gen_ai.response.finish_reasons', [finalStopReason]);
          runSpan.setAttribute('gen_ai.usage.input_tokens', state.usage.inputTokens);
          runSpan.setAttribute('gen_ai.usage.output_tokens', state.usage.outputTokens);
          runSpan.end({ status: { code: 'OK' } });

          const result: AgentResult = {
            text: finalText,
            messages: state.messages,
            steps,
            usage: state.usage,
            cost: runningCost,
            stopReason: finalStopReason,
          };
          if (capture) result.object = capture.args;
          return result;
        });
      });
    } catch (err) {
      const runElapsed = (Date.now() - runT0) / 1000;
      getMeterProvider().getMeter('fino.ai')
        .createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'GenAI operation duration' })
        .record(runElapsed, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': provider, 'gen_ai.request.model': requestModel, 'error.type': (err as Error)?.name ?? 'Error' });
      runSpan.recordException?.(err);
      runSpan.setAttribute('error.type', (err as Error)?.name ?? 'Error');
      runSpan.end({ status: { code: 'ERROR', message: String(err) } });
      throw err;
    }
  }

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
            runId,
          });
        }
      } else if (this.#historyStrategy.history.size === 0) {
        for (const msg of state.messages) {
          await this.#historyStrategy.onAppend(msg, {
            model: this.#model,
            budgetTokens: this.#budgetTokens,
            signal: state.signal,
            stepIndex: state.stepIndex,
            runId,
          });
        }
      }
      const raw = await this.#step(state, this.#tools, this.#baseToolDefs, this.#toolChoice, undefined, runId);
      const { state: foldedState } = await this.#foldStep(raw, state, this.#historyStrategy.history, state.cost ?? 0);
      return { state: foldedState, done: raw.done, suspend: raw.suspend, stopReason: raw.stopReason };
    };

    if (existing) return doStep();
    const runState = { runId, stepIndex: state.stepIndex, signal: state.signal };
    return runContext.runWithValue(runState, doStep);
  }

  #runWithOutput(
    state: AgentState,
    onEvent: ((ev: StreamEvent) => void) | undefined,
  ): Promise<AgentResult> {
    if (!this.#output) {
      return this.#runLoop(state, onEvent, this.#tools, this.#baseToolDefs, this.#toolChoice);
    }
    const supportsNative = this.#model.capabilities?.responseFormat === true;
    if (this.#structuredOutputMode === 'native' && supportsNative) {
      const responseFormat: ResponseFormat = { type: 'json_schema', name: 'response', schema: this.#output };
      return this.#runLoop(state, onEvent, new Map(), [], 'none', responseFormat).then((r) => {
        try { return { ...r, object: JSON.parse(r.text) }; }
        catch { throw new Error('Model returned invalid JSON for native structured output'); }
      });
    }
    return this.#runLoop(state, onEvent, this.#tools, this.#baseToolDefs, this.#toolChoice, undefined, this.#output);
  }

  generate(input: RunInput): Promise<AgentResult> {
    return this.#runWithOutput({
      messages: input.messages,
      stepIndex: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      signal: input.signal,
    }, undefined);
  }

  stream(input: RunInput): AgentStream {
    const ch = new Channel<StreamEvent>();
    const w = ch.writer;
    const onEvent = (ev: StreamEvent) => void w.write(ev);

    const result = this.#runWithOutput({
      messages: input.messages,
      stepIndex: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      signal: input.signal,
    }, onEvent).then(
      (r) => { void w.close(); return r; },
      (err) => { w.fail(err); throw err; },
    );

    return { reader: ch.reader, result };
  }
}
