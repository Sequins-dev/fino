/**
 * fino:format/markdown - safe Markdown parser and HTML renderer for documentation and templates.
 *
 * This module provides a deliberately small Markdown surface for generated
 * documentation, templates, and user-facing text where predictable HTML output
 * matters more than implementing every extension in the Markdown ecosystem.
 * It parses Markdown into a reusable block tree and renders escaped HTML with
 * safe link handling by default.
 *
 * Supported block nodes include paragraphs, ATX headings, ordered and
 * unordered lists, fenced code blocks, and reference-style link definitions.
 * Inline rendering handles emphasis-style text as plain escaped content plus
 * links and code spans used by the documentation generator. Link URLs are
 * limited to relative URLs and `http`/`https` unless `allowUnsafeLinks` is set.
 *
 * The renderer is not a CommonMark or GFM compliance target and does not
 * execute or sanitize arbitrary embedded HTML. Nested list structure,
 * blockquotes, tables, Setext headings, thematic breaks, HTML blocks, and full
 * emphasis/link grammar are outside this release contract; unsupported block
 * forms are rendered as escaped paragraph text. Treat Markdown as content input
 * and use `resolveLink` or `renderCode` to adapt it to an application's
 * routing and syntax-highlighting needs.
 *
 * ```ts no_run
 * import { parseMarkdown, renderMarkdown } from 'fino:format/markdown';
 *
 * const doc = parseMarkdown('# Title\n\nSee [docs](/docs).\n');
 * const html = renderMarkdown(doc, { headingOffset: 1 });
 * ```
 *
 * ```ts no_run
 * import { renderMarkdown } from 'fino:format/markdown';
 *
 * const html = renderMarkdown('```ts\nconst x = 1;\n```', {
 *   renderCode: (code, lang) => `<pre data-lang="${lang}">${code}</pre>`,
 * });
 * ```
 *
 * Useful references:
 *   - CommonMark overview: https://commonmark.org/
 *   - Markdown original syntax: https://daringfireball.net/projects/markdown/syntax
 */

import { Scanner } from '../parsing/scanner.mts';

/**
 * Options controlling Markdown HTML rendering, link safety, and code output.
 *
 * By default the renderer escapes Markdown text, allows relative and
 * `http`/`https` links, renders headings at their source level, and emits
 * fenced code blocks as `<pre><code>`. Override these hooks when routing links
 * through an application or adding syntax highlighting.
 *
 * ```ts no_run
 * import { renderMarkdown, type MarkdownOptions } from 'fino:format/markdown';
 *
 * const options: MarkdownOptions = {
 *   headingOffset: 1,
 *   resolveLink: (href) => href.startsWith('/') ? `/docs${href}` : href,
 * };
 *
 * renderMarkdown('# Title\n\n[Guide](/guide)', options);
 * ```
 */
export interface MarkdownOptions {
  /**
   * Allow link URLs outside the default safe set.
   *
   * Defaults to `false`. When disabled, absolute URLs are limited to `http` and
   * `https`, protocol URLs such as `javascript:` are omitted, and unsafe links
   * render as their label text. Enabling this option does not sanitize the URL.
   *
   * ```ts no_run
   * import { renderMarkdownInline } from 'fino:format/markdown';
   *
   * renderMarkdownInline('[run](javascript:alert(1))', {
   *   allowUnsafeLinks: true,
   * });
   * ```
   */
  allowUnsafeLinks?: boolean;

  /**
   * Add this many levels to rendered Markdown headings.
   *
   * Defaults to `0`. Output heading levels are clamped to the HTML range
   * `h1` through `h6`, which is useful when embedding Markdown below an
   * existing page heading.
   *
   * ```ts no_run
   * import { renderMarkdown } from 'fino:format/markdown';
   *
   * renderMarkdown('# Section', { headingOffset: 2 }); // <h3>Section</h3>
   * ```
   */
  headingOffset?: number;

  /**
   * Reference-style link definitions to use in addition to definitions parsed from the document.
   *
   * Keys are normalized like Markdown reference labels: trimmed, collapsed
   * whitespace, and lower-cased. Parsed document references override nothing;
   * renderer options are merged in before inline rendering.
   *
   * ```ts no_run
   * import { renderMarkdownInline } from 'fino:format/markdown';
   *
   * renderMarkdownInline('[API][api]', {
   *   references: { api: 'https://example.test/api' },
   * });
   * ```
   */
  references?: Record<string, string>;

