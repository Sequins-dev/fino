/**
 * internal/tooling/report — diagnostic display helpers for source tooling.
 *
 * This module converts structured diagnostics from native and JavaScript
 * tooling into stable, compact CLI output. Diagnostics are grouped by file and
 * displayed with one-based source locations when available.
 *
 * ```ts no_run
 * import { formatDiagnostics } from 'internal:tooling/report';
 *
 * console.error(formatDiagnostics([{ file: '/repo/app.ts', line: 1, column: 1, message: 'Example' }]));
 * ```
 *
 * @internal
 */

import { relative } from '../../file/path.ts';
import { cwd } from '../../process.ts';

/**
 * CLI diagnostic emitted by tooling commands.
 *
 * @internal
 */
export interface ToolDiagnostic {
  /**
   * Stable machine-readable diagnostic code.
   */
  code?: string;
  /**
   * Human-readable diagnostic message.
   */
  message: string;
  /**
   * Diagnostic severity, usually `error`.
   */
  severity?: string;
  /**
   * Absolute file path associated with the diagnostic.
   */
  file?: string;
  /**
   * One-based start line.
   */
  line?: number;
  /**
   * One-based start column.
   */
  column?: number;
  /**
   * One-based end line.
   */
  endLine?: number;
  /**
   * One-based end column.
   */
  endColumn?: number;
}

/**
 * Convert an absolute path into a cwd-relative display path.
 *
 * Paths outside the current working directory remain absolute to avoid
 * confusing reports.
 *
 * @internal
 */
export function displayPath(path: string): string {
  const rel = relative(cwd(), path).toString();
  return rel.startsWith('..') ? path : rel;
}

/**
 * Format diagnostics grouped by file.
 *
 * The output is designed for stderr and intentionally stays plain text:
 * filename line, followed by indented location/severity/code/message lines.
 *
 * @internal
 */
export function formatDiagnostics(diagnostics: ToolDiagnostic[]): string {
  const byFile = new Map<string, ToolDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const file = diagnostic.file ?? '<unknown>';
    const existing = byFile.get(file);
    if (existing === undefined) byFile.set(file, [diagnostic]);
    else existing.push(diagnostic);
  }

  const lines: string[] = [];
  for (const [file, items] of byFile) {
    lines.push(displayPath(file));
    for (const item of items) {
      const loc = item.line !== undefined && item.column !== undefined
        ? `${item.line}:${item.column}`
        : '-';
      const code = item.code ? ` ${item.code}` : '';
      const severity = item.severity ?? 'error';
      lines.push(`  ${loc}  ${severity}${code}  ${item.message}`);
    }
  }
  return lines.join('\n');
}
