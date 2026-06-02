# yaml

fino:format/yaml - YAML 1.2 core schema parser and serializer.

YAML is a human-oriented data serialization format often used for
configuration, manifests, and multi-document files. This module implements
the YAML 1.2 core schema with a security-first surface: it resolves core
scalar types, expands anchors and aliases within configured limits, and never
constructs arbitrary application objects from tags.

Supports the full YAML 1.2 core schema including:
  - Block mappings and sequences (indentation-driven)
  - Flow mappings {} and sequences []
  - Scalars: plain, single-quoted, double-quoted, block literal | and folded >
  - Core schema type resolution (null/~, booleans, ints, floats, strings)
  - Anchors (&) and aliases (*) with expansion-limit safety
  - Explicit tags (!!str, !!int, !!float, !!bool, !!null, !!seq, !!map, !!binary, !!timestamp)
  - Merge keys (<<: *anchor and <<: [*a, *b])
  - Complex mapping keys (? key) - mappings with non-string keys return Map<unknown, YamlValue>
  - Comments, document markers --- / ..., parseAll for multi-document streams

**Permanently excluded** (security baseline - never executes code):
  - Arbitrary type construction (!!ruby/object, etc.)
  - Custom user-defined tags
  - Local tags (!foo) - use !! core tags only

**Note on merge keys**: merge pairs (<<) are absorbed at parse time into the
enclosing mapping. stringify does not re-emit them. The round-trip invariant
`deepEqual(parse(stringify(parse(x))), parse(x))` holds; text-exact
round-trip does not for documents with merge keys.

```ts
import { parse, stringify, parseAll } from 'fino:format/yaml';

const cfg = parse('server:\n  port: 8080\nhosts:\n  - a\n  - b\n');
const text = stringify({ x: 1, y: [2, 3] });
const docs = parseAll('---\na: 1\n---\nb: 2\n');
```

Useful references:
  - YAML 1.2.2 specification: https://yaml.org/spec/1.2.2/
  - YAML core schema: https://yaml.org/spec/1.2.2/#103-core-schema

## YamlParseError

```ts
class YamlParseError extends ParseError {
```

Error thrown when YAML input is malformed or violates configured limits.

The error extends `ParseError` and carries YAML format metadata plus line,
column, and offset information where available. Duplicate keys, unsupported
tags, undefined aliases, alias expansion limits, and syntax errors are
reported through this type.

```ts
import { YamlParseError, parse } from 'fino:format/yaml';

try {
  parse('a: 1\na: 2\n');
} catch (error) {
  if (error instanceof YamlParseError) console.error(error.render());
}
```

### name

```ts
name
```

Error name reported by `YamlParseError` instances.

This member is emitted by the docs generator when
`--include-private` is enabled. It is maintained by runtime
internals and should be changed only with the surrounding
implementation contract in mind.

```ts
const error = new YamlParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
console.log(error.name);
```

## YamlValue

```ts
type YamlValue = null | boolean | number | string | Uint8Array | Date | YamlValue[] | YamlMapping | Map<unknown, YamlValue>
```

Value types produced by the YAML core schema parser and accepted by stringify.

Core tags resolve to JavaScript primitives, `Uint8Array` for `!!binary`,
`Date` for `!!timestamp`, arrays for sequences, plain objects for mappings
with string keys, and `Map` for mappings with complex keys.

```ts
import { parse, stringify, type YamlValue } from 'fino:format/yaml';

const value: YamlValue = parse('enabled: true\ncount: 3\n');
stringify(value);
```

## YamlMapping

```ts
type YamlMapping = {
  [k: string]: YamlValue;
}
```

Plain-object YAML mapping with string keys.

Mappings with non-string keys are returned as `Map<unknown, YamlValue>`
instead, because JavaScript object keys cannot preserve arbitrary YAML key
values.

```ts
import { parse, type YamlMapping } from 'fino:format/yaml';

const mapping = parse('server:\n  port: 8080\n') as YamlMapping;
(mapping.server as YamlMapping).port;
```

