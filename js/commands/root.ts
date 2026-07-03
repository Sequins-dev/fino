/**
* fino:commands/root — reusable root Fino command task.
*
* Composes the top-level `fino` command and all built-in subcommands. The root
* command also preserves the legacy behavior where `fino <script>` runs a
* script directly and bare `fino` starts the REPL.
*
* ```js
* import rootCommand from 'fino:commands/root';
* const root = rootCommand;
* console.log(root.name);
* ```
*
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
* Create the root CLI command.
*
* The returned command includes shared root options such as `--watch` and
* `--otlp-endpoint`, direct script execution, and the registered `run`, `test`,
* `bench`, `install`, `init`, `doc`, and `repl` subcommands. If parsing reaches
* the root without a script argument, the command starts the interactive REPL.
*
* ```js
* import root from 'fino:commands/root';
* await root.parse(['run', 'example.ts']);
* ```
*
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
