# argv

fino:process/argv — config-based argv parser with nested command execution.

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

### name

```ts
name?: string
```

### description

```ts
description?: string
```

### allowUnknown

```ts
allowUnknown?: boolean
```

### run

```ts
run?: (ctx: CommandContext) => unknown
```

### options

```ts
options?: OptionConfig[]
```

### positionals

```ts
positionals?: PositionalConfig[]
```

### commands

```ts
commands?: Array<Command | CommandConfig>
```

## OptionConfig

```ts
interface OptionConfig {
```

Command-line option definition, including flags, type, multiplicity, and defaults.

### flags

```ts
flags: string
```

### type

```ts
type?: 'boolean' | 'string' | 'number'
```

### multiple

```ts
multiple?: boolean
```

### required

```ts
required?: boolean
```

### description

```ts
description?: string
```

### default

```ts
default?: OptionDefault
```

## PositionalConfig

```ts
interface PositionalConfig {
```

Positional argument definition for a command.

### name

```ts
name: string
```

### type

```ts
type?: 'string' | 'number'
```

### required

```ts
required?: boolean
```

### multiple

```ts
multiple?: boolean
```

### description

```ts
description?: string
```

## CommandContext

```ts
interface CommandContext {
```

Runtime context passed to a command handler.

### command

```ts
command: Command
```

### invocation

```ts
invocation: CommandInvocation
```

### parent

```ts
parent: CommandInvocation | null
```

### root

```ts
root: CommandInvocation
```

### path

```ts
path: string[]
```

### args

```ts
args: Record<string, unknown>
```

### options

```ts
options: Record<string, unknown>
```

### positionals

```ts
positionals: unknown[]
```

### chain

```ts
chain: CommandInvocation[]
```

### prompt

```ts
prompt: PromptSession
```

### providedOptions

```ts
providedOptions: Set<string>
```

### optionProvided

```ts
optionProvided(key: string): boolean
```

## CommandInvocation

```ts
class CommandInvocation {
```

Parsed invocation node for one command in a nested command chain.

### command

```ts
command: Command
```

### parent

```ts
parent: CommandInvocation | null
```

### args

```ts
args: Record<string, unknown>
```

### options

```ts
options: Record<string, unknown>
```

### positionals

```ts
positionals: unknown[]
```

### providedOptions

```ts
providedOptions: Set<string>
```

### constructor

```ts
constructor(command: Command, parent: CommandInvocation | null, args: Record<string, unknown>, options: Record<string, unknown>, positionals: unknown[], providedOptions: Set<string>)
```

### name

```ts
get name(): string | null
```

### path

```ts
get path(): string[]
```

## Command

```ts
class Command {
```

Config-based command with nested subcommands, options, and positionals.

### constructor

```ts
constructor(config: CommandConfig = {})
```

### name

```ts
get name(): string | null
```

### description

```ts
get description(): string | undefined
```

### parent

```ts
get parent(): Command | null
```

### parse

```ts
parse(argv: string[], options: ParseOptions = {}): unknown
```

### run

```ts
run(ctx: CommandContext): unknown
```

### usage

```ts
usage(programName?: string): string
```

### help

```ts
help(programName?: string): string
```
