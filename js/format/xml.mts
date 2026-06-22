/**
 * fino:format/xml - XML 1.0 + Namespaces parser and serializer.
 *
 * XML is a structured markup format used for documents, feeds, config files,
 * protocols, and interchange with older systems. This module parses XML into a
 * compact document tree, streams SAX-style events from async byte sources, and
 * serializes document trees back to XML text.
 *
 * The parser enforces XML well-formedness and XML Namespaces rules. It parses
 * internal DTD entity definitions for expansion, but it is not a validating
 * DTD processor. External entities are disabled by default to avoid XXE
 * vulnerabilities. Entity expansion and nesting depth are bounded to reduce
 * billion-laughs style attacks. Callers that supply `resolveExternalEntities`
 * are responsible for their own network, filesystem, and trust boundaries.
 *
 * Serialization is structural, not text-exact. The serializer emits the
 * document root, escapes text and attributes, and can add an XML declaration,
 * but it does not preserve prolog nodes, trailing comments or processing
 * instructions, original entity spelling, or namespace declaration attributes
 * consumed during namespace resolution. Use `namespaces: false` when a caller
 * needs namespace declaration attributes to remain ordinary attributes.
 *
 * `parseStream()` is a convenience SAX-style surface over async byte sources.
 * It reparses accumulated input until a complete document is available and is
 * therefore not a true bounded-memory streaming parser for very large XML.
 *
 * Two output surfaces:
 *   - Tree (DOM-lite):  parse(input)  -> XmlDocument
 *   - SAX/streaming:   parseStream(src) -> AsyncIterableIterator<XmlEvent>
 *
 * ```ts no_run
 * import { parse, stringify } from 'fino:format/xml';
 *
 * const doc = parse('<root attr="v"><child>text</child></root>');
 * doc.root.name;             // 'root'
 * doc.root.children[0].type; // 'element'
 * const xml = stringify(doc, { xmlDeclaration: true });
 * ```
 *
 * ```ts no_run
 * import { parseStream } from 'fino:format/xml';
 *
 * for await (const event of parseStream(byteSource)) {
 *   if (event.type === 'startElement') console.log(event.name);
 * }
 * ```
 *
 * Useful references:
 *   - XML 1.0: https://www.w3.org/TR/xml/
 *   - Namespaces in XML: https://www.w3.org/TR/xml-names/
 *   - OWASP XXE guidance: https://owasp.org/www-community/vulnerabilities/XML_External_Entity_(XXE)_Processing
 */

import { Scanner, ParseError } from 'fino:parsing/scanner';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/**
 * Error thrown when XML input is not well-formed or violates parser limits.
 *
 * The error inherits source location and diagnostic rendering from
 * `ParseError`. External entity rejection, entity expansion limits, nesting
 * depth limits, undefined entities, and mismatched close tags are reported
 * through this type.
 *
 * ```ts no_run
 * import { XmlParseError, parse } from 'fino:format/xml';
 *
 * try {
 *   parse('<root>');
 * } catch (error) {
 *   if (error instanceof XmlParseError) console.error(error.render());
 * }
 * ```
 */
export class XmlParseError extends ParseError {
  /**
   * Error name reported by `XmlParseError` instances.
   *
   * This member is emitted by the docs generator when
   * `--include-private` is enabled. It is maintained by runtime
   * internals and should be changed only with the surrounding
   * implementation contract in mind.
   *
   * @example
   * ```ts no_run
   * const error = new XmlParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
   * console.log(error.name);
   * ```
   */
  name = 'XmlParseError';
}

/**
 * Parsed XML document tree.
 *
 * A document contains exactly one root element. Processing instructions,
 * comments, and doctypes before the root are preserved in `prolog`; trailing
 * processing instructions and comments are accepted but not retained.
 *
 * ```ts no_run
 * import { parse, type XmlDocument } from 'fino:format/xml';
 *
 * const document: XmlDocument = parse('<?xml version="1.0"?><root />');
 * document.root.name;
 * ```
 */
export interface XmlDocument {
  /**
   * Discriminator for XML document values.
   *
   * Always the string literal `"document"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root />').type;
   * ```
   */
  type: 'document';
  /**
   * Root element of the document.
   *
   * XML requires exactly one root element; missing or additional element
   * content throws during parsing.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * const root = parse('<root><child /></root>').root;
   * ```
   */
  root: XmlElement;
  /**
   * Processing instructions, comments, and doctypes before the root element.
   *
   * The XML declaration is parsed and skipped rather than added as a prolog
   * processing instruction.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * const prolog = parse('<!-- note --><root />').prolog;
   * ```
   */
  prolog: XmlNode[];
}

/**
 * Element node with namespace metadata, attributes, and child nodes.
 *
 * With namespace processing enabled, `name` is the local name, `prefix`
 * contains the source prefix when present, and `namespace` contains the
 * resolved namespace URI or `null`.
 *
 * ```ts no_run
 * import { parse, type XmlElement } from 'fino:format/xml';
 *
 * const element: XmlElement = parse('<x:root xmlns:x="urn:x" />').root;
 * element.namespace; // 'urn:x'
 * ```
 */
