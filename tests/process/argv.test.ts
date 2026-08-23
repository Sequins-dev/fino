/**
 * Tests for fino:process/argv — config-based nested command parsing and execution.
 */
import { describe, it } from 'fino:test/test';
import { Command, type CommandContext, type CommandInvocation } from 'fino:process/argv';
import { PromptSession } from 'fino:tty/prompt';
interface ParsedExecution {
  path: string[];
  args: Record<string, unknown>;
  options: Record<string, unknown>;
  positionals: unknown[];
}
class RecordingCommand extends Command {
  lastContext: CommandContext | null = null;
  lastChain: CommandInvocation[] | null = null;
  run(ctx: CommandContext): ParsedExecution {
    this.lastContext = ctx;
    this.lastChain = ctx.chain;
    return {
      path: ctx.path,
      args: ctx.args,
      options: ctx.options,
      positionals: ctx.positionals,
    };
  }
}
function requireContext(command: RecordingCommand): CommandContext {
  if (command.lastContext === null) throw new Error('Expected command context');
  return command.lastContext;
}
function requireChain(command: RecordingCommand): CommandInvocation[] {
  if (command.lastChain === null) throw new Error('Expected command chain');
  return command.lastChain;
}
function makeParser() {
  const http = new RecordingCommand({
    name: 'http',
    description: 'Serve HTTP traffic',
    options: [
      {
        flags: '--header',
        type: 'string',
        multiple: true,
        description: 'Attach response header',
      },
      {
        flags: '--tls',
        type: 'boolean',
        description: 'Enable TLS',
      },
    ],
    positionals: [
      {
        name: 'port',
        type: 'number',
        required: true,
        description: 'Listen port',
      },
      {
        name: 'files',
        type: 'string',
        multiple: true,
        description: 'Static files',
      },
    ],
  });
  const serve = new RecordingCommand({
    name: 'serve',
    description: 'Start a server',
    options: [
      {
        flags: '--host, -H',
        type: 'string',
        default: '127.0.0.1',
      },
      {
        flags: '--port, -p',
        type: 'number',
        required: true,
      },
      {
        flags: '--watch, -w',
        type: 'boolean',
      },
    ],
    positionals: [
      {
        name: 'entry',
        type: 'string',
        description: 'Entry module',
      },
    ],
    commands: [http],
  });
  const root = new RecordingCommand({
    description: 'Root command',
    options: [
      {
        flags: '--verbose, -v',
        type: 'boolean',
        description: 'Enable verbose mode',
      },
      {
        flags: '--config, -c',
        type: 'string',
      },
      {
        flags: '--tag, -t',
        type: 'string',
        multiple: true,
      },
      {
        flags: '--retries, -r',
        type: 'number',
        default: 1,
      },
    ],
    commands: [serve],
  });
  return {
    root,
    serve,
    http,
  };
}
describe('Command execution', () => {
  it('executes the matched root command with parsed options', (t) => {
    const { root } = makeParser();
    const result = root.parse([
      '--verbose',
      '--config=app.json',
      '--tag',
      'alpha',
      '--tag=beta',
    ]) as ParsedExecution;
    t.deepEqual(result.path, [], 'root execution path is empty');
    t.equal(result.options.verbose, true, 'boolean flag parsed');
    t.equal(result.options.config, 'app.json', 'string value parsed');
    t.deepEqual(result.options.tag, ['alpha', 'beta'], 'repeated option accumulates');
    t.equal(result.options.retries, 1, 'default applied');
    t.deepEqual(result.positionals, [], 'no root positionals');
    t.equal(requireContext(root).command, root, 'root run received root command');
  });
  it('constructs the command chain and executes the final command', (t) => {
    const { root, serve, http } = makeParser();
    const result = root.parse([
      '--verbose',
      'serve',
      '--port',
      '3000',
      '--watch',
      'http',
      '--header',
      'x-one: 1',
      '--tls',
      '8080',
      'index.ts',
      'about.ts',
    ]) as ParsedExecution;
    t.equal(root.lastContext, null, 'root run not called when a child matched');
    t.equal(serve.lastContext, null, 'intermediate run not called when a child matched');
    t.equal(requireContext(http).command, http, 'deepest command executed');
    t.deepEqual(result.path, ['serve', 'http'], 'final command path returned');
    t.equal(result.args.port, 8080, 'typed positional exposed by name');
    t.deepEqual(result.args.files, ['index.ts', 'about.ts'], 'rest positional exposed by name');
    t.equal(result.options.tls, true, 'final command options returned');
    t.deepEqual(
      result.positionals,
      [8080, 'index.ts', 'about.ts'],
      'final command positionals returned as typed values',
    );
    const httpChain = requireChain(http);
    t.equal(httpChain.length, 3, 'full chain was constructed');
    t.equal(httpChain[0]!.command, root, 'chain includes root');
    t.equal(httpChain[0]!.options.verbose, true, 'root options preserved');
    t.equal(httpChain[1]!.command, serve, 'chain includes serve');
    t.equal(httpChain[1]!.options.port, 3e3, 'serve options preserved');
    t.equal(httpChain[2]!.command, http, 'chain includes http');
    t.deepEqual(httpChain[2]!.options.header, ['x-one: 1'], 'http options preserved');
  });
  it('prefers a matching subcommand over parent positional capture', (t) => {
    const child = new RecordingCommand({
      name: 'deploy',
      positionals: [
        {
          name: 'env',
          type: 'string',
          required: true,
          description: 'Deployment environment',
        },
      ],
    });
    const root = new RecordingCommand({
      positionals: [
        {
          name: 'target',
          type: 'string',
          required: true,
          description: 'Fallback target',
        },
      ],
      commands: [child],
    });
    const result = root.parse(['deploy', 'prod']) as ParsedExecution;
    t.equal(root.lastContext, null, 'root positional was not consumed before child match');
    t.equal(requireContext(child).command, child, 'child command executed');
    t.deepEqual(result.path, ['deploy'], 'child command path returned');
    t.equal(result.args.env, 'prod', 'child positional was consumed by child');
  });
  it('parses grouped short flags and short options with values before execution', (t) => {
    const root = new RecordingCommand({
      options: [
        {
          flags: '--alpha, -a',
          type: 'boolean',
        },
        {
          flags: '--beta, -b',
          type: 'boolean',
        },
        {
          flags: '--count, -c',
          type: 'number',
        },
      ],
    });
    const result = root.parse(['-abc', '4']) as ParsedExecution;
    t.equal(result.options.alpha, true, 'short boolean a parsed');
    t.equal(result.options.beta, true, 'short boolean b parsed');
    t.equal(result.options.count, 4, 'last short option consumed next token as value');
  });
  it('supports boolean long negation with --no-flag', (t) => {
    const root = new RecordingCommand({
      options: [
        {
          flags: '--watch',
          type: 'boolean',
          default: true,
        },
        {
          flags: '--color',
          type: 'boolean',
        },
      ],
    });
    const result = root.parse(['--no-watch', '--color=false']) as ParsedExecution;
    t.equal(result.options.watch, false, 'boolean long option can be negated');
    t.equal(result.options.color, false, 'explicit boolean false still parses');
    t.equal(
      requireContext(root).optionProvided('watch'),
      true,
      'negated option is marked provided',
    );
  });
  it('supports an optional inline value without consuming a positional', (t) => {
    const root = new RecordingCommand({
      options: [
        {
          flags: '--coverage',
          type: 'string',
          implicitValue: 'coverage/coverage.json',
        },
      ],
      positionals: [{ name: 'file', type: 'string', required: true }],
    });
    const implicit = root.parse(['--coverage', 'tests/example.test.ts']) as ParsedExecution;
    const explicit = root.parse([
      '--coverage=artifacts/unit.json',
      'tests/example.test.ts',
    ]) as ParsedExecution;
    t.equal(
      implicit.options.coverage,
      'coverage/coverage.json',
      'bare long option uses its implicit value',
    );
    t.equal(
      implicit.args.file,
      'tests/example.test.ts',
      'bare long option leaves the following positional untouched',
    );
    t.equal(
      explicit.options.coverage,
      'artifacts/unit.json',
      'inline equals value overrides the implicit value',
    );
    t.equal(
      explicit.args.file,
      'tests/example.test.ts',
      'inline value leaves the positional untouched',
    );
  });
  it('rejects implicit values on boolean and short options', (t) => {
    t.throws(
      () =>
        new Command({
          options: [{ flags: '--enabled', type: 'boolean', implicitValue: 'yes' }],
        }),
      /Boolean options cannot define an implicit value/,
      'boolean implicit values are rejected',
    );
    t.throws(
      () =>
        new Command({
          options: [{ flags: '--coverage, -c', type: 'string', implicitValue: 'coverage.json' }],
        }),
      /cannot define a short flag/,
      'short optional values are rejected as ambiguous',
    );
  });
  it('supports multiple long and short aliases for one option key', (t) => {
    const root = new RecordingCommand({
      options: [
        {
          flags: '--environment, --env, -e, -E',
          type: 'string',
        },
      ],
    });
    const longAlias = root.parse(['--env', 'prod']) as ParsedExecution;
    const shortAlias = root.parse(['-E', 'stage']) as ParsedExecution;
    t.equal(longAlias.options.environment, 'prod', 'secondary long alias maps to primary long key');
    t.equal(
      shortAlias.options.environment,
      'stage',
      'secondary short alias maps to primary long key',
    );
  });
  it('validates choices for options and positionals', (t) => {
    const root = new RecordingCommand({
      options: [
        {
          flags: '--mode, -m',
          type: 'string',
          choices: ['dev', 'prod'],
        },
        {
          flags: '--count, -c',
          type: 'number',
          choices: [1, 2, 3],
        },
      ],
      positionals: [
        {
          name: 'target',
          type: 'string',
          choices: ['api', 'worker'],
          required: true,
        },
      ],
    });
    const result = root.parse(['--mode', 'prod', '--count=2', 'worker']) as ParsedExecution;
    const help = root.help();
    t.equal(result.options.mode, 'prod', 'string choice accepted');
    t.equal(result.options.count, 2, 'number choice accepted');
    t.equal(result.args.target, 'worker', 'positional choice accepted');
    t.ok(help.includes('--mode, -m {dev|prod}'), 'option choices are shown in help');
    t.ok(help.includes('target (string) {api|worker}'), 'positional choices are shown in help');
    t.throws(
      () => root.parse(['--mode', 'test', 'api']),
      /Invalid choice "test"/,
      'invalid string choice rejected',
    );
    t.throws(
      () => root.parse(['--count', '4', 'api']),
      /Invalid choice "4"/,
      'invalid number choice rejected',
    );
    t.throws(
      () => root.parse(['--mode', 'dev', 'web']),
      /Invalid choice "web"/,
      'invalid positional choice rejected',
    );
  });
  it('stops option parsing for the current command after --', (t) => {
    const { root, serve } = makeParser();
    const result = root.parse(['serve', '--port', '3000', '--', '--watch']) as ParsedExecution;
    t.equal(requireContext(serve).command, serve, 'serve executed');
    t.deepEqual(result.path, ['serve'], 'stayed on serve');
    t.equal(result.args.entry, '--watch', 'declared positional captured after stop marker');
    t.deepEqual(result.positionals, ['--watch'], 'remaining tokens stayed as serve positionals');
    t.equal(result.options.port, 3e3, 'parsed options before stop marker');
  });
  it('keeps unknown option-like tokens as positionals when configured', (t) => {
    const root = new RecordingCommand({
      allowUnknown: true,
      options: [
        {
          flags: '--verbose, -v',
          type: 'boolean',
        },
      ],
    });
    const result = root.parse(['--mystery', 'value', '--verbose']) as ParsedExecution;
    t.deepEqual(
      result.positionals,
      ['--mystery', 'value', '--verbose'],
      'unknown tokens remained positionals once unknown option was encountered',
    );
    t.equal(result.options.verbose, false, 'known options after passthrough are not parsed');
  });
  it('can pass --help through as a positional when configured', (t) => {
    const root = new RecordingCommand({
      allowHelp: false,
      allowUnknown: true,
      positionals: [
        {
          name: 'args',
          type: 'string',
          multiple: true,
        },
      ],
    });
    const result = root.parse(['--help', 'build', '--flag']) as ParsedExecution;
    t.deepEqual(
      result.args.args,
      ['--help', 'build', '--flag'],
      '--help was forwarded with the remaining delegated argv',
    );
  });
  it('renders command-local usage and help text', (t) => {
    const { root, serve, http } = makeParser();
    t.equal(root.usage('fino'), 'Usage: fino [options] [command]', 'root usage includes commands');
    t.equal(
      serve.usage('fino'),
      'Usage: fino serve [options] [entry] [command]',
      'nested usage includes declared positional',
    );
    const help = http.help('fino');
    t.ok(
      help.includes('Usage: fino serve http [options] <port> [files...]'),
      'help contains nested usage',
    );
    t.ok(help.includes('Serve HTTP traffic'), 'help contains command description');
    t.ok(help.includes('--header'), 'help lists command-local options');
    t.ok(help.includes('--tls'), 'help lists boolean options');
    t.ok(help.includes('Attach response header'), 'help includes option descriptions');
    t.ok(help.includes('Arguments:'), 'help includes positional section');
    t.ok(help.includes('port'), 'help lists required positional');
    t.ok(help.includes('number'), 'help shows positional type');
  });
  it('returns help output when --help is requested on the active command', (t) => {
    const { root } = makeParser();
    const rootHelp = root.parse(['--help']) as string;
    const childHelp = root.parse(['serve', '--help']) as string;
    t.ok(typeof rootHelp === 'string', 'root help returned as string');
    t.ok(rootHelp.includes('Usage:'), 'root help contains usage');
    t.ok(childHelp.includes('Usage:'), 'child help contains usage');
    t.ok(childHelp.includes('serve'), 'child help contains child command name');
    t.ok(childHelp.includes('[entry]'), 'child help contains child positional');
  });
  it('throws on unknown options by default', (t) => {
    const { root } = makeParser();
    t.throws(() => root.parse(['--nope']), /Unknown option/, 'unknown option rejected');
  });
  it('throws when a required option is missing', (t) => {
    const { root } = makeParser();
    t.throws(() => root.parse(['serve']), /Missing required option/, 'required option enforced');
  });
  it('throws when a required positional is missing', (t) => {
    const { root } = makeParser();
    t.throws(
      () => root.parse(['serve', '--port', '3000', 'http']),
      /Missing required positional/,
      'required positional enforced',
    );
  });
  it('does not require parent positionals when parsing descends into a child command', (t) => {
    const child = new RecordingCommand({
      name: 'test',
      positionals: [
        {
          name: 'file',
          type: 'string',
          required: true,
        },
      ],
    });
    const root = new RecordingCommand({
      positionals: [
        {
          name: 'script',
          type: 'string',
          required: true,
        },
      ],
      commands: [child],
    });
    const result = root.parse(['test', 'suite.test.ts']) as ParsedExecution;
    t.deepEqual(result.path, ['test'], 'child command still matched');
    t.equal(result.args.file, 'suite.test.ts', 'child positional parsed');
  });
  it('throws on invalid numeric values', (t) => {
    const { root } = makeParser();
    t.throws(() => root.parse(['--retries', 'abc']), /Invalid value/, 'invalid numbers rejected');
  });
  it('exposes a prompt session on the command context', async (t) => {
    const prompts: string[] = [];
    const root = new Command({
      async run(ctx: CommandContext) {
        const value = await ctx.prompt.text({
          label: 'Project name',
          defaultValue: 'demo',
        });
        prompts.push(value);
        return value;
      },
    });
    const prompt = new PromptSession({
      isInteractive: true,
      async readLine() {
        return 'from-prompt';
      },
      async write() {},
      async writeError() {},
    });
    const result = await root.parse([], { prompt });
    t.equal(result, 'from-prompt', 'run handler can await ctx.prompt');
    t.deepEqual(prompts, ['from-prompt'], 'prompt result was delivered to command');
  });
  it('resolves async option defaults before run and tracks whether an option was provided', async (t) => {
    const root = new Command({
      options: [
        {
          flags: '--name',
          type: 'string',
          default: async function defaultName() {
            return 'resolved-default';
          },
        },
      ],
      async run(ctx) {
        return {
          name: ctx.options.name,
          provided: ctx.optionProvided('name'),
        };
      },
    });
    const withDefault = (await root.parse([])) as {
      name: string;
      provided: boolean;
    };
    const withFlag = (await root.parse(['--name', 'explicit'])) as {
      name: string;
      provided: boolean;
    };
    t.equal(withDefault.name, 'resolved-default', 'async default resolved into options');
    t.equal(withDefault.provided, false, 'defaulted option is not marked provided');
    t.equal(withFlag.name, 'explicit', 'explicit option wins over default');
    t.equal(withFlag.provided, true, 'explicit option is marked provided');
  });
});
