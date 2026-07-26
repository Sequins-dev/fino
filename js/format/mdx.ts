/**
 * fino:format/mdx — compile trusted MDX slide documents into Fino UI modules.
 *
 * The compiler extends `fino:format/markdown` rather than introducing a second
 * Markdown implementation. The existing block parser handles CommonMark/GFM
 * structure, while this module protects MDX expressions and JSX during inline
 * rendering, converts Markdown elements to component lookups, preserves ESM,
 * and sends the generated TSX through Fino's Oxc compiler.
 *
 * Top-level `---` thematic breaks become slide boundaries. MDX is executable
 * application code and must not be compiled from untrusted user input.
 * Remark/rehype plugins and React provider semantics are not supported.
 *
 * Useful references:
 *
 * - [MDX syntax](https://mdxjs.com/docs/what-is-mdx/)
 * - [GitHub Flavored Markdown](https://github.github.com/gfm/)
 *
 * ```ts no_run
 * import { compileMdx } from 'fino:format/mdx';
 *
 * const result = compileMdx('# Hello, {props.name}', { filename: 'talk.mdx' });
 * if (!result.ok) console.error(result.diagnostics);
 * ```
 */
import {
  parseMarkdown,
  renderMarkdownInline,
  type MarkdownDocument,
  type MarkdownListItem,
  type MarkdownNode,
} from 'fino:format/markdown';
import { transpile } from 'fino:format/typescript';
/** Source location attached to an MDX compiler diagnostic. */
export interface MdxDiagnostic {
  /** Human-readable parser or transformer message. */
  message: string;
  /** One-based source line. */
  line: number;
  /** One-based source column. */
  column: number;
  /** Zero-based source offset. */
  offset: number;
  /** Diagnostic implementation namespace. */
  source: string;
  /** Stable diagnostic rule identifier when available. */
  ruleId: string;
}
/** Successful or failed MDX compilation result. */
export interface MdxCompileResult {
  /** Whether parsing and transformation succeeded. */
  ok: boolean;
  /** Executable ESM JavaScript, or an empty string on failure. */
  code: string;
  /** Version-three source map JSON, or an empty string on failure. */
  map: string;
  /** Positioned diagnostics collected during compilation. */
  diagnostics: MdxDiagnostic[];
}
/** Options controlling one MDX compilation. */
export interface MdxCompileOptions {
  /** Original source filename used in diagnostics and source maps. */
  filename?: string;
}
interface SourceDocument {
  esm: string[];
  slides: Array<{
    source: string;
    line: number;
  }>;
}
const markdownComponents = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];
const deckComponents = ['Notes', 'Head', 'Header', 'Footer', 'Steps'];
function diagnostic(
  message: string,
  line: number,
  column: number,
  offset: number,
  ruleId: string,
): MdxDiagnostic {
  return {
    message,
    line,
    column,
    offset,
    source: 'fino:format/mdx',
    ruleId,
  };
}
function lineAt(
  source: string,
  offset: number,
): {
  line: number;
  column: number;
} {
  const prefix = source.slice(0, offset);
  const lines = prefix.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}
