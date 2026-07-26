/**
 * internal/tooling/lint — shared implementation for `fino lint`.
 *
 * This module owns the whole lint workflow behind the `fino lint` subcommand:
 * it expands the user's file/directory/glob inputs into a concrete source list,
 * runs each file through the runtime's native TypeScript lint rules, optionally
 * rewrites files in place with the safe fixes those rules can apply, groups any
 * remaining diagnostics into a stable stderr report, and returns the one-line
 * summary the CLI prints on success.
 *
 * Formatting is deliberately out of scope. `lint --fix` only writes changes
 * that originate from lint rules themselves; whitespace and layout are the job
 * of the formatter, so a file that lints clean is never reformatted here. Fixes
 * are applied idempotently — a rule fix is written only when the produced text
 * actually differs from the file on disk.
 *
 * Because discovery and reporting are shared with the rest of the tooling
 * family, this file coordinates three internal helpers rather than reaching for
 * the filesystem directly: `internal:tooling/files` for discovery and I/O,
 * `fino:format/typescript` for the lint pass, and `internal:tooling/report`
 * for diagnostic formatting.
 *
 * ```ts no_run
 * import { runLint } from 'internal:tooling/lint';
 *
 * // Check without modifying anything; the returned string is what the CLI prints.
 * const summary = await runLint({ files: ['src', 'test.ts'], fix: false });
 * console.log(summary); // e.g. "fino lint: 12 files checked"
 * ```
 *
 * @internal
 */
import { lint as lintSource } from '../../format/typescript.ts';
import { discoverSourceFiles, readSourceFile, writeSourceFile } from './files.ts';
import { formatDiagnostics, type ToolDiagnostic } from './report.ts';
/**
 * Inputs that control a single `runLint` invocation.
 *
 * Mirrors the arguments the `fino lint` subcommand collects from its command
 * line: which paths to inspect and whether to write safe fixes back to disk.
 *
 * ```ts no_run
 * import { runLint, type RunLintOptions } from 'internal:tooling/lint';
 *
 * const options: RunLintOptions = {
 *   files: ['src', 'scripts/build.ts'],
 *   fix: true,
 * };
 * await runLint(options);
 * ```
 *
 * @internal
 */
export interface RunLintOptions {
  /**
   * Raw path inputs supplied by the user — any mix of files, directories, and
   * glob patterns. Directories are walked and globs are expanded by discovery
   * before linting; an empty result is reported rather than treated as an error.
   */
  files: string[];
  /**
   * When true, rule-provided fixes are written back to each file in place and
   * counted toward the summary. When false, linting is read-only and only
   * reports diagnostics.
   */
  fix: boolean;
}
/**
 * Discover, lint, and optionally fix source files, returning the CLI summary.
 *
 * Expands `options.files` into a concrete file list, lints each one against the
 * runtime's default rule set, and — when `options.fix` is set — writes any safe
 * rule fixes back to disk, counting a file as fixed only when its text actually
 * changed. On a clean run it resolves with the one-line summary the CLI prints
 * to stdout, such as `"fino lint: 3 files checked"`, `"fino lint: no source
 * files found"`, or, in fix mode, `"fino lint: fixed 2 files, 0 remaining"`.
 *
 * Throws if discovery fails (for example an unreadable path or a malformed
 * glob), with the underlying message prefixed by `fino lint:`. It also throws
 * when any diagnostics remain after the pass: the grouped, file-by-file report
 * is first written to stderr via the reporting helper, then an error carrying
 * the count (`fino lint: 4 diagnostics`, or in fix mode `fino lint: fixed 1
 * file, 4 remaining`) is raised so the process exits nonzero. Callers should
 * treat a thrown error as the failure signal and let the already-printed report
 * stand as the human-facing output.
 *
 * ```ts no_run
 * import { runLint } from 'internal:tooling/lint';
 *
 * try {
 *   const summary = await runLint({ files: ['src'], fix: false });
 *   console.log(summary);
 *   process.exit(0);
 * } catch (err) {
 *   // The grouped diagnostics were already printed to stderr.
 *   console.error(err instanceof Error ? err.message : String(err));
 *   process.exit(1);
 * }
 * ```
 *
 * @internal
 */
export async function runLint(options: RunLintOptions): Promise<string> {
  let files: string[];
  try {
    files = await discoverSourceFiles(options.files);
  } catch (err) {
    throw new Error(`fino lint: ${err instanceof Error ? err.message : String(err)}`);
  }
  const diagnostics: ToolDiagnostic[] = [];
  let fixed = 0;
  for (const file of files) {
    const source = await readSourceFile(file);
    const result = lintSource(source, {
      filename: file,
      fix: options.fix,
    });
    if (options.fix && typeof result.fixedCode === 'string' && result.fixedCode !== source) {
      await writeSourceFile(file, result.fixedCode);
      fixed++;
    }
    for (const diagnostic of result.diagnostics)
      diagnostics.push({
        ...diagnostic,
        file,
      });
  }
  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
    const suffix = options.fix
      ? `fixed ${fixed} file${fixed === 1 ? '' : 's'}, ${diagnostics.length} remaining`
      : `${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}`;
    throw new Error(`fino lint: ${suffix}`);
  }
  if (options.fix) return `fino lint: fixed ${fixed} file${fixed === 1 ? '' : 's'}, 0 remaining`;
  return files.length === 0
    ? 'fino lint: no source files found'
    : `fino lint: ${files.length} file${files.length === 1 ? '' : 's'} checked`;
}
