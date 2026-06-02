/**
 * internal/commands/fmt — `fino fmt` command.
 *
 * This command formats JavaScript and TypeScript-family source files. With no
 * positional inputs it scans the current working directory using the shared
 * source discovery policy; explicit inputs may be files, directories, or globs.
 * `--check` compares formatted output without writing and exits nonzero when
 * any file would change.
 *
 * ```ts no_run
 * import { createFmtCommand } from 'internal:commands/fmt';
 *
 * const command = createFmtCommand();
 * await command.parse(['--check', 'src/*.ts']);
 * ```
 *
 * @internal
 */

import { Command, type CommandContext } from '../../process/argv.mts';
import { runFormat } from '../tooling/format.mts';

/**
 * Create the `fmt` subcommand used by the root Fino CLI.
 *
 * The command returns a success string for normal output and throws after
 * reportable failures so `internal/main.mts` preserves standard CLI exit
 * behavior.
 *
 * @internal
 */
export function createFmtCommand(): Command {
  return new Command({
    name: 'fmt',
    description: 'Format JavaScript and TypeScript source files',
    run: async function runFmtCommand(ctx: CommandContext) {
      const files = Array.isArray(ctx.args.files) ? ctx.args.files.map(String) : [];
      return runFormat({ files, check: ctx.options.check === true });
    },
    options: [
      { flags: '--check', type: 'boolean', description: 'Report files that would change without writing them' },
    ],
    positionals: [
      { name: 'files', type: 'string', multiple: true, description: 'Files, directories, or globs to format' },
    ],
  });
}
