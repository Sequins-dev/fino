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

import { Task } from '../../task.mts';
import { runLint } from '../tooling/lint.mts';

/**
 * Create the `lint` subcommand used by the root Fino CLI.
 *
 * The task returns a success string for text output, writes a JSON result when
 * `--json` is requested, and throws after diagnostics so `internal/main.mts`
 * preserves standard CLI exit behavior.
 *
 * @internal
 */
export function createLintCommand(): Task {
  return new Task({
    name: 'lint',
    description: 'Lint JavaScript and TypeScript source files',
    outputMode: 'both',
    run: async function runLintCommand(input: { files?: unknown[]; fix?: unknown }, ctx) {
      const files = Array.isArray(input.files) ? input.files.map(String) : [];
      const fix = input.fix === true;
      const message = await runLint({ files, fix });
      if (ctx.writer.mode === 'json') {
        const result = { command: 'lint', ok: true, fix, files, message };
        await ctx.writer.writeJson(result);
        return result;
      }
      return message;
    },
    cli: {
      options: [
        { flags: '--fix', type: 'boolean', description: 'Apply safe lint fixes without running formatting' },
      ],
      positionals: [
        { name: 'files', type: 'string', multiple: true, description: 'Files, directories, or globs to lint' },
      ],
    },
  });
}
