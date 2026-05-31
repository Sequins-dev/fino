/**
 * internal:sqlite/bindings — system libsqlite3 via dlopen.
 *
 * Tries candidate paths in order; sets `sqliteAvailable` accordingly.
 * Homebrew paths are first so macOS users get the extension-loadable build.
 *
 * @internal
 */

import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';

export { Pointer };

const _IS_DARWIN = os === 'darwin';

const _CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
      '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
      '/opt/local/lib/libsqlite3.dylib',
      '/usr/lib/libsqlite3.dylib',
    ]
  : [
      'libsqlite3.so.0',
      '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0',
      '/usr/lib/aarch64-linux-gnu/libsqlite3.so.0',
      '/usr/lib/libsqlite3.so.0',
      '/usr/local/lib/libsqlite3.so',
    ];

const _SYMBOLS = {
  // Lifecycle (async: run on pool thread so VFS callbacks fire cross-thread)
  sqlite3_open_v2:           { parameters: ['pointer', 'pointer', 'i32', 'pointer'],                    result: 'i32', async: true },
  sqlite3_close_v2:          { parameters: ['pointer'],                                                  result: 'i32', async: true },
  // Execution (async: may call VFS)
  sqlite3_exec:              { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'pointer'],      result: 'i32', async: true },
  sqlite3_prepare_v2:        { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'pointer'],          result: 'i32', async: true },
  sqlite3_step:              { parameters: ['pointer'],                                                  result: 'i32', async: true },
  // Statement management (sync: in-memory operations)
  sqlite3_reset:             { parameters: ['pointer'],                                                  result: 'i32' },
  sqlite3_finalize:          { parameters: ['pointer'],                                                  result: 'i32' },
  sqlite3_clear_bindings:    { parameters: ['pointer'],                                                  result: 'i32' },
  // Column reading
  sqlite3_column_count:      { parameters: ['pointer'],                                                  result: 'i32' },
  sqlite3_column_name:       { parameters: ['pointer', 'i32'],                                           result: 'pointer' },
  sqlite3_column_type:       { parameters: ['pointer', 'i32'],                                           result: 'i32' },
  sqlite3_column_int64:      { parameters: ['pointer', 'i32'],                                           result: 'i64' },
  sqlite3_column_double:     { parameters: ['pointer', 'i32'],                                           result: 'f64' },
  sqlite3_column_text:       { parameters: ['pointer', 'i32'],                                           result: 'pointer' },
  sqlite3_column_bytes:      { parameters: ['pointer', 'i32'],                                           result: 'i32' },
  sqlite3_column_blob:       { parameters: ['pointer', 'i32'],                                           result: 'pointer' },
  // Parameter binding
  sqlite3_bind_parameter_count: { parameters: ['pointer'],                                               result: 'i32' },
  sqlite3_bind_parameter_name:  { parameters: ['pointer', 'i32'],                                        result: 'pointer' },
  sqlite3_bind_parameter_index: { parameters: ['pointer', 'pointer'],                                    result: 'i32' },
  sqlite3_bind_null:         { parameters: ['pointer', 'i32'],                                           result: 'i32' },
  sqlite3_bind_int64:        { parameters: ['pointer', 'i32', 'i64'],                                    result: 'i32' },
  sqlite3_bind_double:       { parameters: ['pointer', 'i32', 'f64'],                                    result: 'i32' },
  sqlite3_bind_text:         { parameters: ['pointer', 'i32', 'pointer', 'i32', 'pointer'],              result: 'i32' },
  sqlite3_bind_blob:         { parameters: ['pointer', 'i32', 'pointer', 'i32', 'pointer'],              result: 'i32' },
  // Error info
  sqlite3_errmsg:            { parameters: ['pointer'],                                                  result: 'pointer' },
  sqlite3_errcode:           { parameters: ['pointer'],                                                  result: 'i32' },
  sqlite3_extended_errcode:  { parameters: ['pointer'],                                                  result: 'i32' },
  // Metadata
  sqlite3_last_insert_rowid: { parameters: ['pointer'],                                                  result: 'i64' },
  sqlite3_changes:           { parameters: ['pointer'],                                                  result: 'i32' },
  // Extensions
  sqlite3_enable_load_extension: { parameters: ['pointer', 'i32'],                                      result: 'i32' },
  sqlite3_load_extension:    { parameters: ['pointer', 'pointer', 'pointer', 'pointer'],                 result: 'i32' },
  // VFS registration
  sqlite3_vfs_register:      { parameters: ['pointer', 'i32'],                                           result: 'i32' },
  sqlite3_vfs_unregister:    { parameters: ['pointer'],                                                  result: 'i32' },
  sqlite3_free:              { parameters: ['pointer'],                                                  result: 'void' },
  // Library version
  sqlite3_libversion_number: { parameters: [],                                                           result: 'i32' },
};

