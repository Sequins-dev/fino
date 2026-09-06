/**
 * internal:sim/file — child-side `fino:file` implementation for FakeFs.
 *
 * This module preserves the public filesystem classes and constants while
 * forwarding stateful operations to the parent-owned simulation filesystem
 * through the existing Facade RPC transport.
 *
 * @internal
 */
import { FileSystem, type ByteWriter, type FileHandle } from 'internal:file/provider';
import { Stat } from 'internal:file/stat';
import { Entry, FileEntry, DirEntry } from 'internal:file/entry';
import { Glob } from 'internal:file/glob';
import { Path } from 'fino:file/path';
import { call as callParent } from 'internal:parent-rpc';
import {
  F_OK,
  R_OK,
  W_OK,
  X_OK,
  O_RDONLY,
  O_WRONLY,
  O_RDWR,
  O_CREAT,
  O_TRUNC,
  O_APPEND,
  O_EXCL,
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFLNK,
  S_IFSOCK,
  S_IFIFO,
  S_IFBLK,
  S_IFCHR,
  SEEK_SET,
  SEEK_CUR,
  SEEK_END,
  DT_UNKNOWN,
  DT_FIFO,
  DT_CHR,
  DT_DIR,
  DT_BLK,
  DT_REG,
  DT_LNK,
  DT_SOCK,
} from 'internal:file/constants';

export {
  FileSystem,
  Stat,
  Entry,
  FileEntry,
  DirEntry,
  Glob,
  F_OK,
  R_OK,
  W_OK,
  X_OK,
  O_RDONLY,
  O_WRONLY,
  O_RDWR,
  O_CREAT,
  O_TRUNC,
  O_APPEND,
  O_EXCL,
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFLNK,
  S_IFSOCK,
  S_IFIFO,
  S_IFBLK,
  S_IFCHR,
  SEEK_SET,
  SEEK_CUR,
  SEEK_END,
  DT_UNKNOWN,
  DT_FIFO,
  DT_CHR,
  DT_DIR,
  DT_BLK,
  DT_REG,
  DT_LNK,
  DT_SOCK,
};

type FileKind = 'file' | 'dir' | 'link';
interface FileInfo {
  kind: FileKind;
  size: number;
  mtimeMs: number;
}
interface ListedEntry {
  name: string;
  kind: FileKind;
}
type FileData = string | Uint8Array | ArrayBuffer | ArrayBufferView;

const call = <T>(method: string, args: unknown[]): Promise<T> =>
  callParent(import.meta.url, method, args) as Promise<T>;
