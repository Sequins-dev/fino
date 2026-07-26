/**
 * internal:scheduler/command — CLI command workload.
 *
 * The process main realm can schedule this module like any other workload.
 * CLI parsing, command execution, output, and shutdown hooks then run on a pool
 * worker rather than giving the orchestration realm application duties.
 * Commands that still require embedded realms or completion-backed operations
 * remain on the orchestration realm during this migration.
 *
 * @internal
 */
import root from '../../commands/root.ts';
import { runShutdownHooks } from '../shutdown.ts';

interface CommandInput {
  args: string[];
}

function normalizeCliArgv(args: string[]): string[] {
  if (args[0] === '--bench') return ['bench', ...args.slice(1)];
  return args;
}

/**
 * Parse and execute one CLI invocation, then drain command-realm shutdown hooks.
 *
 * @internal
 */
export default async function runCommand(input: CommandInput): Promise<null> {
  const cliArgv = normalizeCliArgv(input.args);
  const wantsJson = cliArgv.includes('--json');
  let commandError: unknown;
  try {
    const result = await root.parse(
      cliArgv,
      wantsJson
        ? {
            outputMode: 'json',
            writer: {
              mode: 'json',
              writeJson(value) {
                console.log(JSON.stringify(value));
              },
            },
          }
        : {},
    );
    if (typeof result === 'string' && result.length > 0) console.log(result);
  } catch (error) {
    commandError = error;
  }
  try {
    await runShutdownHooks();
  } catch (error) {
    commandError ??= error;
  }
  if (commandError !== undefined) throw commandError;
  return null;
}
