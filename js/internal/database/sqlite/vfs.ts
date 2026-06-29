/**
* internal:database/sqlite/vfs — JS-implemented sqlite3_vfs backed by fino:file FileSystem.
*
* Builds a `sqlite3_vfs` struct and a shared `sqlite3_io_methods` struct, each
* filled with `FfiCallback` function pointers. The VFS delegates all file I/O
* to a `FileSystem` instance from `fino:file`, so sqlite inherits whatever
* provider the realm has (DiskFileSystem, MemoryFileSystem, S3FileSystem, etc.).
*
* ## struct layouts (64-bit)
*
* sqlite3_vfs:
*   [0]  iVersion      i32
*   [4]  szOsFile      i32   (= 16: pMethods ptr + 8-byte file-ID slot)
*   [8]  mxPathname    i32
*   [12] _pad          i32
*   [16] pNext         ptr   (null)
*   [24] zName         ptr   → name C-string
*   [32] pAppData      ptr   (null)
*   [40] xOpen         ptr
*   [48] xDelete       ptr
*   [56] xAccess       ptr
*   [64] xFullPathname ptr
*   [72] xDlOpen       ptr   (null)
*   [80] xDlError      ptr   (null)
*   [88] xDlSym        ptr   (null)
*   [96] xDlClose      ptr   (null)
*   [104] xRandomness  ptr
*   [112] xSleep       ptr
*   [120] xCurrentTime ptr
*   [128] xGetLastError ptr
*   [136] xCurrentTimeInt64 ptr  (v2)
*   [144..167] v3 methods  (null)
*   total: 168 bytes
*
* sqlite3_io_methods:
*   [0]  iVersion      i32
*   [4]  _pad          i32
*   [8]  xClose        ptr
*   [16] xRead         ptr
*   [24] xWrite        ptr
*   [32] xTruncate     ptr
*   [40] xSync         ptr
*   [48] xFileSize     ptr
*   [56] xLock         ptr
*   [64] xUnlock       ptr
*   [72] xCheckReservedLock ptr
*   [80] xFileControl  ptr
*   [88] xSectorSize   ptr
*   [96] xDeviceCharacteristics ptr
*   [104..151] shm/fetch (null, v2/v3)
*   total: 152 bytes
*
* sqlite3_file (our szOsFile = 16):
*   [0]  pMethods      ptr   → shared sqlite3_io_methods struct
*   [8]  fileId        u64   → key into this VFS's handle table
*
* ## Pointer convention
*
* FfiCallback `pointer` parameters arrive as 8-byte ArrayBuffers containing
* the C address as a LE u64. To read/write at the C memory they point to, use
* Pointer.read* / Pointer.write* (which dereference the address). Never use
* DataView directly on a pointer arg — that reads/writes the address itself.
*
* ## Example
*
* ```typescript no_run
* import { FinoVFS } from 'internal:database/sqlite/vfs';
*
* const vfs = new FinoVFS(fileSystem, 'fino');
* vfs.register();
* try {
*   // Open sqlite connections with this VFS name while the callbacks live.
* } finally {
*   vfs.unregister();
* }
* ```
*
* @internal
*/
import { FfiCallback, Pointer } from 'fino:ffi';
import type { FileSystem, FileHandle } from 'internal:file/provider';
import { SQLITE_OK, SQLITE_IOERR, SQLITE_IOERR_READ, SQLITE_IOERR_SHORT_READ, SQLITE_IOERR_WRITE, SQLITE_IOERR_FSYNC, SQLITE_IOERR_TRUNCATE, SQLITE_IOERR_FSTAT, SQLITE_IOERR_CLOSE, SQLITE_NOTFOUND, SQLITE_LOCK_NONE, SQLITE_LOCK_RESERVED, SQLITE_IOCAP_POWERSAFE_OVERWRITE, SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_BLOCK_ON_CONNECT, SQLITE_FCNTL_BUSYHANDLER, SQLITE_FCNTL_CHUNK_SIZE, SQLITE_FCNTL_CKPT_DONE, SQLITE_FCNTL_CKPT_START, SQLITE_FCNTL_COMMIT_ATOMIC_WRITE, SQLITE_FCNTL_COMMIT_PHASETWO, SQLITE_FCNTL_CKSM_FILE, SQLITE_FCNTL_DATA_VERSION, SQLITE_FCNTL_EXTERNAL_READER, SQLITE_FCNTL_FILE_POINTER, SQLITE_FCNTL_FILESTAT, SQLITE_FCNTL_GET_LOCKPROXYFILE, SQLITE_FCNTL_HAS_MOVED, SQLITE_FCNTL_JOURNAL_POINTER, SQLITE_FCNTL_LAST_ERRNO, SQLITE_FCNTL_LOCK_TIMEOUT, SQLITE_FCNTL_LOCKSTATE, SQLITE_FCNTL_MMAP_SIZE, SQLITE_FCNTL_NULL_IO, SQLITE_FCNTL_OVERWRITE, SQLITE_FCNTL_PDB, SQLITE_FCNTL_PERSIST_WAL, SQLITE_FCNTL_POWERSAFE_OVERWRITE, SQLITE_FCNTL_PRAGMA, SQLITE_FCNTL_RBU, SQLITE_FCNTL_RESERVE_BYTES, SQLITE_FCNTL_RESET_CACHE, SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE, SQLITE_FCNTL_SET_LOCKPROXYFILE, SQLITE_FCNTL_SIZE_HINT, SQLITE_FCNTL_SIZE_LIMIT, SQLITE_FCNTL_SYNC, SQLITE_FCNTL_SYNC_OMITTED, SQLITE_FCNTL_TEMPFILENAME, SQLITE_FCNTL_TRACE, SQLITE_FCNTL_VFSNAME, SQLITE_FCNTL_VFS_POINTER, SQLITE_FCNTL_WAL_BLOCK, SQLITE_FCNTL_WIN32_AV_RETRY, SQLITE_FCNTL_WIN32_GET_HANDLE, SQLITE_FCNTL_WIN32_SET_HANDLE, SQLITE_FCNTL_ZIPVFS, SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE, SQLITE_ACCESS_EXISTS, SQLITE_ACCESS_READWRITE, SQLITE_ACCESS_READ, cstr, readCStr, requireSqlite } from './bindings.ts';
const SZ_VFS = 168;
const SZ_IOMETHODS = 152;
const SZ_OS_FILE = 16;
const MX_PATHNAME = 512;
type SyncFileSystem = FileSystem & {
  openSync?: (path: string, mode?: string) => FileHandle;
  unlinkSync?: (path: string) => void;
  statSync?: (path: string) => unknown;
};
type SyncFileHandle = FileHandle & {
  preadSync?: (pos: number | bigint, len: number) => Uint8Array;
  pwriteSync?: (pos: number | bigint, data: Uint8Array) => number;
  truncateSync?: (len: number | bigint) => void;
  syncSync?: () => void;
  sizeSync?: () => bigint;
  closeSync?: () => void;
};
type VfsFileState = {
  handle: FileHandle;
  path: string;
  lockLevel: number;
  chunkSize: number;
  persistWal: number;
  powersafeOverwrite: number;
  lockTimeout: number;
  lastErrno: number;
};
// ---------------------------------------------------------------------------
// Struct initialization helpers — operate on local ArrayBuffer (not via ptr)
// ---------------------------------------------------------------------------
const _dv = (buf: ArrayBuffer) => new DataView(buf);
/**
* Write a function-pointer value into a struct buffer at `offset`.
* `cb.pointer` is an 8-byte ArrayBuffer whose bytes ARE the address.
*/
function _writeFnPtr(struct: ArrayBuffer, offset: number, cb: {
  pointer: ArrayBuffer;
} | null): void {
  const addr = cb === null ? 0n : _dv(cb.pointer).getBigUint64(0, true);
  _dv(struct).setBigUint64(offset, addr, true);
}
/** Write the backing-store address of `buf` into `struct` at `offset`. */
function _writeBufAddr(struct: ArrayBuffer, offset: number, buf: Uint8Array | null): void {
  const addr = buf === null ? 0n : Pointer.addr(buf) as bigint;
  _dv(struct).setBigUint64(offset, addr, true);
}
// ---------------------------------------------------------------------------
// Open flags → file mode
// ---------------------------------------------------------------------------
function _openMode(flags: number): string {
  const rw = (flags & SQLITE_OPEN_READWRITE) !== 0;
  const cr8 = (flags & SQLITE_OPEN_CREATE) !== 0;
  if (rw && cr8) return 'c+';
  if (rw) return 'r+';
  return 'r';
}
// ---------------------------------------------------------------------------
// FinoVFS
// ---------------------------------------------------------------------------
/**
* JavaScript sqlite VFS backed by a Fino `FileSystem`.
*
* A `FinoVFS` owns native callback objects and struct buffers for as long as it
* is registered. Call `unregister` when the VFS is no longer needed; open
* sqlite connections should be closed first.
*
* ```typescript no_run
* import { FinoVFS } from 'internal:database/sqlite/vfs';
* const vfs = new FinoVFS(fs, 'fino');
* vfs.register();
* vfs.unregister();
* ```
*
* @internal
*/
export class FinoVFS {
  /**
  * Private readonly property `#fs` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #fs = undefined;
  *
  *   readInternalState() {
  *     return this.#fs;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #fs: FileSystem;
  /**
  * Private readonly property `#name` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #name = undefined;
  *
  *   readInternalState() {
  *     return this.#name;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #name: string;
  /**
  * Private readonly property `#nameBuf` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #nameBuf = undefined;
  *
  *   readInternalState() {
  *     return this.#nameBuf;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #nameBuf: Uint8Array;
  // Persistent struct buffers — must remain alive as long as the VFS is registered.
  /**
  * Private readonly property `#vfsBuf` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #vfsBuf = undefined;
  *
  *   readInternalState() {
  *     return this.#vfsBuf;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #vfsBuf: ArrayBuffer;
  /**
  * Private readonly property `#ioMethodsBuf` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #ioMethodsBuf = undefined;
  *
  *   readInternalState() {
  *     return this.#ioMethodsBuf;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #ioMethodsBuf: ArrayBuffer;
  // All FfiCallbacks — held to prevent GC and to close on unregister.
  /**
  * Private readonly property `#callbacks` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #callbacks = undefined;
  *
  *   readInternalState() {
  *     return this.#callbacks;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #callbacks: Array<{
    close(): void;
  }> = [];
  // Map from numeric file ID to the open file state.
  /**
  * Private readonly property `#handles` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #handles = undefined;
  *
  *   readInternalState() {
  *     return this.#handles;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #handles: Map<number, VfsFileState> = new Map();
  readonly #dataVersions: Map<string, number> = new Map();
  /**
  * Private property `#nextId` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #nextId = undefined;
  *
  *   readInternalState() {
  *     return this.#nextId;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #nextId = 1;
  /**
  * Create sqlite VFS structs and callbacks for a filesystem provider.
  *
  * `name` defaults to `fino` and is copied into a null-terminated C string.
  * Construction does not register with sqlite; call `register` explicitly.
  *
  * ```typescript no_run
  * import { FinoVFS } from 'internal:database/sqlite/vfs';
  * const vfs = new FinoVFS(fs, 'memory-backed');
  * ```
  */
  constructor(fs: FileSystem, name = 'fino') {
    this.#fs = fs;
    this.#name = name;
    this.#nameBuf = cstr(name);
    this.#vfsBuf = new ArrayBuffer(SZ_VFS);
    this.#ioMethodsBuf = new ArrayBuffer(SZ_IOMETHODS);
    this.#buildIoMethods();
    this.#buildVfs();
  }
  // ---------------------------------------------------------------------------
  // sqlite3_io_methods
  // ---------------------------------------------------------------------------
  /**
  * Private method `#buildIoMethods` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #buildIoMethods() {
  *     return 'buildIoMethods';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#buildIoMethods();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #buildIoMethods(): void {
    const buf = this.#ioMethodsBuf;
    const handles = this.#handles;
    const dataVersions = this.#dataVersions;
    _dv(buf).setInt32(0, 1, true);
    const stateFor = (pFile: ArrayBuffer): VfsFileState | undefined => {
      const id = Number(Pointer.readU64(pFile, 8) as bigint);
      return handles.get(id);
    };
    const bumpDataVersion = (state: VfsFileState): void => {
      const next = (dataVersions.get(state.path) ?? 1) + 1;
      dataVersions.set(state.path, next > 2147483647 ? 1 : next);
    };
    const xClose = new FfiCallback({
      parameters: ['pointer'],
      result: 'i32'
    }, (pFile: ArrayBuffer) => {
      // fileId is at pFile[8] in the sqlite3_file struct
      const id = Number(Pointer.readU64(pFile, 8) as bigint);
      const state = handles.get(id);
      handles.delete(id);
      if (!state) return SQLITE_OK;
      try {
        const syncHandle = state.handle as SyncFileHandle;
        if (typeof syncHandle.closeSync !== 'function') return SQLITE_IOERR_CLOSE;
        syncHandle.closeSync();
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR_CLOSE;
      }
    });
    const xRead = new FfiCallback({
      parameters: [
        'pointer',
        'pointer',
        'i32',
        'i64'
      ],
      result: 'i32'
    }, (pFile: ArrayBuffer, pBuf: ArrayBuffer, iAmt: number, iOfst: bigint) => {
      const state = stateFor(pFile);
      const h = state?.handle as SyncFileHandle | undefined;
      if (!h) return SQLITE_IOERR_READ;
      try {
        if (typeof h.preadSync !== 'function') return SQLITE_IOERR_READ;
        const data = h.preadSync(iOfst, iAmt);
        if (data.byteLength > 0) Pointer.copyTo(pBuf, data);
        if (data.byteLength < iAmt) {
          for (let i = data.byteLength; i < iAmt; i++) Pointer.writeU8(pBuf, i, 0);
          return SQLITE_IOERR_SHORT_READ;
        }
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR_READ;
      }
    });
    const xWrite = new FfiCallback({
      parameters: [
        'pointer',
        'pointer',
        'i32',
        'i64'
      ],
      result: 'i32'
    }, (pFile: ArrayBuffer, pBuf: ArrayBuffer, iAmt: number, iOfst: bigint) => {
      const state = stateFor(pFile);
      const h = state?.handle as SyncFileHandle | undefined;
      if (!h) return SQLITE_IOERR_WRITE;
      try {
        if (typeof h.pwriteSync !== 'function') return SQLITE_IOERR_WRITE;
        const data = Pointer.copyFrom(pBuf, iAmt) as Uint8Array;
        const written = h.pwriteSync(iOfst, data);
        if (written !== iAmt) return SQLITE_IOERR_WRITE;
        if (state) bumpDataVersion(state);
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR_WRITE;
      }
    });
    const xTruncate = new FfiCallback({
      parameters: ['pointer', 'i64'],
      result: 'i32'
    }, (pFile: ArrayBuffer, size: bigint) => {
      const state = stateFor(pFile);
      const h = state?.handle as SyncFileHandle | undefined;
      if (!h) return SQLITE_IOERR_TRUNCATE;
      try {
        if (typeof h.truncateSync !== 'function') return SQLITE_IOERR_TRUNCATE;
        h.truncateSync(size);
        if (state) bumpDataVersion(state);
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR_TRUNCATE;
      }
    });
    const xSync = new FfiCallback({
      parameters: ['pointer', 'i32'],
      result: 'i32'
    }, (pFile: ArrayBuffer, _flags: number) => {
      const state = stateFor(pFile);
      const h = state?.handle as SyncFileHandle | undefined;
      if (!h) return SQLITE_IOERR_FSYNC;
      try {
        if (typeof h.syncSync !== 'function') return SQLITE_IOERR_FSYNC;
        h.syncSync();
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR_FSYNC;
      }
    });
    const xFileSize = new FfiCallback({
      parameters: ['pointer', 'pointer'],
      result: 'i32'
    }, (pFile: ArrayBuffer, pSize: ArrayBuffer) => {
      const state = stateFor(pFile);
      const h = state?.handle as SyncFileHandle | undefined;
      if (!h) return SQLITE_IOERR_FSTAT;
      try {
        if (typeof h.sizeSync !== 'function') return SQLITE_IOERR_FSTAT;
        const sz = h.sizeSync();
        Pointer.writeI64(pSize, 0, sz);
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR_FSTAT;
      }
    });
    const xLock = new FfiCallback({
      parameters: ['pointer', 'i32'],
      result: 'i32'
    }, (pFile: ArrayBuffer, lockType: number) => {
      const state = stateFor(pFile);
      if (state) state.lockLevel = Math.max(state.lockLevel, lockType);
      return SQLITE_OK;
    });
    const xUnlock = new FfiCallback({
      parameters: ['pointer', 'i32'],
      result: 'i32'
    }, (pFile: ArrayBuffer, lockType: number) => {
      const state = stateFor(pFile);
      if (state) state.lockLevel = lockType;
      return SQLITE_OK;
    });
    const xCheckReservedLock = new FfiCallback({
      parameters: ['pointer', 'pointer'],
      result: 'i32'
    }, (pFile: ArrayBuffer, pResOut: ArrayBuffer) => {
      const state = stateFor(pFile);
      Pointer.writeI32(pResOut, 0, state && state.lockLevel >= SQLITE_LOCK_RESERVED ? 1 : 0);
      return SQLITE_OK;
    });
    const xFileControl = new FfiCallback({
      parameters: [
        'pointer',
        'i32',
        'pointer'
      ],
      result: 'i32'
    }, (pFile: ArrayBuffer, op: number, pArg: ArrayBuffer | null) => {
      const state = stateFor(pFile);
      if (!state) return SQLITE_NOTFOUND;
      switch (op) {
        case SQLITE_FCNTL_LOCKSTATE:
          if (pArg) Pointer.writeI32(pArg, 0, state.lockLevel);
          return SQLITE_OK;
        case SQLITE_FCNTL_SYNC_OMITTED:
        case SQLITE_FCNTL_OVERWRITE:
        case SQLITE_FCNTL_BUSYHANDLER:
        case SQLITE_FCNTL_TRACE:
        case SQLITE_FCNTL_SYNC:
        case SQLITE_FCNTL_COMMIT_PHASETWO:
        case SQLITE_FCNTL_WAL_BLOCK:
        case SQLITE_FCNTL_CKPT_START:
        case SQLITE_FCNTL_CKPT_DONE:
        case SQLITE_FCNTL_RESET_CACHE:
        case SQLITE_FCNTL_BLOCK_ON_CONNECT: return SQLITE_OK;
        case SQLITE_FCNTL_SIZE_HINT:
          if (pArg) {
            const h = state.handle as SyncFileHandle;
            try {
              if (typeof h.truncateSync !== 'function') return SQLITE_IOERR_TRUNCATE;
              const size = Pointer.readI64(pArg, 0) as bigint;
              if (size >= 0n) h.truncateSync(size);
              bumpDataVersion(state);
            } catch {
              return SQLITE_IOERR_TRUNCATE;
            }
          }
          return SQLITE_OK;
        case SQLITE_FCNTL_CHUNK_SIZE:
          if (pArg) {
            const chunkSize = Pointer.readI32(pArg, 0) as number;
            if (chunkSize > 0) state.chunkSize = chunkSize;
          }
          return SQLITE_OK;
        case SQLITE_FCNTL_FILE_POINTER:
          if (pArg) Pointer.writePointer(pArg, 0, pFile);
          return SQLITE_OK;
        case SQLITE_FCNTL_LAST_ERRNO:
          if (pArg) Pointer.writeI32(pArg, 0, state.lastErrno);
          return SQLITE_OK;
        case SQLITE_FCNTL_PERSIST_WAL:
          if (pArg) {
            const value = Pointer.readI32(pArg, 0) as number;
            if (value >= 0) state.persistWal = value ? 1 : 0;
            Pointer.writeI32(pArg, 0, state.persistWal);
          }
          return SQLITE_OK;
        case SQLITE_FCNTL_POWERSAFE_OVERWRITE:
          if (pArg) {
            const value = Pointer.readI32(pArg, 0) as number;
            if (value >= 0) state.powersafeOverwrite = value ? 1 : 0;
            Pointer.writeI32(pArg, 0, state.powersafeOverwrite);
          }
          return SQLITE_OK;
        case SQLITE_FCNTL_MMAP_SIZE:
          if (pArg) Pointer.writeI64(pArg, 0, 0n);
          return SQLITE_OK;
        case SQLITE_FCNTL_HAS_MOVED:
          if (pArg) Pointer.writeI32(pArg, 0, 0);
          return SQLITE_OK;
        case SQLITE_FCNTL_LOCK_TIMEOUT:
          if (pArg) {
            const previous = state.lockTimeout;
            state.lockTimeout = Pointer.readI32(pArg, 0) as number;
            Pointer.writeI32(pArg, 0, previous);
          }
          return SQLITE_OK;
        case SQLITE_FCNTL_DATA_VERSION:
          if (pArg) Pointer.writeI32(pArg, 0, dataVersions.get(state.path) ?? 1);
          return SQLITE_OK;
        case SQLITE_FCNTL_GET_LOCKPROXYFILE:
        case SQLITE_FCNTL_SET_LOCKPROXYFILE:
        case SQLITE_FCNTL_WIN32_AV_RETRY:
        case SQLITE_FCNTL_VFSNAME:
        case SQLITE_FCNTL_PRAGMA:
        case SQLITE_FCNTL_TEMPFILENAME:
        case SQLITE_FCNTL_WIN32_SET_HANDLE:
        case SQLITE_FCNTL_ZIPVFS:
        case SQLITE_FCNTL_RBU:
        case SQLITE_FCNTL_VFS_POINTER:
        case SQLITE_FCNTL_JOURNAL_POINTER:
        case SQLITE_FCNTL_WIN32_GET_HANDLE:
        case SQLITE_FCNTL_PDB:
        case SQLITE_FCNTL_BEGIN_ATOMIC_WRITE:
        case SQLITE_FCNTL_COMMIT_ATOMIC_WRITE:
        case SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE:
        case SQLITE_FCNTL_SIZE_LIMIT:
        case SQLITE_FCNTL_RESERVE_BYTES:
        case SQLITE_FCNTL_EXTERNAL_READER:
        case SQLITE_FCNTL_CKSM_FILE:
        case SQLITE_FCNTL_NULL_IO:
        case SQLITE_FCNTL_FILESTAT: return SQLITE_NOTFOUND;
        default: return SQLITE_NOTFOUND;
      }
    });
    const xSectorSize = new FfiCallback({
      parameters: ['pointer'],
      result: 'i32'
    }, (_pFile: ArrayBuffer) => 4096);
    const xDeviceCharacteristics = new FfiCallback({
      parameters: ['pointer'],
      result: 'i32'
    }, (pFile: ArrayBuffer) => {
      const state = stateFor(pFile);
      return state?.powersafeOverwrite ? SQLITE_IOCAP_POWERSAFE_OVERWRITE : 0;
    });
    this.#callbacks.push(xClose, xRead, xWrite, xTruncate, xSync, xFileSize, xLock, xUnlock, xCheckReservedLock, xFileControl, xSectorSize, xDeviceCharacteristics);
    _writeFnPtr(buf, 8, xClose);
    _writeFnPtr(buf, 16, xRead);
    _writeFnPtr(buf, 24, xWrite);
    _writeFnPtr(buf, 32, xTruncate);
    _writeFnPtr(buf, 40, xSync);
    _writeFnPtr(buf, 48, xFileSize);
    _writeFnPtr(buf, 56, xLock);
    _writeFnPtr(buf, 64, xUnlock);
    _writeFnPtr(buf, 72, xCheckReservedLock);
    _writeFnPtr(buf, 80, xFileControl);
    _writeFnPtr(buf, 88, xSectorSize);
    _writeFnPtr(buf, 96, xDeviceCharacteristics);
    // v2/v3 shm/fetch methods at [104..151]: leave zero
  }
  // ---------------------------------------------------------------------------
  // sqlite3_vfs
  // ---------------------------------------------------------------------------
  /**
  * Private method `#buildVfs` used by `FinoVFS`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #buildVfs() {
  *     return 'buildVfs';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#buildVfs();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #buildVfs(): void {
    const buf = this.#vfsBuf;
    const fs = this.#fs;
    const ioM = this.#ioMethodsBuf;
    const handles = this.#handles;
    const dataVersions = this.#dataVersions;
    _dv(buf).setInt32(0, 3, true);
    _dv(buf).setInt32(4, SZ_OS_FILE, true);
    _dv(buf).setInt32(8, MX_PATHNAME, true);
    // pNext = null (offset 16)
    _writeBufAddr(buf, 24, this.#nameBuf);
    // pAppData = null (offset 32)
    // Pre-compute the io_methods address once.
    const ioMAddr = Pointer.addr(new Uint8Array(ioM)) as bigint;
    let nextId = 1;
    const xOpen = new FfiCallback({
      parameters: [
        'pointer',
        'pointer',
        'pointer',
        'i32',
        'pointer'
      ],
      result: 'i32'
    }, async (_pVfs: ArrayBuffer, zName: ArrayBuffer | null, pFile: ArrayBuffer, flags: number, pOutFlags: ArrayBuffer | null) => {
      const path = zName ? readCStr(zName) : '';
      if (!path) return SQLITE_OK;
      const mode = _openMode(flags);
      try {
        const openSync = (fs as SyncFileSystem).openSync;
        if (typeof openSync !== 'function') return SQLITE_IOERR;
        const handle = openSync.call(fs, path, mode);
        const id = nextId++;
        if (!dataVersions.has(path)) dataVersions.set(path, 1);
        handles.set(id, {
          handle,
          path,
          lockLevel: SQLITE_LOCK_NONE,
          chunkSize: 0,
          persistWal: 0,
          powersafeOverwrite: 1,
          lockTimeout: 0,
          lastErrno: 0
        });
        // pFile[0]: pMethods — write address of io_methods struct
        Pointer.writeU64(pFile, 0, ioMAddr);
        // pFile[8]: fileId
        Pointer.writeU64(pFile, 8, BigInt(id));
        if (pOutFlags) Pointer.writeI32(pOutFlags, 0, flags);
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR;
      }
    });
    const xDelete = new FfiCallback({
      parameters: [
        'pointer',
        'pointer',
        'i32'
      ],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, zName: ArrayBuffer, _syncDir: number) => {
      try {
        const unlinkSync = (fs as SyncFileSystem).unlinkSync;
        if (typeof unlinkSync !== 'function') return SQLITE_IOERR;
        unlinkSync.call(fs, readCStr(zName));
        return SQLITE_OK;
      } catch {
        return SQLITE_IOERR;
      }
    });
    const xAccess = new FfiCallback({
      parameters: [
        'pointer',
        'pointer',
        'i32',
        'pointer'
      ],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, zName: ArrayBuffer, _flags: number, pResOut: ArrayBuffer) => {
      let exists = 0;
      try {
        const statSync = (fs as SyncFileSystem).statSync;
        if (typeof statSync === 'function') {
          statSync.call(fs, readCStr(zName));
          exists = 1;
        }
      } catch {}
      Pointer.writeI32(pResOut, 0, exists);
      return SQLITE_OK;
    });
    const xFullPathname = new FfiCallback({
      parameters: [
        'pointer',
        'pointer',
        'i32',
        'pointer'
      ],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, zName: ArrayBuffer, _nOut: number, zOut: ArrayBuffer) => {
      const enc = new TextEncoder().encode(readCStr(zName));
      const limit = Math.min(enc.length, MX_PATHNAME - 1);
      for (let i = 0; i < limit; i++) Pointer.writeU8(zOut, i, enc[i]!);
      Pointer.writeU8(zOut, limit, 0);
      return SQLITE_OK;
    });
    const xRandomness = new FfiCallback({
      parameters: [
        'pointer',
        'i32',
        'pointer'
      ],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, nByte: number, zOut: ArrayBuffer) => {
      const bytes = new Uint8Array(nByte);
      crypto.getRandomValues(bytes);
      Pointer.copyTo(zOut, bytes);
      return nByte;
    });
    const xSleep = new FfiCallback({
      parameters: ['pointer', 'i32'],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, _micros: number) => 0);
    const xCurrentTime = new FfiCallback({
      parameters: ['pointer', 'pointer'],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, pTimeOut: ArrayBuffer) => {
      // Julian Day Number as f64
      Pointer.writeF64(pTimeOut, 0, Date.now() / 864e5 + 2440587.5);
      return SQLITE_OK;
    });
    const xGetLastError = new FfiCallback({
      parameters: [
        'pointer',
        'i32',
        'pointer'
      ],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, _n: number, _zBuf: ArrayBuffer) => 0);
    const xCurrentTimeInt64 = new FfiCallback({
      parameters: ['pointer', 'pointer'],
      result: 'i32'
    }, (_pVfs: ArrayBuffer, pTimeOut: ArrayBuffer) => {
      // Milliseconds since Julian epoch (2440587.5 days before Unix epoch)
      Pointer.writeI64(pTimeOut, 0, BigInt(Date.now()) + 210866803200000n);
      return SQLITE_OK;
    });
    this.#callbacks.push(xOpen, xDelete, xAccess, xFullPathname, xRandomness, xSleep, xCurrentTime, xGetLastError, xCurrentTimeInt64);
    _writeFnPtr(buf, 40, xOpen);
    _writeFnPtr(buf, 48, xDelete);
    _writeFnPtr(buf, 56, xAccess);
    _writeFnPtr(buf, 64, xFullPathname);
    // xDlOpen/xDlError/xDlSym/xDlClose at [72..103]: leave zero
    _writeFnPtr(buf, 104, xRandomness);
    _writeFnPtr(buf, 112, xSleep);
    _writeFnPtr(buf, 120, xCurrentTime);
    _writeFnPtr(buf, 128, xGetLastError);
    _writeFnPtr(buf, 136, xCurrentTimeInt64);
    // v3 methods at [144..167]: leave zero
  }
  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------
  /**
  * Register this VFS with sqlite.
  *
  * Call before opening databases that should use it. Pass `true` to make it
  * sqlite's default VFS. Throws when sqlite is unavailable or registration
  * returns a non-OK result.
  *
  * ```typescript no_run
  * import { FinoVFS } from 'internal:database/sqlite/vfs';
  * const vfs = new FinoVFS(fs);
  * vfs.register(false);
  * ```
  */
  register(makeDflt = false): void {
    const sq = requireSqlite();
    const ptr = Pointer.of(new Uint8Array(this.#vfsBuf));
    const rc = sq.symbols.sqlite3_vfs_register(ptr, makeDflt ? 1 : 0) as number;
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_vfs_register failed: ${rc}`);
  }
  /**
  * Unregister this VFS and free all callbacks.
  *
  * Close sqlite databases using this VFS before unregistering. After this
  * method, the instance should not be registered again because callbacks have
  * been closed.
  *
  * ```typescript no_run
  * vfs.unregister();
  * ```
  */
  unregister(): void {
    const sq = requireSqlite();
    const ptr = Pointer.of(new Uint8Array(this.#vfsBuf));
    sq.symbols.sqlite3_vfs_unregister(ptr);
    for (const cb of this.#callbacks) cb.close();
    this.#callbacks.length = 0;
  }
  /**
  * VFS name to pass as `zVfs` to `sqlite3_open_v2`.
  *
  * ```typescript no_run
  * const name = vfs.name;
  * ```
  */
  get name(): string {
    return this.#name;
  }
  /**
  * Fino pointer to the VFS name C-string.
  *
  * The returned `ArrayBuffer` contains the native address, not the bytes of the
  * string. It remains valid while this VFS instance is alive.
  *
  * ```typescript no_run
  * const namePtr = vfs.nameCstrPointer;
  * ```
  */
  get nameCstrPointer(): ArrayBuffer {
    return Pointer.of(this.#nameBuf);
  }
}
