/**
 * Protocol-agnostic helpers over the `Protocol` interface: schema-less reading
 * and writing of arbitrary Thrift.
 *
 * Thrift's wire formats are self-describing enough to be decoded without the
 * original `.thrift` schema — every field carries its type code and id, and
 * every container carries its element types. This module leans on that to offer
 * two things generated code normally hand-writes: `skip()`, which discards a
 * value of a known `TType` (the mechanism that makes Thrift forward-compatible —
 * a reader drops fields it doesn't recognize), and a generic tagged value model
 * (`ThriftValue`) with symmetric `readValue`/`writeValue` and
 * `readStruct`/`writeStruct`, so a whole message can be round-tripped, inspected,
 * or transcoded between protocols without a single schema-specific line.
 *
 * The value model is a discriminated union keyed on `TType`: scalars carry their
 * JS value (I64 as `bigint`, STRING decoded as text), structs carry a
 * `Map<fieldId, ThriftValue>`, and containers carry their element type codes
 * alongside their contents so a value decoded from one protocol can be
 * re-encoded on another. Reach for these helpers when you need to walk or
 * transform unknown Thrift; drive the `Protocol` scalar methods directly when
 * you know the schema and want typed structs.
 *
 * ```ts no_run
 * import { CompactProtocol, BinaryProtocol, TType } from 'internal:format/thrift';
 * import { readStruct, writeStruct } from 'internal:format/thrift/value';
 *
 * // Decode a struct from the compact wire form with no schema...
 * const fields = readStruct(new CompactProtocol(incoming));
 * fields.get(1); // e.g. { type: TType.STRING, value: 'hello' }
 *
 * // ...then re-encode the exact same value on the binary protocol.
 * const out = new BinaryProtocol();
 * writeStruct(out, fields);
 * const binary = out.bytes();
 * ```
 *
 * @internal
 */
import { type Protocol } from './protocol.ts';
import { TType } from './types.ts';
/**
 * A self-describing Thrift value: a discriminated union whose `type` tag is the
 * numeric `TType` code of the value it holds.
 *
 * Scalar variants pair the tag with the decoded JS value — BOOL is a `boolean`,
 * BYTE/I16/I32/DOUBLE are `number`, I64 is a `bigint` (to preserve the full
 * 64-bit range), and STRING is a decoded `string`. STRUCT carries its members as
 * a `Map` from field id to nested `ThriftValue`. The container variants (LIST,
 * SET, MAP) additionally carry their element type codes (`elemType`, or
 * `keyType`/`valueType`), because those types live in the container header on the
 * wire and are needed to re-encode the value on any protocol.
 *
 * Because the value is fully self-describing, one decoded with `readValue` on one
 * protocol can be handed straight to `writeValue` on another — that is how a
 * message is transcoded between the binary, compact, and JSON formats.
 *
 * ```ts no_run
 * import { TType } from 'internal:format/thrift';
 * import type { ThriftValue } from 'internal:format/thrift/value';
 *
 * const point: ThriftValue = {
 *   type: TType.STRUCT,
 *   fields: new Map<number, ThriftValue>([
 *     [1, { type: TType.I32, value: 10 }],
 *     [2, { type: TType.I32, value: 20 }],
 *     [3, { type: TType.I64, value: 9_000_000_000n }],
 *   ]),
 * };
 *
 * const tags: ThriftValue = {
 *   type: TType.LIST,
 *   elemType: TType.STRING,
 *   values: [
 *     { type: TType.STRING, value: 'a' },
 *     { type: TType.STRING, value: 'b' },
 *   ],
 * };
 * ```
 *
 * @internal
 */