export interface XmlElement {
  /**
   * Discriminator for element nodes.
   *
   * Always the string literal `"element"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root />').root.type;
   * ```
   */
  type: 'element';
  /**
   * Element name.
   *
   * When namespaces are enabled, this is the local name without prefix. When
   * `namespaces: false`, this preserves the qualified source name.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<x:root xmlns:x="urn:x" />').root.name;
   * ```
   */
  name: string;
  /**
   * Source namespace prefix, or `null` when absent or namespace processing is disabled.
   *
   * Prefixes are preserved for serialization, but namespace declaration
   * attributes themselves are not included in `attributes`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<x:root xmlns:x="urn:x" />').root.prefix;
   * ```
   */
  prefix: string | null;
  /**
   * Resolved namespace URI, or `null` when none is in scope.
   *
   * Set `namespaces: false` to disable namespace resolution entirely.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root xmlns="urn:default" />').root.namespace;
   * ```
   */
  namespace: string | null;
  /**
   * Element attributes as string values.
   *
   * Attribute entity references are expanded. Namespace declaration attributes
   * are consumed for namespace resolution and omitted from this record.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root id="a" />').root.attributes.id;
   * ```
   */
  attributes: Record<string, string>;
  /**
   * Child nodes in source order.
   *
   * Text nodes may be omitted when `trim` removes all text content. Self-closing
   * elements have an empty child array.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root>text<child /></root>').root.children;
   * ```
   */
  children: XmlNode[];
}

/**
 * Text node.
 *
 * Entity and character references have already been expanded. When
 * `XmlParseOptions.trim` is true, all-whitespace text nodes are omitted.
 *
 * ```ts no_run
 * import { parse, type XmlText } from 'fino:format/xml';
 *
 * const node = parse('<root>hello</root>').root.children[0] as XmlText;
 * node.data;
 * ```
 */
export interface XmlText {
  /**
   * Discriminator for text nodes.
   *
   * Always the string literal `"text"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root>hello</root>').root.children[0]?.type;
   * ```
   */
  type: 'text';
  /**
   * Text content after entity expansion.
   *
   * The string is not HTML-escaped; escape it when embedding in another output
   * format.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * (parse('<root>&amp;</root>').root.children[0] as { data: string }).data;
   * ```
   */
  data: string;
}
/**
 * CDATA node.
 *
 * CDATA contents are returned as text data without interpreting markup inside
 * the section. The serializer emits the data inside a CDATA section.
 *
 * ```ts no_run
 * import { parse, type XmlCData } from 'fino:format/xml';
 *
 * const node = parse('<root><![CDATA[<x>]]></root>').root.children[0] as XmlCData;
 * node.data;
 * ```
 */
export interface XmlCData {
  /**
   * Discriminator for CDATA nodes.
   *
   * Always the string literal `"cdata"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root><![CDATA[x]]></root>').root.children[0]?.type;
   * ```
   */
  type: 'cdata';
  /**
   * Raw CDATA section content.
   *
   * The closing `]]>` delimiter is not included.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * (parse('<root><![CDATA[x]]></root>').root.children[0] as { data: string }).data;
   * ```
   */
  data: string;
}
/**
 * XML comment node.
 *
 * Comment text excludes the `<!--` and `-->` delimiters. XML forbids `--`
 * inside comments, and such input throws during parsing.
 *
 * ```ts no_run
 * import { parse, type XmlComment } from 'fino:format/xml';
 *
 * const comment = parse('<!-- note --><root />').prolog[0] as XmlComment;
 * comment.data;
 * ```
 */
export interface XmlComment {
  /**
   * Discriminator for comment nodes.
   *
   * Always the string literal `"comment"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<!-- note --><root />').prolog[0]?.type;
   * ```
   */
  type: 'comment';
  /**
   * Comment content without delimiters.
   *
   * The string is not escaped. Do not insert untrusted comments into another
   * document format without escaping.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * (parse('<!-- note --><root />').prolog[0] as { data: string }).data;
   * ```
   */
  data: string;
}
/**
 * Processing instruction node.
 *
 * The XML declaration is parsed but skipped from document `prolog`; other
 * processing instructions are retained with their target and data.
 *
 * ```ts no_run
 * import { parse, type XmlPI } from 'fino:format/xml';
 *
 * const pi = parse('<?xml-stylesheet href="style.css"?><root />').prolog[0] as XmlPI;
 * pi.target;
 * ```
 */
export interface XmlPI {
  /**
   * Discriminator for processing instruction nodes.
   *
   * Always the string literal `"pi"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<?go now?><root />').prolog[0]?.type;
   * ```
   */
  type: 'pi';
  /**
   * Processing instruction target.
   *
   * The target is lower- or upper-case as written by the source except for
   * comparisons internal to parsing.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * (parse('<?go now?><root />').prolog[0] as { target: string }).target;
   * ```
   */
  target: string;
  /**
   * Processing instruction data after the target.
   *
   * Surrounding whitespace is trimmed by the parser. Empty processing
   * instructions use an empty string.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * (parse('<?go now?><root />').prolog[0] as { data: string }).data;
   * ```
   */
  data: string;
}
/**
 * Doctype declaration node.
 *
 * Internal entity declarations are parsed for expansion. External entities are
 * rejected unless a resolver is explicitly provided in parse options.
 *
 * ```ts no_run
 * import { parse, type XmlDoctype } from 'fino:format/xml';
 *
 * const doc = parse('<!DOCTYPE root><root />').prolog[0] as XmlDoctype;
 * doc.data;
 * ```
 */
export interface XmlDoctype {
  /**
   * Discriminator for doctype nodes.
   *
   * Always the string literal `"doctype"`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<!DOCTYPE root><root />').prolog[0]?.type;
   * ```
   */
  type: 'doctype';
  /**
   * Doctype declaration content without the `<!DOCTYPE` wrapper.
   *
   * Internal subset details are preserved only as parser output text, not as a
   * rich DTD model.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * (parse('<!DOCTYPE root><root />').prolog[0] as { data: string }).data;
   * ```
   */
  data: string;
}

