/**
 * fino:format/protobuf - TypeScript-defined Protocol Buffers messages.
 *
 * This module implements the Protocol Buffers binary wire format directly.
 * A message schema is an ordinary TypeScript object whose keys are checked
 * against the application's TypeScript type and whose field descriptors carry
 * the stable numeric indexes written on the wire. Encoded messages therefore
 * contain field numbers and values, never JavaScript property-name strings.
 *
 * The schema object is the intermediate representation: a future TypeScript
 * AST extractor or `.proto` parser can generate the same `MessageSchema<T>`
 * without changing the encoder, decoder, or callers.
 *
 * Supported wire behavior:
 *
 * - VARINT: bool, enum, signed/unsigned integers, and ZigZag integers.
 * - I32/I64: fixed integers and IEEE-754 float/double values.
 * - LEN: UTF-8 strings, bytes, nested messages, and packed repeated scalars.
 * - Unknown fields are skipped, singular scalar fields use last-one-wins, and
 *   repeated numeric fields accept both packed and expanded representations.
 * - Groups and maps have no dedicated schema sugar. Unknown groups are
 *   skipped, and maps can be represented by their standard repeated entry
 *   message.
 *
 * ```ts no_run
 * import { defineMessage } from 'fino:format/protobuf';
 *
 * interface Metric {
 *   name: string;
 *   values: number[];
 * }
 *
 * const Metric = defineMessage<Metric>({
 *   name: { number: 1, type: 'string' },
 *   values: { number: 2, type: 'double', repeated: true },
 * });
 *
 * const bytes = Metric.encode({ name: 'latency', values: [1.5, 2.25] });
 * Metric.decode(bytes);
 * ```
 *
 * Conformance map:
 *
 * - tags and wire types: `_wireType`, `Writer.tag`, and `Reader.tag`
 * - base-128 varints and ZigZag: `Writer.varint`, `Reader.varint`,
 *   `_encodeScalar`, and `_decodeScalar`
 * - length-delimited strings, bytes, and submessages: `_encodeValue` and
 *   `_decodeValue`
 * - packed/expanded repeated fields and last-one-wins: `_decodeMessage`
 * - unknown-field skipping, including deprecated groups: `Reader.skip`
 *
 * Authoritative references:
 *
 * - Protocol Buffers encoding:
 *   https://protobuf.dev/programming-guides/encoding/
 * - Protocol Buffers language specification:
 *   https://protobuf.dev/reference/protobuf/proto3-spec/
 */

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder('utf-8', { fatal: true });
const _codecMarker = Symbol('fino.protobuf.codec');
const _maxFieldNumber = 0x1fffffff;

type NumberType =
  | 'int32'
  | 'uint32'
  | 'sint32'
  | 'fixed32'
  | 'sfixed32'
  | 'float'
  | 'double'
  | 'enum';
type BigIntType = 'int64' | 'uint64' | 'sint64' | 'fixed64' | 'sfixed64';

/**
 * Scalar field names understood by the Protocol Buffers wire codec.
 *
 * The 64-bit integer forms use `bigint`; all other numeric forms use
 * `number`. Enum values are their numeric wire values.
 */
export type ScalarType = NumberType | BigIntType | 'bool' | 'string' | 'bytes';

type SchemaType<T> = T extends boolean
  ? 'bool'
  : T extends string
    ? 'string'
    : T extends Uint8Array
      ? 'bytes'
      : T extends bigint
        ? BigIntType
        : T extends number
          ? NumberType
          : T extends object
            ? MessageCodec<T>
            : never;

type Present<T> = Exclude<T, undefined>;

/**
 * One named TypeScript property and its stable Protocol Buffers field number.
 *
 * Repeated properties must set `repeated: true`. Packable repeated scalar
 * fields are packed by default; set `packed: false` to emit expanded records.
 * Set `optional: true` to preserve absence instead of materializing the scalar
 * type's protobuf default during decoding.
 */
export type FieldSchema<T> =
  Present<T> extends readonly (infer Item)[]
    ? {
        number: number;
        type: SchemaType<Item>;
        repeated: true;
        packed?: boolean;
        optional?: false;
      }
    : {
        number: number;
        type: SchemaType<Present<T>>;
        repeated?: false;
        packed?: never;
        optional?: boolean;
      };

/**
 * Runtime schema for a TypeScript message type.
 *
 * Every property in `T` has one descriptor, so renaming or adding a property
 * requires updating the shared schema at compile time. Field numbers are the
 * stable compatibility boundary and must not be reused after publication.
 */
