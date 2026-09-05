/**
 * internal:database/sqlite/bindings — system libsqlite3 via dlopen.
 *
 * Tries candidate paths in order; sets `sqliteAvailable` accordingly.
 * Homebrew paths are first so macOS users get the extension-loadable build.
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as sqliteBindings from 'internal:database/sqlite/bindings';
 *
 * if (sqliteBindings.sqliteAvailable) {
 *   const sqlite = sqliteBindings.requireSqlite();
 *   const version = sqlite.symbols.sqlite3_libversion_number();
 *   console.assert(version > 0);
 * }
 * ```
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
  sqlite3_open_v2: {
    parameters: ['buffer', 'pointer', 'i32', 'pointer'],
    result: 'i32',
    async: true,
  },
  sqlite3_close_v2: {
    parameters: ['pointer'],
    result: 'i32',
    async: true,
  },
  sqlite3_exec: {
    parameters: ['pointer', 'buffer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
    async: true,
  },
  sqlite3_prepare_v2: {
    parameters: ['pointer', 'buffer', 'i32', 'pointer', 'pointer'],
    result: 'i32',
    async: true,
  },
  sqlite3_step: {
    parameters: ['pointer'],
    result: 'i32',
    async: true,
  },
  sqlite3_reset: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_finalize: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_clear_bindings: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_column_count: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_column_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
  },
  sqlite3_column_type: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
  },
  sqlite3_column_int64: {
    parameters: ['pointer', 'i32'],
    result: 'i64',
  },
  sqlite3_column_double: {
    parameters: ['pointer', 'i32'],
    result: 'f64',
  },
  sqlite3_column_text: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
  },
  sqlite3_column_bytes: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
  },
  sqlite3_column_blob: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
  },
  sqlite3_bind_parameter_count: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_bind_parameter_name: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
  },
  sqlite3_bind_parameter_index: {
    parameters: ['pointer', 'pointer'],
    result: 'i32',
  },
  sqlite3_bind_null: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
  },
  sqlite3_bind_int64: {
    parameters: ['pointer', 'i32', 'i64'],
    result: 'i32',
  },
  sqlite3_bind_double: {
    parameters: ['pointer', 'i32', 'f64'],
    result: 'i32',
  },
  sqlite3_bind_text: {
    parameters: ['pointer', 'i32', 'pointer', 'i32', 'pointer'],
    result: 'i32',
  },
  sqlite3_bind_blob: {
    parameters: ['pointer', 'i32', 'pointer', 'i32', 'pointer'],
    result: 'i32',
  },
  sqlite3_errmsg: {
    parameters: ['pointer'],
    result: 'pointer',
  },
  sqlite3_errcode: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_extended_errcode: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_file_control: {
    parameters: ['pointer', 'buffer', 'i32', 'pointer'],
    result: 'i32',
  },
  sqlite3_last_insert_rowid: {
    parameters: ['pointer'],
    result: 'i64',
  },
  sqlite3_changes: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_enable_load_extension: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
  },
  sqlite3_load_extension: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  sqlite3_vfs_find: {
    parameters: ['pointer'],
    result: 'pointer',
  },
  sqlite3_vfs_register: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
  },
  sqlite3_vfs_unregister: {
    parameters: ['pointer'],
    result: 'i32',
  },
  sqlite3_free: {
    parameters: ['pointer'],
    result: 'void',
  },
  sqlite3_libversion_number: {
    parameters: [],
    result: 'i32',
  },
};
let _lib: ReturnType<typeof dlopen> | null = null;
for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}
/**
 * Whether a usable `libsqlite3` was loaded.
 *
 * Public SQLite APIs use this to report availability without throwing. Calling
 * `requireSqlite` still throws when this is false.
 *
 * ```typescript no_run
 * import { sqliteAvailable } from 'internal:database/sqlite/bindings';
 * if (!sqliteAvailable) {
 *   // Skip sqlite-dependent work.
 * }
 * ```
 *
 * @internal
 */
