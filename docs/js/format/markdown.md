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

Options controlling Markdown HTML rendering, link safety, and code output.

By default the renderer escapes Markdown text, allows relative and
`http`/`https` links, renders headings at their source level, and emits
fenced code blocks as `<pre><code>`. Override these hooks when routing links
through an application or adding syntax highlighting.

```ts
import { renderMarkdown, type MarkdownOptions } from 'fino:format/markdown';

const options: MarkdownOptions = {
  headingOffset: 1,
  resolveLink: (href) => href.startsWith('/') ? `/docs${href}` : href,
};

renderMarkdown('# Title\n\n[Guide](/guide)', options);
```

### allowUnsafeLinks

```ts
allowUnsafeLinks?: boolean
```

Allow link URLs outside the default safe set.

Defaults to `false`. When disabled, absolute URLs are limited to `http` and
`https`, protocol URLs such as `javascript:` are omitted, and unsafe links
render as their label text. Enabling this option does not sanitize the URL.

```ts
import { renderMarkdownInline } from 'fino:format/markdown';

renderMarkdownInline('[run](javascript:alert(1))', {
  allowUnsafeLinks: true,
});
```

### headingOffset

```ts
headingOffset?: number
```

Add this many levels to rendered Markdown headings.

Defaults to `0`. Output heading levels are clamped to the HTML range
`h1` through `h6`, which is useful when embedding Markdown below an
existing page heading.

```ts
import { renderMarkdown } from 'fino:format/markdown';

renderMarkdown('# Section', { headingOffset: 2 }); // <h3>Section</h3>
```

### references

```ts
references?: Record<string, string>
```

Reference-style link definitions to use in addition to definitions parsed from the document.

Keys are normalized like Markdown reference labels: trimmed, collapsed
whitespace, and lower-cased. Parsed document references override nothing;
renderer options are merged in before inline rendering.

```ts
import { renderMarkdownInline } from 'fino:format/markdown';

renderMarkdownInline('[API][api]', {
  references: { api: 'https://example.test/api' },
});
```

### resolveLink

```ts
resolveLink?: (href: string, label: string) => string | undefined
```

Rewrite link URLs while rendering.

Return a replacement URL or `undefined` to keep the original. The resulting
URL is still checked by the safe-link policy unless `allowUnsafeLinks` is
enabled.

```ts
import { renderMarkdown } from 'fino:format/markdown';

renderMarkdown('[Home](/)', {
  resolveLink: (href, label) => href === '/' ? `/docs?from=${label}` : href,
});
```

### renderCode

```ts
renderCode?: (code: string, lang: string, meta: string) => string
```

Render fenced code blocks.

When omitted, code is escaped and wrapped in `<pre><code>`, with
`class="language-..."` when a language is present. Custom renderers receive
the raw code text, language, and trailing fence metadata and must escape
their own HTML output as needed.

```ts
import { renderMarkdown } from 'fino:format/markdown';

renderMarkdown('```ts title=demo\nconst x = 1;\n```', {
  renderCode: (code, lang, meta) =>
    `<pre data-lang="${lang}" data-meta="${meta}">${code}</pre>`,
});
```

## MarkdownNode

