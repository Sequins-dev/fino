/**
* fino:commands/fmt — reusable `fino fmt` command task.
*
* This command formats JavaScript and TypeScript-family source files. With no
* positional inputs it scans the current working directory using the shared
* source discovery policy; explicit inputs may be files, directories, or globs.
* `--check` compares formatted output without writing and exits nonzero when
* any file would change.
*
* Formatting is scope-limited by design: it rewrites layout only and never
* applies lint fixes — `fino fmt` and `fino lint --fix` stay separate
* commands. Files that fail to parse are reported as diagnostics on stderr and
* cause the command to fail; parseable files in the same run are still
* formatted.
*
* The default export is a `Task`, so the command is equally usable
* programmatically (via `parse()` or `run()`) and as the `fmt` subcommand
* of the root Fino CLI. Passing `--json` switches output to a single JSON
* result object instead of the human-readable summary line.
*
* ```ts no_run
* import fmtCommand from 'fino:commands/fmt';
*
* await fmtCommand.parse(['--check', 'src/*.ts']);
* ```
*
*/
import { Task } from '../task.ts';
import { runFormat } from '../internal/tooling/format.ts';
/**
* The `fmt` command task, mounted as a subcommand by the root Fino CLI.
*
* On success the task returns a one-line summary string (for example
* `fino fmt: formatted 2 files` or `fino fmt: no changes`). When `--json` is
* requested it instead writes — and returns — a result object of the shape
* `{ command: 'fmt', ok: true, check, files, message }`.
*
* Throws after reportable failures so `internal/main.ts` preserves standard
* CLI exit behavior: parse diagnostics in any input file, or — in `--check`
* mode — at least one file that would reformat. In both cases the details are
* printed to stderr before the throw, and the thrown message carries only the
* aggregate count.
*
* ```ts no_run
* import fmtCommand from 'fino:commands/fmt';
*
* // Format the current project in place.
* console.log(await fmtCommand.parse([]));
*
* // Verify a subtree is clean without writing; throws if anything changed.
* try {
*   await fmtCommand.parse(['--check', 'src', 'tests/*.test.ts']);
* } catch {
*   console.error('run `fino fmt` before committing');
* }
* ```
*
*/
const command = new Task({
    name: 'fmt',
    description: 'Format JavaScript and TypeScript source files',
    outputMode: 'both',
    run: async function runFmtCommand(input: {
      files?: unknown[];
      check?: unknown;
    }, ctx) {
      const files = Array.isArray(input.files) ? input.files.map(String) : [];
      const check = input.check === true;
      const message = await runFormat({
        files,
        check
      });
      if (ctx.writer.mode === 'json') {
        const result = {
          command: 'fmt',
          ok: true,
          check,
          files,
          message
        };
        await ctx.writer.writeJson(result);
        return result;
      }
      return message;
    },
    cli: {
      options: [{
        flags: '--check',
        type: 'boolean',
        description: 'Report files that would change without writing them'
      }],
      positionals: [{
        name: 'files',
        type: 'string',
        multiple: true,
        description: 'Files, directories, or globs to format'
      }]
    }
});
export { command as default };
