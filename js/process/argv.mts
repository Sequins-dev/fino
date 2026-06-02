/**
 * fino:process/argv - config-based argv parser with nested command execution.
 *
 * This module builds small command-line interfaces from plain configuration
 * objects. A `Command` describes its options, positional arguments, subcommands,
 * and handler. Calling `parse(argv)` walks the command tree, coerces values,
 * applies defaults, validates required inputs, and then runs the handler for
 * the final command in the chain.
 *
 * The parser is intentionally focused on process argument arrays, not shell
 * strings. Pass an already-tokenized `argv` array such as `process.argv.slice(2)`;
 * shell quoting and environment expansion are expected to have happened before
 * the parser receives the values.
 *
 * Supported option forms are `--long`, `--long=value`, `-s`, grouped boolean
 * short flags such as `-abc`, and short options with inline or following values
 * such as `-p8080` or `-p 8080`. Boolean options default to `false`,
 * non-boolean options default to `undefined`, and `multiple` options collect
 * values in arrays. A literal `--` stops option parsing. `--help` returns the
 * generated help text for the command being parsed instead of running its
 * handler.
 *
 * Subcommands can have their own options and positionals. The command handler
 * receives a `CommandContext` containing the selected command, root and parent
 * invocations, parsed named arguments, option values, positional values, the
 * full invocation chain, and a `PromptSession`. Defaults may be functions, so a
 * command can compute context-sensitive defaults or prompt for missing values
 * before required-option validation runs.
 *
 * ## Examples
 *
 * ```ts no_run
 * import { Command } from 'fino:process/argv';
 *
 * const cli = new Command({
 *   name: 'deploy',
 *   description: 'Deploy an application release.',
 *   options: [
 *     { flags: '--env, -e', type: 'string', required: true },
 *     { flags: '--dry-run, -n', type: 'boolean' },
 *     { flags: '--tag, -t', type: 'string', multiple: true },
 *   ],
 *   positionals: [
 *     { name: 'service', required: true },
 *   ],
 *   run(ctx) {
 *     return {
 *       service: ctx.args.service,
 *       environment: ctx.options.env,
 *       dryRun: ctx.options['dry-run'],
 *       tags: ctx.options.tag,
 *     };
 *   },
 * });
 *
 * const result = cli.parse(['--env=prod', '-nt', 'blue', 'api']);
 * ```
 *
 * ```ts no_run
 * import { Command } from 'fino:process/argv';
 *
 * const cli = new Command({
 *   name: 'tool',
 *   commands: [
 *     {
 *       name: 'user',
 *       commands: [
 *         {
 *           name: 'create',
 *           positionals: [{ name: 'email', required: true }],
 *           options: [{ flags: '--admin, -a', type: 'boolean' }],
 *           run(ctx) {
 *             return `creating ${ctx.args.email}`;
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 *
 * cli.parse(['user', 'create', '--admin', 'me@example.com']);
 * ```
 *
 * This parser follows common POSIX/GNU command-line conventions, but it is not
 * a complete clone of any specific CLI framework.
 *
 * Useful references:
 *   - POSIX Utility Syntax Guidelines:
 *     https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html
 *   - GNU option conventions:
 *     https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces.html
 */

import { createDefaultPrompt, PromptSession } from '../tty/prompt.mts';

type OptionDefault =
  | boolean
  | string
  | number
  | Array<string | number>
  | ((ctx: CommandContext) => boolean | string | number | Array<string | number> | Promise<boolean | string | number | Array<string | number>>);

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as Promise<unknown>).then === 'function';
}

/**
 * Configuration object used to construct a command tree.
 *
 * ```ts no_run
 * import { Command, type CommandConfig } from 'fino:process/argv';
 *
 * const config: CommandConfig = { name: 'tool', run: () => 'ok' };
 * const command = new Command(config);
 * ```
 */
export interface CommandConfig {
  /**
   * Command name used in help text and subcommand matching.
   *
   * Root commands may omit a name. Subcommands must provide one or construction
   * throws when they are registered.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = { name: 'deploy' };
   * ```
   */
  name?: string;
  /**
   * Human-readable command description shown by `help()`.
   *
   * When omitted, help output contains only usage, options, arguments, and
   * subcommands.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = { description: 'Deploy a service.' };
   * ```
   */
  description?: string;
  /**
   * Whether unknown options should be treated as positionals.
   *
   * Defaults to `false`. When `false`, parsing an unknown `--long` or `-s`
   * option throws for the current command.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = { allowUnknown: true };
   * ```
   */
  allowUnknown?: boolean;
  /**
   * Handler invoked after parsing and validation.
   *
   * If omitted, the command returns its help text. The handler may return any
   * value or a promise.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = { run: (ctx) => ctx.options };
   * ```
   */
  run?: (ctx: CommandContext) => unknown;
  /**
   * Option definitions for this command.
   *
   * Options are scoped to the command where they are declared. Parent and child
   * command options are stored on their respective invocation nodes.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = {
   *   options: [{ flags: '--verbose, -v', type: 'boolean' }],
   * };
   * ```
   */
  options?: OptionConfig[];
  /**
   * Positional argument definitions for this command.
   *
   * Values are coerced in declaration order. At most one `multiple` positional
   * is allowed, and it must be declared last.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = {
   *   positionals: [{ name: 'service', required: true }],
   * };
   * ```
   */
  positionals?: PositionalConfig[];
  /**
   * Nested subcommands.
   *
   * Each subcommand may be a `Command` instance or a config object. Duplicate
   * child names throw during construction.
   *
   * ```ts no_run
   * import type { CommandConfig } from 'fino:process/argv';
   *
   * const config: CommandConfig = {
   *   commands: [{ name: 'init', run: () => 'created' }],
   * };
   * ```
   */
  commands?: Array<Command | CommandConfig>;
}

