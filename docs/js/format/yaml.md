# yaml

fino:format/yaml — YAML 1.2 core schema parser and serializer.

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
  - Complex mapping keys (? key) — mappings with non-string keys return Map<unknown, YamlValue>
  - Comments, document markers --- / ..., parseAll for multi-document streams

**Permanently excluded** (security baseline — never executes code):
  - Arbitrary type construction (!!ruby/object, etc.)
  - Custom user-defined tags
  - Local tags (!foo) — use !! core tags only

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

Error thrown when YAML input is malformed.

### name

```ts
name
```

## YamlValue

```ts
type YamlValue = | null | boolean | number | string | Uint8Array | Date | YamlValue[] | YamlMapping | Map<unknown, YamlValue>
```

Value types produced by the YAML core schema parser.

## YamlMapping

```ts
type YamlMapping = { [k: string]: YamlValue }
```

Plain-object YAML mapping with string keys. Complex keys are returned as Map.

## YamlParseOptions

```ts
interface YamlParseOptions {
```

Options controlling YAML parsing limits and duplicate-key behavior.

### allowDuplicateKeys

```ts
allowDuplicateKeys?: boolean
```

Permit later duplicate keys to replace earlier values.

### maxAliasExpansion

```ts
maxAliasExpansion?: number
```

Maximum expanded character count from aliases.

### maxAliasDepth

```ts
maxAliasDepth?: number
```

Maximum nested alias expansion depth.

## YamlStringifyOptions

```ts
interface YamlStringifyOptions {
```

Options controlling YAML serialization style.

### indent

```ts
indent?: number
```

Spaces per nesting level. Defaults to 2.

### lineWidth

```ts
lineWidth?: number
```

Preferred scalar wrapping width.

## parse

```ts
function parse(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue
```

Parse one YAML document, returning the first document from a stream.

```ts
import { parse } from 'fino:format/yaml';

parse('server:\n  port: 8080\n');
```

## parseAll

```ts
function parseAll(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue[]
```

Parse all YAML documents from a multi-document stream.

## stringify

```ts
function stringify(value: YamlValue, options: YamlStringifyOptions = {}): string
```

Serialize a YAML-compatible value.

```ts
import { stringify } from 'fino:format/yaml';

stringify({ hosts: ['a', 'b'] });
```
