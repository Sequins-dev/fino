/**
 * internal:main — thin TypeScript orchestration entry point.
 *
 * The main OS thread owns the process readiness backend and scheduling policy.
 * Every CLI invocation runs in an ordinary workload isolate on the worker pool.
 * This realm only starts that pool, operates the readiness loop, and routes
 * readiness completions back to owner-tagged workloads. Rust only pumps this
 * orchestration realm and performs isolate transitions requested by it.
 *
 * @internal
 */
import { argv, exit } from '../process.ts';
import { driveLoop } from 'internal:bootstrap';
import { beginProcessProfiling, finishProcessProfiling } from 'internal:process-profiler';
import { processReadinessControlFd } from 'internal:scheduler-native';
import { runReactorPool } from 'internal:scheduler/readiness';
import {
  installProcessReadinessController,
  ProcessReadinessController,
} from 'internal:scheduler/reactor';

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
    const argument = args[index];
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

let done = false;
/**
 * Whether the command failed, kept apart from what it failed with.
 *
 * `throw undefined` is legal, and a rejection carries whatever was thrown — so using
 * the error value as the flag makes a command that fails with `undefined` look exactly
 * like one that succeeded. That is not hypothetical: an unresolved module specifier
 * rejected with `undefined`, and a whole test run reported success having executed
 * nothing at all.
 */
let failed = false;
let caughtError: unknown;
const profileRequested = processProfileRequested(argv.slice(1));
if (profileRequested) beginProcessProfiling();
const readiness = new ProcessReadinessController(processReadinessControlFd());
installProcessReadinessController(readiness);
readiness.start();
const command = runReactorPool('internal:scheduler/bootstrap');

async function settleCommand(error?: unknown, commandFailed = false): Promise<void> {
  caughtError = error;
  failed = commandFailed;
  if (profileRequested) {
    try {
      const profile = finishProcessProfiling();
      const { DiskFileSystem } = await import('../file/fs.ts');
      await new DiskFileSystem().writeFile('profile.pb', profile);
    } catch (profileError) {
      if (!failed) {
        caughtError = profileError;
        failed = true;
      }
      else
        console.error(
          `[profile] ${profileError instanceof Error ? profileError.message : String(profileError)}`,
        );
    }
  }
  readiness.stop();
  done = true;
}

void command.then(
  function onCommandDone() {
    return settleCommand();
  },
  function onCommandError(error) {
    return settleCommand(error, true);
  },
);

driveLoop(
  function isDone() {
    return done;
  },
  function onMainLoopDone() {
    if (failed) {
      // Something was thrown, but not necessarily anything worth printing. Say so
      // rather than printing `undefined` and leaving the reader no better off.
      console.error(caughtError ?? new Error('the command failed without an error value'));
      exit(1);
    }
  },
);