/**
 * Command-line option definition, including flags, type, multiplicity, and defaults.
 *
 * ```ts no_run
 * import type { OptionConfig } from 'fino:process/argv';
 *
 * const option: OptionConfig = { flags: '--port, -p', type: 'number' };
 * ```
 */
export interface OptionConfig {
  /**
   * Comma-separated long and/or short flags.
   *
   * Long flags start with `--`; short flags start with `-` and must be one
   * character. At least one valid flag is required.
   *
   * ```ts no_run
   * import type { OptionConfig } from 'fino:process/argv';
   *
   * const option: OptionConfig = { flags: '--env, -e', type: 'string' };
   * ```
   */
  flags: string;
  /**
   * Scalar type used for value coercion.
   *
   * Defaults to `boolean`. Number coercion rejects non-finite values.
   *
   * ```ts no_run
   * import type { OptionConfig } from 'fino:process/argv';
   *
   * const option: OptionConfig = { flags: '--retries', type: 'number' };
   * ```
   */
  type?: 'boolean' | 'string' | 'number';
  /**
   * Whether the option may be provided multiple times.
   *
   * Defaults to `false`. Multiple options collect values into an array, with an
   * empty array as the default when no explicit default is supplied.
   *
   * ```ts no_run
   * import type { OptionConfig } from 'fino:process/argv';
   *
   * const option: OptionConfig = { flags: '--tag, -t', type: 'string', multiple: true };
   * ```
   */
  multiple?: boolean;
  /**
   * Whether the option must be provided or resolved by a default.
   *
   * Defaults to `false`. Required validation runs after default functions have
   * resolved.
   *
   * ```ts no_run
   * import type { OptionConfig } from 'fino:process/argv';
   *
   * const option: OptionConfig = { flags: '--env', type: 'string', required: true };
   * ```
   */
  required?: boolean;
  /**
   * Description shown in generated help output.
   *
   * Omitted descriptions leave the help row without trailing explanatory text.
   *
   * ```ts no_run
   * import type { OptionConfig } from 'fino:process/argv';
   *
   * const option: OptionConfig = { flags: '--env', description: 'Deployment environment.' };
   * ```
   */
  description?: string;
  /**
   * Default value or function used when the option is not provided.
   *
   * Function defaults receive the current command context and may return a
   * promise. Array defaults are cloned before use.
   *
   * ```ts no_run
   * import type { OptionConfig } from 'fino:process/argv';
   *
   * const option: OptionConfig = { flags: '--env', type: 'string', default: 'dev' };
   * ```
   */
  default?: OptionDefault;
}

/**
 * Positional argument definition for a command.
 *
 * ```ts no_run
 * import type { PositionalConfig } from 'fino:process/argv';
 *
 * const positional: PositionalConfig = { name: 'file', required: true };
 * ```
 */
export interface PositionalConfig {
  /**
   * Positional argument name.
   *
   * Names must be non-empty. Parsed values are exposed as `ctx.args[name]`.
   *
   * ```ts no_run
   * import type { PositionalConfig } from 'fino:process/argv';
   *
   * const positional: PositionalConfig = { name: 'service' };
   * ```
   */
  name: string;
  /**
   * Scalar type used for value coercion.
   *
   * Defaults to `string`. Number coercion rejects non-finite values.
   *
   * ```ts no_run
   * import type { PositionalConfig } from 'fino:process/argv';
   *
   * const positional: PositionalConfig = { name: 'count', type: 'number' };
   * ```
   */
  type?: 'string' | 'number';
  /**
   * Whether a value is required.
   *
   * Defaults to `false`. Missing required positionals throw unless parsing is
   * still descending into a subcommand.
   *
   * ```ts no_run
   * import type { PositionalConfig } from 'fino:process/argv';
   *
   * const positional: PositionalConfig = { name: 'file', required: true };
   * ```
   */
  required?: boolean;
  /**
   * Whether this positional consumes all remaining positional values.
   *
   * Defaults to `false`. Only one multiple positional is allowed and it must be
   * the final positional definition.
   *
   * ```ts no_run
   * import type { PositionalConfig } from 'fino:process/argv';
   *
   * const positional: PositionalConfig = { name: 'files', multiple: true };
   * ```
   */
  multiple?: boolean;
  /**
   * Description shown in generated help output.
   *
   * ```ts no_run
   * import type { PositionalConfig } from 'fino:process/argv';
   *
   * const positional: PositionalConfig = { name: 'file', description: 'File to read.' };
   * ```
   */
  description?: string;
}