  /**
   * Rewrite link URLs while rendering.
   *
   * Return a replacement URL or `undefined` to keep the original. The resulting
   * URL is still checked by the safe-link policy unless `allowUnsafeLinks` is
   * enabled.
   *
   * ```ts no_run
   * import { renderMarkdown } from 'fino:format/markdown';
   *
   * renderMarkdown('[Home](/)', {
   *   resolveLink: (href, label) => href === '/' ? `/docs?from=${label}` : href,
   * });
   * ```
   */
  resolveLink?: (href: string, label: string) => string | undefined;

  /**
   * Render fenced code blocks.
   *
   * When omitted, code is escaped and wrapped in `<pre><code>`, with
   * `class="language-..."` when a language is present. Custom renderers receive
   * the raw code text, language, and trailing fence metadata and must escape
   * their own HTML output as needed.
   *
   * ```ts no_run
   * import { renderMarkdown } from 'fino:format/markdown';
   *
   * renderMarkdown('```ts title=demo\nconst x = 1;\n```', {
   *   renderCode: (code, lang, meta) =>
   *     `<pre data-lang="${lang}" data-meta="${meta}">${code}</pre>`,
   * });
   * ```
   */
  renderCode?: (code: string, lang: string, meta: string) => string;
}

/**
 * Block-level node returned by the Markdown parser.
 *
 * The parser produces paragraph, heading, list, and fenced-code nodes. Inline
 * Markdown is intentionally left in string fields until rendering, so callers
 * can inspect or transform block structure without losing the original inline
 * text. The node union does not represent arbitrary CommonMark extensions.
 *
 * ```ts no_run
 * import { parseMarkdown, type MarkdownNode } from 'fino:format/markdown';
 *
 * const first: MarkdownNode | undefined = parseMarkdown('# Title').nodes[0];
 * if (first?.kind === 'heading') console.log(first.level, first.text);
 * ```
 */
export type MarkdownNode =
  | {
    /**
     * Discriminator for paragraph nodes.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * parseMarkdown('Body').nodes[0]?.kind;
     * ```
     */
    kind: 'paragraph';
    /**
     * Paragraph text with source lines joined by spaces.
     *
     * Inline Markdown remains unrendered until `renderMarkdownInline()` or
     * `renderMarkdown()` is called.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('Hello **world**').nodes[0];
     * if (node?.kind === 'paragraph') node.text;
     * ```
     */
    text: string;
  }
  | {
    /**
     * Discriminator for heading nodes.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * parseMarkdown('# Title').nodes[0]?.kind;
     * ```
     */
    kind: 'heading';
    /**
     * Heading level from 1 through 6 before render-time offsetting.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('## Title').nodes[0];
     * if (node?.kind === 'heading') node.level;
     * ```
     */
    level: number;
    /**
     * Heading text without the leading hash markers.
     *
     * Inline Markdown remains unrendered until HTML rendering.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('# Title').nodes[0];
     * if (node?.kind === 'heading') node.text;
     * ```
     */
    text: string;
  }
  | {
    /**
     * Discriminator for list nodes.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * parseMarkdown('- item').nodes[0]?.kind;
     * ```
     */
    kind: 'list';
    /**
     * Whether the list was parsed from ordered markers.
     *
     * `true` renders as `<ol>` and `false` renders as `<ul>`.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('1. item').nodes[0];
     * if (node?.kind === 'list') node.ordered;
     * ```
     */
    ordered: boolean;
    /**
     * List item text values in source order.
     *
     * Nested lists are not represented by this compact parser.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('- a\n- b').nodes[0];
     * if (node?.kind === 'list') node.items;
     * ```
     */
    items: string[];
  }
  | {
    /**
     * Discriminator for fenced code block nodes.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * parseMarkdown('```ts\nx\n```').nodes[0]?.kind;
     * ```
     */
    kind: 'code';
    /**
     * Fence language identifier, or `""` when none is provided.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('```ts\nx\n```').nodes[0];
     * if (node?.kind === 'code') node.lang;
     * ```
     */
    lang: string;
    /**
     * Remaining fence info string after the language identifier.
     *
     * The value is trimmed and may be `""`.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('```ts title=demo\nx\n```').nodes[0];
     * if (node?.kind === 'code') node.meta;
     * ```
     */
    meta: string;
    /**
     * Code block contents without the opening or closing fence.
     *
     * The parser preserves internal newlines and does not syntax-highlight.
     *
     * ```ts no_run
     * import { parseMarkdown } from 'fino:format/markdown';
     *
     * const node = parseMarkdown('```\nconst x = 1;\n```').nodes[0];
     * if (node?.kind === 'code') node.code;
     * ```
     */
    code: string;
  };

