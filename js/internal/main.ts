/**
 * internal:main — thin TypeScript orchestration entry point.
 *
 * The main OS thread owns the process readiness backend and scheduling policy.
 * Readiness-only CLI work runs in an ordinary workload isolate on the worker
 * pool. Commands that still depend on embedded child realms or completion-
 * backed io_uring operations temporarily execute in this realm until those
 * operations can be submitted as first-class pool workloads. Rust only pumps
 * this orchestration realm and performs isolate transitions requested by it.
 *
 * Self-sandboxing launcher mode remains here because it must replace the
 * process image before any worker threads exist.
 *
 * @internal
 */
import { argv, exit } from '../process.ts';
import { driveLoop } from 'internal:bootstrap';
import { processReadinessControlFd } from 'internal:scheduler-native';
import { runPooledResidentReadinessWorkloadsAsync } from 'internal:scheduler/readiness';
import {
  installProcessReadinessController,
  ProcessReadinessController,
} from 'internal:scheduler/reactor';
import runCommand from 'internal:scheduler/command';
import { runLauncher } from './security/sandbox/launcher.ts';

if (argv[1] === '--sandbox-launcher') {
  const fd = Number(argv[2]);
  if (!Number.isInteger(fd) || fd < 0) {
    console.error('fino: --sandbox-launcher requires a valid file descriptor');
    exit(1);
  }
  runLauncher(fd);
}

let done = false;
let caughtError: unknown;
const readiness = new ProcessReadinessController(processReadinessControlFd());
installProcessReadinessController(readiness);
readiness.start();
const commandInput = {
  args: argv.slice(1),
};
const pooledCommand = argv[1] === '--help';
const command = pooledCommand
  ? runPooledResidentReadinessWorkloadsAsync<null>('internal:scheduler/command', [
      commandInput,
    ]).then(() => null)
  : runCommand(commandInput);
void command.then(
  function onCommandDone() {
    readiness.stop();
    done = true;
  },
  function onCommandError(error) {
    readiness.stop();
    caughtError = error;
    done = true;
  },
);

let stepChildren: (() => void) | undefined;
let childrenAlive: (() => boolean) | undefined;
void import('fino:realm').then(
  (realm) => {
    stepChildren = realm._stepChildren as () => void;
    childrenAlive = realm._childrenAlive as () => boolean;
  },
  () => {},
);

driveLoop(
  function isDone() {
    return done;
  },
  function onMainLoopDone() {
    if (caughtError !== undefined) {
      console.error(caughtError);
      exit(1);
    }
  },
  {
    stepChildren() {
      stepChildren?.();
    },
    childrenAlive() {
      return childrenAlive?.() ?? false;
    },
  },
);
