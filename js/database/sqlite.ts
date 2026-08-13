/**
 * fino:database/sqlite — SQLite database access via system libsqlite3.
 *
 * SQLite C API reference: https://www.sqlite.org/c3ref/intro.html
 *
 * Uses dlopen to load the system-installed `libsqlite3`. The re-exported
 * `sqliteAvailable` flag reports whether those bindings loaded, so code that
 * may run without system SQLite can branch instead of catching. Release
 * coverage requires the library to be present; CI should set
 * `FINO_REQUIRE_SQLITE=1` when running SQLite tests so missing bindings fail
 * the lane instead of skipping it. All file I/O is routed through the realm's
 * FileSystem provider via a JS-implemented sqlite3_vfs, so virtual providers
 * (MemoryFileSystem, S3FileSystem, etc.) work transparently.
 *
 * The release baseline focuses on core connection, statement, transaction,
 * vector-helper, extension-loading, and VFS-backed file behavior. SQLite-native
 * behavior that is already available through SQL or PRAGMA, such as
 * `PRAGMA busy_timeout`, should be used directly. Node-style convenience APIs
 * for backup, serialize/deserialize, busy-timeout helpers, and broader
 * WAL/concurrency parity are outside this baseline.
 *
 * ## Supported SQLite C/VFS subset
 *
 * `Database` covers the core C API lifecycle used by this module:
 * open/close, prepare/step/finalize, parameter binding, column reads,
 * transactions through SQL, and trusted extension loading. It does not wrap
 * backup, serialization, or busy-timeout convenience APIs; use SQLite SQL,
 * PRAGMA statements, or native extensions for those features.
 *
 * Fino's JavaScript `sqlite3_vfs` implements the file operations SQLite needs
 * for normal database and journal I/O through the active `FileSystem` provider:
 * open, delete, access, full-pathname, read, write, truncate, sync, file size,
 * sector size, device characteristics, locking, unlock, reserved-lock checks,
 * randomness, sleep, current time, and last-error callbacks.
 *
 * Deterministic file controls are supported for lock state, size hints, chunk
 * size, file pointer, last errno, persistent WAL state, powersafe overwrite,
 * disabled mmap size, moved-file checks, lock timeout, and data version.
 * Unsupported controls such as VFS name/proxy hooks, PRAGMA interception,
 * temp-filename allocation, atomic write groups, size limits, reserve bytes,
 * external-reader, checksum-file, null-I/O, and filestat return
 * `SQLITE_NOTFOUND` so SQLite can use its normal fallback paths.
 *
 * Usage:
 * ```ts no_run
 *   import { Database } from 'fino:database/sqlite';
 *   const db = await Database.open('/path/to.db');
 *   await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
 *   const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
 *   await stmt.run(1n, 'hello');
 *   const rows = await db.prepare('SELECT * FROM t').all();
 *   await db.close();
 * ```
 */
import { Pointer } from 'fino:ffi';
import { DiskFileSystem } from 'fino:file';
import type { FileSystem } from 'internal:file/provider';
import {
  sqliteAvailable,
  requireSqlite,
  cstr,
  readCStr,
  dbErrMsg,
  SQLITE_OK,
  SQLITE_ROW,
  SQLITE_DONE,
  SQLITE_INTEGER,
  SQLITE_FLOAT,
  SQLITE3_TEXT,
  SQLITE_BLOB,
  SQLITE_NULL,
  SQLITE_OPEN_READONLY,
  SQLITE_OPEN_READWRITE,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_FULLMUTEX,
} from 'internal:database/sqlite/bindings';
import { FinoVFS } from 'internal:database/sqlite/vfs';
/**
 * `true` when the SQLite native bindings are available in this runtime.
 *
 * Check this before opening a database in code that may run without system
 * `libsqlite3`. SQLite operations call `requireSqlite()` internally and throw
 * when the bindings are unavailable.
 *
 * ```ts no_run
 * import { sqliteAvailable, Database } from 'fino:database/sqlite';
 *
 * if (sqliteAvailable) {
 *   const db = await Database.open(':memory:');
 *   await db.close();
 * }
 * ```
 */
export { sqliteAvailable };
// SQLITE_TRANSIENT = (sqlite3_destructor_type)(-1): tells sqlite to copy the value.
const _TRANSIENT = (() => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, 18446744073709551615n, true);
  return buf;
})();
// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
/**
 * Options for opening a SQLite database.
 *
 * Options control the filesystem provider, open mode, and INTEGER result
 * mapping for the connection. They are read once by `Database.open()`;
 * changing the object afterwards has no effect on the connection.
 *
 * ```ts no_run
 * import { Database } from 'fino:database/sqlite';
 *
 * const db = await Database.open('/data/app.db', {
 *   readonly: true,
 *   safeIntegers: false,
 * });
 * await db.close();
 * ```
 */
