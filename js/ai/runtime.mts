/**
 * Runtime helpers shared by agent, session, workflow, and adapter code.
 *
 * This module is intentionally small. Application code should use
 * `fino:ai/agent` to create and run agents. The runtime module only exposes
 * cross-cutting helpers and types that are useful when integrating agents with
 * sessions, workflows, guardrails, or custom transports.
 */

export {
  GuardrailError,
  runContext,
  maxSteps,
  streamText,
} from 'internal:ai/runtime';

export type {
  GuardrailResult,
  Guardrails,
  AgentState,
  StepResult,
  StopCondition,
  RunInput,
  AgentResult,
  RetryOptions,
  StrategyMemorySink,
  AgentStream,
} from 'internal:ai/runtime';

export { SuspendSignal } from 'fino:ai/tool';
