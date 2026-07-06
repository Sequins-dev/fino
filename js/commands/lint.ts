/**
* fino:commands/lint — reusable `fino lint` command task.
*
* This command lints JavaScript and TypeScript-family source files. With no
* positional inputs it scans the current working directory using the shared
* source discovery policy; explicit inputs may be files, directories, or globs.
*
* Linting is scope-limited by design: `--fix` writes only the safe fixes that
* come from lint rules and never reformats layout — `fino lint --fix` and
* `fino fmt` stay separate commands. Diagnostics are grouped per file and
* printed to stderr; any remaining diagnostic makes the command fail, so a
* clean exit means the checked tree is lint-clean.
*
* The default export is a `Task`, so the command is equally usable
* programmatically (via `parse()` or `run()`) and as the `lint` subcommand of
* the root Fino CLI. Passing `--json` switches output to a single JSON result
* object instead of the human-readable summary line.
*
* ```ts no_run
* import lintCommand from 'fino:commands/lint';
*
* await lintCommand.parse(['--fix', 'src']);
* ```
*
*/
import { Task } from '../task.ts';
import { runLint } from '../internal/tooling/lint.ts';
/**
* The `lint` command task, mounted as a subcommand by the root Fino CLI.
*
* On success the task returns a one-line summary string (for example
* `fino lint: 12 files checked`, or `fino lint: fixed 2 files, 0 remaining`
* with `--fix`). When `--json` is requested it instead writes — and returns —
* a result object of the shape `{ command: 'lint', ok: true, fix, files,
* message }`.
*
* Throws after reportable failures so `internal/main.ts` preserves standard
* CLI exit behavior: when diagnostics remain, the grouped per-file report is
* printed to stderr first and the thrown message carries only the aggregate
* count (including how many files `--fix` rewrote). Input discovery errors —
* such as a named file that does not exist — also throw, before any linting
* runs.
*
* ```ts no_run
* import lintCommand from 'fino:commands/lint';
*
* // Lint the current project; throws if any diagnostic is found.
* console.log(await lintCommand.parse([]));
*
* // Apply safe fixes to a subtree, then gate on what remains.
* try {
*   await lintCommand.parse(['--fix', 'src', 'tests/*.test.ts']);
* } catch {
*   console.error('unfixable lint diagnostics remain');
* }
* ```
*
*/
const command = new Task({
    name: 'lint',
    description: 'Lint JavaScript and TypeScript source files',
    outputMode: 'both',
    run: async function runLintCommand(input: {
      files?: unknown[];
      fix?: unknown;
    }, ctx) {
      const files = Array.isArray(input.files) ? input.files.map(String) : [];
      const fix = input.fix === true;
      const message = await runLint({
        files,
        fix
      });
      if (ctx.writer.mode === 'json') {
        const result = {
          command: 'lint',
          ok: true,
          fix,
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
        flags: '--fix',
        type: 'boolean',
        description: 'Apply safe lint fixes without running formatting'
      }],
      positionals: [{
        name: 'files',
        type: 'string',
        multiple: true,
        description: 'Files, directories, or globs to lint'
      }]
    }
});
export { command as default };
