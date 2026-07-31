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
import { exit } from '../process.ts';
import { driveLoop } from 'internal:bootstrap';
import { processReadinessControlFd } from 'internal:scheduler-native';
import { runReactorPool } from 'internal:scheduler/readiness';
import {
  installProcessReadinessController,
  ProcessReadinessController,
} from 'internal:scheduler/reactor';

let done = false;
let caughtError: unknown;
const readiness = new ProcessReadinessController(processReadinessControlFd());
installProcessReadinessController(readiness);
readiness.start();
const command = runReactorPool('internal:scheduler/bootstrap');
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
);
