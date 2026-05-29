/**
 * Virtualization tests for fino:sqlite.
 *
 * Proves that sqlite I/O flows through the FileSystem abstraction, not raw
 * file paths. Three subtests:
 *
 * 1. Child realm with a Facade restricting fino:file to a specific path
 * 2. Child realm with fino:sqlite entirely blocked via ImportMap.deny
 * 3. In-memory FileSystem — the load-bearing test. Opens a Database backed
 *    by a pure JS MemoryFileSystem, inserts + selects rows. No disk access.
 */

import { describe, it } from 'fino:test/test';
import { sqliteAvailable, Database } from 'fino:sqlite';
import type { FileSystem, FileHandle } from 'internal:file/provider';
import type { Stat } from 'internal:file/stat';
import type { Path } from 'internal:file/path';

if (!sqliteAvailable) {
  console.log('SKIP: libsqlite3 not found');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Minimal MemoryFileSystem — knows nothing about sqlite
// ---------------------------------------------------------------------------

class MemoryFileHandle implements FileHandle {
  #store: { data: Uint8Array };
  #path: string;
  #closed = false;

  constructor(store: { data: Uint8Array }, path: string) {
    this.#store = store;
    this.#path  = path;
  }

  get path() { return this.#path as unknown as Path; }
  get closed() { return this.#closed; }

  async stat(): Promise<Stat> {
    return { size: this.#store.data.byteLength, mtime: 0, atime: 0, ctime: 0, mode: 0o644, ino: 0, dev: 0, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 4096, blocks: 0 } as unknown as Stat;
  }

  reader(): AsyncIterable<Uint8Array> { throw new Error('not implemented'); }
  writer() { throw new Error('not implemented'); }
  async bytes() { return this.#store.data.slice(); }
  async text() { return new TextDecoder().decode(this.#store.data); }

  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    const off  = Number(pos);
    const data = this.#store.data;
    const end  = Math.min(off + len, data.byteLength);
    if (off >= data.byteLength) return new Uint8Array(0);
    return data.slice(off, end);
  }

  async pwrite(pos: number | bigint, src: Uint8Array): Promise<number> {
    const off     = Number(pos);
    const needed  = off + src.byteLength;
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

  async truncate(len: number | bigint): Promise<void> {
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
    return BigInt(this.#store.data.byteLength);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

class MemoryFileSystem {
  #files: Map<string, { data: Uint8Array }> = new Map();

  async stat(path: string | Path) {
    const p = String(path);
    if (!this.#files.has(p)) throw new Error(`ENOENT: ${p}`);
    return {} as unknown as Stat;
  }

  async lstat(path: string | Path) { return this.stat(path); }

  async open(path: string | Path, mode = 'r'): Promise<FileHandle> {
    const p = String(path);
    if (mode === 'r' || mode === 'r+') {
      if (!this.#files.has(p)) throw new Error(`ENOENT: ${p}`);
    }
    if (mode === 'a+' || mode === 'w+' || mode === 'w') {
      if (!this.#files.has(p)) this.#files.set(p, { data: new Uint8Array(0) });
    }
    const store = this.#files.get(p)!;
    return new MemoryFileHandle(store, p);
  }

  async dir()      { throw new Error('not implemented'); }
  async entry()    { throw new Error('not implemented'); }
  async mkdir()    {}
  async rmdir()    {}
  async unlink(path: string | Path) { this.#files.delete(String(path)); }
  async rename(src: string | Path, dst: string | Path) {
    const s = String(src), d = String(dst);
    const store = this.#files.get(s);
    if (!store) throw new Error(`ENOENT: ${s}`);
    this.#files.set(d, store);
    this.#files.delete(s);
  }
  async readlink() { throw new Error('not implemented'); }
  async symlink()  { throw new Error('not implemented'); }
  async realpath(path: string | Path) { return String(path); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fino:sqlite — in-memory FileSystem (virtualization)', () => {
  it('insert + select round-trip through pure JS MemoryFileSystem', async (t) => {
    const memFs = new MemoryFileSystem();
    const db    = await Database.open('/test.db', { fs: memFs as unknown as FileSystem });

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
    const db    = await Database.open('/test.db', { fs: memFs as unknown as FileSystem });
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
    const db    = await Database.open('/test.db', { fs: memFs as unknown as FileSystem });
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
});
