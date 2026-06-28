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
 * checkpointed orchestration belongs in `fino:ai/workflow`.
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
import type { AgentRuntimeOptions, AgentState, StepResult, RunInput, AgentResult, AgentStream } from 'internal:ai/runtime';
import { appendOnlyHistoryStrategy } from 'fino:ai/context';
import type { HistoryStrategy } from 'fino:ai/context';
import { tool } from 'fino:ai/tool';
import type { SchemaBuilder } from 'fino:validate';

function normalizeInput(input: string | RunInput): RunInput {
  if (typeof input === 'string') {
    return { messages: [{ role: 'user', content: input }] };
  }
  return input;
}

export type { AgentState as AgentState, StepResult, RunInput, AgentResult, AgentStream };

/**
 * Iterate over only text deltas from an agent stream.
 */
export function streamText(stream: AgentStream): AsyncGenerator<string> {
  return runtimeStreamText(stream);
}

/**
 * Options for `Agent` and `agent()`.
 *
 * `history` defaults to an append-only in-memory strategy. Supplying a strategy
 * gives that strategy complete ownership of append and read-time curation.
 */
export type AgentOptions = Omit<AgentRuntimeOptions, 'history'> & { history?: HistoryStrategy };

/**
 * Runs an agent loop against a model.
 */
export class Agent {
  #runtime: AgentRuntime;
  name?: string;

  constructor(opts: AgentOptions) {
    this.name = opts.name;
    this.#runtime = new AgentRuntime({
      history: appendOnlyHistoryStrategy(),
      ...opts,
    });
  }

  /**
   * Run one model/tool step from an existing state.
   */
  step(state: AgentState): Promise<StepResult> {
    return this.#runtime.step(state);
  }

  /**
   * Run until the agent reaches a stop condition, suspension, or error.
   */
  generate(input: string | RunInput): Promise<AgentResult> {
    return this.#runtime.generate(normalizeInput(input));
  }

  /**
   * Start a streamed run.
   */
  stream(input: string | RunInput): AgentStream {
    return this.#runtime.stream(normalizeInput(input));
  }

  /**
   * Expose this agent as a tool for composition with another agent.
   */
  asTool(opts: { name?: string; description: string; input?: SchemaBuilder | Record<string, unknown> }): ReturnType<typeof tool> {
    const toolName = opts.name ?? this.name ?? 'agent';
    const parameters = opts.input && typeof opts.input === 'object' && 'schema' in opts.input
      ? (opts.input as SchemaBuilder).schema
      : (opts.input as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} };

    return tool({
      name: toolName,
      description: opts.description,
      parameters,
      execute: async (args, ctx) => {
        const input = typeof args === 'object' && args !== null && Object.keys(args as object).length > 0
          ? JSON.stringify(args)
          : 'Please respond.';
        const result = await this.generate({ messages: [{ role: 'user', content: input }], signal: ctx.signal });
        return result.text;
      },
    });
  }
}

/**
 * Create an `Agent`.
 */
export function agent(opts: AgentOptions): Agent {
  return new Agent(opts);
}