/**
 * Runtime context passed to a command handler.
 *
 * ```ts no_run
 * import { Command, type CommandContext } from 'fino:process/argv';
 *
 * const cli = new Command({
 *   run(ctx: CommandContext) {
 *     return ctx.path.join(' ');
 *   },
 * });
 * ```
 */
export interface CommandContext {
  /**
   * Final command whose handler is running.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.command.name;
   * }
   * ```
   */
  command: Command;
  /**
   * Invocation node for the final command.
   *
   * This contains parsed values scoped to the selected command only.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.invocation.options;
   * }
   * ```
   */
  invocation: CommandInvocation;
  /**
   * Parent invocation, or `null` for the root command.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.parent?.name ?? 'root';
   * }
   * ```
   */
  parent: CommandInvocation | null;
  /**
   * Root invocation for the parsed command chain.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.root.args;
   * }
   * ```
   */
  root: CommandInvocation;
  /**
   * Selected command path as an array of command names.
   *
   * Unnamed root commands do not contribute a path segment.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.path.join(':');
   * }
   * ```
   */
  path: string[];
  /**
   * Parsed named positional values for the final command.
   *
   * Missing optional positionals are present with `undefined` values. Variadic
   * positionals are arrays.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.args.service;
   * }
   * ```
   */
  args: Record<string, unknown>;
  /**
   * Parsed option values for the final command.
   *
   * Boolean options default to `false`, non-boolean options default to
   * `undefined`, and multiple options default to arrays.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.options.verbose;
   * }
   * ```
   */
  options: Record<string, unknown>;
  /**
   * Positional values for the final command in declaration/order form.
   *
   * Extra positionals accepted through `allowUnknown` are appended after named
   * positional values.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.positionals.length;
   * }
   * ```
   */
  positionals: unknown[];
  /**
   * Invocation chain from root to final command.
   *
   * Use this to inspect parent command options in nested CLIs.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.chain.map((item) => item.name);
   * }
   * ```
   */
  chain: CommandInvocation[];
  /**
   * Prompt session available to handlers and default functions.
   *
   * Defaults to `createDefaultPrompt()` unless a prompt is supplied to
   * `Command.parse()`.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * async function run(ctx: CommandContext) {
   *   return ctx.prompt;
   * }
   * ```
   */
  prompt: PromptSession;
  /**
   * Set of option keys explicitly provided for the final command.
   *
   * Defaults do not add keys to this set.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.providedOptions.has('env');
   * }
   * ```
   */
  providedOptions: Set<string>;
  /**
   * Check whether an option key was explicitly provided.
   *
   * This is equivalent to `providedOptions.has(key)` for the final invocation.
   * It returns `false` for values supplied by defaults.
   *
   * ```ts no_run
   * import type { CommandContext } from 'fino:process/argv';
   *
   * function run(ctx: CommandContext) {
   *   return ctx.optionProvided('dry-run');
   * }
   * ```
   */
  optionProvided(key: string): boolean;
}

interface OptionDefinition {
  key: string;
  longName: string | null;
  shortName: string | null;
  type: 'boolean' | 'string' | 'number';
  multiple: boolean;
  required: boolean;
  description: string | undefined;
  default: OptionDefault | undefined;
}

interface PositionalDefinition {
  name: string;
  type: 'string' | 'number';
  required: boolean;
  multiple: boolean;
  description: string | undefined;
}

interface ParseState {
  argv: string[];
  index: number;
}

interface ParsedNode {
  command: Command;
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  positionals: unknown[];
  rawPositionals: string[];
  helpRequested: boolean;
  providedOptions: Set<string>;
}

interface FinalizeConfig {
  allowMissingPositionals: boolean;
}

interface ParseOptions {
  prompt?: PromptSession;
}

/**
 * Parsed invocation node for one command in a nested command chain.
 *
 * Each node stores parsed values scoped to one command and points at its parent
 * invocation. Handlers usually receive these through `CommandContext`.
 *
 * ```ts no_run
 * import { CommandInvocation, Command } from 'fino:process/argv';
 *
 * const command = new Command({ name: 'root' });
 * const invocation = new CommandInvocation(command, null, {}, {}, [], new Set());
 * ```
 */
export class CommandInvocation {
  /**
   * Command represented by this invocation.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const command = new Command({ name: 'tool' });
   * const invocation = new CommandInvocation(command, null, {}, {}, [], new Set());
   * console.log(invocation.command.name);
   * ```
   */
  command: Command;
  /**
   * Parent invocation, or `null` for the root.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const root = new CommandInvocation(new Command({ name: 'tool' }), null, {}, {}, [], new Set());
   * const child = new CommandInvocation(new Command({ name: 'run' }), root, {}, {}, [], new Set());
   * console.log(child.parent?.name);
   * ```
   */
  parent: CommandInvocation | null;
  /**
   * Parsed named positionals for this command.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const invocation = new CommandInvocation(new Command(), null, { file: 'a.txt' }, {}, ['a.txt'], new Set());
   * console.log(invocation.args.file);
   * ```
   */
  args: Record<string, unknown>;
  /**
   * Parsed options for this command.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const invocation = new CommandInvocation(new Command(), null, {}, { verbose: true }, [], new Set(['verbose']));
   * console.log(invocation.options.verbose);
   * ```
   */
  options: Record<string, unknown>;
  /**
   * Parsed positional values for this command in order.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const invocation = new CommandInvocation(new Command(), null, {}, {}, ['a.txt'], new Set());
   * console.log(invocation.positionals[0]);
   * ```
   */
  positionals: unknown[];
  /**
   * Option keys explicitly provided for this command.
   *
   * Defaults are not included in this set.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const invocation = new CommandInvocation(new Command(), null, {}, {}, [], new Set(['env']));
   * console.log(invocation.providedOptions.has('env'));
   * ```
   */
  providedOptions: Set<string>;

