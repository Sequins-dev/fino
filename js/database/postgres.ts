/**
* fino:database/postgres — PostgreSQL protocol client.
*
* This module is the Postgres-specific database engine used by
* `fino:database`. It speaks the PostgreSQL frontend/backend protocol (v3)
* directly rather than binding `libpq`, so every exchange runs on Fino's
* async socket and TLS primitives and never blocks the event loop.
*
* Parameterized statements use the extended query protocol
* (Parse/Bind/Execute), while `exec()`, `LISTEN`/`NOTIFY`, and `COPY` use the
* simple protocol. TLS is negotiated with libpq-compatible `sslmode`
* semantics, and cleartext, MD5, and SCRAM-SHA-256 authentication are all
* supported. Each connection serializes its commands on an internal queue,
* so concurrent calls on one `PostgresDatabase` are safe but execute one at
* a time; use `PostgresPool` when you need real query concurrency.
*
* Result values arrive in the text protocol and are decoded by type OID:
* `boolean`, `int2`/`int4`, and `float4`/`float8` become JS primitives,
* `int8` becomes a `BigInt`, `json`/`jsonb` are parsed, `bytea` values are
* returned as `Uint8Array`, and everything else is returned as a string.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* await using db = await PostgresDatabase.open('postgres://user:pass@localhost/app');
* const row = await db.prepare('SELECT $1::int AS value').get(1);
* console.log(row?.value);
* ```
*
* PostgreSQL Frontend/Backend Protocol:
* https://www.postgresql.org/docs/current/protocol.html
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
/**
* TLS negotiation policy for a Postgres connection, mirroring libpq's
* `sslmode` values.
*
* - `'disable'` — never request TLS.
* - `'prefer'` (the default) — request TLS but fall back to plaintext when
*   the server refuses.
* - `'require'` — require TLS without verifying the server certificate.
* - `'verify-ca'` / `'verify-full'` — require TLS and verify the server
*   certificate. This client treats the two verify modes identically.
*/
export type PostgresTlsMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
/**
* Connection settings for `PostgresDatabase.open` and `PostgresPool`.
*
* All fields are optional. When `open()` is given a connection URL as well,
* values present in the URL win over these options. Defaults: user
* `postgres`, database named after the user, host `127.0.0.1`, port `5432`,
* TLS mode `'prefer'`.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* const db = await PostgresDatabase.open({
*   host: 'db.internal',
*   user: 'app',
*   password: 'secret',
*   database: 'app',
*   tls: 'verify-full',
*   applicationName: 'billing-worker'
* });
* ```
*/
export interface PostgresOptions {
  /** Role to authenticate as; defaults to `postgres`. */
  user?: string;
  /**
  * Password for cleartext, MD5, or SCRAM authentication. Omit for servers
  * that trust the connection.
  */
  password?: string;
  /** Database to connect to; defaults to the user name. */
  database?: string;
  /**
  * Hostname, IP address, or Unix-socket directory (any path starting with
  * `/`); defaults to `127.0.0.1`. Hostnames are resolved via `fino:net/dns`.
  */
  host?: string;
  /**
  * TCP port, which for Unix-socket hosts selects the `.s.PGSQL.<port>`
  * socket file; defaults to `5432`.
  */
  port?: number;
  /** TLS negotiation policy; defaults to `'prefer'`. */
  tls?: PostgresTlsMode;
  /**
  * Value reported to the server as `application_name`, visible in
  * `pg_stat_activity` and server logs.
  */
  applicationName?: string;
}
/**
* A `NOTIFY` message received from the server.
*
* Delivered through `PostgresDatabase.notifications` and the iterators
* returned by `PostgresDatabase.listen()`.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* await using db = await PostgresDatabase.open('postgres://ada@localhost/app');
* const sub = await db.listen('jobs');
* for await (const note of sub) {
*   console.log(`${note.channel} from pid ${note.processId}: ${note.payload}`);
* }
* ```
*/
export interface PostgresNotification {
  /** Backend process ID of the connection that issued the `NOTIFY`. */
  processId: number;
  /** Channel the notification was sent on. */
  channel: string;
  /** Payload string; empty when the notifier omitted one. */
  payload: string;
}
/**
* Result of a Postgres statement execution.
*
* Extends the generic `QueryResult` from `fino:database`: `changes` is
* parsed from the trailing row count of the command tag (`0` when the tag
* carries none), and `lastInsertRowid` is never populated — use a
* `RETURNING` clause to read generated keys.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* await using db = await PostgresDatabase.open('postgres://ada@localhost/app');
* const result = await db.prepare('INSERT INTO users (name) VALUES ($1)').run('Ada');
* console.log(result.changes, result.command); // 1 'INSERT 0 1'
* ```
*/
export interface PostgresQueryResult extends QueryResult {
  /**
  * Command tag reported by the server, such as `'INSERT 0 1'` or
  * `'SELECT 3'`; absent when the statement completed without one.
  */
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
/**
* A prepared statement bound to a `PostgresDatabase` connection.
*
* Created by `PostgresDatabase.prepare()`. Each execution round-trips the
* extended query protocol (Parse/Bind/Execute/Sync) using the unnamed
* server-side statement, so the SQL is re-parsed by the server on every
* call. Positional parameters use Postgres `$1`, `$2`, ... placeholders and
* are sent in text format: `Date` values as ISO 8601 strings, `Uint8Array`
* values as raw bytes, `null`/`undefined` as SQL `NULL`, and everything else
* via `String()`.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* await using db = await PostgresDatabase.open('postgres://ada@localhost/app');
* const insert = db.prepare('INSERT INTO users (name) VALUES ($1)');
* await insert.run('Ada');
*
* const byName = db.prepare('SELECT * FROM users WHERE name = $1');
* const user = await byName.get('Ada');
* ```
*/
export class PostgresStatement {
  readonly #db: PostgresDatabase;
  readonly #sql: string;
  readonly #name: string;
  #finalized = false;
  /**
  * Binds SQL text to a connection under an optional server-side statement
  * name. Application code should use `PostgresDatabase.prepare()` rather
  * than constructing statements directly.
  */
  constructor(db: PostgresDatabase, sql: string, name = '') {
    this.#db = db;
    this.#sql = sql;
    this.#name = name;
  }
  /**
  * Executes the statement and resolves with the affected-row count and
  * command tag, discarding any returned rows.
  */
  run(...params: DbValue[]): Promise<PostgresQueryResult> {
    return this.#db._execute(this.#sql, params, this.#name).then((result) => ({ changes: result.changes, command: result.command }));
  }
  /**
  * Executes the statement and resolves with the first returned row, or
  * `undefined` when the query produces none.
  */
  get(...params: DbValue[]): Promise<DbRow | undefined> {
    return this.#db._execute(this.#sql, params, this.#name).then((result) => result.rows[0]);
  }
  /** Executes the statement and resolves with every returned row. */
  all(...params: DbValue[]): Promise<DbRow[]> {
    return this.#db._execute(this.#sql, params, this.#name).then((result) => result.rows);
  }
  /**
  * Executes the statement and yields each returned row.
  *
  * Rows are fetched eagerly in a single exchange and then yielded from
  * memory — this is an iteration convenience, not a streaming cursor.
  */
  async *iterate(...params: DbValue[]): AsyncGenerator<DbRow> {
    for (const row of await this.all(...params)) yield row;
  }
  /**
  * Marks the statement finalized.
  *
  * The unnamed server-side statement holds no per-statement resources, so
  * this only flips the `finalized` flag for API parity with other
  * `fino:database` drivers; it does not prevent further execution.
  */
  finalize(): void {
    this.#finalized = true;
  }
  /** Whether `finalize()` has been called on this statement. */
  get finalized(): boolean {
    return this.#finalized;
  }
}
/**
* A single PostgreSQL connection.
*
* Open one with the static `open()` factory; the constructor alone produces
* an unconnected instance. `open()` performs TLS negotiation and
* authentication, after which every command is serialized on an internal
* queue — concurrent calls on the same connection are safe but execute one
* at a time. The class implements the `DatabaseConnection` contract from
* `fino:database`, so the same instance is what `Database.open('postgres://...')`
* returns.
*
* Supports `await using` for scoped cleanup.
*
* ```ts no_run
* import { PostgresDatabase } from 'fino:database/postgres';
*
* await using db = await PostgresDatabase.open('postgres://ada@localhost/app');
* await db.exec('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text)');
* await db.prepare('INSERT INTO notes (body) VALUES ($1)').run('hello');
* const notes = await db.prepare('SELECT * FROM notes').all();
* console.log(db.parameters.get('server_version'), notes.length);
* ```
*/
export class PostgresDatabase {
  /** Driver discriminant used by the `fino:database` facade; always `'postgres'`. */
  readonly driver = 'postgres';
  /**
  * Server-reported runtime parameters such as `server_version` and
  * `client_encoding`, captured from `ParameterStatus` messages during
  * startup and updated whenever the server reports a change mid-session.
  */
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
  /**
  * Connects, authenticates, and resolves with a ready connection.
  *
  * The target may be a `postgres://` URL (string or `URL`) or a
  * `PostgresOptions` object. URLs take the user and password from the
  * userinfo part and the database from the path, and understand the
  * `sslmode`, `host`, and `application_name` query parameters; anything
  * missing from the URL falls back to `options`, then to the defaults
  * documented on `PostgresOptions`. A host beginning with `/` is treated as
  * a Unix-socket directory and the client connects to
  * `<host>/.s.PGSQL.<port>`. Hostnames are resolved via `fino:net/dns`
  * before connecting.
  *
  * Throws if the TCP or Unix-socket connection fails, if TLS is required
  * but the server refuses it, or if authentication fails.
  *
  * ```ts no_run
  * import { PostgresDatabase } from 'fino:database/postgres';
  *
  * const fromUrl = await PostgresDatabase.open(
  *   'postgres://ada:secret@db.internal:5432/app?sslmode=verify-full'
  * );
  * const fromOptions = await PostgresDatabase.open({ host: '/var/run/postgresql', user: 'ada' });
  * ```
  */
  static async open(target: string | URL | PostgresOptions, options: PostgresOptions = {}): Promise<PostgresDatabase> {
    const db = new PostgresDatabase();
    await db.#connect(parseTarget(target, options));
    return db;
  }
  /**
  * Signal holding the most recent `NOTIFY` received on this connection, or
  * `null` before the first one.
  *
  * Notifications are decoded while the connection processes protocol
  * traffic for other calls; an otherwise idle connection does not observe
  * new notifications until its next query. Prefer `listen()` for a
  * channel-scoped async iterator.
  */
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
  /**
  * Chains `fn` onto the connection's command queue so protocol exchanges
  * never interleave on the socket. Backs every query method; part of the
  * driver-internal surface shared with `fino:database`, not something
  * application code needs to call.
  */
  _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }
  /**
  * Creates a prepared statement for later execution.
  *
  * Preparation is lazy — nothing is sent to the server until the statement
  * first runs. Throws if the connection has been closed.
  *
  * ```ts no_run
  * const stmt = db.prepare('SELECT * FROM users WHERE id = $1');
  * const user = await stmt.get(7);
  * ```
  */
  prepare(query: string): PostgresStatement {
    if (this.#closed) throw new Error('PostgresDatabase is closed');
    return new PostgresStatement(this, query);
  }
  /**
  * Runs SQL through the simple query protocol, discarding any result rows.
  *
  * Accepts multiple statements separated by semicolons, which makes it the
  * right tool for DDL scripts and other parameterless commands. Throws with
  * the server's error message if any statement fails.
  *
  * ```ts no_run
  * await db.exec('CREATE TABLE a (id int); CREATE TABLE b (id int)');
  * ```
  */
  async exec(query: string): Promise<void> {
    await this._simple(query);
  }
  /**
  * Runs `query` on the simple query protocol and waits for the connection
  * to become ready again, surfacing server errors. Backs `exec()`; part of
  * the driver-internal surface shared with `fino:database`.
  */
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
  /**
  * Runs one extended-protocol exchange (Parse/Bind/Describe/Execute/Sync)
  * and collects the decoded rows, affected-row count, and command tag.
  * Backs `PostgresStatement`; part of the driver-internal surface shared
  * with `fino:database`.
  */
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
  /**
  * Runs `fn` inside a transaction.
  *
  * Issues `BEGIN` before calling `fn`, `COMMIT` when it resolves, and
  * `ROLLBACK` when it rejects; rollback failures are swallowed so the
  * original error propagates. Transactions do not nest — a nested call
  * issues a second `BEGIN`, which Postgres warns about and ignores.
  *
  * ```ts no_run
  * await db.transaction(async () => {
  *   await db.prepare('UPDATE accounts SET balance = balance - $1 WHERE id = $2').run(100, 1);
  *   await db.prepare('UPDATE accounts SET balance = balance + $1 WHERE id = $2').run(100, 2);
  * });
  * ```
  */
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
  /**
  * Subscribes to a notification channel and returns an async iterable of
  * matching notifications.
  *
  * Issues `LISTEN` with the channel name safely quoted as an identifier;
  * throws if the name is empty or contains a NUL byte. The returned object
  * polls the connection's notification signal roughly every 10ms and
  * yields the signal's current notification on each tick where it targets
  * this channel. Call `close()` to stop iterating (no `UNLISTEN` is sent);
  * the raw signal is exposed as `signal` for reactive composition.
  *
  * Because notifications are only decoded while the connection processes
  * protocol traffic, a connection that sits idle after `listen()` will not
  * observe new notifications until it runs another query.
  *
  * ```ts no_run
  * const sub = await db.listen('jobs');
  * for await (const note of sub) {
  *   console.log(note.channel, note.payload);
  * }
  * ```
  */
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
  /**
  * Sends a `NOTIFY` on `channel` with an optional payload.
  *
  * The channel is quoted as an identifier and the payload as a string
  * literal, so arbitrary values are passed safely. Throws if the channel
  * name is empty or if either value contains a NUL byte.
  *
  * ```ts no_run
  * await db.notify('jobs', JSON.stringify({ id: 42 }));
  * ```
  */
  async notify(channel: string, payload = ''): Promise<void> {
    await this.exec(`NOTIFY ${quoteIdentifier(channel)}, ${quoteLiteral(payload)}`);
  }
  /**
  * Streams data into the server with `COPY ... FROM STDIN`.
  *
  * `query` must be a `COPY` statement that reads from `STDIN`. Chunks from
  * `source` (strings are UTF-8 encoded) are forwarded as `CopyData`
  * messages as they are produced, so large imports stream without
  * buffering the whole payload. If `source` throws, the copy is aborted
  * with `CopyFail` and the error is rethrown. Resolves with the server's
  * command tag and the number of rows copied.
  *
  * ```ts no_run
  * const result = await db.copyFrom('COPY users (name, age) FROM STDIN', [
  *   'Ada\t36\n',
  *   'Grace\t45\n'
  * ]);
  * console.log(result.changes); // 2
  * ```
  */
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
  /**
  * Runs `COPY ... TO STDOUT` and resolves with the raw data chunks.
  *
  * Chunks are collected in memory exactly as the server framed them; join
  * or decode them as needed. Throws with the server's error message if the
  * copy fails.
  *
  * ```ts no_run
  * const chunks = await db.copyTo('COPY users TO STDOUT');
  * const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
  * ```
  */
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
  /**
  * Asks the server to cancel this connection's in-flight query.
  *
  * Opens a separate plaintext connection to the same server and sends a
  * `CancelRequest` carrying the backend key received at startup, as the
  * protocol requires. Cancellation is best-effort: the server may already
  * have finished the query, and when it does cancel, the interrupted call
  * rejects with the server's cancellation error.
  */
  async cancel(): Promise<void> {
    const sock = await Socket.connect(await resolveSocketAddress(this.#target));
    const [, writer] = sock.split();
    await writer.write(encodeCancelRequest(this.#backendProcessId, this.#secretKey));
    await writer.flush();
    sock.close();
  }
  /**
  * Terminates the connection.
  *
  * Sends the protocol `Terminate` message on a best-effort basis and
  * closes the socket. Idempotent; after closing, `prepare()` throws.
  */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#writer.write(encodeTerminate());
      await this.#writer.flush();
    } catch {}
    this.#socket?.close();
  }
  /**
  * Closes the connection, enabling
  * `await using db = await PostgresDatabase.open(...)`.
  */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
/**
* A lazy pool of `PostgresDatabase` connections.
*
* Connections are opened on demand up to `max` (default 10) and kept for
* reuse after `release()`. When every connection is checked out, `connect()`
* queues until one is released. Idle connections are not health-checked or
* expired, so a connection that died while parked is handed out as-is and
* fails on first use.
*
* ```ts no_run
* import { PostgresPool } from 'fino:database/postgres';
*
* const pool = new PostgresPool('postgres://ada@localhost/app', { max: 4 });
* const users = await pool.run((db) => db.prepare('SELECT * FROM users').all());
* await pool.close();
* ```
*/
export class PostgresPool {
  readonly #target: string | URL | PostgresOptions;
  readonly #options: PostgresOptions;
  readonly #idle: PostgresDatabase[] = [];
  readonly #waiters: Array<{ resolve(db: PostgresDatabase): void; reject(err: Error): void }> = [];
  readonly #max: number;
  #total = 0;
  #closed = false;
  /**
  * Creates a pool for `target`, which accepts the same URL and option
  * forms as `PostgresDatabase.open`. No connection is opened until first
  * use; `options.max` caps concurrent connections (default 10).
  */
  constructor(target: string | URL | PostgresOptions, options: PostgresOptions & { max?: number } = {}) {
    this.#target = target;
    this.#options = options;
    this.#max = options.max ?? 10;
  }
  /**
  * Checks a connection out of the pool.
  *
  * Reuses an idle connection when one exists, opens a new one while under
  * the `max` cap, and otherwise waits until a connection is released.
  * Every successful `connect()` must be paired with `release()` — prefer
  * `run()` for automatic pairing. Throws if the pool is closed.
  */
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
  /**
  * Returns a connection to the pool.
  *
  * Hands the connection to the longest-waiting `connect()` caller if any,
  * otherwise parks it idle. If the pool has been closed, the connection is
  * closed instead.
  */
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
  /**
  * Acquires a connection, invokes `fn` with it, and releases it when `fn`
  * settles — the safe default for pooled queries.
  *
  * ```ts no_run
  * const row = await pool.run((db) => db.prepare('SELECT now() AS ts').get());
  * ```
  */
  async run<T>(fn: (db: PostgresDatabase) => Promise<T>): Promise<T> {
    const db = await this.connect();
    try {
      return await fn(db);
    } finally {
      this.release(db);
    }
  }
  /**
  * Closes the pool: closes every idle connection and rejects queued
  * `connect()` calls. Checked-out connections are not interrupted; they
  * are closed when released.
  */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#idle.splice(0).map((db) => db.close()));
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error('postgres pool is closed'));
    this.#total = 0;
  }
}
