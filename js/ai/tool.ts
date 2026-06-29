/**
* fino:ai/tool — validated tool definitions for agent tool calling.
*
* A `Tool` wraps a model-visible name, description, `fino:validate` input
* schema, and executor. Agents convert the schema into provider-neutral JSON
* Schema tool definitions, validate model-supplied arguments with
* `fino:validate`, and return tool outputs as model-readable `tool_result`
* content.
*
* ## Execution model
*
* Tool executors receive `ToolRunContext`, including the abort signal, run id,
* step index, current messages, and optional `MessageHistory`. Validation
* failures and ordinary executor exceptions are converted into `isError` tool
* results by default so the model can repair its call. Set `throwOnError` when
* application code should fail the run instead.
*
* Throw `AbortError` to cancel, or throw/use `SuspendSignal` to pause a durable
* session or workflow for external input such as approval. Suspension is a
* control-flow signal, not a failed tool result.
*
* ```ts no_run
* import { tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const lookup = tool({
*   name: 'lookup_user',
*   description: 'Look up a user by id.',
*   parameters: v.object({ id: v.string().describe('User id') }),
*   execute: async ({ id }: { id: string }, ctx) => {
*     if (id === 'needs-approval') ctx.suspend({ reason: 'approval required', payload: { id } });
*     return { content: `user:${id}` };
*   },
* });
* ```
*/
import type { ContentPart, ModelMessage, ToolDefinition } from 'fino:ai/model';
import type { MessageHistory } from 'fino:ai/context';
import { Task } from 'fino:task';
import { normalizeSchema } from 'internal:ai/shared';
import type { SchemaLike } from 'internal:ai/shared';
/**
* Signals that execution should suspend instead of fail.
*/
export class SuspendSignal extends Error {
  payload?: unknown;
  constructor(message?: string, payload?: unknown) {
    super(message ?? 'Suspended');
    this.name = 'SuspendSignal';
    this.payload = payload;
  }
}
/**
* Runtime context passed to a tool executor.
*/
export interface ToolRunContext {
  signal: AbortSignal;
  toolCallId: string;
  step: number;
  runId: string;
  messages: ModelMessage[];
  history?: MessageHistory;
  suspend(opts?: {
    reason?: string;
    payload?: unknown;
  }): never;
}
/**
* Value returned by a tool executor.
*/
export type ToolResult = string | {
  content: ContentPart | ContentPart[] | string;
  isError?: boolean;
};
/**
* Definition used to create a `Tool`.
*
* `parameters` accepts a `fino:validate` schema builder such as
* `v.object({ id: v.string() })`, or a raw JSON Schema object when adapting an
* external protocol. Builders are normalized to plain JSON Schema before being
* sent to providers.
*/
export interface ToolOptions<
  Args,
  R extends ToolResult = ToolResult
> {
  name: string;
  description: string;
  /**
  * Input schema for model-supplied tool arguments.
  *
  * Prefer `fino:validate` builders such as
  * `v.object({ id: v.string() })`. Raw JSON Schema objects are accepted for
  * protocol adapters and are normalized before being sent to providers.
  */
  parameters: SchemaLike<Args>;
  execute: (args: Args, ctx: ToolRunContext) => R | Promise<R>;
  /**
  * Human-readable risk category for approval UIs and audit logs.
  */
  risk?: string;
  /**
  * Whether the tool has external side effects.
  */
  sideEffects?: boolean;
  /**
  * Require an agent/session to suspend for application approval before this
  * tool executes.
  */
  requiresApproval?: boolean;
  /**
  * Maximum intended execution duration in milliseconds.
  *
  * When set, `execute` receives a child abort signal and the invocation returns
  * an error tool result if the timeout elapses before the executor settles.
  */
  timeoutMs?: number;
  throwOnError?: boolean;
}
/**
* Executable tool exposed to a model.
*/
export class Tool<
  Args = unknown,
  R extends ToolResult = ToolResult
> extends Task<Args, R> {
  constructor(opts: ToolOptions<Args, R>) {
    const parameters = normalizeSchema(opts.parameters);
    super({
      name: opts.name,
      description: opts.description,
      inputSchema: parameters as SchemaLike<Args>,
      outputMode: 'text',
      risk: opts.risk,
      sideEffects: opts.sideEffects,
      requiresApproval: opts.requiresApproval,
      timeoutMs: opts.timeoutMs,
      throwOnError: opts.throwOnError,
      run: (args, ctx) => opts.execute(args, {
        signal: ctx.signal,
        toolCallId: ctx.toolCallId ?? 'task',
        step: ctx.step ?? 0,
        runId: ctx.runId ?? 'task',
        messages: ctx.messages ?? [],
        history: ctx.history,
        suspend(suspendOpts = {}): never {
          if (ctx.suspend) return ctx.suspend(suspendOpts);
          throw new SuspendSignal(suspendOpts.reason, suspendOpts.payload);
        }
      })
    });
  }
}
/**
* Create a tool from a schema and executor.
*/
export function tool<
  Args = unknown,
  R extends ToolResult = ToolResult
>(opts: ToolOptions<Args, R>): Tool<Args, R> {
  return new Tool(opts);
}
/**
* Convert a `Tool` into the provider-neutral model tool definition shape.
*/
export function toToolDefinition(t: Tool): ToolDefinition {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  };
}