let _lib: ReturnType<typeof dlopen> | null = null;

for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}

export const sqliteAvailable = _lib !== null;

export function requireSqlite(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error(
      'libsqlite3 not found. Install via:\n' +
      '  macOS:  brew install sqlite\n' +
      '  Ubuntu: apt install libsqlite3-0',
    );
  }
  return _lib;
}

export const sym = _lib?.symbols ?? null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SQLITE_OK           = 0;
export const SQLITE_ERROR        = 1;
export const SQLITE_BUSY         = 5;
export const SQLITE_LOCKED       = 6;
export const SQLITE_IOERR        = 10;
export const SQLITE_CANTOPEN     = 14;
export const SQLITE_ROW          = 100;
export const SQLITE_DONE         = 101;

export const SQLITE_IOERR_READ        = SQLITE_IOERR | (1 << 8);
export const SQLITE_IOERR_SHORT_READ  = SQLITE_IOERR | (2 << 8);
export const SQLITE_IOERR_WRITE       = SQLITE_IOERR | (3 << 8);
export const SQLITE_IOERR_FSYNC       = SQLITE_IOERR | (4 << 8);
export const SQLITE_IOERR_TRUNCATE    = SQLITE_IOERR | (6 << 8);
export const SQLITE_IOERR_FSTAT       = SQLITE_IOERR | (7 << 8);
export const SQLITE_IOERR_CLOSE       = SQLITE_IOERR | (16 << 8);
export const SQLITE_NOTIMPL      = 12;

export const SQLITE_OPEN_READONLY  = 0x00000001;
export const SQLITE_OPEN_READWRITE = 0x00000002;
export const SQLITE_OPEN_CREATE    = 0x00000004;
export const SQLITE_OPEN_NOMUTEX   = 0x00008000;
export const SQLITE_OPEN_FULLMUTEX = 0x00010000;
export const SQLITE_OPEN_URI       = 0x00000040;

export const SQLITE_INTEGER = 1;
export const SQLITE_FLOAT   = 2;
export const SQLITE3_TEXT   = 3;
export const SQLITE_BLOB    = 4;
export const SQLITE_NULL    = 5;

export const SQLITE_ACCESS_EXISTS    = 0;
export const SQLITE_ACCESS_READWRITE = 1;
export const SQLITE_ACCESS_READ      = 2;

export const SQLITE_LOCK_NONE      = 0;
export const SQLITE_LOCK_SHARED    = 1;
export const SQLITE_LOCK_RESERVED  = 2;
export const SQLITE_LOCK_PENDING   = 3;
export const SQLITE_LOCK_EXCLUSIVE = 4;

export const SQLITE_SYNC_NORMAL = 0x00002;
export const SQLITE_SYNC_FULL   = 0x00003;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a JS string as a null-terminated UTF-8 buffer. */
export function cstr(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}

/** Read a null-terminated C string from a fino pointer. */
export function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  let i = 0;
  while (true) {
    const b = Pointer.readU8(ptr, i);
    if (b === 0) break;
    bytes.push(b);
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Read the sqlite3 error message for a db handle.
 * `dbPtr` is the 8-byte fino pointer returned by open.
 */
export function dbErrMsg(dbPtr: ArrayBuffer): string {
  if (!sym) return 'sqlite unavailable';
  const msgPtr = sym.sqlite3_errmsg(dbPtr) as ArrayBuffer | null;
  if (!msgPtr) return 'unknown error';
  return readCStr(msgPtr);
}

/** Throw an error with the sqlite3 error message. */
export function throwSqlite(dbPtr: ArrayBuffer | null, fallback: string): never {
  const msg = dbPtr ? dbErrMsg(dbPtr) : fallback;
  throw new Error(`sqlite3: ${msg}`);
}