export const sqliteAvailable = _lib !== null;
/**
 * Return the loaded sqlite dynamic library or throw with install guidance.
 *
 * Use this inside helpers that require sqlite symbols. The return value exposes
 * raw native functions and should not be cached across module reloads.
 *
 * ```typescript no_run
 * import { requireSqlite } from 'internal:database/sqlite/bindings';
 * const sqlite = requireSqlite();
 * ```
 *
 * @internal
 */
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
/**
 * Raw sqlite symbol table when available.
 *
 * This is `null` when sqlite could not be loaded. Callers that need guaranteed
 * availability should use `requireSqlite`.
 *
 * ```typescript no_run
 * import { sym } from 'internal:database/sqlite/bindings';
 * const version = sym?.sqlite3_libversion_number();
 * ```
 *
 * @internal
 */
export const sym = _lib?.symbols ?? null;
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Successful sqlite result code.
 * ```typescript no_run
 * import { SQLITE_OK } from 'internal:database/sqlite/bindings';
 * void SQLITE_OK;
 * ```
 * @internal */
export const SQLITE_OK = 0;
/** Generic sqlite error result code.
 * ```typescript no_run
 * import { SQLITE_ERROR } from 'internal:database/sqlite/bindings';
 * void SQLITE_ERROR;
 * ```
 * @internal */
export const SQLITE_ERROR = 1;
/** Database busy result code.
 * ```typescript no_run
 * import { SQLITE_BUSY } from 'internal:database/sqlite/bindings';
 * void SQLITE_BUSY;
 * ```
 * @internal */
export const SQLITE_BUSY = 5;
/** Database locked result code.
 * ```typescript no_run
 * import { SQLITE_LOCKED } from 'internal:database/sqlite/bindings';
 * void SQLITE_LOCKED;
 * ```
 * @internal */
export const SQLITE_LOCKED = 6;
/** Base sqlite I/O error code.
 * ```typescript no_run
 * import { SQLITE_IOERR } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR;
 * ```
 * @internal */
export const SQLITE_IOERR = 10;
/** Cannot-open sqlite result code.
 * ```typescript no_run
 * import { SQLITE_CANTOPEN } from 'internal:database/sqlite/bindings';
 * void SQLITE_CANTOPEN;
 * ```
 * @internal */
export const SQLITE_CANTOPEN = 14;
/** Row-available sqlite step result code.
 * ```typescript no_run
 * import { SQLITE_ROW } from 'internal:database/sqlite/bindings';
 * void SQLITE_ROW;
 * ```
 * @internal */
export const SQLITE_ROW = 100;
/** Statement-complete sqlite step result code.
 * ```typescript no_run
 * import { SQLITE_DONE } from 'internal:database/sqlite/bindings';
 * void SQLITE_DONE;
 * ```
 * @internal */
export const SQLITE_DONE = 101;
/** Extended VFS read error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_READ } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_READ;
 * ```
 * @internal */
export const SQLITE_IOERR_READ = SQLITE_IOERR | (1 << 8);
/** Extended VFS short-read error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_SHORT_READ } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_SHORT_READ;
 * ```
 * @internal */
export const SQLITE_IOERR_SHORT_READ = SQLITE_IOERR | (2 << 8);
/** Extended VFS write error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_WRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_WRITE;
 * ```
 * @internal */
export const SQLITE_IOERR_WRITE = SQLITE_IOERR | (3 << 8);
/** Extended VFS fsync error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_FSYNC } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_FSYNC;
 * ```
 * @internal */
export const SQLITE_IOERR_FSYNC = SQLITE_IOERR | (4 << 8);
/** Extended VFS truncate error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_TRUNCATE } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_TRUNCATE;
 * ```
 * @internal */
