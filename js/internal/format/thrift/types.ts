/**
 * Thrift type system and errors.
 *
 * Backs `internal:format/thrift`; not an application-facing module. Defines the
 * wire type codes (`TType`), message kinds (`TMessageType`), the compact
 * protocol's own compressed type nibbles (`CType`) with maps to and from
 * `TType`, and the `ThriftError` raised for malformed input.
 *
 * Everything here is a leaf: the constants are plain lookup tables, the two
 * mapping functions are pure, and `ThriftError`/`_fail` only shape errors. The
 * protocol implementations (`binary`, `compact`, `json`) import these symbols;
 * application code never touches this module directly. `TType`, `TMessageType`,
 * `CType`, `ttypeToCompact`, `compactToTtype`, and `ThriftError` are re-exported
 * from the umbrella `internal:format/thrift`, so the examples below import from
 * there. `_fail` is not re-exported and is imported from this module by name.
 *
 * ```ts no_run
 * import { TType, ttypeToCompact, compactToTtype } from 'internal:format/thrift';
 *
 * // A field header on the wire carries a TType; the compact protocol squeezes
 * // it into a 4-bit nibble and reads it back to the same logical type.
 * const nibble = ttypeToCompact(TType.I32); // CType.I32
 * compactToTtype(nibble) === TType.I32;      // true
 * ```
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
 * `STOP` (0) terminates a struct's field list. `BYTE` and `I8` are the same
 * code (3) — Thrift treats a byte and a signed 8-bit integer identically on the
 * wire. The gaps in the numbering (5, 7, 9) are unused Thrift type ids left as
 * they are on the wire, so this table matches the reference encoding exactly.
 *
 * ```ts no_run
 * import { TType } from 'internal:format/thrift';
 *
 * if (fieldType === TType.STOP) break;       // end of struct fields
 * const isContainer =
 *   fieldType === TType.LIST ||
 *   fieldType === TType.SET ||
 *   fieldType === TType.MAP;
 * ```
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
  LIST: 15,
} as const;
/**
 * Thrift message kinds for the RPC envelope.
 *
 * Every Thrift RPC frame opens with a message header naming the method, one of
 * these kinds, and a sequence id. `CALL` and `ONEWAY` flow client-to-server;
 * `REPLY` carries a normal result and `EXCEPTION` a serialized `TApplication
 * exception`. `ONEWAY` calls expect no reply at all.
 *
 * ```ts no_run
 * import { TMessageType } from 'internal:format/thrift';
 *
 * w.writeMessageBegin('ping', TMessageType.CALL, seqid);
 * // ... later, on the response ...
 * if (header.type === TMessageType.EXCEPTION) throw decodeAppException();
 * ```
 *
 * @internal
 */
export const TMessageType = {
  CALL: 1,
  REPLY: 2,
  EXCEPTION: 3,
  ONEWAY: 4,
} as const;
/**
 * Compact-protocol type nibbles (distinct from `TType`). Bool is split into
 * TRUE/FALSE so a field's boolean value can be folded into its header nibble.
 *
 * These codes fit in four bits so the compact protocol can pack an element type
 * (or two, for a map's key and value) into a single byte. They do not match the
 * `TType` numbering; `ttypeToCompact` and `compactToTtype` translate between the
 * two vocabularies. A compact bool field carries no separate value byte — the
 * header nibble is `BOOLEAN_TRUE` or `BOOLEAN_FALSE` and that is the value.
 *
 * ```ts no_run
 * import { CType } from 'internal:format/thrift';
 *
 * // Decode a map header byte: high nibble is the key type, low nibble the value.
 * const keyNibble = mapByte >> 4 & 0xf;
 * const valNibble = mapByte & 0xf;
 * const valuesAreStructs = valNibble === CType.STRUCT;
 * ```
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
  STRUCT: 12,
} as const;
/**
 * Map a `TType` to the compact-protocol nibble used for container elements and
 * non-boolean fields. Booleans in a field header are handled separately (their
 * value is folded into the nibble); in containers a bool element uses
 * `BOOLEAN_TRUE`.
 *
 * Bool maps to `CType.BOOLEAN_TRUE` because that is the nibble the compact
 * protocol writes for a container element or the placeholder for a field whose
 * true/false is set at write time. Throws `TypeError` for `TType.STOP`,
 * `TType.VOID`, or any code with no compact form — those never appear as an
 * element or field type, so reaching this function with them is a bug in the
 * protocol layer rather than malformed input.
 *
 * ```ts no_run
 * import { TType, ttypeToCompact } from 'internal:format/thrift';
 *
 * // Compact list header: element count and element type share a byte.
 * const elemNibble = ttypeToCompact(TType.STRING); // CType.BINARY
 * writer.writeU8(count << 4 | elemNibble);
 * ```
 *
 * @internal
 */
