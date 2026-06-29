/**
 * internal/main.mts — Root realm CLI entry point.
 *
 * This is the entry module evaluated by the Rust runtime for the root Realm.
 * It imports the shared realm bootstrap (which sets up globals, the module
 * loader, and the source-map stack trace formatter), then runs the CLI command
 * infrastructure and drives the event loop.
 *
 * Child Realms do NOT evaluate this module — they evaluate `internal/bootstrap.mts`
 * directly and then import their own entry module.
 *
 * ```js
 * import 'internal:main';
 * ```
 *
 * @internal
 */

import { argv, exit } from '../process.mts';
import { driveLoop } from 'internal:bootstrap';
import { createRootCommand } from './commands/root.mts';
import { runShutdownHooks } from './shutdown.mts';

// Imported lazily to avoid a hard dependency that breaks when fino:realm is
// not yet loaded. _stepChildren and _childrenAlive default to no-ops so the
// root realm's driveLoop works even before any Realm is created.
let _stepChildren: (() => void) | undefined;
let _childrenAlive: (() => boolean) | undefined;
import('fino:realm').then(
  function onRealmLoaded(m) {
    _stepChildren = m._stepChildren as () => void;
    _childrenAlive = m._childrenAlive as () => boolean;
  },
  function _ignore() {
    // fino:realm not registered yet during tests — safe to ignore
  },
);

function normalizeCliArgv(args: string[]): string[] {
  if (args[0] === '--bench') return ['bench', ...args.slice(1)];
  return args;
}

const root = createRootCommand();
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
    },
  },
} : {})).then(
  function onCommandDone(result) {
    if (typeof result === 'string' && result.length > 0) console.log(result);
    done = true;
  },
  function onCommandError(err) {
    caughtError = err;
    done = true;
  },
);

function startShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.resolve(runShutdownHooks()).then(
    function onShutdownDone() {
      shutdownDone = true;
    },
    function onShutdownError(err) {
      if (caughtError === null) caughtError = err;
      shutdownDone = true;
    },
  );
}

driveLoop(
  function isDone() {
    if (done && !shutdownStarted) startShutdown();
    return done && shutdownDone;
  },
  function onCliLoopDone() {
    if (caughtError) {
      console.error(caughtError);
      exit(1);
    }
  },
  {
    stepChildren: function stepChildren() { _stepChildren?.(); },
    childrenAlive: function childrenAlive() { return _childrenAlive?.() ?? false; },
  },
);