```ts
type MarkdownNode = | { /** * Discriminator for paragraph nodes. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * parseMarkdown('Body').nodes[0]?.kind; * ``` */ kind: 'paragraph'; /** * Paragraph text with source lines joined by spaces. * * Inline Markdown remains unrendered until `renderMarkdownInline()` or * `renderMarkdown()` is called. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('Hello **world**').nodes[0]; * if (node?.kind === 'paragraph') node.text; * ``` */ text: string; } | { /** * Discriminator for heading nodes. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * parseMarkdown('# Title').nodes[0]?.kind; * ``` */ kind: 'heading'; /** * Heading level from 1 through 6 before render-time offsetting. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('## Title').nodes[0]; * if (node?.kind === 'heading') node.level; * ``` */ level: number; /** * Heading text without the leading hash markers. * * Inline Markdown remains unrendered until HTML rendering. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('# Title').nodes[0]; * if (node?.kind === 'heading') node.text; * ``` */ text: string; } | { /** * Discriminator for list nodes. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * parseMarkdown('- item').nodes[0]?.kind; * ``` */ kind: 'list'; /** * Whether the list was parsed from ordered markers. * * `true` renders as `<ol>` and `false` renders as `<ul>`. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('1. item').nodes[0]; * if (node?.kind === 'list') node.ordered; * ``` */ ordered: boolean; /** * List item text values in source order. * * Nested lists are not represented by this compact parser. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('- a\n- b').nodes[0]; * if (node?.kind === 'list') node.items; * ``` */ items: string[]; } | { /** * Discriminator for fenced code block nodes. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * parseMarkdown('```ts\nx\n```').nodes[0]?.kind; * ``` */ kind: 'code'; /** * Fence language identifier, or `""` when none is provided. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('```ts\nx\n```').nodes[0]; * if (node?.kind === 'code') node.lang; * ``` */ lang: string; /** * Remaining fence info string after the language identifier. * * The value is trimmed and may be `""`. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('```ts title=demo\nx\n```').nodes[0]; * if (node?.kind === 'code') node.meta; * ``` */ meta: string; /** * Code block contents without the opening or closing fence. * * The parser preserves internal newlines and does not syntax-highlight. * * ```ts no_run * import { parseMarkdown } from 'fino:format/markdown'; * * const node = parseMarkdown('```\nconst x = 1;\n```').nodes[0]; * if (node?.kind === 'code') node.code; * ``` */ code: string; }
```

Block-level node returned by the Markdown parser.

The parser produces paragraph, heading, list, and fenced-code nodes. Inline
Markdown is intentionally left in string fields until rendering, so callers
can inspect or transform block structure without losing the original inline
text. The node union does not represent arbitrary CommonMark extensions.

```ts
import { parseMarkdown, type MarkdownNode } from 'fino:format/markdown';

const first: MarkdownNode | undefined = parseMarkdown('# Title').nodes[0];
if (first?.kind === 'heading') console.log(first.level, first.text);
```

## MarkdownDocument

```ts
interface MarkdownDocument {
```

Parsed Markdown tree and reference-style link definitions.

`nodes` contains block-level content in source order. `references` contains
link definitions parsed from lines such as `[id]: https://example.test`; it
is merged with `MarkdownOptions.references` during rendering.

```ts
import { parseMarkdown, type MarkdownDocument } from 'fino:format/markdown';

const document: MarkdownDocument = parseMarkdown('[docs]: /docs\n\nSee [docs][].');
console.log(document.references.docs);
```

### nodes

```ts
nodes: MarkdownNode[]
```

Block nodes in source order.

Empty lines and reference definitions are not represented as nodes.

```ts
import { parseMarkdown } from 'fino:format/markdown';

const nodes = parseMarkdown('# A\n\nB').nodes;
nodes.map((node) => node.kind);
```

### references

```ts
references: Record<string, string>
```

Normalized reference-style link definitions parsed from the document.

Missing references leave the original reference syntax escaped in rendered
output. Values are not safety-checked until rendering.

```ts
import { parseMarkdown } from 'fino:format/markdown';

const refs = parseMarkdown('[api]: https://example.test\n').references;
refs.api;
```

## parseMarkdown

```ts
function parseMarkdown(markdown: string): MarkdownDocument
```

Parse Markdown into a reusable document tree.

The parser recognizes a compact block subset: paragraphs, ATX headings,
ordered and unordered lists, fenced code blocks, and reference definitions.
It does not throw for most Markdown oddities; unsupported constructs are
usually folded into paragraphs or escaped later by the renderer.

```ts
import { parseMarkdown } from 'fino:format/markdown';

const document = parseMarkdown('# Title\n\n- one\n- two\n');
const list = document.nodes.find((node) => node.kind === 'list');
```

## renderMarkdownInline

```ts
function renderMarkdownInline(markdown: string, options: MarkdownOptions = {}): string
```

Render inline Markdown spans without wrapping the result in block elements.

Inline rendering escapes text, supports code spans, emphasis, strong text,
images, inline links, reference links, and auto-linked `http`/`https` URLs.
Unsafe or unresolved links are rendered as escaped label text instead of
anchors. The output is an HTML fragment.

```ts
import { renderMarkdownInline } from 'fino:format/markdown';

const html = renderMarkdownInline('Use `code` and [docs](/docs).');
```

## renderMarkdown

```ts
function renderMarkdown(markdown: string | MarkdownDocument, options: MarkdownOptions = {}): string
```

Render a Markdown document or source string to HTML.

String input is parsed first; passing a `MarkdownDocument` reuses an existing
block tree. The renderer joins block HTML with newlines, escapes text by
default, and uses `renderCode` for fenced code blocks when supplied.

```ts
import { parseMarkdown, renderMarkdown } from 'fino:format/markdown';

const document = parseMarkdown('# Title\n\nBody');
const html = renderMarkdown(document, { headingOffset: 1 });
```
