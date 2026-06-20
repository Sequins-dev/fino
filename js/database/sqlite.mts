/**
 * fino:database/sqlite — SQLite database access via system libsqlite3.
 *
 * Uses dlopen to load the system-installed libsqlite3. All file I/O is
 * routed through the realm's FileSystem provider via a JS-implemented
 * sqlite3_vfs, so virtual providers (MemoryFileSystem, S3FileSystem, etc.)
 * work transparently.
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
  sqliteAvailable, requireSqlite, cstr, readCStr, dbErrMsg,
  SQLITE_OK, SQLITE_ROW, SQLITE_DONE,
  SQLITE_INTEGER, SQLITE_FLOAT, SQLITE3_TEXT, SQLITE_BLOB, SQLITE_NULL,
  SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE,
  SQLITE_OPEN_NOMUTEX,
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
  new DataView(buf).setBigUint64(0, 0xFFFFFFFFFFFFFFFFn, true);
  return buf;
})();

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for opening a SQLite database.
 *
 * Options control the filesystem provider, open mode, and INTEGER result
 * mapping for the connection. They are read once by `Database.open()`.
 *
 * ```ts no_run
 * const options = { readonly: true, safeIntegers: true };
 * console.log(options.readonly);
 * ```
 */
export interface DatabaseOptions {
  /**
   * FileSystem provider used by Fino's SQLite VFS.
   *
   * Defaults to a new `DiskFileSystem`. Supplying a custom provider lets SQLite
   * read and write through virtual filesystems.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const options = { fs: new DiskFileSystem() };
   * console.log(options.fs);
   * ```
   */
  fs?: FileSystem;
  /**
   * Open the database in read-only mode.
   *
   * The default is `false`, which opens read-write and creates the database if
   * needed. Read-only connections reject writes at SQLite level and fail when
   * the file does not exist.
   *
   * ```ts no_run
   * const options = { readonly: true };
   * console.log(options.readonly);
   * ```
   */
  readonly?: boolean;
  /**
   * Return INTEGER columns as `bigint` when true.
   *
   * The default is `true`. Set to `false` to coerce INTEGER results to
   * JavaScript `number`, accepting precision loss for values outside the safe
   * integer range.
   *
   * ```ts no_run
   * const options = { safeIntegers: false };
   * console.log(options.safeIntegers);
   * ```
   */
  safeIntegers?: boolean;
}

// ---------------------------------------------------------------------------
// Type mapping helpers
// ---------------------------------------------------------------------------

/**
 * Values accepted for SQLite parameter binding and returned from result rows.
 *
 * `null` and `undefined` bind as SQL NULL. Integers may be bound as `number`
 * or `bigint`; floating-point numbers bind as REAL. Strings bind as UTF-8
 * text, and `Uint8Array` binds as BLOB.
 *
 * ```ts no_run
 * const params = [1n, 'name', null, new Uint8Array([1, 2])];
 * console.log(params.length);
 * ```
 */
export type SqlValue = null | undefined | bigint | number | string | Uint8Array;

