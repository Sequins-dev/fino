/**
 * fino:format/markdown - safe Markdown parser with HTML and terminal renderers.
 *
 * This module implements a practical CommonMark/GFM-oriented Markdown surface
 * in TypeScript. It supports headings, paragraphs, blockquotes, thematic
 * breaks, fenced code, nested ordered and unordered lists, task-list markers,
 * GFM tables, reference links, autolinks, emphasis, strong text, code spans,
 * strikethrough, links, images, and raw HTML with safe defaults.
 *
 * The module is named for its source format; the render function chosen
 * decides the output. Parsing and rendering are split: `parseMarkdown()`
 * produces a `MarkdownDocument` block tree that can be inspected, transformed,
 * or rendered multiple times with different options, while `renderMarkdown()`
 * accepts either a source string or a parsed document and emits HTML.
 * `renderMarkdownInline()` renders span-level Markdown without wrapping the
 * result in block elements, which suits one-line summaries and table cells.
 * `renderMarkdownTerminal()` and `renderMarkdownInlineTerminal()` emit
 * ANSI-styled, word-wrapped text for terminal display, with
 * `highlightCodeTerminal()` providing TypeScript/JavaScript syntax coloring
 * for fenced code blocks. The parser never throws — malformed constructs fall
 * back to escaped literal text rather than errors.
 *
 * Output is safe by default. Raw HTML is escaped unless `allowRawHtml` is
 * enabled, and even then the GFM tagfilter neutralizes dangerous tags such as
 * `script` and `iframe`. Link and image URLs are limited to relative URLs and
 * `http`/`https` unless `allowUnsafeLinks` is set; unsafe URLs render as plain
 * label text instead of anchors.
 *
 * ```ts no_run
 * import { parseMarkdown, renderMarkdown } from 'fino:format/markdown';
 *
 * const doc = parseMarkdown(`# Guide
 *
 * See the [API reference][api] for details.
 *
 * [api]: ./api.md`);
 *
 * const html = renderMarkdown(doc, {
 *   headingOffset: 1,
 *   resolveLink: (href) => href.replace(/\.md$/, '.html'),
 * });
 * // <h2>Guide</h2>
 * // <p>See the <a href="./api.html">API reference</a> for details.</p>
 * ```
 *
 * Useful references:
 * - CommonMark: https://spec.commonmark.org/0.31.2/
 * - GitHub Flavored Markdown: https://github.github.com/gfm/
 */
import { Scanner } from '../parsing/scanner.ts';
import { parse as parseTypeScript } from './typescript.ts';
/**
 * Options controlling Markdown HTML rendering, link safety, and code output.
 *
 * All fields are optional; the defaults render safe HTML with no external
 * hooks. The same options object is accepted by `renderMarkdown()` and
 * `renderMarkdownInline()`.
 *
 * ```ts no_run
 * import { renderMarkdown, type MarkdownOptions } from 'fino:format/markdown';
 *
 * const options: MarkdownOptions = {
 *   headingOffset: 1,
 *   references: { home: '/index.html' },
 *   renderCode: (code, lang) => `<pre data-lang="${lang}">${code}</pre>`,
 * };
 * const html = renderMarkdown('# Docs\n\nBack to [Home][home].', options);
 * ```
 */
export interface MarkdownOptions {
  /**
   * Allow link URLs outside the default safe set.
   *
   * By default only relative URLs and `http`/`https` URLs are rendered; any
   * other protocol (`javascript:`, `data:`, `mailto:`, ...) causes the link to
   * degrade to its label text. Setting this renders every URL verbatim — only
   * enable it for trusted input.
   */
  allowUnsafeLinks?: boolean;
  /**
   * Render raw HTML blocks and inline spans instead of escaping them.
   *
   * GFM tagfilter remains active for disallowed raw HTML tags such as `xmp`
   * and `script`.
   */
  allowRawHtml?: boolean;
  /**
   * Add this many levels to rendered Markdown headings.
   *
   * Useful when embedding a document under an existing page heading, e.g. an
   * offset of `2` renders `# Title` as `<h3>`. Resulting levels are clamped to
   * the `h1`–`h6` range.
   */
  headingOffset?: number;
  /**
   * Reference-style link definitions to use in addition to definitions parsed
   * from the document.
   *
   * Keys are matched case-insensitively with collapsed whitespace. Entries
   * here override same-named definitions parsed from the source.
   */
  references?: Record<string, string>;
  /**
   * Rewrite link URLs while rendering.
   *
   * Called for every link and image with the raw destination and the link
   * label (or image alt text). Return a replacement URL, or `undefined` to
   * keep the original. The returned URL is still checked against the
   * safe-link policy unless `allowUnsafeLinks` is set.
   */
  resolveLink?: (href: string, label: string) => string | undefined;
  /**
   * Render fenced code blocks, replacing the default output.
   *
   * Receives the raw (unescaped) code, the language token, and any trailing
   * info-string metadata. The returned string is inserted into the HTML as-is,
   * so the callback is responsible for escaping. Without this hook, code
   * renders as `<pre><code class="language-…">` with HTML-escaped content.
   */
  renderCode?: (code: string, lang: string, meta: string) => string;
}
/**
 * Block node in a parsed Markdown document.
 *
 * The tree represents the block constructs rendered by `renderMarkdown()`.
 * Inline Markdown remains in string fields (`text`, list item paragraphs,
 * table cells) and is interpreted during rendering, so a node tree can be
 * transformed before inline spans are committed to HTML.
 *
 * ```ts no_run
 * import { parseMarkdown, type MarkdownNode } from 'fino:format/markdown';
 *
 * const headings = parseMarkdown(source).nodes
 *   .filter((node): node is Extract<MarkdownNode, { kind: 'heading' }> => node.kind === 'heading')
 *   .map((node) => ({ level: node.level, text: node.text }));
 * ```
 */
export type MarkdownNode =
  | {
      kind: 'paragraph';
      text: string;
    }
  | {
      kind: 'heading';
      level: number;
      text: string;
    }
  | {
      kind: 'list';
      ordered: boolean;
      tight: boolean;
      items: MarkdownListItem[];
    }
  | {
      kind: 'code';
      lang: string;
      meta: string;
      code: string;
    }
  | {
      kind: 'blockquote';
      nodes: MarkdownNode[];
    }
  | {
      kind: 'thematicBreak';
    }
  | {
      kind: 'htmlBlock';
      html: string;
    }
  | {
      kind: 'table';
      align: TableAlign[];
      header: string[];
      rows: string[][];
    };
/**
 * Parsed list item content.
 *
 * Each item holds its own block tree, so nested lists, code blocks, and
 * multi-paragraph items appear as child nodes.
 *
 * ```ts no_run
 * import { parseMarkdown } from 'fino:format/markdown';
 *
 * const [list] = parseMarkdown('- [x] shipped\n- [ ] pending').nodes;
 * if (list?.kind === 'list') {
 *   const done = list.items.filter((item) => item.task === true).length;
 * }
 * ```
 */
export interface MarkdownListItem {
  /**
   * Block nodes forming the item body, in source order.
   */
  nodes: MarkdownNode[];
  /**
   * GFM task-list state: `true` for `[x]`, `false` for `[ ]`, and omitted for
   * ordinary list items.
   */
  task?: boolean;
}
/**
 * GFM table column alignment.
 *
 * Derived from colons in the table delimiter row (`:---`, `---:`, `:---:`).
 * `undefined` means the column declared no alignment and cells render without
 * an `align` attribute.
 */