/**
 * Parsed Markdown tree and reference-style link definitions.
 *
 * `nodes` contains block-level content in source order. `references` contains
 * link definitions parsed from lines such as `[id]: https://example.test`; it
 * is merged with `MarkdownOptions.references` during rendering.
 *
 * ```ts no_run
 * import { parseMarkdown, type MarkdownDocument } from 'fino:format/markdown';
 *
 * const document: MarkdownDocument = parseMarkdown('[docs]: /docs\n\nSee [docs][].');
 * console.log(document.references.docs);
 * ```
 */
export interface MarkdownDocument {
  /**
   * Block nodes in source order.
   *
   * Empty lines and reference definitions are not represented as nodes.
   *
   * ```ts no_run
   * import { parseMarkdown } from 'fino:format/markdown';
   *
   * const nodes = parseMarkdown('# A\n\nB').nodes;
   * nodes.map((node) => node.kind);
   * ```
   */
  nodes: MarkdownNode[];
  /**
   * Normalized reference-style link definitions parsed from the document.
   *
   * Missing references leave the original reference syntax escaped in rendered
   * output. Values are not safety-checked until rendering.
   *
   * ```ts no_run
   * import { parseMarkdown } from 'fino:format/markdown';
   *
   * const refs = parseMarkdown('[api]: https://example.test\n').references;
   * refs.api;
   * ```
   */
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
  const line = scanner.eatUntil((code) => code === 0x0A || code === 0x0D);
  if (scanner.match('\r\n')) return line;
  scanner.eatChar('\n') || scanner.eatChar('\r');
  return line;
}

function splitFenceInfo(info: string): { lang: string; meta: string } {
  const trimmed = info.trim();
  const match = /^(\S+)?\s*(.*)$/.exec(trimmed);
  return {
    lang: match?.[1] ?? '',
    meta: match?.[2]?.trim() ?? '',
  };
}

function referenceDefinition(line: string): { id: string; href: string } | undefined {
  const match = /^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+.*)?$/.exec(line);
  if (!match) return undefined;
  return { id: normalizeReference(match[1]!), href: match[2]! };
}

/**
 * Parse Markdown into a reusable document tree.
 *
 * The parser recognizes a compact block subset: paragraphs, ATX headings,
 * ordered and unordered lists, fenced code blocks, and reference definitions.
 * It does not throw for most Markdown oddities; unsupported constructs are
 * usually folded into paragraphs or escaped later by the renderer.
 *
 * ```ts no_run
 * import { parseMarkdown } from 'fino:format/markdown';
 *
 * const document = parseMarkdown('# Title\n\n- one\n- two\n');
 * const list = document.nodes.find((node) => node.kind === 'list');
 * ```
 */
