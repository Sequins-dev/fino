/**
 * fino:file/memory — an in-memory filesystem provider.
 *
 * `MemoryFileSystem` implements the same `FileSystem` contract as
 * `DiskFileSystem`, so anything written against `fino:file` works against it
 * unchanged: the same `Stat` objects, the same `File` handles, the same
 * `Entry`/`FileEntry`/`DirEntry` listings, and the same errno-carrying errors.
 * Nothing it stores ever reaches a disk.
 *
 * That makes it useful wherever a real filesystem is inconvenient — tests that
 * would otherwise need a temp directory, staging a tree before committing it,
 * or any caller written against `FileSystem` that needs an isolated instance.
 *
 * ```ts no_run
 * import { MemoryFileSystem } from 'fino:file/memory';
 *
 * const fs = new MemoryFileSystem({ '/etc/app.conf': 'debug=true' });
 * console.log(new TextDecoder().decode(await fs.readFile('/etc/app.conf')));
 * ```
 *
 * Parent directories of seeded files are created implicitly, which is what
 * makes a one-line constructor a usable tree. Directories created later follow
 * POSIX and require their parent to exist.
 *
 * Timestamps come from `Date.now()` by default. Pass a `now` function to make
 * them something else — a counter, for instance, so that two runs of the same
 * sequence of operations produce identical metadata.
 */
import {
  DT_DIR,
  DT_LNK,
  DT_REG,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  F_OK,
  R_OK,
  W_OK,
  X_OK,
} from '../internal/file/bindings.ts';
import { DirEntry, Entry, FileEntry } from '../internal/file/entry.ts';
import { FileSystem, type ByteWriter, type FileHandle } from '../internal/file/provider.ts';
import { Stat } from '../internal/file/stat.ts';
import { Path } from './path.ts';
export { F_OK, R_OK, W_OK, X_OK };
/**
 * Settings for a `MemoryFileSystem`.
 */
export interface MemoryFileSystemOptions {
  /**
   * Files to seed the tree with, by absolute path. Parent directories are
   * created as needed.
   */
  files?: Record<string, string | Uint8Array>;
  /**
   * Source of timestamps, in milliseconds. Defaults to `Date.now`.
   *
   * A monotonic counter here makes metadata reproducible across repeated runs
   * of the same operation sequence.
   */
  now?: () => number;
  /**
   * Permission bits reported for seeded and created files. Defaults to `0o644`.
   */
  fileMode?: number;
  /**
   * Permission bits reported for directories. Defaults to `0o755`.
   */
  dirMode?: number;
}
interface Node {
  kind: 'file' | 'dir' | 'link';
  data: Uint8Array;
  target: string;
  mode: number;
  uid: number;
  gid: number;
  ino: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}
interface ErrnoError extends Error {
  code?: string;
  syscall?: string;
  path?: string;
}
/**
 * Build an error shaped like the ones `DiskFileSystem` raises, so callers that
 * branch on `err.code` behave the same against either provider.
 */
function fail(syscall: string, path: string, code: string): never {
  const err: ErrnoError = new Error(`${syscall}('${path}'): ${code}`);
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  throw err;
}
/** Collapse `.`, `..`, and repeated separators onto one absolute spelling. */
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}
function nameOf(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}
function joinChild(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}
function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
/** How many links a path walk will follow before declaring a cycle. */
const SYMLINK_DEPTH = 40;
/**
 * A filesystem whose entire contents live in this isolate's heap.
 *
 * Construction seeds the tree; everything after that goes through the ordinary
 * provider methods. Instances are independent — two `MemoryFileSystem`s share
 * nothing, which is what makes one per test safe to use in parallel.
 *
 * ```ts no_run
 * import { MemoryFileSystem } from 'fino:file/memory';
 *
 * const fs = new MemoryFileSystem();
 * await fs.mkdir('/work');
 * await fs.writeFile('/work/notes.txt', new TextEncoder().encode('hello'));
 * const dir = await fs.dir('/work');
 * for (const entry of await dir.entries()) console.log(entry.name);
 * ```
 */