export type MessageSchema<T extends object> = {
  [Key in keyof T]-?: FieldSchema<T[Key]>;
};

/**
 * Compiled encoder and decoder for one TypeScript message type.
 */
export interface MessageCodec<T extends object> {
  /**
   * The checked TypeScript schema used to build this codec.
   */
  readonly schema: Readonly<MessageSchema<T>>;

  /**
   * Encode a value as a protobuf binary message.
   */
  encode(value: T): Uint8Array;

  /**
   * Decode a protobuf binary message.
   *
   * Unknown fields are ignored. Missing required-looking scalar properties
   * receive protobuf defaults because wire format presence alone cannot enforce
   * application-level requiredness.
   */
  decode(bytes: Uint8Array | ArrayBuffer): T;
}

/**
 * Error thrown for an invalid schema, unsupported value, or malformed wire
 * message.
 */
export class ProtobufError extends Error {
  /** Error name reported by `ProtobufError` instances. */
  override name = 'ProtobufError';

  /**
   * Byte offset associated with malformed input, when available.
   */
  readonly offset?: number;

  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} at byte ${offset}`);
    this.offset = offset;
  }
}

type AnyCodec = MessageCodec<Record<string, unknown>> & {
  readonly [_codecMarker]: true;
};

interface RuntimeField {
  name: string;
  number: number;
  type: ScalarType | AnyCodec;
  repeated: boolean;
  packed: boolean;
  optional: boolean;
}

class Writer {
  #buffer = new Uint8Array(64);
  #length = 0;

  #reserve(additional: number): void {
    const required = this.#length + additional;
    if (required <= this.#buffer.byteLength) return;
    let capacity = this.#buffer.byteLength;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.#buffer);
    this.#buffer = next;
  }

  byte(value: number): void {
    this.#reserve(1);
    this.#buffer[this.#length++] = value;
  }

  bytes(value: Uint8Array): void {
    this.#reserve(value.byteLength);
    this.#buffer.set(value, this.#length);
    this.#length += value.byteLength;
  }

  varint(value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new ProtobufError(`varint is outside the unsigned 64-bit range: ${value}`);
    }
    while (value >= 0x80n) {
      this.byte(Number(value & 0x7fn) | 0x80);
      value >>= 7n;
    }
    this.byte(Number(value));
  }

  tag(fieldNumber: number, wireType: number): void {
    this.varint(BigInt(fieldNumber * 8 + wireType));
  }

  lengthDelimited(value: Uint8Array): void {
    this.varint(BigInt(value.byteLength));
    this.bytes(value);
  }

  fixed32(value: number, signed: boolean): void {
    const bytes = new Uint8Array(4);
    const view = new DataView(bytes.buffer);
    if (signed) view.setInt32(0, value, true);
    else view.setUint32(0, value, true);
    this.bytes(bytes);
  }

  float(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.bytes(bytes);
  }

  fixed64(value: bigint, signed: boolean): void {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    if (signed) view.setBigInt64(0, value, true);
    else view.setBigUint64(0, value, true);
    this.bytes(bytes);
  }

  double(value: number): void {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    this.bytes(bytes);
  }

  finish(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

class Reader {
  readonly bytes: Uint8Array;
  offset = 0;
  readonly end: number;

  constructor(bytes: Uint8Array, start = 0, end = bytes.byteLength) {
    this.bytes = bytes;
    this.offset = start;
    this.end = end;
  }

  get done(): boolean {
    return this.offset >= this.end;
  }

  #require(size: number): void {
    if (size < 0 || this.offset + size > this.end) {
      throw new ProtobufError('truncated protobuf message', this.offset);
    }
  }

  varint(): bigint {
    const start = this.offset;
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      this.#require(1);
      const byte = this.bytes[this.offset++]!;
      if (shift === 63n && byte > 1) {
        throw new ProtobufError('varint exceeds 64 bits', start);
      }
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new ProtobufError('varint exceeds 10 bytes', start);
  }

  tag(): { number: number; wireType: number } {
    const offset = this.offset;
    const tag = this.varint();
    const wireType = Number(tag & 7n);
    const number = Number(tag >> 3n);
    if (number < 1 || number > _maxFieldNumber) {
      throw new ProtobufError(`invalid field number ${number}`, offset);
    }
    if (wireType > 5) {
      throw new ProtobufError(`invalid wire type ${wireType}`, offset);
    }
    return { number, wireType };
  }

  length(): number {
    const offset = this.offset;
    const value = this.varint();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtobufError('length exceeds JavaScript safe integer range', offset);
    }
    const length = Number(value);
    this.#require(length);
    return length;
  }

  slice(length: number): Uint8Array {
    this.#require(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  fixed32(signed: boolean): number {
    this.#require(4);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    this.offset += 4;
    return signed ? view.getInt32(0, true) : view.getUint32(0, true);
  }

  float(): number {
    this.#require(4);
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    ).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  fixed64(signed: boolean): bigint {
    this.#require(8);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    this.offset += 8;
    return signed ? view.getBigInt64(0, true) : view.getBigUint64(0, true);
  }

  double(): number {
    this.#require(8);
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8,
    ).getFloat64(0, true);
    this.offset += 8;
    return value;
  }

  skip(wireType: number, fieldNumber: number): void {
    if (wireType === 0) {
      this.varint();
      return;
    }
    if (wireType === 1) {
      this.slice(8);
      return;
    }
    if (wireType === 2) {
      this.slice(this.length());
      return;
    }
    if (wireType === 3) {
      while (!this.done) {
        const tag = this.tag();
        if (tag.wireType === 4) {
          if (tag.number !== fieldNumber) {
            throw new ProtobufError('mismatched end-group field number', this.offset);
          }
          return;
        }
        this.skip(tag.wireType, tag.number);
      }
      throw new ProtobufError('unterminated group', this.offset);
    }
    if (wireType === 4) {
      throw new ProtobufError('unexpected end-group tag', this.offset);
    }
    if (wireType === 5) {
      this.slice(4);
      return;
    }
    throw new ProtobufError(`invalid wire type ${wireType}`, this.offset);
  }
}

function _isCodec(value: ScalarType | AnyCodec): value is AnyCodec {
  return typeof value === 'object' && value !== null && value[_codecMarker] === true;
}

function _wireType(type: ScalarType | AnyCodec): number {
  if (_isCodec(type) || type === 'string' || type === 'bytes') return 2;
  if (type === 'fixed64' || type === 'sfixed64' || type === 'double') return 1;
  if (type === 'fixed32' || type === 'sfixed32' || type === 'float') return 5;
  return 0;
}

function _isPackable(type: ScalarType | AnyCodec): boolean {
  return !_isCodec(type) && type !== 'string' && type !== 'bytes';
}

function _number(value: unknown, type: ScalarType): number {
  if (typeof value !== 'number') {
    throw new ProtobufError(`${type} field requires a number`);
  }
  return value;
}

function _integer(value: unknown, type: ScalarType, min: number, max: number): number {
  const number = _number(value, type);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ProtobufError(`${type} field is outside its integer range: ${number}`);
  }
  return number;
}

function _bigint(value: unknown, type: ScalarType, signed: boolean): bigint {
  if (typeof value !== 'bigint') throw new ProtobufError(`${type} field requires a bigint`);
  const min = signed ? -(1n << 63n) : 0n;
  const max = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (value < min || value > max) {
    throw new ProtobufError(`${type} field is outside its 64-bit range: ${value}`);
  }
  return value;
}

function _encodeScalar(writer: Writer, type: ScalarType, value: unknown): void {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new ProtobufError('bool field requires a boolean');
    writer.varint(value ? 1n : 0n);
  } else if (type === 'int32' || type === 'enum') {
    const number = _integer(value, type, -0x80000000, 0x7fffffff);
    writer.varint(BigInt.asUintN(64, BigInt(number)));
  } else if (type === 'uint32') {
    writer.varint(BigInt(_integer(value, type, 0, 0xffffffff)));
  } else if (type === 'sint32') {
    const number = BigInt(_integer(value, type, -0x80000000, 0x7fffffff));
    writer.varint(BigInt.asUintN(32, (number << 1n) ^ (number >> 31n)));
  } else if (type === 'int64') {
    writer.varint(BigInt.asUintN(64, _bigint(value, type, true)));
  } else if (type === 'uint64') {
    writer.varint(_bigint(value, type, false));
  } else if (type === 'sint64') {
    const number = _bigint(value, type, true);
    writer.varint(BigInt.asUintN(64, (number << 1n) ^ (number >> 63n)));
  } else if (type === 'fixed32') {
    writer.fixed32(_integer(value, type, 0, 0xffffffff), false);
  } else if (type === 'sfixed32') {
    writer.fixed32(_integer(value, type, -0x80000000, 0x7fffffff), true);
  } else if (type === 'float') {
    writer.float(_number(value, type));
  } else if (type === 'fixed64') {
    writer.fixed64(_bigint(value, type, false), false);
  } else if (type === 'sfixed64') {
    writer.fixed64(_bigint(value, type, true), true);
  } else if (type === 'double') {
    writer.double(_number(value, type));
  } else {
    throw new ProtobufError(`${type} is not a scalar wire value`);
  }
}

function _encodeValue(writer: Writer, type: ScalarType | AnyCodec, value: unknown): void {
  if (_isCodec(type)) {
    if (typeof value !== 'object' || value === null) {
      throw new ProtobufError('message field requires an object');
    }
    writer.lengthDelimited(type.encode(value as Record<string, unknown>));
  } else if (type === 'string') {
    if (typeof value !== 'string') throw new ProtobufError('string field requires a string');
    writer.lengthDelimited(_textEncoder.encode(value));
  } else if (type === 'bytes') {
    if (!(value instanceof Uint8Array)) {
      throw new ProtobufError('bytes field requires a Uint8Array');
    }
    writer.lengthDelimited(value);
  } else {
    _encodeScalar(writer, type, value);
  }
}

function _defaultValue(type: ScalarType | AnyCodec): unknown {
  if (_isCodec(type)) return undefined;
  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'bytes') return new Uint8Array();
  if (
    type === 'int64' ||
    type === 'uint64' ||
    type === 'sint64' ||
    type === 'fixed64' ||
    type === 'sfixed64'
  ) {
    return 0n;
  }
  return 0;
}

function _isDefault(type: ScalarType | AnyCodec, value: unknown): boolean {
  if (_isCodec(type)) return value === undefined;
  if (type === 'bool') return value === false;
  if (type === 'string') return value === '';
  if (type === 'bytes') return value instanceof Uint8Array && value.byteLength === 0;
  if (typeof value === 'bigint') return value === 0n;
  return value === 0;
}

function _decodeScalar(reader: Reader, type: ScalarType): unknown {
  if (type === 'bool') return reader.varint() !== 0n;
  if (type === 'int32' || type === 'enum') return Number(BigInt.asIntN(32, reader.varint()));
  if (type === 'uint32') return Number(BigInt.asUintN(32, reader.varint()));
  if (type === 'sint32') {
    const value = BigInt.asUintN(32, reader.varint());
    return Number(BigInt.asIntN(32, (value >> 1n) ^ -(value & 1n)));
  }
  if (type === 'int64') return BigInt.asIntN(64, reader.varint());
  if (type === 'uint64') return BigInt.asUintN(64, reader.varint());
  if (type === 'sint64') {
    const value = BigInt.asUintN(64, reader.varint());
    return BigInt.asIntN(64, (value >> 1n) ^ -(value & 1n));
  }
  if (type === 'fixed32') return reader.fixed32(false);
  if (type === 'sfixed32') return reader.fixed32(true);
  if (type === 'float') return reader.float();
  if (type === 'fixed64') return reader.fixed64(false);
  if (type === 'sfixed64') return reader.fixed64(true);
  if (type === 'double') return reader.double();
  throw new ProtobufError(`${type} is not a scalar wire value`, reader.offset);
}

function _decodeValue(reader: Reader, type: ScalarType | AnyCodec): unknown {
  if (_isCodec(type)) return type.decode(reader.slice(reader.length()));
  if (type === 'string') {
    const offset = reader.offset;
    try {
      return _textDecoder.decode(reader.slice(reader.length()));
    } catch {
      throw new ProtobufError('string field is not valid UTF-8', offset);
    }
  }
  if (type === 'bytes') return reader.slice(reader.length()).slice();
  return _decodeScalar(reader, type);
}

function _compileSchema<T extends object>(
  schema: MessageSchema<T>,
): {
  fields: RuntimeField[];
  byNumber: Map<number, RuntimeField>;
} {
  const fields: RuntimeField[] = [];
  const byNumber = new Map<number, RuntimeField>();
  for (const [name, raw] of Object.entries(schema)) {
    const descriptor = raw as {
      number: number;
      type: ScalarType | AnyCodec;
      repeated?: boolean;
      packed?: boolean;
      optional?: boolean;
    };
    if (
      !Number.isInteger(descriptor.number) ||
      descriptor.number < 1 ||
      descriptor.number > _maxFieldNumber
    ) {
      throw new ProtobufError(`invalid field number ${descriptor.number} for ${name}`);
    }
    if (descriptor.number >= 19_000 && descriptor.number <= 19_999) {
      throw new ProtobufError(`field number ${descriptor.number} is reserved`);
    }
    if (byNumber.has(descriptor.number)) {
      throw new ProtobufError(`duplicate field number ${descriptor.number}`);
    }
    if (typeof descriptor.type !== 'string' && !_isCodec(descriptor.type)) {
      throw new ProtobufError(`invalid field type for ${name}`);
    }
    const repeated = descriptor.repeated === true;
    if (descriptor.packed !== undefined && (!repeated || !_isPackable(descriptor.type))) {
      throw new ProtobufError(`packed is only valid for repeated scalar field ${name}`);
    }
    const field: RuntimeField = {
      name,
      number: descriptor.number,
      type: descriptor.type,
      repeated,
      packed: repeated && _isPackable(descriptor.type) && descriptor.packed !== false,
      optional: descriptor.optional === true,
    };
    fields.push(field);
    byNumber.set(field.number, field);
  }
  fields.sort((a, b) => a.number - b.number);
  return { fields, byNumber };
}

function _encodeMessage(fields: RuntimeField[], value: object): Uint8Array {
  if (typeof value !== 'object' || value === null) {
    throw new ProtobufError('message value must be an object');
  }
  const record = value as Record<string, unknown>;
  const writer = new Writer();
  for (const field of fields) {
    const current = record[field.name];
    if (field.repeated) {
      if (!Array.isArray(current)) {
        throw new ProtobufError(`repeated field ${field.name} requires an array`);
      }
      if (current.length === 0) continue;
      if (field.packed) {
        const packed = new Writer();
        for (const item of current) {
          _encodeScalar(packed, field.type as ScalarType, item);
        }
        writer.tag(field.number, 2);
        writer.lengthDelimited(packed.finish());
      } else {
        const wireType = _wireType(field.type);
        for (const item of current) {
          writer.tag(field.number, wireType);
          _encodeValue(writer, field.type, item);
        }
      }
      continue;
    }
    if (current === undefined) {
      if (field.optional || _isCodec(field.type)) continue;
      throw new ProtobufError(`field ${field.name} is undefined`);
    }
    if (!field.optional && _isDefault(field.type, current)) continue;
    writer.tag(field.number, _wireType(field.type));
    _encodeValue(writer, field.type, current);
  }
  return writer.finish();
}

function _decodeMessage(
  fields: RuntimeField[],
  byNumber: Map<number, RuntimeField>,
  bytes: Uint8Array,
) {
  const value: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.repeated) value[field.name] = [];
    else if (!field.optional && !_isCodec(field.type)) {
      value[field.name] = _defaultValue(field.type);
    }
  }
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = reader.tag();
    const field = byNumber.get(tag.number);
    if (field === undefined) {
      reader.skip(tag.wireType, tag.number);
      continue;
    }
    const wireType = _wireType(field.type);
    if (field.repeated && _isPackable(field.type) && tag.wireType === 2) {
      const length = reader.length();
      const packed = new Reader(reader.slice(length));
      const list = value[field.name] as unknown[];
      while (!packed.done) list.push(_decodeScalar(packed, field.type as ScalarType));
      continue;
    }
    if (tag.wireType !== wireType) {
      reader.skip(tag.wireType, tag.number);
      continue;
    }
    const decoded = _decodeValue(reader, field.type);
    if (field.repeated) {
      (value[field.name] as unknown[]).push(decoded);
    } else if (_isCodec(field.type) && value[field.name] !== undefined) {
      value[field.name] = {
        ...(value[field.name] as Record<string, unknown>),
        ...(decoded as Record<string, unknown>),
      };
    } else {
      value[field.name] = decoded;
    }
  }
  return value;
}

/**
 * Compile a TypeScript-keyed schema into a protobuf encoder and decoder.
 *
 * The schema is validated once and fields are encoded in ascending numeric
 * order for predictable local output. Protocol Buffers does not define
 * canonical serialization, so callers must not use the resulting bytes as a
 * cross-implementation content hash.
 *
 * ```ts no_run
 * interface Ready {
 *   owner: number;
 *   descriptors: number[];
 * }
 *
 * const Ready = defineMessage<Ready>({
 *   owner: { number: 1, type: 'uint32' },
 *   descriptors: { number: 2, type: 'int32', repeated: true },
 * });
 * ```
 */
export function defineMessage<T extends object>(schema: MessageSchema<T>): MessageCodec<T> {
  const compiled = _compileSchema(schema);
  const codec = {
    [_codecMarker]: true as const,
    schema: Object.freeze({ ...schema }),
    encode(value: T): Uint8Array {
      return _encodeMessage(compiled.fields, value);
    },
    decode(bytes: Uint8Array | ArrayBuffer): T {
      const input = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      return _decodeMessage(compiled.fields, compiled.byNumber, input) as T;
    },
  };
  return codec as MessageCodec<T>;
}
