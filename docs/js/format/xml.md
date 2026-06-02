# xml

fino:format/xml - XML 1.0 + Namespaces parser and serializer.

XML is a structured markup format used for documents, feeds, config files,
protocols, and interchange with older systems. This module parses XML into a
compact document tree, streams SAX-style events from async byte sources, and
serializes document trees back to XML text.

The parser enforces XML well-formedness and XML Namespaces rules. It parses
internal DTD entity definitions but disables external entities by default to
avoid XXE vulnerabilities. Entity expansion and nesting depth are bounded to
reduce billion-laughs style attacks. Callers that supply
`resolveExternalEntities` are responsible for their own network, filesystem,
and trust boundaries.

Two output surfaces:
  - Tree (DOM-lite):  parse(input)  -> XmlDocument
  - SAX/streaming:   parseStream(src) -> AsyncIterableIterator<XmlEvent>

```ts
import { parse, stringify } from 'fino:format/xml';

const doc = parse('<root attr="v"><child>text</child></root>');
doc.root.name;             // 'root'
doc.root.children[0].type; // 'element'
const xml = stringify(doc, { xmlDeclaration: true });
```

```ts
import { parseStream } from 'fino:format/xml';

for await (const event of parseStream(byteSource)) {
  if (event.type === 'startElement') console.log(event.name);
}
```

Useful references:
  - XML 1.0: https://www.w3.org/TR/xml/
  - Namespaces in XML: https://www.w3.org/TR/xml-names/
  - OWASP XXE guidance: https://owasp.org/www-community/vulnerabilities/XML_External_Entity_(XXE)_Processing

## XmlParseError

```ts
class XmlParseError extends ParseError {
```

Error thrown when XML input is not well-formed or violates parser limits.

The error inherits source location and diagnostic rendering from
`ParseError`. External entity rejection, entity expansion limits, nesting
depth limits, undefined entities, and mismatched close tags are reported
through this type.

```ts
import { XmlParseError, parse } from 'fino:format/xml';

try {
  parse('<root>');
} catch (error) {
  if (error instanceof XmlParseError) console.error(error.render());
}
```

### name

```ts
name
```

Error name reported by `XmlParseError` instances.

This member is emitted by the docs generator when
`--include-private` is enabled. It is maintained by runtime
internals and should be changed only with the surrounding
implementation contract in mind.

```ts
const error = new XmlParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
console.log(error.name);
```

## XmlDocument

```ts
interface XmlDocument {
```

Parsed XML document tree.

A document contains exactly one root element. Processing instructions,
comments, and doctypes before the root are preserved in `prolog`; trailing
processing instructions and comments are accepted but not retained.

```ts
import { parse, type XmlDocument } from 'fino:format/xml';

const document: XmlDocument = parse('<?xml version="1.0"?><root />');
document.root.name;
```

### type

```ts
type: 'document'
```

Discriminator for XML document values.

Always the string literal `"document"`.

```ts
import { parse } from 'fino:format/xml';

parse('<root />').type;
```

### root

```ts
root: XmlElement
```

Root element of the document.

XML requires exactly one root element; missing or additional element
content throws during parsing.

```ts
import { parse } from 'fino:format/xml';

const root = parse('<root><child /></root>').root;
```

### prolog

```ts
prolog: XmlNode[]
```

Processing instructions, comments, and doctypes before the root element.

The XML declaration is parsed and skipped rather than added as a prolog
processing instruction.

```ts
import { parse } from 'fino:format/xml';

const prolog = parse('<!-- note --><root />').prolog;
```

## XmlElement

```ts
interface XmlElement {
```

Element node with namespace metadata, attributes, and child nodes.

With namespace processing enabled, `name` is the local name, `prefix`
contains the source prefix when present, and `namespace` contains the
resolved namespace URI or `null`.

```ts
import { parse, type XmlElement } from 'fino:format/xml';

const element: XmlElement = parse('<x:root xmlns:x="urn:x" />').root;
element.namespace; // 'urn:x'
```

### type

```ts
type: 'element'
```

Discriminator for element nodes.

Always the string literal `"element"`.

```ts
import { parse } from 'fino:format/xml';

parse('<root />').root.type;
```

