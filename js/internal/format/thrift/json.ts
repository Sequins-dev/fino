/**
* Thrift JSON protocol (`TJSONProtocol`).
*
* The interoperable text protocol: the only Thrift codec that produces
* human-readable, valid JSON. It trades the density and speed of the binary and
* compact protocols for a wire form you can inspect, diff, and paste into a JSON
* tool. Reach for it when a peer speaks `TJSONProtocol`, or when you want the
* encoded bytes to be legible; prefer the compact protocol (used by Parquet
* metadata) when size matters.
*
* The grammar is fixed and terse. A message is a
* `[version, name, type, seqid, …]` array. A struct is an object keyed by the
* field id (as a decimal string) whose value is a single-entry object
* `{ "<typecode>": value }` tagging the field's type — `"i32"`, `"str"`,
* `"lst"`, and so on. A map is `["<kcode>", "<vcode>", size, { … }]` and a
* list or set is `["<elemcode>", size, …]`. Booleans are the integers `1`/`0`,
* i64 is written as a bare number and read back as a lossless `bigint`, binary
* is unpadded base64, and the non-finite doubles are the quoted strings
* `"NaN"`, `"Infinity"`, and `"-Infinity"`. Because JSON requires object keys to
* be strings, every number that lands in a key position (struct field ids, map
* keys) is quoted.
*
* Unlike the binary and compact codecs, this protocol does not build on the
* shared `ByteWriter`/`ByteReader`: it accumulates output as string fragments
* and reads by advancing a character cursor over the decoded input, tracking
* nested array/object separators (`,` and `:`) with a small context stack. A
* single instance is either a writer or a reader, fixed at construction:
* `new JSONProtocol()` builds a writer whose bytes you collect with `bytes()`,
* while `new JSONProtocol(input)` builds a reader over `input`.
*
* ```ts no_run
* import { JSONProtocol, TType } from 'internal:format/thrift';
*
* // Encode a one-field struct { 1: i32 = 42 }.
* const w = new JSONProtocol();
* w.writeStructBegin();
* w.writeFieldBegin('', TType.I32, 1);
* w.writeI32(42);
* w.writeFieldEnd();
* w.writeFieldStop();
* w.writeStructEnd();
* const text = new TextDecoder().decode(w.bytes()); // {"1":{"i32":42}}
*
* // Decode it back.
* const r = new JSONProtocol(w.bytes());
* r.readStructBegin();
* const field = r.readFieldBegin(); // { type: TType.I32, id: 1, name: '' }
* const value = r.readI32();        // 42
* r.readFieldEnd();
* r.readStructEnd();
* ```
*
* Reference: https://github.com/apache/thrift/blob/master/lib/rb/lib/thrift/protocol/json_protocol.rb
*
* @internal
*/
import { type Protocol, type MessageHeader, type FieldHeader, type MapHeader, type ListHeader } from './protocol.ts';
import { TType, ThriftError } from './types.ts';
const VERSION = 1;
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();
const TYPE_NAME: Record<number, string> = {
  [TType.BOOL]: 'tf',
  [TType.BYTE]: 'i8',
  [TType.I16]: 'i16',
  [TType.I32]: 'i32',
  [TType.I64]: 'i64',
  [TType.DOUBLE]: 'dbl',
  [TType.STRING]: 'str',
  [TType.STRUCT]: 'rec',
  [TType.MAP]: 'map',
  [TType.SET]: 'set',
  [TType.LIST]: 'lst'
};
const NAME_TYPE: Record<string, number> = {
  tf: TType.BOOL,
  i8: TType.BYTE,
  i16: TType.I16,
  i32: TType.I32,
  i64: TType.I64,
  dbl: TType.DOUBLE,
  str: TType.STRING,
  rec: TType.STRUCT,
  map: TType.MAP,
  set: TType.SET,
  lst: TType.LIST
};
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const inv = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) inv[B64.charCodeAt(i)] = i;
  return inv;
})();
function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.byteLength; i += 3) {
    const n = bytes[i]! << 16 | bytes[i + 1]! << 8 | bytes[i + 2]!;
    out += B64[n >> 18 & 63]! + B64[n >> 12 & 63]! + B64[n >> 6 & 63]! + B64[n & 63]!;
  }
  const rem = bytes.byteLength - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[n >> 18 & 63]! + B64[n >> 12 & 63]!;
  } else if (rem === 2) {
    const n = bytes[i]! << 16 | bytes[i + 1]! << 8;
    out += B64[n >> 18 & 63]! + B64[n >> 12 & 63]! + B64[n >> 6 & 63]!;
  }
  return out;
}
function base64Decode(str: string): Uint8Array {
  const clean = str.replace(/=+$/, '');
  const out: number[] = [];
  let i = 0;
  for (; i + 4 <= clean.length; i += 4) {
    const n = B64_INV[clean.charCodeAt(i)]! << 18 | B64_INV[clean.charCodeAt(i + 1)]! << 12 | B64_INV[clean.charCodeAt(i + 2)]! << 6 | B64_INV[clean.charCodeAt(i + 3)]!;
    out.push(n >> 16 & 255, n >> 8 & 255, n & 255);
  }
  const rem = clean.length - i;
  if (rem === 2) {
    const n = B64_INV[clean.charCodeAt(i)]! << 18 | B64_INV[clean.charCodeAt(i + 1)]! << 12;
    out.push(n >> 16 & 255);
  } else if (rem === 3) {
    const n = B64_INV[clean.charCodeAt(i)]! << 18 | B64_INV[clean.charCodeAt(i + 1)]! << 12 | B64_INV[clean.charCodeAt(i + 2)]! << 6;
    out.push(n >> 16 & 255, n >> 8 & 255);
  }
  return new Uint8Array(out);
}
// --- write/read contexts (comma/colon separators) --------------------------
class WriteContext {
  write(_emit: (s: string) => void): void {}
  escapeNum(): boolean {
    return false;
  }
}
class ListWriteContext extends WriteContext {
  #first = true;
  override write(emit: (s: string) => void): void {
    if (this.#first) this.#first = false;
    else emit(',');
  }
}
class PairWriteContext extends WriteContext {
  #first = true;
  #colon = true;
  override write(emit: (s: string) => void): void {
    if (this.#first) {
      this.#first = false;
      this.#colon = true;
    } else {
      emit(this.#colon ? ':' : ',');
      this.#colon = !this.#colon;
    }
  }
  override escapeNum(): boolean {
    return this.#colon;
  }
}
/**
* Text Thrift JSON protocol codec implementing the shared `Protocol` contract.
*
* Manages its own state rather than the shared `ByteWriter`/`ByteReader`: a
* writer appends string fragments to an internal buffer, and a reader tokenizes
* the decoded input by advancing a character cursor. Both modes maintain a stack
* of separator contexts so nested arrays and objects emit or consume the right
* `,` and `:` punctuation without the caller thinking about it.
*
* Construct with no argument for a writer and drive the `write*` calls in the
* structure order the Thrift schema implies (`writeStructBegin`, then a
* `writeFieldBegin`/value/`writeFieldEnd` per field, then `writeFieldStop`,
* then `writeStructEnd`), finally collecting the encoded UTF-8 bytes with
* `bytes()`. Construct with a `Uint8Array` for a reader and mirror those calls
* with the `read*` counterparts. The two modes are not enforced to be exclusive
* — a fresh instance simply starts with an empty write buffer and an empty read
* cursor — but mixing them on one instance is not meaningful. A reader whose
* input violates the grammar throws a `ThriftError` carrying the byte offset.
*
* ```ts no_run
* import { JSONProtocol, TType, TMessageType } from 'internal:format/thrift';
*
* const w = new JSONProtocol();
* w.writeMessageBegin('ping', TMessageType.CALL, 7);
* w.writeStructBegin();
* w.writeFieldStop();
* w.writeStructEnd();
* w.writeMessageEnd();
* // [1,"ping",1,7,{}]
*
* const r = new JSONProtocol(w.bytes());
* const header = r.readMessageBegin(); // { name: 'ping', type: CALL, seqid: 7 }
* r.readStructBegin();
* r.readFieldBegin();                  // { type: TType.STOP, ... }
* r.readStructEnd();
* r.readMessageEnd();
* ```
*
* @internal
*/
export class JSONProtocol implements Protocol {
  #parts: string[] = [];
  #in = '';
  #ip = 0;
  #source: Uint8Array;
  #wctx: WriteContext[] = [new WriteContext()];
  #rctx: WriteContext[] = [new WriteContext()];
  /**
  * Builds a writer when `input` is omitted, or a reader over `input` when it is
  * supplied. Reader input is decoded from UTF-8 up front so the tokenizer can
  * work on characters; the original bytes are retained so error offsets refer
  * to the caller's buffer.
  */
  constructor(input?: Uint8Array) {
    this.#source = input ?? new Uint8Array(0);
    if (input !== undefined) this.#in = _decoder.decode(input);
  }
  /**
  * Returns the encoded document as UTF-8 bytes (writer mode).
  *
  * Joins the accumulated string fragments and encodes them. Called once the
  * full structure has been written. On a reader (or a writer that has emitted
  * nothing) this returns the encoding of the empty string.
  */
  bytes(): Uint8Array {
    return _encoder.encode(this.#parts.join(''));
  }

  /**
  * Returns the reader's current cursor, as a character offset into the decoded
  * input, reporting how much of the document has been consumed.
  */
  position(): number {
    return this.#ip;
  }
  // --- write helpers -------------------------------------------------------
  #emit = (s: string): void => {
    this.#parts.push(s);
  };
  #wtop(): WriteContext {
    return this.#wctx[this.#wctx.length - 1]!;
  }
  #ctxWrite(): void {
    this.#wtop().write(this.#emit);
  }
  #writeArrayStart(): void {
    this.#ctxWrite();
    this.#emit('[');
    this.#wctx.push(new ListWriteContext());
  }
  #writeArrayEnd(): void {
    this.#wctx.pop();
    this.#emit(']');
  }
  #writeObjectStart(): void {
    this.#ctxWrite();
    this.#emit('{');
    this.#wctx.push(new PairWriteContext());
  }
  #writeObjectEnd(): void {
    this.#wctx.pop();
    this.#emit('}');
  }
  #writeJSONInteger(text: string): void {
    this.#ctxWrite();
    const escape = this.#wtop().escapeNum();
    this.#emit(escape ? `"${text}"` : text);
  }
  #writeJSONString(value: string): void {
    this.#ctxWrite();
    this.#emit(JSON.stringify(value));
  }
  #writeJSONDouble(value: number): void {
    this.#ctxWrite();
    let text: string;
    let quote = this.#wtop().escapeNum();
    if (Number.isNaN(value)) {
      text = 'NaN';
      quote = true;
    } else if (value === Infinity) {
      text = 'Infinity';
      quote = true;
    } else if (value === -Infinity) {
      text = '-Infinity';
      quote = true;
    } else {
      text = String(value);
    }
    this.#emit(quote ? `"${text}"` : text);
  }
  // --- write API -----------------------------------------------------------
  /**
  * Opens the message envelope array `[version, "name", type, seqid, …`.
  *
  * Writes the protocol version (always `1`), the quoted `name`, the
  * `TMessageType` `type` (CALL, REPLY, EXCEPTION, ONEWAY), and the `seqid`
  * request/response correlation number. The message body (typically a single
  * struct) follows, closed by `writeMessageEnd`.
  */
  writeMessageBegin(name: string, type: number, seqid: number): void {
    this.#writeArrayStart();
    this.#writeJSONInteger(String(VERSION));
    this.#writeJSONString(name);
    this.#writeJSONInteger(String(type));
    this.#writeJSONInteger(String(seqid));
  }
  /** Closes the message envelope array opened by `writeMessageBegin`. */
  writeMessageEnd(): void {
    this.#writeArrayEnd();
  }
  /** Opens a struct object `{`. The declared `_name` is not on the wire. */
  writeStructBegin(_name?: string): void {
    this.#writeObjectStart();
  }
  /** Closes the struct object opened by `writeStructBegin`. */
  writeStructEnd(): void {
    this.#writeObjectEnd();
  }
  /**
  * Opens a field: writes the field `id` as a quoted key, then opens the
  * single-entry type-tag object and writes the type name (`"i32"`, `"str"`,
  * etc.) derived from the `TType` `type`. The declared `_name` is not on the
  * wire. The field value is written next, then `writeFieldEnd` closes the tag.
  */
  writeFieldBegin(_name: string, type: number, id: number): void {
    this.#writeJSONInteger(String(id));
    this.#writeObjectStart();
    this.#writeJSONString(TYPE_NAME[type]!);
  }
  /** Closes the type-tag object opened by `writeFieldBegin`. */
  writeFieldEnd(): void {
    this.#writeObjectEnd();
  }
  /**
  * No-op; the JSON protocol has no field-stop marker. The end of a struct's
  * fields is delimited by the closing `}`, so this exists only to satisfy the
  * shared `Protocol` contract.
  */
  writeFieldStop(): void {}
  /**
  * Opens a map `["<kcode>", "<vcode>", size, {`.
  *
  * Writes the key and value type names (from the `keyType`/`valueType` `TType`
  * codes), the entry `size`, and opens the entry object. The caller then writes
  * the `size` key/value pairs before `writeMapEnd`.
  */
  writeMapBegin(keyType: number, valueType: number, size: number): void {
    this.#writeArrayStart();
    this.#writeJSONString(TYPE_NAME[keyType]!);
    this.#writeJSONString(TYPE_NAME[valueType]!);
    this.#writeJSONInteger(String(size));
    this.#writeObjectStart();
  }
  /** Closes the entry object and the map array opened by `writeMapBegin`. */
  writeMapEnd(): void {
    this.#writeObjectEnd();
    this.#writeArrayEnd();
  }
  /**
  * Opens a list `["<elemcode>", size, …`, writing the element type name (from
  * the `elemType` `TType` code) and the element `size`. The caller writes the
  * `size` elements before `writeListEnd`.
  */
  writeListBegin(elemType: number, size: number): void {
    this.#writeArrayStart();
    this.#writeJSONString(TYPE_NAME[elemType]!);
    this.#writeJSONInteger(String(size));
  }
  /** Closes the list array opened by `writeListBegin`. */
  writeListEnd(): void {
    this.#writeArrayEnd();
  }
  /** Opens a set, encoded identically to a list (see `writeListBegin`). */
  writeSetBegin(elemType: number, size: number): void {
    this.writeListBegin(elemType, size);
  }
  /** Closes the set array opened by `writeSetBegin`. */
  writeSetEnd(): void {
    this.#writeArrayEnd();
  }
  /** Writes a boolean as the integer `1` (true) or `0` (false). */
  writeBool(value: boolean): void {
    this.#writeJSONInteger(value ? '1' : '0');
  }
  /** Writes a signed byte as a bare integer. */
  writeByte(value: number): void {
    this.#writeJSONInteger(String(value));
  }
  /** Writes a 16-bit integer as a bare integer. */
  writeI16(value: number): void {
    this.#writeJSONInteger(String(value));
  }
  /** Writes a 32-bit integer as a bare integer. */
  writeI32(value: number): void {
    this.#writeJSONInteger(String(value));
  }
  /**
  * Writes a 64-bit integer as a bare integer, using the `bigint` decimal so no
  * precision is lost above 2^53.
  */
  writeI64(value: bigint): void {
    this.#writeJSONInteger(value.toString());
  }
  /**
  * Writes a double. Finite values are bare JSON numbers; the non-finite values
  * are written as the quoted strings `"NaN"`, `"Infinity"`, and `"-Infinity"`,
  * which plain JSON cannot otherwise represent.
  */
  writeDouble(value: number): void {
    this.#writeJSONDouble(value);
  }
  /** Writes a string as a JSON string literal, with standard escaping. */
  writeString(value: string): void {
    this.#writeJSONString(value);
  }
  /** Writes raw bytes as an unpadded (no trailing `=`) base64 JSON string. */
  writeBinary(value: Uint8Array): void {
    this.#writeJSONString(base64Encode(value));
  }
  // --- read helpers --------------------------------------------------------
  #fail(detail: string): never {
    throw new ThriftError(`Malformed thrift JSON: ${detail}`, {
      detail,
      format: 'thrift',
      offset: Math.min(this.#ip, Math.max(0, this.#source.byteLength - 1)),
      source: this.#source
    });
  }
  #skipWs(): void {
    while (this.#ip < this.#in.length) {
      const c = this.#in[this.#ip]!;
      if (c === ' ' || c === '	' || c === '\n' || c === '\r') this.#ip++;
      else break;
    }
  }
  #peek(): string {
    this.#skipWs();
    if (this.#ip >= this.#in.length) this.#fail('unexpected end of JSON');
    return this.#in[this.#ip]!;
  }
  #expect(ch: string): void {
    if (this.#peek() !== ch) this.#fail(`expected '${ch}' but found '${this.#in[this.#ip]}'`);
    this.#ip++;
  }
  #rtop(): WriteContext {
    return this.#rctx[this.#rctx.length - 1]!;
  }
  #ctxRead(): void {
    // Reader contexts reuse the write-context separator logic to know when to
    // consume a ',' or ':'.
    const top = this.#rtop();
    if (top instanceof ListReadContext || top instanceof PairReadContext) top.consume(this);
  }
  #readArrayStart(): void {
    this.#ctxRead();
    this.#expect('[');
    this.#rctx.push(new ListReadContext());
  }
  #readArrayEnd(): void {
    this.#rctx.pop();
    this.#expect(']');
  }
  #readObjectStart(): void {
    this.#ctxRead();
    this.#expect('{');
    this.#rctx.push(new PairReadContext());
  }
  #readObjectEnd(): void {
    this.#rctx.pop();
    this.#expect('}');
  }
  #readNumericToken(): string {
    this.#ctxRead();
    const escape = this.#rtop().escapeNum();
    this.#skipWs();
    // A token is quoted when it is an object key (escapeNum) or a non-finite
    // double written as "NaN"/"Infinity"/"-Infinity".
    if (escape || this.#in[this.#ip] === '"') {
      this.#expect('"');
      const start = this.#ip;
      while (this.#ip < this.#in.length && this.#in[this.#ip] !== '"') this.#ip++;
      const token = this.#in.slice(start, this.#ip);
      this.#expect('"');
      if (token.length === 0) this.#fail('expected a number');
      return token;
    }
    const start = this.#ip;
    while (this.#ip < this.#in.length && /[-+0-9.eE]/.test(this.#in[this.#ip]!)) this.#ip++;
    const token = this.#in.slice(start, this.#ip);
    if (token.length === 0) this.#fail('expected a number');
    return token;
  }
  #readJSONString(): string {
    this.#ctxRead();
    this.#expect('"');
    let out = '';
    while (this.#ip < this.#in.length) {
      const c = this.#in[this.#ip++]!;
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.#in[this.#ip++]!;
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '	';
            break;
          case 'u': {
            const hex = this.#in.slice(this.#ip, this.#ip + 4);
            this.#ip += 4;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default: this.#fail(`bad escape \\${e}`);
        }
      } else {
        out += c;
      }
    }
    this.#fail('unterminated JSON string');
  }
  // --- read API ------------------------------------------------------------
  /**
  * Reads the message envelope array and returns its header.
  *
  * Consumes the opening `[`, the version, `name`, `type`, and `seqid`. Throws a
  * `ThriftError` if the version is not `1` or if the array does not begin as
  * expected.
  */
  readMessageBegin(): MessageHeader {
    this.#readArrayStart();
    const version = Number(this.#readNumericToken());
    if (version !== VERSION) this.#fail(`unsupported JSON protocol version ${version}`);
    const name = this.#readJSONString();
    const type = Number(this.#readNumericToken());
    const seqid = Number(this.#readNumericToken());
    return {
      name,
      type,
      seqid
    };
  }
  /** Consumes the closing `]` of the message envelope array. */
  readMessageEnd(): void {
    this.#readArrayEnd();
  }
  /**
  * Consumes the opening `{` of a struct object. Returns `null` because the JSON
  * protocol carries no struct name on the wire.
  */
  readStructBegin(): string | null {
    this.#readObjectStart();
    return null;
  }
  /** Consumes the closing `}` of a struct object. */
  readStructEnd(): void {
    this.#readObjectEnd();
  }
  /**
  * Reads the next field header, or a `STOP` sentinel at the end of the struct.
  *
  * If the next character is the struct's closing `}`, returns a header with
  * `type` `TType.STOP` (without consuming the brace, which `readStructEnd`
  * handles). Otherwise consumes the field id key and the type-tag object's type
  * name and returns the field's `id` and `type`. The header `name` is always
  * empty, since names are not on the wire. Throws a `ThriftError` on an
  * unrecognized type name.
  */
  readFieldBegin(): FieldHeader {
    if (this.#peek() === '}') return {
      name: '',
      type: TType.STOP,
      id: 0
    };
    const id = Number(this.#readNumericToken());
    this.#readObjectStart();
    const type = NAME_TYPE[this.#readJSONString()];
    if (type === undefined) this.#fail('unknown field type code');
    return {
      name: '',
      type,
      id
    };
  }
  /** Consumes the closing `}` of the field's type-tag object. */
  readFieldEnd(): void {
    this.#readObjectEnd();
  }
  /**
  * Reads a map header and opens its entry object.
  *
  * Consumes the opening `[`, the key and value type names, the entry `size`,
  * and the entry object's opening `{`. The caller then reads `size` key/value
  * pairs before `readMapEnd`.
  */
  readMapBegin(): MapHeader {
    this.#readArrayStart();
    const keyType = NAME_TYPE[this.#readJSONString()]!;
    const valueType = NAME_TYPE[this.#readJSONString()]!;
    const size = Number(this.#readNumericToken());
    this.#readObjectStart();
    return {
      keyType,
      valueType,
      size
    };
  }
  /** Consumes the closing `}` of the entry object and the map's closing `]`. */
  readMapEnd(): void {
    this.#readObjectEnd();
    this.#readArrayEnd();
  }
  /**
  * Reads a list header: consumes the opening `[`, the element type name, and
  * the element `size`. The caller then reads `size` elements before
  * `readListEnd`.
  */
  readListBegin(): ListHeader {
    this.#readArrayStart();
    const elemType = NAME_TYPE[this.#readJSONString()]!;
    const size = Number(this.#readNumericToken());
    return {
      elemType,
      size
    };
  }
  /** Consumes the closing `]` of the list array. */
  readListEnd(): void {
    this.#readArrayEnd();
  }
  /** Reads a set header, decoded identically to a list (see `readListBegin`). */
  readSetBegin(): ListHeader {
    return this.readListBegin();
  }
  /** Consumes the closing `]` of the set array. */
  readSetEnd(): void {
    this.#readArrayEnd();
  }
  /** Reads a boolean, decoding any nonzero integer token as `true`. */
  readBool(): boolean {
    return Number(this.#readNumericToken()) !== 0;
  }
  /** Reads a signed byte as a number. */
  readByte(): number {
    return Number(this.#readNumericToken());
  }
  /** Reads a 16-bit integer as a number. */
  readI16(): number {
    return Number(this.#readNumericToken());
  }
  /** Reads a 32-bit integer as a number. */
  readI32(): number {
    return Number(this.#readNumericToken());
  }
  /**
  * Reads a 64-bit integer as a `bigint`, so values beyond 2^53 survive the
  * round trip without precision loss.
  */
  readI64(): bigint {
    return BigInt(this.#readNumericToken());
  }
  /**
  * Reads a double. Recognizes the quoted sentinels `"NaN"`, `"Infinity"`, and
  * `"-Infinity"` and maps them to the corresponding JS values; any other token
  * is parsed as a finite number.
  */
  readDouble(): number {
    const token = this.#readNumericToken();
    if (token === 'NaN') return NaN;
    if (token === 'Infinity') return Infinity;
    if (token === '-Infinity') return -Infinity;
    return Number(token);
  }
  /** Reads a JSON string literal, resolving standard escape sequences. */
  readString(): string {
    return this.#readJSONString();
  }
  /** Reads a base64 JSON string (padded or unpadded) and returns the raw bytes. */
  readBinary(): Uint8Array {
    return base64Decode(this.#readJSONString());
  }
  /** @internal — used by the reader contexts to consume a separator char. */
  _consumeSeparator(sep: string): void {
    this.#skipWs();
    if (this.#in[this.#ip] !== sep) this.#fail(`expected separator '${sep}'`);
    this.#ip++;
  }
}
// Reader contexts. They mirror the writer contexts but consume separators from
// the input stream via the protocol's `_consumeSeparator`.
class ListReadContext extends WriteContext {
  #first = true;
  consume(p: JSONProtocol): void {
    if (this.#first) this.#first = false;
    else p._consumeSeparator(',');
  }
}
class PairReadContext extends WriteContext {
  #first = true;
  #colon = true;
  consume(p: JSONProtocol): void {
    if (this.#first) {
      this.#first = false;
      this.#colon = true;
    } else {
      p._consumeSeparator(this.#colon ? ':' : ',');
      this.#colon = !this.#colon;
    }
  }
  override escapeNum(): boolean {
    return this.#colon;
  }
}
