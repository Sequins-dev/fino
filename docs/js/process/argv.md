# argv

fino:process/argv - config-based argv parser with nested command execution.

This module builds small command-line interfaces from plain configuration
objects. A `Command` describes its options, positional arguments, subcommands,
and handler. Calling `parse(argv)` walks the command tree, coerces values,
applies defaults, validates required inputs, and then runs the handler for
the final command in the chain.

The parser is intentionally focused on process argument arrays, not shell
strings. Pass an already-tokenized `argv` array such as `process.argv.slice(2)`;
shell quoting and environment expansion are expected to have happened before
the parser receives the values.

Supported option forms are `--long`, `--long=value`, `-s`, grouped boolean
short flags such as `-abc`, and short options with inline or following values
such as `-p8080` or `-p 8080`. Boolean options default to `false`,
non-boolean options default to `undefined`, and `multiple` options collect
values in arrays. A literal `--` stops option parsing. `--help` returns the
generated help text for the command being parsed instead of running its
handler.

Subcommands can have their own options and positionals. The command handler
receives a `CommandContext` containing the selected command, root and parent
invocations, parsed named arguments, option values, positional values, the
full invocation chain, and a `PromptSession`. Defaults may be functions, so a
command can compute context-sensitive defaults or prompt for missing values
before required-option validation runs.

## Examples

```ts
import { Command } from 'fino:process/argv';

const cli = new Command({
  name: 'deploy',
  description: 'Deploy an application release.',
  options: [
    { flags: '--env, -e', type: 'string', required: true },
    { flags: '--dry-run, -n', type: 'boolean' },
    { flags: '--tag, -t', type: 'string', multiple: true },
  ],
  positionals: [
    { name: 'service', required: true },
  ],
  run(ctx) {
    return {
      service: ctx.args.service,
      environment: ctx.options.env,
      dryRun: ctx.options['dry-run'],
      tags: ctx.options.tag,
    };
  },
});

const result = cli.parse(['--env=prod', '-nt', 'blue', 'api']);
```

```ts
import { Command } from 'fino:process/argv';

const cli = new Command({
  name: 'tool',
  commands: [
    {
      name: 'user',
      commands: [
        {
          name: 'create',
          positionals: [{ name: 'email', required: true }],
          options: [{ flags: '--admin, -a', type: 'boolean' }],
          run(ctx) {
            return `creating ${ctx.args.email}`;
          },
        },
      ],
    },
  ],
});

cli.parse(['user', 'create', '--admin', 'me@example.com']);
```

This parser follows common POSIX/GNU command-line conventions, but it is not
a complete clone of any specific CLI framework.

Useful references:
  - POSIX Utility Syntax Guidelines:
    https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/V1_chap12.html
  - GNU option conventions:
    https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces.html

## CommandConfig

```ts
interface CommandConfig {
```

Configuration object used to construct a command tree.

```ts
import { Command, type CommandConfig } from 'fino:process/argv';

const config: CommandConfig = { name: 'tool', run: () => 'ok' };
const command = new Command(config);
```

### name

```ts
name?: string
```

Command name used in help text and subcommand matching.

Root commands may omit a name. Subcommands must provide one or construction
throws when they are registered.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = { name: 'deploy' };
```

### description

```ts
description?: string
```

Human-readable command description shown by `help()`.

When omitted, help output contains only usage, options, arguments, and
subcommands.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = { description: 'Deploy a service.' };
```

### allowUnknown

```ts
allowUnknown?: boolean
```

Whether unknown options should be treated as positionals.

Defaults to `false`. When `false`, parsing an unknown `--long` or `-s`
option throws for the current command.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = { allowUnknown: true };
```

### run

```ts
run?: (ctx: CommandContext) => unknown
```

Handler invoked after parsing and validation.

If omitted, the command returns its help text. The handler may return any
value or a promise.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = { run: (ctx) => ctx.options };
```

### options

```ts
options?: OptionConfig[]
```

Option definitions for this command.

Options are scoped to the command where they are declared. Parent and child
command options are stored on their respective invocation nodes.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = {
  options: [{ flags: '--verbose, -v', type: 'boolean' }],
};
```

### positionals

```ts
positionals?: PositionalConfig[]
```

Positional argument definitions for this command.

Values are coerced in declaration order. At most one `multiple` positional
is allowed, and it must be declared last.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = {
  positionals: [{ name: 'service', required: true }],
};
```