export function ttypeToCompact(type: number): number {
  switch (type) {
    case TType.BOOL:
      return CType.BOOLEAN_TRUE;
    case TType.BYTE:
      return CType.BYTE;
    case TType.I16:
      return CType.I16;
    case TType.I32:
      return CType.I32;
    case TType.I64:
      return CType.I64;
    case TType.DOUBLE:
      return CType.DOUBLE;
    case TType.STRING:
      return CType.BINARY;
    case TType.LIST:
      return CType.LIST;
    case TType.SET:
      return CType.SET;
    case TType.MAP:
      return CType.MAP;
    case TType.STRUCT:
      return CType.STRUCT;
    default:
      throw new TypeError(`thrift: type ${type} has no compact encoding`);
  }
}
/**
 * Map a compact-protocol nibble back to a `TType`. Both boolean nibbles map to
 * `TType.BOOL`; callers that need the folded value read it from the nibble.
 *
 * Only the low four bits are consulted, so callers can pass a whole header byte
 * without masking it first. `BINARY` decodes to `TType.STRING` (compact folds
 * string and binary into one nibble). Throws `TypeError` if the low nibble is
 * not a known `CType` — a value the compact reader treats as a corrupt stream.
 *
 * ```ts no_run
 * import { CType, compactToTtype } from 'internal:format/thrift';
 *
 * // Read a list header byte, recover the logical element type.
 * const elemType = compactToTtype(headerByte); // low nibble only
 * const boolFolded = (headerByte & 0xf) === CType.BOOLEAN_TRUE;
 * ```
 *
 * @internal
 */
export function compactToTtype(nibble: number): number {
  switch (nibble & 15) {
    case CType.STOP:
      return TType.STOP;
    case CType.BOOLEAN_TRUE:
      return TType.BOOL;
    case CType.BOOLEAN_FALSE:
      return TType.BOOL;
    case CType.BYTE:
      return TType.BYTE;
    case CType.I16:
      return TType.I16;
    case CType.I32:
      return TType.I32;
    case CType.I64:
      return TType.I64;
    case CType.DOUBLE:
      return TType.DOUBLE;
    case CType.BINARY:
      return TType.STRING;
    case CType.LIST:
      return TType.LIST;
    case CType.SET:
      return TType.SET;
    case CType.MAP:
      return TType.MAP;
    case CType.STRUCT:
      return TType.STRUCT;
    default:
      throw new TypeError(`thrift: unknown compact type nibble ${nibble & 15}`);
  }
}
/**
 * Error thrown when a Thrift byte stream is malformed or truncated. Extends
 * `ParseError` for hex-dump diagnostics; programmer misuse (bad arguments)
 * throws `TypeError`/`Error` instead.
 *
 * Because it carries `ParseError`'s `offset`, `source`, and `format` fields, a
 * caught `ThriftError` can render a byte-accurate hex dump pointing at the exact
 * location the decoder gave up. Most instances are produced through `_fail`
 * rather than constructed directly. The `format` field on these errors is
 * `'thrift'` across the binary, compact, and JSON protocols.
 *
 * ```ts no_run
 * import { ThriftError } from 'internal:format/thrift';
 *
 * try {
 *   protocol.readStructBegin();
 * } catch (err) {
 *   if (err instanceof ThriftError) console.error(err.message, 'at', err.offset);
 *   else throw err;
 * }
 * ```
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
 * Raise a `ThriftError` at `offset` in `source`, tagged with the `thrift`
 * format for hex-dump diagnostics.
 *
 * This is the single choke point every byte-level decode error flows through:
 * it stamps the message with a `Malformed thrift:` prefix and attaches
 * `source`, `offset`, and `detail` so the resulting `ThriftError` can point at
 * the offending byte. Its `never` return lets callers write it as the whole
 * body of a failure branch without a following `throw`.
 *
 * ```ts no_run
 * import { _fail } from 'internal:format/thrift/types';
 *
 * if (position + n > bytes.length) {
 *   _fail(bytes, position, `unexpected end of input (need ${n} bytes)`);
 * }
 * ```
 *
 * @internal
 */
export function _fail(source: Uint8Array, offset: number, detail: string): never {
  throw new ThriftError(`Malformed thrift: ${detail}`, {
    detail,
    format: 'thrift',
    offset,
    source,
  });
}
