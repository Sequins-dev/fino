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

import { Command } from '../../process/argv.mts';
import { createTestCommand } from './test.mts';
import { createBenchCommand } from './bench.mts';
import { createInstallCommand } from './install.mts';
import { createInitCommand } from './init.mts';
import { createDocCommand } from './doc.mts';
import { createReplCommand, runReplCommand } from './repl.mts';
import { createRunCommand, runScriptCommand } from './run.mts';

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
 * await root.parse(['run', 'example.mts']);
 * ```
 *
 * @returns A configured root `Command` for the Fino CLI.
 * @internal
 */
export function createRootCommand(): Command {
  return new Command({
    name: 'fino',
    description: 'Fino runtime CLI',
    options: [
      {
        flags: '--otlp-endpoint',
        type: 'string',
        description: 'Enable OpenTelemetry export to the given OTLP/HTTP collector endpoint',
      },
      {
        flags: '--watch',
        type: 'boolean',
        description: 'Re-run the script whenever any imported file changes',
      },
    ],
    run: async function runRootCommand(ctx) {
      const script = ctx.args.script;
      if (script === undefined) return runReplCommand();
      return runScriptCommand(ctx);
    },
    positionals: [
      { name: 'script', type: 'string', description: 'Script module to execute' },
    ],
    commands: [
      createRunCommand(),
      createTestCommand(),
      createBenchCommand(),
      createInstallCommand(),
      createInitCommand(),
      createDocCommand(),
      createReplCommand(),
    ],
  });
}