export type ThriftValue =
  | {
      type: 2;
      value: boolean;
    }
  | {
      type: 3;
      value: number;
    }
  | {
      type: 6;
      value: number;
    }
  | {
      type: 8;
      value: number;
    }
  | {
      type: 10;
      value: bigint;
    }
  | {
      type: 4;
      value: number;
    }
  | {
      type: 11;
      value: string;
    }
  | {
      type: 12;
      fields: Map<number, ThriftValue>;
    }
  | {
      type: 15;
      elemType: number;
      values: ThriftValue[];
    }
  | {
      type: 14;
      elemType: number;
      values: ThriftValue[];
    }
  | {
      type: 13;
      keyType: number;
      valueType: number;
      entries: [ThriftValue, ThriftValue][];
    };
/**
 * Read and discard one value of the given `TType`, advancing the reader past it.
 *
 * This is the forward-compatibility primitive: when a struct reader encounters a
 * field id it does not know, it calls `skip` with the field's declared type to
 * consume exactly that value — recursing through nested structs and containers —
 * and continues with the next field. Nothing is materialized; the only effect is
 * moving the cursor to the byte after the value.
 *
 * Throws `TypeError` for a `type` that has no readable representation (for
 * example `TType.STOP` or `TType.VOID`); propagates a `ThriftError` if the
 * underlying bytes are truncated or malformed.
 *
 * ```ts no_run
 * import { CompactProtocol, TType } from 'internal:format/thrift';
 * import { skip } from 'internal:format/thrift/value';
 *
 * // Read a struct but keep only field 1, skipping every other field.
 * const p = new CompactProtocol(bytes);
 * p.readStructBegin();
 * let name: string | undefined;
 * for (;;) {
 *   const f = p.readFieldBegin();
 *   if (f.type === TType.STOP) break;
 *   if (f.id === 1 && f.type === TType.STRING) name = p.readString();
 *   else skip(p, f.type);
 *   p.readFieldEnd();
 * }
 * p.readStructEnd();
 * ```
 *
 * @internal
 */
export function skip(protocol: Protocol, type: number): void {
  switch (type) {
    case TType.BOOL:
      protocol.readBool();
      return;
    case TType.BYTE:
      protocol.readByte();
      return;
    case TType.I16:
      protocol.readI16();
      return;
    case TType.I32:
      protocol.readI32();
      return;
    case TType.I64:
      protocol.readI64();
      return;
    case TType.DOUBLE:
      protocol.readDouble();
      return;
    case TType.STRING:
      protocol.readBinary();
      return;
    case TType.STRUCT: {
      protocol.readStructBegin();
      for (;;) {
        const field = protocol.readFieldBegin();
        if (field.type === TType.STOP) break;
        skip(protocol, field.type);
        protocol.readFieldEnd();
      }
      protocol.readStructEnd();
      return;
    }
    case TType.MAP: {
      const header = protocol.readMapBegin();
      for (let i = 0; i < header.size; i++) {
        skip(protocol, header.keyType);
        skip(protocol, header.valueType);
      }
      protocol.readMapEnd();
      return;
    }
    case TType.SET: {
      const header = protocol.readSetBegin();
      for (let i = 0; i < header.size; i++) skip(protocol, header.elemType);
      protocol.readSetEnd();
      return;
    }
    case TType.LIST: {
      const header = protocol.readListBegin();
      for (let i = 0; i < header.size; i++) skip(protocol, header.elemType);
      protocol.readListEnd();
      return;
    }
    default:
      throw new TypeError(`thrift: cannot skip type ${type}`);
  }
}
/**
 * Read one value of the given `TType` from the protocol into a `ThriftValue`.
 *
 * Scalars are decoded to their JS form (I64 as `bigint`); STRUCT recurses via
 * `readStruct` into a field map; and LIST, SET, and MAP read their headers and
 * recurse element-by-element, carrying the element type codes into the returned
 * container variant so it can be re-encoded later.
 *
 * STRING is always decoded as UTF-8 text. When a field is really opaque binary,
 * drive `protocol.readBinary()` yourself instead of round-tripping through this
 * helper, since decoding to a string is lossy for non-text bytes.
 *
 * Throws `TypeError` for a `type` with no readable value (such as `TType.STOP`);
 * propagates a `ThriftError` on truncated or malformed input.
 *
 * ```ts no_run
 * import { CompactProtocol, TType } from 'internal:format/thrift';
 * import { readValue } from 'internal:format/thrift/value';
 *
 * const p = new CompactProtocol(bytes);
 * const v = readValue(p, TType.LIST);
 * if (v.type === TType.LIST) {
 *   for (const item of v.values) {
 *     if (item.type === TType.I32) console.log(item.value);
 *   }
 * }
 * ```
 *
 * @internal
 */