  /**
   * Create a parsed invocation node.
   *
   * The constructor stores its arguments directly. It does not validate that
   * the values match the command's definitions.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const invocation = new CommandInvocation(new Command({ name: 'tool' }), null, {}, {}, [], new Set());
   * ```
   *
   * @param command Command represented by this invocation.
   * @param parent Parent invocation, or `null`.
   * @param args Named positional values.
   * @param options Parsed option values.
   * @param positionals Positional values in order.
   * @param providedOptions Explicitly provided option keys.
   */
  constructor(command: Command, parent: CommandInvocation | null, args: Record<string, unknown>, options: Record<string, unknown>, positionals: unknown[], providedOptions: Set<string>) {
    this.command = command;
    this.parent = parent;
    this.args = args;
    this.options = options;
    this.positionals = positionals;
    this.providedOptions = providedOptions;
  }

  /**
   * Command name for this invocation, or `null` for unnamed commands.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const invocation = new CommandInvocation(new Command({ name: 'deploy' }), null, {}, {}, [], new Set());
   * console.log(invocation.name);
   * ```
   */
  get name(): string | null {
    return this.command.name;
  }

  /**
   * Command path from root to this invocation.
   *
   * Unnamed commands are skipped. The returned array is newly built for each
   * access.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const root = new CommandInvocation(new Command({ name: 'tool' }), null, {}, {}, [], new Set());
   * const child = new CommandInvocation(new Command({ name: 'deploy' }), root, {}, {}, [], new Set());
   * console.log(child.path.join(' '));
   * ```
   */
  get path(): string[] {
    const names: string[] = [];
    let current: CommandInvocation | null = this;
    while (current !== null) {
      if (current.name !== null) names.push(current.name);
      current = current.parent;
    }
    names.reverse();
    return names;
  }
}

/**
 * Config-based command with nested subcommands, options, and positionals.
 *
 * A `Command` parses tokenized argv arrays, applies defaults, validates
 * required values, and runs the selected command handler. `parse()` returns the
 * handler result or a promise if async defaults or handlers are used.
 *
 * ```ts no_run
 * import { Command } from 'fino:process/argv';
 *
 * const cli = new Command({
 *   name: 'echo',
 *   positionals: [{ name: 'message', required: true }],
 *   run: (ctx) => ctx.args.message,
 * });
 * cli.parse(['hello']);
 * ```
 */
export class Command {
  /**
   * Private property `#name` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #name = undefined;
   *
   *   readInternalState() {
   *     return this.#name;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #name: string | null = null;
  /**
   * Private property `#description` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #description = undefined;
   *
   *   readInternalState() {
   *     return this.#description;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #description: string | undefined = undefined;
  /**
   * Private property `#allowUnknown` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #allowUnknown = undefined;
   *
   *   readInternalState() {
   *     return this.#allowUnknown;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #allowUnknown: boolean = false;
  /**
   * Private property `#runHandler` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #runHandler = undefined;
   *
   *   readInternalState() {
   *     return this.#runHandler;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #runHandler: ((ctx: CommandContext) => unknown) | undefined = undefined;
  /**
   * Private property `#parent` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #parent = undefined;
   *
   *   readInternalState() {
   *     return this.#parent;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #parent: Command | null = null;
  /**
   * Private property `#children` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #children = undefined;
   *
   *   readInternalState() {
   *     return this.#children;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #children: Command[] = [];
  /**
   * Private property `#childMap` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #childMap = undefined;
   *
   *   readInternalState() {
   *     return this.#childMap;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #childMap = new Map<string, Command>();
  /**
   * Private property `#options` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #options = undefined;
   *
   *   readInternalState() {
   *     return this.#options;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #options: OptionDefinition[] = [];
  /**
   * Private property `#positionals` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #positionals = undefined;
   *
   *   readInternalState() {
   *     return this.#positionals;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #positionals: PositionalDefinition[] = [];
  /**
   * Private property `#longOptions` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #longOptions = undefined;
   *
   *   readInternalState() {
   *     return this.#longOptions;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #longOptions = new Map<string, OptionDefinition>();
  /**
   * Private property `#shortOptions` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #shortOptions = undefined;
   *
   *   readInternalState() {
   *     return this.#shortOptions;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #shortOptions = new Map<string, OptionDefinition>();

  /**
   * Create a command from configuration.
   *
   * Options and positionals are registered immediately. Construction throws for
   * invalid flags, duplicate subcommands, unnamed subcommands, empty positional
   * names, or multiple/incorrectly placed variadic positionals.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * const command = new Command({ name: 'deploy', options: [{ flags: '--env' }] });
   * ```
   *
   * @param config Command configuration. Defaults to an unnamed root command.
   */
  constructor(config: CommandConfig = {}) {
    this.#name = config.name ?? null;
    this.#description = config.description;
    this.#allowUnknown = config.allowUnknown ?? false;
    this.#runHandler = config.run;

    for (const option of config.options ?? []) this.#registerOption(option);
    for (const positional of config.positionals ?? []) this.#registerPositional(positional);
    for (const child of config.commands ?? []) this.#registerChild(child instanceof Command ? child : new Command(child));
  }

