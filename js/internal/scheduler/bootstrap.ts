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
import { finishCoverage } from 'internal:coverage';
import type { CoverageMetric, CoverageSummary } from 'internal:coverage/model';

function coverageComments(summary: CoverageSummary): string {
  const metric = (name: string, value: CoverageMetric) =>
    `#   ${name.padEnd(10)} ${value.percent.toFixed(2)}% (${value.covered}/${value.total})`;
  return [
    '# coverage',
    metric('lines', summary.totals.lines),
    metric('branches', summary.totals.branches),
    metric('functions', summary.totals.functions),
    `#   realms     ${summary.realmCount - summary.incompleteRealmCount} complete, ${summary.incompleteRealmCount} incomplete`,
    `#   report     ${summary.path}`,
  ].join('\n');
}

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
/**
 * Whether the command failed, kept apart from what it failed with.
 *
 * `throw undefined` is legal, so a rejection value cannot double as the flag: treating
 * `undefined` as "no error" makes a command that failed with one look like a command
 * that succeeded, and the failure never reaches the caller.
 */
let commandFailed = false;
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
  commandFailed = true;
}
try {
  await runShutdownHooks();
} catch (error) {
  if (!commandFailed) commandError = error;
  commandFailed = true;
}
try {
  const summary = await finishCoverage();
  if (summary !== null && !wantsJson) console.log(coverageComments(summary));
} catch (error) {
  if (!commandFailed) {
    commandError = error;
    commandFailed = true;
  }
  else console.error(`[coverage] ${error instanceof Error ? error.message : String(error)}`);
}
if (commandFailed) throw commandError;
