/**
* Nested columns: the Dremel repetition/definition-level model bridging Arrow
* list/struct/map/fixed-size-list and the Parquet schema tree.
*
* A schema `Node` tree is built from (or parsed into) an Arrow schema; each leaf
* carries its max definition/repetition levels. `shredColumn` dissects a nested
* Arrow vector into per-leaf (value, defLevel, repLevel) streams; `assembleTree`
* reconstructs the nested Arrow vector from those streams.
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
/** A node in the Parquet schema tree, aligned with an Arrow field. @internal */
export interface Node {
  name: string;
  kind: 'leaf' | 'struct' | 'list' | 'map';
  nullable: boolean;
  field: Field;
  defLevel: number;
  repLevel: number;
  children: Node[];
  // leaf only:
  physicalType?: number;
  typeLength?: number;
  decode?: ValueConverter;
  encode?: ValueConverter;
  descriptor?: ColumnDescriptor;
}
/** Whether a type needs nested (group) handling. @internal */
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
/** Build the schema-tree nodes for an Arrow schema. @internal */
export function buildNodes(schema: Schema): Node[] {
  return schema.fields.map((f) => buildNode(f, 0, 0, []));
}
/** All leaf descriptors under a node, in column order. @internal */
export function collectLeaves(node: Node, out: ColumnDescriptor[] = []): ColumnDescriptor[] {
  if (node.kind === 'leaf') out.push(node.descriptor!);
  else for (const child of node.children) collectLeaves(child, out);
  return out;
}
// --- schema element (de)serialization --------------------------------------
/** Emit the Parquet `SchemaElement` list for schema-tree nodes. @internal */
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
/** Parse Parquet `SchemaElement`s into schema-tree nodes + an Arrow schema. @internal */
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
/** Per-leaf shredded column data. @internal */
export interface LeafStream {
  descriptor: ColumnDescriptor;
  values: unknown[];
  defLevels: number[];
  repLevels: number[];
}
/** Shred a nested Arrow column into per-leaf streams. @internal */
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
/** Reassemble a nested Arrow vector from a node's leaf streams. @internal */
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