  /**
   * Command name, or `null` for unnamed root commands.
   *
   * The value is used in generated usage text and subcommand matching.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * console.log(new Command({ name: 'deploy' }).name);
   * ```
   */
  get name(): string | null {
    return this.#name;
  }

  /**
   * Description shown in generated help output.
   *
   * Returns `undefined` when no description was configured.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * console.log(new Command({ description: 'Deploy services.' }).description);
   * ```
   */
  get description(): string | undefined {
    return this.#description;
  }

  /**
   * Parent command, or `null` for the root.
   *
   * The parent is assigned when a command is registered as a subcommand.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * const child = new Command({ name: 'run' });
   * new Command({ name: 'tool', commands: [child] });
   * console.log(child.parent?.name);
   * ```
   */
  get parent(): Command | null {
    return this.#parent;
  }

  /**
   * Parse tokenized argv and run the selected command.
   *
   * `--help` returns generated help text instead of running a handler. Unknown
   * options throw unless `allowUnknown` is enabled for the current command.
   * Async default values make the return value promise-like.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * const cli = new Command({
   *   options: [{ flags: '--count, -c', type: 'number', default: 1 }],
   *   run: (ctx) => ctx.options.count,
   * });
   * const count = cli.parse(['--count=3']);
   * ```
   *
   * @param argv Already-tokenized argument array, typically `argv.slice(2)`.
   * @param options Optional parse-time dependencies such as a prompt session.
   * @returns Handler result, help text, or a promise for the handler result.
   */
  parse(argv: string[], options: ParseOptions = {}): unknown {
    const state: ParseState = { argv, index: 0 };
    const parsedChain = this.#parseInto(state, []);
    const invocationChain = buildInvocationChain(parsedChain);
    const finalInvocation = invocationChain[invocationChain.length - 1];
    const finalParsed = parsedChain[parsedChain.length - 1];
    const prompt = options.prompt ?? createDefaultPrompt();
    if (finalInvocation === undefined || finalParsed === undefined) throw new Error('Command parse failed');

    if (finalParsed.helpRequested) return finalInvocation.command.help();
    const resolved = this.#resolveOptionDefaults(invocationChain, prompt);
    if (isPromiseLike(resolved)) {
      return resolved.then(() => finalInvocation.command.run(createContext(finalInvocation, invocationChain, prompt)));
    }
    return finalInvocation.command.run(createContext(finalInvocation, invocationChain, prompt));
  }

