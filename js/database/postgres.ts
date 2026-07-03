/**
* fino:database/postgres — PostgreSQL protocol client.
*
* PostgreSQL Frontend/Backend Protocol:
* https://www.postgresql.org/docs/current/protocol.html
*
* This module is the Postgres-specific database engine used by
* `fino:database`. It uses the frontend/backend protocol directly rather than
* `libpq`, so it can run on Fino's async socket and TLS primitives.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* await using db = await PostgresDatabase.open('postgres://user:pass@localhost/app');
* const row = await db.prepare('SELECT $1::int AS value').get(1);
* console.log(row?.value);
* ```
*/
import { Socket } from 'fino:net/socket';
import { TlsSocket } from 'fino:net/tls';
import type { Address } from 'fino:net/socket';
import { lookup } from 'fino:net/dns';
import { createSignal, type ReadonlySignal } from 'fino:signals';
import {
  decodeBackendMessage,
  encodeBind,
  encodeCancelRequest,
  encodeCopyData,
  encodeCopyDone,
  encodeCopyFail,
  encodeDescribe,
  encodeExecute,
  encodeParse,
  encodePasswordMessage,
  encodeQuery,
  encodeSaslInitialResponse,
  encodeSaslResponse,
  encodeSSLRequest,
  encodeStartupMessage,
  encodeSync,
  encodeTerminate,
  type BackendMessage,
  type RowField
} from 'internal:database/postgres/protocol';
import { ScramSha256Client, md5Password } from 'internal:database/postgres/scram';
import type { DbRow, DbValue, QueryResult } from 'fino:database';
import type { BufferedBytesReader, BufferedBytesWriter } from 'internal:stream';
const enc = new TextEncoder();
const dec = new TextDecoder();
export type PostgresTlsMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
export interface PostgresOptions {
  user?: string;
  password?: string;
  database?: string;
  host?: string;
  port?: number;
  tls?: PostgresTlsMode;
  applicationName?: string;
}
export interface PostgresNotification {
  processId: number;
  channel: string;
  payload: string;
}
export interface PostgresQueryResult extends QueryResult {
  command?: string;
}
interface ConnectionTarget {
  user: string;
  password?: string;
  database: string;
  host: string;
  port: number;
  tls: PostgresTlsMode;
  applicationName?: string;
}
function parseTarget(input: string | URL | PostgresOptions, options: PostgresOptions = {}): ConnectionTarget {
  if (typeof input === 'object' && !(input instanceof URL)) {
    const user = input.user ?? 'postgres';
    return { user, password: input.password, database: input.database ?? user, host: input.host ?? '127.0.0.1', port: input.port ?? 5432, tls: input.tls ?? 'prefer', applicationName: input.applicationName };
  }
  const url = input instanceof URL ? input : new URL(String(input));
  const user = decodeURIComponent(url.username || options.user || 'postgres');
  return {
    user,
    password: url.password ? decodeURIComponent(url.password) : options.password,
    database: decodeURIComponent(url.pathname.replace(/^\//, '') || options.database || user),
    host: (url.searchParams.get('host') ?? url.hostname) || options.host || '127.0.0.1',
    port: url.port ? Number(url.port) : options.port ?? 5432,
    tls: (url.searchParams.get('sslmode') as PostgresTlsMode | null) ?? options.tls ?? 'prefer',
    applicationName: url.searchParams.get('application_name') ?? options.applicationName
  };
}
function socketAddress(target: ConnectionTarget): Address {
  if (target.host.startsWith('/')) return { family: 'unix', path: `${target.host}/.s.PGSQL.${target.port}` };
  return target.host.includes(':') ? { family: 'ipv6', ip: target.host, port: target.port } : { family: 'ipv4', ip: target.host, port: target.port };
}
async function resolveSocketAddress(target: ConnectionTarget): Promise<Address> {
  if (target.host.startsWith('/')) return socketAddress(target);
  const resolved = await lookup(target.host, { family: target.host.includes(':') ? 6 : 4 });
  return resolved.family === 6 ? { family: 'ipv6', ip: resolved.address, port: target.port } : { family: 'ipv4', ip: resolved.address, port: target.port };
}
async function readFrame(reader: BufferedBytesReader): Promise<Uint8Array> {
  const first = await reader.readExactly(5);
  const length = new DataView(first.buffer, first.byteOffset + 1, 4).getInt32(0, false);
  const rest = length > 4 ? await reader.readExactly(length - 4) : new Uint8Array();
  const out = new Uint8Array(1 + length);
  out.set(first);
  out.set(rest, 5);
  return out;
}
function paramValue(value: DbValue): string | Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
function decodeValue(field: RowField, value: Uint8Array | null): DbValue {
  if (value === null) return null;
  if (field.typeOid === 17) return value;
  const text = dec.decode(value);
  switch (field.typeOid) {
    case 16: return text === 't';
    case 20: return BigInt(text);
    case 21:
    case 23: return Number(text);
    case 700:
    case 701: return Number(text);
    case 114:
    case 3802: return JSON.parse(text);
    default: return text;
  }
}
function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes('\0')) throw new Error('postgres: invalid identifier');
  return `"${value.replaceAll('"', '""')}"`;
}
function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('postgres: invalid string literal');
  return `'${value.replaceAll("'", "''")}'`;
}
async function* toAsyncChunks(source: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>): AsyncGenerator<Uint8Array> {
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    yield typeof chunk === 'string' ? enc.encode(chunk) : chunk;
  }
}
export class PostgresStatement {
  readonly #db: PostgresDatabase;
  readonly #sql: string;
  readonly #name: string;
  #finalized = false;
  constructor(db: PostgresDatabase, sql: string, name = '') {
    this.#db = db;
    this.#sql = sql;
    this.#name = name;
  }
  run(...params: DbValue[]): Promise<PostgresQueryResult> {
    return this.#db._execute(this.#sql, params, this.#name).then((result) => ({ changes: result.changes, command: result.command }));
  }
  get(...params: DbValue[]): Promise<DbRow | undefined> {
    return this.#db._execute(this.#sql, params, this.#name).then((result) => result.rows[0]);
  }
  all(...params: DbValue[]): Promise<DbRow[]> {
    return this.#db._execute(this.#sql, params, this.#name).then((result) => result.rows);
  }
  async *iterate(...params: DbValue[]): AsyncGenerator<DbRow> {
    for (const row of await this.all(...params)) yield row;
  }
  finalize(): void {
    this.#finalized = true;
  }
  get finalized(): boolean {
    return this.#finalized;
  }
}
export class PostgresDatabase {
  readonly driver = 'postgres';
  readonly parameters = new Map<string, string>();
  #reader!: BufferedBytesReader;
  #writer!: BufferedBytesWriter;
  #socket!: Socket | TlsSocket;
  #target!: ConnectionTarget;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  #backendProcessId = 0;
  #secretKey = new Uint8Array();
  #notifications = createSignal<PostgresNotification | null>(null);
  static async open(target: string | URL | PostgresOptions, options: PostgresOptions = {}): Promise<PostgresDatabase> {
    const db = new PostgresDatabase();
    await db.#connect(parseTarget(target, options));
    return db;
  }
  get notifications(): ReadonlySignal<PostgresNotification | null> {
    return this.#notifications;
  }
  async #connect(target: ConnectionTarget): Promise<void> {
    this.#target = target;
    let socket: Socket | TlsSocket = await Socket.connect(await resolveSocketAddress(target));
    if (target.tls !== 'disable') {
      const [reader, writer] = socket.split();
      await writer.write(encodeSSLRequest());
      await writer.flush();
      const response = await reader.readExactly(1);
      if (response[0] === 0x53) {
        socket = await TlsSocket.upgrade(socket, { hostname: target.host.startsWith('/') ? undefined : target.host, rejectUnauthorized: target.tls === 'verify-ca' || target.tls === 'verify-full' });
      } else if (target.tls === 'require' || target.tls === 'verify-ca' || target.tls === 'verify-full') {
        socket.close();
        throw new Error('postgres: server refused TLS');
      }
    }
    this.#socket = socket;
    [this.#reader, this.#writer] = socket.split();
    await this.#writer.write(encodeStartupMessage({ user: target.user, database: target.database, ...(target.applicationName ? { application_name: target.applicationName } : {}) }));
    await this.#writer.flush();
    await this.#authenticate();
  }
  async #authenticate(): Promise<void> {
    while (true) {
      const message = decodeBackendMessage(await readFrame(this.#reader));
      if (message.type === 'Authentication') {
        await this.#handleAuth(message);
      } else if (message.type === 'BackendKeyData') {
        this.#backendProcessId = message.processId;
        this.#secretKey = message.secretKey;
      } else if (message.type === 'ParameterStatus') {
        this.parameters.set(message.name, message.value);
      } else if (message.type === 'ReadyForQuery') {
        return;
      } else if (message.type === 'ErrorResponse') {
        throw new Error(message.fields.M ?? 'postgres authentication failed');
      }
    }
  }
  async #handleAuth(message: Extract<BackendMessage, { type: 'Authentication' }>): Promise<void> {
    const code = message.code;
    if (code === 0) return;
    const password = this.#target.password ?? '';
    if (code === 3) {
      await this.#writer.write(encodePasswordMessage(password));
      return this.#writer.flush();
    }
    if (code === 5) {
      await this.#writer.write(encodePasswordMessage(md5Password(password, this.#target.user, message.data.subarray(0, 4))));
      return this.#writer.flush();
    }
    if (code === 10) {
      const mechanisms = dec.decode(message.data).split('\0').filter(Boolean);
      if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error(`postgres: unsupported SASL mechanisms ${mechanisms.join(', ')}`);
      const scram = new ScramSha256Client(password);
      await this.#writer.write(encodeSaslInitialResponse('SCRAM-SHA-256', scram.initialResponse(this.#target.user)));
      await this.#writer.flush();
      const challenge = decodeBackendMessage(await readFrame(this.#reader));
      if (challenge.type !== 'Authentication' || challenge.code !== 11) throw new Error('postgres: expected SASL challenge');
      await this.#writer.write(encodeSaslResponse(await scram.finalMessage(dec.decode(challenge.data))));
      await this.#writer.flush();
      const final = decodeBackendMessage(await readFrame(this.#reader));
      if (final.type !== 'Authentication' || final.code !== 12) throw new Error('postgres: expected SASL final');
      await scram.verifyServerFinal(dec.decode(final.data));
      return;
    }
    throw new Error(`postgres: unsupported authentication code ${code}`);
  }
  _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }
  prepare(query: string): PostgresStatement {
    if (this.#closed) throw new Error('PostgresDatabase is closed');
    return new PostgresStatement(this, query);
  }
  async exec(query: string): Promise<void> {
    await this._simple(query);
  }
  async _simple(query: string): Promise<void> {
    await this._serialize(async () => {
      await this.#writer.write(encodeQuery(query));
      await this.#writer.flush();
      while (true) {
        const message = decodeBackendMessage(await readFrame(this.#reader));
        this.#handleAsync(message);
        if (message.type === 'ErrorResponse') throw new Error(message.fields.M ?? 'postgres query failed');
        if (message.type === 'ReadyForQuery') return;
      }
    });
  }
  async _execute(query: string, params: DbValue[] = [], statement = ''): Promise<{ rows: DbRow[]; changes: number; command?: string }> {
    return this._serialize(async () => {
      await this.#writer.write(encodeParse(statement, query));
      await this.#writer.write(encodeBind('', statement, params.map(paramValue)));
      await this.#writer.write(encodeDescribe('portal'));
      await this.#writer.write(encodeExecute());
      await this.#writer.write(encodeSync());
      await this.#writer.flush();
      const rows: DbRow[] = [];
      let fields: RowField[] = [];
      let command: string | undefined;
      while (true) {
        const message = decodeBackendMessage(await readFrame(this.#reader));
        this.#handleAsync(message);
        if (message.type === 'RowDescription') fields = message.fields;
        else if (message.type === 'DataRow') {
          const row: DbRow = {};
          for (let index = 0; index < fields.length; index++) row[fields[index]!.name] = decodeValue(fields[index]!, message.values[index] ?? null);
          rows.push(row);
        } else if (message.type === 'CommandComplete') command = message.tag;
        else if (message.type === 'ErrorResponse') throw new Error(message.fields.M ?? 'postgres query failed');
        else if (message.type === 'ReadyForQuery') break;
      }
      return { rows, changes: command ? Number(command.match(/(\d+)$/)?.[1] ?? 0) : 0, command };
    });
  }
  #handleAsync(message: BackendMessage): void {
    if (message.type === 'ParameterStatus') this.parameters.set(message.name, message.value);
    else if (message.type === 'NotificationResponse') this.#notifications.set(message);
    else if (message.type === 'NoticeResponse') {
      // Notices are intentionally non-fatal; callers can use server logs for now.
    }
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.exec('BEGIN');
    try {
      const result = await fn();
      await this.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        await this.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }
  async listen(channel: string): Promise<AsyncIterable<PostgresNotification> & { close(): Promise<void>; signal: ReadonlySignal<PostgresNotification | null> }> {
    await this.exec(`LISTEN ${quoteIdentifier(channel)}`);
    const signal = this.#notifications;
    let closed = false;
    return {
      signal,
      async close() {
        closed = true;
      },
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const current = signal.get();
          if (current?.channel === channel) yield current;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
  }
  async notify(channel: string, payload = ''): Promise<void> {
    await this.exec(`NOTIFY ${quoteIdentifier(channel)}, ${quoteLiteral(payload)}`);
  }
  async copyFrom(query: string, source: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>): Promise<PostgresQueryResult> {
    return this._serialize(async () => {
      await this.#writer.write(encodeQuery(query));
      await this.#writer.flush();
      let command: string | undefined;
      while (true) {
        const message = decodeBackendMessage(await readFrame(this.#reader));
        this.#handleAsync(message);
        if (message.type === 'CopyInResponse') break;
        if (message.type === 'ErrorResponse') throw new Error(message.fields.M ?? 'postgres copy failed');
      }
      try {
        for await (const chunk of toAsyncChunks(source)) await this.#writer.write(encodeCopyData(chunk));
        await this.#writer.write(encodeCopyDone());
      } catch (err) {
        await this.#writer.write(encodeCopyFail(err instanceof Error ? err.message : String(err)));
        throw err;
      } finally {
        await this.#writer.flush();
      }
      while (true) {
        const message = decodeBackendMessage(await readFrame(this.#reader));
        this.#handleAsync(message);
        if (message.type === 'CommandComplete') command = message.tag;
        else if (message.type === 'ErrorResponse') throw new Error(message.fields.M ?? 'postgres copy failed');
        else if (message.type === 'ReadyForQuery') break;
      }
      return { changes: command ? Number(command.match(/(\d+)$/)?.[1] ?? 0) : 0, command };
    });
  }
  async copyTo(query: string): Promise<Uint8Array[]> {
    return this._serialize(async () => {
      await this.#writer.write(encodeQuery(query));
      await this.#writer.flush();
      const chunks: Uint8Array[] = [];
      while (true) {
        const message = decodeBackendMessage(await readFrame(this.#reader));
        this.#handleAsync(message);
        if (message.type === 'CopyData') chunks.push(message.data);
        else if (message.type === 'ErrorResponse') throw new Error(message.fields.M ?? 'postgres copy failed');
        else if (message.type === 'ReadyForQuery') break;
      }
      return chunks;
    });
  }
  async cancel(): Promise<void> {
    const sock = await Socket.connect(await resolveSocketAddress(this.#target));
    const [, writer] = sock.split();
    await writer.write(encodeCancelRequest(this.#backendProcessId, this.#secretKey));
    await writer.flush();
    sock.close();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#writer.write(encodeTerminate());
      await this.#writer.flush();
    } catch {}
    this.#socket?.close();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
export class PostgresPool {
  readonly #target: string | URL | PostgresOptions;
  readonly #options: PostgresOptions;
  readonly #idle: PostgresDatabase[] = [];
  readonly #waiters: Array<{ resolve(db: PostgresDatabase): void; reject(err: Error): void }> = [];
  readonly #max: number;
  #total = 0;
  #closed = false;
  constructor(target: string | URL | PostgresOptions, options: PostgresOptions & { max?: number } = {}) {
    this.#target = target;
    this.#options = options;
    this.#max = options.max ?? 10;
  }
  async connect(): Promise<PostgresDatabase> {
    if (this.#closed) throw new Error('postgres pool is closed');
    const idle = this.#idle.pop();
    if (idle) return idle;
    if (this.#total >= this.#max) return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    this.#total++;
    try {
      return await PostgresDatabase.open(this.#target as any, this.#options);
    } catch (err) {
      this.#total--;
      throw err;
    }
  }
  release(db: PostgresDatabase): void {
    if (this.#closed) {
      db.close();
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(db);
      return;
    }
    this.#idle.push(db);
  }
  async run<T>(fn: (db: PostgresDatabase) => Promise<T>): Promise<T> {
    const db = await this.connect();
    try {
      return await fn(db);
    } finally {
      this.release(db);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#idle.splice(0).map((db) => db.close()));
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error('postgres pool is closed'));
    this.#total = 0;
  }
}
