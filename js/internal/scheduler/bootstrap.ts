/**
 * internal:scheduler/bootstrap — CLI bootstrap workload.
 *
 * The process main realm submits this module as the initial reactor workload.
 * This workload reads the process arguments itself; CLI parsing, command
 * selection, execution, output, and shutdown hooks all happen here on the
 * worker pool.
 *
 * @internal
 */
import root from '../../commands/root.ts';
import { argv, exit } from '../../process.ts';
import { runShutdownHooks } from '../shutdown.ts';
import { runLauncher } from '../security/sandbox/launcher.ts';

function normalizeCliArgv(args: string[]): string[] {
  if (args[0] === '--bench') return ['bench', ...args.slice(1)];
  return args;
}

if (argv[1] === '--sandbox-launcher') {
  const fd = Number(argv[2]);
  if (!Number.isInteger(fd) || fd < 0) {
    console.error('fino: --sandbox-launcher requires a valid file descriptor');
    exit(1);
  }
  runLauncher(fd);
}
const cliArgv = normalizeCliArgv(argv.slice(1));
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