/**
 * Any non-document XML node returned in the tree model.
 *
 * Use the `type` discriminator before accessing node-specific fields.
 *
 * ```ts no_run
 * import { parse, type XmlNode } from 'fino:format/xml';
 *
 * const node: XmlNode | undefined = parse('<root>text</root>').root.children[0];
 * if (node?.type === 'text') console.log(node.data);
 * ```
 */
export type XmlNode = XmlElement | XmlText | XmlCData | XmlComment | XmlPI | XmlDoctype;

/**
 * SAX-style parse event emitted by `parseStream()`.
 *
 * Events are yielded in document order after the prolog. Start element events
 * contain resolved namespace metadata and attributes; end element events
 * contain only the element name.
 *
 * ```ts no_run
 * import { parseStream, type XmlEvent } from 'fino:format/xml';
 *
 * async function handle(event: XmlEvent) {
 *   if (event.type === 'text') console.log(event.data);
 * }
 * ```
 */
export type XmlEvent =
  | {
    /**
     * Discriminator for start-element events.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'startElement', name: 'root', prefix: null, namespace: null, attributes: {} };
     * event.type;
     * ```
     */
    type: 'startElement';
    /**
     * Element name for the start tag.
     *
     * With namespaces enabled, this is the local name.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'startElement', name: 'root', prefix: null, namespace: null, attributes: {} };
     * event.name;
     * ```
     */
    name: string;
    /**
     * Source namespace prefix, or `null`.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'startElement', name: 'root', prefix: 'x', namespace: 'urn:x', attributes: {} };
     * event.prefix;
     * ```
     */
    prefix: string | null;
    /**
     * Resolved namespace URI, or `null` when none is in scope.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'startElement', name: 'root', prefix: null, namespace: 'urn:x', attributes: {} };
     * event.namespace;
     * ```
     */
    namespace: string | null;
    /**
     * Start-tag attributes as expanded string values.
     *
     * Namespace declaration attributes are omitted when namespace processing is
     * enabled.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'startElement', name: 'root', prefix: null, namespace: null, attributes: { id: 'a' } };
     * event.attributes.id;
     * ```
     */
    attributes: Record<string, string>;
  }
  | {
    /**
     * Discriminator for end-element events.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'endElement', name: 'root' };
     * event.type;
     * ```
     */
    type: 'endElement';
    /**
     * Element name for the closing tag.
     *
     * With namespaces enabled, this is the local name.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'endElement', name: 'root' };
     * event.name;
     * ```
     */
    name: string;
  }
  | {
    /**
     * Discriminator for text events.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'text', data: 'hello' };
     * event.type;
     * ```
     */
    type: 'text';
    /**
     * Text data after entity expansion.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'text', data: 'hello' };
     * event.data;
     * ```
     */
    data: string;
  }
  | {
    /**
     * Discriminator for CDATA events.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'cdata', data: '<raw>' };
     * event.type;
     * ```
     */
    type: 'cdata';
    /**
     * Raw CDATA section content.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'cdata', data: '<raw>' };
     * event.data;
     * ```
     */
    data: string;
  }
  | {
    /**
     * Discriminator for comment events.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'comment', data: 'note' };
     * event.type;
     * ```
     */
    type: 'comment';
    /**
     * Comment text without XML comment delimiters.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'comment', data: 'note' };
     * event.data;
     * ```
     */
    data: string;
  }
  | {
    /**
     * Discriminator for processing-instruction events.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'pi', target: 'go', data: 'now' };
     * event.type;
     * ```
     */
    type: 'pi';
    /**
     * Processing instruction target.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'pi', target: 'go', data: 'now' };
     * event.target;
     * ```
     */
    target: string;
    /**
     * Processing instruction data after the target.
     *
     * ```ts no_run
     * import type { XmlEvent } from 'fino:format/xml';
     *
     * const event: XmlEvent = { type: 'pi', target: 'go', data: 'now' };
     * event.data;
     * ```
     */
    data: string;
  };

/**
 * Options controlling XML parsing, namespaces, and entity expansion limits.
 *
 * Defaults enable namespaces, preserve text whitespace, reject external
 * entities, cap entity expansion at 1,000,000 characters, and cap nesting
 * depth at 500 elements.
 *
 * ```ts no_run
 * import { parse, type XmlParseOptions } from 'fino:format/xml';
 *
 * const options: XmlParseOptions = { trim: true, maxDepth: 100 };
 * parse('<root> text </root>', options);
 * ```
 */
export interface XmlParseOptions {
  /**
   * Enable XML namespace resolution. Defaults to `true`.
   *
   * When disabled, element names preserve their qualified source names and
   * `prefix` and `namespace` are `null`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<x:r xmlns:x="urn:x" />', { namespaces: false }).root.name;
   * ```
   */
  namespaces?: boolean;
  /**
   * Trim text nodes and omit empty text after trimming. Defaults to `false`.
   *
   * CDATA content and comments are not trimmed by this option.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root> text </root>', { trim: true }).root.children[0];
   * ```
   */
  trim?: boolean;
  /**
   * Maximum expanded character count from XML entity references.
   *
   * Defaults to `1_000_000`. Lower this for untrusted inputs that should fail
   * quickly on repeated entity expansion.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root>&amp;</root>', { maxEntityExpansion: 10 });
   * ```
   */
  maxEntityExpansion?: number;
  /**
   * Maximum nested element depth. Defaults to `500`.
   *
   * Deeply nested documents throw once this limit is exceeded.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<root><child /></root>', { maxDepth: 10 });
   * ```
   */
  maxDepth?: number;
  /**
   * Optional resolver for external DTD entities.
   *
   * Defaults to `null`, which rejects external entities. A resolver should
   * return the entity text, or `null` to ignore it. Supplying a resolver opts
   * into any filesystem, network, and trust-boundary risks it performs.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/xml';
   *
   * parse('<!DOCTYPE r [<!ENTITY e SYSTEM "safe">]><r>&e;</r>', {
   *   resolveExternalEntities: (systemId) => systemId === 'safe' ? 'ok' : null,
   * });
   * ```
   */
  resolveExternalEntities?: ((systemId: string) => string | null) | null;
}