### commands

```ts
commands?: Array<Command | CommandConfig>
```

Nested subcommands.

Each subcommand may be a `Command` instance or a config object. Duplicate
child names throw during construction.

```ts
import type { CommandConfig } from 'fino:process/argv';

const config: CommandConfig = {
  commands: [{ name: 'init', run: () => 'created' }],
};
```

## OptionConfig

```ts
interface OptionConfig {
```

Command-line option definition, including flags, type, multiplicity, and defaults.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--port, -p', type: 'number' };
```

### flags

```ts
flags: string
```

Comma-separated long and/or short flags.

Long flags start with `--`; short flags start with `-` and must be one
character. At least one valid flag is required.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--env, -e', type: 'string' };
```

### type

```ts
type?: 'boolean' | 'string' | 'number'
```

Scalar type used for value coercion.

Defaults to `boolean`. Number coercion rejects non-finite values.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--retries', type: 'number' };
```

### multiple

```ts
multiple?: boolean
```

Whether the option may be provided multiple times.

Defaults to `false`. Multiple options collect values into an array, with an
empty array as the default when no explicit default is supplied.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--tag, -t', type: 'string', multiple: true };
```

### required

```ts
required?: boolean
```

Whether the option must be provided or resolved by a default.

Defaults to `false`. Required validation runs after default functions have
resolved.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--env', type: 'string', required: true };
```

### description

```ts
description?: string
```

Description shown in generated help output.

Omitted descriptions leave the help row without trailing explanatory text.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--env', description: 'Deployment environment.' };
```

### default

```ts
default?: OptionDefault
```

Default value or function used when the option is not provided.

Function defaults receive the current command context and may return a
promise. Array defaults are cloned before use.

```ts
import type { OptionConfig } from 'fino:process/argv';

const option: OptionConfig = { flags: '--env', type: 'string', default: 'dev' };
```

## PositionalConfig

```ts
interface PositionalConfig {
```

Positional argument definition for a command.

```ts
import type { PositionalConfig } from 'fino:process/argv';

const positional: PositionalConfig = { name: 'file', required: true };
```

### name

```ts
name: string
```

Positional argument name.

Names must be non-empty. Parsed values are exposed as `ctx.args[name]`.

```ts
import type { PositionalConfig } from 'fino:process/argv';

const positional: PositionalConfig = { name: 'service' };
```

### type

```ts
type?: 'string' | 'number'
```

Scalar type used for value coercion.

Defaults to `string`. Number coercion rejects non-finite values.

```ts
import type { PositionalConfig } from 'fino:process/argv';

const positional: PositionalConfig = { name: 'count', type: 'number' };
```

### required

```ts
required?: boolean
```

Whether a value is required.

Defaults to `false`. Missing required positionals throw unless parsing is
still descending into a subcommand.

```ts
import type { PositionalConfig } from 'fino:process/argv';

const positional: PositionalConfig = { name: 'file', required: true };
```

### multiple

```ts
multiple?: boolean
```

Whether this positional consumes all remaining positional values.

Defaults to `false`. Only one multiple positional is allowed and it must be
the final positional definition.

```ts
import type { PositionalConfig } from 'fino:process/argv';

const positional: PositionalConfig = { name: 'files', multiple: true };
```

### description

```ts
description?: string
```

Description shown in generated help output.

```ts
import type { PositionalConfig } from 'fino:process/argv';

const positional: PositionalConfig = { name: 'file', description: 'File to read.' };
```

## CommandContext

```ts
interface CommandContext {
```

Runtime context passed to a command handler.

```ts
import { Command, type CommandContext } from 'fino:process/argv';

const cli = new Command({
  run(ctx: CommandContext) {
    return ctx.path.join(' ');
  },
});
```

### command

```ts
command: Command
```

Final command whose handler is running.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.command.name;
}
```

### invocation

```ts
invocation: CommandInvocation
```

Invocation node for the final command.

This contains parsed values scoped to the selected command only.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.invocation.options;
}
```

### parent

```ts
parent: CommandInvocation | null
```

Parent invocation, or `null` for the root command.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.parent?.name ?? 'root';
}
```

### root

```ts
root: CommandInvocation
```

Root invocation for the parsed command chain.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.root.args;
}
```