function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index;
  }
  return -1;
}
function jsxTagEnd(source: string, start: number): number {
  let quote = '';
  let escaped = false;
  let braces = 0;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') braces++;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '>' && braces === 0) return index;
  }
  return -1;
}
function validateMdx(source: string): MdxDiagnostic[] {
  const diagnostics: MdxDiagnostic[] = [];
  const componentStack: Array<{
    name: string;
    offset: number;
  }> = [];
  let fenced = false;
  for (let index = 0; index < source.length; ) {
    const atLineStart = index === 0 || source[index - 1] === '\n';
    if (atLineStart && source.startsWith('```', index)) {
      fenced = !fenced;
      index += 3;
      continue;
    }
    if (!fenced && source[index] === '{') {
      const end = matchingBrace(source, index);
      if (end < 0) {
        const place = lineAt(source, index);
        diagnostics.push(
          diagnostic(
            'Unclosed MDX expression.',
            place.line,
            place.column,
            index,
            'expression-unclosed',
          ),
        );
        break;
      }
      index = end + 1;
      continue;
    }
    if (!fenced && source[index] === '<') {
      const end = jsxTagEnd(source, index);
      if (end < 0) {
        const place = lineAt(source, index);
        diagnostics.push(
          diagnostic('Unclosed MDX JSX tag.', place.line, place.column, index, 'jsx-tag-unclosed'),
        );
        break;
      }
      const tag = source.slice(index, end + 1);
      const match = /^<\s*(\/?)\s*([A-Z][A-Za-z0-9_.:-]*)/.exec(tag);
      if (match) {
        const closing = match[1] === '/';
        const name = match[2]!;
        const selfClosing = /\/\s*>$/.test(tag);
        if (closing) {
          const open = componentStack.pop();
          if (!open || open.name !== name) {
            const place = lineAt(source, index);
            diagnostics.push(
              diagnostic(
                `Unexpected closing JSX tag </${name}>.`,
                place.line,
                place.column,
                index,
                'jsx-tag-mismatch',
              ),
            );
            break;
          }
        } else if (!selfClosing)
          componentStack.push({
            name,
            offset: index,
          });
      }
      index = end + 1;
      continue;
    }
    index++;
  }
  const open = componentStack.at(-1);
  if (diagnostics.length === 0 && open) {
    const place = lineAt(source, open.offset);
    diagnostics.push(
      diagnostic(
        `Missing closing JSX tag for <${open.name}>.`,
        place.line,
        place.column,
        open.offset,
        'jsx-tag-unclosed',
      ),
    );
  }
  return diagnostics;
}
function splitDocument(source: string): SourceDocument {
  const esm: string[] = [];
  const slides: Array<{
    source: string;
    line: number;
  }> = [];
  let current: string[] = [];
  let startLine = 1;
  let fenced = false;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^```/.test(line)) fenced = !fenced;
    if (!fenced && /^(?:import|export)\s/.test(line)) {
      esm.push(line);
      continue;
    }
    if (!fenced && /^---\s*$/.test(line)) {
      slides.push({
        source: current.join('\n'),
        line: startLine,
      });
      current = [];
      startLine = index + 2;
      continue;
    }
    current.push(line);
  }
  slides.push({
    source: current.join('\n'),
    line: startLine,
  });
  return {
    esm,
    slides,
  };
}
function protectMdx(source: string): {
  markdown: string;
  tokens: string[];
} {
  const tokens: string[] = [];
  let markdown = '';
  for (let index = 0; index < source.length; ) {
    let end = -1;
    if (source[index] === '{') end = matchingBrace(source, index);
    else if (source[index] === '<') end = jsxTagEnd(source, index);
    if (end >= index) {
      const token = source.slice(index, end + 1);
      const marker = `FINOMDXTOKEN${tokens.length}X`;
      tokens.push(
        token.replace(/^(<\/?)(Notes|Head|Header|Footer|Steps)(?=[\s>])/u, '$1_components.$2'),
      );
      markdown += marker;
      index = end + 1;
    } else {
      markdown += source[index]!;
      index++;
    }
  }
  return {
    markdown,
    tokens,
  };
}
function mapMarkdownTags(value: string): string {
  const names = markdownComponents.join('|');
  return value.replace(new RegExp(`<(/?)(${names})(?=[\\s>])`, 'g'), '<$1_components.$2');
}
function inline(source: string, document: MarkdownDocument): string {
  const protectedSource = protectMdx(source);
  let value = renderMarkdownInline(protectedSource.markdown, {
    allowRawHtml: true,
    allowUnsafeLinks: true,
    references: document.references,
  });
  value = mapMarkdownTags(value);
  for (let index = 0; index < protectedSource.tokens.length; index++) {
    value = value.replaceAll(`FINOMDXTOKEN${index}X`, protectedSource.tokens[index]!);
  }
  return value;
}
function renderListItem(
  item: MarkdownListItem,
  document: MarkdownDocument,
  tight: boolean,
): string {
  const checkbox =
    item.task === undefined
      ? ''
      : `<_components.input type="checkbox" checked={${item.task}} disabled />`;
  return `<_components.li>${checkbox}${item.nodes.map((node) => renderNode(node, document, tight)).join('')}</_components.li>`;
}
function renderNode(node: MarkdownNode, document: MarkdownDocument, tight = false): string {
  if (node.kind === 'paragraph') {
    const content = inline(node.text, document);
    return tight ? content : `<_components.p>${content}</_components.p>`;
  }
  if (node.kind === 'heading')
    return `<_components.h${node.level}>${inline(node.text, document)}</_components.h${node.level}>`;
  if (node.kind === 'thematicBreak') return '<_components.hr />';
  if (node.kind === 'blockquote')
    return `<_components.blockquote>${node.nodes.map((child) => renderNode(child, document)).join('')}</_components.blockquote>`;
  if (node.kind === 'htmlBlock') return inline(node.html, document);
  if (node.kind === 'code') {
    const className = node.lang ? ` class={${JSON.stringify(`language-${node.lang}`)}}` : '';
    return `<_components.pre><_components.code${className}>{${JSON.stringify(node.code)}}</_components.code></_components.pre>`;
  }
  if (node.kind === 'list') {
    const name = node.ordered ? 'ol' : 'ul';
    return `<_components.${name}>${node.items.map((item) => renderListItem(item, document, node.tight)).join('')}</_components.${name}>`;
  }
  const head = node.header
    .map((cell, index) => {
      const align = node.align[index] ? ` align={${JSON.stringify(node.align[index])}}` : '';
      return `<_components.th${align}>${inline(cell, document)}</_components.th>`;
    })
    .join('');
  const rows = node.rows
    .map(
      (row) =>
        `<_components.tr>${node.header
          .map((_, index) => {
            const align = node.align[index] ? ` align={${JSON.stringify(node.align[index])}}` : '';
            return `<_components.td${align}>${inline(row[index] ?? '', document)}</_components.td>`;
          })
          .join('')}</_components.tr>`,
    )
    .join('');
  return `<_components.table><_components.thead><_components.tr>${head}</_components.tr></_components.thead>${rows ? `<_components.tbody>${rows}</_components.tbody>` : ''}</_components.table>`;
}
function generateTsx(source: SourceDocument): string {
  const defaults = markdownComponents
    .map((name) => `${JSON.stringify(name)}: ${JSON.stringify(name)}`)
    .join(', ');
  const deckDefaults = [
    'Notes: (value: any) => <aside data-fino-notes hidden>{value.children}</aside>',
    'Head: (value: any) => <div data-fino-head hidden>{value.children}</div>',
    'Header: (value: any) => <header class="fino-slide-header">{value.children}</header>',
    'Footer: (value: any) => <footer class="fino-slide-footer">{value.children}</footer>',
    'Steps: (value: any) => <div data-fino-steps>{value.children}</div>',
  ].join(', ');
  const sections = source.slides
    .map((slide, index) => {
      const document = parseMarkdown(slide.source);
      const body = document.nodes.map((node) => renderNode(node, document)).join('');
      return `<section data-fino-slide={${index}}>${body}</section>`;
    })
    .join('');
  return `/** @jsxImportSource fino:ui */\n${source.esm.join('\n')}\nexport default function MDXContent(props: Record<string, any> = {}) {\n  const _components = { ${defaults}, ${deckDefaults}, ...(props.components ?? {}) };\n  return <>${sections}</>;\n}\n`;
}
/**
 * Compile one trusted MDX document into an executable Fino UI ESM module.
 *
 * `source` uses the same Markdown behavior as `fino:format/markdown`, plus ESM,
 * expressions, JSX, and slide separators. `options.filename` defaults to
 * `module.mdx` and is retained in diagnostics and source-map metadata. Syntax
 * failures are returned rather than thrown.
 */
export function compileMdx(source: string, options: MdxCompileOptions = {}): MdxCompileResult {
  const filename = options.filename ?? 'module.mdx';
  const diagnostics = validateMdx(source);
  if (diagnostics.length > 0)
    return {
      ok: false,
      code: '',
      map: '',
      diagnostics,
    };
  const tsx = generateTsx(splitDocument(source));
  const transformed = transpile(tsx, { filename: `${filename}.tsx` });
  if (!transformed.ok) {
    return {
      ok: false,
      code: '',
      map: '',
      diagnostics: transformed.errors.map((error) => ({
        message: error.message,
        line: error.line ?? 1,
        column: error.column ?? 1,
        offset: 0,
        source: 'oxc',
        ruleId: error.code ?? 'transform',
      })),
    };
  }
  let map = transformed.map;
  try {
    const value = JSON.parse(map) as {
      sources?: string[];
    };
    value.sources = [filename];
    map = JSON.stringify(value);
  } catch (_) {}
  return {
    ok: true,
    code: transformed.code,
    map,
    diagnostics: [],
  };
}
