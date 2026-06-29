/**
* internal/commands/root — internal runtime module.
*
* Composes the top-level `fino` command and all built-in subcommands. The root
* command also preserves the legacy behavior where `fino <script>` runs a
* script directly and bare `fino` starts the REPL.
*
* ```js
* import { createRootCommand } from 'internal:commands/root';
* const root = createRootCommand();
* console.log(root.name);
* ```
*
* @internal
*/
import { Task } from '../../task.ts';
import { createTestCommand } from './test.ts';
import { createBenchCommand } from './bench.ts';
import { createInstallCommand } from './install.ts';
import { createInitCommand } from './init.ts';
import { createDocCommand } from './doc.ts';
import { createFmtCommand } from './fmt.ts';
import { createLintCommand } from './lint.ts';
import { createReplCommand, runReplCommand } from './repl.ts';
import { createRunCommand, runScriptTask } from './run.ts';
/**
* Create the root CLI command.
*
* The returned command includes shared root options such as `--watch` and
* `--otlp-endpoint`, direct script execution, and the registered `run`, `test`,
* `bench`, `install`, `init`, `doc`, and `repl` subcommands. If parsing reaches
* the root without a script argument, the command starts the interactive REPL.
*
* ```js
* import { createRootCommand } from 'internal:commands/root';
* const root = createRootCommand();
* await root.parse(['run', 'example.ts']);
* ```
*
* @returns A configured root `Task` for the Fino CLI.
* @internal
*/
export function createRootCommand(): Task {
  return new Task({
    name: 'fino',
    description: 'Fino runtime CLI',
    outputMode: 'text',
    cli: {
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
      }]
    },
    run: async function runRootCommand(input) {
      const script = (input as {
        script?: unknown;
      }).script;
      if (script === undefined) return runReplCommand();
      return runScriptTask(input as Record<string, unknown>);
    },
    children: [
      createRunCommand(),
      createTestCommand(),
      createBenchCommand(),
      createInstallCommand(),
      createInitCommand(),
      createDocCommand(),
      createFmtCommand(),
      createLintCommand(),
      createReplCommand()
    ]
  });
}