/**
 * Options controlling XML serialization.
 *
 * Serialization escapes text and attribute values, optionally pretty-prints
 * element children, and emits an XML declaration unless disabled.
 *
 * ```ts no_run
 * import { stringify, parse, type XmlStringifyOptions } from 'fino:format/xml';
 *
 * const options: XmlStringifyOptions = { indent: '  ', xmlDeclaration: true };
 * stringify(parse('<root />'), options);
 * ```
 */
export interface XmlStringifyOptions {
  /**
   * Indentation string for nested elements. Defaults to `""`.
   *
   * An empty string emits compact XML without added newlines between child
   * nodes. A non-empty value inserts newlines around nested children.
   *
   * ```ts no_run
   * import { parse, stringify } from 'fino:format/xml';
   *
   * stringify(parse('<root><child /></root>'), { indent: '  ' });
   * ```
   */
  indent?: string;
  /**
   * Whether to emit the XML declaration. Defaults to `true`.
   *
   * Set to `false` when embedding XML fragments or when a caller provides its
   * own declaration.
   *
   * ```ts no_run
   * import { parse, stringify } from 'fino:format/xml';
   *
   * stringify(parse('<root />'), { xmlDeclaration: false });
   * ```
   */
  xmlDeclaration?: boolean;
}

// ---------------------------------------------------------------------------
// Parse (tree)
// ---------------------------------------------------------------------------

/**
 * Parse XML input into a document tree.
 *
 * Input may be a string or UTF-8 bytes. Well-formedness, namespace resolution,
 * entity expansion limits, and nesting depth are enforced during parsing.
 *
 * ```ts no_run
 * import { parse } from 'fino:format/xml';
 *
 * const doc = parse('<root><child /></root>');
 * ```
 */
export function parse(input: string | Uint8Array, options: XmlParseOptions = {}): XmlDocument {
  return new XmlParser(input, options).parseDocument();
}

// ---------------------------------------------------------------------------
// Parse stream (SAX)
// ---------------------------------------------------------------------------

/**
 * Parse XML bytes into SAX-style events.
 *
 * The stream parser reparses accumulated bytes until a complete document is
 * available and yields only newly observed events. Errors thrown after the
 * source is exhausted are real parse errors, while earlier chunk-boundary
 * stalls are retried with more input. Because accumulated bytes are retained
 * and reparsed, this is not a bounded-memory streaming parser for very large
 * documents.
 *
 * ```ts no_run
 * import { parseStream } from 'fino:format/xml';
 *
 * async function* source() {
 *   yield new TextEncoder().encode('<root>');
 *   yield new TextEncoder().encode('<child /></root>');
 * }
 *
 * for await (const event of parseStream(source())) {
 *   console.log(event.type);
 * }
 * ```
 */
export async function* parseStream(
  src: AsyncIterable<Uint8Array>,
  options: XmlParseOptions = {},
): AsyncIterableIterator<XmlEvent> {
  let accum = new Uint8Array(0);
  // Events already yielded to the caller. On each re-parse attempt we skip
  // this many events at the front (they were yielded in a previous iteration
  // before the parser stalled at an incomplete chunk boundary).
  let yieldedCount = 0;

  for await (const chunk of src) {
    const merged = new Uint8Array(accum.length + chunk.length);
    merged.set(accum, 0);
    merged.set(chunk, accum.length);
    accum = merged;

    let i = 0;
    try {
      for (const event of new XmlParser(accum, options).events()) {
        if (i++ >= yieldedCount) yield event;
      }
      return; // parser reached natural end-of-document
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      // Parser stalled; likely an incomplete token at the chunk boundary.
      // Record how many events were emitted before the stall; skip them on
      // the next attempt once more data arrives.
      yieldedCount = i;
    }
  }

  // Source exhausted; parse the final accumulated buffer. Any error here is
  // a genuine parse error (not a chunk-boundary truncation).
  let i = 0;
  for (const event of new XmlParser(accum, options).events()) {
    if (i++ >= yieldedCount) yield event;
  }
}

// ---------------------------------------------------------------------------
// XmlParser
// ---------------------------------------------------------------------------

const MAX_ENTITY_EXPANSION = 1_000_000;
const MAX_DEPTH = 500;

const _PREDEF: Record<string, string> = {
  lt: '<', gt: '>', amp: '&', apos: "'", quot: '"',
};

const _NS_XMLNS = 'http://www.w3.org/2000/xmlns/';
const _NS_XML   = 'http://www.w3.org/XML/1998/namespace';

class XmlParser {
  #sc: Scanner;
  #opts: XmlParseOptions;
  #entities: Record<string, string> = Object.create(_PREDEF);
  #expandedChars = 0;
  #depth = 0;
  #nsStack: Record<string, string>[] = [{ xml: _NS_XML, xmlns: _NS_XMLNS }];

  constructor(src: string | Uint8Array, opts: XmlParseOptions) {
    this.#opts = opts;
    this.#sc = new Scanner(src, { encoding: 'utf-8', format: 'xml' });
  }