export type TableAlign = 'left' | 'right' | 'center' | undefined;
/**
 * Parsed Markdown tree and reference-style link definitions.
 *
 * Produced by `parseMarkdown()` and accepted by `renderMarkdown()`, allowing
 * one parse to be inspected or rendered multiple times with different options.
 *
 * ```ts no_run
 * import { parseMarkdown, renderMarkdown, type MarkdownDocument } from 'fino:format/markdown';
 *
 * const doc: MarkdownDocument = parseMarkdown('See [Docs][docs].\n\n[docs]: /docs');
 * doc.references.docs;          // '/docs'
 * const html = renderMarkdown(doc);
 * ```
 */
export interface MarkdownDocument {
  /**
   * Block nodes in source order.
   */
  nodes: MarkdownNode[];
  /**
   * Normalized reference-style link definitions parsed from the document.
   *
   * Keys are lowercased with whitespace collapsed; duplicate definitions are
   * last-write-wins.
   */
  references: Record<string, string>;
}
interface Line {
  raw: string;
  text: string;
  indent: number;
}
interface ParseState {
  lines: Line[];
  index: number;
  references: Record<string, string>;
}
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttribute(value: unknown): string {
  return escapeHtml(value);
}
function normalizeReference(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
function isSafeHref(href: string, options: MarkdownOptions): boolean {
  if (options.allowUnsafeLinks) return true;
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return trimmed.length > 0;
}
function readLine(scanner: Scanner): string | undefined {
  if (scanner.done) return undefined;
  const line = scanner.eatUntil((code) => code === 10 || code === 13);
  if (scanner.match('\r\n')) return line;
  scanner.eatChar('\n') || scanner.eatChar('\r');
  return line;
}
function toLine(raw: string): Line {
  const spaces = /^ */.exec(raw)?.[0].length ?? 0;
  return {
    raw,
    text: raw.slice(spaces),
    indent: spaces,
  };
}
function splitFenceInfo(info: string): {
  lang: string;
  meta: string;
} {
  const trimmed = info.trim();
  const match = /^(\S+)?\s*(.*)$/.exec(trimmed);
  return {
    lang: match?.[1] ?? '',
    meta: match?.[2]?.trim() ?? '',
  };
}
function referenceDefinition(line: string):
  | {
      id: string;
      href: string;
    }
  | undefined {
  const match = /^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+.*)?$/.exec(line);
  if (!match) return undefined;
  return {
    id: normalizeReference(match[1]!),
    href: match[2]!,
  };
}
function listMarker(
  line: Line,
  baseIndent: number,
):
  | {
      ordered: boolean;
      rest: string;
      markerWidth: number;
    }
  | undefined {
  if (line.indent < baseIndent) return undefined;
  const current = line.raw.slice(baseIndent);
  const unordered = /^([-*+])\s+(.+)$/.exec(current);
  if (unordered)
    return {
      ordered: false,
      rest: unordered[2]!,
      markerWidth: unordered[1]!.length + 1,
    };
  const ordered = /^(\d+[.)])\s+(.+)$/.exec(current);
  if (ordered)
    return {
      ordered: true,
      rest: ordered[2]!,
      markerWidth: ordered[1]!.length + 1,
    };
  return undefined;
}
function thematicBreak(line: string): boolean {
  return /^(?: {0,3})([-*_])(?:\s*\1){2,}\s*$/.test(line);
}
function heading(line: string):
  | {
      level: number;
      text: string;
    }
  | undefined {
  const match = /^(#{1,6})(?:\s+|$)(.*?)(?:\s+#+\s*)?$/.exec(line);
  if (!match) return undefined;
  return {
    level: match[1]!.length,
    text: match[2]!.trim(),
  };
}
function setextHeading(line: string): 1 | 2 | undefined {
  if (/^=+\s*$/.test(line)) return 1;
  if (/^-+\s*$/.test(line)) return 2;
  return undefined;
}
function htmlBlockStart(line: string): boolean {
  return (
    /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/>)/i.test(
      line,
    ) ||
    /^<!--/.test(line) ||
    /^<\?/.test(line) ||
    /^<![A-Z]/.test(line) ||
    /^<!\[CDATA\[/.test(line)
  );
}
function disallowedRawHtmlTag(line: string): boolean {
  return /^<\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?=\s|>|\/>)/i.test(
    line,
  );
}
function renderRawHtml(html: string, options: MarkdownOptions): string {
  if (!options.allowRawHtml) return escapeHtml(html);
  return html.replace(
    /<\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?=\s|>|\/>)/gi,
    (tag) => `&lt;${tag.slice(1)}`,
  );
}
function splitTableRow(line: string): string[] {
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}
function parseTableDelimiter(line: string): TableAlign[] | undefined {
  const cells = splitTableRow(line);
  const align: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return undefined;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : undefined);
  }
  return align;
}
function tableStart(state: ParseState):
  | {
      align: TableAlign[];
      header: string[];
    }
  | undefined {
  const header = state.lines[state.index];
  const delimiter = state.lines[state.index + 1];
  if (!header || !delimiter || !header.raw.includes('|')) return undefined;
  const align = parseTableDelimiter(delimiter.text);
  if (!align) return undefined;
  const cells = splitTableRow(header.text);
  if (cells.length !== align.length) return undefined;
  return {
    align,
    header: cells,
  };
}
function isBlockStart(state: ParseState, baseIndent: number): boolean {
  const line = state.lines[state.index];
  if (!line || line.raw.trim() === '') return true;
  if (line.indent < baseIndent) return true;
  const text = line.raw.slice(baseIndent);
  return Boolean(
    referenceDefinition(line.raw) ||
    /^```/.test(text) ||
    heading(text) ||
    thematicBreak(text) ||
    /^> ?/.test(text) ||
    listMarker(line, baseIndent) ||
    htmlBlockStart(text) ||
    tableStart(state),
  );
}
function continuesListAfterBlank(line: Line | undefined, baseIndent: number): boolean {
  if (!line) return false;
  if (listMarker(line, baseIndent)) return true;
  return line.raw.trim() !== '' && line.indent > baseIndent;
}
function parseBlocks(state: ParseState, baseIndent = 0, stopOnListMarker = false): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]!;
    if (line.raw.trim() === '') {
      state.index++;
      if (stopOnListMarker) break;
      continue;
    }
    if (line.indent < baseIndent) break;
    if (stopOnListMarker && listMarker(line, baseIndent)) break;
    const reference = referenceDefinition(line.raw);
    if (reference) {
      state.references[reference.id] = reference.href;
      state.index++;
      continue;
    }
    const text = line.raw.slice(baseIndent);
    const fence = /^```(.*)$/.exec(text);
    if (fence) {
      const info = splitFenceInfo(fence[1] ?? '');
      const code: string[] = [];
      state.index++;
      while (
        state.index < state.lines.length &&
        !/^```\s*$/.test(state.lines[state.index]!.raw.slice(baseIndent))
      ) {
        const current = state.lines[state.index]!;
        code.push(current.raw.slice(Math.min(baseIndent, current.raw.length)));
        state.index++;
      }
      if (state.index < state.lines.length) state.index++;
      nodes.push({
        kind: 'code',
        lang: info.lang,
        meta: info.meta,
        code: code.join('\n'),
      });
      continue;
    }
    const atx = heading(text);
    if (atx) {
      nodes.push({
        kind: 'heading',
        level: atx.level,
        text: atx.text,
      });
      state.index++;
      continue;
    }
    if (thematicBreak(text)) {
      nodes.push({ kind: 'thematicBreak' });
      state.index++;
      continue;
    }
    if (/^> ?/.test(text)) {
      const quoteLines: string[] = [];
      while (state.index < state.lines.length) {
        const current = state.lines[state.index]!;
        if (current.raw.trim() === '') {
          quoteLines.push('');
          state.index++;
          continue;
        }
        const currentText = current.raw.slice(baseIndent);
        const marker = /^> ?(.*)$/.exec(currentText);
        if (!marker) break;
        quoteLines.push(marker[1] ?? '');
        state.index++;
      }
      nodes.push({
        kind: 'blockquote',
        nodes: parseMarkdown(quoteLines.join('\n')).nodes,
      });
      continue;
    }
    const list = parseList(state, baseIndent);
    if (list) {
      nodes.push(list);
      continue;
    }
    const table = tableStart(state);
    if (table) {
      state.index += 2;
      const rows: string[][] = [];
      while (state.index < state.lines.length) {
        const current = state.lines[state.index]!;
        if (current.raw.trim() === '' || !current.raw.includes('|') || current.indent < baseIndent)
          break;
        rows.push(splitTableRow(current.text));
        state.index++;
      }
      nodes.push({
        kind: 'table',
        align: table.align,
        header: table.header,
        rows,
      });
      continue;
    }
    if (htmlBlockStart(text) || disallowedRawHtmlTag(text)) {
      const html: string[] = [];
      while (state.index < state.lines.length && state.lines[state.index]!.raw.trim() !== '') {
        html.push(state.lines[state.index]!.raw.slice(baseIndent));
        state.index++;
      }
      nodes.push({
        kind: 'htmlBlock',
        html: html.join('\n'),
      });
      continue;
    }
    const paragraph: string[] = [text.trim()];
    state.index++;
    while (state.index < state.lines.length && !isBlockStart(state, baseIndent)) {
      const current = state.lines[state.index]!.raw.slice(baseIndent);
      if (paragraph.length === 1 && setextHeading(current)) break;
      paragraph.push(current.trim());
      state.index++;
    }
    const next = state.lines[state.index];
    const setext =
      next && next.indent >= baseIndent ? setextHeading(next.raw.slice(baseIndent)) : undefined;
    if (setext && paragraph.length === 1) {
      nodes.push({
        kind: 'heading',
        level: setext,
        text: paragraph[0]!,
      });
      state.index++;
    } else {
      nodes.push({
        kind: 'paragraph',
        text: paragraph.join('\n'),
      });
    }
  }
  return nodes;
}
function parseList(state: ParseState, baseIndent: number): MarkdownNode | undefined {
  const first = state.lines[state.index];
  if (!first) return undefined;
  const marker = listMarker(first, baseIndent);
  if (!marker) return undefined;
  const ordered = marker.ordered;
  const items: MarkdownListItem[] = [];
  let loose = false;
  while (state.index < state.lines.length) {
    const line = state.lines[state.index]!;
    const current = listMarker(line, baseIndent);
    if (!current || current.ordered !== ordered) break;
    const itemIndent = baseIndent + current.markerWidth;
    const itemLines: string[] = [current.rest];
    state.index++;
    while (state.index < state.lines.length) {
      const next = state.lines[state.index]!;
      if (next.raw.trim() === '') {
        if (!continuesListAfterBlank(state.lines[state.index + 1], baseIndent)) break;
        loose = true;
        itemLines.push('');
        state.index++;
        if (state.index < state.lines.length && listMarker(state.lines[state.index]!, baseIndent))
          break;
        continue;
      }
      if (listMarker(next, baseIndent)) break;
      if (next.indent < baseIndent) break;
      itemLines.push(next.raw.slice(Math.min(itemIndent, next.raw.length)));
      state.index++;
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
    const itemDocument = parseMarkdown(itemLines.join('\n'));
    const item: MarkdownListItem = { nodes: itemDocument.nodes };
    const firstNode = item.nodes[0];
    if (firstNode?.kind === 'paragraph') {
      const task = /^\[([ xX])\]\s+/.exec(firstNode.text);
      if (task) {
        item.task = task[1]!.toLowerCase() === 'x';
        firstNode.text = firstNode.text.slice(task[0]!.length);
      }
    }
    items.push(item);
  }
  return {
    kind: 'list',
    ordered,
    tight: !loose,
    items,
  };
}
/**
 * Parse Markdown into a reusable document tree.
 *
 * Splits the source into block nodes (headings, paragraphs, lists, code,
 * blockquotes, tables, HTML blocks, thematic breaks) and collects
 * reference-style link definitions. Inline spans are left as raw text inside
 * the nodes and are only interpreted when the tree is rendered. Parsing never
 * throws; unrecognized syntax becomes paragraph text.
 *
 * ```ts no_run
 * import { parseMarkdown } from 'fino:format/markdown';
 *
 * const doc = parseMarkdown(`# Changelog
 *
 * - added \`renderCode\` hook
 * - fixed [tables][gfm]
 *
 * [gfm]: https://github.github.com/gfm/`);
 *
 * doc.nodes[0];               // { kind: 'heading', level: 1, text: 'Changelog' }
 * doc.nodes[1]?.kind;         // 'list'
 * doc.references.gfm;         // 'https://github.github.com/gfm/'
 * ```
 */
export function parseMarkdown(markdown: string): MarkdownDocument {
  const scanner = new Scanner(markdown, {
    encoding: 'utf-8',
    format: 'markdown',
  });
  const lines: Line[] = [];
  while (!scanner.done) lines.push(toLine(readLine(scanner) ?? ''));
  const state: ParseState = {
    lines,
    index: 0,
    references: {},
  };
  return {
    nodes: parseBlocks(state),
    references: state.references,
  };
}
function resolveHref(href: string, label: string, options: MarkdownOptions): string | undefined {
  const resolved = options.resolveLink?.(href, label) ?? href;
  return isSafeHref(resolved, options) ? resolved : undefined;
}
function renderLink(label: string, href: string, options: MarkdownOptions): string {
  const resolved = resolveHref(href, label, options);
  if (!resolved) return label;
  return `<a href="${escapeAttribute(resolved)}">${label}</a>`;
}
function renderImage(alt: string, href: string, options: MarkdownOptions): string {
  const resolved = resolveHref(href, alt, options);
  if (!resolved) return escapeHtml(alt);
  return `<img src="${escapeAttribute(resolved)}" alt="${escapeAttribute(alt)}">`;
}
function trimUrlPunctuation(value: string): {
  href: string;
  suffix: string;
} {
  let href = value;
  let suffix = '';
  while (/[.,;:!?)]$/.test(href)) {
    suffix = href.slice(-1) + suffix;
    href = href.slice(0, -1);
  }
  return {
    href,
    suffix,
  };
}
function readLinkDestination(scanner: Scanner): {
  href: string;
  closed: boolean;
} {
  let href = '';
  let depth = 0;
  while (!scanner.done) {
    const char = scanner.eat();
    if (char === '\\' && !scanner.done) {
      href += char + scanner.eat();
      continue;
    }
    if (char === '(') {
      depth++;
      href += char;
      continue;
    }
    if (char === ')') {
      if (depth === 0)
        return {
          href: href.trim(),
          closed: true,
        };
      depth--;
      href += char;
      continue;
    }
    href += char;
  }
  return {
    href: href.trim(),
    closed: false,
  };
}
/**
 * Render inline Markdown spans without wrapping the result in block elements.
 *
 * Interprets emphasis, strong text, code spans, strikethrough, links, images,
 * reference links, bare `http`/`https` autolinks, backslash escapes, and raw
 * inline HTML tags. Emphasis and strong text use asterisk delimiters only
 * (`*em*`, `**strong**`); underscore-delimited emphasis renders as literal
 * text. Everything else is HTML-escaped, and malformed constructs
 * (an unclosed link, a dangling `**`) degrade to escaped literal text.
 * Because block parsing never runs, reference links resolve only against
 * `options.references`. Use this for single-line contexts such as titles,
 * summaries, and table cells where a `<p>` wrapper would be wrong.
 *
 * ```ts no_run
 * import { renderMarkdownInline } from 'fino:format/markdown';
 *
 * renderMarkdownInline('Return the `value` as **HTML**.');
 * // 'Return the <code>value</code> as <strong>HTML</strong>.'
 *
 * renderMarkdownInline('See [Docs][docs].', { references: { docs: '/docs' } });
 * // 'See <a href="/docs">Docs</a>.'
 * ```
 */
export function renderMarkdownInline(markdown: string, options: MarkdownOptions = {}): string {
  const references = Object.assign({}, options.references ?? {});
  const scanner = new Scanner(markdown, {
    encoding: 'utf-8',
    format: 'markdown-inline',
  });
  let html = '';
  while (!scanner.done) {
    if (scanner.match('\\')) {
      if (!scanner.done) html += escapeHtml(scanner.eat());
      else html += '\\';
      continue;
    }
    if (scanner.match('~~')) {
      const text = scanner.eatUntil((value) => value === 126);
      if (scanner.match('~~')) html += `<del>${renderMarkdownInline(text, options)}</del>`;
      else html += '~~' + escapeHtml(text);
      continue;
    }
    if (scanner.match('`')) {
      const code = scanner.eatUntil((value) => value === 96);
      if (scanner.eatChar('`')) html += `<code>${escapeHtml(code)}</code>`;
      else html += '`' + escapeHtml(code);
      continue;
    }
    if (scanner.match('**')) {
      const strong = scanner.eatUntil((value) => value === 42);
      if (scanner.match('**')) html += `<strong>${renderMarkdownInline(strong, options)}</strong>`;
      else html += '**' + escapeHtml(strong);
      continue;
    }
    if (scanner.match('*')) {
      const emphasis = scanner.eatUntil((value) => value === 42);
      if (scanner.eatChar('*')) html += `<em>${renderMarkdownInline(emphasis, options)}</em>`;
      else html += '*' + escapeHtml(emphasis);
      continue;
    }
    if (scanner.match('![')) {
      const alt = scanner.eatUntil((value) => value === 93);
      if (scanner.eatChar(']') && scanner.eatChar('(')) {
        const { href, closed } = readLinkDestination(scanner);
        if (closed) {
          html += renderImage(alt, href, options);
          continue;
        }
        html += `![${escapeHtml(alt)}](${escapeHtml(href)}`;
        continue;
      }
      html += '![' + escapeHtml(alt);
      continue;
    }
    if (scanner.match('[')) {
      const labelSource = scanner.eatUntil((value) => value === 93);
      if (scanner.eatChar(']')) {
        if (scanner.eatChar('(')) {
          const { href, closed } = readLinkDestination(scanner);
          if (closed) {
            const label = renderMarkdownInline(labelSource, options);
            html += renderLink(label, href, options);
            continue;
          }
          html += `[${escapeHtml(labelSource)}](${escapeHtml(href)}`;
          continue;
        }
        if (scanner.eatChar('[')) {
          const id = scanner.eatUntil((value) => value === 93);
          if (scanner.eatChar(']')) {
            const href = references[normalizeReference(id || labelSource)];
            if (href) {
              const label = renderMarkdownInline(labelSource, options);
              html += renderLink(label, href, options);
            } else {
              html += `[${escapeHtml(labelSource)}][${escapeHtml(id)}]`;
            }
            continue;
          }
          html += `[${escapeHtml(labelSource)}][${escapeHtml(id)}`;
          continue;
        }
      }
      html += '[' + escapeHtml(labelSource);
      continue;
    }
    const rawRest = scanner.peek(4096);
    if (rawRest.startsWith('<')) {
      const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>/.exec(rawRest);
      if (tag) {
        scanner.eat(tag[0].length);
        html += renderRawHtml(tag[0], options);
        continue;
      }
    }
    const rest = scanner.peek(8);
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      const raw = scanner.eatUntil((value) => value <= 32);
      const { href, suffix } = trimUrlPunctuation(raw);
      html += renderLink(escapeHtml(href), href, options) + escapeHtml(suffix);
      continue;
    }
    html += escapeHtml(scanner.eat());
  }
  return html;
}
function renderNode(node: MarkdownNode, options: MarkdownOptions, inTightList = false): string {
  if (node.kind === 'paragraph') {
    const body = renderMarkdownInline(node.text, options);
    return inTightList ? body : `<p>${body}</p>`;
  }
  if (node.kind === 'heading') {
    const level = Math.min(6, Math.max(1, node.level + (options.headingOffset ?? 0)));
    return `<h${level}>${renderMarkdownInline(node.text, options)}</h${level}>\n`;
  }
  if (node.kind === 'thematicBreak') return '<hr />\n';
  if (node.kind === 'blockquote') {
    const body = renderNodes(node.nodes, options);
    return `<blockquote>\n${body}${body.endsWith('\n') ? '' : '\n'}</blockquote>\n`;
  }
  if (node.kind === 'htmlBlock') return `${renderRawHtml(node.html, options)}\n`;
  if (node.kind === 'table') return renderTable(node, options);
  if (node.kind === 'list') return renderList(node, options);
  if (options.renderCode) return options.renderCode(node.code, node.lang, node.meta);
  const className = node.lang ? ` class="language-${escapeAttribute(node.lang)}"` : '';
  return `<pre><code${className}>${escapeHtml(node.code)}</code></pre>`;
}
function renderNodes(nodes: MarkdownNode[], options: MarkdownOptions, inTightList = false): string {
  let html = '';
  for (const node of nodes) {
    const rendered = renderNode(node, options, inTightList);
    if (html && !html.endsWith('\n')) html += '\n';
    html += rendered;
  }
  return html;
}
function renderList(
  list: Extract<
    MarkdownNode,
    {
      kind: 'list';
    }
  >,
  options: MarkdownOptions,
): string {
  const tag = list.ordered ? 'ol' : 'ul';
  const output = [`<${tag}>`];
  for (const item of list.items) {
    const body = renderNodes(item.nodes, options, list.tight);
    const task =
      item.task === undefined
        ? ''
        : `<input type="checkbox"${item.task ? ' checked=""' : ''} disabled="" /> `;
    if (list.tight) {
      output.push(`<li>${task}${body}</li>`);
    } else {
      output.push(`<li>`);
      output.push(task ? task + body : body);
      output.push(`</li>`);
    }
  }
  output.push(`</${tag}>`);
  return output.join('\n') + '\n';
}
function renderTable(
  table: Extract<
    MarkdownNode,
    {
      kind: 'table';
    }
  >,
  options: MarkdownOptions,
): string {
  const output = ['<table>', '<thead>', '<tr>'];
  for (let index = 0; index < table.header.length; index++) {
    const align = table.align[index] ? ` align="${table.align[index]}"` : '';
    output.push(`<th${align}>${renderMarkdownInline(table.header[index] ?? '', options)}</th>`);
  }
  output.push('</tr>', '</thead>');
  if (table.rows.length > 0) {
    output.push('<tbody>');
    for (const row of table.rows) {
      output.push('<tr>');
      for (let index = 0; index < table.header.length; index++) {
        const align = table.align[index] ? ` align="${table.align[index]}"` : '';
        output.push(`<td${align}>${renderMarkdownInline(row[index] ?? '', options)}</td>`);
      }
      output.push('</tr>');
    }
    output.push('</tbody>');
  }
  output.push('</table>');
  return output.join('\n') + '\n';
}
/**
 * Render a Markdown document or source string to HTML.
 *
 * A string argument is parsed with `parseMarkdown()` first; passing an
 * already-parsed `MarkdownDocument` skips that step, which is useful when the
 * same document renders more than once or was transformed after parsing.
 * Reference definitions from the document are merged with
 * `options.references`, with the options taking precedence.
 *
 * Output follows the module's safety defaults: raw HTML is escaped and
 * non-`http(s)`, non-relative link URLs are dropped unless the corresponding
 * options opt out.
 *
 * ```ts no_run
 * import { renderMarkdown } from 'fino:format/markdown';
 *
 * renderMarkdown('# Hello\n\nSome *emphasis* and a [link](/docs).');
 * // '<h1>Hello</h1>\n<p>Some <em>emphasis</em> and a <a href="/docs">link</a>.</p>'
 *
 * renderMarkdown('```ts\nconst x = 1;\n```', {
 *   renderCode: (code, lang) => highlight(code, lang),
 * });
 * ```
 */
