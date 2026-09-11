/**
 * internal:scheduler/bootstrap — CLI bootstrap workload.
 *
 * The native process host submits this module as the initial reactor workload.
 * This workload reads the process arguments itself; CLI parsing, command
 * selection, execution, output, and shutdown hooks all happen here on the
 * worker pool.
 *
 * @internal
 */
import { beginProcessProfiling, finishProcessProfiling } from 'internal:process-profiler';
import root from '../../commands/root.ts';
import { argv, exit } from '../../process.ts';
import { runShutdownHooks } from '../shutdown.ts';
import { runLauncher } from '../security/sandbox/launcher.ts';
import { finishCoverage } from 'internal:coverage';
import type { CoverageMetric, CoverageSummary } from 'internal:coverage/model';

const nonRunCommands = new Set([
  'test',
  'coverage',
  'bench',
  'load',
  'install',
  'init',
  'doc',
  'fmt',
  'lint',
  'task',
  'repl',
]);

function scanOptionPrefix(args: string[], start: number) {
  let profile = false;
  for (let index = start; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') return { profile, positional: undefined, next: args.length };
    if (argument === '--profile') {
      profile = true;
      continue;
    }
    if (argument === '--otlp-endpoint') {
      index++;
      continue;
    }
    if (argument.startsWith('-')) continue;
    return { profile, positional: argument, next: index + 1 };
  }
  return { profile, positional: undefined, next: args.length };
}

/** Detect the run flag before creating the CLI workload Realm. */
function processProfileRequested(args: string[]): boolean {
  const root = scanOptionPrefix(args, 0);
  if (root.positional === 'run') {
    const run = scanOptionPrefix(args, root.next);
    return run.positional !== undefined && (root.profile || run.profile);
  }
  if (root.positional === undefined || nonRunCommands.has(root.positional)) return false;
  return root.profile;
}

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
const profileRequested = processProfileRequested(cliArgv);
if (profileRequested) beginProcessProfiling();
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
try {
  const summary = await finishCoverage();
  if (summary !== null && !wantsJson) console.log(coverageComments(summary));
} catch (error) {
  if (commandError === undefined) commandError = error;
  else console.error(`[coverage] ${error instanceof Error ? error.message : String(error)}`);
}
if (profileRequested) {
  try {
    const profile = finishProcessProfiling();
    const { DiskFileSystem } = await import('../../file/fs.ts');
    await new DiskFileSystem().writeFile('profile.pb', profile);
  } catch (error) {
    commandError ??= error;
  }
}
if (commandError !== undefined) throw commandError;
