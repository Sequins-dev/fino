/**
 * fino:sqlite — SQLite database access via system libsqlite3.
 *
 * Uses dlopen to load the system-installed libsqlite3. All file I/O is
 * routed through the realm's FileSystem provider via a JS-implemented
 * sqlite3_vfs, so virtual providers (MemoryFileSystem, S3FileSystem, etc.)
 * work transparently.
 *
 * Usage:
 * ```ts
 *   import { Database } from 'fino:sqlite';
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
} from 'internal:sqlite/bindings';
import { FinoVFS } from 'internal:sqlite/vfs';

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

export interface DatabaseOptions {
  /** FileSystem provider. Defaults to DiskFileSystem. */
  fs?: FileSystem;
  /** If true, open read-only. */
  readonly?: boolean;
  /** If true, type-map INTEGER columns to number instead of BigInt. */
  safeIntegers?: boolean;
}

// ---------------------------------------------------------------------------
// Type mapping helpers
// ---------------------------------------------------------------------------

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

export class Statement {
  readonly #db: Database;
  readonly #sql: string;
  readonly #safeIntegers: boolean;
  #ptr: ArrayBuffer | null = null;  // null until first use (lazy compile)
  #finalized = false;
  #colNames: string[] | null = null;

  constructor(db: Database, sql: string, safeIntegers: boolean) {
    this.#db           = db;
    this.#sql          = sql;
    this.#safeIntegers = safeIntegers;
  }

  async #compile(): Promise<ArrayBuffer> {
    if (this.#finalized) throw new Error('Statement is finalized');
    if (this.#ptr) return this.#ptr;

    const s      = requireSqlite().symbols;
    const sqlBuf = cstr(this.#sql);
    const ppStmt = new ArrayBuffer(8);

    const rc = await s.sqlite3_prepare_v2(
      this.#db.ptr,
      Pointer.of(sqlBuf),
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

  #colCount(ptr: ArrayBuffer): number {
    return requireSqlite().symbols.sqlite3_column_count(ptr) as number;
  }

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

  #readRow(ptr: ArrayBuffer): Record<string, SqlValue> {
    const names = this.#getColNames(ptr);
    const row: Record<string, SqlValue> = {};
    for (let i = 0; i < names.length; i++) {
      row[names[i]!] = _readColumn(ptr, i, this.#safeIntegers);
    }
    return row;
  }

  #bindArgs(ptr: ArrayBuffer, params: SqlValue[]): void {
    const s = requireSqlite().symbols;
    s.sqlite3_reset(ptr);
    s.sqlite3_clear_bindings(ptr);
    for (let i = 0; i < params.length; i++) {
      _bindParam(ptr, i + 1, params[i]);
    }
  }

  #bindNamed(ptr: ArrayBuffer, params: Record<string, SqlValue>): void {
    const s     = requireSqlite().symbols;
    const count = s.sqlite3_bind_parameter_count(ptr) as number;
    s.sqlite3_reset(ptr);
    s.sqlite3_clear_bindings(ptr);
    for (let i = 1; i <= count; i++) {
      const namPtr = s.sqlite3_bind_parameter_name(ptr, i) as ArrayBuffer | null;
      if (!namPtr) continue;
      const name = readCStr(namPtr).replace(/^[:$@]/, '');
      if (name in params) _bindParam(ptr, i, params[name]!);
    }
  }

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

  /** Execute the statement. Returns `{ changes, lastInsertRowid }`. */
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

  /** Execute and return the first row, or undefined. */
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

  /** Execute and return all rows. */
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

  /** Async-iterate rows one at a time. */
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

  /** Finalize (free) this statement. */
  finalize(): void {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.#ptr) requireSqlite().symbols.sqlite3_finalize(this.#ptr);
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export class Database {
  readonly #ptr: ArrayBuffer;   // sqlite3* — an 8-byte fino pointer
  readonly #vfs: FinoVFS | null;
  readonly #safeIntegers: boolean;
  #closed = false;
  #vectorsAvailable: boolean | null = null;

  private constructor(ptr: ArrayBuffer, vfs: FinoVFS | null, safeIntegers: boolean) {
    this.#ptr          = ptr;
    this.#vfs          = vfs;
    this.#safeIntegers = safeIntegers;
  }

  /** Internal access for Statement to call db-level functions. */
  get ptr(): ArrayBuffer { return this.#ptr; }

  /**
   * Open a database at `path`. Use `':memory:'` for an in-memory database.
   * Pass `{ fs }` to route I/O through a custom FileSystem provider.
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
      Pointer.of(pathBuf),
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

  /** Execute one or more SQL statements with no result rows. */
  async exec(sql: string): Promise<void> {
    this.#checkOpen();
    const s  = requireSqlite().symbols;
    const rc = await s.sqlite3_exec(
      this.#ptr, Pointer.of(cstr(sql)), null, null, null,
    ) as number;
    if (rc !== SQLITE_OK) {
      throw new Error(`sqlite3_exec: ${dbErrMsg(this.#ptr)}`);
    }
  }

  /**
   * Compile a SQL statement and return a reusable Statement.
   * Compilation is lazy — it happens on the first `.run/.get/.all/.iterate` call.
   */
  prepare(sql: string): Statement {
    this.#checkOpen();
    return new Statement(this, sql, this.#safeIntegers ?? true);
  }

  /**
   * Run `fn` inside a BEGIN/COMMIT transaction. Rolls back on throw.
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
   */
  get vectorsAvailable(): boolean {
    if (this.#vectorsAvailable !== null) return this.#vectorsAvailable;
    this.#vectorsAvailable = this.#probeVectors();
    return this.#vectorsAvailable;
  }

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
   */
  loadExtension(path: string, entryPoint?: string): void {
    this.#checkOpen();
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

  /** Number of rows changed by the most recent DML statement. */
  get changes(): number {
    return requireSqlite().symbols.sqlite3_changes(this.#ptr) as number;
  }

  /** Row ID of the most recent INSERT. */
  get lastInsertRowid(): bigint {
    return requireSqlite().symbols.sqlite3_last_insert_rowid(this.#ptr) as bigint;
  }

  /** Close the database and unregister the VFS. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await requireSqlite().symbols.sqlite3_close_v2(this.#ptr);
    if (this.#vfs) this.#vfs.unregister();
  }

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
 */
export function vec(arr: Float32Array | number[]): string {
  const a = arr instanceof Float32Array ? arr : new Float32Array(arr);
  return '[' + Array.from(a).join(',') + ']';
}

/**
 * Decode a sqlite-vec BLOB column back to a Float32Array.
 * sqlite-vec stores vectors as little-endian float32 blobs.
 */
export function vecDecode(blob: Uint8Array): Float32Array {
  const buf = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(buf);
}
