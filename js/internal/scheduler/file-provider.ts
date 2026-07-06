/**
* internal:scheduler/file-provider — scheduler-backed `fino:file`.
*
* Remapped in place of `fino:file` inside scheduler-managed tenant isolates, so
* tenant code that does `import { DiskFileSystem } from 'fino:file'` gets a
* provider whose every operation is performed by the owning scheduler on its own
* event loop (facade-owned I/O), not by direct FFI in the tenant isolate.
*
* The pure pieces of the filesystem surface — `FileSystem`, `Stat`, `Entry`,
* `Glob`, and the POSIX constants — are re-exported unchanged; only the
* I/O-performing methods are routed through {@link facadeOp}.
*
* @internal
*/
import { FileSystem } from '../file/provider.ts';
import { Stat } from '../file/stat.ts';
import { Entry, FileEntry, DirEntry } from '../file/entry.ts';
import type { Path } from 'fino:file/path';
import { facadeOp } from './facade-ops.ts';

export { FileSystem } from '../file/provider.ts';
export { Stat } from '../file/stat.ts';
export { File } from '../file/handle.ts';
export { Entry, FileEntry, DirEntry } from '../file/entry.ts';
export { Glob } from '../file/glob.ts';
export {
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR,
  SEEK_SET, SEEK_CUR, SEEK_END,
  DT_UNKNOWN, DT_FIFO, DT_CHR, DT_DIR, DT_BLK, DT_REG, DT_LNK, DT_SOCK,
  F_OK, R_OK, W_OK, X_OK
} from '../file/bindings.ts';

function pathString(path: Path | string): string {
  return typeof path === 'string' ? path : String(path);
}

/** Reconstruct a `Stat` from the 14 raw fields the scheduler serialized. */
function statFromFields(f: number[]): Stat {
  return new Stat(f[0]!, f[1]!, f[2]!, f[3]!, f[4]!, f[5]!, f[6]!, f[7]!, f[8]!, f[9]!, f[10]!, f[11]!, f[12]!, f[13]!);
}

/**
* A file handle whose operations are performed by the scheduler against a real
* handle it keeps in its own table, addressed by `#id`.
*/
class SchedulerFile {
  #id: number;
  #writeBuffer: number[] = [];

  constructor(id: number) {
    this.#id = id;
  }