### name

```ts
name: string
```

Element name.

When namespaces are enabled, this is the local name without prefix. When
`namespaces: false`, this preserves the qualified source name.

```ts
import { parse } from 'fino:format/xml';

parse('<x:root xmlns:x="urn:x" />').root.name;
```

### prefix

```ts
prefix: string | null
```

Source namespace prefix, or `null` when absent or namespace processing is disabled.

Prefixes are preserved for serialization, but namespace declaration
attributes themselves are not included in `attributes`.

```ts
import { parse } from 'fino:format/xml';

parse('<x:root xmlns:x="urn:x" />').root.prefix;
```

### namespace

```ts
namespace: string | null
```

Resolved namespace URI, or `null` when none is in scope.

Set `namespaces: false` to disable namespace resolution entirely.

```ts
import { parse } from 'fino:format/xml';

parse('<root xmlns="urn:default" />').root.namespace;
```

### attributes

```ts
attributes: Record<string, string>
```

Element attributes as string values.

Attribute entity references are expanded. Namespace declaration attributes
are consumed for namespace resolution and omitted from this record.

```ts
import { parse } from 'fino:format/xml';

parse('<root id="a" />').root.attributes.id;
```

### children

```ts
children: XmlNode[]
```

Child nodes in source order.

Text nodes may be omitted when `trim` removes all text content. Self-closing
elements have an empty child array.

```ts
import { parse } from 'fino:format/xml';

parse('<root>text<child /></root>').root.children;
```

## XmlText

```ts
interface XmlText {
```

Text node.

Entity and character references have already been expanded. When
`XmlParseOptions.trim` is true, all-whitespace text nodes are omitted.

```ts
import { parse, type XmlText } from 'fino:format/xml';

const node = parse('<root>hello</root>').root.children[0] as XmlText;
node.data;
```

### type

```ts
type: 'text'
```

Discriminator for text nodes.

Always the string literal `"text"`.

```ts
import { parse } from 'fino:format/xml';

parse('<root>hello</root>').root.children[0]?.type;
```

### data

```ts
data: string
```

Text content after entity expansion.

The string is not HTML-escaped; escape it when embedding in another output
format.

```ts
import { parse } from 'fino:format/xml';

(parse('<root>&amp;</root>').root.children[0] as { data: string }).data;
```

## XmlCData

```ts
interface XmlCData {
```

CDATA node.

CDATA contents are returned as text data without interpreting markup inside
the section. The serializer emits the data inside a CDATA section.

```ts
import { parse, type XmlCData } from 'fino:format/xml';

const node = parse('<root><![CDATA[<x>]]></root>').root.children[0] as XmlCData;
node.data;
```

### type

```ts
type: 'cdata'
```

Discriminator for CDATA nodes.

Always the string literal `"cdata"`.

```ts
import { parse } from 'fino:format/xml';

parse('<root><![CDATA[x]]></root>').root.children[0]?.type;
```

### data

```ts
data: string
```

Raw CDATA section content.

The closing `]]>` delimiter is not included.

```ts
import { parse } from 'fino:format/xml';

(parse('<root><![CDATA[x]]></root>').root.children[0] as { data: string }).data;
```

## XmlComment

```ts
interface XmlComment {
```

XML comment node.

Comment text excludes the `<!--` and `-->` delimiters. XML forbids `--`
inside comments, and such input throws during parsing.

```ts
import { parse, type XmlComment } from 'fino:format/xml';

const comment = parse('<!-- note --><root />').prolog[0] as XmlComment;
comment.data;
```

### type

```ts
type: 'comment'
```

Discriminator for comment nodes.

Always the string literal `"comment"`.

```ts
import { parse } from 'fino:format/xml';

parse('<!-- note --><root />').prolog[0]?.type;
```

### data

```ts
data: string
```

Comment content without delimiters.

The string is not escaped. Do not insert untrusted comments into another
document format without escaping.

```ts
import { parse } from 'fino:format/xml';

(parse('<!-- note --><root />').prolog[0] as { data: string }).data;
```

## XmlPI

```ts
interface XmlPI {
```

Processing instruction node.

