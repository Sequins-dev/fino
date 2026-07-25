/**
* fino:commands/root — reusable root Fino command task.
*
* Composes the top-level `fino` command from the built-in subcommand tasks —
* `run`, `test`, `bench`, `install`, `init`, `doc`, `fmt`, `lint`, `task`,
* and `repl` — and layers the shorthand behavior on top: `fino <script>`
* executes the script directly (delegating to `fino:commands/run`), and bare
* `fino` with no arguments starts the interactive REPL.
*
* Option parsing stops after the first positional, so flags that follow the
* script path (`fino app.ts --port 8080`) are forwarded to the script as its
* own arguments instead of being consumed by the CLI.
*
* The runtime entry module (`internal:main`) drives the whole CLI by parsing
* `argv` through this task; embedders and tests can invoke the same surface
* programmatically with `parse()` or `run()`.
*
* ```ts no_run
* import root from 'fino:commands/root';
*
* // Equivalent to `fino test tests/ffi.test.ts` on the command line.
* await root.parse(['test', 'tests/ffi.test.ts']);
*
* // Shorthand: run a script directly; trailing flags go to the script.
* await root.parse(['app.ts', '--port', '8080']);
* ```
*/
import { Task } from '../task.ts';
import testCommand from './test.ts';
import benchCommand from './bench.ts';
import installCommand from './install.ts';
import initCommand from './init.ts';
import docCommand from './doc.ts';
import fmtCommand from './fmt.ts';
import lintCommand from './lint.ts';
import replCommand from './repl.ts';
import runCommand from './run.ts';
import taskCommand from './task.ts';
/**
* The root `fino` CLI command.
*
* A `Task` named `fino` whose children are the built-in subcommands. The root
* itself declares two options that apply to direct script execution:
* `--watch` re-runs the script whenever any imported file changes, and
* `--otlp-endpoint` enables OpenTelemetry export to the given OTLP/HTTP
* collector endpoint.
*
* When parsing does not match a subcommand, the root's own run function takes
* over: with a `script` positional it delegates to the `run` command, and with
* no arguments at all it hands the same execution context (signal, writer,
* env, cwd, prompt, provided options) to the `repl` command and starts the
* interactive REPL.
*
* ```ts no_run
* import root from 'fino:commands/root';
*
* await root.parse(['run', 'example.ts']); // explicit subcommand
* await root.parse(['example.ts']);        // shorthand, same effect
* await root.parse([]);                    // starts the REPL
* ```
*/
const command = new Task({
    name: 'fino',
    description: 'Fino runtime CLI',
    outputMode: 'text',
    cli: {
      stopOptionsAfterPositionals: true,
      options: [{
        flags: '--otlp-endpoint',
        type: 'string',
        description: 'Enable OpenTelemetry export to the given OTLP/HTTP collector endpoint'
      }, {
        flags: '--watch',
        type: 'boolean',
        description: 'Re-run the script whenever any imported file changes'
      }],
      positionals: [{
        name: 'script',
        type: 'string',
        description: 'Script module to execute'
      }, {
        name: 'args',
        type: 'string',
        multiple: true,
        description: 'Arguments passed to the script'
      }]
    },
    run: async function runRootCommand(input, ctx) {
      const script = (input as {
        script?: unknown;
      }).script;
      if (script === undefined) return replCommand.run({}, {
        signal: ctx.signal,
        runId: ctx.runId,
        writer: ctx.writer,
        env: ctx.env,
        cwd: ctx.cwd,
        prompt: ctx.prompt,
        providedOptions: ctx.providedOptions
      });
      return runCommand.run(input as Record<string, unknown>, {
        signal: ctx.signal,
        runId: ctx.runId,
        writer: ctx.writer,
        env: ctx.env,
        cwd: ctx.cwd,
        prompt: ctx.prompt,
        providedOptions: ctx.providedOptions
      });
    },
    children: [
      runCommand,
      testCommand,
      benchCommand,
      installCommand,
      initCommand,
      docCommand,
      fmtCommand,
      lintCommand,
      taskCommand,
      replCommand
    ]
});
export { command as default };