  /**
   * Run this command's handler with a parsed context.
   *
   * If no handler was configured, returns this command's help text. This method
   * does not parse or validate argv; `parse()` performs those steps.
   *
   * ```ts no_run
   * import { Command, CommandInvocation } from 'fino:process/argv';
   *
   * const command = new Command({ run: (ctx) => ctx.path });
   * const invocation = new CommandInvocation(command, null, {}, {}, [], new Set());
   * command.run({
   *   command,
   *   invocation,
   *   parent: null,
   *   root: invocation,
   *   path: [],
   *   args: {},
   *   options: {},
   *   positionals: [],
   *   chain: [invocation],
   *   prompt: undefined as never,
   *   providedOptions: new Set(),
   *   optionProvided: () => false,
   * });
   * ```
   *
   * @param ctx Parsed command context.
   * @returns Handler result or help text.
   */
  run(ctx: CommandContext): unknown {
    if (this.#runHandler !== undefined) return this.#runHandler(ctx);
    return this.help();
  }

  /**
   * Generate one-line usage text.
   *
   * The output includes command path, `[options]` when relevant, positional
   * usage, and `[command]` when subcommands are available.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * const cli = new Command({ name: 'tool', positionals: [{ name: 'file' }] });
   * console.log(cli.usage());
   * ```
   *
   * @param programName Optional program name to prefix or de-duplicate.
   * @returns Usage string.
   */
  usage(programName?: string): string {
    const segments = this.#commandPath();
    const parts: string[] = ['Usage:'];
    if (programName !== undefined && programName.length > 0) parts.push(programName);
    if (segments.length > 0) {
      const visibleSegments = programName !== undefined && segments[0] === programName ? segments.slice(1) : segments;
      parts.push(...visibleSegments);
    }
    if (this.#options.length > 0 || this.#children.length > 0) parts.push('[options]');
    parts.push(...this.#positionals.map(formatPositionalUsage));
    if (this.#children.length > 0) parts.push('[command]');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Generate help text for this command.
   *
   * The result includes usage, description, options, positional arguments, and
   * child commands when present. It never runs the command handler.
   *
   * ```ts no_run
   * import { Command } from 'fino:process/argv';
   *
   * const cli = new Command({ name: 'tool', description: 'Example CLI.' });
   * console.log(cli.help());
   * ```
   *
   * @param programName Optional program name passed to `usage()`.
   * @returns Multiline help text.
   */
  help(programName?: string): string {
    const lines = [this.usage(programName)];
    if (this.#description !== undefined && this.#description.length > 0) {
      lines.push('');
      lines.push(this.#description);
    }
    if (this.#options.length > 0) {
      lines.push('');
      lines.push('Options:');
      for (const def of this.#options) lines.push(`  ${formatFlags(def)}${formatDescription(def.description)}`);
    }
    if (this.#positionals.length > 0) {
      lines.push('');
      lines.push('Arguments:');
      for (const def of this.#positionals) {
        lines.push(`  ${def.name} (${def.type}${def.multiple ? '[]' : ''})${formatDescription(def.description)}`);
      }
    }
    if (this.#children.length > 0) {
      lines.push('');
      lines.push('Commands:');
      for (const child of this.#children) lines.push(`  ${child.name}${formatDescription(child.description)}`);
    }
    return lines.join('\n');
  }

  /**
   * Private method `#registerOption` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #registerOption() {
   *     return 'registerOption';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#registerOption();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #registerOption(config: OptionConfig): void {
    const parsed = parseFlags(config.flags);
    const def: OptionDefinition = {
      key: parsed.longName ?? parsed.shortName!,
      longName: parsed.longName,
      shortName: parsed.shortName,
      type: config.type ?? 'boolean',
      multiple: config.multiple ?? false,
      required: config.required ?? false,
      description: config.description,
      default: config.default,
    };
    this.#options.push(def);
    if (def.longName !== null) this.#longOptions.set(def.longName, def);
    if (def.shortName !== null) this.#shortOptions.set(def.shortName, def);
  }

  /**
   * Private method `#registerPositional` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #registerPositional() {
   *     return 'registerPositional';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#registerPositional();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #registerPositional(config: PositionalConfig): void {
    if (config.name.length === 0) throw new Error('Positional name must not be empty');
    const def: PositionalDefinition = {
      name: config.name,
      type: config.type ?? 'string',
      required: config.required ?? false,
      multiple: config.multiple ?? false,
      description: config.description,
    };
    if (def.multiple && this.#positionals.some((item) => item.multiple)) {
      throw new Error(`Command "${this.#name ?? 'root'}" already has a variadic positional`);
    }
    if (this.#positionals.some((item) => item.multiple)) {
      throw new Error('Variadic positional must be declared last');
    }
    this.#positionals.push(def);
  }

  /**
   * Private method `#registerChild` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #registerChild() {
   *     return 'registerChild';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#registerChild();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #registerChild(command: Command): void {
    if (command.name === null) throw new Error('Subcommands must have a name');
    if (this.#childMap.has(command.name)) throw new Error(`Duplicate command "${command.name}"`);
    command.#parent = this;
    this.#children.push(command);
    this.#childMap.set(command.name, command);
  }

  /**
   * Private method `#parseInto` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #parseInto() {
   *     return 'parseInto';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#parseInto();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #parseInto(state: ParseState, path: string[]): ParsedNode[] {
    const parsed: ParsedNode = {
      command: this,
      args: {},
      options: makeInitialOptions(this.#options),
      positionals: [],
      rawPositionals: [],
      helpRequested: false,
      providedOptions: new Set(),
    };
    let stopOptions = false;

    while (state.index < state.argv.length) {
      const token = state.argv[state.index];
      if (token === undefined) break;
      const child = this.#childMap.get(token);
      if (!stopOptions && child !== undefined) {
        if (!parsed.helpRequested) this.#finalizeParsedNode(parsed, this.#formatPath(path), { allowMissingPositionals: true });
        state.index++;
        return [parsed, ...child.#parseInto(state, [...path, child.name!])];
      }

      if (!stopOptions && token === '--') {
        stopOptions = true;
        state.index++;
        continue;
      }

      if (!stopOptions && token === '--help') {
        parsed.helpRequested = true;
        state.index++;
        continue;
      }

      if (!stopOptions && token.startsWith('--') && token.length > 2) {
        if (!this.#consumeLongOption(state, parsed, path)) {
          if (this.#allowUnknown) {
            stopOptions = true;
            continue;
          }
          throw new Error(`Unknown option "${token}" for ${this.#formatPath(path)}`);
        }
        continue;
      }

      if (!stopOptions && token.startsWith('-') && token.length > 1) {
        if (!this.#consumeShortOptions(state, parsed, path)) {
          if (this.#allowUnknown) {
            stopOptions = true;
            continue;
          }
          throw new Error(`Unknown option "${token}" for ${this.#formatPath(path)}`);
        }
        continue;
      }

      parsed.rawPositionals.push(token);
      state.index++;
    }

    if (!parsed.helpRequested) this.#finalizeParsedNode(parsed, this.#formatPath(path), { allowMissingPositionals: false });
    return [parsed];
  }

  /**
   * Private method `#consumeLongOption` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #consumeLongOption() {
   *     return 'consumeLongOption';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#consumeLongOption();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #consumeLongOption(state: ParseState, parsed: ParsedNode, path: string[]): boolean {
    const token = state.argv[state.index];
    if (token === undefined) return false;
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value = eq === -1 ? null : token.slice(eq + 1);
    const def = this.#longOptions.get(flag);
    if (def === undefined) return false;

    state.index++;

    if (def.type === 'boolean') {
      assignOptionValue(parsed.options, parsed.providedOptions, def, value === null ? true : coerceScalarValue(def.type, value, formatPath(path), formatOption(def)));
      return true;
    }

    const raw = value === null ? takeNextValue(state, def, this.#formatPath(path)) : value;
    assignOptionValue(parsed.options, parsed.providedOptions, def, coerceScalarValue(def.type, raw, formatPath(path), formatOption(def)));
    return true;
  }

  /**
   * Private method `#consumeShortOptions` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #consumeShortOptions() {
   *     return 'consumeShortOptions';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#consumeShortOptions();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #consumeShortOptions(state: ParseState, parsed: ParsedNode, path: string[]): boolean {
    const token = state.argv[state.index];
    if (token === undefined) return false;
    const group = token.slice(1);
    let consumedAny = false;

    for (let i = 0; i < group.length; i++) {
      const name = group[i];
      if (name === undefined) continue;
      const def = this.#shortOptions.get(name);
      if (def === undefined) {
        if (!consumedAny) return false;
        throw new Error(`Unknown option "-${name}" for ${this.#formatPath(path)}`);
      }

      consumedAny = true;
      if (def.type === 'boolean') {
        assignOptionValue(parsed.options, parsed.providedOptions, def, true);
        continue;
      }

      const inline = group.slice(i + 1);
      state.index++;
      const raw = inline.length > 0 ? inline : takeNextValue(state, def, this.#formatPath(path));
      assignOptionValue(parsed.options, parsed.providedOptions, def, coerceScalarValue(def.type, raw, formatPath(path), formatOption(def)));
      return true;
    }

    state.index++;
    return true;
  }

  /**
   * Private method `#commandPath` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #commandPath() {
   *     return 'commandPath';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#commandPath();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #commandPath(): string[] {
    const names: string[] = [];
    let current: Command | null = this;
    while (current !== null) {
      if (current.name !== null) names.push(current.name);
      current = current.parent;
    }
    names.reverse();
    return names;
  }

  /**
   * Private method `#formatPath` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #formatPath() {
   *     return 'formatPath';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#formatPath();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #formatPath(path: string[]): string {
    const names = this.#name === null ? path : path.length === 0 ? [this.#name] : path;
    return names.length === 0 ? 'root command' : `command "${names.join(' ')}"`;
  }

  /**
   * Private method `#finalizeParsedNode` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #finalizeParsedNode() {
   *     return 'finalizeParsedNode';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#finalizeParsedNode();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #finalizeParsedNode(parsed: ParsedNode, formattedPath: string, config: FinalizeConfig): void {
    const args: Record<string, unknown> = {};
    const values: unknown[] = [];
    let index = 0;

    for (const def of this.#positionals) {
      if (def.multiple) {
        const rawValues = parsed.rawPositionals.slice(index);
        if (def.required && rawValues.length === 0 && !config.allowMissingPositionals) {
          throw new Error(`Missing required positional "${def.name}" on ${formattedPath}`);
        }
        const coerced = rawValues.map((raw) => coerceScalarValue(def.type, raw, formattedPath, `positional "${def.name}"`));
        args[def.name] = coerced;
        values.push(...coerced);
        index = parsed.rawPositionals.length;
        continue;
      }

      const raw = parsed.rawPositionals[index];
      if (raw === undefined) {
        if (def.required && !config.allowMissingPositionals) {
          throw new Error(`Missing required positional "${def.name}" on ${formattedPath}`);
        }
        args[def.name] = undefined;
        continue;
      }
      const coerced = coerceScalarValue(def.type, raw, formattedPath, `positional "${def.name}"`);
      args[def.name] = coerced;
      values.push(coerced);
      index++;
    }

    for (; index < parsed.rawPositionals.length; index++) values.push(parsed.rawPositionals[index]);
    parsed.args = args;
    parsed.positionals = values;
  }

  /**
   * Private method `#resolveOptionDefaults` used by `Command`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #resolveOptionDefaults() {
   *     return 'resolveOptionDefaults';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#resolveOptionDefaults();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #resolveOptionDefaults(chain: CommandInvocation[], prompt: PromptSession): void | Promise<void> {
    let pending: Promise<void> | null = null;

    function schedule(work: () => void | Promise<void>) {
      if (pending === null) {
        const result = work();
        if (isPromiseLike(result)) pending = Promise.resolve(result).then(() => undefined);
      } else {
        pending = pending.then(async () => { await work(); });
      }
    }

    for (const invocation of chain) {
      for (const def of invocation.command.#options) {
        if (invocation.providedOptions.has(def.key)) continue;
        const defaultValue = def.default;
        if (defaultValue === undefined) continue;

        if (typeof defaultValue === 'function') {
          schedule(async () => {
            invocation.options[def.key] = await defaultValue(createContext(invocation, chain, prompt));
          });
        } else {
          const currentValue = invocation.options[def.key];
          if (currentValue === undefined || (def.multiple && Array.isArray(currentValue) && currentValue.length === 0)) {
            invocation.options[def.key] = cloneDefault(defaultValue);
          }
        }
      }
      schedule(() => {
        validateRequiredOptions(invocation.command.#options, invocation.options, invocation.command.#formatPath(invocation.path));
      });
    }
    return pending ?? undefined;
  }
}

function parseFlags(flags: string): { longName: string | null; shortName: string | null } {
  let longName: string | null = null;
  let shortName: string | null = null;
  for (const part of flags.split(',')) {
    const flag = part.trim();
    if (flag.startsWith('--')) {
      const name = flag.slice(2).trim();
      if (name.length === 0) throw new Error(`Invalid long option "${flags}"`);
      longName = name;
    } else if (flag.startsWith('-')) {
      const name = flag.slice(1).trim();
      if (name.length !== 1) throw new Error(`Invalid short option "${flags}"`);
      shortName = name;
    } else {
      throw new Error(`Invalid option flags "${flags}"`);
    }
  }

  if (longName === null && shortName === null) throw new Error(`Invalid option flags "${flags}"`);
  return { longName, shortName };
}

function makeInitialOptions(defs: OptionDefinition[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of defs) {
    if (def.multiple) {
      out[def.key] = Array.isArray(def.default) ? [...def.default] : [];
    } else if (def.default !== undefined && typeof def.default !== 'function') {
      out[def.key] = cloneDefault(def.default);
    } else if (def.type === 'boolean') {
      out[def.key] = false;
    } else {
      out[def.key] = undefined;
    }
  }
  return out;
}

function cloneDefault(value: boolean | string | number | Array<string | number>) {
  return Array.isArray(value) ? [...value] : value;
}

function takeNextValue(state: ParseState, def: OptionDefinition, formattedPath: string): string {
  if (state.index >= state.argv.length) throw new Error(`Missing value for option "${formatOption(def)}" on ${formattedPath}`);
  const value = state.argv[state.index];
  state.index++;
  if (value === undefined) throw new Error(`Missing value for option "${formatOption(def)}" on ${formattedPath}`);
  return value;
}

function coerceScalarValue(type: 'boolean' | 'string' | 'number', raw: string, path: string, label: string): boolean | string | number {
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`Invalid value "${raw}" for ${label} on ${path}`);
  }
  if (type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid value "${raw}" for ${label} on ${path}`);
    return value;
  }
  return raw;
}

function assignOptionValue(options: Record<string, unknown>, providedOptions: Set<string>, def: OptionDefinition, value: unknown): void {
  providedOptions.add(def.key);
  if (def.multiple) {
    const current = options[def.key];
    const items = Array.isArray(current) ? current : [];
    items.push(value as string | number);
    options[def.key] = items;
    return;
  }
  options[def.key] = value;
}

function validateRequiredOptions(defs: OptionDefinition[], options: Record<string, unknown>, formattedPath: string): void {
  for (const def of defs) {
    const value = options[def.key];
    const missing = def.multiple ? Array.isArray(value) && value.length === 0 : value === undefined;
    if (def.required && missing) throw new Error(`Missing required option "${formatOption(def)}" on ${formattedPath}`);
  }
}

function buildInvocationChain(parsedChain: ParsedNode[]): CommandInvocation[] {
  const chain: CommandInvocation[] = [];
  let parent: CommandInvocation | null = null;
  for (const parsed of parsedChain) {
    const invocation: CommandInvocation = new CommandInvocation(parsed.command, parent, parsed.args, parsed.options, parsed.positionals, parsed.providedOptions);
    chain.push(invocation);
    parent = invocation;
  }
  return chain;
}

function createContext(invocation: CommandInvocation, chain: CommandInvocation[], prompt: PromptSession): CommandContext {
  const root = chain[0];
  if (root === undefined) throw new Error('Command invocation chain is empty');
  return {
    command: invocation.command,
    invocation,
    parent: invocation.parent,
    root,
    path: invocation.path,
    args: invocation.args,
    options: invocation.options,
    positionals: invocation.positionals,
    chain,
    prompt,
    providedOptions: invocation.providedOptions,
    optionProvided(key: string) {
      return invocation.providedOptions.has(key);
    },
  };
}

function formatOption(def: OptionDefinition): string {
  if (def.longName !== null) return `--${def.longName}`;
  if (def.shortName === null) throw new Error('Option definition is missing a flag name');
  return `-${def.shortName}`;
}

function formatFlags(def: OptionDefinition): string {
  const parts = [];
  if (def.longName !== null) parts.push(`--${def.longName}`);
  if (def.shortName !== null) parts.push(`-${def.shortName}`);
  return parts.join(', ');
}

function formatDescription(description?: string): string {
  return description === undefined || description.length === 0 ? '' : `  ${description}`;
}

function formatPositionalUsage(def: PositionalDefinition): string {
  const label = def.multiple ? `${def.name}...` : def.name;
  return def.required ? `<${label}>` : `[${label}]`;
}

function formatPath(path: string[]): string {
  return path.length === 0 ? 'root command' : `command "${path.join(' ')}"`;
}
