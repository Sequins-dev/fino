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

import { Task } from '../../task.mts';
import { runFormat } from '../tooling/format.mts';

/**
 * Create the `fmt` subcommand used by the root Fino CLI.
 *
 * The task returns a success string for text output, writes a JSON result when
 * `--json` is requested, and throws after reportable failures so
 * `internal/main.mts` preserves standard CLI exit behavior.
 *
 * @internal
 */
export function createFmtCommand(): Task {
  return new Task({
    name: 'fmt',
    description: 'Format JavaScript and TypeScript source files',
    outputMode: 'both',
    run: async function runFmtCommand(input: { files?: unknown[]; check?: unknown }, ctx) {
      const files = Array.isArray(input.files) ? input.files.map(String) : [];
      const check = input.check === true;
      const message = await runFormat({ files, check });
      if (ctx.writer.mode === 'json') {
        const result = { command: 'fmt', ok: true, check, files, message };
        await ctx.writer.writeJson(result);
        return result;
      }
      return message;
    },
    cli: {
      options: [
        { flags: '--check', type: 'boolean', description: 'Report files that would change without writing them' },
      ],
      positionals: [
        { name: 'files', type: 'string', multiple: true, description: 'Files, directories, or globs to format' },
      ],
    },
  });
}