### path

```ts
path: string[]
```

Selected command path as an array of command names.

Unnamed root commands do not contribute a path segment.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.path.join(':');
}
```

### args

```ts
args: Record<string, unknown>
```

Parsed named positional values for the final command.

Missing optional positionals are present with `undefined` values. Variadic
positionals are arrays.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.args.service;
}
```

### options

```ts
options: Record<string, unknown>
```

Parsed option values for the final command.

Boolean options default to `false`, non-boolean options default to
`undefined`, and multiple options default to arrays.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.options.verbose;
}
```

### positionals

```ts
positionals: unknown[]
```

Positional values for the final command in declaration/order form.

Extra positionals accepted through `allowUnknown` are appended after named
positional values.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.positionals.length;
}
```

### chain

```ts
chain: CommandInvocation[]
```

Invocation chain from root to final command.

Use this to inspect parent command options in nested CLIs.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.chain.map((item) => item.name);
}
```

### prompt

```ts
prompt: PromptSession
```

Prompt session available to handlers and default functions.

Defaults to `createDefaultPrompt()` unless a prompt is supplied to
`Command.parse()`.

```ts
import type { CommandContext } from 'fino:process/argv';

async function run(ctx: CommandContext) {
  return ctx.prompt;
}
```

### providedOptions

```ts
providedOptions: Set<string>
```

Set of option keys explicitly provided for the final command.

Defaults do not add keys to this set.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.providedOptions.has('env');
}
```

### optionProvided

```ts
optionProvided(key: string): boolean
```

Check whether an option key was explicitly provided.

This is equivalent to `providedOptions.has(key)` for the final invocation.
It returns `false` for values supplied by defaults.

```ts
import type { CommandContext } from 'fino:process/argv';

function run(ctx: CommandContext) {
  return ctx.optionProvided('dry-run');
}
```

## CommandInvocation

```ts
class CommandInvocation {
```

Parsed invocation node for one command in a nested command chain.

Each node stores parsed values scoped to one command and points at its parent
invocation. Handlers usually receive these through `CommandContext`.

```ts
import { CommandInvocation, Command } from 'fino:process/argv';

const command = new Command({ name: 'root' });
const invocation = new CommandInvocation(command, null, {}, {}, [], new Set());
```

### command

```ts
command: Command
```

Command represented by this invocation.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const command = new Command({ name: 'tool' });
const invocation = new CommandInvocation(command, null, {}, {}, [], new Set());
console.log(invocation.command.name);
```

### parent

```ts
parent: CommandInvocation | null
```

Parent invocation, or `null` for the root.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const root = new CommandInvocation(new Command({ name: 'tool' }), null, {}, {}, [], new Set());
const child = new CommandInvocation(new Command({ name: 'run' }), root, {}, {}, [], new Set());
console.log(child.parent?.name);
```

### args

```ts
args: Record<string, unknown>
```

Parsed named positionals for this command.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const invocation = new CommandInvocation(new Command(), null, { file: 'a.txt' }, {}, ['a.txt'], new Set());
console.log(invocation.args.file);
```

### options

```ts
options: Record<string, unknown>
```

Parsed options for this command.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const invocation = new CommandInvocation(new Command(), null, {}, { verbose: true }, [], new Set(['verbose']));
console.log(invocation.options.verbose);
```

### positionals

```ts
positionals: unknown[]
```

Parsed positional values for this command in order.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const invocation = new CommandInvocation(new Command(), null, {}, {}, ['a.txt'], new Set());
console.log(invocation.positionals[0]);
```

### providedOptions

```ts
providedOptions: Set<string>
```

Option keys explicitly provided for this command.

Defaults are not included in this set.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const invocation = new CommandInvocation(new Command(), null, {}, {}, [], new Set(['env']));
console.log(invocation.providedOptions.has('env'));
```

### constructor

```ts
constructor(command: Command, parent: CommandInvocation | null, args: Record<string, unknown>, options: Record<string, unknown>, positionals: unknown[], providedOptions: Set<string>)
```

Create a parsed invocation node.

