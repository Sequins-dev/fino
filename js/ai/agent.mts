/**
 * High-level agent API for running model loops with tools, skills, guardrails,
 * and strategy-owned history.
 *
 * Use `agent()` for the factory-first style or `new Agent()` when a class value
 * is more convenient. Both forms default to append-only in-memory history. Pass
 * a custom `HistoryStrategy` when the agent needs durable, summarized, selected,
 * or memory-emitting history.
 */

import { AgentRuntime, streamText } from 'internal:ai/runtime';
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

export { streamText };

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