export const SQLITE_IOERR_TRUNCATE = SQLITE_IOERR | (6 << 8);
/** Extended VFS stat error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_FSTAT } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_FSTAT;
 * ```
 * @internal */
export const SQLITE_IOERR_FSTAT = SQLITE_IOERR | (7 << 8);
/** Extended VFS close error code.
 * ```typescript no_run
 * import { SQLITE_IOERR_CLOSE } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOERR_CLOSE;
 * ```
 * @internal */
export const SQLITE_IOERR_CLOSE = SQLITE_IOERR | (16 << 8);
/** SQLite not-found result code.
 * ```typescript no_run
 * import { SQLITE_NOTFOUND } from 'internal:database/sqlite/bindings';
 * void SQLITE_NOTFOUND;
 * ```
 * @internal */
export const SQLITE_NOTFOUND = 12;
/** Open database read-only flag.
 * ```typescript no_run
 * import { SQLITE_OPEN_READONLY } from 'internal:database/sqlite/bindings';
 * void SQLITE_OPEN_READONLY;
 * ```
 * @internal */
export const SQLITE_OPEN_READONLY = 1;
/** Open database read-write flag.
 * ```typescript no_run
 * import { SQLITE_OPEN_READWRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_OPEN_READWRITE;
 * ```
 * @internal */
export const SQLITE_OPEN_READWRITE = 2;
/** Open database create-if-missing flag.
 * ```typescript no_run
 * import { SQLITE_OPEN_CREATE } from 'internal:database/sqlite/bindings';
 * void SQLITE_OPEN_CREATE;
 * ```
 * @internal */
export const SQLITE_OPEN_CREATE = 4;
/** Open database no-mutex flag.
 * ```typescript no_run
 * import { SQLITE_OPEN_NOMUTEX } from 'internal:database/sqlite/bindings';
 * void SQLITE_OPEN_NOMUTEX;
 * ```
 * @internal */
export const SQLITE_OPEN_NOMUTEX = 32768;
/** Open database full-mutex flag.
 * ```typescript no_run
 * import { SQLITE_OPEN_FULLMUTEX } from 'internal:database/sqlite/bindings';
 * void SQLITE_OPEN_FULLMUTEX;
 * ```
 * @internal */
export const SQLITE_OPEN_FULLMUTEX = 65536;
/** Open database URI parsing flag.
 * ```typescript no_run
 * import { SQLITE_OPEN_URI } from 'internal:database/sqlite/bindings';
 * void SQLITE_OPEN_URI;
 * ```
 * @internal */
export const SQLITE_OPEN_URI = 64;
/** SQLite integer column type.
 * ```typescript no_run
 * import { SQLITE_INTEGER } from 'internal:database/sqlite/bindings';
 * void SQLITE_INTEGER;
 * ```
 * @internal */
export const SQLITE_INTEGER = 1;
/** SQLite floating-point column type.
 * ```typescript no_run
 * import { SQLITE_FLOAT } from 'internal:database/sqlite/bindings';
 * void SQLITE_FLOAT;
 * ```
 * @internal */
export const SQLITE_FLOAT = 2;
/** SQLite text column type.
 * ```typescript no_run
 * import { SQLITE3_TEXT } from 'internal:database/sqlite/bindings';
 * void SQLITE3_TEXT;
 * ```
 * @internal */
export const SQLITE3_TEXT = 3;
/** SQLite blob column type.
 * ```typescript no_run
 * import { SQLITE_BLOB } from 'internal:database/sqlite/bindings';
 * void SQLITE_BLOB;
 * ```
 * @internal */
export const SQLITE_BLOB = 4;
/** SQLite null column type.
 * ```typescript no_run
 * import { SQLITE_NULL } from 'internal:database/sqlite/bindings';
 * void SQLITE_NULL;
 * ```
 * @internal */
export const SQLITE_NULL = 5;
/** VFS access check for existence.
 * ```typescript no_run
 * import { SQLITE_ACCESS_EXISTS } from 'internal:database/sqlite/bindings';
 * void SQLITE_ACCESS_EXISTS;
 * ```
 * @internal */
