/**
 * fino:ai/runtime — shared agent integration helpers and result types.
 *
 * This module exposes the small runtime surface that application adapters need
 * without exposing the internal agent loop implementation. Use it for
 * cross-cutting helpers such as `runContext`, `maxSteps()`, `streamText()`,
 * guardrail error types, and the public state/result types shared by
 * `fino:ai/agent` and `fino:ai/session`.
 *
 * ## Boundary
 *
 * Application code should create agents through `fino:ai/agent`. The runtime
 * module is intentionally not a harness API and does not export the internal
 * runtime class. This keeps the public integration layer stable while allowing
 * the agent loop internals to evolve.
 *
 * `runContext` is an async context populated while an agent step or session is
 * driving work. Tools can read it for run metadata, but should use the explicit
 * `ToolRunContext` when possible.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { openai } from 'fino:ai/model';
 * import { maxSteps, streamText } from 'fino:ai/runtime';
 *
 * const bot = agent({
 *   model: openai({ model: 'gpt-4o' }),
 *   stopWhen: maxSteps(4),
 * });
 *
 * for await (const text of streamText(bot.stream('Draft a title.'))) {
 *   console.log(text);
 * }
 * ```
 */

import {
  GuardrailError as RuntimeGuardrailError,
  runContext as runtimeRunContext,
  maxSteps as runtimeMaxSteps,
  streamText as runtimeStreamText,
} from 'internal:ai/runtime';
import type {
  GuardrailResult as RuntimeGuardrailResult,
  Guardrails as RuntimeGuardrails,
  AgentState as RuntimeAgentState,
  StepResult as RuntimeStepResult,
  StopCondition as RuntimeStopCondition,
  RunInput as RuntimeRunInput,
  AgentResult as RuntimeAgentResult,
  RetryOptions as RuntimeRetryOptions,
  StrategyMemorySink as RuntimeStrategyMemorySink,
  AgentStream as RuntimeAgentStream,
} from 'internal:ai/runtime';
import { SuspendSignal } from 'fino:ai/tool';

/**
 * Error thrown when an input or output guardrail blocks execution.
 */
export const GuardrailError = RuntimeGuardrailError;

/**
 * Async context for the active agent or workflow run.
 */
export const runContext = runtimeRunContext;

/**
 * Stop after `n` model steps.
 */
export function maxSteps(n: number): StopCondition {
  return runtimeMaxSteps(n);
}

/**
 * Iterate over only text deltas from an agent stream.
 */
export function streamText(stream: AgentStream): AsyncGenerator<string> {
  return runtimeStreamText(stream);
}

/**
 * Result returned by an input or output guardrail.
 */
export type GuardrailResult = RuntimeGuardrailResult;

/**
 * Optional input and output guardrails for an agent.
 */
export type Guardrails = RuntimeGuardrails;

/**
 * Mutable state passed through one agent run.
 */
export type AgentState = RuntimeAgentState;

/**
 * Result of one agent step.
 */
export type StepResult = RuntimeStepResult;

/**
 * Predicate that decides whether an agent run should stop.
 */
export type StopCondition = RuntimeStopCondition;

/**
 * Input accepted by `Agent.generate()` and `Agent.stream()`.
 */
export type RunInput = RuntimeRunInput;

/**
 * Final result of an agent run.
 */
export type AgentResult = RuntimeAgentResult;

/**
 * Retry policy for provider failures.
 */
export type RetryOptions = RuntimeRetryOptions;

/**
 * Minimal sink a history strategy can use to emit durable memory.
 */
export type StrategyMemorySink = RuntimeStrategyMemorySink;

/**
 * Stream handle returned by `Agent.stream()`.
 */
export type AgentStream = RuntimeAgentStream;

/**
 * Signals that execution should suspend instead of fail.
 */
export { SuspendSignal };