The XML declaration is parsed but skipped from document `prolog`; other
processing instructions are retained with their target and data.

```ts
import { parse, type XmlPI } from 'fino:format/xml';

const pi = parse('<?xml-stylesheet href="style.css"?><root />').prolog[0] as XmlPI;
pi.target;
```

### type

```ts
type: 'pi'
```

Discriminator for processing instruction nodes.

Always the string literal `"pi"`.

```ts
import { parse } from 'fino:format/xml';

parse('<?go now?><root />').prolog[0]?.type;
```

### target

```ts
target: string
```

Processing instruction target.

The target is lower- or upper-case as written by the source except for
comparisons internal to parsing.

```ts
import { parse } from 'fino:format/xml';

(parse('<?go now?><root />').prolog[0] as { target: string }).target;
```

### data

```ts
data: string
```

Processing instruction data after the target.

Surrounding whitespace is trimmed by the parser. Empty processing
instructions use an empty string.

```ts
import { parse } from 'fino:format/xml';

(parse('<?go now?><root />').prolog[0] as { data: string }).data;
```

## XmlDoctype

```ts
interface XmlDoctype {
```

Doctype declaration node.

Internal entity declarations are parsed for expansion. External entities are
rejected unless a resolver is explicitly provided in parse options.

```ts
import { parse, type XmlDoctype } from 'fino:format/xml';

const doc = parse('<!DOCTYPE root><root />').prolog[0] as XmlDoctype;
doc.data;
```

### type

```ts
type: 'doctype'
```

Discriminator for doctype nodes.

Always the string literal `"doctype"`.

```ts
import { parse } from 'fino:format/xml';

parse('<!DOCTYPE root><root />').prolog[0]?.type;
```

### data

```ts
data: string
```

Doctype declaration content without the `<!DOCTYPE` wrapper.

Internal subset details are preserved only as parser output text, not as a
rich DTD model.

```ts
import { parse } from 'fino:format/xml';

(parse('<!DOCTYPE root><root />').prolog[0] as { data: string }).data;
```

## XmlNode

```ts
type XmlNode = XmlElement | XmlText | XmlCData | XmlComment | XmlPI | XmlDoctype
```

Any non-document XML node returned in the tree model.

Use the `type` discriminator before accessing node-specific fields.

```ts
import { parse, type XmlNode } from 'fino:format/xml';

const node: XmlNode | undefined = parse('<root>text</root>').root.children[0];
if (node?.type === 'text') console.log(node.data);
```

## XmlEvent

```ts
type XmlEvent = {
  type: 'startElement';
  name: string;
  prefix: string | null;
  namespace: string | null;
  attributes: Record<string, string>;
} | {
  type: 'endElement';
  name: string;
} | {
  type: 'text';
  data: string;
} | {
  type: 'cdata';
  data: string;
} | {
  type: 'comment';
  data: string;
} | {
  type: 'pi';
  target: string;
  data: string;
}
```

SAX-style parse event emitted by `parseStream()`.

Events are yielded in document order after the prolog. Start element events
contain resolved namespace metadata and attributes; end element events
contain only the element name.

```ts
import { parseStream, type XmlEvent } from 'fino:format/xml';

async function handle(event: XmlEvent) {
  if (event.type === 'text') console.log(event.data);
}
```

## XmlParseOptions

```ts
interface XmlParseOptions {
```

Options controlling XML parsing, namespaces, and entity expansion limits.

Defaults enable namespaces, preserve text whitespace, reject external
entities, cap entity expansion at 1,000,000 characters, and cap nesting
depth at 500 elements.

```ts
import { parse, type XmlParseOptions } from 'fino:format/xml';

const options: XmlParseOptions = { trim: true, maxDepth: 100 };
parse('<root> text </root>', options);
```

### namespaces

```ts
namespaces?: boolean
```

Enable XML namespace resolution. Defaults to `true`.

When disabled, element names preserve their qualified source names and
`prefix` and `namespace` are `null`.

```ts
import { parse } from 'fino:format/xml';

parse('<x:r xmlns:x="urn:x" />', { namespaces: false }).root.name;
```

### trim

```ts
trim?: boolean
```