export const SQLITE_ACCESS_EXISTS = 0;
/** VFS access check for read-write permission.
 * ```typescript no_run
 * import { SQLITE_ACCESS_READWRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_ACCESS_READWRITE;
 * ```
 * @internal */
export const SQLITE_ACCESS_READWRITE = 1;
/** VFS access check for read permission.
 * ```typescript no_run
 * import { SQLITE_ACCESS_READ } from 'internal:database/sqlite/bindings';
 * void SQLITE_ACCESS_READ;
 * ```
 * @internal */
export const SQLITE_ACCESS_READ = 2;
/** SQLite no-lock state.
 * ```typescript no_run
 * import { SQLITE_LOCK_NONE } from 'internal:database/sqlite/bindings';
 * void SQLITE_LOCK_NONE;
 * ```
 * @internal */
export const SQLITE_LOCK_NONE = 0;
/** SQLite shared-lock state.
 * ```typescript no_run
 * import { SQLITE_LOCK_SHARED } from 'internal:database/sqlite/bindings';
 * void SQLITE_LOCK_SHARED;
 * ```
 * @internal */
export const SQLITE_LOCK_SHARED = 1;
/** SQLite reserved-lock state.
 * ```typescript no_run
 * import { SQLITE_LOCK_RESERVED } from 'internal:database/sqlite/bindings';
 * void SQLITE_LOCK_RESERVED;
 * ```
 * @internal */
export const SQLITE_LOCK_RESERVED = 2;
/** SQLite pending-lock state.
 * ```typescript no_run
 * import { SQLITE_LOCK_PENDING } from 'internal:database/sqlite/bindings';
 * void SQLITE_LOCK_PENDING;
 * ```
 * @internal */
export const SQLITE_LOCK_PENDING = 3;
/** SQLite exclusive-lock state.
 * ```typescript no_run
 * import { SQLITE_LOCK_EXCLUSIVE } from 'internal:database/sqlite/bindings';
 * void SQLITE_LOCK_EXCLUSIVE;
 * ```
 * @internal */
export const SQLITE_LOCK_EXCLUSIVE = 4;
/** SQLite normal sync flag.
 * ```typescript no_run
 * import { SQLITE_SYNC_NORMAL } from 'internal:database/sqlite/bindings';
 * void SQLITE_SYNC_NORMAL;
 * ```
 * @internal */
export const SQLITE_SYNC_NORMAL = 2;
/** SQLite full sync flag.
 * ```typescript no_run
 * import { SQLITE_SYNC_FULL } from 'internal:database/sqlite/bindings';
 * void SQLITE_SYNC_FULL;
 * ```
 * @internal */
export const SQLITE_SYNC_FULL = 3;
/** xDeviceCharacteristics bit for powersafe overwrite support.
 * ```typescript no_run
 * import { SQLITE_IOCAP_POWERSAFE_OVERWRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_IOCAP_POWERSAFE_OVERWRITE;
 * ```
 * @internal */
export const SQLITE_IOCAP_POWERSAFE_OVERWRITE = 4096;
/** SQLite file-control opcodes used by the JavaScript VFS.
 * ```typescript no_run
 * import { SQLITE_FCNTL_LOCKSTATE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_LOCKSTATE;
 * ```
 * @internal */
export const SQLITE_FCNTL_LOCKSTATE = 1;
/** File-control opcode requesting the macOS lock-proxy file path; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_GET_LOCKPROXYFILE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_GET_LOCKPROXYFILE;
 * ```
 * @internal */
export const SQLITE_FCNTL_GET_LOCKPROXYFILE = 2;
/** File-control opcode setting the macOS lock-proxy file path; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_SET_LOCKPROXYFILE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_SET_LOCKPROXYFILE;
 * ```
 * @internal */