export interface DatabaseOptions {
  /**
   * FileSystem provider used by Fino's SQLite VFS.
   *
   * Defaults to a new `DiskFileSystem`. Supplying a custom provider lets SQLite
   * read and write through virtual filesystems — a database file, its journal,
   * and its WAL all flow through this provider rather than direct disk I/O.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   * import { DiskFileSystem } from 'fino:file';
   *
   * const db = await Database.open('/data/app.db', { fs: new DiskFileSystem() });
   * await db.close();
   * ```
   */
  fs?: FileSystem;
  /**
   * Open the database in read-only mode.
   *
   * The default is `false`, which opens read-write and creates the database if
   * needed. Read-only connections reject writes at SQLite level and fail when
   * the file does not exist.
   */
  readonly?: boolean;
  /**
   * Return INTEGER columns as `bigint` when true.
   *
   * The default is `true`. Set to `false` to coerce INTEGER results to
   * JavaScript `number`, accepting precision loss for values outside the safe
   * integer range. This does not affect `lastInsertRowid`, which is always a
   * `bigint`.
   */
  safeIntegers?: boolean;
}
// ---------------------------------------------------------------------------
// Type mapping helpers
// ---------------------------------------------------------------------------
/**
 * Values accepted for SQLite parameter binding and returned from result rows.
 *
 * `null` and `undefined` bind as SQL NULL. A whole `number` or a `bigint`
 * binds as INTEGER; fractional numbers bind as REAL. Strings bind as UTF-8
 * text, and `Uint8Array` binds as BLOB. Reads map back the same way: INTEGER
 * columns decode as `bigint` (or `number` when `safeIntegers` is `false`),
 * TEXT as string, BLOB as `Uint8Array`, and NULL as `null`.
 *
 * ```ts no_run
 * import { Database } from 'fino:database/sqlite';
 *
 * const db = await Database.open(':memory:');
 * await db.exec('CREATE TABLE t (id INTEGER, score REAL, name TEXT, data BLOB)');
 * await db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)')
 *   .run(1n, 0.5, 'ada', new Uint8Array([1, 2]));
 * await db.close();
 * ```
 */
export type SqlValue = null | undefined | bigint | number | string | Uint8Array;
function _readColumn(stmtPtr: ArrayBuffer, col: number, safeIntegers: boolean): SqlValue {
  const s = requireSqlite().symbols;
  const type = s.sqlite3_column_type(stmtPtr, col) as number;
  switch (type) {
    case SQLITE_NULL:
      return null;
    case SQLITE_INTEGER: {
      const v = s.sqlite3_column_int64(stmtPtr, col) as bigint;
      return safeIntegers ? v : Number(v);
    }
    case SQLITE_FLOAT:
      return s.sqlite3_column_double(stmtPtr, col) as number;
    case SQLITE3_TEXT: {
      const ptr = s.sqlite3_column_text(stmtPtr, col) as ArrayBuffer | null;
      return ptr ? readCStr(ptr) : '';
    }
    case SQLITE_BLOB: {
      const ptr = s.sqlite3_column_blob(stmtPtr, col) as ArrayBuffer | null;
      const bytes = s.sqlite3_column_bytes(stmtPtr, col) as number;
      if (!ptr || bytes === 0) return new Uint8Array(0);
      return Pointer.copyFrom(ptr, bytes) as Uint8Array;
    }
    default:
      return null;
  }
}
function _bindParam(stmtPtr: ArrayBuffer, idx: number, val: SqlValue): void {
  const s = requireSqlite().symbols;
  if (val === null || val === undefined) {
    s.sqlite3_bind_null(stmtPtr, idx);
  } else if (typeof val === 'bigint') {
    s.sqlite3_bind_int64(stmtPtr, idx, val);
  } else if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      s.sqlite3_bind_int64(stmtPtr, idx, BigInt(val));
    } else {
      s.sqlite3_bind_double(stmtPtr, idx, val);
    }
  } else if (typeof val === 'string') {
    const enc = cstr(val);
    // enc.length - 1: UTF-8 byte count without the null terminator cstr() appends.
    s.sqlite3_bind_text(stmtPtr, idx, Pointer.of(enc), enc.length - 1, _TRANSIENT);
  } else if (val instanceof Uint8Array) {
    s.sqlite3_bind_blob(stmtPtr, idx, Pointer.of(val), val.byteLength, _TRANSIENT);
  }
}
// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------
/**
 * Prepared SQLite statement with lazy compilation and typed row helpers.
 *
 * Statements are created by `Database.prepare()` and compile on first use.
 * Positional parameters are bound from rest arguments; pass one plain object to
 * bind named parameters without the leading `:`, `$`, or `@`. Call
 * `finalize()` when a reusable statement is no longer needed. Parameter
 * binding is strict: positional calls must provide exactly one value per bind
 * slot, and named-parameter objects must exactly cover the statement's named
 * parameters without extra keys.
 *
 * ```ts no_run
 * import { Database } from 'fino:database/sqlite';
 *
 * const db = await Database.open(':memory:');
 * await db.exec('CREATE TABLE users (id INTEGER, name TEXT)');
 * const stmt = db.prepare('INSERT INTO users VALUES (?, ?)');
 * await stmt.run(1n, 'Ada');
 * stmt.finalize();
 * await db.close();
 * ```
 */