  parseDocument(): XmlDocument {
    const prolog: XmlNode[] = [];
    const sc = this.#sc;
    let root: XmlElement | null = null;

    while (!sc.done) {
      sc.skipWhitespace();
      if (sc.done) break;
      if (!sc.match('<')) throw sc.error('expected <');
      const next = sc.peek();
      if (next === '?') {
        const pi = this.#parsePI();
        // Skip XML declaration
        if (pi.target.toLowerCase() !== 'xml') prolog.push(pi);
      } else if (next === '!' && sc.peekCode(1) === 0x2D && sc.peekCode(2) === 0x2D) {
        prolog.push(this.#parseComment());
      } else if (next === '!' && sc.peek(8) === '!DOCTYPE') {
        prolog.push(this.#parseDoctype());
      } else {
        root = this.#parseElement();
        break;
      }
    }

    if (!root) throw sc.error('no root element');
    sc.skipWhitespace();
    if (!sc.done) {
      // Allow comments/PIs after root
      while (!sc.done) {
        sc.skipWhitespace();
        if (sc.done) break;
        if (sc.match('<')) {
          if (sc.peek() === '?' || (sc.peek() === '!' && sc.peekCode(1) === 0x2D)) {
            if (sc.peek() === '?') this.#parsePI();
            else this.#parseComment();
          } else {
            throw sc.error('content after root element');
          }
        } else {
          throw sc.error('content after root element');
        }
      }
    }

    return { type: 'document', root, prolog };
  }

  *events(): Generator<XmlEvent, void> {
    const sc = this.#sc;
    // Skip prolog
    while (!sc.done) {
      sc.skipWhitespace();
      if (sc.done) break;
      if (sc.match('<')) {
        const next = sc.peek();
        if (next === '?') { this.#parsePI(); continue; }
        if (next === '!' && sc.peekCode(1) === 0x2D) { this.#parseComment(); continue; }
        if (sc.peek(8) === '!DOCTYPE') { this.#parseDoctype(); continue; }
        break;
      }
      break;
    }
    yield* this.#elementEvents();
  }

  *#elementEvents(): Generator<XmlEvent, void> {
    const sc = this.#sc;
    const { rawName, name, prefix, ns, attrs, selfClose } = this.#parseStartTag();

    yield { type: 'startElement', name, prefix: prefix ?? null, namespace: ns ?? null, attributes: attrs };

    if (!selfClose) {
      yield* this.#childEvents(rawName);
    }
    yield { type: 'endElement', name };
  }

  *#childEvents(parentName: string): Generator<XmlEvent, void> {
    const sc = this.#sc;
    while (!sc.done) {
      if (!sc.match('<')) {
        // Text
        const text = this.#parseCharData();
        if (text) yield { type: 'text', data: text };
        continue;
      }
      const next = sc.peek();
      if (next === '/') {
        sc.eat(); // consume /
        const closeName = this.#parseEndTagName();
        sc.expect('>');
        if (closeName !== parentName) throw sc.error(`mismatched close tag: expected </${parentName}>, got </${closeName}>`);
        if (this.#opts.namespaces !== false && this.#nsStack.length > 1) this.#nsStack.pop();
        return;
      }
      if (next === '!' && sc.peekCode(1) === 0x5B) {
        yield { type: 'cdata', data: this.#parseCData() };
      } else if (next === '!' && sc.peekCode(1) === 0x2D) {
        yield { type: 'comment', data: this.#parseComment().data };
      } else if (next === '?') {
        const pi = this.#parsePI();
        yield { type: 'pi', target: pi.target, data: pi.data };
      } else {
        yield* this.#elementEvents();
      }
    }
    throw sc.error(`unclosed element <${parentName}>`);
  }

  #parseElement(): XmlElement {
    const { rawName, name, prefix, ns, attrs, selfClose } = this.#parseStartTag();
    if (++this.#depth > (this.#opts.maxDepth ?? MAX_DEPTH)) throw this.#sc.error('element nesting too deep');
    const children: XmlNode[] = [];
    if (!selfClose) {
      this.#parseChildren(rawName, children);
    }
    this.#depth--;
    return { type: 'element', name, prefix: prefix ?? null, namespace: ns ?? null, attributes: attrs, children };
  }

  #parseStartTag() {
    const sc = this.#sc;
    const useNs = this.#opts.namespaces !== false;
    const nsFrame: Record<string, string> = {};

    const name = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x2F && c !== 0x3E);
    if (!name) throw sc.error('expected element name');
    this.#validateName(name);
    if (useNs) this.#validateQName(name);

    const attrs: Record<string, string> = {};
    const rawAttrs: Record<string, string> = {};
    const rawAttrNames = new Set<string>();

    // Parse attributes
    while (!sc.done) {
      sc.skipWhitespace();
      const ch = sc.peek();
      if (ch === '/' || ch === '>') break;
      const aname = sc.eatWhile(c => c !== 0x3D && c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x2F && c !== 0x3E);
      if (!aname) break;
      this.#validateName(aname);
      if (useNs && aname !== 'xmlns' && !aname.startsWith('xmlns:')) this.#validateQName(aname);
      if (rawAttrNames.has(aname)) throw sc.error(`duplicate attribute: ${aname}`);
      rawAttrNames.add(aname);
      sc.skipWhitespace();
      sc.expect('=');
      sc.skipWhitespace();
      const q = sc.eat();
      if (q !== '"' && q !== "'") throw sc.error('expected quote for attribute value');
      let val = '';
      while (!sc.done && sc.peek() !== q) {
        val += this.#parseAttrChar(sc, q);
      }
      sc.expect(q);
      rawAttrs[aname] = val;
      if (useNs && aname === 'xmlns') nsFrame[''] = val;
      else if (useNs && aname.startsWith('xmlns:')) {
        const nsPrefix = aname.slice(6);
        this.#validateNCName(nsPrefix);
        if (val === '') throw sc.error(`prefix undeclaring is not allowed: ${nsPrefix}`);
        nsFrame[nsPrefix] = val;
      }
    }

    const selfClose = sc.eatChar('/');
    sc.expect('>');

    if (useNs) this.#validateNamespaceDeclarations(nsFrame);

    // Build namespace map
    let pushedNs = false;
    if (useNs && Object.keys(nsFrame).length > 0) {
      this.#nsStack.push({ ...this.#nsStack[this.#nsStack.length - 1]!, ...nsFrame });
      pushedNs = true;
    }

    // Resolve element namespace
    const [elemPrefix, localName] = _splitName(name);
    const nsMap = this.#nsStack[this.#nsStack.length - 1]!;
    const ns = useNs ? (elemPrefix ? (nsMap[elemPrefix] ?? null) : (nsMap[''] ?? null)) : null;
    if (useNs && elemPrefix) {
      if (elemPrefix === 'xmlns') throw sc.error('reserved namespace prefix used as element name: xmlns');
      if (ns === null) throw sc.error(`unbound namespace prefix: ${elemPrefix}`);
    }

    // Resolve attribute namespaces and populate attrs
    const expandedAttrs = new Set<string>();
    for (const [aname, val] of Object.entries(rawAttrs)) {
      if (useNs && (aname === 'xmlns' || aname.startsWith('xmlns:'))) continue;
      if (useNs) {
        const [attrPrefix, attrLocal] = _splitName(aname);
        const attrNs = attrPrefix ? (nsMap[attrPrefix] ?? null) : null;
        if (attrPrefix) {
          if (attrNs === null) throw sc.error(`unbound namespace prefix: ${attrPrefix}`);
          if (attrPrefix === 'xmlns') throw sc.error('reserved namespace prefix used as attribute name: xmlns');
        }
        const expandedName = `${attrNs ?? ''}\u0000${attrLocal}`;
        if (expandedAttrs.has(expandedName)) throw sc.error(`duplicate attribute: ${aname}`);
        expandedAttrs.add(expandedName);
      }
      attrs[aname] = val;
    }

    if (selfClose && pushedNs) this.#nsStack.pop();

    return { rawName: name, name: useNs ? localName : name, prefix: useNs ? elemPrefix : null, ns, attrs, selfClose };
  }

  #parseChildren(parentName: string, children: XmlNode[]): void {
    const sc = this.#sc;
    const useNs = this.#opts.namespaces !== false;
    while (!sc.done) {
      if (!sc.match('<')) {
        const text = this.#parseCharData();
        if (text) {
          const t = this.#opts.trim ? text.trim() : text;
          if (t) children.push({ type: 'text', data: t });
        }
        continue;
      }
      const next = sc.peek();
      if (next === '/') {
        sc.eat();
        const closeName = this.#parseEndTagName();
        sc.expect('>');
        if (closeName !== parentName) {
          throw sc.error(`mismatched close tag: expected </${parentName}>, got </${closeName}>`);
        }
        if (useNs && this.#nsStack.length > 1) this.#nsStack.pop();
        return;
      }
      if (next === '!' && sc.peekCode(1) === 0x5B) {
        const cdata = this.#parseCData();
        children.push({ type: 'cdata', data: cdata });
      } else if (next === '!' && sc.peekCode(1) === 0x2D) {
        children.push(this.#parseComment());
      } else if (next === '?') {
        children.push(this.#parsePI());
      } else {
        children.push(this.#parseElement());
      }
    }
    throw sc.error(`unclosed element <${parentName}>`);
  }

  #parseEndTagName(): string {
    const sc = this.#sc;
    const useNs = this.#opts.namespaces !== false;
    const closeName = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D && c !== 0x3E);
    if (!closeName) throw sc.error('expected element name');
    this.#validateName(closeName);
    if (useNs) {
      this.#validateQName(closeName);
      const [prefix] = _splitName(closeName);
      if (prefix && !(prefix in this.#nsStack[this.#nsStack.length - 1]!)) {
        throw sc.error(`unbound namespace prefix: ${prefix}`);
      }
    }
    sc.skipWhitespace();
    return closeName;
  }

  #parseCharData(): string {
    const sc = this.#sc;
    let s = '';
    while (!sc.done && sc.peek() !== '<') {
      if (sc.peek() === '&') { s += this.#parseEntityRef(); continue; }
      s += sc.eat();
    }
    return s;
  }

  #parseAttrChar(sc: Scanner, quote: string): string {
    if (sc.peek() === '&') return this.#parseEntityRef();
    const ch = sc.eat();
    if (ch === '<') throw sc.error('< not allowed in attribute value');
    return ch;
  }

  #parseEntityRef(): string {
    const sc = this.#sc;
    sc.expect('&');
    if (sc.eatChar('#')) {
      let hex = false;
      if (sc.eatChar('x')) hex = true;
      const digits = sc.eatWhile(c => hex
        ? (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
        : (c >= 0x30 && c <= 0x39));
      sc.expect(';');
      if (digits.length === 0) throw sc.error('invalid character reference');
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!isXmlChar(cp)) throw sc.error(`invalid XML character reference: ${digits}`);
      this.#addExpandedChars(1);
      return String.fromCodePoint(cp);
    }
    const name = sc.eatWhile(c => c !== 0x3B);
    sc.expect(';');
    this.#validateName(name);
    if (name in _PREDEF) return _PREDEF[name]!;
    if (name in this.#entities) {
      const expanded = this.#expandEntity(name, []);
      this.#addExpandedChars(expanded.length);
      return expanded;
    }
    throw sc.error(`undefined entity: &${name};`);
  }

  #expandEntity(name: string, stack: string[]): string {
    if (stack.includes(name)) throw this.#sc.error(`recursive entity reference: ${name}`);
    const value = this.#entities[name];
    if (value === undefined) throw this.#sc.error(`undefined entity: &${name};`);
    return this.#expandEntityText(value, [...stack, name]);
  }

  #expandEntityText(value: string, stack: string[]): string {
    let out = '';
    for (let i = 0; i < value.length;) {
      const amp = value.indexOf('&', i);
      if (amp === -1) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, amp);
      const semi = value.indexOf(';', amp + 1);
      if (semi === -1) throw this.#sc.error('unterminated entity reference');
      const ref = value.slice(amp + 1, semi);
      if (ref.startsWith('#')) {
        out += this.#expandCharacterReference(ref.slice(1));
      } else if (ref in _PREDEF) {
        out += _PREDEF[ref]!;
      } else if (ref in this.#entities) {
        const expanded = this.#expandEntity(ref, stack);
        this.#addExpandedChars(expanded.length);
        out += expanded;
      } else {
        throw this.#sc.error(`undefined entity: &${ref};`);
      }
      i = semi + 1;
    }
    return out;
  }

  #expandCharacterReference(body: string): string {
    const hex = body.startsWith('x');
    const digits = hex ? body.slice(1) : body;
    if (digits.length === 0) throw this.#sc.error('invalid character reference');
    const validDigits = hex ? /^[0-9A-Fa-f]+$/.test(digits) : /^[0-9]+$/.test(digits);
    if (!validDigits) throw this.#sc.error('invalid character reference');
    const cp = parseInt(digits, hex ? 16 : 10);
    if (!isXmlChar(cp)) throw this.#sc.error(`invalid XML character reference: ${digits}`);
    this.#addExpandedChars(1);
    return String.fromCodePoint(cp);
  }

