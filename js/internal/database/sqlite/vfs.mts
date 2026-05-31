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
 * @internal
 */

import { FfiCallback, Pointer } from 'fino:ffi';
import type { FileSystem, FileHandle } from 'internal:file/provider';
import {
  SQLITE_OK, SQLITE_IOERR,
  SQLITE_IOERR_READ, SQLITE_IOERR_SHORT_READ,
  SQLITE_IOERR_WRITE, SQLITE_IOERR_FSYNC, SQLITE_IOERR_TRUNCATE,
  SQLITE_IOERR_FSTAT, SQLITE_IOERR_CLOSE,
  SQLITE_NOTIMPL,
  SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE,
  SQLITE_ACCESS_EXISTS, SQLITE_ACCESS_READWRITE, SQLITE_ACCESS_READ,
  cstr, readCStr, requireSqlite,
} from './bindings.mts';

const SZ_VFS       = 168;
const SZ_IOMETHODS = 152;
const SZ_OS_FILE   = 16;  // pMethods ptr (8) + fileId slot (8)
const MX_PATHNAME  = 512;

// ---------------------------------------------------------------------------
// Struct initialization helpers — operate on local ArrayBuffer (not via ptr)
// ---------------------------------------------------------------------------

const _dv = (buf: ArrayBuffer) => new DataView(buf);

/**
 * Write a function-pointer value into a struct buffer at `offset`.
 * `cb.pointer` is an 8-byte ArrayBuffer whose bytes ARE the address.
 */
function _writeFnPtr(struct: ArrayBuffer, offset: number, cb: { pointer: ArrayBuffer } | null): void {
  const addr = cb === null ? 0n : _dv(cb.pointer).getBigUint64(0, true);
  _dv(struct).setBigUint64(offset, addr, true);
}

/** Write the backing-store address of `buf` into `struct` at `offset`. */
function _writeBufAddr(struct: ArrayBuffer, offset: number, buf: Uint8Array | null): void {
  const addr = buf === null ? 0n : (Pointer.addr(buf) as bigint);
  _dv(struct).setBigUint64(offset, addr, true);
}

// ---------------------------------------------------------------------------
// Open flags → file mode
// ---------------------------------------------------------------------------

function _openMode(flags: number): string {
  const rw  = (flags & SQLITE_OPEN_READWRITE) !== 0;
  const cr8 = (flags & SQLITE_OPEN_CREATE)    !== 0;
  if (rw && cr8) return 'a+';  // create if missing, preserve if exists; pread/pwrite ignore O_APPEND
  if (rw)        return 'r+';  // read-write, must exist
  return 'r';                  // read-only
}

// ---------------------------------------------------------------------------
// FinoVFS
// ---------------------------------------------------------------------------

export class FinoVFS {
  readonly #fs: FileSystem;
  readonly #name: string;
  readonly #nameBuf: Uint8Array;

  // Persistent struct buffers — must remain alive as long as the VFS is registered.
  readonly #vfsBuf: ArrayBuffer;
  readonly #ioMethodsBuf: ArrayBuffer;

  // All FfiCallbacks — held to prevent GC and to close on unregister.
  readonly #callbacks: Array<{ close(): void }> = [];

  // Map from numeric file ID to the open FileHandle.
  readonly #handles: Map<number, FileHandle> = new Map();
  #nextId = 1;

  constructor(fs: FileSystem, name = 'fino') {
    this.#fs      = fs;
    this.#name    = name;
    this.#nameBuf = cstr(name);

    this.#vfsBuf       = new ArrayBuffer(SZ_VFS);
    this.#ioMethodsBuf = new ArrayBuffer(SZ_IOMETHODS);

    this.#buildIoMethods();
    this.#buildVfs();
  }

  // ---------------------------------------------------------------------------
  // sqlite3_io_methods
  // ---------------------------------------------------------------------------

  #buildIoMethods(): void {
    const buf     = this.#ioMethodsBuf;
    const handles = this.#handles;
    _dv(buf).setInt32(0, 1, true);  // iVersion = 1