export class Statement {
  /**
   * The owning connection. Every native call this statement makes is routed
   * through the connection's `_serialize()` queue so the `sqlite3*` handle is
   * never entered concurrently.
   *
   * @internal
   */
  readonly #db: Database;
  /**
   * SQL text captured at `prepare()` time. Compilation is deferred until the
   * first execution method runs, so syntax errors surface there rather than in
   * `prepare()`.
   *
   * @internal
   */
  readonly #sql: string;
  /**
   * Whether INTEGER columns decode as `bigint` rather than `number`. Inherited
   * from the connection's `safeIntegers` option when created via
   * `Database.prepare()`.
   *
   * @internal
   */
  readonly #safeIntegers: boolean;
  /**
   * Fino pointer buffer holding the compiled `sqlite3_stmt*`, or `null` before
   * first compilation. Set once by `#compile()` and freed by `finalize()`.
   *
   * @internal
   */
  #ptr: ArrayBuffer | null = null;
  /**
   * Set once by `finalize()`. Any later attempt to compile or execute throws
   * `Statement is finalized`.
   *
   * @internal
   */
  #finalized = false;
  /**
   * Cached result-column names, resolved on the first row read and reused for
   * every subsequent row this statement produces.
   *
   * @internal
   */
  #colNames: string[] | null = null;
  /**
   * Create a statement wrapper over `sql` for an open connection.
   *
   * Application code should normally call `Database.prepare()` instead of this
   * constructor so the statement inherits the database's integer mapping and is
   * tracked for cleanup at `close()`. `safeIntegers` controls whether INTEGER
   * columns are returned as `bigint`. Compilation remains lazy until the first
   * execution method is called.
   *
   * ```ts no_run
   * import { Database, Statement } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * const stmt = new Statement(db, 'SELECT 1 AS value', true);
   * console.log(await stmt.get());
   * stmt.finalize();
   * await db.close();
   * ```
   */
  constructor(db: Database, sql: string, safeIntegers: boolean) {
    this.#db = db;
    this.#sql = sql;
    this.#safeIntegers = safeIntegers;
  }
  /**
   * Compile the SQL with `sqlite3_prepare_v2` on first use, caching the
   * statement pointer for reuse. Throws `Statement is finalized` after
   * `finalize()`, and with the database error message when compilation fails.
   *
   * @internal
   */
  async #compile(): Promise<ArrayBuffer> {
    if (this.#finalized) throw new Error('Statement is finalized');
    if (this.#ptr) return this.#ptr;
    const s = requireSqlite().symbols;
    const sqlBuf = cstr(this.#sql);
    const ppStmt = new ArrayBuffer(8);
    const rc = (await s.sqlite3_prepare_v2(
      this.#db.ptr,
      sqlBuf,
      -1,
      Pointer.of(ppStmt),
      null,
    )) as number;
    if (rc !== SQLITE_OK) {
      throw new Error(`sqlite3_prepare_v2: ${dbErrMsg(this.#db.ptr)}`);
    }
    // ppStmt's backing store now contains the sqlite3_stmt* address (written by sqlite).
    // A fino pointer is an 8-byte ArrayBuffer with the address, so ppStmt IS the pointer.
    const addr = new DataView(ppStmt).getBigUint64(0, true);
    if (addr === 0n) throw new Error('sqlite3_prepare_v2: returned null statement');
    this.#ptr = ppStmt;
    return ppStmt;
  }
  /**
   * Result-column count for the compiled statement, via
   * `sqlite3_column_count`.
   *
   * @internal
   */
  #colCount(ptr: ArrayBuffer): number {
    return requireSqlite().symbols.sqlite3_column_count(ptr) as number;
  }
  /**
   * Resolve and cache the statement's column names. Columns without a name
   * fall back to their zero-based index as a string.
   *
   * @internal
   */
  #getColNames(ptr: ArrayBuffer): string[] {
    if (this.#colNames) return this.#colNames;
    const s = requireSqlite().symbols;
    const n = this.#colCount(ptr);
    this.#colNames = [];
    for (let i = 0; i < n; i++) {
      const p = s.sqlite3_column_name(ptr, i) as ArrayBuffer | null;
      this.#colNames.push(p ? readCStr(p) : String(i));
    }
    return this.#colNames;
  }
  /**
   * Materialize the row the statement is currently stopped on as a
   * column-name-keyed record, applying this statement's integer mapping.
   *
   * @internal
   */
  #readRow(ptr: ArrayBuffer): Record<string, SqlValue> {
    const names = this.#getColNames(ptr);
    const row: Record<string, SqlValue> = {};
    for (let i = 0; i < names.length; i++) {
      row[names[i]!] = _readColumn(ptr, i, this.#safeIntegers);
    }
    return row;
  }
  /**
   * Reset the statement, clear old bindings, and bind positional parameters.
   * Throws when the value count does not exactly match the statement's bind
   * slot count.
   *
   * @internal
   */
  #bindArgs(ptr: ArrayBuffer, params: SqlValue[]): void {
    const s = requireSqlite().symbols;
    const count = s.sqlite3_bind_parameter_count(ptr) as number;
    if (params.length !== count) {
      throw new Error(
        `sqlite parameter binding: expected ${count} positional parameters, got ${params.length}`,
      );
    }
    s.sqlite3_reset(ptr);
    s.sqlite3_clear_bindings(ptr);
    for (let i = 0; i < params.length; i++) {
      _bindParam(ptr, i + 1, params[i]);
    }
  }
  /**
   * Bind a named-parameter object. Validation is strict: the statement may not
   * mix in anonymous `?` slots, and the object's keys (without the `:`/`$`/`@`
   * prefix) must exactly cover the statement's named parameters — a missing or
   * extra key throws before anything is bound.
   *
   * @internal
   */
  #bindNamed(ptr: ArrayBuffer, params: Record<string, SqlValue>): void {
    const s = requireSqlite().symbols;
    const count = s.sqlite3_bind_parameter_count(ptr) as number;
    const expected = new Set<string>();
    let anonymousCount = 0;
    for (let i = 1; i <= count; i++) {
      const namPtr = s.sqlite3_bind_parameter_name(ptr, i) as ArrayBuffer | null;
      if (!namPtr) {
        anonymousCount++;
        continue;
      }
      expected.add(readCStr(namPtr).replace(/^[:$@]/, ''));
    }
    if (anonymousCount > 0) {
      throw new Error(
        'sqlite parameter binding: named parameter object cannot bind anonymous positional parameters',
      );
    }
    const actual = Object.keys(params);
    for (const name of expected) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`sqlite parameter binding: missing named parameter '${name}'`);
      }
    }
    for (const name of actual) {
      if (!expected.has(name)) {
        throw new Error(`sqlite parameter binding: extra named parameter '${name}'`);
      }
    }
    s.sqlite3_reset(ptr);
    s.sqlite3_clear_bindings(ptr);
    for (let i = 1; i <= count; i++) {
      const namPtr = s.sqlite3_bind_parameter_name(ptr, i) as ArrayBuffer | null;
      if (!namPtr) continue;
      const name = readCStr(namPtr).replace(/^[:$@]/, '');
      _bindParam(ptr, i, params[name]!);
    }
  }
  /**
   * Choose the binding mode: a single plain-object argument (not `null` and
   * not a `Uint8Array`) binds named parameters; anything else binds
   * positionally.
   *
   * @internal
   */
  #resolveParams(ptr: ArrayBuffer, params: SqlValue[]): void {
    if (
      params.length === 1 &&
      params[0] !== null &&
      params[0] !== undefined &&
      typeof params[0] === 'object' &&
      !(params[0] instanceof Uint8Array)
    ) {
      this.#bindNamed(ptr, params[0] as Record<string, SqlValue>);
    } else {
      this.#bindArgs(ptr, params);
    }
  }
  /**
   * Execute the statement and return write metadata.
   *
   * Parameters may be positional values or one named-parameter object. The
   * statement is reset after execution. Parameter counts are validated before
   * binding. SQL errors reject with the database error message. Result rows,
   * if any, are discarded; the resolved object carries the connection's change
   * count and last insert rowid.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.exec('CREATE TABLE t (name TEXT)');
   * const result = await db.prepare('INSERT INTO t VALUES (?)').run('hello');
   * console.log(result.changes, result.lastInsertRowid);
   * await db.close();
   * ```
   */
  run(...params: SqlValue[]): Promise<{
    changes: number;
    lastInsertRowid: bigint;
  }> {
    return this.#db._serialize(async () => {
      const ptr = await this.#compile();
      this.#resolveParams(ptr, params);
      const s = requireSqlite().symbols;
      const rc = (await s.sqlite3_step(ptr)) as number;
      s.sqlite3_reset(ptr);
      if (rc !== SQLITE_DONE && rc !== SQLITE_ROW) {
        throw new Error(`sqlite3: step failed: ${dbErrMsg(this.#db.ptr)}`);
      }
      return {
        changes: s.sqlite3_changes(this.#db.ptr) as number,
        lastInsertRowid: s.sqlite3_last_insert_rowid(this.#db.ptr) as bigint,
      };
    });
  }
  /**
   * Execute and return the first row.
   *
   * Returns `undefined` when the query produces no rows. Column names are used
   * as object keys. Parameter counts are validated before binding. The
   * statement is reset before returning or throwing.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * const row = await db.prepare('SELECT 42 AS answer').get();
   * console.log(row?.answer);
   * await db.close();
   * ```
   */
  get(...params: SqlValue[]): Promise<Record<string, SqlValue> | undefined> {
    return this.#db._serialize(async () => {
      const ptr = await this.#compile();
      this.#resolveParams(ptr, params);
      const s = requireSqlite().symbols;
      const rc = (await s.sqlite3_step(ptr)) as number;
      if (rc === SQLITE_ROW) {
        const row = this.#readRow(ptr);
        s.sqlite3_reset(ptr);
        return row;
      }
      s.sqlite3_reset(ptr);
      if (rc !== SQLITE_DONE) {
        throw new Error(`sqlite3: step failed: ${dbErrMsg(this.#db.ptr)}`);
      }
      return undefined;
    });
  }
  /**
   * Execute and return all rows.
   *
   * This buffers every result row in memory. Use `iterate()` for large result
   * sets. Parameter counts are validated before binding. The statement is
   * reset before returning or throwing, and rows resolve in result order.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * const rows = await db.prepare('SELECT 1 AS n UNION ALL SELECT 2').all();
   * console.log(rows.length);
   * await db.close();
   * ```
   */
  all(...params: SqlValue[]): Promise<Record<string, SqlValue>[]> {
    return this.#db._serialize(async () => {
      const ptr = await this.#compile();
      this.#resolveParams(ptr, params);
      const s = requireSqlite().symbols;
      const rows: Record<string, SqlValue>[] = [];
      while (true) {
        const rc = (await s.sqlite3_step(ptr)) as number;
        if (rc === SQLITE_ROW) {
          rows.push(this.#readRow(ptr));
          continue;
        }
        if (rc === SQLITE_DONE) {
          break;
        }
        s.sqlite3_reset(ptr);
        throw new Error(`sqlite3: step failed: ${dbErrMsg(this.#db.ptr)}`);
      }
      s.sqlite3_reset(ptr);
      return rows;
    });
  }
  /**
   * Async-iterate rows one at a time.
   *
   * The statement remains active for the duration of iteration and is reset in
   * a `finally` block when iteration finishes, throws, or is abandoned early.
   * Parameter counts are validated before binding. Each step is serialized on
   * the connection individually, so other operations on the same connection
   * may interleave between rows.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * for await (const row of db.prepare('SELECT 1 AS n').iterate()) {
   *   console.log(row.n);
   * }
   * await db.close();
   * ```
   */
  async *iterate(...params: SqlValue[]): AsyncGenerator<Record<string, SqlValue>> {
    // Serialize per step (not the whole iteration) so consumers may run other
    // operations on this connection between rows; multiple active statements
    // are legal as long as native calls never overlap.
    const ptr = await this.#db._serialize(async () => {
      const compiled = await this.#compile();
      this.#resolveParams(compiled, params);
      return compiled;
    });
    const s = requireSqlite().symbols;
    try {
      while (true) {
        const step = await this.#db._serialize(async () => {
          const rc = (await s.sqlite3_step(ptr)) as number;
          if (rc === SQLITE_ROW) {
            return {
              rc,
              row: this.#readRow(ptr),
            };
          }
          return { rc };
        });
        if (step.rc === SQLITE_ROW) {
          yield step.row!;
          continue;
        }
        if (step.rc === SQLITE_DONE) {
          break;
        }
        throw new Error(`sqlite3: step failed: ${dbErrMsg(this.#db.ptr)}`);
      }
    } finally {
      s.sqlite3_reset(ptr);
    }
  }
  /**
   * Finalize and free this statement.
   *
   * Calling `finalize()` more than once is allowed. Any later execution method
   * throws `Statement is finalized`.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * const stmt = db.prepare('SELECT 1');
   * stmt.finalize();
   * await db.close();
   * ```
   */
  finalize(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.#ptr) requireSqlite().symbols.sqlite3_finalize(this.#ptr);
    this.#db._untrackStatement(this);
  }
  /**
   * Alias for `finalize()`, letting a statement participate in `using`
   * declarations for automatic cleanup at scope exit.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * {
   *   using stmt = db.prepare('SELECT 1 AS n');
   *   console.log(await stmt.get());
   * } // stmt.finalize() runs here
   * await db.close();
   * ```
   */
  [Symbol.dispose](): void {
    this.finalize();
  }
}
// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
/**
 * SQLite database connection backed by Fino's SQLite VFS.
 *
 * Open connections with `Database.open()`. The connection owns a native
 * `sqlite3*` pointer and a per-connection VFS registration; call `close()` when
 * finished. Close finalizes any statements that were not explicitly finalized.
 * Methods throw after the connection has been closed.
 *
 * ```ts no_run
 * import { Database } from 'fino:database/sqlite';
 *
 * const db = await Database.open(':memory:');
 * await db.exec('CREATE TABLE t (value TEXT)');
 * await db.close();
 * ```
 */