  #addExpandedChars(count: number): void {
    this.#expandedChars += count;
    if (this.#expandedChars > (this.#opts.maxEntityExpansion ?? MAX_ENTITY_EXPANSION)) {
      throw this.#sc.error('entity expansion limit exceeded');
    }
  }

  #parseCData(): string {
    const sc = this.#sc;
    sc.match('![CDATA[');
    let s = '';
    while (!sc.done) {
      if (sc.match(']]>')) return s;
      s += sc.eat();
    }
    throw sc.error('unterminated CDATA section');
  }

  #parseComment(): XmlComment {
    const sc = this.#sc;
    sc.match('!--');
    let s = '';
    while (!sc.done) {
      if (sc.match('-->')) return { type: 'comment', data: s };
      if (sc.peek() === '-' && sc.peekCode(1) === 0x2D) throw sc.error('-- not allowed inside comment');
      s += sc.eat();
    }
    throw sc.error('unterminated comment');
  }

  #parsePI(): XmlPI {
    const sc = this.#sc;
    sc.expect('?');
    const target = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x3F && c !== 0x3E);
    if (!target) throw sc.error('expected processing instruction target');
    this.#validateName(target);
    if (this.#opts.namespaces !== false) this.#validateNCName(target);
    if (target.toLowerCase() === 'xml' && !this.#sc.done) {
      // XML declaration: consume it
      const decl = sc.eatWhile(c => c !== 0x3F);
      sc.match('?>');
      return { type: 'pi', target, data: decl.trim() };
    }
    sc.skipWhitespace();
    const data = sc.eatWhile(c => !(c === 0x3F && sc.peekCode(1) === 0x3E));
    sc.match('?>');
    return { type: 'pi', target, data: data.trim() };
  }

  #parseDoctype(): XmlDoctype {
    const sc = this.#sc;
    sc.match('!DOCTYPE');
    sc.skipWhitespace();
    let depth = 0;
    let s = '';
    while (!sc.done) {
      const ch = sc.eat();
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === '>' && depth === 0) break;
      s += ch;

      // Parse entity definitions from internal DTD subset
      if (s.endsWith('<!ENTITY')) {
        const entityMark = sc.mark();
        sc.skipWhitespace();
        const ename = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A);
        this.#validateName(ename);
        if (this.#opts.namespaces !== false) this.#validateNCName(ename);
        sc.skipWhitespace();

        if (sc.peek() === '"' || sc.peek() === "'") {
          // Internal entity definition
          const q = sc.eat();
          let val = '';
          while (!sc.done && sc.peek() !== q) val += sc.eat();
          sc.expect(q);
          sc.skipWhitespace();
          sc.expect('>');
          if (!(ename in _PREDEF)) this.#entities[ename] = val;
        } else if (sc.match('SYSTEM') || sc.match('PUBLIC')) {
          // External entity: consume the identifier(s) then reject or resolve
          sc.skipWhitespace();
          let firstId = '';
          if (sc.peek() === '"' || sc.peek() === "'") {
            const q = sc.eat();
            firstId = sc.eatUntil(c => c === q.charCodeAt(0));
            sc.expect(q);
          }
          // PUBLIC has two identifiers; second is the system ID
          sc.skipWhitespace();
          let systemId = firstId;
          if (sc.peek() === '"' || sc.peek() === "'") {
            const q = sc.eat();
            systemId = sc.eatUntil(c => c === q.charCodeAt(0));
            sc.expect(q);
          }
          sc.skipWhitespace();
          sc.expect('>');

          const resolver = this.#opts.resolveExternalEntities;
          if (typeof resolver === 'function') {
            const val = resolver(systemId);
            if (val !== null && !(ename in _PREDEF)) this.#entities[ename] = val;
          } else {
            throw sc.error(
              `external entity rejected: ${ename} (set resolveExternalEntities to opt in)`,
              entityMark,
            );
          }
        }
        s += ename;
      }
    }
    return { type: 'doctype', data: s.trim() };
  }

  #validateName(name: string): void {
    if (!isXmlName(name)) throw this.#sc.error(`invalid XML name: ${name}`);
  }

  #validateNCName(name: string): void {
    if (!isXmlName(name) || name.includes(':')) throw this.#sc.error(`invalid XML name: ${name}`);
  }

  #validateQName(name: string): void {
    const parts = name.split(':');
    if (
      parts.length > 2 ||
      parts.some(part => part.length === 0) ||
      parts.some(part => !isXmlName(part) || part.includes(':'))
    ) {
      throw this.#sc.error(`invalid QName: ${name}`);
    }
  }

  #validateNamespaceDeclarations(nsFrame: Record<string, string>): void {
    for (const [prefix, uri] of Object.entries(nsFrame)) {
      if (prefix === 'xml' && uri !== _NS_XML) {
        throw this.#sc.error('reserved namespace prefix xml must use the XML namespace name');
      }
      if (prefix !== 'xml' && uri === _NS_XML) {
        throw this.#sc.error('reserved namespace name for xml cannot be bound to another prefix or default namespace');
      }
      if (prefix === 'xmlns' || uri === _NS_XMLNS) {
        throw this.#sc.error('reserved namespace prefix or name cannot be redeclared: xmlns');
      }
    }
  }
}