  async stat(): Promise<Stat> {
    return statFromFields(await facadeOp('file-handle', 'stat', { id: this.#id }) as number[]);
  }

  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    return await facadeOp('file-handle', 'pread', { id: this.#id, pos: Number(pos), len }) as Uint8Array;
  }

  async pwrite(pos: number | bigint, data: Uint8Array): Promise<number> {
    return await facadeOp('file-handle', 'pwrite', { id: this.#id, pos: Number(pos), data }) as number;
  }

  async size(): Promise<bigint> {
    return BigInt(await facadeOp('file-handle', 'size', { id: this.#id }) as number);
  }

  async truncate(len: number | bigint): Promise<void> {
    await facadeOp('file-handle', 'truncate', { id: this.#id, len: Number(len) });
  }

  async sync(): Promise<void> {
    await this.flush();
    await facadeOp('file-handle', 'sync', { id: this.#id });
  }

  async bytes(): Promise<Uint8Array> {
    return await facadeOp('file-handle', 'bytes', { id: this.#id }) as Uint8Array;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  write(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (let i = 0; i < bytes.length; i++) this.#writeBuffer.push(bytes[i] as number);
  }

  async flush(): Promise<void> {
    if (this.#writeBuffer.length === 0) return;
    const data = Uint8Array.from(this.#writeBuffer);
    this.#writeBuffer = [];
    await facadeOp('file-handle', 'write', { id: this.#id, data });
  }

  async close(): Promise<void> {
    await this.flush();
    await facadeOp('file-handle', 'close', { id: this.#id });
  }

  reader(): AsyncIterable<Uint8Array> {
    const file = this;
    return {
      async *[Symbol.asyncIterator]() {
        const total = Number(await file.size());
        const chunk = 64 * 1024;
        for (let pos = 0; pos < total; pos += chunk) {
          yield await file.pread(pos, Math.min(chunk, total - pos));
        }
      }
    };
  }

  writer(): { write(data: Uint8Array | string): void; flush(): Promise<void>; close(): Promise<void> } {
    return {
      write: (data) => this.write(data),
      flush: () => this.flush(),
      close: () => this.close()
    };
  }
}

interface EntryInfo { name: string; path: string; dtype: number; isDir: boolean }

/**
* A directory entry whose listing is performed by the scheduler. The base
* `DirEntry.entries()` walks the directory with direct FFI; overriding it routes
* the listing through a facade op so a tenant never touches the filesystem.
*/
class SchedulerDirEntry extends DirEntry {
  #sfs: SchedulerFileSystem;

  constructor(name: string, path: string, fs: SchedulerFileSystem, dtype: number) {
    super(name, path, fs, dtype);
    this.#sfs = fs;
  }

  override entries(): Promise<Entry[]> {
    return this.#sfs.listEntries(this.path.toString());
  }
}

function makeEntry(info: EntryInfo, fs: SchedulerFileSystem): Entry {
  if (info.isDir) return new SchedulerDirEntry(info.name, info.path, fs, info.dtype);
  return new FileEntry(info.name, info.path, fs, info.dtype);
}

/**
* A `FileSystem` whose operations are performed by the owning scheduler.
*/
export class SchedulerFileSystem extends FileSystem {
  /** @internal — list a directory's children through the scheduler. */
  async listEntries(path: string): Promise<Entry[]> {
    const items = await facadeOp('file', 'readdir', { path }) as EntryInfo[];
    return items.map((info) => makeEntry(info, this));
  }

  async stat(path: Path | string): Promise<Stat> {
    return statFromFields(await facadeOp('file', 'stat', { path: pathString(path) }) as number[]);
  }

  async lstat(path: Path | string): Promise<Stat> {
    return statFromFields(await facadeOp('file', 'lstat', { path: pathString(path) }) as number[]);
  }

  async open(path: Path | string, mode = 'r'): Promise<SchedulerFile> {
    const id = await facadeOp('file', 'open', { path: pathString(path), mode }) as number;
    return new SchedulerFile(id);
  }

  async dir(path: Path | string): Promise<DirEntry> {
    const info = await facadeOp('file', 'dir', { path: pathString(path) }) as EntryInfo;
    return new SchedulerDirEntry(info.name, info.path, this, info.dtype);
  }

  async entry(path: Path | string): Promise<Entry> {
    const info = await facadeOp('file', 'entry', { path: pathString(path) }) as EntryInfo;
    return makeEntry(info, this);
  }

  async mkdir(path: Path | string, mode = 0o755): Promise<void> {
    await facadeOp('file', 'mkdir', { path: pathString(path), mode });
  }

  async rmdir(path: Path | string): Promise<void> {
    await facadeOp('file', 'rmdir', { path: pathString(path) });
  }

  async unlink(path: Path | string): Promise<void> {
    await facadeOp('file', 'unlink', { path: pathString(path) });
  }

  async rename(oldPath: Path | string, newPath: Path | string): Promise<void> {
    await facadeOp('file', 'rename', { oldPath: pathString(oldPath), newPath: pathString(newPath) });
  }

  async readlink(path: Path | string): Promise<string> {
    return await facadeOp('file', 'readlink', { path: pathString(path) }) as string;
  }

  async symlink(target: Path | string, linkpath: Path | string): Promise<void> {
    await facadeOp('file', 'symlink', { target: pathString(target), linkpath: pathString(linkpath) });
  }

  async realpath(path: Path | string): Promise<string> {
    return await facadeOp('file', 'realpath', { path: pathString(path) }) as string;
  }

  // Whole-file transfers are performed in a single facade op rather than through
  // an open handle, so a tenant read/write is one scheduler round trip.
  override async readFile(path: Path | string): Promise<Uint8Array> {
    return await facadeOp('file', 'readFile', { path: pathString(path) }) as Uint8Array;
  }

  override async writeFile(path: Path | string, data: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void> {
    const bytes = data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
    await facadeOp('file', 'writeFile', { path: pathString(path), data: bytes });
  }
}

/** The scheduler-backed `fino:file` default filesystem. */
export const DiskFileSystem = SchedulerFileSystem;