export function renderMarkdown(
  markdown: string | MarkdownDocument,
  options: MarkdownOptions = {},
): string {
  const document = typeof markdown === 'string' ? parseMarkdown(markdown) : markdown;
  const references = Object.assign({}, document.references, options.references ?? {});
  return renderNodes(document.nodes, {
    ...options,
    references,
  });
}
/**
 * Options controlling Markdown terminal rendering.
 *
 * The defaults render ANSI-colored text wrapped at 80 columns. Set `color`
 * to `false` for plain wrapped text, which also disables syntax highlighting
 * in fenced code blocks.
 *
 * ```ts no_run
 * import { renderMarkdownTerminal, type MarkdownTerminalOptions } from 'fino:format/markdown';
 *
 * const options: MarkdownTerminalOptions = { width: 100, color: true };
 * const text = renderMarkdownTerminal('# Release\n\nShipped **today**.', options);
 * ```
 */
export interface MarkdownTerminalOptions {
  /**
   * Wrap column for paragraphs, headings, quotes, and list items.
   *
   * Code blocks and tables are never wrapped. Defaults to `80`.
   */
  width?: number;
  /**
   * Emit ANSI escape sequences for styling.
   *
   * Defaults to `true`. When disabled the output is plain text: inline code
   * keeps its backticks and code blocks render without highlighting.
   */
  color?: boolean;
  /**
   * Reference-style link definitions used in addition to definitions parsed
   * from the document, matching `MarkdownOptions.references`.
   */
  references?: Record<string, string>;
  /**
   * Render fenced code blocks, replacing the default output.
   *
   * Receives the raw code, the language token, and any trailing info-string
   * metadata, and returns the block's lines without indentation. Without this
   * hook, TypeScript/JavaScript blocks are highlighted with
   * `highlightCodeTerminal()` and other languages render as plain lines.
   */
  renderCode?: (code: string, lang: string, meta: string) => string[];
}
const ANSI_RESET = '\x1b[0m';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const TERMINAL_HIGHLIGHT_LANGUAGES = new Set([
  'ts',
  'mts',
  'cts',
  'tsx',
  'typescript',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'javascript',
]);
const TERMINAL_KEYWORDS = new Set([
  'abstract',
  'any',
  'as',
  'asserts',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unique',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);
function sgr(codes: readonly string[]): string {
  return codes.length === 0 ? '' : `\x1b[${codes.join(';')}m`;
}
function stripControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 9 || code === 10 || code >= 32) {
      if (code !== 127) out += ch;
    }
  }
  return out;
}
function visibleWidth(text: string): number {
  return Array.from(text.replace(ANSI_PATTERN, '')).length;
}
function applyAnsiCodes(active: readonly string[], text: string): string[] {
  let codes = [...active];
  for (const match of text.matchAll(ANSI_PATTERN)) {
    const params = match[0]
      .slice(2, -1)
      .split(';')
      .filter((p) => p !== '');
    if (params.length === 0 || params.includes('0')) codes = [];
    else codes.push(...params);
  }
  return codes;
}
function splitStyledLines(styled: string): string[] {
  const parts = styled.split('\n');
  const lines: string[] = [];
  let active: string[] = [];
  for (const part of parts) {
    const prefix = sgr(active);
    active = applyAnsiCodes(active, part);
    lines.push(prefix + part + (active.length > 0 || prefix !== '' ? ANSI_RESET : ''));
  }
  return lines;
}
function hardSplitStyledWord(word: string, limit: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  let width = 0;
  let index = 0;
  while (index < word.length) {
    ANSI_PATTERN.lastIndex = index;
    const match = ANSI_PATTERN.exec(word);
    if (match && match.index === index) {
      piece += match[0];
      index += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(word.codePointAt(index)!);
    if (width >= limit) {
      pieces.push(piece);
      piece = '';
      width = 0;
    }
    piece += ch;
    width += 1;
    index += ch.length;
  }
  if (piece !== '') pieces.push(piece);
  return pieces.length > 0 ? pieces : [''];
}
function wrapStyledText(styled: string, width: number): string[] {
  const limit = Math.max(1, width);
  const words = styled.split(' ').filter((word) => word !== '');
  const lines: string[] = [];
  let line = '';
  let lineWidth = 0;
  let active: string[] = [];
  const pushLine = (): void => {
    lines.push(line + (applyAnsiCodes([], line).length > 0 ? ANSI_RESET : ''));
    line = sgr(active);
    lineWidth = 0;
  };
  for (const rawWord of words) {
    const parts = visibleWidth(rawWord) > limit ? hardSplitStyledWord(rawWord, limit) : [rawWord];
    for (const word of parts) {
      const wordWidth = visibleWidth(word);
      if (lineWidth > 0 && lineWidth + 1 + wordWidth > limit) pushLine();
      if (lineWidth > 0) {
        line += ' ';
        lineWidth += 1;
      }
      line += word;
      lineWidth += wordWidth;
      active = applyAnsiCodes(active, word);
    }
  }
  if (lineWidth > 0 || lines.length === 0) {
    lines.push(line + (applyAnsiCodes([], line).length > 0 ? ANSI_RESET : ''));
  }
  return lines;
}
interface TerminalRenderContext {
  color: boolean;
  references: Record<string, string>;
  renderCode?: (code: string, lang: string, meta: string) => string[];
}
function terminalSpan(
  codes: readonly string[],
  inner: string,
  active: readonly string[],
  color: boolean,
): string {
  if (!color || codes.length === 0) return inner;
  return sgr(codes) + inner + ANSI_RESET + sgr(active);
}
function renderInlineTerminal(
  markdown: string,
  ctx: TerminalRenderContext,
  active: readonly string[],
): string {
  const scanner = new Scanner(stripControl(markdown), {
    encoding: 'utf-8',
    format: 'markdown-inline',
  });
  let out = '';
  const nested = (source: string, codes: readonly string[]): string =>
    renderInlineTerminal(source, ctx, [...active, ...codes]);
  while (!scanner.done) {
    if (scanner.match('\\')) {
      out += scanner.done ? '\\' : scanner.eat();
      continue;
    }
    if (scanner.match('~~')) {
      const text = scanner.eatUntil((value) => value === 126);
      if (scanner.match('~~')) out += terminalSpan(['9'], nested(text, ['9']), active, ctx.color);
      else out += '~~' + text;
      continue;
    }
    if (scanner.match('`')) {
      const code = scanner.eatUntil((value) => value === 96);
      if (scanner.eatChar('`')) {
        out += ctx.color ? terminalSpan(['36'], code, active, ctx.color) : '`' + code + '`';
      } else {
        out += '`' + code;
      }
      continue;
    }
    if (scanner.match('**')) {
      const strong = scanner.eatUntil((value) => value === 42);
      if (scanner.match('**')) {
        out += terminalSpan(['1'], nested(strong, ['1']), active, ctx.color);
      } else {
        out += '**' + strong;
      }
      continue;
    }
    if (scanner.match('*')) {
      const emphasis = scanner.eatUntil((value) => value === 42);
      if (scanner.eatChar('*')) {
        out += terminalSpan(['3'], nested(emphasis, ['3']), active, ctx.color);
      } else {
        out += '*' + emphasis;
      }
      continue;
    }
    if (scanner.match('![')) {
      const alt = scanner.eatUntil((value) => value === 93);
      if (scanner.eatChar(']') && scanner.eatChar('(')) {
        const { href, closed } = readLinkDestination(scanner);
        if (closed) {
          out += terminalSpan(['2'], `[image: ${alt || href}]`, active, ctx.color);
          continue;
        }
        out += `![${alt}](${href}`;
        continue;
      }
      out += '![' + alt;
      continue;
    }
    if (scanner.match('[')) {
      const labelSource = scanner.eatUntil((value) => value === 93);
      if (scanner.eatChar(']')) {
        if (scanner.eatChar('(')) {
          const { href, closed } = readLinkDestination(scanner);
          if (closed) {
            out += renderTerminalLink(labelSource, href, ctx, active, nested);
            continue;
          }
          out += `[${labelSource}](${href}`;
          continue;
        }
        if (scanner.eatChar('[')) {
          const id = scanner.eatUntil((value) => value === 93);
          if (scanner.eatChar(']')) {
            const href = ctx.references[normalizeReference(id || labelSource)];
            if (href) out += renderTerminalLink(labelSource, href, ctx, active, nested);
            else out += `[${labelSource}][${id}]`;
            continue;
          }
          out += `[${labelSource}][${id}`;
          continue;
        }
      }
      out += '[' + labelSource;
      continue;
    }
    const rawRest = scanner.peek(4096);
    if (rawRest.startsWith('<')) {
      const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>/.exec(rawRest);
      if (tag) {
        scanner.eat(tag[0].length);
        out += tag[0];
        continue;
      }
    }
    const rest = scanner.peek(8);
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      const raw = scanner.eatUntil((value) => value <= 32);
      const { href, suffix } = trimUrlPunctuation(raw);
      out += terminalSpan(['4', '34'], href, active, ctx.color) + suffix;
      continue;
    }
    out += scanner.eat();
  }
  return out;
}
function renderTerminalLink(
  labelSource: string,
  href: string,
  ctx: TerminalRenderContext,
  active: readonly string[],
  nested: (source: string, codes: readonly string[]) => string,
): string {
  const label = terminalSpan(['4', '34'], nested(labelSource, ['4', '34']), active, ctx.color);
  if (labelSource.trim() === href.trim()) return label;
  return label + terminalSpan(['2'], ` (${href})`, active, ctx.color);
}
/**
 * Render inline Markdown spans as a single ANSI-styled line of text.
 *
 * The terminal counterpart of `renderMarkdownInline()`: emphasis, strong
 * text, code spans, strikethrough, links, and autolinks become ANSI styling
 * instead of HTML tags, and no wrapping is applied. Control characters in the
 * source are stripped, so untrusted text cannot inject escape sequences.
 * Reference links resolve only against `references`.
 *
 * ```ts no_run
 * import { renderMarkdownInlineTerminal } from 'fino:format/markdown';
 *
 * renderMarkdownInlineTerminal('Run `fino test` before **pushing**.');
 * // 'Run \x1b[36mfino test\x1b[0m before \x1b[1mpushing\x1b[0m.'
 * ```
 */