export const SQLITE_FCNTL_SET_LOCKPROXYFILE = 3;
/** File-control opcode retrieving the last VFS errno; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_LAST_ERRNO } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_LAST_ERRNO;
 * ```
 * @internal */
export const SQLITE_FCNTL_LAST_ERRNO = 4;
/** File-control opcode hinting the file's expected final size so the VFS can preallocate.
 * ```typescript no_run
 * import { SQLITE_FCNTL_SIZE_HINT } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_SIZE_HINT;
 * ```
 * @internal */
export const SQLITE_FCNTL_SIZE_HINT = 5;
/** File-control opcode setting the chunk size the file grows by; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_CHUNK_SIZE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_CHUNK_SIZE;
 * ```
 * @internal */
export const SQLITE_FCNTL_CHUNK_SIZE = 6;
/** File-control opcode fetching the underlying `sqlite3_file` pointer; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_FILE_POINTER } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_FILE_POINTER;
 * ```
 * @internal */
export const SQLITE_FCNTL_FILE_POINTER = 7;
/** File-control opcode notifying the VFS that a sync was omitted; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_SYNC_OMITTED } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_SYNC_OMITTED;
 * ```
 * @internal */
export const SQLITE_FCNTL_SYNC_OMITTED = 8;
/** File-control opcode tuning Windows anti-virus retry behavior; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_WIN32_AV_RETRY } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_WIN32_AV_RETRY;
 * ```
 * @internal */
export const SQLITE_FCNTL_WIN32_AV_RETRY = 9;
/** File-control opcode querying or setting WAL-file persistence; the JS VFS reports the persist flag.
 * ```typescript no_run
 * import { SQLITE_FCNTL_PERSIST_WAL } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_PERSIST_WAL;
 * ```
 * @internal */
export const SQLITE_FCNTL_PERSIST_WAL = 10;
/** File-control opcode signalling that the database will be overwritten; the JS VFS acknowledges it.
 * ```typescript no_run
 * import { SQLITE_FCNTL_OVERWRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_OVERWRITE;
 * ```
 * @internal */
export const SQLITE_FCNTL_OVERWRITE = 11;
/** File-control opcode retrieving the VFS name stack; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_VFSNAME } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_VFSNAME;
 * ```
 * @internal */
export const SQLITE_FCNTL_VFSNAME = 12;
/** File-control opcode intercepting `PRAGMA` statements at the VFS layer; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_PRAGMA } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_PRAGMA;
 * ```
 * @internal */
export const SQLITE_FCNTL_PRAGMA = 14;
/** File-control opcode querying or setting powersafe-overwrite support; the JS VFS reports its capability.
 * ```typescript no_run
 * import { SQLITE_FCNTL_POWERSAFE_OVERWRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_POWERSAFE_OVERWRITE;
 * ```
 * @internal */
export const SQLITE_FCNTL_POWERSAFE_OVERWRITE = 13;
/** File-control opcode passing a busy handler to the VFS; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_BUSYHANDLER } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_BUSYHANDLER;
 * ```
 * @internal */
export const SQLITE_FCNTL_BUSYHANDLER = 15;
/** File-control opcode requesting a temporary filename from the VFS; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_TEMPFILENAME } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_TEMPFILENAME;
 * ```
 * @internal */
export const SQLITE_FCNTL_TEMPFILENAME = 16;
/** File-control opcode querying or setting the memory-map size; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_MMAP_SIZE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_MMAP_SIZE;
 * ```
 * @internal */
export const SQLITE_FCNTL_MMAP_SIZE = 18;
/** File-control opcode delivering SQL trace text to the VFS; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_TRACE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_TRACE;
 * ```
 * @internal */
export const SQLITE_FCNTL_TRACE = 19;
/** File-control opcode asking whether the database file has been renamed or moved; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_HAS_MOVED } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_HAS_MOVED;
 * ```
 * @internal */
