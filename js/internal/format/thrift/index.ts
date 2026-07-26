/**
 * internal:format/thrift - a complete, schema-less Apache Thrift serialization
 * codec.
 *
 * Implements the three interchange protocols — Binary (`TBinaryProtocol`),
 * Compact (`TCompactProtocol`, the one Apache Parquet uses), and JSON
 * (`TJSONProtocol`) — over a common `Protocol` interface (the standard
 * `TProtocol` contract), plus the full type system, message envelopes, `skip()`,
 * and a generic `ThriftValue` model. Not exposed as a public `fino:*` builtin;
 * consumed by other builtins (e.g. a Parquet reader) and, potentially, a future
 * public Thrift module.
 *
 * ```ts no_run
 * import { CompactProtocol, TType, readStruct } from 'internal:format/thrift';
 *
 * const w = new CompactProtocol();
 * w.writeStructBegin();
 * w.writeFieldBegin('', TType.I32, 1);
 * w.writeI32(42);
 * w.writeFieldEnd();
 * w.writeFieldStop();
 * w.writeStructEnd();
 *
 * const fields = readStruct(new CompactProtocol(w.bytes()));
 * fields.get(1); // { type: TType.I32, value: 42 }
 * ```
 *
 * Reference: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
 *
 * @internal
 */
export {
  TType,
  TMessageType,
  CType,
  ttypeToCompact,
  compactToTtype,
  ThriftError,
} from './types.ts';
export { ByteReader, ByteWriter } from './io.ts';
export {
  ProtocolBase,
  type Protocol,
  type MessageHeader,
  type FieldHeader,
  type MapHeader,
  type ListHeader,
} from './protocol.ts';
export { BinaryProtocol } from './binary.ts';
export { CompactProtocol } from './compact.ts';
export { JSONProtocol } from './json.ts';
export { skip, readValue, writeValue, readStruct, writeStruct, type ThriftValue } from './value.ts';