export function renderMarkdownInlineTerminal(
  markdown: string,
  options: MarkdownTerminalOptions = {},
): string {
  return renderInlineTerminal(
    markdown,
    {
      color: options.color ?? true,
      references: Object.assign({}, options.references ?? {}),
      renderCode: options.renderCode,
    },
    [],
  );
}
/**
 * Highlight TypeScript or JavaScript code for terminal display.
 *
 * Tokenizes the code with `fino:format/typescript` and colors keywords,
 * strings, numbers, regular expressions, and comments with ANSI sequences,
 * returning one string per source line. Unsupported languages and
 * `color: false` degrade to the plain source lines, so the result is always
 * safe to print.
 *
 * Source that does not parse — a half-written snippet arriving from a model
 * stream, say — falls back to lexical highlighting of comments, strings,
 * numbers, and keywords, so partial code is colored as it is written rather
 * than staying plain until its last brace closes.
 *
 * ```ts no_run
 * import { highlightCodeTerminal } from 'fino:format/markdown';
 *
 * for (const line of highlightCodeTerminal('const x = 1;', 'ts')) {
 *   console.log(line);
 * }
 * ```
 */
export function highlightCodeTerminal(
  code: string,
  lang: string,
  options: { color?: boolean } = {},
): string[] {
  const plain = stripControl(code).replace(/\n$/, '').split('\n');
  if (options.color === false) return plain;
  if (!TERMINAL_HIGHLIGHT_LANGUAGES.has(lang.toLowerCase())) return plain;
  const source = plain.join('\n');
  let parsed;
  try {
    parsed = parseTypeScript(source, {
      sourceType: 'ts',
      tokens: true,
    });
  } catch (_) {
    parsed = undefined;
  }
  const byteToIndex = byteOffsetMap(source);
  const spans =
    parsed && parsed.tokens.length > 0
      ? [
          ...parsed.comments.map((comment) => ({
            start: comment.start,
            end: comment.end,
            kind: 'comment',
          })),
          ...parsed.tokens.map((token) => ({
            start: token.start,
            end: token.end,
            kind: token.kind,
          })),
        ]
          .filter((span) => span.end > span.start)
          .sort((a, b) => a.start - b.start || b.end - a.end)
          .map((span) => ({
            start: byteToIndex[span.start] ?? source.length,
            end: byteToIndex[span.end] ?? source.length,
            codes: terminalTokenCodes(source.slice(span.start, span.end), span.kind),
          }))
      : lexicalSpans(source);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor || span.end <= span.start) continue;
    out += source.slice(cursor, span.start);
    const text = source.slice(span.start, span.end);
    out += span.codes ? sgr([span.codes]) + text + ANSI_RESET : text;
    cursor = span.end;
  }
  out += source.slice(cursor);
  return splitStyledLines(out);
}
/**
 * Colorable spans found without parsing, for source the parser rejects.
 *
 * A single scan recognizes the constructs whose spelling alone identifies
 * them — comments, quoted and template strings, numbers, and keywords —
 * which is everything the token-based path colors apart from regular
 * expressions, and unlike a parse it never fails on unfinished code.
 */
