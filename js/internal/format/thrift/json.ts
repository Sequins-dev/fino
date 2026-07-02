/**
* Thrift JSON protocol (`TJSONProtocol`).
*
* The interoperable text protocol: messages are `[version,name,type,seqid,…]`
* arrays, structs are objects keyed by field-id string with a nested
* `{ "<typecode>": value }`, containers are `["<elemcode>",size,…]` /
* `["<kcode>","<vcode>",size,{…}]` arrays, binary is base64 (unpadded), and
* non-finite doubles are the strings `"NaN"`/`"Infinity"`/`"-Infinity"`. Object
* keys are quoted numbers, per JSON. The reader is a small tokenizer that honors
* the exact grammar (and parses i64 as `bigint` to stay lossless).
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
* Thrift JSON protocol. Manages its own text buffer (write) and character
* cursor (read) rather than the shared `ByteWriter`/`ByteReader`.
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
  constructor(input?: Uint8Array) {
    this.#source = input ?? new Uint8Array(0);
    if (input !== undefined) this.#in = _decoder.decode(input);
  }
  bytes(): Uint8Array {
    return _encoder.encode(this.#parts.join(''));
  }

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
  writeMessageBegin(name: string, type: number, seqid: number): void {
    this.#writeArrayStart();
    this.#writeJSONInteger(String(VERSION));
    this.#writeJSONString(name);
    this.#writeJSONInteger(String(type));
    this.#writeJSONInteger(String(seqid));
  }
  writeMessageEnd(): void {
    this.#writeArrayEnd();
  }
  writeStructBegin(_name?: string): void {
    this.#writeObjectStart();
  }
  writeStructEnd(): void {
    this.#writeObjectEnd();
  }
  writeFieldBegin(_name: string, type: number, id: number): void {
    this.#writeJSONInteger(String(id));
    this.#writeObjectStart();
    this.#writeJSONString(TYPE_NAME[type]!);
  }
  writeFieldEnd(): void {
    this.#writeObjectEnd();
  }
  writeFieldStop(): void {}
  writeMapBegin(keyType: number, valueType: number, size: number): void {
    this.#writeArrayStart();
    this.#writeJSONString(TYPE_NAME[keyType]!);
    this.#writeJSONString(TYPE_NAME[valueType]!);
    this.#writeJSONInteger(String(size));
    this.#writeObjectStart();
  }
  writeMapEnd(): void {
    this.#writeObjectEnd();
    this.#writeArrayEnd();
  }
  writeListBegin(elemType: number, size: number): void {
    this.#writeArrayStart();
    this.#writeJSONString(TYPE_NAME[elemType]!);
    this.#writeJSONInteger(String(size));
  }
  writeListEnd(): void {
    this.#writeArrayEnd();
  }
  writeSetBegin(elemType: number, size: number): void {
    this.writeListBegin(elemType, size);
  }
  writeSetEnd(): void {
    this.#writeArrayEnd();
  }
  writeBool(value: boolean): void {
    this.#writeJSONInteger(value ? '1' : '0');
  }
  writeByte(value: number): void {
    this.#writeJSONInteger(String(value));
  }
  writeI16(value: number): void {
    this.#writeJSONInteger(String(value));
  }
  writeI32(value: number): void {
    this.#writeJSONInteger(String(value));
  }
  writeI64(value: bigint): void {
    this.#writeJSONInteger(value.toString());
  }
  writeDouble(value: number): void {
    this.#writeJSONDouble(value);
  }
  writeString(value: string): void {
    this.#writeJSONString(value);
  }
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
  readMessageEnd(): void {
    this.#readArrayEnd();
  }
  readStructBegin(): string | null {
    this.#readObjectStart();
    return null;
  }
  readStructEnd(): void {
    this.#readObjectEnd();
  }
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
  readFieldEnd(): void {
    this.#readObjectEnd();
  }
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
  readMapEnd(): void {
    this.#readObjectEnd();
    this.#readArrayEnd();
  }
  readListBegin(): ListHeader {
    this.#readArrayStart();
    const elemType = NAME_TYPE[this.#readJSONString()]!;
    const size = Number(this.#readNumericToken());
    return {
      elemType,
      size
    };
  }
  readListEnd(): void {
    this.#readArrayEnd();
  }
  readSetBegin(): ListHeader {
    return this.readListBegin();
  }
  readSetEnd(): void {
    this.#readArrayEnd();
  }
  readBool(): boolean {
    return Number(this.#readNumericToken()) !== 0;
  }
  readByte(): number {
    return Number(this.#readNumericToken());
  }
  readI16(): number {
    return Number(this.#readNumericToken());
  }
  readI32(): number {
    return Number(this.#readNumericToken());
  }
  readI64(): bigint {
    return BigInt(this.#readNumericToken());
  }
  readDouble(): number {
    const token = this.#readNumericToken();
    if (token === 'NaN') return NaN;
    if (token === 'Infinity') return Infinity;
    if (token === '-Infinity') return -Infinity;
    return Number(token);
  }
  readString(): string {
    return this.#readJSONString();
  }
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
