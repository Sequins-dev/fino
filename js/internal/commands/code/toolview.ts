/**
 * internal:commands/code/toolview — function-call rendering for tool activity.
 *
 * Tool calls read best as code: this module renders one as a call signature
 * with named parameters — `read_file(path: "js/ai/agent.ts", offset: 10)` —
 * and renders its arguments and output through a format-aware view.
 * TypeScript and JavaScript are syntax-highlighted, Markdown renders as
 * terminal Markdown, JSON is pretty-printed, and line-numbered file reads
 * keep their numbers dimmed beside highlighted source. The format is
 * inferred from the tool and its arguments (a `path` extension, or a tool
 * that is known to emit Markdown); anything unrecognized falls back to plain
 * wrapped text, so the view never fails on unexpected output.
 *
 * ```ts no_run
 * import { formatToolSignature, formatToolOutputLines } from 'internal:commands/code/toolview';
 *
 * formatToolSignature('read_file', { path: 'a.ts', offset: 10 });
 * // 'read_file(path: "a.ts", offset: 10)'
 *
 * const lines = formatToolOutputLines({
 *   name: 'read_file',
 *   args: { path: 'a.ts' },
 *   output: '    1\tconst x = 1;',
 *   width: 80,
 * });
 * ```
 */
import { highlightCodeTerminal, renderMarkdownTerminal } from 'fino:format/markdown';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['ts', 'ts'],
  ['tsx', 'ts'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['js', 'js'],
  ['jsx', 'js'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['md', 'md'],
  ['markdown', 'md'],
  ['json', 'json'],
]);
// Tools whose output is Markdown regardless of any path argument.
const MARKDOWN_TOOLS = new Set(['docs_show']);
// Argument names that carry file bodies worth formatting as source.
const BODY_ARGS = new Set(['content', 'oldText', 'newText']);
const NUMBERED_LINE = /^(\s*\d+)\t(.*)$/;

function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const word of raw.split(' ')) {
      if (word === '' && line === '') continue;
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
      while (line.length > limit) {
        lines.push(line.slice(0, limit));
        line = line.slice(limit);
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

/**
 * Infer the content language for a tool call, or `null` when unknown.
 *
 * Uses the tool name for tools that always emit one format, then the
 * extension of a `path` argument.
 */
export function languageForTool(name: string, args: unknown): string | null {
  if (MARKDOWN_TOOLS.has(name)) return 'md';
  const path =
    typeof args === 'object' && args !== null ? (args as { path?: unknown }).path : undefined;
  if (typeof path !== 'string') return null;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return LANGUAGE_BY_EXTENSION.get(path.slice(dot + 1).toLowerCase()) ?? null;
}

function inlineValue(value: unknown, max: number): string {
  const limit = Math.max(8, max);
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    return JSON.stringify(flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat);
  }
  if (value === null || typeof value !== 'object') return String(value);
  const json = JSON.stringify(value) ?? '';
  return json.length > limit ? `${json.slice(0, limit - 1)}…` : json;
}

/**
 * Render a tool call as a single-line call signature with named parameters.
 *
 * Long or multi-line values are flattened and truncated so the signature
 * stays one line; the full values are available from
 * `formatToolArgLines()`.
 */
export function formatToolSignature(
  name: string,
  args: unknown,
  opts: { maxValue?: number } = {},
): string {
  if (typeof args !== 'object' || args === null) return `${name}()`;
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return `${name}()`;
  const max = opts.maxValue ?? 48;
  return `${name}(${entries.map(([key, value]) => `${key}: ${inlineValue(value, max)}`).join(', ')})`;
}

function formatBody(
  text: string,
  language: string | null,
  width: number,
  color: boolean,
): string[] {
  if (language === 'md') return renderMarkdownTerminal(text, { width, color }).split('\n');
  if (language === 'ts' || language === 'js') {
    return highlightCodeTerminal(text, language, { color });
  }
  if (language === 'json') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2).split('\n');
    } catch (_) {
      return wrapPlain(text, width);
    }
  }
  return wrapPlain(text, width);
}

/**
 * Render each argument of a tool call on its own line for the expanded view.
 *
 * Short values stay inline (`path: "a.ts"`); file bodies and other long or
 * multi-line values become indented blocks, formatted as source when the
 * call's language is known.
 */
export function formatToolArgLines(
  name: string,
  args: unknown,
  opts: { width: number; color?: boolean },
): string[] {
  if (typeof args !== 'object' || args === null) return [];
  const color = opts.color ?? true;
  const language = languageForTool(name, args);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined) continue;
    const inlineWidth = opts.width - key.length - 2;
    if (typeof value === 'string' && (value.includes('\n') || value.length > inlineWidth)) {
      lines.push(`${key}:`);
      const body = BODY_ARGS.has(key)
        ? formatBody(value, language, opts.width - 2, color)
        : wrapPlain(value, opts.width - 2);
      lines.push(...body.map((line) => `  ${line}`));
      continue;
    }
    lines.push(`${key}: ${inlineValue(value, Math.max(8, inlineWidth))}`);
  }
  return lines;
}

interface NumberedOutput {
  numbers: string[];
  code: string[];
}

function splitNumbered(output: string): NumberedOutput | null {
  const raw = output.replace(/\n$/, '').split('\n');
  const numbers: string[] = [];
  const code: string[] = [];
  let matched = 0;
  for (const line of raw) {
    const match = NUMBERED_LINE.exec(line);
    if (match) {
      numbers.push(match[1]!);
      code.push(match[2]!);
      matched += 1;
      continue;
    }
    // Trailing notes such as "[N more lines; continue with offset=…]" are
    // fine; anything else means this is not a numbered file read.
    if (line.trim().length > 0 && !line.startsWith('[')) return null;
    numbers.push('');
    code.push(line);
  }
  return matched > 0 ? { numbers, code } : null;
}

/**
 * Render a tool's output for the expanded view, formatted by content type.
 *
 * Line-numbered file reads keep dimmed line numbers beside highlighted
 * source; Markdown renders as terminal Markdown; JSON is pretty-printed; and
 * unrecognized output is wrapped plain text.
 */
export function formatToolOutputLines(opts: {
  name: string;
  args: unknown;
  output: string;
  width: number;
  color?: boolean;
}): string[] {
  const color = opts.color ?? true;
  const language = languageForTool(opts.name, opts.args);
  const numbered = splitNumbered(opts.output);
  if (numbered) {
    const source = numbered.code.join('\n');
    // Markdown reads are worth rendering as prose, which drops the
    // line-to-line correspondence the numbers describe.
    if (language === 'md')
      return renderMarkdownTerminal(source, { width: opts.width, color }).split('\n');
    const gutter = Math.max(...numbered.numbers.map((n) => n.length));
    const body = formatBody(source, language, Math.max(8, opts.width - gutter - 1), color);
    return numbered.numbers.map((number, index) => {
      const label = number.padStart(gutter, ' ');
      const prefix = color ? `${DIM}${label}${RESET} ` : `${label} `;
      return `${prefix}${body[index] ?? ''}`;
    });
  }
  if (language !== null) return formatBody(opts.output, language, opts.width, color);
  const trimmed = opts.output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).split('\n');
    } catch (_) {
      // not JSON after all
    }
  }
  return wrapPlain(opts.output, opts.width);
}