Trim text nodes and omit empty text after trimming. Defaults to `false`.

CDATA content and comments are not trimmed by this option.

```ts
import { parse } from 'fino:format/xml';

parse('<root> text </root>', { trim: true }).root.children[0];
```

### maxEntityExpansion

```ts
maxEntityExpansion?: number
```

Maximum expanded character count from XML entity references.

Defaults to `1_000_000`. Lower this for untrusted inputs that should fail
quickly on repeated entity expansion.

```ts
import { parse } from 'fino:format/xml';

parse('<root>&amp;</root>', { maxEntityExpansion: 10 });
```

### maxDepth

```ts
maxDepth?: number
```

Maximum nested element depth. Defaults to `500`.

Deeply nested documents throw once this limit is exceeded.

```ts
import { parse } from 'fino:format/xml';

parse('<root><child /></root>', { maxDepth: 10 });
```

### resolveExternalEntities

```ts
resolveExternalEntities?: ((systemId: string) => string | null) | null
```

Optional resolver for external DTD entities.

Defaults to `null`, which rejects external entities. A resolver should
return the entity text, or `null` to ignore it. Supplying a resolver opts
into any filesystem, network, and trust-boundary risks it performs.

```ts
import { parse } from 'fino:format/xml';

parse('<!DOCTYPE r [<!ENTITY e SYSTEM "safe">]><r>&e;</r>', {
  resolveExternalEntities: (systemId) => systemId === 'safe' ? 'ok' : null,
});
```

## XmlStringifyOptions

```ts
interface XmlStringifyOptions {
```

Options controlling XML serialization.

Serialization escapes text and attribute values, optionally pretty-prints
element children, and emits an XML declaration unless disabled.

```ts
import { stringify, parse, type XmlStringifyOptions } from 'fino:format/xml';

const options: XmlStringifyOptions = { indent: '  ', xmlDeclaration: true };
stringify(parse('<root />'), options);
```

### indent

```ts
indent?: string
```

Indentation string for nested elements. Defaults to `""`.

An empty string emits compact XML without added newlines between child
nodes. A non-empty value inserts newlines around nested children.

```ts
import { parse, stringify } from 'fino:format/xml';

stringify(parse('<root><child /></root>'), { indent: '  ' });
```

### xmlDeclaration

```ts
xmlDeclaration?: boolean
```

Whether to emit the XML declaration. Defaults to `true`.

Set to `false` when embedding XML fragments or when a caller provides its
own declaration.

```ts
import { parse, stringify } from 'fino:format/xml';

stringify(parse('<root />'), { xmlDeclaration: false });
```

## parse

```ts
function parse(input: string | Uint8Array, options: XmlParseOptions = {}): XmlDocument
```

Parse XML input into a document tree.

Input may be a string or UTF-8 bytes. Well-formedness, namespace resolution,
entity expansion limits, and nesting depth are enforced during parsing.

```ts
import { parse } from 'fino:format/xml';

const doc = parse('<root><child /></root>');
```

## parseStream

```ts
async function* parseStream(
  src: AsyncIterable<Uint8Array>,
  options: XmlParseOptions = {
  },
): AsyncIterableIterator<XmlEvent>
```

Parse XML bytes into SAX-style events.

The stream parser reparses accumulated bytes until a complete document is
available and yields only newly observed events. Errors thrown after the
source is exhausted are real parse errors, while earlier chunk-boundary
stalls are retried with more input.

```ts
import { parseStream } from 'fino:format/xml';

async function* source() {
  yield new TextEncoder().encode('<root>');
  yield new TextEncoder().encode('<child /></root>');
}

for await (const event of parseStream(source())) {
  console.log(event.type);
}
```

## stringify

```ts
function stringify(doc: XmlDocument, options: XmlStringifyOptions = {}): string
```

Serialize an XML document tree.

The serializer emits the document root and ignores `prolog` nodes. Text and
attribute values are escaped, CDATA and comments are emitted as stored, and
an XML declaration is included unless `xmlDeclaration: false` is set.

```ts
import { parse, stringify } from 'fino:format/xml';

const xml = stringify(parse('<root attr="&amp;">text</root>'), {
  xmlDeclaration: false,
});
```