The constructor stores its arguments directly. It does not validate that
the values match the command's definitions.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const invocation = new CommandInvocation(new Command({ name: 'tool' }), null, {}, {}, [], new Set());
```

### name

```ts
get name(): string | null
```

Command name for this invocation, or `null` for unnamed commands.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const invocation = new CommandInvocation(new Command({ name: 'deploy' }), null, {}, {}, [], new Set());
console.log(invocation.name);
```

### path

```ts
get path(): string[]
```

Command path from root to this invocation.

Unnamed commands are skipped. The returned array is newly built for each
access.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const root = new CommandInvocation(new Command({ name: 'tool' }), null, {}, {}, [], new Set());
const child = new CommandInvocation(new Command({ name: 'deploy' }), root, {}, {}, [], new Set());
console.log(child.path.join(' '));
```

## Command

```ts
class Command {
```

Config-based command with nested subcommands, options, and positionals.

A `Command` parses tokenized argv arrays, applies defaults, validates
required values, and runs the selected command handler. `parse()` returns the
handler result or a promise if async defaults or handlers are used.

```ts
import { Command } from 'fino:process/argv';

const cli = new Command({
  name: 'echo',
  positionals: [{ name: 'message', required: true }],
  run: (ctx) => ctx.args.message,
});
cli.parse(['hello']);
```

### constructor

```ts
constructor(config: CommandConfig = {})
```

Create a command from configuration.

Options and positionals are registered immediately. Construction throws for
invalid flags, duplicate subcommands, unnamed subcommands, empty positional
names, or multiple/incorrectly placed variadic positionals.

```ts
import { Command } from 'fino:process/argv';

const command = new Command({ name: 'deploy', options: [{ flags: '--env' }] });
```

### name

```ts
get name(): string | null
```

Command name, or `null` for unnamed root commands.

The value is used in generated usage text and subcommand matching.

```ts
import { Command } from 'fino:process/argv';

console.log(new Command({ name: 'deploy' }).name);
```

### description

```ts
get description(): string | undefined
```

Description shown in generated help output.

Returns `undefined` when no description was configured.

```ts
import { Command } from 'fino:process/argv';

console.log(new Command({ description: 'Deploy services.' }).description);
```

### parent

```ts
get parent(): Command | null
```

Parent command, or `null` for the root.

The parent is assigned when a command is registered as a subcommand.

```ts
import { Command } from 'fino:process/argv';

const child = new Command({ name: 'run' });
new Command({ name: 'tool', commands: [child] });
console.log(child.parent?.name);
```

### parse

```ts
parse(argv: string[], options: ParseOptions = {}): unknown
```

Parse tokenized argv and run the selected command.

`--help` returns generated help text instead of running a handler. Unknown
options throw unless `allowUnknown` is enabled for the current command.
Async default values make the return value promise-like.

```ts
import { Command } from 'fino:process/argv';

const cli = new Command({
  options: [{ flags: '--count, -c', type: 'number', default: 1 }],
  run: (ctx) => ctx.options.count,
});
const count = cli.parse(['--count=3']);
```

### run

```ts
run(ctx: CommandContext): unknown
```

Run this command's handler with a parsed context.

If no handler was configured, returns this command's help text. This method
does not parse or validate argv; `parse()` performs those steps.

```ts
import { Command, CommandInvocation } from 'fino:process/argv';

const command = new Command({ run: (ctx) => ctx.path });
const invocation = new CommandInvocation(command, null, {}, {}, [], new Set());
command.run({
  command,
  invocation,
  parent: null,
  root: invocation,
  path: [],
  args: {},
  options: {},
  positionals: [],
  chain: [invocation],
  prompt: undefined as never,
  providedOptions: new Set(),
  optionProvided: () => false,
});
```

### usage

```ts
usage(programName?: string): string
```

Generate one-line usage text.

The output includes command path, `[options]` when relevant, positional
usage, and `[command]` when subcommands are available.

```ts
import { Command } from 'fino:process/argv';

const cli = new Command({ name: 'tool', positionals: [{ name: 'file' }] });
console.log(cli.usage());
```

### help

```ts
help(programName?: string): string
```

Generate help text for this command.

The result includes usage, description, options, positional arguments, and
child commands when present. It never runs the command handler.

```ts
import { Command } from 'fino:process/argv';

const cli = new Command({ name: 'tool', description: 'Example CLI.' });
console.log(cli.help());
```