function _readColumn(stmtPtr: ArrayBuffer, col: number, safeIntegers: boolean): SqlValue {
  const s    = requireSqlite().symbols;
  const type = s.sqlite3_column_type(stmtPtr, col) as number;
  switch (type) {
    case SQLITE_NULL:    return null;
    case SQLITE_INTEGER: {
      const v = s.sqlite3_column_int64(stmtPtr, col) as bigint;
      return safeIntegers ? v : Number(v);
    }
    case SQLITE_FLOAT:   return s.sqlite3_column_double(stmtPtr, col) as number;
    case SQLITE3_TEXT: {
      const ptr = s.sqlite3_column_text(stmtPtr, col) as ArrayBuffer | null;
      return ptr ? readCStr(ptr) : '';
    }
    case SQLITE_BLOB: {
      const ptr   = s.sqlite3_column_blob(stmtPtr, col) as ArrayBuffer | null;
      const bytes = s.sqlite3_column_bytes(stmtPtr, col) as number;
      if (!ptr || bytes === 0) return new Uint8Array(0);
      return Pointer.copyFrom(ptr, bytes) as Uint8Array;
    }
    default: return null;
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
   * Private readonly property `#db` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #db = undefined;
   *
   *   readInternalState() {
   *     return this.#db;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #db: Database;
  /**
   * Private readonly property `#sql` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #sql = undefined;
   *
   *   readInternalState() {
   *     return this.#sql;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #sql: string;
  /**
   * Private readonly property `#safeIntegers` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #safeIntegers = undefined;
   *
   *   readInternalState() {
   *     return this.#safeIntegers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #safeIntegers: boolean;
  /**
   * Private property `#ptr` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ptr = undefined;
   *
   *   readInternalState() {
   *     return this.#ptr;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ptr: ArrayBuffer | null = null;  // null until first use (lazy compile)
  /**
   * Private property `#finalized` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #finalized = undefined;
   *
   *   readInternalState() {
   *     return this.#finalized;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #finalized = false;
  /**
   * Private property `#colNames` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #colNames = undefined;
   *
   *   readInternalState() {
   *     return this.#colNames;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #colNames: string[] | null = null;

  /**
   * Create a statement wrapper.
   *
   * Application code should normally call `Database.prepare()` instead of this
   * constructor so the statement inherits the database's integer mapping.
   * Compilation remains lazy until the first execution method is called.
   *
   * @param {Database} db Open database connection.
   * @param {string} sql SQL text to prepare.
   * @param {boolean} safeIntegers Whether INTEGER columns should be returned as `bigint`.
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
    this.#db           = db;
    this.#sql          = sql;
    this.#safeIntegers = safeIntegers;
  }

  /**
   * Private method `#compile` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #compile() {
   *     return 'compile';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#compile();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #compile(): Promise<ArrayBuffer> {
    if (this.#finalized) throw new Error('Statement is finalized');
    if (this.#ptr) return this.#ptr;

    const s      = requireSqlite().symbols;
    const sqlBuf = cstr(this.#sql);
    const ppStmt = new ArrayBuffer(8);

    const rc = await s.sqlite3_prepare_v2(
      this.#db.ptr,
      sqlBuf,
      -1,
      Pointer.of(ppStmt),
      null,
    ) as number;

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
   * Private method `#colCount` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #colCount() {
   *     return 'colCount';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#colCount();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #colCount(ptr: ArrayBuffer): number {
    return requireSqlite().symbols.sqlite3_column_count(ptr) as number;
  }

  /**
   * Private method `#getColNames` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #getColNames() {
   *     return 'getColNames';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#getColNames();
   *   }
   * }
   * ```
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
   * Private method `#readRow` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readRow() {
   *     return 'readRow';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#readRow();
   *   }
   * }
   * ```
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
   * Private method `#bindArgs` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bindArgs() {
   *     return 'bindArgs';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#bindArgs();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bindArgs(ptr: ArrayBuffer, params: SqlValue[]): void {
    const s = requireSqlite().symbols;
    const count = s.sqlite3_bind_parameter_count(ptr) as number;
    if (params.length !== count) {
      throw new Error(`sqlite parameter binding: expected ${count} positional parameters, got ${params.length}`);
    }
    s.sqlite3_reset(ptr);
    s.sqlite3_clear_bindings(ptr);
    for (let i = 0; i < params.length; i++) {
      _bindParam(ptr, i + 1, params[i]);
    }
  }

  /**
   * Private method `#bindNamed` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bindNamed() {
   *     return 'bindNamed';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#bindNamed();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bindNamed(ptr: ArrayBuffer, params: Record<string, SqlValue>): void {
    const s     = requireSqlite().symbols;
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
      throw new Error('sqlite parameter binding: named parameter object cannot bind anonymous positional parameters');
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
   * Private method `#resolveParams` used by `Statement`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #resolveParams() {
   *     return 'resolveParams';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#resolveParams();
   *   }
   * }
   * ```
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
   * if any, are not returned by this method.
   *
   * @param {...SqlValue} params Positional values, or one named parameter object.
   * @returns {Promise<{ changes: number; lastInsertRowid: bigint }>} Change count and last insert rowid.
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
  async run(...params: SqlValue[]): Promise<{ changes: number; lastInsertRowid: bigint }> {
    const ptr = await this.#compile();
    this.#resolveParams(ptr, params);
    const s  = requireSqlite().symbols;
    const rc = await s.sqlite3_step(ptr) as number;
    s.sqlite3_reset(ptr);
    if (rc !== SQLITE_DONE && rc !== SQLITE_ROW) {
      throw new Error(`sqlite3: step failed: ${dbErrMsg(this.#db.ptr)}`);
    }
    return {
      changes:         s.sqlite3_changes(this.#db.ptr) as number,
      lastInsertRowid: s.sqlite3_last_insert_rowid(this.#db.ptr) as bigint,
    };
  }

  /**
   * Execute and return the first row.
   *
   * Returns `undefined` when the query produces no rows. Column names are used
   * as object keys. Parameter counts are validated before binding. The
   * statement is reset before returning or throwing.
   *
   * @param {...SqlValue} params Positional values, or one named parameter object.
   * @returns {Promise<Record<string, SqlValue> | undefined>} First row, or `undefined`.
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
  async get(...params: SqlValue[]): Promise<Record<string, SqlValue> | undefined> {
    const ptr = await this.#compile();
    this.#resolveParams(ptr, params);
    const s  = requireSqlite().symbols;
    const rc = await s.sqlite3_step(ptr) as number;
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
  }

  /**
   * Execute and return all rows.
   *
   * This buffers every result row in memory. Use `iterate()` for large result
   * sets. Parameter counts are validated before binding. The statement is
   * reset before returning or throwing.
   *
   * @param {...SqlValue} params Positional values, or one named parameter object.
   * @returns {Promise<Record<string, SqlValue>[]>} All rows in result order.
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
  async all(...params: SqlValue[]): Promise<Record<string, SqlValue>[]> {
    const ptr = await this.#compile();
    this.#resolveParams(ptr, params);
    const s    = requireSqlite().symbols;
    const rows: Record<string, SqlValue>[] = [];
    while (true) {
      const rc = await s.sqlite3_step(ptr) as number;
      if (rc === SQLITE_ROW)  { rows.push(this.#readRow(ptr)); continue; }
      if (rc === SQLITE_DONE) { break; }
      s.sqlite3_reset(ptr);
      throw new Error(`sqlite3: step failed: ${dbErrMsg(this.#db.ptr)}`);
    }
    s.sqlite3_reset(ptr);
    return rows;
  }

  /**
   * Async-iterate rows one at a time.
   *
   * The statement remains active for the duration of iteration and is reset in
   * a `finally` block when iteration finishes, throws, or is abandoned early.
   * Parameter counts are validated before binding.
   *
   * @param {...SqlValue} params Positional values, or one named parameter object.
   * @returns {AsyncGenerator<Record<string, SqlValue>>} Rows in result order.
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
    const ptr = await this.#compile();
    this.#resolveParams(ptr, params);
    const s = requireSqlite().symbols;
    try {
      while (true) {
        const rc = await s.sqlite3_step(ptr) as number;
        if (rc === SQLITE_ROW)  { yield this.#readRow(ptr); continue; }
        if (rc === SQLITE_DONE) { break; }
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
   * Private readonly property `#ptr` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ptr = undefined;
   *
   *   readInternalState() {
   *     return this.#ptr;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #ptr: ArrayBuffer;   // sqlite3* — an 8-byte fino pointer
  /**
   * Private readonly property `#vfs` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #vfs = undefined;
   *
   *   readInternalState() {
   *     return this.#vfs;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #vfs: FinoVFS | null;
  /**
   * Private readonly property `#safeIntegers` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #safeIntegers = undefined;
   *
   *   readInternalState() {
   *     return this.#safeIntegers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #safeIntegers: boolean;
  /**
   * Private property `#closed` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closed = undefined;
   *
   *   readInternalState() {
   *     return this.#closed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closed = false;
  /**
   * Private property `#vectorsAvailable` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #vectorsAvailable = undefined;
   *
   *   readInternalState() {
   *     return this.#vectorsAvailable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #vectorsAvailable: boolean | null = null;
  #statements = new Set<Statement>();

  /**
   * Generated-doc-visible constructor `constructor`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * // Construct Database through the documented constructor path.
   * const ctorName = 'Database';
   * console.log(ctorName);
   * ```
   *
   * @internal
   */
  private constructor(ptr: ArrayBuffer, vfs: FinoVFS | null, safeIntegers: boolean) {
    this.#ptr          = ptr;
    this.#vfs          = vfs;
    this.#safeIntegers = safeIntegers;
  }

  /**
   * Internal sqlite3 pointer for statement helpers.
   *
   * This getter exposes the native pointer wrapper used by this module. It is
   * public for `Statement` integration but is not needed by normal application
   * code. The value becomes invalid after `close()`.
   *
   * @returns {ArrayBuffer} Fino pointer buffer containing `sqlite3*`.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * console.log(db.ptr.byteLength);
   * await db.close();
   * ```
   */
  get ptr(): ArrayBuffer { return this.#ptr; }

  /**
   * Open a database at `path`. Use `':memory:'` for an in-memory database.
   * Pass `{ fs }` to route I/O through a custom FileSystem provider.
   *
   * By default, the database opens read-write and is created if missing.
   * `{ readonly: true }` opens read-only. Each connection registers a private
   * Fino VFS name so file operations go through the chosen filesystem provider.
   * Throws when SQLite is unavailable, open fails, or VFS registration fails.
   *
   * @param {string} path Database path, or `':memory:'`.
   * @param {DatabaseOptions} [opts={}] Open options.
   * @returns {Promise<Database>} Open database connection.
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:', { safeIntegers: true });
   * await db.close();
   * ```
   */
  static async open(path: string, opts: DatabaseOptions = {}): Promise<Database> {
    const s  = requireSqlite().symbols;
    const fs = opts.fs ?? new DiskFileSystem();

    // Per-database VFS with a unique name so multiple open databases don't collide.
    const vfsName = `fino-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const vfs     = new FinoVFS(fs as FileSystem, vfsName);
    vfs.register(false);

    const pathBuf  = cstr(path);
    const ppDb     = new ArrayBuffer(8);   // output: receives sqlite3*

    let flags = SQLITE_OPEN_NOMUTEX;
    if (opts.readonly) {
      flags |= SQLITE_OPEN_READONLY;
    } else {
      flags |= SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    }

    const rc = await s.sqlite3_open_v2(
      pathBuf,
      Pointer.of(ppDb),
      flags,
      vfs.nameCstrPointer,
    ) as number;

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
   * @param {string} sql SQL text to execute.
   * @returns {Promise<void>}
   *
   * ```ts no_run
   * import { Database } from 'fino:database/sqlite';
   *
   * const db = await Database.open(':memory:');
   * await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
   * await db.close();
   * ```
   */
  async exec(sql: string): Promise<void> {
    this.#checkOpen();
    const s  = requireSqlite().symbols;
    const sqlBuf = cstr(sql);
    const rc = await s.sqlite3_exec(
      this.#ptr, sqlBuf, null, null, null,
    ) as number;
    void sqlBuf;
    if (rc !== SQLITE_OK) {
      throw new Error(`sqlite3_exec: ${dbErrMsg(this.#ptr)}`);
    }
  }

  /**
   * Compile a SQL statement and return a reusable Statement.
   * Compilation is lazy — it happens on the first `.run/.get/.all/.iterate` call.
   *
   * Throws immediately if the database is closed. SQL syntax errors are thrown
   * later when the statement first compiles.
   *
   * @param {string} sql SQL statement text.
   * @returns {Statement} Lazy prepared statement wrapper.
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
   * Stop tracking a statement that has been explicitly finalized.
   *
   * Statement wrappers call this during `finalize()` so `close()` only has to
   * finalize wrappers that still own native statement pointers.
   *
   * @param {Statement} stmt Statement to remove from the connection registry.
   * @returns Nothing.
   * @internal
   */
  _untrackStatement(stmt: Statement): void {
    this.#statements.delete(stmt);
  }

  /**
   * Run `fn` inside a BEGIN/COMMIT transaction. Rolls back on throw.
   *
   * The transaction starts with `BEGIN`, commits if `fn` resolves, and attempts
   * `ROLLBACK` if `fn` throws. Nested transaction behavior depends on SQLite
   * and the SQL executed by `fn`; this helper does not create savepoints.
   *
   * @param {() => Promise<T>} fn Async function to run inside the transaction.
   * @returns {Promise<T>} The value returned by `fn`.
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
    await this.exec('BEGIN');
    try {
      const result = await fn();
      await this.exec('COMMIT');
      return result;
    } catch (err) {
      try { await this.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  /**
   * Whether the current sqlite build supports extension loading and sqlite-vec
   * was found. Probed lazily on first access.
   *
   * The probe tries `FINO_SQLITE_VEC_PATH` first when present, then common
   * platform paths. A failed probe caches `false`. Access may enable extension
   * loading on the connection.
   *
   * @returns {boolean} `true` when sqlite-vec was loaded successfully.
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
   * Private method `#probeVectors` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #probeVectors() {
   *     return 'probeVectors';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#probeVectors();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #probeVectors(): boolean {
    const s  = requireSqlite().symbols;
    const rc = s.sqlite3_enable_load_extension(this.#ptr, 1) as number;
    if (rc !== SQLITE_OK) return false;
    const candidates = [
      '/opt/homebrew/lib/sqlite-vec.dylib',
      '/usr/local/lib/sqlite-vec.dylib',
      '/usr/lib/sqlite-vec.so',
      'vec0.so',
    ];
    const envPath = typeof process !== 'undefined'
      ? (process as { env?: Record<string, string> }).env?.['FINO_SQLITE_VEC_PATH']
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
          this.#ptr, Pointer.of(cstr(p)), null, Pointer.of(ppErr),
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
   * The optional `entryPoint` is passed through to `sqlite3_load_extension`.
   * Throws with SQLite's extension error message when loading fails, and throws
   * if the database is closed.
   *
   * @param {string} path Filesystem path to the extension library.
   * @param {string} [entryPoint] Optional extension entry point symbol.
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
    const s   = requireSqlite().symbols;
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
   * @returns {number} Last change count for this connection.
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
   * @returns {bigint} Last inserted rowid for this connection.
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
   * Calling `close()` more than once is allowed. Any statements created by this
   * connection are finalized before the native database handle is closed.
   *
   * @returns {Promise<void>}
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
    for (const stmt of Array.from(this.#statements)) stmt.finalize();
    this.#statements.clear();
    await requireSqlite().symbols.sqlite3_close_v2(this.#ptr);
    if (this.#vfs) this.#vfs.unregister();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Private method `#checkOpen` used by `Database`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #checkOpen() {
   *     return 'checkOpen';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#checkOpen();
   *   }
   * }
   * ```
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
 * `Float32Array` when the input is a regular array.
 *
 * @param {Float32Array|number[]} arr Vector values.
 * @returns {string} sqlite-vec text vector literal.
 *
 * ```ts no_run
 * import { vec } from 'fino:database/sqlite';
 *
 * const literal = vec([0.1, 0.2, 0.3]);
 * console.log(literal);
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
 * @param {Uint8Array} blob sqlite-vec vector BLOB bytes.
 * @returns {Float32Array} Decoded float32 vector.
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
