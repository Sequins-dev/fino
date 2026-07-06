/**
* fino:ai/runtime — shared agent integration helpers and result types.
*
* This module exposes the small runtime surface that application adapters need
* without exposing the internal agent loop implementation. It carries the
* cross-cutting helpers — `runContext`, `maxSteps()`, `streamText()`, and the
* guardrail and suspension error types — together with the public state and
* result types shared by `fino:ai/agent` and `fino:ai/session`: run inputs and
* results, per-step state, streaming events, retry policy, and tool-approval
* requests. Import from here when writing integration code (UI adapters,
* observability hooks, session stores) that consumes agent runs but does not
* construct agents itself.
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
import { SuspendSignal } from 'fino:ai/tool';
import { GuardrailError as RuntimeGuardrailError, runContext as runtimeRunContext, maxSteps as runtimeMaxSteps, streamText as runtimeStreamText } from 'internal:ai/runtime';
import type { AgentStream, StopCondition } from './runtime-internal.ts';
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
export type { AgentEvent, AgentResult, AgentState, AgentStream, GuardrailResult, Guardrails, RetryOptions, RunInput, StepResult, StopCondition, StrategyMemorySink, ToolApprovalRequest } from './runtime-internal.ts';
/**
* Signals that execution should suspend instead of fail.
*
* Throw this from a tool executor — or call the executor context's
* `suspend()`, which throws it — to pause the run at the current step. The
* step completes with `StepResult.suspend` set and the run's `stopReason`
* reflects the interrupted tool turn (`tool_use`). A durable session persists
* a resume token so the run can continue later with external input. `payload`
* carries arbitrary data for whoever resumes the run, such as a question for
* a human operator.
*
* ```ts no_run
* import { tool } from 'fino:ai/tool';
* import { SuspendSignal } from 'fino:ai/runtime';
*
* const askHuman = tool({
*   name: 'ask_human',
*   description: 'Ask the operator a question.',
*   parameters: { type: 'object', properties: { question: { type: 'string' } } },
*   execute: ({ question }: { question: string }) => {
*     throw new SuspendSignal('needs human input', { question });
*   },
* });
* ```
*/
export { SuspendSignal };
