/**
* internal:database/postgres/protocol — PostgreSQL protocol v3 codecs.
*
* PostgreSQL Frontend/Backend Protocol:
* https://www.postgresql.org/docs/current/protocol.html
*
* @internal
*/
const enc = new TextEncoder();
const dec = new TextDecoder();
function utf8(value: string): Uint8Array {
  return enc.encode(value);
}
function cstring(value: string): Uint8Array {
  const bytes = utf8(value);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
function i16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, value, false);
  return out;
}
function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}
function frontend(tag: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  return concat([utf8(tag), i32(body.byteLength + 4), body]);
}
export function encodeStartupMessage(params: Record<string, string>): Uint8Array {
  const entries: Uint8Array[] = [i32(196608)];
  for (const [name, value] of Object.entries(params)) {
    entries.push(cstring(name), cstring(value));
  }
  entries.push(new Uint8Array([0]));
  const body = concat(entries);
  return concat([i32(body.byteLength + 4), body]);
}
export function encodeSSLRequest(): Uint8Array {
  return concat([i32(8), i32(80877103)]);
}
export function encodeCancelRequest(processId: number, secretKey: Uint8Array): Uint8Array {
  return concat([i32(12 + secretKey.byteLength), i32(80877102), i32(processId), secretKey]);
}
export function encodeTerminate(): Uint8Array {
  return frontend('X');
}
export function encodeSync(): Uint8Array {
  return frontend('S');
}
export function encodeFlush(): Uint8Array {
  return frontend('H');
}
export function encodeQuery(query: string): Uint8Array {
  return frontend('Q', cstring(query));
}
export function encodePasswordMessage(password: string | Uint8Array): Uint8Array {
  return frontend('p', typeof password === 'string' ? cstring(password) : password);
}
export function encodeSaslInitialResponse(mechanism: string, response: string | Uint8Array): Uint8Array {
  const bytes = typeof response === 'string' ? utf8(response) : response;
  return frontend('p', concat([cstring(mechanism), i32(bytes.byteLength), bytes]));
}
export function encodeSaslResponse(response: string | Uint8Array): Uint8Array {
  return frontend('p', typeof response === 'string' ? utf8(response) : response);
}
export function encodeParse(statement: string, query: string, typeOids: number[] = []): Uint8Array {
  return frontend('P', concat([cstring(statement), cstring(query), i16(typeOids.length), ...typeOids.map(i32)]));
}
export function encodeDescribe(kind: 'statement' | 'portal', name = ''): Uint8Array {
  return frontend('D', concat([utf8(kind === 'statement' ? 'S' : 'P'), cstring(name)]));
}
export function encodeBind(portal: string, statement: string, values: Array<string | Uint8Array | null>): Uint8Array {
  const valueChunks: Uint8Array[] = [];
  for (const value of values) {
    if (value === null) valueChunks.push(i32(-1));
    else {
      const bytes = typeof value === 'string' ? utf8(value) : value;
      valueChunks.push(i32(bytes.byteLength), bytes);
    }
  }
  return frontend('B', concat([cstring(portal), cstring(statement), i16(0), i16(values.length), ...valueChunks, i16(0)]));
}
export function encodeExecute(portal = '', maxRows = 0): Uint8Array {
  return frontend('E', concat([cstring(portal), i32(maxRows)]));
}
export function encodeClose(kind: 'statement' | 'portal', name = ''): Uint8Array {
  return frontend('C', concat([utf8(kind === 'statement' ? 'S' : 'P'), cstring(name)]));
}
export function encodeCopyData(data: Uint8Array): Uint8Array {
  return frontend('d', data);
}
export function encodeCopyDone(): Uint8Array {
  return frontend('c');
}
export function encodeCopyFail(message: string): Uint8Array {
  return frontend('f', cstring(message));
}
class Reader {
  readonly bytes: Uint8Array;
  offset = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  u8(): number {
    return this.bytes[this.offset++]!;
  }
  i16(): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 2).getInt16(0, false);
    this.offset += 2;
    return value;
  }
  i32(): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getInt32(0, false);
    this.offset += 4;
    return value;
  }
  bytesN(length: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new Uint8Array(out);
  }
  cstring(): string {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0) throw new Error('postgres protocol: unterminated string');
    const value = dec.decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return value;
  }
  done(): boolean {
    return this.offset >= this.bytes.byteLength;
  }
}
export type BackendMessage =
  | { type: 'Authentication'; code: number; data: Uint8Array }
  | { type: 'BackendKeyData'; processId: number; secretKey: Uint8Array }
  | { type: 'ParameterStatus'; name: string; value: string }
  | { type: 'ReadyForQuery'; status: string }
  | { type: 'RowDescription'; fields: RowField[] }
  | { type: 'DataRow'; values: Array<Uint8Array | null> }
  | { type: 'CommandComplete'; tag: string }
  | { type: 'ErrorResponse' | 'NoticeResponse'; fields: Record<string, string> }
  | { type: 'NotificationResponse'; processId: number; channel: string; payload: string }
  | { type: 'ParseComplete' | 'BindComplete' | 'CloseComplete' | 'NoData' | 'PortalSuspended' | 'CopyDone' }
  | { type: 'CopyInResponse' | 'CopyOutResponse' | 'CopyBothResponse'; format: number; columnFormats: number[] }
  | { type: 'CopyData'; data: Uint8Array }
  | { type: 'ParameterDescription'; typeOids: number[] }
  | { type: 'Unknown'; tag: string; body: Uint8Array };
