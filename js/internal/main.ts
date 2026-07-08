/**
* internal:main — root realm CLI entry point.
*
* This is the module the Rust runtime evaluates to start the process. It is a
* pure entry point: importing it has no exported surface, only side effects. It
* wires the shared realm bootstrap (globals, module loader, source-map stack
* trace formatter) to the CLI command tree, parses `argv`, runs the selected
* command, and drives the host event loop until the command and its shutdown
* hooks have both settled.
*
* Only the root Realm evaluates this module. Child Realms evaluate
* `internal:bootstrap` directly and then import their own entry module, so none
* of the CLI parsing, shutdown-hook, or child-stepping logic here runs inside a
* child.
*
* Startup order matters. Before any CLI parsing, the module checks for
* self-sandboxing launcher mode (`fino --sandbox-launcher <fd>`): in that mode
* the process applies OS sandbox policy to itself over FFI and `execve()`s the
* target, so `runLauncher` either replaces the process image or hard-exits and
* never returns to the code below. Argv is then normalized (`--bench` is
* rewritten to the `bench` subcommand, and a leading `--json` switches the
* command writer into JSON output mode) and handed to the root command's
* `parse`. The result string, if any, is printed; a thrown command error is
* captured and re-raised after the loop drains.
*
* The event loop is driven through `driveLoop` from the bootstrap. The done
* predicate first waits for the command promise to settle, then kicks off
* shutdown hooks exactly once and only reports the loop finished after those
* hooks resolve, guaranteeing cleanup runs before exit. `fino:realm` is imported
* lazily so the root loop can also step and observe liveness of any child Realms
* that were created, without hard-depending on the realm module being
* registered (during tests it may not be).
*
* ```ts no_run
* import 'internal:main';
* ```
*
* @internal
*/
import { argv, exit } from '../process.ts';
import { driveLoop } from 'internal:bootstrap';
import { runLauncher } from './security/sandbox/launcher.ts';
// Self-sandboxing launcher mode: `fino --sandbox-launcher <fd>`. This process
// applies OS policy to itself over FFI and execve()s the target. It must run
// before any CLI parsing or event-loop setup. runLauncher never returns on
// success (the image is replaced) and hard-exits on failure, so control never
// reaches the CLI code below.
if (argv[1] === '--sandbox-launcher') {
  const fd = Number(argv[2]);
  if (!Number.isInteger(fd) || fd < 0) {
    console.error('fino: --sandbox-launcher requires a valid file descriptor');
    exit(1);
  }
  runLauncher(fd);
}
import root from '../commands/root.ts';
import { runShutdownHooks } from './shutdown.ts';
// Child-realm stepping needs no wiring here: fino:realm registers its
// steppers with the bootstrap (_registerChildSteppers) when imported, in
// every realm alike.
function normalizeCliArgv(args: string[]): string[] {
  if (args[0] === '--bench') return ['bench', ...args.slice(1)];
  return args;
}
let done = false;
let caughtError: unknown = null;
let shutdownStarted = false;
let shutdownDone = false;
const cliArgv = normalizeCliArgv(argv.slice(1));
const wantsJson = cliArgv.includes('--json');
Promise.resolve(root.parse(cliArgv, wantsJson ? {
  outputMode: 'json',
  writer: {
    mode: 'json',
    writeJson(value) {
      console.log(JSON.stringify(value));
    }
  }
} : {})).then(function onCommandDone(result) {
  if (typeof result === 'string' && result.length > 0) console.log(result);
  done = true;
}, function onCommandError(err) {
  caughtError = err;
  done = true;
});
function startShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.resolve(runShutdownHooks()).then(function onShutdownDone() {
    shutdownDone = true;
  }, function onShutdownError(err) {
    if (caughtError === null) caughtError = err;
    shutdownDone = true;
  });
}
driveLoop(function isDone() {
  if (done && !shutdownStarted) startShutdown();
  return done && shutdownDone;
}, function onCliLoopDone() {
  if (caughtError) {
    console.error(caughtError);
    exit(1);
  }
});
