# Format Guide

Format modules parse and serialize common structured data formats. Use them for
configuration files, interchange data, generated documents, and text protocols.
Use `fino:parsing/scanner` when building a new parser rather than consuming an
existing format.

## CSV

Use CSV for row-oriented data:

```ts
import { parse, stringify } from 'fino:format/csv';

const rows = parse('name,count\nalpha,1\nbeta,2\n', {
  header: true,
  cast: true,
});

console.log(rows[0].name, rows[0].count);

const output = stringify(rows, { header: true });
```

Use `header: true` when the first row names object fields. Use `columns` when
the input does not include a header row but you still want records.

## TOML

Use TOML for human-edited configuration:

```ts
import { parse, stringify } from 'fino:format/toml';

const config = parse(`
[server]
host = "127.0.0.1"
port = 3000
`);

console.log(config.server);

const text = stringify({
  server: { host: '127.0.0.1', port: 3000 },
});
```

TOML keeps configuration readable while preserving richer types than simple
environment variables.

## YAML

Use YAML when you need compatibility with YAML-based tooling:

```ts
import { parse, stringify } from 'fino:format/yaml';

const doc = parse(`
name: demo
features:
  - http
  - sqlite
`);

console.log(doc);

const yaml = stringify({ name: 'demo', enabled: true });
```

YAML can represent multiple documents. Use `parseAll` when the input may contain
more than one document.

## XML

Use XML for XML-based protocols and document interchange:

```ts
import { parse, stringify } from 'fino:format/xml';

const doc = parse('<feed><title>Updates</title></feed>');

console.log(doc.root.name);

const xml = stringify(doc);
```

XML documents preserve element structure, attributes, and text nodes so code can
round-trip protocol-shaped data.

## Markdown

Use Markdown helpers when documentation or rich text needs to become HTML:

```ts
import { renderMarkdown } from 'fino:format/markdown';

const html = renderMarkdown('# Hello\n\nThis is **Fino**.');
```

Use `parseMarkdown` when code needs the parsed document tree rather than final
HTML.

## Scanner

`fino:parsing/scanner` is not a format module. It is a parser-building utility
used by several format modules. Reach for it when creating a new parser that
needs position tracking, useful parse errors, and byte/string scanning helpers:

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('name=value', { format: 'example' });
const mark = scanner.mark();

scanner.eatUntil((code) => code === 0x3D);
const name = scanner.text(mark);
scanner.eat();
const value = scanner.eatUntil(() => false);

console.log(name, value);
```

Prefer an existing `fino:format/*` module when one matches your input. Use the
scanner when the input format is application-specific or not implemented yet.
