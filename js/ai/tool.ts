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
*
* Throwing a `SuspendSignal` (directly or via `ToolRunContext.suspend()`)
* tells the surrounding agent, session, or workflow harness to pause the run
* and wait for external input — an approval decision, a human answer, a
* webhook — rather than treat the tool call as an error. `Tool.invoke()`
* recognizes it by `name` and always rethrows it, bypassing both the default
* `isError` conversion and `throwOnError`.
*
* The message defaults to `'Suspended'`. Attach a `payload` with whatever the
* resuming side needs to present or resolve the suspension.
*
* ```ts no_run
* import { SuspendSignal } from 'fino:ai/tool';
*
* throw new SuspendSignal('needs approval', { action: 'delete', target: 'prod-db' });
* ```
*/
export class SuspendSignal extends Error {
  /**
  * Application data carried to whatever resumes or renders the suspension,
  * such as the pending action shown in an approval UI.
  */
  payload?: unknown;
  /**
  * Create a suspension signal with an optional human-readable reason and an
  * optional payload for the resuming side. The message defaults to
  * `'Suspended'`.
  */
  constructor(message?: string, payload?: unknown) {
    super(message ?? 'Suspended');
    this.name = 'SuspendSignal';
    this.payload = payload;
  }
}
/**
* Runtime context passed to a tool executor.
*
* Agents populate every field when they invoke a tool during a run. When the
* same tool is executed outside an agent loop (for example directly through
* `Task.run()`), the identifiers fall back to `'task'`/`0` and `messages` is
* empty, so executors can rely on the fields always being present.
*
* ```ts no_run
* import { tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const fetchPage = tool({
*   name: 'fetch_page',
*   description: 'Fetch a URL as text.',
*   parameters: v.object({ url: v.string() }),
*   execute: async ({ url }: { url: string }, ctx) => {
*     const res = await fetch(url, { signal: ctx.signal });
*     return { content: await res.text() };
*   },
* });
* ```
*/
export interface ToolRunContext {
  /**
  * Aborts when the run is cancelled or, when `timeoutMs` is set, when the
  * tool's own deadline elapses. Pass it to any cancellable I/O the executor
  * performs.
  */
  signal: AbortSignal;
  /**
  * Identifier of the model's tool-call block that triggered this execution,
  * matching the id echoed back in the `tool_result` message.
  */
  toolCallId: string;
  /**
  * Zero-based index of the agent step (model turn) this call belongs to.
  */
  step: number;
  /**
  * Identifier of the enclosing agent run, stable across all steps and tool
  * calls within it.
  */
  runId: string;
  /**
  * Snapshot of the conversation messages at the time of the call, for tools
  * that need to inspect prior context.
  */
  messages: ModelMessage[];
  /**
  * Durable conversation history from `fino:ai/context` when the run is backed
  * by one; absent for ad-hoc runs.
  */
  history?: MessageHistory;
  /**
  * Pause the run for external input instead of returning a result.
  *
  * Inside a durable session or workflow this delegates to the harness's own
  * suspend mechanism; otherwise it throws a `SuspendSignal` carrying the
  * given reason and payload. Either way it never returns.
  */
  suspend(opts?: {
    reason?: string;
    payload?: unknown;
  }): never;
}
/**
* Value returned by a tool executor.
*
* A plain string is shorthand for a successful text result. The object form
* carries structured `ContentPart`s (text, images, and so on) and may set
* `isError: true` to report a domain failure to the model as a failed
* `tool_result` without throwing — useful when the model should see the
* failure and retry with different arguments.
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
*
* ```ts no_run
* import { tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const remove = tool({
*   name: 'remove_file',
*   description: 'Delete a file from the workspace.',
*   parameters: v.object({ path: v.string().describe('Workspace-relative path') }),
*   risk: 'destructive',
*   sideEffects: true,
*   requiresApproval: true,
*   timeoutMs: 10_000,
*   execute: async ({ path }: { path: string }) => `deleted ${path}`,
* });
* ```
*/
export interface ToolOptions<
  Args,
  R extends ToolResult = ToolResult
