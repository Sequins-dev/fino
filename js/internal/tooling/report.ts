/**
 * internal:tooling/report — diagnostic display helpers for source tooling.
 *
 * This module converts structured diagnostics from native and JavaScript
 * tooling — the type checker, linter, and formatter commands — into stable,
 * compact CLI output. Diagnostics are grouped by originating file and each is
 * printed with its one-based source location when one is known, so the output
 * is easy to scan and stable enough to diff across runs.
 *
 * The rendering is deliberately plain text with no color or terminal escapes:
 * it targets stderr, stays legible when piped or captured, and never depends on
 * a TTY. Absolute paths are shortened to cwd-relative form for readability, but
 * only when the file actually lives under the current directory — paths outside
 * it stay absolute so a report never points at an ambiguous relative location.
 *
 * Reach for this module from any tooling command that has already collected a
 * list of {@link ToolDiagnostic}s and needs to present them to the user. It
 * does not discover, run, or filter diagnostics; it only formats a batch that
 * the caller supplies.
 *
 * ```ts no_run
 * import { formatDiagnostics, type ToolDiagnostic } from 'internal:tooling/report';
 *
 * const diagnostics: ToolDiagnostic[] = [
 *   { file: '/repo/src/app.ts', line: 12, column: 5, code: 'TS2304', message: "Cannot find name 'foo'." },
 *   { file: '/repo/src/app.ts', line: 40, column: 1, severity: 'warning', message: 'Unused export.' },
 * ];
 *
 * console.error(formatDiagnostics(diagnostics));
 * // /repo/src/app.ts
 * //   12:5  error TS2304  Cannot find name 'foo'.
 * //   40:1  warning  Unused export.
 * ```
 *
 * @internal
 */
import { relative } from '../../file/path.ts';
import { cwd } from '../../process.ts';
/**
 * A single CLI diagnostic emitted by a tooling command.
 *
 * Only {@link ToolDiagnostic.message} is required. Every location field is
 * optional and one-based: a diagnostic with no `line`/`column` renders with a
 * `-` placeholder, and one with no `file` is grouped under `<unknown>`. The
 * `severity` defaults to `error` at render time, and `code` is an optional
 * stable identifier (such as a compiler rule name) that appears inline.
 *
 * The shape intentionally mirrors what native tooling produces, so diagnostics
 * from the type checker, linter, and formatter can be collected into one array
 * and reported together.
 *
 * ```ts no_run
 * import { formatDiagnostics, type ToolDiagnostic } from 'internal:tooling/report';
 *
 * const diag: ToolDiagnostic = {
 *   file: '/repo/lib/index.ts',
 *   line: 3,
 *   column: 10,
 *   endLine: 3,
 *   endColumn: 18,
 *   severity: 'error',
 *   code: 'no-unused',
 *   message: "'helper' is declared but never used.",
 * };
 *
 * console.error(formatDiagnostics([diag]));
 * ```
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
 * Computes the path relative to the current working directory. If the result
 * would escape the cwd — that is, it begins with `..` — the original absolute
 * path is returned unchanged, so a report never shows a confusing relative path
 * that walks up out of the project. Paths already under the cwd are shortened.
 *
 * This is the same shortening {@link formatDiagnostics} applies to file
 * headers; it is exported so callers that build custom report lines share the
 * identical convention.
 *
 * ```ts no_run
 * import { displayPath } from 'internal:tooling/report';
 *
 * // With cwd = /repo:
 * displayPath('/repo/src/app.ts'); // 'src/app.ts'
 * displayPath('/etc/hosts');       // '/etc/hosts' (outside cwd, stays absolute)
 * ```
 *
 * @internal
 */
export function displayPath(path: string): string {
  const rel = relative(cwd(), path).toString();
  return rel.startsWith('..') ? path : rel;
}
/**
 * Format a batch of diagnostics into a grouped, plain-text report string.
 *
 * Diagnostics are grouped by file in first-seen order: for each file a header
 * line carries the {@link displayPath}-shortened path, followed by one indented
 * line per diagnostic in the order supplied. Each detail line reads
 * `<line>:<column>  <severity>[ <code>]  <message>`, where the location
 * collapses to `-` when either `line` or `column` is missing, `severity`
 * defaults to `error`, and `code` is omitted when absent. Diagnostics without a
 * `file` are collected under a single `<unknown>` group.
 *
 * The returned string has no trailing newline and no color, making it suitable
 * to hand directly to `console.error`. An empty input yields an empty string.
 *
 * ```ts no_run
 * import { formatDiagnostics } from 'internal:tooling/report';
 *
 * const report = formatDiagnostics([
 *   { file: '/repo/a.ts', line: 1, column: 1, code: 'E001', message: 'Broken.' },
 *   { file: '/repo/a.ts', message: 'No location known.' },
 *   { message: 'Orphan diagnostic.' },
 * ]);
 *
 * console.error(report);
 * // /repo/a.ts (shown relative to cwd)
 * //   1:1  error E001  Broken.
 * //   -  error  No location known.
 * // <unknown>
 * //   -  error  Orphan diagnostic.
 * ```
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
      const loc =
        item.line !== undefined && item.column !== undefined ? `${item.line}:${item.column}` : '-';
      const code = item.code ? ` ${item.code}` : '';
      const severity = item.severity ?? 'error';
      lines.push(`  ${loc}  ${severity}${code}  ${item.message}`);
    }
  }
  return lines.join('\n');
}
