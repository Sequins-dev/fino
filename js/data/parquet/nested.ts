/**
* Nested columns: the Dremel repetition/definition-level model bridging Arrow
* list/struct/map/fixed-size-list and the Parquet schema tree.
*
* Parquet has no nested storage — every column in a file is a flat stream of
* values annotated with two small integers per slot: the *definition level*
* (how many optional/repeated ancestors are actually present) and the
* *repetition level* (at which repeated ancestor this slot continues, with 0
* meaning "starts a new row"). This module implements both directions of that
* model.
*
* The central structure is the schema `Node` tree, which aligns each Parquet
* group or leaf with an Arrow field and records the maximum definition and
* repetition levels at that position. Trees are built from an Arrow schema
* with `buildNodes` (writing) or parsed from a footer's `SchemaElement` list
* with `schemaElementsToNodes` (reading); `nodesToSchemaElements` is the
* serializer for the write side. Given a tree, `shredColumn` dissects a
* nested Arrow vector into per-leaf `LeafStream`s of (value, defLevel,
* repLevel), and `assembleTree` reconstructs the nested Arrow vector from
* those streams.
*
* `reader.ts` and `writer.ts` are the two consumers: the writer shreds each
* top-level column into leaf streams and encodes them as column chunks; the
* reader decodes each chunk back into a leaf stream and assembles per
* top-level node.
*
* ```ts no_run
* import { Field, Schema, list, utf8, vectorFromArray } from 'fino:data/arrow';
* import { buildNodes, shredColumn, assembleTree } from 'internal:data/parquet/nested';
*
* const tags = new Field('tags', list(new Field('item', utf8(), true)), true);
* const [node] = buildNodes(new Schema([tags]));
*
* const vec = vectorFromArray([['a', 'b'], [], null], tags.type);
* const streams = shredColumn(node!, vec, 3);
* // streams[0].defLevels → [3, 3, 1, 0], repLevels → [0, 1, 0, 0]
*
* const rebuilt = assembleTree(node!, streams, 3);
* // rebuilt.toArray() → [['a', 'b'], [], null]
* ```
*
* Reference: https://parquet.apache.org/docs/file-format/nestedencoding/
*
* @internal
*/
import { Field, Schema, Vector, makeVector, vectorFromArray, struct as structType, list as listType, map as mapType, type DataType } from 'fino:data/arrow';
import { PType, Repetition, ConvertedType, LogicalTypeId, ParquetError } from './types.ts';
import type { SchemaElement } from './metadata.ts';
import { arrowTypeToParquet, parquetLeafToArrow, type ColumnDescriptor, type ValueConverter } from './schema.ts';
const _decoder = new TextDecoder();
const _encoder = new TextEncoder();
/**
* A node in the Parquet schema tree, aligned with an Arrow field.
*
* Group nodes (`struct`, `list`, `map`) carry their children: a struct has one
* child per member, while list and map nodes have exactly one child — the
* element node, or the `key_value` entries struct. Leaf nodes additionally
* carry the Parquet physical type, the value converters, and a ready-made
* `ColumnDescriptor` consumed by the column reader/writer.
*
* Trees come from `buildNodes` (Arrow schema, writing) or
* `schemaElementsToNodes` (file footer, reading); the level fields are what
* `shredColumn` and `assembleTree` use to interpret the flat streams.
*
* ```ts no_run
* import { buildNodes, type Node } from 'internal:data/parquet/nested';
*
* function describe(node: Node, indent = ''): void {
*   console.log(`${indent}${node.name}: ${node.kind} def=${node.defLevel} rep=${node.repLevel}`);
*   for (const child of node.children) describe(child, indent + '  ');
* }
* for (const node of buildNodes(schema)) describe(node);
* ```
*
* @internal
*/
export interface Node {
  /** Field name as it appears in the schema (Arrow field name for real fields, `list`/`element`/`key_value`/`entries` for synthetic group members). */
  name: string;
  /** Node shape. `list` covers Arrow `list`, `largelist`, and `fixedsizelist`; everything that is not a struct, list, or map is a `leaf`. */
  kind: 'leaf' | 'struct' | 'list' | 'map';
  /** Whether the field is OPTIONAL in Parquet terms — mirrors the Arrow field's nullability. */
  nullable: boolean;
  /** The Arrow field this node corresponds to. */
  field: Field;
  /**
  * Maximum definition level at this node: the level a slot carries when a
  * value is present here. For list/map nodes this is the level of a
  * present-but-empty container; entries sit one level deeper.
  */
  defLevel: number;
  /**
  * Maximum repetition level at this node — the number of repeated ancestors,
  * counting the node itself for lists and maps. A slot whose repetition
  * level equals this value continues the innermost list rather than starting
  * a new one.
  */
  repLevel: number;
  /** Child nodes; empty for leaves, exactly one for list and map nodes. */
  children: Node[];
  // leaf only:
  /** Parquet physical type (a `PType` value) — leaf nodes only. */
  physicalType?: number;
  /** Byte length for FIXED_LEN_BYTE_ARRAY leaves — leaf nodes only. */
  typeLength?: number;
  /** Parquet physical value → Arrow JS value — leaf nodes only. */
  decode?: ValueConverter;
  /** Arrow JS value → Parquet physical value — leaf nodes only. */
  encode?: ValueConverter;
  /** The descriptor handed to the column reader/writer, with the full dotted path and max levels — leaf nodes only. */
  descriptor?: ColumnDescriptor;
}
/**
* Whether an Arrow type needs nested (group) handling.
*
* True for `struct`, `list`, `largelist`, `fixedsizelist`, and `map`; false
* for every flat leaf type. Callers use this to decide between the flat
* column path and the shred/assemble path in this module.
*
* ```ts no_run
* import { Field, list, int32, utf8 } from 'fino:data/arrow';
* import { isNested } from 'internal:data/parquet/nested';
*
* isNested(utf8());                                   // false — flat leaf
* isNested(list(new Field('item', int32(), true)));   // true — needs shredding
* ```
*
* @internal
*/
export function isNested(type: DataType): boolean {
  return type.kind === 'struct' || type.kind === 'list' || type.kind === 'largelist' || type.kind === 'fixedsizelist' || type.kind === 'map';
}
// --- build node tree from Arrow --------------------------------------------
function buildNode(field: Field, parentDef: number, parentRep: number, path: string[]): Node {
  const type = field.type;
  const nullable = field.nullable;
  if (type.kind === 'struct') {
    const defLevel = parentDef + (nullable ? 1 : 0);
    const node: Node = {
      name: field.name,
      kind: 'struct',
      nullable,
      field,
      defLevel,
      repLevel: parentRep,
      children: []
    };
    node.children = type.children.map((f) => buildNode(f, defLevel, parentRep, [...path, field.name]));
    return node;
  }
  if (type.kind === 'list' || type.kind === 'largelist' || type.kind === 'fixedsizelist') {
    const groupDef = parentDef + (nullable ? 1 : 0);
    const repLevel = parentRep + 1;
    const node: Node = {
      name: field.name,
      kind: 'list',
      nullable,
      field,
      defLevel: groupDef,
      repLevel,
      children: []
    };
    node.children = [buildNode(type.child, groupDef + 1, repLevel, [
      ...path,
      field.name,
      'list'
    ])];
    return node;
  }
  if (type.kind === 'map') {
    const groupDef = parentDef + (nullable ? 1 : 0);
    const repLevel = parentRep + 1;
    const node: Node = {
      name: field.name,
      kind: 'map',
      nullable,
      field,
      defLevel: groupDef,
      repLevel,
      children: []
    };
    // The entries (key_value) group is repeated+required; its struct is required.
    node.children = [buildNode(type.child, groupDef + 1, repLevel, [
      ...path,
      field.name,
      'key_value'
    ])];
    return node;
  }
  // leaf
  const info = arrowTypeToParquet(type);
  const defLevel = parentDef + (nullable ? 1 : 0);
  const node: Node = {
    name: field.name,
    kind: 'leaf',
    nullable,
    field,
    defLevel,
    repLevel: parentRep,
    children: [],
    physicalType: info.physicalType,
    typeLength: info.typeLength,
    decode: info.decode,
    encode: info.encode
  };
  node.descriptor = {
    name: field.name,
    path: [...path, field.name],
    physicalType: info.physicalType,
    typeLength: info.typeLength,
    maxDefinitionLevel: defLevel,
    maxRepetitionLevel: parentRep,
    arrowField: field,
    decode: info.decode,
    encode: info.encode
  };
  return node;
}
/**
* Build the schema-tree nodes for an Arrow schema, one per top-level field.
*
* Levels are assigned Dremel-style: every nullable node adds one definition
* level, and every list or map adds one repetition level plus one extra
* definition level for its repeated group (distinguishing "empty" from
* "contains a null"). Each leaf gets a `ColumnDescriptor` whose `path`
* includes the synthetic `list` / `key_value` group segments, matching the
* elements `nodesToSchemaElements` writes to the footer.
*
* Throws `ParquetError` if a field uses an Arrow type with no Parquet
* mapping.
*
* ```ts no_run
* import { Field, Schema, list, int64, utf8 } from 'fino:data/arrow';
* import { buildNodes } from 'internal:data/parquet/nested';
*
* const schema = new Schema([
*   new Field('id', int64(), false),
*   new Field('tags', list(new Field('item', utf8(), true)), true)
* ]);
* const [id, tags] = buildNodes(schema);
* // id:   leaf, defLevel 0, repLevel 0
* // tags: list, defLevel 1, repLevel 1; its leaf child has defLevel 3
* ```
*
* @internal
*/
export function buildNodes(schema: Schema): Node[] {
  return schema.fields.map((f) => buildNode(f, 0, 0, []));
}
/**
* All leaf descriptors under a node, depth-first in schema order.
*
* This is exactly the order column chunks appear within a Parquet row group,
* the order `shredColumn` returns its streams, and the order `assembleTree`
* expects them. When `out` is supplied the descriptors are appended to it —
* useful for flattening several top-level nodes into one file-wide list.
*
* ```ts no_run
* import { buildNodes, collectLeaves } from 'internal:data/parquet/nested';
*
* const nodes = buildNodes(schema);
* const allLeaves = nodes.flatMap((n) => collectLeaves(n));
* // allLeaves[i] describes the i-th column chunk of every row group
* ```
*
* @internal
*/
export function collectLeaves(node: Node, out: ColumnDescriptor[] = []): ColumnDescriptor[] {
  if (node.kind === 'leaf') out.push(node.descriptor!);
  else for (const child of node.children) collectLeaves(child, out);
  return out;
}
// --- schema element (de)serialization --------------------------------------
/**
* Flatten schema-tree nodes into the Parquet `SchemaElement` list for the
* file footer.
*
* The list starts with the root element (named `schema`) and continues with
* a depth-first walk of the nodes. Lists are emitted in the standard
* three-level form `<name> (LIST) { repeated group list { element } }` and
* maps as `<name> (MAP) { repeated group key_value { required key; value } }`
* — map keys are always written as required, regardless of the Arrow key
* field's nullability.
*
* ```ts no_run
* import { buildNodes, nodesToSchemaElements } from 'internal:data/parquet/nested';
*
* const nodes = buildNodes(table.schema);
* const elements = nodesToSchemaElements(nodes);
* // elements[0] is the root: { name: 'schema', numChildren: nodes.length }
* // → serialized into FileMetaData by the writer
* ```
*
* @internal
*/
export function nodesToSchemaElements(nodes: Node[]): SchemaElement[] {
  const out: SchemaElement[] = [{
    name: 'schema',
    numChildren: nodes.length
  }];
  for (const node of nodes) emitElement(node, out);
  return out;
}
function emitElement(node: Node, out: SchemaElement[]): void {
  const rep = node.nullable ? Repetition.OPTIONAL : Repetition.REQUIRED;
  if (node.kind === 'leaf') {
    const info = arrowTypeToParquet(node.field.type);
    out.push({
      name: node.name,
      type: info.physicalType,
      typeLength: info.typeLength,
      repetitionType: rep,
      convertedType: info.convertedType,
      scale: (info as {
        scale?: number;
      }).scale,
      precision: (info as {
        precision?: number;
      }).precision,
      logicalType: info.logicalType
    });
    return;
  }
  if (node.kind === 'struct') {
    out.push({
      name: node.name,
      repetitionType: rep,
      numChildren: node.children.length
    });
    for (const child of node.children) emitElement(child, out);
    return;
  }
  if (node.kind === 'list') {
    // <rep> group <name> (LIST) { repeated group list { <element> } }
    out.push({
      name: node.name,
      repetitionType: rep,
      numChildren: 1,
      convertedType: ConvertedType.LIST,
      logicalType: { kind: 'list' }
    });
    out.push({
      name: 'list',
      repetitionType: Repetition.REPEATED,
      numChildren: 1
    });
    emitElement({
      ...node.children[0]!,
      name: 'element'
    }, out);
    return;
  }
  // map: <rep> group <name> (MAP) { repeated group key_value { required key; value } }
  out.push({
    name: node.name,
    repetitionType: rep,
    numChildren: 1,
    convertedType: ConvertedType.MAP,
    logicalType: { kind: 'map' }
  });
  out.push({
    name: 'key_value',
    repetitionType: Repetition.REPEATED,
    numChildren: 2
  });
  const entries = node.children[0]!;
  const [keyNode, valueNode] = entries.children;
  emitElement({
    ...keyNode!,
    name: 'key',
    nullable: false
  }, out);
  emitElement({
    ...valueNode!,
    name: 'value'
  }, out);
}
// --- parse schema tree (reading) -------------------------------------------
interface Cursor {
  i: number;
}
/**
* Parse a footer's `SchemaElement` list into schema-tree nodes plus the
* equivalent Arrow schema.
*
* Inverse of `nodesToSchemaElements`, but tolerant of files written by other
* implementations: groups are recognized as lists or maps by their converted
* type (`LIST`, `MAP`, `MAP_KEY_VALUE`) or logical type, and any other group
* becomes an Arrow struct. Map entries are surfaced as a required `entries`
* struct child, matching Arrow's map layout. Leaves are mapped through
* `parquetLeafToArrow`, so each node's descriptor carries working
* encode/decode converters.
*
* Throws `ParquetError` if the element list is truncated (ends before all
* declared children have been read) or a leaf has an unsupported physical
* type.
*
* ```ts no_run
* import { readFileMetaData } from 'internal:data/parquet/metadata';
* import { schemaElementsToNodes, collectLeaves } from 'internal:data/parquet/nested';
*
* const meta = readFileMetaData(footerBytes);
* const { schema, nodes } = schemaElementsToNodes(meta.schema);
* const descriptors = nodes.flatMap((n) => collectLeaves(n));
* // descriptors line up 1:1 with each row group's column chunks
* ```
*
* @internal
*/
export function schemaElementsToNodes(elements: SchemaElement[]): {
  schema: Schema;
  nodes: Node[];
} {
  const root = elements[0]!;
  const cursor: Cursor = { i: 1 };
  const nodes: Node[] = [];
  for (let c = 0; c < (root.numChildren ?? 0); c++) nodes.push(parseNode(elements, cursor, 0, 0, []));
  return {
    schema: new Schema(nodes.map((n) => n.field)),
    nodes
  };
}
function parseNode(elements: SchemaElement[], cursor: Cursor, parentDef: number, parentRep: number, path: string[]): Node {
  const el = elements[cursor.i++];
  if (el === undefined) throw new ParquetError('truncated Parquet schema');
  const nullable = el.repetitionType !== Repetition.REQUIRED;
  const numChildren = el.numChildren ?? 0;
  if (numChildren === 0) {
    // leaf
    const { type, decode, encode } = parquetLeafToArrow(el);
    const defLevel = parentDef + (nullable ? 1 : 0);
    const field = new Field(el.name, type, nullable);
    const descriptor: ColumnDescriptor = {
      name: el.name,
      path: [...path, el.name],
      physicalType: el.type ?? PType.BYTE_ARRAY,
      typeLength: el.typeLength,
      maxDefinitionLevel: defLevel,
      maxRepetitionLevel: parentRep,
      arrowField: field,
      decode,
      encode
    };
    return {
      name: el.name,
      kind: 'leaf',
      nullable,
      field,
      defLevel,
      repLevel: parentRep,
      children: [],
      physicalType: el.type,
      typeLength: el.typeLength,
      decode,
      encode,
      descriptor
    };
  }
  const isList = el.convertedType === ConvertedType.LIST || el.logicalType?.kind === 'list';
  const isMap = el.convertedType === ConvertedType.MAP || el.convertedType === ConvertedType.MAP_KEY_VALUE || el.logicalType?.kind === 'map';
  if (isList) {
    // group (LIST) { repeated group list { element } }
    const groupDef = parentDef + (nullable ? 1 : 0);
    const repLevel = parentRep + 1;
    const repeated = elements[cursor.i++]!;
    void repeated;
    const element = parseNode(elements, cursor, groupDef + 1, repLevel, [
      ...path,
      el.name,
      'list'
    ]);
    const field = new Field(el.name, listType(element.field), nullable);
    return {
      name: el.name,
      kind: 'list',
      nullable,
      field,
      defLevel: groupDef,
      repLevel,
      children: [element]
    };
  }
  if (isMap) {
    const groupDef = parentDef + (nullable ? 1 : 0);
    const repLevel = parentRep + 1;
    const keyValue = elements[cursor.i++]!;
    const kvChildren = keyValue.numChildren ?? 2;
    const entryChildren: Node[] = [];
    for (let k = 0; k < kvChildren; k++) entryChildren.push(parseNode(elements, cursor, groupDef + 1, repLevel, [
      ...path,
      el.name,
      'key_value'
    ]));
    const entriesStruct = new Field('entries', structType(entryChildren.map((n) => n.field)), false);
    const entriesNode: Node = {
      name: 'entries',
      kind: 'struct',
      nullable: false,
      field: entriesStruct,
      defLevel: groupDef + 1,
      repLevel,
      children: entryChildren
    };
    const field = new Field(el.name, mapType(entriesStruct), nullable);
    return {
      name: el.name,
      kind: 'map',
      nullable,
      field,
      defLevel: groupDef,
      repLevel,
      children: [entriesNode]
    };
  }
  // plain struct group
  const defLevel = parentDef + (nullable ? 1 : 0);
  const children: Node[] = [];
  for (let k = 0; k < numChildren; k++) children.push(parseNode(elements, cursor, defLevel, parentRep, [...path, el.name]));
  const field = new Field(el.name, structType(children.map((n) => n.field)), nullable);
  return {
    name: el.name,
    kind: 'struct',
    nullable,
    field,
    defLevel,
    repLevel: parentRep,
    children
  };
}
// --- shredding (Arrow value tree -> leaf streams) --------------------------
/**
* Per-leaf shredded column data: the flat streams Parquet actually stores.
*
* `defLevels` and `repLevels` have one entry per occurrence slot — including
* slots contributed by null or empty ancestors — while `values` holds only
* the values that are actually present (slots whose definition level equals
* the leaf's maximum). Values are in Parquet physical form: `shredColumn`
* runs them through the leaf's `encode` converter, and `assembleTree` expects
* physical values it can hand to `decode`.
*
* The reader builds one `LeafStream` per column chunk; the writer produces
* them via `shredColumn` and encodes each into pages.
*
* ```ts no_run
* import { collectLeaves, type LeafStream } from 'internal:data/parquet/nested';
*
* // An empty row group still needs one (empty) stream per leaf:
* const streams: LeafStream[] = collectLeaves(node).map((d) => ({
*   descriptor: d, values: [], defLevels: [], repLevels: []
* }));
* ```
*
* @internal
*/
export interface LeafStream {
  /** The leaf column this stream belongs to. */
  descriptor: ColumnDescriptor;
  /** Present values only, in physical (encoded) form. */
  values: unknown[];
  /** One definition level per slot; values exist only where the level equals the leaf's `maxDefinitionLevel`. */
  defLevels: number[];
  /** One repetition level per slot; 0 starts a new row, higher values continue an enclosing list. */
  repLevels: number[];
}
/**
* Shred a nested Arrow column into per-leaf streams (Dremel record
* shredding).
*
* Walks the first `numRows` values of `vec` through the node tree, appending
* one slot to every descendant leaf per occurrence. A null at any level
* emits a slot at the definition level of its deepest defined ancestor; an
* empty list or map emits a slot at the container's own `defLevel`
* (distinguishing empty from null); a present leaf value is recorded at the
* leaf's maximum definition level, encoded via its `encode` converter. The
* first item of a list carries the enclosing repetition level while
* subsequent items carry the list's own `repLevel`, so row boundaries stay
* recoverable.
*
* Streams are returned in `collectLeaves(node)` order. The writer calls this
* per record batch and concatenates the resulting streams.
*
* ```ts no_run
* import { vectorFromArray } from 'fino:data/arrow';
* import { buildNodes, shredColumn } from 'internal:data/parquet/nested';
*
* const [node] = buildNodes(schema);           // tags: nullable list<utf8>
* const vec = vectorFromArray([['a', 'b'], [], null], node!.field.type);
* const [stream] = shredColumn(node!, vec, 3);
* // stream.values:    ['a', 'b'] encoded      (present values only)
* // stream.defLevels: [3, 3, 1, 0]            (3 = present, 1 = empty, 0 = null)
* // stream.repLevels: [0, 1, 0, 0]            (1 = continues row 0's list)
* ```
*
* @internal
*/
export function shredColumn(node: Node, vec: Vector, numRows: number): LeafStream[] {
  const leaves = collectLeaves(node);
  const streams = new Map<ColumnDescriptor, LeafStream>();
  for (const d of leaves) streams.set(d, {
    descriptor: d,
    values: [],
    defLevels: [],
    repLevels: []
  });
  for (let row = 0; row < numRows; row++) {
    shredValue(node, vec.get(row), 0, 0, streams);
  }
  return leaves.map((d) => streams.get(d)!);
}
function emitAbsent(node: Node, repLevel: number, defLevel: number, streams: Map<ColumnDescriptor, LeafStream>): void {
  if (node.kind === 'leaf') {
    const s = streams.get(node.descriptor!)!;
    s.repLevels.push(repLevel);
    s.defLevels.push(defLevel);
    return;
  }
  for (const child of node.children) emitAbsent(child, repLevel, defLevel, streams);
}
function shredValue(node: Node, value: unknown, repLevel: number, defLevel: number, streams: Map<ColumnDescriptor, LeafStream>): void {
  switch (node.kind) {
    case 'leaf': {
      const s = streams.get(node.descriptor!)!;
      if (value === null || value === undefined) {
        s.repLevels.push(repLevel);
        s.defLevels.push(defLevel);
      } else {
        s.repLevels.push(repLevel);
        s.defLevels.push(node.defLevel);
        s.values.push(node.encode!(value));
      }
      return;
    }
    case 'struct': {
      if (value === null || value === undefined) {
        emitAbsent(node, repLevel, defLevel, streams);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const child of node.children) shredValue(child, obj[child.name] ?? null, repLevel, node.defLevel, streams);
      return;
    }
    case 'list': {
      if (value === null || value === undefined) {
        emitAbsent(node, repLevel, defLevel, streams);
        return;
      }
      const arr = value as unknown[];
      if (arr.length === 0) {
        emitAbsent(node.children[0]!, repLevel, node.defLevel, streams);
        return;
      }
      for (let j = 0; j < arr.length; j++) {
        shredValue(node.children[0]!, arr[j], j === 0 ? repLevel : node.repLevel, node.defLevel + 1, streams);
      }
      return;
    }
    case 'map': {
      if (value === null || value === undefined) {
        emitAbsent(node, repLevel, defLevel, streams);
        return;
      }
      const entries = value as [unknown, unknown][];
      if (entries.length === 0) {
        emitAbsent(node.children[0]!, repLevel, node.defLevel, streams);
        return;
      }
      const entriesNode = node.children[0]!;
      for (let j = 0; j < entries.length; j++) {
        const [k, v] = entries[j]!;
        shredValue(entriesNode, {
          key: k,
          value: v
        }, j === 0 ? repLevel : node.repLevel, node.defLevel + 1, streams);
      }
      return;
    }
  }
}
// --- assembly (leaf streams -> nested Arrow vector) ------------------------
interface LeafCursor {
  descriptor: ColumnDescriptor;
  values: unknown[];
  defLevels: number[];
  repLevels: number[];
  vi: number;
  li: number;
}
/**
* Reassemble a nested Arrow vector from a node's leaf streams.
*
* Inverse of `shredColumn`: consumes the definition and repetition levels of
* each stream in lockstep to rebuild `numRows` nested values, decodes present
* leaf values through each leaf's `decode` converter, and materializes the
* result as an Arrow `Vector` of the node's type — validity bitmaps and
* list/map offsets included. `streams` must be in `collectLeaves(node)` order,
* which is how the reader gets them from a row group's column chunks.
*
* For a group node, presence is decided by peeking the definition level of
* its first descendant leaf, so all streams under a node must describe the
* same row set — mixing streams from different row groups corrupts the
* output.
*
* ```ts no_run
* import { schemaElementsToNodes, assembleTree, collectLeaves } from 'internal:data/parquet/nested';
*
* const { nodes } = schemaElementsToNodes(meta.schema);
* const node = nodes[0]!;
* const streams = collectLeaves(node).map((d, i) => readLeafStream(d, chunks[i]!));
* const vector = assembleTree(node, streams, numRows);
* // vector.get(row) yields fully nested JS values (objects, arrays, entry pairs)
* ```
*
* @internal
*/
export function assembleTree(node: Node, streams: LeafStream[], numRows: number): Vector {
  const cursors = new Map<ColumnDescriptor, LeafCursor>();
  const leaves = collectLeaves(node);
  for (let i = 0; i < leaves.length; i++) {
    const s = streams[i]!;
    cursors.set(leaves[i]!, {
      descriptor: leaves[i]!,
      values: s.values,
      defLevels: s.defLevels,
      repLevels: s.repLevels,
      vi: 0,
      li: 0
    });
  }
  const jsValues: unknown[] = [];
  for (let row = 0; row < numRows; row++) jsValues.push(assembleValue(node, cursors, 0));
  return buildNested(node, jsValues);
}
// Assemble one value at `node` consuming from the representative leaf cursor;
// `repFloor` is the repetition level that starts a new item at this node.
function assembleValue(node: Node, cursors: Map<ColumnDescriptor, LeafCursor>, repFloor: number): unknown {
  const rep = repLeaf(node, cursors);
  switch (node.kind) {
    case 'leaf': {
      const cur = cursors.get(node.descriptor!)!;
      const def = cur.defLevels[cur.li]!;
      cur.li++;
      cur.repLevels[cur.li - 1];
      if (def >= node.defLevel) return cur.values[cur.vi++];
      return null;
    }
    case 'struct': {
      const def = peekDef(node, cursors);
      if (def < node.defLevel) {
        // struct is null: consume one level slot from every leaf.
        consumeAbsent(node, cursors);
        return null;
      }
      const obj: Record<string, unknown> = {};
      for (const child of node.children) obj[child.name] = assembleValue(child, cursors, repFloor);
      return obj;
    }
    case 'list': {
      const def = peekDef(node, cursors);
      if (def < node.defLevel) {
        consumeAbsent(node, cursors);
        return null;
      }
      if (def === node.defLevel) {
        // present but empty list
        consumeAbsent(node.children[0]!, cursors);
        return [];
      }
      const arr: unknown[] = [];
      arr.push(assembleValue(node.children[0]!, cursors, node.repLevel));
      while (peekRep(node.children[0]!, cursors) >= node.repLevel) {
        arr.push(assembleValue(node.children[0]!, cursors, node.repLevel));
      }
      return arr;
    }
    case 'map': {
      const def = peekDef(node, cursors);
      if (def < node.defLevel) {
        consumeAbsent(node, cursors);
        return null;
      }
      if (def === node.defLevel) {
        consumeAbsent(node.children[0]!, cursors);
        return [];
      }
      const entriesNode = node.children[0]!;
      const out: [unknown, unknown][] = [];
      const first = assembleValue(entriesNode, cursors, node.repLevel) as Record<string, unknown>;
      out.push([first.key, first.value]);
      while (peekRep(entriesNode, cursors) >= node.repLevel) {
        const e = assembleValue(entriesNode, cursors, node.repLevel) as Record<string, unknown>;
        out.push([e.key, e.value]);
      }
      return out;
    }
  }
  void rep;
}
function firstLeaf(node: Node): Node {
  let n = node;
  while (n.kind !== 'leaf') n = n.children[0]!;
  return n;
}
function repLeaf(node: Node, cursors: Map<ColumnDescriptor, LeafCursor>): number {
  const cur = cursors.get(firstLeaf(node).descriptor!)!;
  return cur.repLevels[cur.li] ?? 0;
}
function peekDef(node: Node, cursors: Map<ColumnDescriptor, LeafCursor>): number {
  const cur = cursors.get(firstLeaf(node).descriptor!)!;
  return cur.defLevels[cur.li] ?? 0;
}
function peekRep(node: Node, cursors: Map<ColumnDescriptor, LeafCursor>): number {
  const cur = cursors.get(firstLeaf(node).descriptor!)!;
  return cur.repLevels[cur.li] ?? 0;
}
// Consume exactly one level slot from every leaf under `node` (a null/empty
// occurrence contributes one slot to each descendant leaf's streams).
function consumeAbsent(node: Node, cursors: Map<ColumnDescriptor, LeafCursor>): void {
  if (node.kind === 'leaf') {
    const cur = cursors.get(node.descriptor!)!;
    cur.li++;
    return;
  }
  for (const child of node.children) consumeAbsent(child, cursors);
}
// --- build nested Arrow vector from JS values ------------------------------
function buildNested(node: Node, values: unknown[]): Vector {
  switch (node.kind) {
    case 'leaf': return vectorFromArray(values.map((v) => v === null || v === undefined ? null : node.decode!(v)), node.field.type);
    case 'struct': {
      const { validity, nullCount } = validityOf(values);
      const children = node.children.map((child) => buildNested(child, values.map((v) => v === null || v === undefined ? null : (v as Record<string, unknown>)[child.name] ?? null)));
      return makeVector({
        type: node.field.type,
        length: values.length,
        validity,
        nullCount,
        children
      });
    }
    case 'list': {
      const { validity, nullCount } = validityOf(values);
      const offsets = new Uint8Array((values.length + 1) * 4);
      const odv = new DataView(offsets.buffer);
      const flat: unknown[] = [];
      for (let i = 0; i < values.length; i++) {
        const arr = values[i];
        if (Array.isArray(arr)) flat.push(...arr);
        odv.setInt32((i + 1) * 4, flat.length, true);
      }
      const child = buildNested(node.children[0]!, flat);
      return makeVector({
        type: node.field.type,
        length: values.length,
        validity,
        nullCount,
        valueOffsets: offsets,
        children: [child]
      });
    }
    case 'map': {
      const { validity, nullCount } = validityOf(values);
      const offsets = new Uint8Array((values.length + 1) * 4);
      const odv = new DataView(offsets.buffer);
      const entriesNode = node.children[0]!;
      const entryObjs: unknown[] = [];
      for (let i = 0; i < values.length; i++) {
        const entries = values[i];
        if (Array.isArray(entries)) for (const [k, v] of entries as [unknown, unknown][]) entryObjs.push({
          key: k,
          value: v
        });
        odv.setInt32((i + 1) * 4, entryObjs.length, true);
      }
      const child = buildNested(entriesNode, entryObjs);
      return makeVector({
        type: node.field.type,
        length: values.length,
        validity,
        nullCount,
        valueOffsets: offsets,
        children: [child]
      });
    }
  }
}
function validityOf(values: unknown[]): {
  validity: Uint8Array | null;
  nullCount: number;
} {
  let nullCount = 0;
  for (const v of values) if (v === null || v === undefined) nullCount++;
  if (nullCount === 0) return {
    validity: null,
    nullCount: 0
  };
  const validity = new Uint8Array(values.length + 7 >> 3);
  for (let i = 0; i < values.length; i++) if (values[i] !== null && values[i] !== undefined) validity[i >> 3]! |= 1 << (i & 7);
  return {
    validity,
    nullCount
  };
}
void _decoder;
void _encoder;
void LogicalTypeId;