export function parseMarkdown(markdown: string): MarkdownDocument {
  const scanner = new Scanner(markdown, { encoding: 'utf-8', format: 'markdown' });
  const lines: string[] = [];
  while (!scanner.done) lines.push(readLine(scanner) ?? '');

  const nodes: MarkdownNode[] = [];
  const references: Record<string, string> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      index++;
      continue;
    }

    const reference = referenceDefinition(line);
    if (reference) {
      references[reference.id] = reference.href;
      index++;
      continue;
    }

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const info = splitFenceInfo(fence[1] ?? '');
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index++;
      }
      if (index < lines.length) index++;
      nodes.push({ kind: 'code', lang: info.lang, meta: info.meta, code: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      nodes.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      index++;
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const orderedList = ordered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const item = orderedList ? /^\s*\d+\.\s+(.+)$/.exec(current) : /^\s*[-*+]\s+(.+)$/.exec(current);
        if (!item) break;
        items.push(item[1]!.trim());
        index++;
      }
      nodes.push({ kind: 'list', ordered: orderedList, items });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index++;
    while (index < lines.length
      && lines[index]!.trim() !== ''
      && !/^\s*```/.test(lines[index]!)
      && !/^(#{1,6})\s+/.test(lines[index]!)
      && !/^\s*[-*+]\s+/.test(lines[index]!)
      && !/^\s*\d+\.\s+/.test(lines[index]!)
      && !referenceDefinition(lines[index]!)) {
      paragraph.push(lines[index]!.trim());
      index++;
    }
    nodes.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return { nodes, references };
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

function trimUrlPunctuation(value: string): { href: string; suffix: string } {
  let href = value;
  let suffix = '';
  while (/[.,;:!?)]$/.test(href)) {
    suffix = href.slice(-1) + suffix;
    href = href.slice(0, -1);
  }
  return { href, suffix };
}

function readLinkDestination(scanner: Scanner): { href: string; closed: boolean } {
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
      if (depth === 0) return { href: href.trim(), closed: true };
      depth--;
      href += char;
      continue;
    }
    href += char;
  }

  return { href: href.trim(), closed: false };
}

/**
 * Render inline Markdown spans without wrapping the result in block elements.
 *
 * Inline rendering escapes text, supports code spans, emphasis, strong text,
 * images, inline links, reference links, and auto-linked `http`/`https` URLs.
 * Unsafe or unresolved links are rendered as escaped label text instead of
 * anchors. The output is an HTML fragment.
 *
 * ```ts no_run
 * import { renderMarkdownInline } from 'fino:format/markdown';
 *
 * const html = renderMarkdownInline('Use `code` and [docs](/docs).');
 * ```
 */
export function renderMarkdownInline(markdown: string, options: MarkdownOptions = {}): string {
  const references = Object.assign({}, options.references ?? {});
  const scanner = new Scanner(markdown, { encoding: 'utf-8', format: 'markdown-inline' });
  let html = '';

  while (!scanner.done) {
    if (scanner.match('\\')) {
      if (!scanner.done) html += escapeHtml(scanner.eat());
      else html += '\\';
      continue;
    }

    if (scanner.match('`')) {
      const code = scanner.eatUntil((value) => value === 0x60);
      if (scanner.eatChar('`')) html += `<code>${escapeHtml(code)}</code>`;
      else html += '`' + escapeHtml(code);
      continue;
    }

    if (scanner.match('**')) {
      const strong = scanner.eatUntil((value) => value === 0x2A);
      if (scanner.match('**')) html += `<strong>${renderMarkdownInline(strong, options)}</strong>`;
      else html += '**' + escapeHtml(strong);
      continue;
    }

    if (scanner.match('*')) {
      const emphasis = scanner.eatUntil((value) => value === 0x2A);
      if (scanner.eatChar('*')) html += `<em>${renderMarkdownInline(emphasis, options)}</em>`;
      else html += '*' + escapeHtml(emphasis);
      continue;
    }

    if (scanner.match('![')) {
      const alt = scanner.eatUntil((value) => value === 0x5D);
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
      const labelSource = scanner.eatUntil((value) => value === 0x5D);
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
          const id = scanner.eatUntil((value) => value === 0x5D);
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

    const rest = scanner.peek(8);
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      const raw = scanner.eatUntil((value) => value <= 0x20);
      const { href, suffix } = trimUrlPunctuation(raw);
      html += renderLink(escapeHtml(href), href, options) + escapeHtml(suffix);
      continue;
    }

    html += escapeHtml(scanner.eat());
  }

  return html;
}

/**
 * Render a Markdown document or source string to HTML.
 *
 * String input is parsed first; passing a `MarkdownDocument` reuses an existing
 * block tree. The renderer joins block HTML with newlines, escapes text by
 * default, and uses `renderCode` for fenced code blocks when supplied.
 *
 * ```ts no_run
 * import { parseMarkdown, renderMarkdown } from 'fino:format/markdown';
 *
 * const document = parseMarkdown('# Title\n\nBody');
 * const html = renderMarkdown(document, { headingOffset: 1 });
 * ```
 */
export function renderMarkdown(markdown: string | MarkdownDocument, options: MarkdownOptions = {}): string {
  const document = typeof markdown === 'string' ? parseMarkdown(markdown) : markdown;
  const references = Object.assign({}, document.references, options.references ?? {});
  const renderOptions = { ...options, references };
  const output: string[] = [];

  for (const node of document.nodes) {
    if (node.kind === 'paragraph') {
      output.push(`<p>${renderMarkdownInline(node.text, renderOptions)}</p>`);
    } else if (node.kind === 'heading') {
      const level = Math.min(6, Math.max(1, node.level + (options.headingOffset ?? 0)));
      output.push(`<h${level}>${renderMarkdownInline(node.text, renderOptions)}</h${level}>`);
    } else if (node.kind === 'list') {
      const tag = node.ordered ? 'ol' : 'ul';
      output.push(`<${tag}>`);
      for (const item of node.items) output.push(`<li>${renderMarkdownInline(item, renderOptions)}</li>`);
      output.push(`</${tag}>`);
    } else if (node.kind === 'code') {
      if (options.renderCode) {
        output.push(options.renderCode(node.code, node.lang, node.meta));
      } else {
        const className = node.lang ? ` class="language-${escapeAttribute(node.lang)}"` : '';
        output.push(`<pre><code${className}>${escapeHtml(node.code)}</code></pre>`);
      }
    }
  }

  return output.join('\n');
}
