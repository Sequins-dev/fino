/**
* fino:format/markdown - safe Markdown parser and HTML renderer for documentation and templates.
*
* This module implements a practical CommonMark/GFM-oriented Markdown surface
* in TypeScript. It supports headings, paragraphs, blockquotes, thematic
* breaks, fenced code, nested ordered and unordered lists, task-list markers,
* GFM tables, reference links, autolinks, emphasis, strong text, code spans,
* strikethrough, links, images, and raw HTML with safe defaults.
*
* Parsing and rendering are split: `parseMarkdown()` produces a
* `MarkdownDocument` block tree that can be inspected, transformed, or
* rendered multiple times with different options, while `renderMarkdown()`
* accepts either a source string or a parsed document and emits HTML.
* `renderMarkdownInline()` renders span-level Markdown without wrapping the
* result in block elements, which suits one-line summaries and table cells.
* The parser never throws — malformed constructs fall back to escaped literal
* text rather than errors.
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
export type MarkdownNode = {
  kind: 'paragraph';
  text: string;
} | {
  kind: 'heading';
  level: number;
  text: string;
} | {
  kind: 'list';
  ordered: boolean;
  tight: boolean;
  items: MarkdownListItem[];
} | {
  kind: 'code';
  lang: string;
  meta: string;
  code: string;
} | {
  kind: 'blockquote';
  nodes: MarkdownNode[];
} | {
  kind: 'thematicBreak';
} | {
  kind: 'htmlBlock';
  html: string;
} | {
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
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    indent: spaces
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
    meta: match?.[2]?.trim() ?? ''
  };
}
function referenceDefinition(line: string): {
  id: string;
  href: string;
} | undefined {
  const match = /^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+.*)?$/.exec(line);
  if (!match) return undefined;
  return {
    id: normalizeReference(match[1]!),
    href: match[2]!
  };
}
function listMarker(line: Line, baseIndent: number): {
  ordered: boolean;
  rest: string;
  markerWidth: number;
} | undefined {
  if (line.indent < baseIndent) return undefined;
  const current = line.raw.slice(baseIndent);
  const unordered = /^([-*+])\s+(.+)$/.exec(current);
  if (unordered) return {
    ordered: false,
    rest: unordered[2]!,
    markerWidth: unordered[1]!.length + 1
  };
  const ordered = /^(\d+[.)])\s+(.+)$/.exec(current);
  if (ordered) return {
    ordered: true,
    rest: ordered[2]!,
    markerWidth: ordered[1]!.length + 1
  };
  return undefined;
}
function thematicBreak(line: string): boolean {
  return /^(?: {0,3})([-*_])(?:\s*\1){2,}\s*$/.test(line);
}
function heading(line: string): {
  level: number;
  text: string;
} | undefined {
  const match = /^(#{1,6})(?:\s+|$)(.*?)(?:\s+#+\s*)?$/.exec(line);
  if (!match) return undefined;
  return {
    level: match[1]!.length,
    text: match[2]!.trim()
  };
}
function setextHeading(line: string): 1 | 2 | undefined {
  if (/^=+\s*$/.test(line)) return 1;
  if (/^-+\s*$/.test(line)) return 2;
  return undefined;
}
function htmlBlockStart(line: string): boolean {
  return /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/>)/i.test(line) || /^<!--/.test(line) || /^<\?/.test(line) || /^<![A-Z]/.test(line) || /^<!\[CDATA\[/.test(line);
}
function disallowedRawHtmlTag(line: string): boolean {
  return /^<\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?=\s|>|\/>)/i.test(line);
}
function renderRawHtml(html: string, options: MarkdownOptions): string {
  if (!options.allowRawHtml) return escapeHtml(html);
  return html.replace(/<\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?=\s|>|\/>)/gi, (tag) => `&lt;${tag.slice(1)}`);
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
function tableStart(state: ParseState): {
  align: TableAlign[];
  header: string[];
} | undefined {
  const header = state.lines[state.index];
  const delimiter = state.lines[state.index + 1];
  if (!header || !delimiter || !header.raw.includes('|')) return undefined;
  const align = parseTableDelimiter(delimiter.text);
  if (!align) return undefined;
  const cells = splitTableRow(header.text);
  if (cells.length !== align.length) return undefined;
  return {
    align,
    header: cells
  };
}
function isBlockStart(state: ParseState, baseIndent: number): boolean {
  const line = state.lines[state.index];
  if (!line || line.raw.trim() === '') return true;
  if (line.indent < baseIndent) return true;
  const text = line.raw.slice(baseIndent);
  return Boolean(referenceDefinition(line.raw) || /^```/.test(text) || heading(text) || thematicBreak(text) || /^> ?/.test(text) || listMarker(line, baseIndent) || htmlBlockStart(text) || tableStart(state));
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
      while (state.index < state.lines.length && !/^```\s*$/.test(state.lines[state.index]!.raw.slice(baseIndent))) {
        const current = state.lines[state.index]!;
        code.push(current.raw.slice(Math.min(baseIndent, current.raw.length)));
        state.index++;
      }
      if (state.index < state.lines.length) state.index++;
      nodes.push({
        kind: 'code',
        lang: info.lang,
        meta: info.meta,
        code: code.join('\n')
      });
      continue;
    }
    const atx = heading(text);
    if (atx) {
      nodes.push({
        kind: 'heading',
        level: atx.level,
        text: atx.text
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
        nodes: parseMarkdown(quoteLines.join('\n')).nodes
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
        if (current.raw.trim() === '' || !current.raw.includes('|') || current.indent < baseIndent) break;
        rows.push(splitTableRow(current.text));
        state.index++;
      }
      nodes.push({
        kind: 'table',
        align: table.align,
        header: table.header,
        rows
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
        html: html.join('\n')
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
    const setext = next && next.indent >= baseIndent ? setextHeading(next.raw.slice(baseIndent)) : undefined;
    if (setext && paragraph.length === 1) {
      nodes.push({
        kind: 'heading',
        level: setext,
        text: paragraph[0]!
      });
      state.index++;
    } else {
      nodes.push({
        kind: 'paragraph',
        text: paragraph.join('\n')
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
        if (state.index < state.lines.length && listMarker(state.lines[state.index]!, baseIndent)) break;
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
    items
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
    format: 'markdown'
  });
  const lines: Line[] = [];
  while (!scanner.done) lines.push(toLine(readLine(scanner) ?? ''));
  const state: ParseState = {
    lines,
    index: 0,
    references: {}
  };
  return {
    nodes: parseBlocks(state),
    references: state.references
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
    suffix
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
      if (depth === 0) return {
        href: href.trim(),
        closed: true
      };
      depth--;
      href += char;
      continue;
    }
    href += char;
  }
  return {
    href: href.trim(),
    closed: false
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
    format: 'markdown-inline'
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
function renderList(list: Extract<MarkdownNode, {
  kind: 'list';
}>, options: MarkdownOptions): string {
  const tag = list.ordered ? 'ol' : 'ul';
  const output = [`<${tag}>`];
  for (const item of list.items) {
    const body = renderNodes(item.nodes, options, list.tight);
    const task = item.task === undefined ? '' : `<input type="checkbox"${item.task ? ' checked=""' : ''} disabled="" /> `;
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
function renderTable(table: Extract<MarkdownNode, {
  kind: 'table';
}>, options: MarkdownOptions): string {
  const output = [
    '<table>',
    '<thead>',
    '<tr>'
  ];
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
export function renderMarkdown(markdown: string | MarkdownDocument, options: MarkdownOptions = {}): string {
  const document = typeof markdown === 'string' ? parseMarkdown(markdown) : markdown;
  const references = Object.assign({}, document.references, options.references ?? {});
  return renderNodes(document.nodes, {
    ...options,
    references
  });
}
