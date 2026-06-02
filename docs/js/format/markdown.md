# markdown

fino:format/markdown - safe Markdown parser and HTML renderer for documentation and templates.

This module provides a deliberately small Markdown surface for generated
documentation, templates, and user-facing text where predictable HTML output
matters more than implementing every extension in the Markdown ecosystem.
It parses Markdown into a reusable block tree and renders escaped HTML with
safe link handling by default.

Supported block nodes include paragraphs, ATX headings, ordered and
unordered lists, fenced code blocks, and reference-style link definitions.
Inline rendering handles emphasis-style text as plain escaped content plus
links and code spans used by the documentation generator. Link URLs are
limited to relative URLs and `http`/`https` unless `allowUnsafeLinks` is set.

The renderer is not a CommonMark compliance target and does not execute or
sanitize arbitrary embedded HTML. Treat Markdown as content input and use
`resolveLink` or `renderCode` to adapt it to an application's routing and
syntax-highlighting needs.

```ts
import { parseMarkdown, renderMarkdown } from 'fino:format/markdown';

const doc = parseMarkdown('# Title\n\nSee [docs](/docs).\n');
const html = renderMarkdown(doc, { headingOffset: 1 });
```

```ts
import { renderMarkdown } from 'fino:format/markdown';

const html = renderMarkdown('```ts\nconst x = 1;\n```', {
  renderCode: (code, lang) => `<pre data-lang="${lang}">${code}</pre>`,
});
```

Useful references:
  - CommonMark overview: https://commonmark.org/
  - Markdown original syntax: https://daringfireball.net/projects/markdown/syntax

## MarkdownOptions

```ts
interface MarkdownOptions {
```

Options controlling Markdown HTML rendering and link safety.

### allowUnsafeLinks

```ts
allowUnsafeLinks?: boolean
```

Allow link URLs outside the default safe set.

### headingOffset

```ts
headingOffset?: number
```

Add this many levels to rendered Markdown headings.

### references

```ts
references?: Record<string, string>
```

Reference-style link definitions to use in addition to definitions parsed from the document.

### resolveLink

```ts
resolveLink?: (href: string, label: string) => string | undefined
```

Rewrite link URLs while rendering.

### renderCode

```ts
renderCode?: (code: string, lang: string, meta: string) => string
```

Render fenced code blocks.

## MarkdownNode

```ts
type MarkdownNode = | { kind: 'paragraph'; text: string } | { kind: 'heading'; level: number; text: string } | { kind: 'list'; ordered: boolean; items: string[] } | { kind: 'code'; lang: string; meta: string; code: string }
```

Block-level node returned by the Markdown parser.

## MarkdownDocument

```ts
interface MarkdownDocument {
```

Parsed Markdown tree and reference-style link definitions.

### nodes

```ts
nodes: MarkdownNode[]
```

### references

```ts
references: Record<string, string>
```

## parseMarkdown

```ts
function parseMarkdown(markdown: string): MarkdownDocument
```

Parse Markdown into a reusable document tree.

## renderMarkdownInline

```ts
function renderMarkdownInline(markdown: string, options: MarkdownOptions = {}): string
```

Render inline Markdown spans without wrapping the result in block elements.

## renderMarkdown

```ts
function renderMarkdown(markdown: string | MarkdownDocument, options: MarkdownOptions = {}): string
```

Render a Markdown document or source string to HTML.