function _splitName(name: string): [string | null, string] {
  const i = name.indexOf(':');
  if (i === -1) return [null, name];
  return [name.slice(0, i), name.slice(i + 1)];
}

function isXmlName(name: string): boolean {
  if (name.length === 0) return false;
  let first = true;
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (first) {
      if (!isXmlNameStartChar(cp)) return false;
      first = false;
    } else if (!isXmlNameChar(cp)) {
      return false;
    }
  }
  return true;
}

function isXmlNameStartChar(cp: number): boolean {
  return cp === 0x3A ||
    (cp >= 0x41 && cp <= 0x5A) ||
    cp === 0x5F ||
    (cp >= 0x61 && cp <= 0x7A) ||
    (cp >= 0xC0 && cp <= 0xD6) ||
    (cp >= 0xD8 && cp <= 0xF6) ||
    (cp >= 0xF8 && cp <= 0x2FF) ||
    (cp >= 0x370 && cp <= 0x37D) ||
    (cp >= 0x37F && cp <= 0x1FFF) ||
    (cp >= 0x200C && cp <= 0x200D) ||
    (cp >= 0x2070 && cp <= 0x218F) ||
    (cp >= 0x2C00 && cp <= 0x2FEF) ||
    (cp >= 0x3001 && cp <= 0xD7FF) ||
    (cp >= 0xF900 && cp <= 0xFDCF) ||
    (cp >= 0xFDF0 && cp <= 0xFFFD) ||
    (cp >= 0x10000 && cp <= 0xEFFFF);
}

