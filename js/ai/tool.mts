/**
 * Tool primitives for agent tool calling and composition.
 *
 * A `Tool` wraps a named JSON-schema input contract and an executor. Executors
 * receive run context, abort signals, and the current message history when
 * available. Throw `SuspendSignal` from a tool to pause a session or workflow
 * for external input.
 */

import type { ContentPart, ModelMessage, ToolDefinition } from 'fino:ai/model';
import type { MessageHistory } from 'fino:ai/context';
import { compile } from 'fino:validate';
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
  suspend(opts?: { reason?: string; payload?: unknown }): never;
}

/**
 * Value returned by a tool executor.
 */
export type ToolResult =
  | string
  | { content: ContentPart | ContentPart[] | string; isError?: boolean };

/**
 * Definition used to create a `Tool`.
 */
export interface ToolOptions<Args, R extends ToolResult = ToolResult> {
  name: string;
  description: string;
  parameters: SchemaLike<Args>;
  execute: (args: Args, ctx: ToolRunContext) => R | Promise<R>;
  throwOnError?: boolean;
}

/**
 * Executable tool exposed to a model.
 */
export class Tool<Args = unknown, R extends ToolResult = ToolResult> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  #execute: (args: Args, ctx: ToolRunContext) => R | Promise<R>;
  #throwOnError: boolean;
  #validator: ReturnType<typeof compile> | null = null;

  constructor(opts: ToolOptions<Args, R>) {
    this.name = opts.name;
    this.description = opts.description;
    this.parameters = normalizeSchema(opts.parameters);
    this.#execute = opts.execute;
    this.#throwOnError = opts.throwOnError ?? false;
  }

  #getValidator(): ReturnType<typeof compile> {
    if (!this.#validator) this.#validator = compile(this.parameters);
    return this.#validator;
  }

  async invoke(
    rawArgs: unknown,
    ctx: ToolRunContext,
  ): Promise<{ content: string | ContentPart[]; isError?: boolean }> {
    const parsed = this.#getValidator().safeParse(rawArgs);

    if (!parsed.success) {
      const summary = parsed.issues
        .map((issue: { path: string; message: string }) =>
          `${issue.path || '<root>'}: ${issue.message}`
        )
        .join('\n');
      return { content: summary, isError: true };
    }

    let output: R;
    try {
      output = await this.#execute(parsed.value as Args, ctx);
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'SuspendSignal')) throw err;
      if (this.#throwOnError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { content: message, isError: true };
    }

    if (typeof output === 'string') return { content: output };
    return output as { content: string | ContentPart[]; isError?: boolean };
  }
}

/**
 * Create a tool from a schema and executor.
 */
export function tool<Args = unknown, R extends ToolResult = ToolResult>(
  opts: ToolOptions<Args, R>,
): Tool<Args, R> {
  return new Tool(opts);
}

/**
 * Convert a `Tool` into the provider-neutral model tool definition shape.
 */
export function toToolDefinition(t: Tool): ToolDefinition {
  return { name: t.name, description: t.description, parameters: t.parameters };
}
