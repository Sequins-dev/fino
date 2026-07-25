/**
* internal:database/postgres/protocol — PostgreSQL protocol v3 codecs.
*
* Pure, stateless codecs for the PostgreSQL frontend/backend wire protocol
* (version 3.0). Each `encode*` function returns one complete, ready-to-write
* frame as a `Uint8Array` — a tag byte (for messages that have one) followed
* by a big-endian length and the body — and `decodeBackendMessage` turns one
* complete backend frame into a `BackendMessage` discriminated union.
*
* The module does no I/O and holds no connection state. Framing the inbound
* byte stream — reading the tag and four-byte length, then waiting for the
* full body — is the caller's job. `fino:database/postgres` layers connection
* management, authentication, and query execution on top of these codecs;
* use this module directly only when building protocol-level tooling such as
* proxies or test harnesses.
*
* Values travel in text format: `encodeBind` sends zero format codes so all
* parameters and result columns default to text, and `DataRow` values come
* back as raw bytes for the caller to decode.
*
* ```ts no_run
* import {
*   encodeStartupMessage,
*   encodeQuery,
*   decodeBackendMessage,
* } from 'internal:database/postgres/protocol';
*
* socket.write(encodeStartupMessage({ user: 'ada', database: 'app' }));
* socket.write(encodeQuery('SELECT now()'));
*
* // The caller splits the inbound stream into complete frames.
* const message = decodeBackendMessage(frame);
* if (message.type === 'DataRow') {
*   console.log(message.values);
* }
* ```
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
  return concat([
    utf8(tag),
    i32(body.byteLength + 4),
    body
  ]);
}
/**
* Encodes the StartupMessage that opens every connection.
*
* The frame carries protocol version 3.0 followed by NUL-terminated
* name/value pairs and a final terminator byte. The server requires `user`;
* `database`, `application_name`, and other run-time settings are optional.
* As a startup-phase message it has no tag byte — just the length and body —
* so it may only be sent as the first message on a connection (or right
* after a TLS handshake negotiated via `encodeSSLRequest`).
*
* ```ts no_run
* import { encodeStartupMessage } from 'internal:database/postgres/protocol';
*
* socket.write(encodeStartupMessage({
*   user: 'ada',
*   database: 'app',
*   application_name: 'fino',
* }));
* // Server replies with Authentication, ParameterStatus, BackendKeyData,
* // and finally ReadyForQuery frames.
* ```
*/
export function encodeStartupMessage(params: Record<string, string>): Uint8Array {
  const entries: Uint8Array[] = [i32(196608)];
  for (const [name, value] of Object.entries(params)) {
    entries.push(cstring(name), cstring(value));
  }
  entries.push(new Uint8Array([0]));
  const body = concat(entries);
  return concat([i32(body.byteLength + 4), body]);
}
/**
* Encodes the SSLRequest probe that asks the server to upgrade to TLS.
*
* Send this before the startup message on a fresh connection. The server
* answers with a single raw byte — `S` to proceed with a TLS handshake or
* `N` to refuse — not a regular protocol frame, so read exactly one byte
* before deciding how to continue. Like StartupMessage, the frame has no tag
* byte; it is the length followed by the magic code `80877103`.
*
* ```ts no_run
* import { encodeSSLRequest, encodeStartupMessage } from 'internal:database/postgres/protocol';
*
* socket.write(encodeSSLRequest());
* const answer = await readByte(socket);
* if (answer === 0x53) await upgradeToTls(socket); // 'S'
* socket.write(encodeStartupMessage({ user: 'ada' }));
* ```
*/
export function encodeSSLRequest(): Uint8Array {
  return concat([i32(8), i32(80877103)]);
}
/**
* Encodes a CancelRequest that aborts a query running on another connection.
*
* Cancellation is out of band: open a brand-new connection, write this frame
* as its first and only message, then close. `processId` and `secretKey` are
* the values captured from the `BackendKeyData` message received during the
* target connection's startup. The server sends no reply; success shows up
* as an `ErrorResponse` (query canceled) on the original connection.
*
* ```ts no_run
* import { encodeCancelRequest } from 'internal:database/postgres/protocol';
*
* // key came from the BackendKeyData message on the busy connection.
* cancelSocket.write(encodeCancelRequest(key.processId, key.secretKey));
* cancelSocket.close();
* ```
*/
export function encodeCancelRequest(processId: number, secretKey: Uint8Array): Uint8Array {
  return concat([
    i32(12 + secretKey.byteLength),
    i32(80877102),
    i32(processId),
    secretKey
  ]);
}
/**
* Encodes the Terminate message for a graceful disconnect.
*
* Write it as the last message on a connection, then close the socket. The
* server responds by closing its end; no reply frame is sent.
*
* ```ts no_run
* import { encodeTerminate } from 'internal:database/postgres/protocol';
*
* socket.write(encodeTerminate());
* socket.close();
* ```
*/
export function encodeTerminate(): Uint8Array {
  return frontend('X');
}
/**
* Encodes the Sync message that closes an extended-query pipeline.
*
* Sync marks the end of a Parse/Bind/Execute batch: the server closes the
* implicit transaction and answers with `ReadyForQuery`. It is also the error
* recovery point — after an `ErrorResponse` mid-pipeline the server discards
* messages until it sees a Sync, so always finish extended-query traffic with
* one even when an earlier step may have failed.
*
* ```ts no_run
* import { encodeParse, encodeBind, encodeExecute, encodeSync } from 'internal:database/postgres/protocol';
*
* socket.write(encodeParse('', 'SELECT $1::int', []));
* socket.write(encodeBind('', '', ['42']));
* socket.write(encodeExecute());
* socket.write(encodeSync());
* // ...read frames until ReadyForQuery.
* ```
*/
export function encodeSync(): Uint8Array {
  return frontend('S');
}
/**
* Encodes the Flush message, which forces the server to deliver pending output.
*
* Unlike Sync it does not end the pipeline or produce `ReadyForQuery`; it
* only asks the server to flush whatever responses it has buffered. Useful
* between extended-query steps when the client needs an intermediate result
* (for example a `ParameterDescription` after Describe) before sending more
* messages.
*
* ```ts no_run
* import { encodeDescribe, encodeFlush } from 'internal:database/postgres/protocol';
*
* socket.write(encodeDescribe('statement', 'get_user'));
* socket.write(encodeFlush());
* // ParameterDescription and RowDescription frames arrive without ending the batch.
* ```
*/
export function encodeFlush(): Uint8Array {
  return frontend('H');
}
/**
* Encodes a simple-protocol Query message.
*
* `query` may contain one or more SQL statements separated by semicolons.
* For each statement the server replies with `RowDescription` and `DataRow`
* frames (for row-returning statements) followed by `CommandComplete`, and
* ends the whole exchange with `ReadyForQuery`. The simple protocol has no
* parameter binding — use the Parse/Bind/Execute family for parameterized
* queries instead of interpolating values into the SQL text.
*
* ```ts no_run
* import { encodeQuery } from 'internal:database/postgres/protocol';
*
* socket.write(encodeQuery('SELECT id, name FROM users; SELECT count(*) FROM users'));
* ```
*/
export function encodeQuery(query: string): Uint8Array {
  return frontend('Q', cstring(query));
}
/**
* Encodes a PasswordMessage answering a cleartext or MD5 authentication request.
*
* Send in response to an `Authentication` message with code 3 (cleartext) or
* code 5 (MD5, where the response is the precomputed `md5...` digest string
* built with the salt from the request — see
* `internal:database/postgres/scram` for the digest helper). A string is
* NUL-terminated on the wire; a `Uint8Array` is sent verbatim, so include
* any required terminator yourself.
*
* ```ts no_run
* import { encodePasswordMessage } from 'internal:database/postgres/protocol';
*
* // After Authentication code 3:
* socket.write(encodePasswordMessage('hunter2'));
* ```
*/
export function encodePasswordMessage(password: string | Uint8Array): Uint8Array {
  return frontend('p', typeof password === 'string' ? cstring(password) : password);
}
/**
* Encodes the SASLInitialResponse that starts a SASL authentication exchange.
*
* Send in response to an `Authentication` message with code 10 (SASL), which
* lists the mechanisms the server supports. `mechanism` names the one chosen
* (typically `SCRAM-SHA-256`) and `response` is the mechanism's client-first
* message; string responses are encoded as UTF-8 and byte responses are sent
* verbatim, in both cases length-prefixed rather than NUL-terminated. The
* server continues the exchange with an `Authentication` code 11 frame.
*
* ```ts no_run
* import { encodeSaslInitialResponse } from 'internal:database/postgres/protocol';
*
* socket.write(encodeSaslInitialResponse('SCRAM-SHA-256', clientFirstMessage));
* ```
*/
export function encodeSaslInitialResponse(mechanism: string, response: string | Uint8Array): Uint8Array {
  const bytes = typeof response === 'string' ? utf8(response) : response;
  return frontend('p', concat([
    cstring(mechanism),
    i32(bytes.byteLength),
    bytes
  ]));
}
/**
* Encodes a SASLResponse continuing an in-progress SASL exchange.
*
* Send in response to an `Authentication` code 11 (SASL continue) frame; for
* SCRAM-SHA-256 the payload is the client-final message carrying the proof.
* The body is exactly the mechanism data — no mechanism name, length prefix,
* or NUL terminator. A successful exchange ends with `Authentication` code 12
* (SASL final) followed by code 0 (OK).
*
* ```ts no_run
* import { encodeSaslResponse } from 'internal:database/postgres/protocol';
*
* socket.write(encodeSaslResponse(clientFinalMessage));
* ```
*/
export function encodeSaslResponse(response: string | Uint8Array): Uint8Array {
  return frontend('p', typeof response === 'string' ? utf8(response) : response);
}
/**
* Encodes a Parse message that prepares a statement on the server.
*
* `statement` names the prepared statement — pass `''` for the unnamed
* statement, which is replaced by the next unnamed Parse. Placeholders in
* `query` are `$1`, `$2`, and so on. `typeOids` optionally pins parameter
* types by `pg_type` OID; omit it (or use OID `0` for individual slots) to
* let the server infer types from context. The server replies with
* `ParseComplete`, or `ErrorResponse` if the SQL fails to parse.
*
* ```ts no_run
* import { encodeParse } from 'internal:database/postgres/protocol';
*
* socket.write(encodeParse('get_user', 'SELECT * FROM users WHERE id = $1', [23]));
* ```
*/
export function encodeParse(statement: string, query: string, typeOids: number[] = []): Uint8Array {
  return frontend('P', concat([
    cstring(statement),
    cstring(query),
    i16(typeOids.length),
    ...typeOids.map(i32)
  ]));
}
/**
* Encodes a Describe message requesting metadata for a statement or portal.
*
* Describing a `'statement'` yields a `ParameterDescription` followed by a
* `RowDescription` (or `NoData` for statements that return no rows);
* describing a `'portal'` yields just the `RowDescription` or `NoData`. An
* empty `name` targets the unnamed statement or portal. Pair with
* `encodeFlush` to receive the metadata before continuing the pipeline.
*
* ```ts no_run
* import { encodeDescribe, encodeFlush } from 'internal:database/postgres/protocol';
*
* socket.write(encodeDescribe('statement', 'get_user'));
* socket.write(encodeFlush());
* ```
*/
export function encodeDescribe(kind: 'statement' | 'portal', name = ''): Uint8Array {
  return frontend('D', concat([utf8(kind === 'statement' ? 'S' : 'P'), cstring(name)]));
}
/**
* Encodes a Bind message that binds parameter values to a prepared statement.
*
* Creates the portal named `portal` (usually `''` for the unnamed portal)
* from the prepared statement named `statement`. Each entry in `values`
* becomes one `$n` parameter: `null` is sent as SQL NULL, strings are UTF-8
* encoded, and `Uint8Array` values are sent verbatim. No format codes are
* transmitted, so the server treats every parameter — and every result
* column — as text; byte values must therefore contain the text
* representation, not binary-format data. The server replies with
* `BindComplete`.
*
* ```ts no_run
* import { encodeBind } from 'internal:database/postgres/protocol';
*
* socket.write(encodeBind('', 'get_user', ['42']));
* socket.write(encodeBind('', 'set_bio', [null]));
* ```
*/
export function encodeBind(portal: string, statement: string, values: Array<string | Uint8Array | null>): Uint8Array {
  const valueChunks: Uint8Array[] = [];
  for (const value of values) {
    if (value === null) valueChunks.push(i32(-1));
    else {
      const bytes = typeof value === 'string' ? utf8(value) : value;
      valueChunks.push(i32(bytes.byteLength), bytes);
    }
  }
  return frontend('B', concat([
    cstring(portal),
    cstring(statement),
    i16(0),
    i16(values.length),
    ...valueChunks,
    i16(0)
  ]));
}
/**
* Encodes an Execute message that runs a bound portal.
*
* With `maxRows` of `0` the portal runs to completion and the server ends
* the result stream with `CommandComplete`. A positive `maxRows` caps the
* number of `DataRow` frames returned; if rows remain the server sends
* `PortalSuspended` instead, and another Execute for the same portal resumes
* where it left off. Execute produces no `RowDescription` — issue a
* Describe first if column metadata is needed.
*
* ```ts no_run
* import { encodeExecute, encodeSync } from 'internal:database/postgres/protocol';
*
* socket.write(encodeExecute('', 100)); // fetch at most 100 rows
* socket.write(encodeSync());
* ```
*/
export function encodeExecute(portal = '', maxRows = 0): Uint8Array {
  return frontend('E', concat([cstring(portal), i32(maxRows)]));
}
/**
* Encodes a Close message that releases a prepared statement or portal.
*
* Closing a statement also closes any portals built from it. Closing
* something that does not exist is not an error. An empty `name` targets the
* unnamed statement or portal. The server replies with `CloseComplete`.
*
* ```ts no_run
* import { encodeClose } from 'internal:database/postgres/protocol';
*
* socket.write(encodeClose('statement', 'get_user'));
* ```
*/
export function encodeClose(kind: 'statement' | 'portal', name = ''): Uint8Array {
  return frontend('C', concat([utf8(kind === 'statement' ? 'S' : 'P'), cstring(name)]));
}
/**
* Encodes a CopyData message carrying one chunk of COPY payload.
*
* Used after the server answers a `COPY ... FROM STDIN` query with
* `CopyInResponse`. Chunk boundaries are arbitrary — the server reassembles
* the stream, so rows may span chunks. Finish the transfer with
* `encodeCopyDone` or abort it with `encodeCopyFail`.
*
* ```ts no_run
* import { encodeCopyData, encodeCopyDone } from 'internal:database/postgres/protocol';
*
* const enc = new TextEncoder();
* socket.write(encodeCopyData(enc.encode('1\tada\n')));
* socket.write(encodeCopyData(enc.encode('2\tgrace\n')));
* socket.write(encodeCopyDone());
* ```
*/
export function encodeCopyData(data: Uint8Array): Uint8Array {
  return frontend('d', data);
}
/**
* Encodes the CopyDone message that completes a COPY-in transfer.
*
* Send after the last `CopyData` chunk. The server then commits the copy and
* replies with `CommandComplete` followed by `ReadyForQuery`.
*
* ```ts no_run
* import { encodeCopyDone } from 'internal:database/postgres/protocol';
*
* socket.write(encodeCopyDone());
* ```
*/
export function encodeCopyDone(): Uint8Array {
  return frontend('c');
}
/**
* Encodes the CopyFail message that aborts a COPY-in transfer.
*
* `message` is a human-readable reason the server includes in the resulting
* `ErrorResponse`. The COPY statement fails and no rows are kept.
*
* ```ts no_run
* import { encodeCopyFail } from 'internal:database/postgres/protocol';
*
* socket.write(encodeCopyFail('source file unreadable'));
* ```
*/
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
/**
* Discriminated union of decoded backend messages, keyed by `type`.
*
* Every message `decodeBackendMessage` understands maps to one variant;
* frames with an unrecognized tag decode to `Unknown` with the raw body
* preserved so callers can skip or log them. Payloads worth noting:
*
* - `Authentication` — `code` selects the mechanism (0 = OK, 3 = cleartext
*   password, 5 = MD5, 10 = SASL start, 11 = SASL continue, 12 = SASL final)
*   and `data` holds the mechanism-specific remainder such as the MD5 salt
*   or the SCRAM server message.
* - `DataRow` — one entry per column; `null` marks SQL NULL, otherwise the
*   raw column bytes in the format declared by the preceding `RowDescription`.
* - `ErrorResponse` / `NoticeResponse` — `fields` keyed by the single-letter
*   protocol codes (`S` severity, `C` SQLSTATE, `M` message, `D` detail, ...).
* - `ReadyForQuery` — `status` is `I` (idle), `T` (in a transaction), or `E`
*   (in a failed transaction).
* - `NotificationResponse` — a `LISTEN`/`NOTIFY` event with the notifying
*   backend's `processId`, the `channel`, and the `payload` string.
*
* ```ts no_run
* import { decodeBackendMessage, type BackendMessage } from 'internal:database/postgres/protocol';
*
* const message: BackendMessage = decodeBackendMessage(frame);
* switch (message.type) {
*   case 'DataRow': rows.push(message.values); break;
*   case 'CommandComplete': console.log(message.tag); break;
*   case 'ErrorResponse': throw new Error(message.fields.M);
* }
* ```
*/
export type BackendMessage = {
  type: 'Authentication';
  code: number;
  data: Uint8Array;
} | {
  type: 'BackendKeyData';
  processId: number;
  secretKey: Uint8Array;
} | {
  type: 'ParameterStatus';
  name: string;
  value: string;
} | {
  type: 'ReadyForQuery';
  status: string;
} | {
  type: 'RowDescription';
  fields: RowField[];
} | {
  type: 'DataRow';
  values: Array<Uint8Array | null>;
} | {
  type: 'CommandComplete';
  tag: string;
} | {
  type: 'ErrorResponse' | 'NoticeResponse';
  fields: Record<string, string>;
} | {
  type: 'NotificationResponse';
  processId: number;
  channel: string;
  payload: string;
} | {
  type: 'ParseComplete' | 'BindComplete' | 'CloseComplete' | 'NoData' | 'PortalSuspended' | 'CopyDone';
} | {
  type: 'CopyInResponse' | 'CopyOutResponse' | 'CopyBothResponse';
  format: number;
  columnFormats: number[];
} | {
  type: 'CopyData';
  data: Uint8Array;
} | {
  type: 'ParameterDescription';
  typeOids: number[];
} | {
  type: 'Unknown';
  tag: string;
  body: Uint8Array;
};
/**
* Column metadata from a `RowDescription` message.
*
* A `RowDescription` carries one `RowField` per result column, in column
* order, describing the `DataRow` frames that follow. Use `typeOid` together
* with `format` to decide how to decode each column's bytes.
*
* ```ts no_run
* import { decodeBackendMessage, type RowField } from 'internal:database/postgres/protocol';
*
* const message = decodeBackendMessage(frame);
* if (message.type === 'RowDescription') {
*   const names = message.fields.map((field: RowField) => field.name);
* }
* ```
*/
export interface RowField {
  /** Column name, or the alias assigned in the query. */
  name: string;
  /** OID of the source table, or `0` when the column is not a simple table column. */
  tableOid: number;
  /** Attribute number of the source column, or `0` when the column is not a simple table column. */
  columnAttribute: number;
  /** OID of the column's data type in the `pg_type` catalog — e.g. `23` for `int4`, `25` for `text`. */
  typeOid: number;
  /** Size of the type in bytes; negative for variable-length types. */
  typeSize: number;
  /** Type-specific modifier, such as declared `varchar` length; `-1` when the type takes none. */
  typeModifier: number;
  /** Wire format of the column's `DataRow` values: `0` for text, `1` for binary. */
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
  return {
    type,
    format,
    columnFormats
  };
}
/**
* Decodes one complete backend frame into a `BackendMessage`.
*
* `frame` must be exactly one message: the tag byte, the four-byte big-endian
* length (which counts itself but not the tag), and the body. Framing the
* stream is the caller's job — buffer until `1 + length` bytes are available,
* slice the frame out, and pass it here. Byte payloads in the result
* (`DataRow` values, `CopyData`, authentication `data`) are copied out of
* `frame`, so the input buffer may be reused or mutated afterwards.
*
* Frames with an unrecognized tag decode to the `Unknown` variant rather than
* throwing. Throws if a NUL-terminated string field runs past the end of the
* frame, which indicates a truncated or corrupt frame.
*
* ```ts no_run
* import { decodeBackendMessage } from 'internal:database/postgres/protocol';
*
* const view = new DataView(buffer.buffer, buffer.byteOffset);
* const frameLength = 1 + view.getInt32(1, false);
* if (buffer.byteLength >= frameLength) {
*   const message = decodeBackendMessage(buffer.subarray(0, frameLength));
*   if (message.type === 'ReadyForQuery') console.log(message.status);
* }
* ```
*/
export function decodeBackendMessage(frame: Uint8Array): BackendMessage {
  const tag = String.fromCharCode(frame[0]!);
  const length = new DataView(frame.buffer, frame.byteOffset + 1, 4).getInt32(0, false);
  const reader = new Reader(frame.subarray(5, 1 + length));
  switch (tag) {
    case 'R': return {
      type: 'Authentication',
      code: reader.i32(),
      data: reader.bytesN(frame.byteLength - 9)
    };
    case 'K': return {
      type: 'BackendKeyData',
      processId: reader.i32(),
      secretKey: reader.bytesN(frame.byteLength - 13)
    };
    case 'S': return {
      type: 'ParameterStatus',
      name: reader.cstring(),
      value: reader.cstring()
    };
    case 'Z': return {
      type: 'ReadyForQuery',
      status: String.fromCharCode(reader.u8())
    };
    case '1': return { type: 'ParseComplete' };
    case '2': return { type: 'BindComplete' };
    case '3': return { type: 'CloseComplete' };
    case 'n': return { type: 'NoData' };
    case 's': return { type: 'PortalSuspended' };
    case 'c': return { type: 'CopyDone' };
    case 'C': return {
      type: 'CommandComplete',
      tag: reader.cstring()
    };
    case 'E': return {
      type: 'ErrorResponse',
      fields: decodeFields(reader)
    };
    case 'N': return {
      type: 'NoticeResponse',
      fields: decodeFields(reader)
    };
    case 'A': return {
      type: 'NotificationResponse',
      processId: reader.i32(),
      channel: reader.cstring(),
      payload: reader.cstring()
    };
    case 't': {
      const count = reader.i16();
      const typeOids: number[] = [];
      for (let index = 0; index < count; index++) typeOids.push(reader.i32());
      return {
        type: 'ParameterDescription',
        typeOids
      };
    }
    case 'T': {
      const count = reader.i16();
      const fields: RowField[] = [];
      for (let index = 0; index < count; index++) {
        fields.push({
          name: reader.cstring(),
          tableOid: reader.i32(),
          columnAttribute: reader.i16(),
          typeOid: reader.i32(),
          typeSize: reader.i16(),
          typeModifier: reader.i32(),
          format: reader.i16()
        });
      }
      return {
        type: 'RowDescription',
        fields
      };
    }
    case 'D': {
      const count = reader.i16();
      const values: Array<Uint8Array | null> = [];
      for (let index = 0; index < count; index++) {
        const len = reader.i32();
        values.push(len < 0 ? null : reader.bytesN(len));
      }
      return {
        type: 'DataRow',
        values
      };
    }
    case 'G': return decodeCopy('CopyInResponse', reader);
    case 'H': return decodeCopy('CopyOutResponse', reader);
    case 'W': return decodeCopy('CopyBothResponse', reader);
    case 'd': return {
      type: 'CopyData',
      data: reader.bytesN(frame.byteLength - 5)
    };
    default: return {
      type: 'Unknown',
      tag,
      body: reader.bytesN(frame.byteLength - 5)
    };
  }
}