export function readValue(protocol: Protocol, type: number): ThriftValue {
  switch (type) {
    case TType.BOOL:
      return {
        type: TType.BOOL,
        value: protocol.readBool(),
      };
    case TType.BYTE:
      return {
        type: TType.BYTE,
        value: protocol.readByte(),
      };
    case TType.I16:
      return {
        type: TType.I16,
        value: protocol.readI16(),
      };
    case TType.I32:
      return {
        type: TType.I32,
        value: protocol.readI32(),
      };
    case TType.I64:
      return {
        type: TType.I64,
        value: protocol.readI64(),
      };
    case TType.DOUBLE:
      return {
        type: TType.DOUBLE,
        value: protocol.readDouble(),
      };
    case TType.STRING:
      return {
        type: TType.STRING,
        value: protocol.readString(),
      };
    case TType.STRUCT:
      return {
        type: TType.STRUCT,
        fields: readStruct(protocol),
      };
    case TType.LIST: {
      const header = protocol.readListBegin();
      const values: ThriftValue[] = [];
      for (let i = 0; i < header.size; i++) values.push(readValue(protocol, header.elemType));
      protocol.readListEnd();
      return {
        type: TType.LIST,
        elemType: header.elemType,
        values,
      };
    }
    case TType.SET: {
      const header = protocol.readSetBegin();
      const values: ThriftValue[] = [];
      for (let i = 0; i < header.size; i++) values.push(readValue(protocol, header.elemType));
      protocol.readSetEnd();
      return {
        type: TType.SET,
        elemType: header.elemType,
        values,
      };
    }
    case TType.MAP: {
      const header = protocol.readMapBegin();
      const entries: [ThriftValue, ThriftValue][] = [];
      for (let i = 0; i < header.size; i++) {
        entries.push([readValue(protocol, header.keyType), readValue(protocol, header.valueType)]);
      }
      protocol.readMapEnd();
      return {
        type: TType.MAP,
        keyType: header.keyType,
        valueType: header.valueType,
        entries,
      };
    }
    default:
      throw new TypeError(`thrift: cannot read value of type ${type}`);
  }
}
/**
 * Write a `ThriftValue` to the protocol — the exact inverse of `readValue`.
 *
 * The value's `type` tag selects the encoding: scalars go out through the
 * matching scalar writer, STRUCT delegates to `writeStruct`, and each container
 * emits its header (from the tag's element types and its element count) followed
 * by its elements. A value produced by `readValue` on one protocol can be passed
 * to `writeValue` on another to transcode it between wire formats.
 *
 * ```ts no_run
 * import { BinaryProtocol, TType } from 'internal:format/thrift';
 * import { writeValue, type ThriftValue } from 'internal:format/thrift/value';
 *
 * const tags: ThriftValue = {
 *   type: TType.LIST,
 *   elemType: TType.STRING,
 *   values: [
 *     { type: TType.STRING, value: 'alpha' },
 *     { type: TType.STRING, value: 'beta' },
 *   ],
 * };
 *
 * const p = new BinaryProtocol();
 * writeValue(p, tags);
 * const bytes = p.bytes();
 * ```
 *
 * @internal
 */
