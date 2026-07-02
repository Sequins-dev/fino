/**
* Thrift type system and errors.
*
* Backs `internal:format/thrift`; not an application-facing module. Defines the
* wire type codes (`TType`), message kinds (`TMessageType`), the compact
* protocol's own compressed type nibbles (`CType`) with maps to and from
* `TType`, and the `ThriftError` raised for malformed input.
*
* @internal
*/
import { ParseError } from 'fino:parsing/scanner';
/**
* Thrift base and container type codes, as used on the wire by the binary
* protocol and as the logical type in the `Protocol` interface. The compact
* protocol re-encodes these as `CType` nibbles (below) but the interface always
* speaks `TType`.
*
* @internal
*/
export const TType = {
  STOP: 0,
  VOID: 1,
  BOOL: 2,
  BYTE: 3,
  I8: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15
} as const;
/**
* Thrift message kinds for the RPC envelope.
*
* @internal
*/
export const TMessageType = {
  CALL: 1,
  REPLY: 2,
  EXCEPTION: 3,
  ONEWAY: 4
} as const;
/**
* Compact-protocol type nibbles (distinct from `TType`). Bool is split into
* TRUE/FALSE so a field's boolean value can be folded into its header nibble.
*
* @internal
*/
export const CType = {
  STOP: 0,
  BOOLEAN_TRUE: 1,
  BOOLEAN_FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12
} as const;
/**
* Map a `TType` to the compact-protocol nibble used for container elements and
* non-boolean fields. Booleans in a field header are handled separately (their
* value is folded into the nibble); in containers a bool element uses
* `BOOLEAN_TRUE`.
*
* @internal
*/
export function ttypeToCompact(type: number): number {
  switch (type) {
    case TType.BOOL: return CType.BOOLEAN_TRUE;
    case TType.BYTE: return CType.BYTE;
    case TType.I16: return CType.I16;
    case TType.I32: return CType.I32;
    case TType.I64: return CType.I64;
    case TType.DOUBLE: return CType.DOUBLE;
    case TType.STRING: return CType.BINARY;
    case TType.LIST: return CType.LIST;
    case TType.SET: return CType.SET;
    case TType.MAP: return CType.MAP;
    case TType.STRUCT: return CType.STRUCT;
    default: throw new TypeError(`thrift: type ${type} has no compact encoding`);
  }
}
/**
* Map a compact-protocol nibble back to a `TType`. Both boolean nibbles map to
* `TType.BOOL`; callers that need the folded value read it from the nibble.
*
* @internal
*/
export function compactToTtype(nibble: number): number {
  switch (nibble & 15) {
    case CType.STOP: return TType.STOP;
    case CType.BOOLEAN_TRUE: return TType.BOOL;
    case CType.BOOLEAN_FALSE: return TType.BOOL;
    case CType.BYTE: return TType.BYTE;
    case CType.I16: return TType.I16;
    case CType.I32: return TType.I32;
    case CType.I64: return TType.I64;
    case CType.DOUBLE: return TType.DOUBLE;
    case CType.BINARY: return TType.STRING;
    case CType.LIST: return TType.LIST;
    case CType.SET: return TType.SET;
    case CType.MAP: return TType.MAP;
    case CType.STRUCT: return TType.STRUCT;
    default: throw new TypeError(`thrift: unknown compact type nibble ${nibble & 15}`);
  }
}
/**
* Error thrown when a Thrift byte stream is malformed or truncated. Extends
* `ParseError` for hex-dump diagnostics; programmer misuse (bad arguments)
* throws `TypeError`/`Error` instead.
*
* @internal
*/
export class ThriftError extends ParseError {
  /**
  * Error name reported by `ThriftError` instances.
  *
  * @internal
  */
  override name = 'ThriftError';
}
/**
* Raise a `ThriftError` at `offset` in `source`.
*
* @internal
*/
export function _fail(source: Uint8Array, offset: number, detail: string): never {
  throw new ThriftError(`Malformed thrift: ${detail}`, {
    detail,
    format: 'thrift',
    offset,
    source
  });
}