function isXmlNameChar(cp: number): boolean {
  return isXmlNameStartChar(cp) ||
    cp === 0x2D ||
    cp === 0x2E ||
    (cp >= 0x30 && cp <= 0x39) ||
    cp === 0xB7 ||
    (cp >= 0x0300 && cp <= 0x036F) ||
    (cp >= 0x203F && cp <= 0x2040);
}

function isXmlChar(cp: number): boolean {
  return cp === 0x09 ||
    cp === 0x0A ||
    cp === 0x0D ||
    (cp >= 0x20 && cp <= 0xD7FF) ||
    (cp >= 0xE000 && cp <= 0xFFFD) ||
    (cp >= 0x10000 && cp <= 0x10FFFF);
}

// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------

/**
 * Serialize an XML document tree.
 *
 * The serializer emits the document root and ignores `prolog` nodes. Text and
 * attribute values are escaped, CDATA and comments are emitted as stored, and
 * an XML declaration is included unless `xmlDeclaration: false` is set.
 * Serializer output is normalized: it does not preserve source entity spelling,
 * trailing document comments or processing instructions, or namespace
 * declaration attributes removed during namespace resolution.
 *
 * ```ts no_run
 * import { parse, stringify } from 'fino:format/xml';
 *
 * const xml = stringify(parse('<root attr="&amp;">text</root>'), {
 *   xmlDeclaration: false,
 * });
 * ```
 */
export function stringify(doc: XmlDocument, options: XmlStringifyOptions = {}): string {
  const indent = options.indent ?? '';
  let out = '';
  if (options.xmlDeclaration !== false) out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += stringifyNode(doc.root, indent, 0);
  return out;
}

function stringifyNode(node: XmlNode, indent: string, depth: number): string {
  const pad = indent.repeat(depth);
  switch (node.type) {
    case 'element': return stringifyElement(node, indent, depth);
    case 'text':    return pad + _escapeText(node.data);
    case 'cdata':   return `${pad}<![CDATA[${node.data}]]>`;
    case 'comment': return `${pad}<!--${node.data}-->`;
    case 'pi':      return `${pad}<?${node.target}${node.data ? ' ' + node.data : ''}?>`;
    case 'doctype': return `${pad}<!DOCTYPE ${node.data}>`;
  }
}

function stringifyElement(el: XmlElement, indent: string, depth: number): string {
  const pad = indent.repeat(depth);
  const nameStr = el.prefix ? `${el.prefix}:${el.name}` : el.name;
  const attrs = Object.entries(el.attributes)
    .map(([k, v]) => ` ${k}="${_escapeAttr(v)}"`)
    .join('');
  if (el.children.length === 0) return `${pad}<${nameStr}${attrs}/>`;
  const childStr = el.children.map(c => stringifyNode(c, indent, depth + 1)).join(indent ? '\n' : '');
  const inner = indent ? `\n${childStr}\n${pad}` : childStr;
  return `${pad}<${nameStr}${attrs}>${inner}</${nameStr}>`;
}

function _escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