export function writeValue(protocol: Protocol, value: ThriftValue): void {
  switch (value.type) {
    case TType.BOOL:
      protocol.writeBool(value.value);
      return;
    case TType.BYTE:
      protocol.writeByte(value.value);
      return;
    case TType.I16:
      protocol.writeI16(value.value);
      return;
    case TType.I32:
      protocol.writeI32(value.value);
      return;
    case TType.I64:
      protocol.writeI64(value.value);
      return;
    case TType.DOUBLE:
      protocol.writeDouble(value.value);
      return;
    case TType.STRING:
      protocol.writeString(value.value);
      return;
    case TType.STRUCT:
      writeStruct(protocol, value.fields);
      return;
    case TType.LIST:
      protocol.writeListBegin(value.elemType, value.values.length);
      for (const item of value.values) writeValue(protocol, item);
      protocol.writeListEnd();
      return;
    case TType.SET:
      protocol.writeSetBegin(value.elemType, value.values.length);
      for (const item of value.values) writeValue(protocol, item);
      protocol.writeSetEnd();
      return;
    case TType.MAP:
      protocol.writeMapBegin(value.keyType, value.valueType, value.entries.length);
      for (const [k, v] of value.entries) {
        writeValue(protocol, k);
        writeValue(protocol, v);
      }
      protocol.writeMapEnd();
      return;
  }
}
/**
 * Read a whole struct into a `Map` from field id to `ThriftValue`.
 *
 * Reads the struct header, then loops reading field headers and their values
 * until the STOP field terminates the struct. Each field is materialized with
 * `readValue`, so nested structs and containers come back fully populated. Field
 * names are not present on the wire, so the map is keyed purely by numeric id.
 *
 * Propagates a `ThriftError` on truncated or malformed input, and a `TypeError`
 * if a field declares a type with no readable value.
 *
 * ```ts no_run
 * import { CompactProtocol, TType } from 'internal:format/thrift';
 * import { readStruct } from 'internal:format/thrift/value';
 *
 * const fields = readStruct(new CompactProtocol(bytes));
 * const name = fields.get(1);
 * if (name?.type === TType.STRING) console.log(name.value);
 * ```
 *
 * @internal
 */
export function readStruct(protocol: Protocol): Map<number, ThriftValue> {
  const fields = new Map<number, ThriftValue>();
  protocol.readStructBegin();
  for (;;) {
    const field = protocol.readFieldBegin();
    if (field.type === TType.STOP) break;
    fields.set(field.id, readValue(protocol, field.type));
    protocol.readFieldEnd();
  }
  protocol.readStructEnd();
  return fields;
}
/**
 * Write a `Map` of field id to `ThriftValue` as a struct — the inverse of
 * `readStruct`.
 *
 * Emits the struct header, then one field per map entry (using the entry's value
 * `type` as the field type and the key as the field id, with an empty field name
 * since names are never on the wire), then the STOP marker and struct end. Map
 * iteration order determines field order on the wire; Thrift readers key on id,
 * so order is not significant to correctness.
 *
 * ```ts no_run
 * import { BinaryProtocol, TType } from 'internal:format/thrift';
 * import { writeStruct, type ThriftValue } from 'internal:format/thrift/value';
 *
 * const fields = new Map<number, ThriftValue>([
 *   [1, { type: TType.STRING, value: 'ada' }],
 *   [2, { type: TType.I32, value: 1815 }],
 * ]);
 *
 * const p = new BinaryProtocol();
 * writeStruct(p, fields);
 * const bytes = p.bytes();
 * ```
 *
 * @internal
 */
export function writeStruct(protocol: Protocol, fields: Map<number, ThriftValue>): void {
  protocol.writeStructBegin();
  for (const [id, value] of fields) {
    protocol.writeFieldBegin('', value.type, id);
    writeValue(protocol, value);
    protocol.writeFieldEnd();
  }
  protocol.writeFieldStop();
  protocol.writeStructEnd();
}
