/**
* internal:tooling/format — shared implementation for `fino fmt`.
*
* This module owns the whole formatting workflow behind the `fmt` command:
* source discovery, native OXC formatter invocation, check-mode comparison,
* write-back, parse diagnostic reporting, and the aggregate success/failure
* messages. The public `fino:commands/fmt` task is a thin CLI shell over the
* single entry point exported here, so any tool that wants to format Fino
* source programmatically can call `runFormat` directly without going through
* the command layer.
*
* Formatting is deliberately scope-limited: it rewrites layout only. This
* module never applies lint fixes — `fmt` and `lint --fix` remain separate
* user-facing commands — and it never changes program behavior. Files that
* fail to parse are collected as diagnostics and reported together; parseable
* files in the same run are still formatted (or, in check mode, still
* compared), so one broken file does not mask the rest.
*
* This is an internal helper module, importable only from other built-ins.
* Reach for it when building formatting tooling on top of the runtime; end
* users format via the public `fino fmt` command instead.
*
* ```ts no_run
* import { runFormat } from 'internal:tooling/format';
*
* // Reformat a subtree in place and print the CLI summary line.
* console.log(await runFormat({ files: ['src'], check: false }));
*
* // Verify formatting without writing; throws if anything would change.
* await runFormat({ files: ['src', 'tests'], check: true });
* ```
*
* @internal
*/
import { format as formatSource } from '../../format/typescript.ts';
import { discoverSourceFiles, readSourceFile, writeSourceFile } from './files.ts';
import { displayPath, formatDiagnostics, type ToolDiagnostic } from './report.ts';
/**
* Inputs that control a single `runFormat` invocation.
*
* Mirrors the two user-facing knobs of the `fino fmt` command: the set of
* paths to process and whether to run in non-writing check mode. Both fields
* are required; the CLI shell fills them from parsed arguments, defaulting
* `files` to the current working directory and `check` to `false`.
*
* ```ts no_run
* import { runFormat, type RunFormatOptions } from 'internal:tooling/format';
*
* const options: RunFormatOptions = {
*   files: ['src', 'scripts/build.ts'],
*   check: process.env.CI === 'true',
* };
* await runFormat(options);
* ```
*
* @internal
*/
export interface RunFormatOptions {
  /**
  * Files, directories, or glob inputs to format, as supplied by the user. An
  * empty array falls through to the shared source-discovery policy, which
  * scans the current working directory.
  */
  files: string[];
  /**
  * When `true`, report which files would change and throw instead of writing
  * them — the mode used by pre-commit and CI checks. When `false`, formatted
  * output is written back to disk.
  */
  check: boolean;
}
/**
* Run the formatter over the source files discovered from the given inputs.
*
* Expands `options.files` through the shared discovery policy, formats each
* resolved file with the native OXC formatter, and either writes changes back
* or — in check mode — records which files would change. On success it returns
* the one-line summary string the CLI prints, such as
* `fino fmt: formatted 2 files`, `fino fmt: no changes`, or, in check mode,
* `fino fmt: 3 files checked`.
*
* Throws in three cases, always after printing a human-readable report to
* stderr first, so `internal/main.ts` exits nonzero via the existing CLI error
* path: when discovery itself fails, when any input file fails to parse (a
* diagnostics report is printed and parse errors do not abort the loop early),
* or — in check mode only — when at least one file would reformat. The thrown
* `Error` message carries only the aggregate count; the per-file detail lives
* in the stderr report.
*
* ```ts no_run
* import { runFormat } from 'internal:tooling/format';
*
* // Format in place, logging the summary.
* console.log(await runFormat({ files: [], check: false }));
*
* // Gate a commit on clean formatting.
* try {
*   await runFormat({ files: ['src'], check: true });
* } catch (err) {
*   console.error(err instanceof Error ? err.message : err);
*   throw err;
* }
* ```
*
* @internal
*/
export async function runFormat(options: RunFormatOptions): Promise<string> {
  let files: string[];
  try {
    files = await discoverSourceFiles(options.files);
  } catch (err) {
    throw new Error(`fino fmt: ${err instanceof Error ? err.message : String(err)}`);
  }
  const changed: string[] = [];
  const diagnostics: ToolDiagnostic[] = [];
  for (const file of files) {
    const source = await readSourceFile(file);
    const result = formatSource(source, { filename: file });
    if (!result.ok) {
      for (const diagnostic of result.errors) diagnostics.push({
        ...diagnostic,
        file
      });
      continue;
    }
    if (result.code !== source) {
      changed.push(file);
      if (!options.check) await writeSourceFile(file, result.code);
    }
  }
  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
    throw new Error(`fino fmt: ${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'}`);
  }
  if (options.check && changed.length > 0) {
    console.error(changed.map((file) => `${displayPath(file)} would reformat`).join('\n'));
    throw new Error(`fino fmt: ${changed.length} file${changed.length === 1 ? '' : 's'} would reformat`);
  }
  if (options.check) return files.length === 0 ? 'fino fmt: no source files found' : `fino fmt: ${files.length} file${files.length === 1 ? '' : 's'} checked`;
  return changed.length === 0 ? 'fino fmt: no changes' : `fino fmt: formatted ${changed.length} file${changed.length === 1 ? '' : 's'}`;
}