> {
  /**
  * Model-visible tool name, sent to the provider in the tool definition and
  * matched against the model's tool-call blocks.
  */
  name: string;
  /**
  * Model-visible description telling the model what the tool does and when
  * to call it. Quality here directly affects tool-selection accuracy.
  */
  description: string;
  /**
  * Input schema for model-supplied tool arguments.
  *
  * Prefer `fino:validate` builders such as
  * `v.object({ id: v.string() })`. Raw JSON Schema objects are accepted for
  * protocol adapters and are normalized before being sent to providers.
  */
  parameters: SchemaLike<Args>;
  /**
  * Executor called with validated, typed arguments and the run context.
  *
  * Return a `ToolResult` (or a promise of one). Exceptions become `isError`
  * tool results unless `throwOnError` is set; `AbortError` and
  * `SuspendSignal` always propagate.
  */
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
  /**
  * Rethrow validation failures and executor exceptions to the caller instead
  * of converting them into `isError` tool results.
  *
  * Defaults to `false`, which lets the model see failures and repair its
  * call. Enable it when a tool failure should abort the application-level
  * run. `AbortError` and `SuspendSignal` propagate regardless.
  */
  throwOnError?: boolean;
}
/**
* Executable tool exposed to a model.
*
* A `Tool` is a `fino:task` `Task` specialized for model tool calling: the
* input schema is normalized to JSON Schema at construction, output mode is
* fixed to text, and the executor receives a fully-populated
* `ToolRunContext`. Everything from `Task` is inherited — agents call
* `invoke()` to get the `tool_result` contract (validated arguments, errors
* folded into `isError` results), while `toToolDefinition()`, `run()`, and
* the CLI surface remain available. This means one `Tool` can be handed to an
* agent, mounted in an MCP server, or run directly by application code.
*
* Arguments are validated against `parameters` before the executor runs; a
* validation failure produces an `isError` result whose message summarizes
* the failing paths so the model can correct itself.
*
* ```ts no_run
* import { Tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const weather = new Tool({
*   name: 'get_weather',
*   description: 'Get current weather for a city.',
*   parameters: v.object({ city: v.string() }),
*   execute: async ({ city }: { city: string }) => `Sunny in ${city}`,
* });
*
* // Direct execution, outside an agent loop:
* const text = await weather.run({ city: 'Lisbon' });
*
* // Agent-style invocation with the tool_result contract (agents build the
* // context for you; shown here for a custom loop):
* const result = await weather.invoke({ city: 'Lisbon' }, {
*   signal: AbortSignal.timeout(5_000),
*   toolCallId: 'call_1',
*   step: 0,
*   runId: 'run_1',
*   messages: [],
*   suspend() { throw new Error('no suspension support'); },
* });
* // → { content: 'Sunny in Lisbon' }
* ```
*/
export class Tool<
  Args = unknown,
  R extends ToolResult = ToolResult
> extends Task<Args, R> {
  /**
  * Create a tool from `ToolOptions`, normalizing `parameters` to plain JSON
  * Schema and wiring the executor so it always receives a complete
  * `ToolRunContext` with a working `suspend()`.
  */
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
*
* Convenience factory for `new Tool(opts)`. Argument types are inferred from
* the `Args` type parameter (or annotated on `execute`), so the executor body
* is fully typed.
*
* ```ts no_run
* import { tool } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const add = tool({
*   name: 'add',
*   description: 'Add two numbers.',
*   parameters: v.object({ a: v.number(), b: v.number() }),
*   execute: ({ a, b }: { a: number; b: number }) => String(a + b),
* });
* ```
*/
export function tool<
  Args = unknown,
  R extends ToolResult = ToolResult
>(opts: ToolOptions<Args, R>): Tool<Args, R> {
  return new Tool(opts);
}
/**
* Convert a `Tool` into the provider-neutral model tool definition shape.
*
* Returns the `name`, `description`, and normalized JSON Schema `parameters`
* that `fino:ai/model` providers send to the model. Agents call this
* automatically for the tools they are given; use it directly when building a
* custom loop or wiring tools into an external protocol.
*
* ```ts no_run
* import { tool, toToolDefinition } from 'fino:ai/tool';
* import { v } from 'fino:validate';
*
* const search = tool({
*   name: 'search',
*   description: 'Search the web.',
*   parameters: v.object({ query: v.string() }),
*   execute: async ({ query }: { query: string }) => `results for ${query}`,
* });
*
* const def = toToolDefinition(search);
* // → { name: 'search', description: 'Search the web.', parameters: { type: 'object', ... } }
* ```
*/
export function toToolDefinition(t: Tool): ToolDefinition {
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  };
}