export const SQLITE_FCNTL_HAS_MOVED = 20;
/** File-control opcode fired at the start of each `xSync`; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_SYNC } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_SYNC;
 * ```
 * @internal */
export const SQLITE_FCNTL_SYNC = 21;
/** File-control opcode fired after commit phase two; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_COMMIT_PHASETWO } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_COMMIT_PHASETWO;
 * ```
 * @internal */
export const SQLITE_FCNTL_COMMIT_PHASETWO = 22;
/** File-control opcode setting the Windows file handle; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_WIN32_SET_HANDLE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_WIN32_SET_HANDLE;
 * ```
 * @internal */
export const SQLITE_FCNTL_WIN32_SET_HANDLE = 23;
/** File-control opcode requesting blocking behavior on WAL locks; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_WAL_BLOCK } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_WAL_BLOCK;
 * ```
 * @internal */
export const SQLITE_FCNTL_WAL_BLOCK = 24;
/** File-control opcode reserved for the ZIPVFS extension; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_ZIPVFS } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_ZIPVFS;
 * ```
 * @internal */
export const SQLITE_FCNTL_ZIPVFS = 25;
/** File-control opcode used by the RBU (resumable bulk update) extension; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_RBU } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_RBU;
 * ```
 * @internal */
export const SQLITE_FCNTL_RBU = 26;
/** File-control opcode retrieving the top-level VFS pointer; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_VFS_POINTER } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_VFS_POINTER;
 * ```
 * @internal */
export const SQLITE_FCNTL_VFS_POINTER = 27;
/** File-control opcode retrieving the journal file's `sqlite3_file` pointer; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_JOURNAL_POINTER } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_JOURNAL_POINTER;
 * ```
 * @internal */
export const SQLITE_FCNTL_JOURNAL_POINTER = 28;
/** File-control opcode fetching the Windows file handle; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_WIN32_GET_HANDLE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_WIN32_GET_HANDLE;
 * ```
 * @internal */
export const SQLITE_FCNTL_WIN32_GET_HANDLE = 29;
/** File-control opcode fetching the owning `sqlite3` database handle; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_PDB } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_PDB;
 * ```
 * @internal */
export const SQLITE_FCNTL_PDB = 30;
/** File-control opcode marking the start of an atomic batch write; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_BEGIN_ATOMIC_WRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_BEGIN_ATOMIC_WRITE;
 * ```
 * @internal */
export const SQLITE_FCNTL_BEGIN_ATOMIC_WRITE = 31;
/** File-control opcode committing an atomic batch write; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_COMMIT_ATOMIC_WRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_COMMIT_ATOMIC_WRITE;
 * ```
 * @internal */
export const SQLITE_FCNTL_COMMIT_ATOMIC_WRITE = 32;
/** File-control opcode rolling back an atomic batch write; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE;
 * ```
 * @internal */
export const SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE = 33;
/** File-control opcode setting the blocking-lock timeout in milliseconds; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_LOCK_TIMEOUT } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_LOCK_TIMEOUT;
 * ```
 * @internal */
export const SQLITE_FCNTL_LOCK_TIMEOUT = 34;
/** File-control opcode reading the database change-counter (data version); the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_DATA_VERSION } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_DATA_VERSION;
 * ```
 * @internal */
export const SQLITE_FCNTL_DATA_VERSION = 35;
/** File-control opcode querying or setting the maximum in-memory database size; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_SIZE_LIMIT } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_SIZE_LIMIT;
 * ```
 * @internal */
export const SQLITE_FCNTL_SIZE_LIMIT = 36;
/** File-control opcode fired after a WAL checkpoint completes; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_CKPT_DONE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_CKPT_DONE;
 * ```
 * @internal */
export const SQLITE_FCNTL_CKPT_DONE = 37;
/** File-control opcode querying or setting reserved bytes per page; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_RESERVE_BYTES } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_RESERVE_BYTES;
 * ```
 * @internal */