export class MemoryFileSystem extends FileSystem {
  #nodes = new Map<string, Node>();
  #now: () => number;
  #fileMode: number;
  #dirMode: number;
  #nextIno = 1;
  constructor(
    files: Record<string, string | Uint8Array> | MemoryFileSystemOptions = {},
    options: MemoryFileSystemOptions = {},
  ) {
    super();
    // Seeding a tree is the overwhelmingly common construction, so the bare
    // record form is accepted directly rather than nested under a key.
    const settings = isOptions(files) ? files : { ...options, files };
    this.#now = settings.now ?? Date.now;
    this.#fileMode = settings.fileMode ?? 0o644;
    this.#dirMode = settings.dirMode ?? 0o755;
    this.#nodes.set('/', this.#node('dir'));
    for (const [path, contents] of Object.entries(settings.files ?? {})) {
      const p = normalize(path);
      this.#ensureDirs(parentOf(p));
      this.#nodes.set(p, { ...this.#node('file'), data: toBytes(contents) });
    }
  }
  #node(kind: Node['kind']): Node {
    const stamp = this.#now();
    return {
      kind,
      data: new Uint8Array(),
      target: '',
      mode: kind === 'dir' ? this.#dirMode : kind === 'link' ? 0o777 : this.#fileMode,
      uid: 0,
      gid: 0,
      ino: this.#nextIno++,
      atimeMs: stamp,
      mtimeMs: stamp,
      ctimeMs: stamp,
      birthtimeMs: stamp,
    };
  }
  #ensureDirs(path: string): void {
    if (this.#nodes.has(path)) return;
    if (path !== '/') this.#ensureDirs(parentOf(path));
    this.#nodes.set(path, this.#node('dir'));
  }
  #touch(path: string): void {
    const node = this.#nodes.get(path);
    if (node === undefined) return;
    node.mtimeMs = node.ctimeMs = node.atimeMs = this.#now();
  }
  /**
   * Walk `path` one component at a time, expanding symlinks along the way.
   *
   * Intermediate links are always followed — a link in the middle of a path is
   * a directory reference, not the thing being addressed. `follow` decides only
   * what happens when the final component is itself a link, which is the whole
   * difference between `stat` and `lstat`.
   */
  #resolve(syscall: string, path: string, follow: boolean, depth = 0): string {
    if (depth > SYMLINK_DEPTH) fail(syscall, path, 'ELOOP');
    const target = normalize(path);
    if (target === '/') return '/';
    const parent = this.#resolve(syscall, parentOf(target), true, depth + 1);
    const resolved = joinChild(parent, nameOf(target));
    const node = this.#nodes.get(resolved);
    if (node?.kind !== 'link' || !follow) return resolved;
    const linked = node.target.startsWith('/')
      ? node.target
      : joinChild(parentOf(resolved), node.target);
    return this.#resolve(syscall, linked, true, depth + 1);
  }
  #lookup(syscall: string, path: string, follow: boolean): [string, Node] {
    const resolved = this.#resolve(syscall, path, follow);
    const node = this.#nodes.get(resolved);
    if (node === undefined) fail(syscall, path, 'ENOENT');
    return [resolved, node];
  }
  #statOf(node: Node): Stat {
    const type = node.kind === 'dir' ? S_IFDIR : node.kind === 'link' ? S_IFLNK : S_IFREG;
    const size =
      node.kind === 'file' ? node.data.length : node.kind === 'link' ? node.target.length : 0;
    return new Stat(
      0,
      node.ino,
      type | node.mode,
      1,
      node.uid,
      node.gid,
      0,
      size,
      4096,
      Math.ceil(size / 512),
      node.atimeMs,
      node.mtimeMs,
      node.ctimeMs,
      node.birthtimeMs,
    );
  }
  #childNames(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names: string[] = [];
    for (const candidate of this.#nodes.keys()) {
      if (candidate === dir || !candidate.startsWith(prefix)) continue;
      if (candidate.indexOf('/', prefix.length) !== -1) continue;
      names.push(candidate.slice(prefix.length));
    }
    return names.sort();
  }
  /**
   * Stat a path, following symlinks.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * console.log((await fs.stat('/a.txt')).size); // 2
   * ```
   */
  async stat(path: Path | string): Promise<Stat> {
    return this.statSync(path);
  }
  /**
   * Synchronous `stat`. Always available: there is no I/O to await.
   */
  statSync(path: Path | string): Stat {
    return this.#statOf(this.#lookup('stat', String(path), true)[1]);
  }
  /**
   * Stat a path without following symlinks.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * console.log((await fs.lstat('/a.txt')).isSymlink()); // false
   * ```
   */
  async lstat(path: Path | string): Promise<Stat> {
    return this.#statOf(this.#lookup('lstat', String(path), false)[1]);
  }
  /**
   * Open a file and return a handle.
   *
   * Supports the same modes as `DiskFileSystem`: `r`, `r+`, `w`, `w+`, `a`,
   * `a+`, the internal `c+`, and an `x` suffix for exclusive creation.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem();
   * const file = await fs.open('/log.txt', 'w');
   * await file.pwrite(0, new TextEncoder().encode('ready\n'));
   * await file.close();
   * ```
   */
  async open(path: Path | string, mode: string = 'r'): Promise<FileHandle> {
    return this.openSync(path, mode);
  }
  /**
   * Synchronous `open`, for callers such as the SQLite VFS that cannot await.
   */
  openSync(path: Path | string, mode: string = 'r'): FileHandle {
    const requested = String(path);
    const base = mode.replace('x', '');
    if (!['r', 'r+', 'w', 'w+', 'a', 'a+', 'c+'].includes(base)) {
      fail('open', requested, 'EINVAL');
    }
    const resolved = this.#resolve('open', requested, true);
    const existing = this.#nodes.get(resolved);
    if (existing?.kind === 'dir' && base !== 'r') fail('open', requested, 'EISDIR');
    if (existing !== undefined && mode.includes('x')) fail('open', requested, 'EEXIST');
    if (existing === undefined) {
      if (base === 'r' || base === 'r+') fail('open', requested, 'ENOENT');
      if (this.#nodes.get(parentOf(resolved))?.kind !== 'dir') fail('open', requested, 'ENOENT');
      this.#nodes.set(resolved, this.#node('file'));
    } else if (base === 'w' || base === 'w+') {
      existing.data = new Uint8Array();
      this.#touch(resolved);
    }
    return new MemoryFile(this, resolved, base !== 'r', base === 'a' || base === 'a+');
  }
  /**
   * Open a directory handle.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/work/a.txt': '' });
   * const dir = await fs.dir('/work');
   * console.log((await dir.entries()).length); // 1
   * ```
   */
  async dir(path: Path | string): Promise<DirEntry> {
    const p = Path.from(path);
    const [, node] = this.#lookup('opendir', String(path), true);
    if (node.kind !== 'dir') fail('opendir', String(path), 'ENOTDIR');
    return new DirEntry(p.basename(), p, this, DT_DIR);
  }
  /**
   * Build an `Entry` for any path, without following a trailing symlink.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * console.log((await fs.entry('/a.txt')).isFile()); // true
   * ```
   */
  async entry(path: Path | string): Promise<Entry> {
    const p = Path.from(path);
    const [, node] = this.#lookup('lstat', String(path), false);
    if (node.kind === 'dir') return new DirEntry(p.basename(), p, this, DT_DIR);
    if (node.kind === 'link') return new Entry(p.basename(), p, this, DT_LNK);
    return new FileEntry(p.basename(), p, this, DT_REG);
  }
  /**
   * List a directory's immediate children.
   *
   * `DirEntry` iteration goes through this, which is how listings work without
   * a real directory stream underneath.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/work/a.txt': '' });
   * console.log((await fs.readdir('/work')).map((e) => e.name)); // ['a.txt']
   * ```
   */
  async readdir(path: Path | string): Promise<Entry[]> {
    const [resolved, node] = this.#lookup('readdir', String(path), true);
    if (node.kind !== 'dir') fail('readdir', String(path), 'ENOTDIR');
    const base = Path.from(resolved);
    return this.#childNames(resolved).map((name) => {
      const child = this.#nodes.get(joinChild(resolved, name))!;
      const childPath = base.join(name);
      if (child.kind === 'dir') return new DirEntry(name, childPath, this, DT_DIR);
      if (child.kind === 'link') return new Entry(name, childPath, this, DT_LNK);
      return new FileEntry(name, childPath, this, DT_REG);
    });
  }
  /**
   * Create a directory. The parent must already exist.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem();
   * await fs.mkdir('/work', 0o700);
   * ```
   */
  async mkdir(path: Path | string, mode: number = 0o755): Promise<void> {
    const resolved = this.#resolve('mkdir', String(path), false);
    if (this.#nodes.has(resolved)) fail('mkdir', String(path), 'EEXIST');
    if (this.#nodes.get(parentOf(resolved))?.kind !== 'dir') fail('mkdir', String(path), 'ENOENT');
    this.#nodes.set(resolved, { ...this.#node('dir'), mode });
  }
  /**
   * Remove an empty directory.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem();
   * await fs.mkdir('/scratch');
   * await fs.rmdir('/scratch');
   * ```
   */
  async rmdir(path: Path | string): Promise<void> {
    const [resolved, node] = this.#lookup('rmdir', String(path), true);
    if (node.kind !== 'dir') fail('rmdir', String(path), 'ENOTDIR');
    if (resolved === '/') fail('rmdir', String(path), 'EBUSY');
    if (this.#childNames(resolved).length > 0) fail('rmdir', String(path), 'ENOTEMPTY');
    this.#nodes.delete(resolved);
  }
  /**
   * Delete a file or symlink.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.unlink('/a.txt');
   * ```
   */
  async unlink(path: Path | string): Promise<void> {
    this.unlinkSync(path);
  }
  /**
   * Synchronous `unlink`.
   */
  unlinkSync(path: Path | string): void {
    const [resolved, node] = this.#lookup('unlink', String(path), false);
    if (node.kind === 'dir') fail('unlink', String(path), 'EISDIR');
    this.#nodes.delete(resolved);
  }
  /**
   * Rename a file or directory, moving any subtree with it.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.rename('/a.txt', '/b.txt');
   * ```
   */
  async rename(oldPath: Path | string, newPath: Path | string): Promise<void> {
    const [from, node] = this.#lookup('rename', String(oldPath), false);
    const to = this.#resolve('rename', String(newPath), false);
    if (from === to) return;
    if (this.#nodes.get(parentOf(to))?.kind !== 'dir') fail('rename', String(newPath), 'ENOENT');
    if (node.kind === 'dir' && to.startsWith(`${from}/`)) {
      fail('rename', String(newPath), 'EINVAL');
    }
    const prefix = `${from}/`;
    for (const [path, moving] of [...this.#nodes]) {
      if (path !== from && !path.startsWith(prefix)) continue;
      this.#nodes.delete(path);
      this.#nodes.set(path === from ? to : `${to}${path.slice(from.length)}`, moving);
    }
    this.#touch(to);
  }
  /**
   * Read a symlink's target.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.symlink('/a.txt', '/link');
   * console.log(await fs.readlink('/link')); // '/a.txt'
   * ```
   */
  async readlink(path: Path | string): Promise<string> {
    const [, node] = this.#lookup('readlink', String(path), false);
    if (node.kind !== 'link') fail('readlink', String(path), 'EINVAL');
    return node.target;
  }
  /**
   * Create a symlink at `linkpath` pointing at `target`.
   *
   * The target is stored verbatim and resolved on use, so a link may be created
   * before the thing it names, exactly as on disk.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem();
   * await fs.symlink('/not-yet', '/link');
   * ```
   */
  async symlink(target: Path | string, linkpath: Path | string): Promise<void> {
    const resolved = this.#resolve('symlink', String(linkpath), false);
    if (this.#nodes.has(resolved)) fail('symlink', String(linkpath), 'EEXIST');
    if (this.#nodes.get(parentOf(resolved))?.kind !== 'dir') {
      fail('symlink', String(linkpath), 'ENOENT');
    }
    this.#nodes.set(resolved, { ...this.#node('link'), target: String(target) });
  }
  /**
   * Create a hard link. The two paths then hold the same node.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.link('/a.txt', '/b.txt');
   * ```
   */
  async link(existingPath: Path | string, newPath: Path | string): Promise<void> {
    const [, node] = this.#lookup('link', String(existingPath), true);
    if (node.kind === 'dir') fail('link', String(existingPath), 'EPERM');
    const resolved = this.#resolve('link', String(newPath), false);
    if (this.#nodes.has(resolved)) fail('link', String(newPath), 'EEXIST');
    this.#nodes.set(resolved, node);
  }
  /**
   * Resolve a path to its canonical form, expanding every symlink.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a/b.txt': 'hi' });
   * console.log(await fs.realpath('/a/./b.txt')); // '/a/b.txt'
   * ```
   */
  async realpath(path: Path | string): Promise<string> {
    return this.#lookup('realpath', String(path), true)[0];
  }
  /**
   * Check a path exists, and optionally that its permission bits allow a mode.
   *
   * ```ts no_run
   * import { MemoryFileSystem, F_OK } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.access('/a.txt', F_OK);
   * ```
   */
  async access(path: Path | string, mode: number = F_OK): Promise<void> {
    const [, node] = this.#lookup('access', String(path), true);
    const wanted =
      ((mode & R_OK) !== 0 ? 0o444 : 0) |
      ((mode & W_OK) !== 0 ? 0o222 : 0) |
      ((mode & X_OK) !== 0 ? 0o111 : 0);
    if ((node.mode & wanted) !== wanted) fail('access', String(path), 'EACCES');
  }
  /**
   * Change a path's permission bits.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.chmod('/a.txt', 0o600);
   * ```
   */
  async chmod(path: Path | string, mode: number): Promise<void> {
    const [, node] = this.#lookup('chmod', String(path), true);
    node.mode = mode & 0o7777;
    node.ctimeMs = this.#now();
  }
  /**
   * Change a path's owner and group.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.chown('/a.txt', 501, 20);
   * ```
   */
  async chown(path: Path | string, uid: number, gid: number): Promise<void> {
    const [, node] = this.#lookup('chown', String(path), true);
    node.uid = uid;
    node.gid = gid;
    node.ctimeMs = this.#now();
  }
  /**
   * Set a path's access and modification times.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.utimes('/a.txt', 0, 0);
   * ```
   */
  async utimes(path: Path | string, atime: Date | number, mtime: Date | number): Promise<void> {
    const [, node] = this.#lookup('utimes', String(path), true);
    node.atimeMs = atime instanceof Date ? atime.getTime() : atime * 1000;
    node.mtimeMs = mtime instanceof Date ? mtime.getTime() : mtime * 1000;
  }
  /**
   * Set a file's size, zero-filling any extension.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hello' });
   * await fs.truncate('/a.txt', 2);
   * ```
   */
  async truncate(path: Path | string, size = 0): Promise<void> {
    const [resolved, node] = this.#lookup('truncate', String(path), true);
    if (node.kind !== 'file') fail('truncate', String(path), 'EISDIR');
    node.data = resize(node.data, size);
    this.#touch(resolved);
  }
  /**
   * Copy a file's contents to another path.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * await fs.copyFile('/a.txt', '/b.txt');
   * ```
   */
  async copyFile(src: Path | string, dest: Path | string): Promise<void> {
    const [, node] = this.#lookup('copyfile', String(src), true);
    if (node.kind !== 'file') fail('copyfile', String(src), 'EISDIR');
    const resolved = this.#resolve('copyfile', String(dest), true);
    if (this.#nodes.get(parentOf(resolved))?.kind !== 'dir') {
      fail('copyfile', String(dest), 'ENOENT');
    }
    this.#nodes.set(resolved, { ...this.#node('file'), data: node.data.slice(), mode: node.mode });
  }
  /**
   * Every file's contents as text, keyed by path.
   *
   * Handy for asserting on what a run wrote without walking the tree.
   *
   * ```ts no_run
   * import { MemoryFileSystem } from 'fino:file/memory';
   *
   * const fs = new MemoryFileSystem({ '/a.txt': 'hi' });
   * console.log(fs.snapshot()); // { '/a.txt': 'hi' }
   * ```
   */
  snapshot(): Record<string, string> {
    const decoder = new TextDecoder();
    const out: Record<string, string> = {};
    for (const [path, node] of this.#nodes) {
      if (node.kind === 'file') out[path] = decoder.decode(node.data);
    }
    return out;
  }
  /**
   * Read a node's bytes, for `MemoryFile`.
   *
   * @internal
   */
  _bytes(path: string): Uint8Array {
    const node = this.#nodes.get(path);
    if (node === undefined) fail('read', path, 'ENOENT');
    return node.data;
  }
  /**
   * Replace a node's bytes, for `MemoryFile`.
   *
   * @internal
   */
  _setBytes(path: string, data: Uint8Array): void {
    const node = this.#nodes.get(path);
    if (node === undefined) fail('write', path, 'ENOENT');
    node.data = data;
    node.mtimeMs = node.ctimeMs = this.#now();
  }
}
function isOptions(
  value: Record<string, string | Uint8Array> | MemoryFileSystemOptions,
): value is MemoryFileSystemOptions {
  const candidate = value as MemoryFileSystemOptions;
  return (
    candidate.files !== undefined ||
    candidate.now !== undefined ||
    candidate.fileMode !== undefined ||
    candidate.dirMode !== undefined
  );
}
function resize(data: Uint8Array, size: number): Uint8Array {
  if (size === data.length) return data;
  if (size < data.length) return data.slice(0, size);
  const grown = new Uint8Array(size);
  grown.set(data, 0);
  return grown;
}
/**
 * An open handle onto a `MemoryFileSystem` file.
 *
 * Reads and writes go straight to the stored bytes, so every operation has a
 * synchronous variant — which is what lets an in-memory tree back integrations
 * such as the SQLite VFS that cannot await inside their callbacks.
 */
class MemoryFile implements FileHandle {
  #fs: MemoryFileSystem;
  #path: Path;
  #key: string;
  #writable: boolean;
  #append: boolean;
  #closed = false;
  constructor(fs: MemoryFileSystem, path: string, writable: boolean, append: boolean) {
    this.#fs = fs;
    this.#path = Path.from(path);
    this.#key = path;
    this.#writable = writable;
    this.#append = append;
  }
  get path(): Path {
    return this.#path;
  }
  get closed(): boolean {
    return this.#closed;
  }
  #assertOpen(): void {
    if (this.#closed) fail('fstat', this.#key, 'EBADF');
  }
  #assertWritable(): void {
    this.#assertOpen();
    if (!this.#writable) fail('write', this.#key, 'EBADF');
  }
  async stat(): Promise<Stat> {
    this.#assertOpen();
    return this.#fs.statSync(this.#key);
  }
  reader(): AsyncIterable<Uint8Array> {
    this.#assertOpen();
    const bytes = this.#fs._bytes(this.#key);
    return (async function* () {
      if (bytes.length > 0) yield bytes;
    })();
  }
  writer(): ByteWriter {
    this.#assertWritable();
    return {
      write: (data: Uint8Array | string) => {
        this.#assertWritable();
        this.#fs._setBytes(this.#key, concat(this.#fs._bytes(this.#key), toBytes(data)));
      },
      flush: async () => {},
      close: async () => {},
    };
  }
  async bytes(): Promise<Uint8Array> {
    this.#assertOpen();
    return this.#fs._bytes(this.#key);
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }
  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    return this.preadSync(pos, len);
  }
  preadSync(pos: number | bigint, len: number): Uint8Array {
    this.#assertOpen();
    const start = Number(pos);
    return this.#fs._bytes(this.#key).slice(start, start + len);
  }
  async pwrite(pos: number | bigint, data: Uint8Array): Promise<number> {
    return this.pwriteSync(pos, data);
  }
  pwriteSync(pos: number | bigint, data: Uint8Array): number {
    this.#assertWritable();
    const current = this.#fs._bytes(this.#key);
    // An append-mode handle ignores the offset, matching O_APPEND.
    const start = this.#append ? current.length : Number(pos);
    const next = resize(current, Math.max(current.length, start + data.length));
    next.set(data, start);
    this.#fs._setBytes(this.#key, next);
    return data.length;
  }
  async sync(): Promise<void> {
    this.#assertOpen();
  }
  syncSync(): void {
    this.#assertOpen();
  }
  async truncate(len: number | bigint): Promise<void> {
    this.truncateSync(len);
  }
  truncateSync(len: number | bigint): void {
    this.#assertWritable();
    this.#fs._setBytes(this.#key, resize(this.#fs._bytes(this.#key), Number(len)));
  }
  async size(): Promise<bigint> {
    return this.sizeSync();
  }
  sizeSync(): bigint {
    this.#assertOpen();
    return BigInt(this.#fs._bytes(this.#key).length);
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
  closeSync(): void {
    this.#closed = true;
  }
}