function lexicalSpans(source: string): Array<{ start: number; end: number; codes?: string }> {
  const pattern =
    /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?|\b\d[\w.]*|[A-Za-z_$][\w$]*/g;
  const spans: Array<{ start: number; end: number; codes?: string }> = [];
  for (const match of source.matchAll(pattern)) {
    const text = match[0];
    const head = text[0]!;
    const codes =
      head === '/'
        ? '90'
        : head === '"' || head === "'" || head === '`'
          ? '32'
          : head >= '0' && head <= '9'
            ? '33'
            : TERMINAL_KEYWORDS.has(text)
              ? '35'
              : undefined;
    if (codes) spans.push({ start: match.index, end: match.index + text.length, codes });
  }
  return spans;
}
function byteOffsetMap(source: string): number[] {
  const map: number[] = [];
  let byteOffset = 0;
  for (let index = 0; index < source.length; ) {
    map[byteOffset] = index;
    const codePoint = source.codePointAt(index)!;
    index += codePoint > 65535 ? 2 : 1;
    if (codePoint <= 127) byteOffset += 1;
    else if (codePoint <= 2047) byteOffset += 2;
    else if (codePoint <= 65535) byteOffset += 3;
    else byteOffset += 4;
  }
  map[byteOffset] = source.length;
  return map;
}
function terminalTokenCodes(text: string, kind: string): string | undefined {
  if (kind === 'comment') return '90';
  if (kind === 'jsx' || text.startsWith('"') || text.startsWith("'") || text.startsWith('`'))
    return '32';
  if (
    kind.includes('bigint') ||
    kind === 'decimal' ||
    kind === 'float' ||
    kind === 'binary' ||
    kind === 'octal' ||
    kind === 'hex'
  )
    return '33';
  if (kind === '/regexp/') return '31';
  if (TERMINAL_KEYWORDS.has(kind) || TERMINAL_KEYWORDS.has(text)) return '35';
  return undefined;
}
function renderNodeTerminal(
  node: MarkdownNode,
  ctx: TerminalRenderContext,
  width: number,
): string[] {
  if (node.kind === 'paragraph') {
    const styled = renderInlineTerminal(node.text.replace(/\s+/g, ' ').trim(), ctx, []);
    return wrapStyledText(styled, width);
  }
  if (node.kind === 'heading') {
    const codes = ctx.color ? ['1', node.level <= 2 ? '36' : '37'] : [];
    const text = `${'#'.repeat(node.level)} ${node.text.replace(/\s+/g, ' ').trim()}`;
    const styled = ctx.color
      ? sgr(codes) + renderInlineTerminal(text, ctx, codes) + ANSI_RESET
      : renderInlineTerminal(text, ctx, []);
    return wrapStyledText(styled, width);
  }
  if (node.kind === 'thematicBreak') {
    const rule = '─'.repeat(Math.max(1, Math.min(width, 80)));
    return [ctx.color ? sgr(['2']) + rule + ANSI_RESET : rule];
  }
  if (node.kind === 'blockquote') {
    const inner = renderNodesTerminal(node.nodes, ctx, Math.max(1, width - 2));
    const bar = ctx.color ? sgr(['2']) + '│' + ANSI_RESET + ' ' : '│ ';
    return inner.map((line) => (line === '' ? bar.trimEnd() : bar + line));
  }
  if (node.kind === 'htmlBlock') {
    return stripControl(node.html).replace(/\n$/, '').split('\n');
  }
  if (node.kind === 'table') return renderTableTerminal(node, ctx, width);
  if (node.kind === 'list') return renderListTerminal(node, ctx, width);
  const codeLines =
    ctx.renderCode?.(node.code, node.lang, node.meta) ??
    highlightCodeTerminal(node.code, node.lang, { color: ctx.color });
  return codeLines.map((line) => '    ' + line);
}
function renderNodesTerminal(
  nodes: MarkdownNode[],
  ctx: TerminalRenderContext,
  width: number,
): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const rendered = renderNodeTerminal(node, ctx, width);
    if (lines.length > 0 && rendered.length > 0) lines.push('');
    lines.push(...rendered);
  }
  return lines;
}
function renderListTerminal(
  list: Extract<MarkdownNode, { kind: 'list' }>,
  ctx: TerminalRenderContext,
  width: number,
): string[] {
  const lines: string[] = [];
  const markerWidth = list.ordered ? String(list.items.length).length + 2 : 2;
  for (let index = 0; index < list.items.length; index++) {
    const item = list.items[index]!;
    const marker = list.ordered
      ? `${String(index + 1)}.`.padEnd(markerWidth, ' ')
      : '•'.padEnd(markerWidth, ' ');
    const task = item.task === undefined ? '' : item.task ? '[x] ' : '[ ] ';
    const indent = ' '.repeat(markerWidth + task.length);
    const inner = renderNodesTerminal(item.nodes, ctx, Math.max(1, width - indent.length));
    if (!list.tight && lines.length > 0) lines.push('');
    if (inner.length === 0) {
      lines.push((marker + task).trimEnd());
      continue;
    }
    lines.push(marker + task + inner[0]);
    for (let rest = 1; rest < inner.length; rest++) {
      const line = inner[rest]!;
      lines.push(line === '' ? '' : indent + line);
    }
  }
  return lines;
}
function renderTableTerminal(
  table: Extract<MarkdownNode, { kind: 'table' }>,
  ctx: TerminalRenderContext,
  width: number,
): string[] {
  const headerCells = table.header.map((cell) => renderInlineTerminal(cell, ctx, []));
  const rowCells = table.rows.map((row) =>
    table.header.map((_, index) => renderInlineTerminal(row[index] ?? '', ctx, [])),
  );
  const widths = table.header.map((_, index) =>
    Math.max(
      visibleWidth(headerCells[index] ?? ''),
      ...rowCells.map((row) => visibleWidth(row[index] ?? '')),
      1,
    ),
  );
  const pad = (cell: string, index: number): string => {
    const gap = widths[index]! - visibleWidth(cell);
    if (gap <= 0) return cell;
    if (table.align[index] === 'right') return ' '.repeat(gap) + cell;
    if (table.align[index] === 'center') {
      const left = Math.floor(gap / 2);
      return ' '.repeat(left) + cell + ' '.repeat(gap - left);
    }
    return cell + ' '.repeat(gap);
  };
  const joinRow = (cells: string[]): string =>
    cells
      .map((cell, index) => pad(cell, index))
      .join('  ')
      .trimEnd();
  const header = joinRow(headerCells);
  const rule = widths.map((w) => '─'.repeat(w)).join('  ');
  const lines = [
    ctx.color ? sgr(['1']) + header + ANSI_RESET : header,
    ctx.color ? sgr(['2']) + rule + ANSI_RESET : rule,
  ];
  for (const row of rowCells) lines.push(joinRow(row));
  void width;
  return lines;
}
/**
 * Render a Markdown document or source string as ANSI-styled terminal text.
 *
 * The terminal counterpart of `renderMarkdown()`: the same parsed
 * `MarkdownDocument` tree renders to word-wrapped text with ANSI styling —
 * bold headings, `│`-prefixed blockquotes, hanging-indent lists, aligned
 * tables, dim rules, and syntax-highlighted TypeScript/JavaScript code
 * blocks. Control characters in the source are stripped before styling is
 * applied, so untrusted Markdown (such as model output) cannot inject its own
 * escape sequences. Code blocks and tables are never wrapped; everything else
 * wraps at `width`.
 *
 * ```ts no_run
 * import { renderMarkdownTerminal } from 'fino:format/markdown';
 *
 * const text = renderMarkdownTerminal(assistantReply, { width: 100 });
 * console.log(text);
 * ```
 */
