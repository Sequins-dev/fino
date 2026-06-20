/**
 * internal/tooling/format — shared implementation for `fino fmt`.
 *
 * This module owns formatting workflow: source discovery, native formatter
 * invocation, check-mode comparison, write-back, parse diagnostic reporting,
 * and aggregate success/failure messages. It intentionally does not run lint
 * fixes; `fmt` and `lint --fix` remain separate user-facing commands.
 *
 * ```ts no_run
 * import { runFormat } from 'internal:tooling/format';
 *
 * await runFormat({ files: ['src'], check: true });
 * ```
 *
 * @internal
 */

import { format as formatSource } from '../../format/typescript.mts';
import { discoverSourceFiles, readSourceFile, writeSourceFile } from './files.mts';
import { displayPath, formatDiagnostics, type ToolDiagnostic } from './report.mts';

/**
 * Options for running source formatting.
 *
 * @internal
 */
export interface RunFormatOptions {
  /**
   * Files, directories, or glob inputs supplied by the user.
   */
  files: string[];
  /**
   * Whether to report changed files without writing them.
   */
  check: boolean;
}

/**
 * Run formatter over discovered source files.
 *
 * Returns the success message printed by the CLI. On failures it writes a
 * human-readable report to stderr and throws so `internal/main.mts` exits
 * nonzero using the existing CLI error path.
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
      for (const diagnostic of result.errors) diagnostics.push({ ...diagnostic, file });
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