export class Database {
  /**
   * Fino pointer buffer holding the native `sqlite3*` handle, written by
   * `sqlite3_open_v2` and invalidated by `close()`.
   *
   * @internal
   */
  readonly #ptr: ArrayBuffer;
  /**
   * This connection's private `FinoVFS` registration, which routes SQLite file
   * I/O through the configured FileSystem provider. Unregistered during
   * `close()`.
   *
   * @internal
   */
  readonly #vfs: FinoVFS | null;
  /**
   * Connection-wide INTEGER mapping from `DatabaseOptions.safeIntegers`,
   * inherited by every statement this connection prepares.
   *
   * @internal
   */
  readonly #safeIntegers: boolean;
  /**
   * Set once by `close()`. Methods guarded by `#checkOpen()` throw
   * `Database is closed` afterwards.
   *
   * @internal
   */
  #closed = false;
  /**
   * Cached result of the sqlite-vec probe. `null` until `vectorsAvailable` is
   * first read; the probe result (including failure) is cached for the life of
   * the connection.
   *
   * @internal
   */
  #vectorsAvailable: boolean | null = null;
  /**
   * Live statements created by `prepare()` that have not been finalized.
   * `close()` finalizes everything left in this set before closing the native
   * handle; `Statement.finalize()` removes itself via `_untrackStatement()`.
   */
  #statements = new Set<Statement>();
  /**
   * Tail of the per-connection operation queue.
   *
   * Statement stepping is offloaded to the blocking thread pool, and a
   * `sqlite3*` connection must never be entered from two threads at once (nor
   * may its JS VFS callbacks trampoline concurrently), so every async native
   * call on this connection runs strictly after the previous one.
   *
   * @internal
   */
  #opQueue: Promise<unknown> = Promise.resolve();
  #txQueue: Promise<unknown> = Promise.resolve();
  /**
   * Wrap an already-open `sqlite3*` handle and its VFS registration. Private:
   * connections are only created through `Database.open()`, which performs the
   * VFS setup and open-flag handling this constructor assumes has succeeded.
   *
   * @internal
   */
  private constructor(ptr: ArrayBuffer, vfs: FinoVFS | null, safeIntegers: boolean) {
    this.#ptr = ptr;
    this.#vfs = vfs;
    this.#safeIntegers = safeIntegers;
  }
  /**
   * Internal sqlite3 pointer for statement helpers.
   *
   * This getter exposes the native pointer wrapper used by this module. It is
   * public for `Statement` integration but is not needed by normal application
   * code. The value is a Fino pointer buffer containing the `sqlite3*` address
   * and becomes invalid after `close()`.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * console.log(db.ptr.byteLength);
   * await db.close();
   * ```
   */
  get ptr(): ArrayBuffer {
    return this.#ptr;
  }
  /**
   * Open a database at `path`. Use `':memory:'` for an in-memory database.
   * Pass `{ fs }` to route I/O through a custom FileSystem provider.
   *
   * By default, the database opens read-write and is created if missing.
   * `{ readonly: true }` opens read-only. Each connection registers a private
   * Fino VFS name so file operations go through the chosen filesystem provider.
   * Throws when SQLite is unavailable, open fails, or VFS registration fails.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:', { safeIntegers: true });
   * await db.close();
   * ```
   */
  static async open(path: string, opts: DatabaseOptions = {}): Promise<Database> {
    const s = requireSqlite().symbols;
    const fs = opts.fs ?? new DiskFileSystem();
    // Per-database VFS with a unique name so multiple open databases don't collide.
    const vfsName = `fino-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const vfs = new FinoVFS(fs as FileSystem, vfsName);
    vfs.register(false);
    const pathBuf = cstr(path);
    const ppDb = new ArrayBuffer(8);
    // FULLMUTEX (serialized) mode: connection calls hop across blocking-pool
    // threads, and although the per-connection queue prevents overlap, the
    // connection-internal mutex is cheap insurance against any unqueued path.
    let flags = SQLITE_OPEN_FULLMUTEX;
    if (opts.readonly) {
      flags |= SQLITE_OPEN_READONLY;
    } else {
      flags |= SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    }
    const rc = (await s.sqlite3_open_v2(
      pathBuf,
      Pointer.of(ppDb),
      flags,
      vfs.nameCstrPointer,
    )) as number;
    // After the call, ppDb's backing store contains the sqlite3* address.
    // A fino pointer is an 8-byte ArrayBuffer with the address, so ppDb IS the db pointer.
    const dbAddr = new DataView(ppDb).getBigUint64(0, true);
    if (rc !== SQLITE_OK) {
      const msg = dbAddr !== 0n ? dbErrMsg(ppDb) : `error code ${rc}`;
      if (dbAddr !== 0n) await s.sqlite3_close_v2(ppDb);
      vfs.unregister();
      throw new Error(`sqlite3_open_v2: ${msg}`);
    }
    return new Database(ppDb, vfs, opts.safeIntegers ?? true);
  }
  /**
   * Execute one or more SQL statements with no result rows.
   *
   * This uses `sqlite3_exec()` and is best for schema setup, pragmas, and
   * simple SQL batches. Use `prepare()` for parameter binding or reading result
   * rows. Treat this as a trusted-SQL-only API: never concatenate untrusted
   * user input into `exec()` strings. Throws on SQL errors or when the database
   * is closed.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
   * await db.close();
   * ```
   */
  exec(sql: string): Promise<void> {
    this.#checkOpen();
    return this._serialize(async () => {
      const s = requireSqlite().symbols;
      const sqlBuf = cstr(sql);
      const rc = (await s.sqlite3_exec(this.#ptr, sqlBuf, null, null, null)) as number;
      void sqlBuf;
      if (rc !== SQLITE_OK) {
        throw new Error(`sqlite3_exec: ${dbErrMsg(this.#ptr)}`);
      }
    });
  }
  /**
   * Compile a SQL statement and return a reusable Statement.
   * Compilation is lazy — it happens on the first `.run/.get/.all/.iterate` call.
   *
   * Throws immediately if the database is closed. SQL syntax errors are thrown
   * later when the statement first compiles.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * const stmt = db.prepare('SELECT ? AS value');
   * console.log(await stmt.get(123));
   * stmt.finalize();
   * await db.close();
   * ```
   */
  prepare(sql: string): Statement {
    this.#checkOpen();
    const stmt = new Statement(this, sql, this.#safeIntegers ?? true);
    this.#statements.add(stmt);
    return stmt;
  }
  /**
   * Run `fn` strictly after every previously queued operation on this
   * connection.
   *
   * Async native sqlite calls execute on blocking-pool threads, and a
   * connection (and its JS VFS trampoline) must never be entered concurrently
   * — statement wrappers route every step/compile through this queue. Resolves
   * or rejects with `fn`'s own outcome; a rejected predecessor does not block
   * the queue.
   *
   * @internal
   */
  _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#opQueue.then(fn, fn);
    this.#opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /**
   * Stop tracking a statement that has been explicitly finalized.
   *
   * Statement wrappers call this during `finalize()` so `close()` only has to
   * finalize wrappers that still own native statement pointers.
   *
   * @internal
   */
  _untrackStatement(stmt: Statement): void {
    this.#statements.delete(stmt);
  }
  /**
   * Run `fn` inside a BEGIN/COMMIT transaction. Rolls back on throw.
   *
   * The transaction starts with `BEGIN`, commits if `fn` resolves, and attempts
   * `ROLLBACK` if `fn` throws, then rethrows `fn`'s error. The resolved value
   * is whatever `fn` returned. Nested transaction behavior depends on SQLite
   * and the SQL executed by `fn`; this helper does not create savepoints.
   *
   * Concurrent callers queue: a connection has exactly one transaction, so
   * overlapping them would fail the second `BEGIN` — and worse, one caller's
   * rollback would discard the other's writes. Callers that share a
   * connection across independent tasks therefore serialize here rather than
   * racing.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.exec('CREATE TABLE t (value TEXT)');
   * await db.transaction(async () => {
   *   await db.prepare('INSERT INTO t VALUES (?)').run('ok');
   * });
   * await db.close();
   * ```
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#checkOpen();
    // Queued on #txQueue rather than the statement queue: the body issues
    // statements of its own, which would deadlock against their own gate.
    const run = this.#txQueue.then(
      () => this.#runTransaction(fn),
      () => this.#runTransaction(fn),
    );
    this.#txQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  async #runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#checkOpen();
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
   * Whether the current sqlite build supports extension loading and sqlite-vec
   * was found. Probed lazily on first access.
   *
   * The probe tries `FINO_SQLITE_VEC_PATH` first when present, then common
   * platform paths, and returns `true` only when sqlite-vec actually loaded.
   * A failed probe caches `false`. Access may enable extension loading on the
   * connection.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * console.log(db.vectorsAvailable);
   * await db.close();
   * ```
   */
  get vectorsAvailable(): boolean {
    this.#checkOpen();
    if (this.#vectorsAvailable !== null) return this.#vectorsAvailable;
    this.#vectorsAvailable = this.#probeVectors();
    return this.#vectorsAvailable;
  }
  /**
   * Probe for sqlite-vec: enable extension loading, then attempt to load from
   * `FINO_SQLITE_VEC_PATH` followed by common install paths. Absolute
   * candidates are stat-checked before the load attempt; relative candidates
   * are only tried when they came from the environment variable.
   *
   * @internal
   */
  #probeVectors(): boolean {
    const s = requireSqlite().symbols;
    const rc = s.sqlite3_enable_load_extension(this.#ptr, 1) as number;
    if (rc !== SQLITE_OK) return false;
    const candidates = [
      '/opt/homebrew/lib/sqlite-vec.dylib',
      '/usr/local/lib/sqlite-vec.dylib',
      '/usr/lib/sqlite-vec.so',
      'vec0.so',
    ];
    const envPath =
      typeof process !== 'undefined'
        ? (
            process as {
              env?: Record<string, string>;
            }
          ).env?.['FINO_SQLITE_VEC_PATH']
        : undefined;
    if (envPath) candidates.unshift(envPath);
    const ppErr = new ArrayBuffer(8);
    for (const p of candidates) {
      try {
        if (p.startsWith('/')) {
          try {
            const fs = new DiskFileSystem();
            fs.statSync(p);
          } catch {
            continue;
          }
        } else if (!envPath || p !== envPath) {
          continue;
        }
        const rc2 = s.sqlite3_load_extension(
          this.#ptr,
          Pointer.of(cstr(p)),
          null,
          Pointer.of(ppErr),
        ) as number;
        if (rc2 === SQLITE_OK) return true;
      } catch {}
    }
    return false;
  }
  /**
   * Load a SQLite extension from `path`. Requires a SQLite build with
   * extension loading enabled (e.g. Homebrew sqlite on macOS).
   *
   * Loading an extension executes native code inside the current process. Only
   * load trusted extension libraries from trusted paths.
   *
   * The optional `entryPoint` symbol is passed through to
   * `sqlite3_load_extension`. Throws when an absolute `path` does not exist,
   * with SQLite's extension error message when loading fails, and if the
   * database is closed.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * db.loadExtension('/usr/local/lib/sqlite-vec.dylib');
   * await db.close();
   * ```
   */
  loadExtension(path: string, entryPoint?: string): void {
    this.#checkOpen();
    if (path.startsWith('/')) {
      try {
        const fs = new DiskFileSystem();
        fs.statSync(path);
      } catch {
        throw new Error(`sqlite3_load_extension: extension not found: ${path}`);
      }
    }
    const s = requireSqlite().symbols;
    const ppErr = new ArrayBuffer(8);
    s.sqlite3_enable_load_extension(this.#ptr, 1);
    const rc = s.sqlite3_load_extension(
      this.#ptr,
      Pointer.of(cstr(path)),
      entryPoint ? Pointer.of(cstr(entryPoint)) : null,
      Pointer.of(ppErr),
    ) as number;
    if (rc !== SQLITE_OK) {
      const errAddr = new DataView(ppErr).getBigUint64(0, true);
      const msg = errAddr !== 0n ? readCStr(ppErr) : `error ${rc}`;
      requireSqlite().symbols.sqlite3_free(ppErr);
      throw new Error(`sqlite3_load_extension: ${msg}`);
    }
  }
  /**
   * Number of rows changed by the most recent DML statement.
   *
   * This mirrors `sqlite3_changes()` for the connection. It is meaningful after
   * INSERT, UPDATE, DELETE, and similar statements. It throws only if SQLite
   * bindings are unavailable.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.exec('CREATE TABLE t (value TEXT)');
   * await db.prepare('INSERT INTO t VALUES (?)').run('x');
   * console.log(db.changes);
   * await db.close();
   * ```
   */
  get changes(): number {
    return requireSqlite().symbols.sqlite3_changes(this.#ptr) as number;
  }
  /**
   * Row ID of the most recent INSERT.
   *
   * This mirrors `sqlite3_last_insert_rowid()` and returns a `bigint`
   * regardless of `safeIntegers`, because rowids may exceed JavaScript's safe
   * integer range.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
   * await db.prepare('INSERT INTO t DEFAULT VALUES').run();
   * console.log(db.lastInsertRowid);
   * await db.close();
   * ```
   */
  get lastInsertRowid(): bigint {
    return requireSqlite().symbols.sqlite3_last_insert_rowid(this.#ptr) as bigint;
  }
  /**
   * Close the database and unregister the VFS.
   *
   * Calling `close()` more than once is allowed. The close runs after any
   * in-flight queued operations, and any statements created by this connection
   * are finalized before the native database handle is closed.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.close();
   * ```
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this._serialize(async () => {
      for (const stmt of Array.from(this.#statements)) stmt.finalize();
      this.#statements.clear();
      await requireSqlite().symbols.sqlite3_close_v2(this.#ptr);
      if (this.#vfs) this.#vfs.unregister();
    });
  }
  /**
   * Alias for `close()`, letting a connection participate in `await using`
   * declarations for automatic cleanup at scope exit.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * {
   *   await using db = await Database.open(':memory:');
   *   await db.exec('CREATE TABLE t (value TEXT)');
   * } // db.close() runs here
   * ```
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
   * Throws `Database is closed` once `close()` has been called.
   *
   * @internal
   */
  #checkOpen(): void {
    if (this.#closed) throw new Error('Database is closed');
  }
}
// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------
/**
 * Encode a Float32Array or number[] as the `'[x,y,z]'` text literal that
 * sqlite-vec's vec0 virtual table expects in INSERT and MATCH expressions.
 *
 * The returned string is not SQL-escaped; bind it as a parameter or use it only
 * where sqlite-vec expects a vector literal. Numbers are converted through
 * `Float32Array` when the input is a regular array, so values round to float32
 * precision.
 *
 * ```ts no_run
 * import { Database, vec } from 'fino:database/sqlite';
 *
 * const db = await Database.open(':memory:');
 * await db.exec('CREATE VIRTUAL TABLE docs USING vec0(embedding float[3])');
 * await db.prepare('INSERT INTO docs (rowid, embedding) VALUES (?, ?)')
 *   .run(1n, vec([0.1, 0.2, 0.3]));
 * await db.close();
 * ```
 */
export function vec(arr: Float32Array | number[]): string {
  const a = arr instanceof Float32Array ? arr : new Float32Array(arr);
  return '[' + Array.from(a).join(',') + ']';
}
/**
 * Decode a sqlite-vec BLOB column back to a Float32Array.
 * sqlite-vec stores vectors as little-endian float32 blobs.
 *
 * The returned array views a sliced copy of the input buffer, so it is aligned
 * for `Float32Array` use and independent of the original byte offset. Invalid
 * byte lengths that are not multiples of four follow `Float32Array`
 * construction rules and may throw.
 *
 * ```ts no_run
 * import { vecDecode } from 'fino:database/sqlite';
 *
 * const bytes = new Uint8Array(new Float32Array([1, 2]).buffer);
 * const vector = vecDecode(bytes);
 * console.log(vector[0]);
 * ```
 */
export function vecDecode(blob: Uint8Array): Float32Array {
  const buf = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(buf);
}