export function renderMarkdownTerminal(
  markdown: string | MarkdownDocument,
  options: MarkdownTerminalOptions = {},
): string {
  const document = typeof markdown === 'string' ? parseMarkdown(markdown) : markdown;
  const references = Object.assign({}, document.references, options.references ?? {});
  const ctx: TerminalRenderContext = {
    color: options.color ?? true,
    references,
    renderCode: options.renderCode,
  };
  return renderNodesTerminal(document.nodes, ctx, Math.max(1, options.width ?? 80)).join('\n');
}
/**
 * Length of the leading run of `markdown` whose rendering can no longer
 * change as more text arrives.
 *
 * Text is only settled at a blank line that closes a block outright: inside a
 * fence more code is still coming, and a blank line followed by a list
 * marker, quote, table row, or indented line may be a loose continuation of
 * the block above it.
 */
function settledMarkdownLength(markdown: string): number {
  const lines = markdown.split('\n');
  let offset = 0;
  let settled = 0;
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = offset + line.length + 1;
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && line.trim() === '') {
      const following = lines.slice(index + 1).find((candidate) => candidate.trim() !== '');
      if (following !== undefined && /^(?![\s>|])(?!([-*+]|\d+[.)])\s)/.test(following)) {
        settled = next;
      }
    }
    offset = next;
  }
  return settled;
}
/**
 * Incremental terminal renderer for markdown that is still arriving.
 *
 * Re-rendering a whole message on every delta costs milliseconds per frame
 * once it grows past a few KB, which a live view cannot afford. This keeps
 * the rendered lines of blocks that can no longer change and re-renders only
 * the block currently being written, so output is highlighted continuously
 * rather than staying plain until the message ends.
 *
 * One instance renders one message at one width; make a new one when either
 * changes.
 *
 * ```ts no_run
 * import { MarkdownTerminalStream } from 'fino:format/markdown';
 *
 * const stream = new MarkdownTerminalStream({ width: 80 });
 * let text = '';
 * for await (const delta of deltas) {
 *   text += delta;
 *   paint(stream.render(text));
 * }
 * ```
 */
