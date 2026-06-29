/**
* Virtualization tests for fino:database/sqlite.
*
* Proves that sqlite I/O flows through the FileSystem abstraction, not raw
* file paths. Three subtests:
*
* 1. Child realm with a Facade restricting fino:file to a specific path
* 2. Child realm with fino:database/sqlite entirely blocked via ImportMap.deny
* 3. In-memory FileSystem — the load-bearing test. Opens a Database backed
*    by a pure JS MemoryFileSystem, inserts + selects rows. No disk access.
*/
import { describe, it } from 'fino:test/test';
import { sqliteAvailable, Database } from 'fino:database/sqlite';
import { Pointer } from 'fino:ffi';
import { cstr, requireSqlite, SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, SQLITE_FCNTL_DATA_VERSION, SQLITE_FCNTL_HAS_MOVED, SQLITE_FCNTL_LOCKSTATE, SQLITE_FCNTL_MMAP_SIZE, SQLITE_FCNTL_PERSIST_WAL, SQLITE_FCNTL_POWERSAFE_OVERWRITE, SQLITE_FCNTL_PRAGMA, SQLITE_FCNTL_SIZE_HINT, SQLITE_IOERR_TRUNCATE, SQLITE_LOCK_NONE, SQLITE_NOTFOUND, SQLITE_OK } from 'internal:database/sqlite/bindings';
import type { FileSystem, FileHandle } from 'internal:file/provider';
import type { Stat } from 'internal:file/stat';
import type { Path } from 'internal:file/path';
if (!sqliteAvailable) {
  if (process.env['FINO_REQUIRE_SQLITE'] === '1') {
    throw new Error('libsqlite3 not found and FINO_REQUIRE_SQLITE=1');
  }
  console.log('SKIP: libsqlite3 not found');
  process.exit(0);
}
// ---------------------------------------------------------------------------
// Minimal MemoryFileSystem — knows nothing about sqlite
// ---------------------------------------------------------------------------
class MemoryFileHandle implements FileHandle {
  #store: {
    data: Uint8Array;
  };
  #path: string;
  #closed = false;
  constructor(store: {
    data: Uint8Array;
  }, path: string) {
    this.#store = store;
    this.#path = path;
  }
  get path() {
    return (this.#path as unknown) as Path;
  }
  get closed() {
    return this.#closed;
  }
  get storeForTest() {
    return this.#store;
  }
  async stat(): Promise<Stat> {
    return ({
      size: this.#store.data.byteLength,
      mtime: 0,
      atime: 0,
      ctime: 0,
      mode: 420,
      ino: 0,
      dev: 0,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      blksize: 4096,
      blocks: 0
    } as unknown) as Stat;
  }
  reader(): AsyncIterable<Uint8Array> {
    throw new Error('not implemented');
  }
  writer() {
    throw new Error('not implemented');
  }
  async bytes() {
    return this.#store.data.slice();
  }
  async text() {
    return new TextDecoder().decode(this.#store.data);
  }
  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    return this.preadSync(pos, len);
  }
  preadSync(pos: number | bigint, len: number): Uint8Array {
    const off = Number(pos);
    const data = this.#store.data;
    const end = Math.min(off + len, data.byteLength);
    if (off >= data.byteLength) return new Uint8Array(0);
    return data.slice(off, end);
  }
  async pwrite(pos: number | bigint, src: Uint8Array): Promise<number> {
    return this.pwriteSync(pos, src);
  }
  pwriteSync(pos: number | bigint, src: Uint8Array): number {
    const off = Number(pos);
    const needed = off + src.byteLength;
    const current = this.#store.data;
    if (needed > current.byteLength) {
      const grown = new Uint8Array(needed);
      grown.set(current);
      this.#store.data = grown;
    }
    this.#store.data.set(src, off);
    return src.byteLength;
  }
  async sync(): Promise<void> {}
  syncSync(): void {}
  async truncate(len: number | bigint): Promise<void> {
    this.truncateSync(len);
  }
  truncateSync(len: number | bigint): void {
    const n = Number(len);
    if (n < this.#store.data.byteLength) {
      this.#store.data = this.#store.data.slice(0, n);
    } else if (n > this.#store.data.byteLength) {
      const grown = new Uint8Array(n);
      grown.set(this.#store.data);
      this.#store.data = grown;
    }
  }
  async size(): Promise<bigint> {
    return this.sizeSync();
  }
  sizeSync(): bigint {
    return BigInt(this.#store.data.byteLength);
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
  closeSync(): void {
    this.#closed = true;
  }
}
class MemoryFileSystem {
  #files: Map<string, {
    data: Uint8Array;
  }> = new Map();
  async stat(path: string | Path) {
    return this.statSync(path);
  }
  statSync(path: string | Path): Stat {
    const p = String(path);
    if (!this.#files.has(p)) throw new Error(`ENOENT: ${p}`);
    return ({} as unknown) as Stat;
  }
  async lstat(path: string | Path) {
    return this.stat(path);
  }
  async open(path: string | Path, mode = 'r'): Promise<FileHandle> {
    return this.openSync(path, mode);
  }
  openSync(path: string | Path, mode = 'r'): FileHandle {
    const p = String(path);
    switch (mode) {
      case 'r':
      case 'r+':
        if (!this.#files.has(p)) throw new Error(`ENOENT: ${p}`);
        break;
      case 'w':
      case 'w+':
        this.#files.set(p, { data: new Uint8Array(0) });
        break;
      case 'a':
      case 'a+':
      case 'c+':
        if (!this.#files.has(p)) this.#files.set(p, { data: new Uint8Array(0) });
        break;
      default: throw new Error(`Unknown file mode: '${mode}'`);
    }
    const store = this.#files.get(p)!;
    return new MemoryFileHandle(store, p);
  }
  async dir() {
    throw new Error('not implemented');
  }
  async entry() {
    throw new Error('not implemented');
  }
  async mkdir() {}
  async rmdir() {}
  async unlink(path: string | Path) {
    this.#files.delete(String(path));
  }
  unlinkSync(path: string | Path): void {
    this.#files.delete(String(path));
  }
  async rename(src: string | Path, dst: string | Path) {
    const s = String(src), d = String(dst);
    const store = this.#files.get(s);
    if (!store) throw new Error(`ENOENT: ${s}`);
    this.#files.set(d, store);
    this.#files.delete(s);
  }
  async readlink() {
    throw new Error('not implemented');
  }
  async symlink() {
    throw new Error('not implemented');
  }
  async realpath(path: string | Path) {
    return String(path);
  }
}
class FailingSyncFileHandle extends MemoryFileHandle {
  #failure: 'sync' | 'truncate' | 'write';
  constructor(store: {
    data: Uint8Array;
  }, path: string, failure: 'sync' | 'truncate' | 'write') {
    super(store, path);
    this.#failure = failure;
  }
  override pwriteSync(pos: number | bigint, src: Uint8Array): number {
    if (this.#failure === 'write') throw new Error('injected pwrite failure');
    return super.pwriteSync(pos, src);
  }
  override syncSync(): void {
    if (this.#failure === 'sync') throw new Error('injected sync failure');
    super.syncSync();
  }
  override truncateSync(len: number | bigint): void {
    if (this.#failure === 'truncate') throw new Error('injected truncate failure');
    super.truncateSync(len);
  }
}
class FailingSyncFileSystem extends MemoryFileSystem {
  #failure: 'sync' | 'truncate' | 'write';
  constructor(failure: 'sync' | 'truncate' | 'write') {
    super();
    this.#failure = failure;
  }
  override openSync(path: string | Path, mode = 'r'): FileHandle {
    const handle = super.openSync(path, mode) as MemoryFileHandle;
    return new FailingSyncFileHandle(handle.storeForTest, String(path), this.#failure);
  }
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('fino:database/sqlite — in-memory FileSystem (virtualization)', () => {
  it('insert + select round-trip through pure JS MemoryFileSystem', async (t) => {
    const memFs = new MemoryFileSystem();
    const db = await Database.open('/test.db', { fs: (memFs as unknown) as FileSystem });
    await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
    const ins = db.prepare('INSERT INTO items VALUES (?, ?)');
    await ins.run(1n, 'alpha');
    await ins.run(2n, 'beta');
    await ins.run(3n, 'gamma');
    ins.finalize();
    const rows = await db.prepare('SELECT * FROM items ORDER BY id').all();
    t.equal(rows.length, 3, '3 rows');
    t.equal(rows[0]!['label'], 'alpha', 'first row');
    t.equal(rows[2]!['label'], 'gamma', 'third row');
    const count = await db.prepare('SELECT COUNT(*) AS n FROM items').get();
    t.equal(count!['n'], 3n, 'count is 3');
    await db.close();
    t.ok(true, 'closed cleanly');
  });
  it('transaction in MemoryFileSystem commits', async (t) => {
    const memFs = new MemoryFileSystem();
    const db = await Database.open('/test.db', { fs: (memFs as unknown) as FileSystem });
    await db.exec('CREATE TABLE t (v INTEGER)');
    await db.transaction(async () => {
      await db.exec('INSERT INTO t VALUES (10)');
      await db.exec('INSERT INTO t VALUES (20)');
    });
    const rows = await db.prepare('SELECT SUM(v) AS s FROM t').get();
    t.equal(rows!['s'], 30n, 'sum is 30');
    await db.close();
  });
  it('transaction rollback in MemoryFileSystem', async (t) => {
    const memFs = new MemoryFileSystem();
    const db = await Database.open('/test.db', { fs: (memFs as unknown) as FileSystem });
    await db.exec('CREATE TABLE t (v INTEGER)');
    try {
      await db.transaction(async () => {
        await db.exec('INSERT INTO t VALUES (99)');
        throw new Error('abort');
      });
    } catch {}
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM t').get();
    t.equal(rows!['n'], 0n, 'rolled back');
    await db.close();
  });
  it('persists data across reopen with the same MemoryFileSystem', async (t) => {
    const memFs = new MemoryFileSystem();
    const first = await Database.open('/persist.db', { fs: (memFs as unknown) as FileSystem });
    try {
      await first.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
      await first.prepare('INSERT INTO items VALUES (?, ?)').run(1n, 'saved');
    } finally {
      await first.close();
    }
    const second = await Database.open('/persist.db', { fs: (memFs as unknown) as FileSystem });
    try {
      const row = await second.prepare('SELECT label FROM items WHERE id = 1').get();
      t.equal(row!['label'], 'saved', 'reopened database reads persisted in-memory bytes');
    } finally {
      await second.close();
    }
  });
  it('reports VFS write failures as sqlite errors', async (t) => {
    const fs = new FailingSyncFileSystem('write');
    const db = await Database.open('/write-failure.db', { fs: (fs as unknown) as FileSystem });
    try {
      await t.rejects(() => db.exec('CREATE TABLE t (value TEXT)'), /sqlite3_exec|disk I\/O|I\/O|ioerr/i, 'pwrite failures reject the statement');
    } finally {
      await db.close();
    }
  });
  it('reports VFS sync failures as sqlite errors', async (t) => {
    const fs = new FailingSyncFileSystem('sync');
    const db = await Database.open('/sync-failure.db', { fs: (fs as unknown) as FileSystem });
    try {
      await t.rejects(async () => {
        await db.exec('PRAGMA synchronous = FULL');
        await db.exec('CREATE TABLE t (value TEXT)');
      }, /sqlite3_exec|disk I\/O|I\/O|ioerr/i, 'sync failures reject the statement');
    } finally {
      await db.close();
    }
  });
  it('reports VFS truncate failures as sqlite errors', async (t) => {
    const fs = new FailingSyncFileSystem('truncate');
    const db = await Database.open('/truncate-failure.db', { fs: (fs as unknown) as FileSystem });
    const s = requireSqlite().symbols;
    const main = cstr('main');
    const size = new ArrayBuffer(8);
    new DataView(size).setBigInt64(0, 8192n, true);
    try {
      await db.exec('CREATE TABLE t (value TEXT)');
      const rc = s.sqlite3_file_control(db.ptr, main, SQLITE_FCNTL_SIZE_HINT, Pointer.of(size)) as number;
      t.equal(rc, SQLITE_IOERR_TRUNCATE, 'truncate failures return SQLITE_IOERR_TRUNCATE');
    } finally {
      await db.close();
    }
  });
  it('supports deterministic VFS file controls', async (t) => {
    const memFs = new MemoryFileSystem();
    const db = await Database.open('/control.db', { fs: (memFs as unknown) as FileSystem });
    const s = requireSqlite().symbols;
    const main = cstr('main');
    const i32Arg = (value: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setInt32(0, value, true);
      return buf;
    };
    const i64Arg = (value: bigint) => {
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigInt64(0, value, true);
      return buf;
    };
    const control = (op: number, arg: ArrayBuffer) => s.sqlite3_file_control(db.ptr, main, op, Pointer.of(arg)) as number;
    try {
      let arg = i32Arg(-1);
      t.equal(control(SQLITE_FCNTL_LOCKSTATE, arg), SQLITE_OK, 'LOCKSTATE succeeds');
      t.equal(new DataView(arg).getInt32(0, true), SQLITE_LOCK_NONE, 'database starts unlocked');
      arg = i32Arg(1);
      t.equal(control(SQLITE_FCNTL_PERSIST_WAL, arg), SQLITE_OK, 'PERSIST_WAL set succeeds');
      arg = i32Arg(-1);
      t.equal(control(SQLITE_FCNTL_PERSIST_WAL, arg), SQLITE_OK, 'PERSIST_WAL query succeeds');
      t.equal(new DataView(arg).getInt32(0, true), 1, 'PERSIST_WAL query returns tracked value');
      arg = i32Arg(0);
      t.equal(control(SQLITE_FCNTL_POWERSAFE_OVERWRITE, arg), SQLITE_OK, 'POWERSAFE_OVERWRITE set succeeds');
      arg = i32Arg(-1);
      t.equal(control(SQLITE_FCNTL_POWERSAFE_OVERWRITE, arg), SQLITE_OK, 'POWERSAFE_OVERWRITE query succeeds');
      t.equal(new DataView(arg).getInt32(0, true), 0, 'POWERSAFE_OVERWRITE query returns tracked value');
      const mmap = i64Arg(-1n);
      t.equal(control(SQLITE_FCNTL_MMAP_SIZE, mmap), SQLITE_OK, 'MMAP_SIZE query succeeds');
      t.equal(new DataView(mmap).getBigInt64(0, true), 0n, 'MMAP_SIZE reports disabled mmap');
      arg = i32Arg(-1);
      t.equal(control(SQLITE_FCNTL_HAS_MOVED, arg), SQLITE_OK, 'HAS_MOVED succeeds');
      t.equal(new DataView(arg).getInt32(0, true), 0, 'open file has not moved');
      arg = i32Arg(0);
      t.equal(control(SQLITE_FCNTL_DATA_VERSION, arg), SQLITE_OK, 'DATA_VERSION initial query succeeds');
      const before = new DataView(arg).getInt32(0, true);
      await db.exec('CREATE TABLE vfs_data_version (value TEXT)');
      await db.exec('INSERT INTO vfs_data_version VALUES (\'changed\')');
      arg = i32Arg(0);
      t.equal(control(SQLITE_FCNTL_DATA_VERSION, arg), SQLITE_OK, 'DATA_VERSION second query succeeds');
      t.ok(new DataView(arg).getInt32(0, true) > before, 'DATA_VERSION advances after writes');
      arg = i32Arg(0);
      t.equal(control(SQLITE_FCNTL_BEGIN_ATOMIC_WRITE, arg), SQLITE_NOTFOUND, 'unsupported atomic writes return NOTFOUND');
      t.equal(control(SQLITE_FCNTL_PRAGMA, arg), SQLITE_NOTFOUND, 'unsupported PRAGMA control returns NOTFOUND');
      const pragma = await db.prepare('PRAGMA journal_mode').get();
      t.ok(typeof pragma!['journal_mode'] === 'string', 'normal PRAGMA handling still works');
    } finally {
      await db.close();
    }
  });
});
