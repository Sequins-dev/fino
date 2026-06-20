/**
 * internal/tooling/lint — shared implementation for `fino lint`.
 *
 * This module owns lint workflow: source discovery, native lint invocation,
 * optional safe-fix application, diagnostic reporting, and aggregate command
 * messages. Formatting is intentionally not run here; `lint --fix` only writes
 * fixes that come from lint rules.
 *
 * ```ts no_run
 * import { runLint } from 'internal:tooling/lint';
 *
 * await runLint({ files: ['src/*.ts'], fix: false });
 * ```
 *
 * @internal
 */

import { lint as lintSource } from '../../format/typescript.mts';
import { discoverSourceFiles, readSourceFile, writeSourceFile } from './files.mts';
import { formatDiagnostics, type ToolDiagnostic } from './report.mts';

/**
 * Options for running source linting.
 *
 * @internal
 */
export interface RunLintOptions {
  /**
   * Files, directories, or glob inputs supplied by the user.
   */
  files: string[];
  /**
   * Whether safe lint fixes should be applied.
   */
  fix: boolean;
}

/**
 * Run linter over discovered source files.
 *
 * Returns the success message printed by the CLI. On diagnostics it writes a
 * grouped report to stderr and throws so the process exits nonzero.
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
    const result = lintSource(source, { filename: file, fix: options.fix });
    if (options.fix && typeof result.fixedCode === 'string' && result.fixedCode !== source) {
      await writeSourceFile(file, result.fixedCode);
      fixed++;
    }
    for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, file });
  }

  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
    const suffix = options.fix ? `fixed ${fixed} file${fixed === 1 ? '' : 's'}, ${diagnostics.length} remaining` : `${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}`;
    throw new Error(`fino lint: ${suffix}`);
  }

  if (options.fix) return `fino lint: fixed ${fixed} file${fixed === 1 ? '' : 's'}, 0 remaining`;
  return files.length === 0 ? 'fino lint: no source files found' : `fino lint: ${files.length} file${files.length === 1 ? '' : 's'} checked`;
}