export const SQLITE_FCNTL_RESERVE_BYTES = 38;
/** File-control opcode fired before a WAL checkpoint begins; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_CKPT_START } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_CKPT_START;
 * ```
 * @internal */
export const SQLITE_FCNTL_CKPT_START = 39;
/** File-control opcode checking for external readers of a WAL database; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_EXTERNAL_READER } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_EXTERNAL_READER;
 * ```
 * @internal */
export const SQLITE_FCNTL_EXTERNAL_READER = 40;
/** File-control opcode used by the checksum VFS shim; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_CKSM_FILE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_CKSM_FILE;
 * ```
 * @internal */
export const SQLITE_FCNTL_CKSM_FILE = 41;
/** File-control opcode requesting that the page cache be reset; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_RESET_CACHE } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_RESET_CACHE;
 * ```
 * @internal */
export const SQLITE_FCNTL_RESET_CACHE = 42;
/** File-control opcode detaching the underlying file descriptor to release I/O; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_NULL_IO } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_NULL_IO;
 * ```
 * @internal */
export const SQLITE_FCNTL_NULL_IO = 43;
/** File-control opcode requesting the VFS block while connecting to a WAL database; the JS VFS acknowledges it as a no-op.
 * ```typescript no_run
 * import { SQLITE_FCNTL_BLOCK_ON_CONNECT } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_BLOCK_ON_CONNECT;
 * ```
 * @internal */
export const SQLITE_FCNTL_BLOCK_ON_CONNECT = 44;
/** Non-standard file-control opcode reserved by the fino VFS for file-stat queries; the JS VFS reports it unhandled.
 * ```typescript no_run
 * import { SQLITE_FCNTL_FILESTAT } from 'internal:database/sqlite/bindings';
 * void SQLITE_FCNTL_FILESTAT;
 * ```
 * @internal */
export const SQLITE_FCNTL_FILESTAT = 45;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Encode a JS string as a null-terminated UTF-8 buffer for sqlite C APIs.
 *
 * Embedded nulls are preserved and may truncate the string in sqlite.
 *
 * ```typescript no_run
 * import { cstr } from 'internal:database/sqlite/bindings';
 * const sql = cstr('select 1');
 * ```
 *
 * @internal
 */
export function cstr(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}
/**
 * Read a null-terminated C string from a fino pointer.
 *
 * The pointer is dereferenced with `Pointer.readU8` until a null byte is found.
 * Passing an invalid pointer is undefined at the FFI layer.
 *
 * ```typescript no_run
 * import { readCStr } from 'internal:database/sqlite/bindings';
 * const message = readCStr(ptr);
 * ```
 *
 * @internal
 */
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
 *
 * Returns fallback strings when sqlite is unavailable or sqlite returns a null
 * error pointer.
 *
 * ```typescript no_run
 * import { dbErrMsg } from 'internal:database/sqlite/bindings';
 * const message = dbErrMsg(dbPtr);
 * ```
 */
export function dbErrMsg(dbPtr: ArrayBuffer): string {
  if (!sym) return 'sqlite unavailable';
  const msgPtr = sym.sqlite3_errmsg(dbPtr) as ArrayBuffer | null;
  if (!msgPtr) return 'unknown error';
  return readCStr(msgPtr);
}
/**
 * Throw an error with the sqlite3 error message.
 *
 * If `dbPtr` is null, `fallback` is used. The thrown message is prefixed with
 * `sqlite3:` for consistent diagnostics.
 *
 * ```typescript no_run
 * import { throwSqlite } from 'internal:database/sqlite/bindings';
 * throwSqlite(null, 'open failed');
 * ```
 *
 * @internal
 */
export function throwSqlite(dbPtr: ArrayBuffer | null, fallback: string): never {
  const msg = dbPtr ? dbErrMsg(dbPtr) : fallback;
  throw new Error(`sqlite3: ${msg}`);
}
