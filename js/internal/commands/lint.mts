/**
 * internal/commands/lint — `fino lint` command.
 *
 * This command lints JavaScript and TypeScript-family source files. With no
 * positional inputs it scans the current working directory using the shared
 * source discovery policy; explicit inputs may be files, directories, or globs.
 * `--fix` applies safe lint fixes only and does not run formatting.
 *
 * ```ts no_run
 * import { createLintCommand } from 'internal:commands/lint';
 *
 * const command = createLintCommand();
 * await command.parse(['--fix', 'src']);
 * ```
 *
 * @internal
 */

import { Command, type CommandContext } from '../../process/argv.mts';
import { runLint } from '../tooling/lint.mts';

/**
 * Create the `lint` subcommand used by the root Fino CLI.
 *
 * The command returns a success string for normal output and throws after
 * diagnostics so `internal/main.mts` preserves standard CLI exit behavior.
 *
 * @internal
 */
export function createLintCommand(): Command {
  return new Command({
    name: 'lint',
    description: 'Lint JavaScript and TypeScript source files',
    run: async function runLintCommand(ctx: CommandContext) {
      const files = Array.isArray(ctx.args.files) ? ctx.args.files.map(String) : [];
      return runLint({ files, fix: ctx.options.fix === true });
    },
    options: [
      { flags: '--fix', type: 'boolean', description: 'Apply safe lint fixes without running formatting' },
    ],
    positionals: [
      { name: 'files', type: 'string', multiple: true, description: 'Files, directories, or globs to lint' },
    ],
  });
}
