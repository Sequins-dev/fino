/**
* fino:task — shared executable tasks for CLIs, agents, MCP, and runtimes.
*
* A `Task` describes one named operation with input metadata, optional output
* metadata, effect metadata, child tasks, and one executor. The same value can
* be invoked directly by application code, parsed as a CLI command, exposed as
* an AI tool, mounted in an MCP server, or reused later by RPC and queue
* surfaces.
*
* ## Design
*
* Task output is explicit at execution time. `outputMode` declares what a task
* can produce: text, JSON, or both. The `writer` passed to a task is a
* discriminated union, so task code must check `writer.mode` before writing
* text or structured JSON. Fino does not try to convert a generic structured
* result into human text; each task owns the output behavior that fits its
* domain.
*
* CLI parsing is built on `fino:process/argv` for now. `Task.parse()` converts
* CLI options and positionals into a flat input object, walks child tasks, and
* honors a global `--json` token before running the selected task.
*
* ```ts no_run
* import { task } from 'fino:task';
*
* const greet = task({
*   name: 'greet',
*   outputMode: 'both',
*   cli: { positionals: [{ name: 'name', required: true }] },
*   run: async (input: { name: string }, ctx) => {
*     if (ctx.writer.mode === 'json') {
*       await ctx.writer.writeJson({ greeting: `hello ${input.name}` });
*     } else {
*       await ctx.writer.writeText(`hello ${input.name}\n`);
*     }
*     return { greeting: `hello ${input.name}` };
*   },
* });
*
* await greet.parse(['--json', 'Ada']);
* ```
*/
import { Command as ArgvCommand } from 'fino:process/argv';
import type { CommandConfig, CommandContext, OptionConfig, PositionalConfig, ParseOptions } from 'fino:process/argv';
import type { PromptSession } from 'fino:tty/prompt';
import type { ContentPart, ModelMessage, ToolDefinition } from 'fino:ai/model';
import type { MessageHistory } from 'fino:ai/context';
import { compile } from 'fino:validate';
import { normalizeSchema } from 'internal:ai/shared';
import type { SchemaLike } from 'internal:ai/shared';
/**
* Output formats a task can produce.
*/
export type TaskOutputMode = 'text' | 'json' | 'both';
/**
* Concrete output format requested for a single task execution.
*/
export type TaskRequestedOutputMode = 'text' | 'json';
/**
* JSON-compatible value accepted by JSON task writers.
*/
export type TaskJsonValue = null | boolean | number | string | TaskJsonValue[] | {
  [key: string]: TaskJsonValue;
};
/**
* Output writer passed into a task executor.
*
* The union is intentionally discriminated by `mode`: TypeScript callers must
* narrow before calling `writeText()` or `writeJson()`.
*/
export type TaskOutputWriter = {
  readonly mode: 'text';
  writeText(chunk: string): void | Promise<void>;
  writeJson?: never;
} | {
  readonly mode: 'json';
  writeJson(value: TaskJsonValue): void | Promise<void>;
  writeText?: never;
};
/**
* Side-effect metadata for policy, approval, and audit layers.
*/
export interface TaskEffect {
  kind: string;
  description?: string;
}
/**
* Context passed to a task executor.
*/
export interface TaskContext {
  readonly signal: AbortSignal;
  readonly runId?: string;
  readonly writer: TaskOutputWriter;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly prompt?: PromptSession;
  readonly providedOptions?: ReadonlySet<string>;
  optionProvided?(key: string): boolean;
  readonly toolCallId?: string;
  readonly step?: number;
  readonly messages?: ModelMessage[];
  readonly history?: MessageHistory;
  suspend?(opts?: {
    reason?: string;
    payload?: unknown;
  }): never;
}
/**
* Function that performs a task.
*/
export type TaskHandler<
  Input,
  Output = unknown