export interface RowField {
  name: string;
  tableOid: number;
  columnAttribute: number;
  typeOid: number;
  typeSize: number;
  typeModifier: number;
  format: number;
}
function decodeFields(reader: Reader): Record<string, string> {
  const fields: Record<string, string> = {};
  while (!reader.done()) {
    const code = reader.u8();
    if (code === 0) break;
    fields[String.fromCharCode(code)] = reader.cstring();
  }
  return fields;
}
function decodeCopy(type: 'CopyInResponse' | 'CopyOutResponse' | 'CopyBothResponse', reader: Reader): BackendMessage {
  const format = reader.u8();
  const count = reader.i16();
  const columnFormats: number[] = [];
  for (let index = 0; index < count; index++) columnFormats.push(reader.i16());
  return { type, format, columnFormats };
}
export function decodeBackendMessage(frame: Uint8Array): BackendMessage {
  const tag = String.fromCharCode(frame[0]!);
  const length = new DataView(frame.buffer, frame.byteOffset + 1, 4).getInt32(0, false);
  const reader = new Reader(frame.subarray(5, 1 + length));
  switch (tag) {
    case 'R': return { type: 'Authentication', code: reader.i32(), data: reader.bytesN(frame.byteLength - 9) };
    case 'K': return { type: 'BackendKeyData', processId: reader.i32(), secretKey: reader.bytesN(frame.byteLength - 13) };
    case 'S': return { type: 'ParameterStatus', name: reader.cstring(), value: reader.cstring() };
    case 'Z': return { type: 'ReadyForQuery', status: String.fromCharCode(reader.u8()) };
    case '1': return { type: 'ParseComplete' };
    case '2': return { type: 'BindComplete' };
    case '3': return { type: 'CloseComplete' };
    case 'n': return { type: 'NoData' };
    case 's': return { type: 'PortalSuspended' };
    case 'c': return { type: 'CopyDone' };
    case 'C': return { type: 'CommandComplete', tag: reader.cstring() };
    case 'E': return { type: 'ErrorResponse', fields: decodeFields(reader) };
    case 'N': return { type: 'NoticeResponse', fields: decodeFields(reader) };
    case 'A': return { type: 'NotificationResponse', processId: reader.i32(), channel: reader.cstring(), payload: reader.cstring() };
    case 't': {
      const count = reader.i16();
      const typeOids: number[] = [];
      for (let index = 0; index < count; index++) typeOids.push(reader.i32());
      return { type: 'ParameterDescription', typeOids };
    }
    case 'T': {
      const count = reader.i16();
      const fields: RowField[] = [];
      for (let index = 0; index < count; index++) {
        fields.push({ name: reader.cstring(), tableOid: reader.i32(), columnAttribute: reader.i16(), typeOid: reader.i32(), typeSize: reader.i16(), typeModifier: reader.i32(), format: reader.i16() });
      }
      return { type: 'RowDescription', fields };
    }
    case 'D': {
      const count = reader.i16();
      const values: Array<Uint8Array | null> = [];
      for (let index = 0; index < count; index++) {
        const len = reader.i32();
        values.push(len < 0 ? null : reader.bytesN(len));
      }
      return { type: 'DataRow', values };
    }
    case 'G': return decodeCopy('CopyInResponse', reader);
    case 'H': return decodeCopy('CopyOutResponse', reader);
    case 'W': return decodeCopy('CopyBothResponse', reader);
    case 'd': return { type: 'CopyData', data: reader.bytesN(frame.byteLength - 5) };
    default: return { type: 'Unknown', tag, body: reader.bytesN(frame.byteLength - 5) };
  }
}