## YamlParseOptions

```ts
interface YamlParseOptions {
```

Options controlling YAML parsing limits and duplicate-key behavior.

Defaults reject duplicate keys, cap total alias expansion at 1,000,000
estimated characters, and cap alias expansion depth at 100.

```ts
import { parse, type YamlParseOptions } from 'fino:format/yaml';

const options: YamlParseOptions = { maxAliasExpansion: 10_000 };
parse('a: 1\n', options);
```

### allowDuplicateKeys

```ts
allowDuplicateKeys?: boolean
```

Permit later duplicate keys to replace earlier values. Defaults to `false`.

When disabled, duplicate keys throw `YamlParseError`. For complex keys,
duplicate detection uses a JSON string form and is best-effort.

```ts
import { parse } from 'fino:format/yaml';

parse('a: 1\na: 2\n', { allowDuplicateKeys: true });
```

### maxAliasExpansion

```ts
maxAliasExpansion?: number
```

Maximum estimated expanded character count from aliases.

Defaults to `1_000_000`. Lower values can reject hostile or accidental
alias amplification earlier for untrusted inputs.

```ts
import { parse } from 'fino:format/yaml';

parse('a: &a hello\nb: *a\n', { maxAliasExpansion: 100 });
```

### maxAliasDepth

```ts
maxAliasDepth?: number
```

Maximum nested alias expansion depth. Defaults to `100`.

This option exists to bound deeply nested alias graphs. The parser also
applies the total expansion cap in `maxAliasExpansion`.

```ts
import { parse } from 'fino:format/yaml';

parse('a: &a [1]\nb: *a\n', { maxAliasDepth: 10 });
```

## YamlStringifyOptions

```ts
interface YamlStringifyOptions {
```

Options controlling YAML serialization style.

Stringification emits a readable block style for objects and arrays and does
not preserve source comments, anchors, aliases, or merge keys from parsed
input.

```ts
import { stringify, type YamlStringifyOptions } from 'fino:format/yaml';

const options: YamlStringifyOptions = { indent: 4 };
stringify({ server: { port: 8080 } }, options);
```

### indent

```ts
indent?: number
```

Spaces per nesting level. Defaults to `2`.

Values are used directly by the formatter; choose a positive integer for
conventional YAML output.

```ts
import { stringify } from 'fino:format/yaml';

stringify({ a: { b: 1 } }, { indent: 4 });
```

### lineWidth

```ts
lineWidth?: number
```

Preferred scalar wrapping width.

This option is reserved for scalar wrapping behavior. Current output may
keep long scalar values on one line when quoting is required.

```ts
import { stringify } from 'fino:format/yaml';

stringify({ message: 'hello world' }, { lineWidth: 80 });
```

## parse

```ts
function parse(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue
```

Parse one YAML document, returning the first document from a stream.

String input is parsed directly; byte input is decoded as UTF-8. If the input
contains no document content, the function returns `null`. For multi-document
streams, use `parseAll()` to keep every document.

```ts
import { parse } from 'fino:format/yaml';

parse('server:\n  port: 8080\n');
```

## parseAll

```ts
function parseAll(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue[]
```

Parse all YAML documents from a multi-document stream.

Document markers (`---` and `...`) are consumed between documents. Anchors
are scoped per document and cleared before parsing the next document. Empty
input returns an empty array.

```ts
import { parseAll } from 'fino:format/yaml';

const docs = parseAll('---\na: 1\n---\nb: 2\n');
docs.length; // 2
```

## stringify

```ts
function stringify(value: YamlValue, options: YamlStringifyOptions = {}): string
```

Serialize a YAML-compatible value.

Serialization emits YAML core-schema values from JavaScript primitives,
arrays, plain mappings, `Map`, `Uint8Array`, and `Date`. It does not re-emit
comments, anchors, aliases, merge keys, or original document markers.

```ts
import { stringify } from 'fino:format/yaml';

stringify({ hosts: ['a', 'b'] });
```