> = (input: Input, ctx: TaskContext) => Output | Promise<Output>;
/**
* CLI option metadata for a task.
*/
export interface TaskCliOption {
  name?: string;
  flags: string;
  description?: string;
  type?: 'string' | 'number' | 'boolean';
  multiple?: boolean;
  required?: boolean;
  default?: boolean | string | number | Array<string | number> | ((ctx: CommandContext) => unknown);
  choices?: Array<string | number>;
}
/**
* CLI positional metadata for a task.
*/
export interface TaskCliPositional {
  name: string;
  description?: string;
  type?: 'string' | 'number';
  required?: boolean;
  multiple?: boolean;
  variadic?: boolean;
  choices?: Array<string | number>;
}
/**
* CLI-facing task metadata.
*/
export interface TaskCliSpec {
  name?: string;
  usage?: string;
  options?: TaskCliOption[];
  positionals?: TaskCliPositional[];
  allowUnknown?: boolean;
}
/**
* Runtime context passed to AI-tool-compatible task invocation.
*/
export interface TaskRunContext {
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
* Result shape returned by AI-tool-compatible task invocation.
*/
export type TaskToolResult = string | {
  content: ContentPart | ContentPart[] | string;
  isError?: boolean;
};
/**
* Options used to create a task.
*/
export interface TaskOptions<
  Input = unknown,
  Output = unknown
> {
  name: string;
  description?: string;
  inputSchema?: SchemaLike<Input>;
  outputSchema?: unknown;
  outputMode?: TaskOutputMode;
  cli?: TaskCliSpec;
  children?: Task[];
  effects?: TaskEffect[];
  requiresApproval?: boolean;
  risk?: string;
  sideEffects?: boolean;
  timeoutMs?: number;
  throwOnError?: boolean;
  run: TaskHandler<Input, Output>;
}
/**
* Options for direct task execution.
*/
export interface TaskRunOptions {
  outputMode?: TaskRequestedOutputMode;
  writer?: TaskOutputWriter;
  signal?: AbortSignal;
  runId?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  prompt?: PromptSession;
  providedOptions?: ReadonlySet<string>;
}
/**
* Options for CLI-style task parsing.
*/
export interface TaskParseOptions extends ParseOptions {
  outputMode?: TaskRequestedOutputMode;
  writer?: TaskOutputWriter;
  signal?: AbortSignal;
  runId?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}
class TaskTimeoutError extends Error {
  constructor(taskName: string, timeoutMs: number) {
    super(`Task "${taskName}" timed out after ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
  }
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as {
    then?: unknown;
  }).then === 'function';
}
function defaultSignal(): AbortSignal {
  return new AbortController().signal;
}
function makeDefaultWriter(mode: TaskRequestedOutputMode): TaskOutputWriter {
  if (mode === 'json') return {
    mode: 'json',
    writeJson: () => undefined
  };
  return {
    mode: 'text',
    writeText: () => undefined
  };
}
function assertOutputMode(taskName: string, supported: TaskOutputMode, requested: TaskRequestedOutputMode): void {
  if (supported === 'both' || supported === requested) return;
  throw new Error(`Task "${taskName}" does not support ${requested} output`);
}
function normalizeRequestedOutputMode(mode: TaskOutputMode, requested?: TaskRequestedOutputMode): TaskRequestedOutputMode {
  if (requested !== undefined) return requested;
  return mode === 'json' ? 'json' : 'text';
}
function optionKey(flags: string): string {
  for (const part of flags.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('--')) return trimmed.slice(2);
  }
  for (const part of flags.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('-')) return trimmed.slice(1);
  }
  return flags;
}
function cloneCliOptions(options: TaskCliOption[] | undefined): OptionConfig[] {
  return (options ?? []).map((option) => ({
    flags: option.flags,
    ...option.description !== undefined ? { description: option.description } : {},
    ...option.type !== undefined ? { type: option.type } : {},
    ...option.multiple !== undefined ? { multiple: option.multiple } : {},
    ...option.required !== undefined ? { required: option.required } : {},
    ...option.default !== undefined ? { default: option.default } : {},
    ...option.choices !== undefined ? { choices: option.choices } : {}
  }));
}
function cloneCliPositionals(positionals: TaskCliPositional[] | undefined): PositionalConfig[] {
  return (positionals ?? []).map((positional) => ({
    name: positional.name,
    ...positional.description !== undefined ? { description: positional.description } : {},
    ...positional.type !== undefined ? { type: positional.type } : {},
    ...positional.required !== undefined ? { required: positional.required } : {},
    ...positional.choices !== undefined ? { choices: positional.choices } : {},
    multiple: positional.multiple ?? positional.variadic ?? false
  }));
}
function stripGlobalJson(argv: string[]): {
  argv: string[];
  outputMode?: TaskRequestedOutputMode;
} {
  const out: string[] = [];
  let outputMode: TaskRequestedOutputMode | undefined;
  let stopped = false;
  for (const token of argv) {
    if (!stopped && token === '--') {
      stopped = true;
      out.push(token);
      continue;
    }
    if (!stopped && token === '--json') {
      outputMode = 'json';
      continue;
    }
    out.push(token);
  }
  return {
    argv: out,
    outputMode
  };
}
function contextInput(task: Task, ctx: CommandContext): Record<string, unknown> {
  const input: Record<string, unknown> = { ...ctx.args };
  const mappedKeys = new Set<string>();
  for (const option of task.cli?.options ?? []) {
    if (option.name !== undefined) mappedKeys.add(optionKey(option.flags));
  }
  for (const [key, value] of Object.entries(ctx.options)) {
    if (!mappedKeys.has(key)) input[key] = value;
  }
  for (const option of task.cli?.options ?? []) {
    if (option.name === undefined) continue;
    input[option.name] = ctx.options[optionKey(option.flags)];
  }
  return input;
}
/**
* Shared executable task for CLI, AI, MCP, and runtime surfaces.
*/
export class Task<
  Input = unknown,
  Output = unknown
> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: unknown;
  readonly outputMode: TaskOutputMode;
  readonly cli?: TaskCliSpec;
  readonly children: readonly Task[];
  readonly effects: readonly TaskEffect[];
  readonly requiresApproval: boolean;
  readonly risk?: string;
  readonly sideEffects: boolean;
  readonly timeoutMs?: number;
  readonly parameters: Record<string, unknown>;
  #run: TaskHandler<Input, Output>;
  #throwOnError: boolean;
  #validator: ReturnType<typeof compile> | null = null;
  #allChildren: readonly (Task | ArgvCommand)[] = [];
  constructor(options: TaskOptions<Input, Output>) {
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = options.inputSchema === undefined ? undefined : normalizeSchema(options.inputSchema);
    this.outputSchema = options.outputSchema;
    this.outputMode = options.outputMode ?? 'text';
    this.cli = options.cli;
    this.#allChildren = [...options.children ?? []] as Array<Task | ArgvCommand>;
    this.children = this.#allChildren.filter((child): child is Task => child instanceof Task);
    this.effects = [...options.effects ?? []];
    this.requiresApproval = options.requiresApproval ?? false;
    this.risk = options.risk;
    this.sideEffects = options.sideEffects ?? false;
    this.timeoutMs = options.timeoutMs;
    this.parameters = this.inputSchema ?? {
      type: 'object',
      properties: {}
    };
    this.#run = options.run;
    this.#throwOnError = options.throwOnError ?? false;
  }
  #getValidator(): ReturnType<typeof compile> | null {
    if (this.inputSchema === undefined) return null;
    if (!this.#validator) this.#validator = compile(this.inputSchema);
    return this.#validator;
  }
  #validate(rawInput: unknown): Input {
    const validator = this.#getValidator();
    if (validator === null) return rawInput as Input;
    const parsed = validator.safeParse(rawInput);
    if (parsed.success) return parsed.value as Input;
    const summary = parsed.issues.map((issue: {
      path: string;
      message: string;
    }) => `${issue.path || '<root>'}: ${issue.message}`).join('\n');
    throw new Error(summary);
  }
  async #execute(input: Input, ctx: TaskContext): Promise<Output> {
    if (this.timeoutMs === undefined) return await this.#run(input, ctx);
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) abortFromParent();
    else ctx.signal.addEventListener('abort', abortFromParent, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const err = new TaskTimeoutError(this.name, this.timeoutMs!);
          controller.abort(err);
          reject(err);
        }, this.timeoutMs);
      });
      return await Promise.race([this.#run(input, {
        ...ctx,
        signal: controller.signal
      }), timeoutPromise]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      ctx.signal.removeEventListener('abort', abortFromParent);
    }
  }
  /**
  * Run this task directly with already-structured input.
  */
  async run(rawInput: Input, options: TaskRunOptions = {}): Promise<Output> {
    const requested = normalizeRequestedOutputMode(this.outputMode, options.outputMode);
    if (options.writer !== undefined && options.writer.mode !== requested) {
      throw new Error(`Task "${this.name}" writer mode ${options.writer.mode} does not match requested ${requested} output`);
    }
    assertOutputMode(this.name, this.outputMode, requested);
    const writer = options.writer ?? makeDefaultWriter(requested);
    const input = this.#validate(rawInput);
    return await this.#execute(input, {
      signal: options.signal ?? defaultSignal(),
      runId: options.runId,
      writer,
      env: options.env,
      cwd: options.cwd,
      prompt: options.prompt,
      providedOptions: options.providedOptions,
      optionProvided: options.providedOptions ? (key) => options.providedOptions!.has(key) : undefined
    });
  }
  /**
  * Parse CLI argv, select a child task when present, and run the matched task.
  */
  parse(argv: string[], options: TaskParseOptions = {}): Output | Promise<Output> {
    const global = stripGlobalJson(argv);
    const requested = options.outputMode ?? global.outputMode ?? normalizeRequestedOutputMode(this.outputMode);
    const parseOptions: ParseOptions = { ...options.prompt !== undefined ? { prompt: options.prompt } : {} };
    const command = this.#toArgvCommand({
      outputMode: requested,
      writer: options.writer,
      signal: options.signal,
      runId: options.runId,
      env: options.env,
      cwd: options.cwd
    });
    return command.parse(global.argv, parseOptions) as Output | Promise<Output>;
  }
  /**
  * Generate CLI help text for this task and its child tasks.
  */
  help(): string {
    return this.#toArgvCommand({}).help();
  }
  /**
  * Return a direct child task by name.
  */
  child(name: string): Task | undefined {
    return this.children.find((child) => child.name === name);
  }
  /**
  * Return direct child tasks.
  */
  list(): readonly Task[] {
    return this.children;
  }
  #toArgvCommand(options: Omit<TaskRunOptions, 'writer'> & {
    writer?: TaskOutputWriter;
  }): ArgvCommand {
    const commandOptions = cloneCliOptions(this.cli?.options);
    const config: CommandConfig = {
      name: this.cli?.name ?? this.name,
      description: this.description,
      allowUnknown: this.cli?.allowUnknown,
      options: commandOptions,
      positionals: cloneCliPositionals(this.cli?.positionals),
      commands: (this.#allChildren as Array<Task | ArgvCommand>).map((child) => child instanceof Task ? child.#toArgvCommand(options) : child),
      run: (ctx) => this.run(contextInput(this, ctx) as Input, {
        ...options,
        prompt: ctx.prompt,
        providedOptions: ctx.providedOptions
      })
    };
    return new ArgvCommand(config);
  }
  /**
  * Invoke this task through the AI-tool-compatible result contract.
  */
  async invoke(rawArgs: unknown, ctx: TaskRunContext): Promise<{
    content: string | ContentPart[];
    isError?: boolean;
  }> {
    let output: Output;
    try {
      assertOutputMode(this.name, this.outputMode, 'text');
      const input = this.#validate(rawArgs);
      output = await this.#execute(input, {
        signal: ctx.signal,
        runId: ctx.runId,
        writer: {
          mode: 'text',
          writeText: () => undefined
        },
        toolCallId: ctx.toolCallId,
        step: ctx.step,
        messages: ctx.messages,
        history: ctx.history,
        suspend: ctx.suspend
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'SuspendSignal')) throw err;
      if (this.#throwOnError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: message,
        isError: true
      };
    }
    if (typeof output === 'string') return { content: output };
    const result = output as TaskToolResult;
    if (typeof result === 'string') return { content: result };
    if (result !== null && typeof result === 'object' && 'content' in result) {
      return result as {
        content: string | ContentPart[];
        isError?: boolean;
      };
    }
    return { content: JSON.stringify(output) };
  }
  /**
  * Convert this task to a provider-neutral model tool definition.
  */
  toToolDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description ?? '',
      parameters: this.parameters
    };
  }
  /**
  * Turn this task (and its children) into a job-worker dispatcher — the
  * default-export-function contract of `fino:realm/pool`.
  *
  * A module that default-exports a `Task` gets this applied automatically by
  * the realm bootstrap, so `new RealmPool({ entry: './my-task.ts' })` and
  * `fino:jobs` pool processors work on plain task files.
  *
  * ```ts no_run
  * import { task } from 'fino:task';
  *
  * const compact = task({ name: 'compact', run: async () => 'ok' });
  * export default compact.worker();
  * ```
  */
  worker(): (call: unknown) => Promise<unknown> {
    let dispatcher: Promise<(call: never) => Promise<unknown>> | undefined;
    return async (call: unknown) => {
      // Lazy so task.ts never statically depends on the jobs runner.
      dispatcher ??= import('internal:jobs/runner').then((mod) => (mod as {
        taskWorker(root: Task): (call: never) => Promise<unknown>;
      }).taskWorker(this as unknown as Task));
      return (await dispatcher)(call as never);
    };
  }
}
// Cross-module brand so the realm bootstrap can recognize a default-exported
// Task without importing fino:task eagerly (instanceof does not survive
// separate module caches; Symbol.for is per-isolate and the check always runs
// in the same realm as the export).
Object.defineProperty(Task.prototype, Symbol.for('fino.task'), {
  value: true,
  writable: false,
  enumerable: false,
  configurable: false
});
/**
* Create a task from metadata and an executor.
*/
export function task<
  Input = unknown,
  Output = unknown
>(options: TaskOptions<Input, Output>): Task<Input, Output> {
  return new Task(options);
}
/**
* Convert a task into the provider-neutral model tool definition shape.
*/
export function toTaskToolDefinition(t: Task): ToolDefinition {
  return t.toToolDefinition();
}
