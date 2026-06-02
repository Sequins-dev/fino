# xml

fino:format/xml — XML 1.0 + Namespaces parser and serializer.

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
  - Tree (DOM-lite):  parse(input)  → XmlDocument
  - SAX/streaming:   parseStream(src) → AsyncIterableIterator<XmlEvent>

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

### name

```ts
name
```

## XmlDocument

```ts
interface XmlDocument {
```

Parsed XML document tree.

### type

```ts
type: 'document'
```

### root

```ts
root: XmlElement
```

### prolog

```ts
prolog: XmlNode[]
```

## XmlElement

```ts
interface XmlElement {
```

Element node with namespace metadata, attributes, and child nodes.

### type

```ts
type: 'element'
```

### name

```ts
name: string
```

### prefix

```ts
prefix: string | null
```

### namespace

```ts
namespace: string | null
```

### attributes

```ts
attributes: Record<string, string>
```

### children

```ts
children: XmlNode[]
```

## XmlText

```ts
interface XmlText {
```

Text node.

### type

```ts
type: 'text'
```

### data

```ts
data: string
```

## XmlCData

```ts
interface XmlCData {
```

CDATA node.

### type

```ts
type: 'cdata'
```

### data

```ts
data: string
```

## XmlComment

```ts
interface XmlComment {
```

XML comment node.

### type

```ts
type: 'comment'
```

### data

```ts
data: string
```

## XmlPI

```ts
interface XmlPI {
```

Processing instruction node.

### type

```ts
type: 'pi'
```

### target

```ts
target: string
```

### data

```ts
data: string
```

## XmlDoctype

```ts
interface XmlDoctype {
```

Doctype declaration node.

### type

```ts
type: 'doctype'
```

### data

```ts
data: string
```

## XmlNode

```ts
type XmlNode = XmlElement | XmlText | XmlCData | XmlComment | XmlPI | XmlDoctype
```

Any non-document XML node returned in the tree model.

## XmlEvent

```ts
type XmlEvent = | { type: 'startElement'; name: string; prefix: string | null; namespace: string | null; attributes: Record<string, string> } | { type: 'endElement'; name: string } | { type: 'text'; data: string } | { type: 'cdata'; data: string } | { type: 'comment'; data: string } | { type: 'pi'; target: string; data: string }
```

SAX-style parse event emitted by parseStream().

## XmlParseOptions

```ts
interface XmlParseOptions {
```

Options controlling XML parsing, namespaces, and entity expansion limits.

### namespaces

```ts
namespaces?: boolean
```

### trim

```ts
trim?: boolean
```

### maxEntityExpansion

```ts
maxEntityExpansion?: number
```

### maxDepth

```ts
maxDepth?: number
```

### resolveExternalEntities

```ts
resolveExternalEntities?: ((systemId: string) => string | null) | null
```

## XmlStringifyOptions

```ts
interface XmlStringifyOptions {
```

Options controlling XML serialization.

### indent

```ts
indent?: string
```

### xmlDeclaration

```ts
xmlDeclaration?: boolean
```

## parse

```ts
function parse(input: string | Uint8Array, options: XmlParseOptions = {}): XmlDocument
```

Parse XML input into a document tree.

```ts
import { parse } from 'fino:format/xml';

const doc = parse('<root><child /></root>');
```

## parseStream

```ts
async function* parseStream( src: AsyncIterable<Uint8Array>, options: XmlParseOptions = {}, ): AsyncIterableIterator<XmlEvent>
```

Parse XML bytes into SAX-style events.

## stringify

```ts
function stringify(doc: XmlDocument, options: XmlStringifyOptions = {}): string
```

Serialize an XML document tree.
