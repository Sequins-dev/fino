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
      { flags: '--header', type: 'string', multiple: true, description: 'Attach response header' },
      { flags: '--tls', type: 'boolean', description: 'Enable TLS' },
    ],
    positionals: [
      { name: 'port', type: 'number', required: true, description: 'Listen port' },
      { name: 'files', type: 'string', multiple: true, description: 'Static files' },
    ],
  });

  const serve = new RecordingCommand({
    name: 'serve',
    description: 'Start a server',
    options: [
      { flags: '--host, -H', type: 'string', default: '127.0.0.1' },
      { flags: '--port, -p', type: 'number', required: true },
      { flags: '--watch, -w', type: 'boolean' },
    ],
    positionals: [
      { name: 'entry', type: 'string', description: 'Entry module' },
    ],
    commands: [http],
  });

  const root = new RecordingCommand({
    description: 'Root command',
    options: [
      { flags: '--verbose, -v', type: 'boolean', description: 'Enable verbose mode' },
      { flags: '--config, -c', type: 'string' },
      { flags: '--tag, -t', type: 'string', multiple: true },
      { flags: '--retries, -r', type: 'number', default: 1 },
    ],
    commands: [serve],
  });

  return { root, serve, http };
}

describe('Command execution', () => {
  it('executes the matched root command with parsed options', (t) => {
    const { root } = makeParser();

    const result = root.parse(['--verbose', '--config=app.json', '--tag', 'alpha', '--tag=beta']) as ParsedExecution;

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
      '--port', '3000',
      '--watch',
      'http',
      '--header', 'x-one: 1',
      '--tls',
      '8080',
      'index.mts',
      'about.mts',
    ]) as ParsedExecution;

    t.equal(root.lastContext, null, 'root run not called when a child matched');
    t.equal(serve.lastContext, null, 'intermediate run not called when a child matched');
    t.equal(requireContext(http).command, http, 'deepest command executed');
    t.deepEqual(result.path, ['serve', 'http'], 'final command path returned');
    t.equal(result.args.port, 8080, 'typed positional exposed by name');
    t.deepEqual(result.args.files, ['index.mts', 'about.mts'], 'rest positional exposed by name');
    t.equal(result.options.tls, true, 'final command options returned');
    t.deepEqual(result.positionals, [8080, 'index.mts', 'about.mts'], 'final command positionals returned as typed values');
    const httpChain = requireChain(http);
    t.equal(httpChain.length, 3, 'full chain was constructed');
    t.equal(httpChain[0]!.command, root, 'chain includes root');
    t.equal(httpChain[0]!.options.verbose, true, 'root options preserved');
    t.equal(httpChain[1]!.command, serve, 'chain includes serve');
    t.equal(httpChain[1]!.options.port, 3000, 'serve options preserved');
    t.equal(httpChain[2]!.command, http, 'chain includes http');
    t.deepEqual(httpChain[2]!.options.header, ['x-one: 1'], 'http options preserved');
  });

  it('prefers a matching subcommand over parent positional capture', (t) => {
    const child = new RecordingCommand({
      name: 'deploy',
      positionals: [{ name: 'env', type: 'string', required: true, description: 'Deployment environment' }],
    });
    const root = new RecordingCommand({
      positionals: [{ name: 'target', type: 'string', required: true, description: 'Fallback target' }],
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
        { flags: '--alpha, -a', type: 'boolean' },
        { flags: '--beta, -b', type: 'boolean' },
        { flags: '--count, -c', type: 'number' },
      ],
    });

    const result = root.parse(['-abc', '4']) as ParsedExecution;

    t.equal(result.options.alpha, true, 'short boolean a parsed');
    t.equal(result.options.beta, true, 'short boolean b parsed');
    t.equal(result.options.count, 4, 'last short option consumed next token as value');
  });

  it('stops option parsing for the current command after --', (t) => {
    const { root, serve } = makeParser();

    const result = root.parse(['serve', '--port', '3000', '--', '--watch']) as ParsedExecution;

    t.equal(requireContext(serve).command, serve, 'serve executed');
    t.deepEqual(result.path, ['serve'], 'stayed on serve');
    t.equal(result.args.entry, '--watch', 'declared positional captured after stop marker');
    t.deepEqual(result.positionals, ['--watch'], 'remaining tokens stayed as serve positionals');
    t.equal(result.options.port, 3000, 'parsed options before stop marker');
  });

  it('keeps unknown option-like tokens as positionals when configured', (t) => {
    const root = new RecordingCommand({
      allowUnknown: true,
      options: [{ flags: '--verbose, -v', type: 'boolean' }],
    });

    const result = root.parse(['--mystery', 'value', '--verbose']) as ParsedExecution;

    t.deepEqual(result.positionals, ['--mystery', 'value', '--verbose'], 'unknown tokens remained positionals once unknown option was encountered');
    t.equal(result.options.verbose, false, 'known options after passthrough are not parsed');
  });

  it('renders command-local usage and help text', (t) => {
    const { root, serve, http } = makeParser();

    t.equal(root.usage('fino'), 'Usage: fino [options] [command]', 'root usage includes commands');
    t.equal(serve.usage('fino'), 'Usage: fino serve [options] [entry] [command]', 'nested usage includes declared positional');

    const help = http.help('fino');

    t.ok(help.includes('Usage: fino serve http [options] <port> [files...]'), 'help contains nested usage');
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
    t.throws(() => root.parse(['serve', '--port', '3000', 'http']), /Missing required positional/, 'required positional enforced');
  });

  it('does not require parent positionals when parsing descends into a child command', (t) => {
    const child = new RecordingCommand({
      name: 'test',
      positionals: [{ name: 'file', type: 'string', required: true }],
    });
    const root = new RecordingCommand({
      positionals: [{ name: 'script', type: 'string', required: true }],
      commands: [child],
    });

    const result = root.parse(['test', 'suite.test.mts']) as ParsedExecution;

    t.deepEqual(result.path, ['test'], 'child command still matched');
    t.equal(result.args.file, 'suite.test.mts', 'child positional parsed');
  });

  it('throws on invalid numeric values', (t) => {
    const { root } = makeParser();
    t.throws(() => root.parse(['--retries', 'abc']), /Invalid value/, 'invalid numbers rejected');
  });

  it('exposes a prompt session on the command context', async (t) => {
    const prompts: string[] = [];
    const root = new Command({
      async run(ctx: CommandContext) {
        const value = await ctx.prompt.text({ label: 'Project name', defaultValue: 'demo' });
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

    const withDefault = await root.parse([]) as { name: string; provided: boolean };
    const withFlag = await root.parse(['--name', 'explicit']) as { name: string; provided: boolean };

    t.equal(withDefault.name, 'resolved-default', 'async default resolved into options');
    t.equal(withDefault.provided, false, 'defaulted option is not marked provided');
    t.equal(withFlag.name, 'explicit', 'explicit option wins over default');
    t.equal(withFlag.provided, true, 'explicit option is marked provided');
  });
});
