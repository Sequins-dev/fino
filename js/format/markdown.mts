/**
 * fino:format/markdown - safe Markdown parser and HTML renderer for documentation and templates.
 */

import { Scanner } from '../parsing/scanner.mts';

export interface MarkdownOptions {
  /**
   * Allow link URLs outside the default safe set.
   */
  allowUnsafeLinks?: boolean;

  /**
   * Add this many levels to rendered Markdown headings.
   */
  headingOffset?: number;

  /**
   * Reference-style link definitions to use in addition to definitions parsed from the document.
   */
  references?: Record<string, string>;

  /**
   * Rewrite link URLs while rendering.
   */
  resolveLink?: (href: string, label: string) => string | undefined;

  /**
   * Render fenced code blocks.
   */
  renderCode?: (code: string, lang: string, meta: string) => string;
}

export type MarkdownNode =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; meta: string; code: string };

export interface MarkdownDocument {
  nodes: MarkdownNode[];
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

/**
 * Render inline Markdown spans without wrapping the result in block elements.
 */
export function renderMarkdownInline(markdown: string, options: MarkdownOptions = {}): string {
  const references = Object.assign({}, options.references ?? {});
  const scanner = new Scanner(markdown, { encoding: 'utf-8', format: 'markdown-inline' });
  let html = '';

  while (!scanner.done) {
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
        const href = scanner.eatUntil((value) => value === 0x29).trim();
        if (scanner.eatChar(')')) {
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
          const href = scanner.eatUntil((value) => value === 0x29).trim();
          if (scanner.eatChar(')')) {
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