    const xClose = new FfiCallback(
      { parameters: ['pointer'], result: 'i32' },
      async (pFile: ArrayBuffer) => {
        // fileId is at pFile[8] in the sqlite3_file struct
        const id = Number(Pointer.readU64(pFile, 8) as bigint);
        const h  = handles.get(id);
        handles.delete(id);
        if (!h) return SQLITE_OK;
        try { await h.close(); return SQLITE_OK; }
        catch { return SQLITE_IOERR_CLOSE; }
      },
    );

    const xRead = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'i32', 'i64'], result: 'i32' },
      async (pFile: ArrayBuffer, pBuf: ArrayBuffer, iAmt: number, iOfst: bigint) => {
        const id = Number(Pointer.readU64(pFile, 8) as bigint);
        const h  = handles.get(id);
        if (!h) return SQLITE_IOERR_READ;
        try {
          const data = await h.pread(iOfst, iAmt);
          if (data.byteLength > 0) Pointer.copyTo(pBuf, data);
          if (data.byteLength < iAmt) {
            for (let i = data.byteLength; i < iAmt; i++) Pointer.writeU8(pBuf, i, 0);
            return SQLITE_IOERR_SHORT_READ;
          }
          return SQLITE_OK;
        } catch { return SQLITE_IOERR_READ; }
      },
    );

    const xWrite = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'i32', 'i64'], result: 'i32' },
      async (pFile: ArrayBuffer, pBuf: ArrayBuffer, iAmt: number, iOfst: bigint) => {
        const id = Number(Pointer.readU64(pFile, 8) as bigint);
        const h  = handles.get(id);
        if (!h) return SQLITE_IOERR_WRITE;
        try {
          const data    = Pointer.copyFrom(pBuf, iAmt) as Uint8Array;
          const written = await h.pwrite(iOfst, data);
          return written === iAmt ? SQLITE_OK : SQLITE_IOERR_WRITE;
        } catch { return SQLITE_IOERR_WRITE; }
      },
    );

    const xTruncate = new FfiCallback(
      { parameters: ['pointer', 'i64'], result: 'i32' },
      async (pFile: ArrayBuffer, size: bigint) => {
        const id = Number(Pointer.readU64(pFile, 8) as bigint);
        const h  = handles.get(id);
        if (!h) return SQLITE_IOERR_TRUNCATE;
        try { await h.truncate(size); return SQLITE_OK; }
        catch { return SQLITE_IOERR_TRUNCATE; }
      },
    );

    const xSync = new FfiCallback(
      { parameters: ['pointer', 'i32'], result: 'i32' },
      async (pFile: ArrayBuffer, _flags: number) => {
        const id = Number(Pointer.readU64(pFile, 8) as bigint);
        const h  = handles.get(id);
        if (!h) return SQLITE_IOERR_FSYNC;
        try { await h.sync(); return SQLITE_OK; }
        catch { return SQLITE_IOERR_FSYNC; }
      },
    );

    const xFileSize = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      async (pFile: ArrayBuffer, pSize: ArrayBuffer) => {
        const id = Number(Pointer.readU64(pFile, 8) as bigint);
        const h  = handles.get(id);
        if (!h) return SQLITE_IOERR_FSTAT;
        try {
          const sz = await h.size();
          Pointer.writeI64(pSize, 0, sz);
          return SQLITE_OK;
        } catch { return SQLITE_IOERR_FSTAT; }
      },
    );

    const xLock = new FfiCallback(
      { parameters: ['pointer', 'i32'], result: 'i32' },
      (_pFile: ArrayBuffer, _lockType: number) => SQLITE_OK,
    );

    const xUnlock = new FfiCallback(
      { parameters: ['pointer', 'i32'], result: 'i32' },
      (_pFile: ArrayBuffer, _lockType: number) => SQLITE_OK,
    );

    const xCheckReservedLock = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      (_pFile: ArrayBuffer, pResOut: ArrayBuffer) => {
        Pointer.writeI32(pResOut, 0, 0);  // not locked
        return SQLITE_OK;
      },
    );

    const xFileControl = new FfiCallback(
      { parameters: ['pointer', 'i32', 'pointer'], result: 'i32' },
      (_pFile: ArrayBuffer, _op: number, _pArg: ArrayBuffer) => SQLITE_NOTIMPL,
    );

    const xSectorSize = new FfiCallback(
      { parameters: ['pointer'], result: 'i32' },
      (_pFile: ArrayBuffer) => 4096,
    );

    const xDeviceCharacteristics = new FfiCallback(
      { parameters: ['pointer'], result: 'i32' },
      (_pFile: ArrayBuffer) => 0,
    );

    this.#callbacks.push(
      xClose, xRead, xWrite, xTruncate, xSync, xFileSize,
      xLock, xUnlock, xCheckReservedLock, xFileControl,
      xSectorSize, xDeviceCharacteristics,
    );

    _writeFnPtr(buf,   8, xClose);
    _writeFnPtr(buf,  16, xRead);
    _writeFnPtr(buf,  24, xWrite);
    _writeFnPtr(buf,  32, xTruncate);
    _writeFnPtr(buf,  40, xSync);
    _writeFnPtr(buf,  48, xFileSize);
    _writeFnPtr(buf,  56, xLock);
    _writeFnPtr(buf,  64, xUnlock);
    _writeFnPtr(buf,  72, xCheckReservedLock);
    _writeFnPtr(buf,  80, xFileControl);
    _writeFnPtr(buf,  88, xSectorSize);
    _writeFnPtr(buf,  96, xDeviceCharacteristics);
    // v2/v3 shm/fetch methods at [104..151]: leave zero
  }

  // ---------------------------------------------------------------------------
  // sqlite3_vfs
  // ---------------------------------------------------------------------------

  #buildVfs(): void {
    const buf     = this.#vfsBuf;
    const fs      = this.#fs;
    const ioM     = this.#ioMethodsBuf;
    const handles = this.#handles;

    _dv(buf).setInt32(0, 3,           true);  // iVersion = 3
    _dv(buf).setInt32(4, SZ_OS_FILE,  true);  // szOsFile
    _dv(buf).setInt32(8, MX_PATHNAME, true);  // mxPathname
    // pNext = null (offset 16)
    _writeBufAddr(buf, 24, this.#nameBuf);    // zName → name C-string
    // pAppData = null (offset 32)

    // Pre-compute the io_methods address once.
    const ioMAddr = Pointer.addr(new Uint8Array(ioM)) as bigint;

    let nextId = 1;

    const xOpen = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'pointer', 'i32', 'pointer'], result: 'i32' },
      async (
        _pVfs:     ArrayBuffer,
        zName:     ArrayBuffer | null,
        pFile:     ArrayBuffer,
        flags:     number,
        pOutFlags: ArrayBuffer | null,
      ) => {
        const path = zName ? readCStr(zName) : '';
        if (!path) return SQLITE_OK;  // anonymous temp — skip (sqlite handles in-memory itself)
        const mode = _openMode(flags);
        try {
          const handle = await fs.open(path, mode);
          const id     = nextId++;
          handles.set(id, handle);
          // pFile[0]: pMethods — write address of io_methods struct
          Pointer.writeU64(pFile, 0, ioMAddr);
          // pFile[8]: fileId
          Pointer.writeU64(pFile, 8, BigInt(id));
          if (pOutFlags) Pointer.writeI32(pOutFlags, 0, flags);
          return SQLITE_OK;
        } catch { return SQLITE_IOERR; }
      },
    );

    const xDelete = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'i32'], result: 'i32' },
      async (_pVfs: ArrayBuffer, zName: ArrayBuffer, _syncDir: number) => {
        try { await fs.unlink(readCStr(zName)); return SQLITE_OK; }
        catch { return SQLITE_IOERR; }
      },
    );

    const xAccess = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'i32', 'pointer'], result: 'i32' },
      async (_pVfs: ArrayBuffer, zName: ArrayBuffer, _flags: number, pResOut: ArrayBuffer) => {
        let exists = 0;
        try { await fs.stat(readCStr(zName)); exists = 1; } catch {}
        Pointer.writeI32(pResOut, 0, exists);
        return SQLITE_OK;
      },
    );

    const xFullPathname = new FfiCallback(
      { parameters: ['pointer', 'pointer', 'i32', 'pointer'], result: 'i32' },
      (_pVfs: ArrayBuffer, zName: ArrayBuffer, _nOut: number, zOut: ArrayBuffer) => {
        const enc   = new TextEncoder().encode(readCStr(zName));
        const limit = Math.min(enc.length, MX_PATHNAME - 1);
        for (let i = 0; i < limit; i++) Pointer.writeU8(zOut, i, enc[i]!);
        Pointer.writeU8(zOut, limit, 0);
        return SQLITE_OK;
      },
    );

    const xRandomness = new FfiCallback(
      { parameters: ['pointer', 'i32', 'pointer'], result: 'i32' },
      (_pVfs: ArrayBuffer, nByte: number, zOut: ArrayBuffer) => {
        const bytes = new Uint8Array(nByte);
        crypto.getRandomValues(bytes);
        Pointer.copyTo(zOut, bytes);
        return nByte;
      },
    );

    const xSleep = new FfiCallback(
      { parameters: ['pointer', 'i32'], result: 'i32' },
      (_pVfs: ArrayBuffer, _micros: number) => 0,
    );

    const xCurrentTime = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      (_pVfs: ArrayBuffer, pTimeOut: ArrayBuffer) => {
        // Julian Day Number as f64
        Pointer.writeF64(pTimeOut, 0, Date.now() / 86400000.0 + 2440587.5);
        return SQLITE_OK;
      },
    );

    const xGetLastError = new FfiCallback(
      { parameters: ['pointer', 'i32', 'pointer'], result: 'i32' },
      (_pVfs: ArrayBuffer, _n: number, _zBuf: ArrayBuffer) => 0,
    );

    const xCurrentTimeInt64 = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      (_pVfs: ArrayBuffer, pTimeOut: ArrayBuffer) => {
        // Milliseconds since Julian epoch (2440587.5 days before Unix epoch)
        Pointer.writeI64(pTimeOut, 0, BigInt(Date.now()) + 210866803200000n);
        return SQLITE_OK;
      },
    );

    this.#callbacks.push(
      xOpen, xDelete, xAccess, xFullPathname,
      xRandomness, xSleep, xCurrentTime, xGetLastError, xCurrentTimeInt64,
    );

    _writeFnPtr(buf,  40, xOpen);
    _writeFnPtr(buf,  48, xDelete);
    _writeFnPtr(buf,  56, xAccess);
    _writeFnPtr(buf,  64, xFullPathname);
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

  /** Register this VFS with sqlite. Call before opening any databases. */
  register(makeDflt = false): void {
    const sq  = requireSqlite();
    const ptr = Pointer.of(new Uint8Array(this.#vfsBuf));
    const rc  = sq.symbols.sqlite3_vfs_register(ptr, makeDflt ? 1 : 0) as number;
    if (rc !== SQLITE_OK) throw new Error(`sqlite3_vfs_register failed: ${rc}`);
  }

  /** Unregister this VFS and free all callbacks. */
  unregister(): void {
    const sq  = requireSqlite();
    const ptr = Pointer.of(new Uint8Array(this.#vfsBuf));
    sq.symbols.sqlite3_vfs_unregister(ptr);
    for (const cb of this.#callbacks) cb.close();
    this.#callbacks.length = 0;
  }

  /** The VFS name to pass as `zVfs` to `sqlite3_open_v2`. */
  get name(): string { return this.#name; }

  /** An 8-byte fino pointer to the VFS name C-string. */
  get nameCstrPointer(): ArrayBuffer {
    return Pointer.of(this.#nameBuf);
  }
}