export class MarkdownTerminalStream {
  #options: MarkdownTerminalOptions;
  #settled = 0;
  #lines: string[] = [];
  #mode: 'render' | 'commit' | null = null;
  #emitted = false;
  #done = false;
  constructor(options: MarkdownTerminalOptions = {}) {
    this.#options = options;
  }
  /**
   * Render everything received so far, as terminal lines.
   *
   * `markdown` is the whole message, not just the newest delta.
   */
  render(markdown: string): string[] {
    if (this.#mode === 'commit') {
      throw new Error('render() cannot be used on a MarkdownTerminalStream after commit() or finish()');
    }
    this.#mode = 'render';
    const settled = this.#settled + settledMarkdownLength(markdown.slice(this.#settled));
    if (settled > this.#settled) {
      this.#lines = this.#join(this.#lines, this.#block(markdown.slice(this.#settled, settled)));
      this.#settled = settled;
    }
    return this.#join(this.#lines, this.#block(markdown.slice(this.#settled)));
  }
  /**
   * Flush the lines that settled since the last `commit()`, plus a fresh
   * render of the still-open tail.
   *
   * `markdown` is the whole message so far, as with `render()`. Returned
   * `lines` are final: they carry their own leading blank separator, are
   * never re-emitted, and are dropped from the stream's state so memory
   * stays proportional to the open block rather than the whole message.
   * Concatenating every `lines` array with the last `tail` reproduces what
   * `render()` would return for the same input.
   */
  commit(markdown: string): { lines: string[]; tail: string[] } {
    this.#enterCommit();
    return {
      lines: this.#flushSettled(markdown),
      tail: this.#separated(this.#block(markdown.slice(this.#settled))),
    };
  }
  /**
   * Flush everything not yet committed — remaining settled lines and the
   * final render of the open tail — and mark the stream done.
   *
   * Any later `render()`, `commit()`, or `finish()` call throws.
   */
  finish(markdown: string): string[] {
    this.#enterCommit();
    const lines = this.#flushSettled(markdown);
    const tail = this.#separated(this.#block(markdown.slice(this.#settled)));
    this.#done = true;
    return [...lines, ...tail];
  }
  #enterCommit(): void {
    if (this.#mode === 'render') {
      throw new Error('commit() and finish() cannot be used on a MarkdownTerminalStream after render()');
    }
    if (this.#done) throw new Error('MarkdownTerminalStream is already finished');
    this.#mode = 'commit';
  }
  #flushSettled(markdown: string): string[] {
    const settled = this.#settled + settledMarkdownLength(markdown.slice(this.#settled));
    if (settled <= this.#settled) return [];
    const block = this.#block(markdown.slice(this.#settled, settled));
    this.#settled = settled;
    if (block.length === 0) return [];
    const lines = this.#separated(block);
    this.#emitted = true;
    return lines;
  }
  // The blank separator between blocks belongs to the start of the later
  // block: a commit whose block ends the message must not leave a dangling
  // blank line, so concatenated commits + tail stay identical to render().
  #separated(lines: string[]): string[] {
    if (lines.length === 0 || !this.#emitted) return lines;
    return ['', ...lines];
  }
  #block(markdown: string): string[] {
    const rendered = renderMarkdownTerminal(markdown, this.#options);
    return rendered.length === 0 ? [] : rendered.split('\n');
  }
  // Blocks are separated by one blank line, matching what a single render of
  // the whole text emits.
  #join(head: string[], next: string[]): string[] {
    if (head.length === 0) return next;
    if (next.length === 0) return head;
    return [...head, '', ...next];
  }
}