const pathOf = (path: Path | string): string => String(path);
const errno = (code: string, detail: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${detail}`), { code });
const rethrow = (error: unknown, path: string): never => {
  const message = error instanceof Error ? error.message : String(error);
  const match = /:\s*(E[A-Z0-9]+)\s*$/.exec(message) || /\b(E[A-Z]+)\b/.exec(message);
  const wrapped = new Error(message.includes(path) ? message : `${message}: ${path}`) as Error & {
    code?: string;
  };
  if (match) wrapped.code = match[1];
  throw wrapped;
};
const statOf = (info: FileInfo): Stat => {
  const type = info.kind === 'dir' ? S_IFDIR : info.kind === 'link' ? S_IFLNK : S_IFREG;
  return new Stat(
    0,
    0,
    type | (info.kind === 'dir' ? 0o755 : info.kind === 'link' ? 0o777 : 0o644),
    1,
    0,
    0,
    0,
    info.size,
    4096,
    Math.ceil(info.size / 512),
    info.mtimeMs,
    info.mtimeMs,
    info.mtimeMs,
    info.mtimeMs,
  );
};
const bytesOf = (data: FileData): Uint8Array => {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};
const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left);
  bytes.set(right, left.length);
  return bytes;
};

/** Open handle backed by a buffered copy of a simulated file. */
export class File implements FileHandle {
  #path: Path;
  #bytes: Uint8Array;
  #writable: boolean;
  #dirty: boolean;
  #closed = false;

  constructor(path: string, bytes: Uint8Array, writable: boolean, dirty = false) {
    this.#path = Path.from(path);
    this.#bytes = bytes;
    this.#writable = writable;
    this.#dirty = dirty;
  }

  get path(): Path {
    return this.#path;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed) throw errno('EBADF', `file is closed: ${this.#path}`);
  }

  #assertWritable(): void {
    this.#assertOpen();
    if (!this.#writable) throw errno('EBADF', `file is read-only: ${this.#path}`);
  }

  async stat(): Promise<Stat> {
    this.#assertOpen();
    const info = await call<FileInfo>('stat', [String(this.#path)]).catch((error) =>
      rethrow(error, String(this.#path)),
    );
    return statOf({ ...info, kind: 'file', size: this.#bytes.length });
  }

  reader(): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const bytes = this.#bytes;
    return (async function* () {
      if (bytes.length > 0) yield bytes;
    })();
  }

  writer(): ByteWriter {
    this.#assertWritable();
    return {
      write: (data) => {
        this.#assertWritable();
        this.#bytes = concat(this.#bytes, bytesOf(data));
        this.#dirty = true;
      },
      flush: () => this.sync(),
      close: async () => {},
    };
  }

  async bytes(): Promise<Uint8Array> {
    this.#assertOpen();
    return this.#bytes;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    this.#assertOpen();
    return this.#bytes.slice(Number(pos), Number(pos) + len);
  }

  async pwrite(pos: number | bigint, data: Uint8Array): Promise<number> {
    this.#assertWritable();
    const start = Number(pos);
    const end = start + data.length;
    if (end > this.#bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.#bytes);
      this.#bytes = grown;
    }
    this.#bytes.set(data, start);
    this.#dirty = true;
    return data.length;
  }

  async truncate(len: number | bigint): Promise<void> {
    this.#assertWritable();
    const size = Number(len);
    const resized = new Uint8Array(size);
    resized.set(this.#bytes.subarray(0, size));
    this.#bytes = resized;
    this.#dirty = true;
  }

  async size(): Promise<bigint> {
    this.#assertOpen();
    return BigInt(this.#bytes.length);
  }

  async sync(): Promise<void> {
    this.#assertOpen();
    if (!this.#dirty) return;
    await call<void>('writeFile', [String(this.#path), this.#bytes]).catch((error) =>
      rethrow(error, String(this.#path)),
    );
    this.#dirty = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#dirty) await this.sync();
    this.#closed = true;
  }
}

/** Filesystem provider that forwards operations through the FakeFs Facade. */
export class DiskFileSystem extends FileSystem {
  async #stat(method: 'stat' | 'lstat', path: Path | string): Promise<Stat> {
    const value = pathOf(path);
    const info = await call<FileInfo | null>(method, [value]).catch((error) =>
      rethrow(error, value),
    );
    if (info === null) throw errno('ENOENT', `no such file or directory: ${value}`);
    return statOf(info);
  }

  stat(path: Path | string): Promise<Stat> {
    return this.#stat('stat', path);
  }

  lstat(path: Path | string): Promise<Stat> {
    return this.#stat('lstat', path);
  }

  async open(path: Path | string, mode = 'r'): Promise<File> {
    const value = pathOf(path);
    const exists = await call<boolean>('exists', [value]).catch((error) => rethrow(error, value));
    if (mode.includes('x') && exists) throw errno('EEXIST', `file exists: ${value}`);
    if (!exists && mode.startsWith('r')) throw errno('ENOENT', `no such file: ${value}`);
    const writable = mode !== 'r';
    const truncate = mode.startsWith('w');
    if (!exists) {
      await call<void>('writeFile', [value, new Uint8Array()]).catch((error) =>
        rethrow(error, value),
      );
    }
    const bytes =
      exists && !truncate
        ? await call<Uint8Array>('readFile', [value]).catch((error) => rethrow(error, value))
        : new Uint8Array();
    return new File(value, bytes, writable, truncate);
  }

  async readdir(path: Path | string): Promise<Entry[]> {
    const value = pathOf(path);
    const listed = await call<ListedEntry[]>('readdir', [value]).catch((error) =>
      rethrow(error, value),
    );
    return listed.map(({ name, kind }) => {
      const child = value === '/' ? `/${name}` : `${value}/${name}`;
      if (kind === 'dir') return new DirEntry(name, child, this, DT_DIR);
      if (kind === 'link') return new Entry(name, child, this, DT_LNK);
      return new FileEntry(name, child, this, DT_REG);
    });
  }

  async dir(path: Path | string): Promise<DirEntry> {
    const value = pathOf(path);
    const info = await this.stat(value);
    if (!info.isDirectory()) throw errno('ENOTDIR', `not a directory: ${value}`);
    const name = value === '/' ? '/' : value.slice(value.lastIndexOf('/') + 1);
    return new DirEntry(name, value, this, DT_DIR);
  }

  async entry(path: Path | string): Promise<Entry> {
    const value = pathOf(path);
    const info = await this.lstat(value);
    const name = value === '/' ? '/' : value.slice(value.lastIndexOf('/') + 1);
    if (info.isDirectory()) return new DirEntry(name, value, this, DT_DIR);
    if (info.isSymlink()) return new Entry(name, value, this, DT_LNK);
    return new FileEntry(name, value, this, DT_REG);
  }

  mkdir(path: Path | string, mode?: number): Promise<void> {
    return call('mkdir', [pathOf(path), mode]);
  }

  rmdir(path: Path | string): Promise<void> {
    return call('rmdir', [pathOf(path)]);
  }

  unlink(path: Path | string): Promise<void> {
    return call('unlink', [pathOf(path)]);
  }

  rename(from: Path | string, to: Path | string): Promise<void> {
    return call('rename', [pathOf(from), pathOf(to)]);
  }

  readlink(path: Path | string): Promise<string> {
    return call('readlink', [pathOf(path)]);
  }

  symlink(target: Path | string, link: Path | string): Promise<void> {
    return call('symlink', [pathOf(target), pathOf(link)]);
  }

  realpath(path: Path | string): Promise<string> {
    return call('realpath', [pathOf(path)]);
  }

  async access(path: Path | string): Promise<void> {
    const value = pathOf(path);
    if (!(await call<boolean>('exists', [value]))) {
      throw errno('ENOENT', `no such file: ${value}`);
    }
  }

  readFile(path: Path | string): Promise<Uint8Array> {
    const value = pathOf(path);
    return call<Uint8Array>('readFile', [value]).catch((error) => rethrow(error, value));
  }

  writeFile(path: Path | string, data: FileData): Promise<void> {
    const value = pathOf(path);
    return call<void>('writeFile', [value, bytesOf(data)]).catch((error) => rethrow(error, value));
  }
}
