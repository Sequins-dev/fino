/**
* Regression tests for sqlite concurrency:
*
* - interleaved statement execution on one connection (used to race
*   blocking-pool threads inside one sqlite3* and segfault or hang; now
*   serialized by the per-connection operation queue),
* - real advisory locking between connections (the VFS used to no-op
*   xLock/xUnlock),
* - file-backed sqlite inside a child realm (the FFI bridge used to attach
*   promise reactions in the wrong realm, deadlocking VFS trampolines).
*/
import { describe, it } from 'fino:test/test';
import { Database, sqliteAvailable } from 'fino:database/sqlite';
import { Realm } from 'fino:realm';
import { env, exit } from 'fino:process';
import type sqliteChildFn from './realm/fixtures/sqlite-child-fn.ts';

if (!sqliteAvailable) {
  if (env.FINO_REQUIRE_SQLITE === '1') throw new Error('sqlite required but unavailable');
  console.log('SKIP: sqlite unavailable');
  exit(0);
}

function tempPath(): string {
  return `/tmp/fino-sqlite-conc-${Math.floor(Math.random() * 1e9)}.db`;
}

describe('sqlite concurrency', () => {
  it('interleaves statements on one connection safely', async (t) => {
    await using db = await Database.open(tempPath());
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 50; i++) await ins.run(`row-${i}`);
    ins.finalize();
    const a = db.prepare('SELECT * FROM t WHERE id % 2 = 0');
    const b = db.prepare('SELECT * FROM t WHERE id % 2 = 1');
    const c = db.prepare('SELECT COUNT(*) AS n FROM t');
    const [ra, rb, rc] = await Promise.all([a.all(), b.all(), c.get()]);
    a.finalize();
    b.finalize();
    c.finalize();
    t.equal(ra.length, 25, 'even rows returned');
    t.equal(rb.length, 25, 'odd rows returned');
    t.equal(Number(rc!.n), 50, 'concurrent count saw all rows');
  });
  it('interleaves other work between iterate() steps', async (t) => {
    await using db = await Database.open(tempPath());
    await db.exec('CREATE TABLE t (v INTEGER)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 5; i++) await ins.run(i);
    ins.finalize();
    const counter = db.prepare('SELECT COUNT(*) AS n FROM t');
    const seen: number[] = [];
    const iterStmt = db.prepare('SELECT v FROM t ORDER BY v');
    for await (const row of iterStmt.iterate()) {
      seen.push(Number(row.v));
      const mid = await counter.get();
      t.equal(Number(mid!.n), 5, `count works mid-iteration at row ${row.v}`);
    }
    iterStmt.finalize();
    counter.finalize();
    t.deepEqual(seen, [0, 1, 2, 3, 4], 'iteration produced every row in order');
  });
  it('locks writers against each other across connections', async (t) => {
    const path = tempPath();
    await using a = await Database.open(path);
    await a.exec('PRAGMA busy_timeout=0');
    await a.exec('CREATE TABLE t (v INTEGER)');
    await using b = await Database.open(path);
    await b.exec('PRAGMA busy_timeout=0');
    await a.exec('BEGIN IMMEDIATE');
    await a.exec('INSERT INTO t (v) VALUES (1)');
    let blocked = false;
    try {
      await b.exec('BEGIN IMMEDIATE');
      await b.exec('ROLLBACK');
    } catch (err) {
      blocked = true;
      t.ok(/locked|busy/i.test(err instanceof Error ? err.message : ''), `second writer saw the lock: ${err instanceof Error ? err.message : err}`);
    }
    t.ok(blocked, 'concurrent write transaction was refused while the first held the lock');
    await a.exec('COMMIT');
    await b.exec('BEGIN IMMEDIATE');
    await b.exec('INSERT INTO t (v) VALUES (2)');
    await b.exec('COMMIT');
    const rows = await a.prepare('SELECT COUNT(*) AS n FROM t').all();
    t.equal(Number(rows[0]!.n), 2, 'both writes landed once the lock was released');
  });
  it('runs file-backed sqlite inside a child realm', async (t) => {
    const realm = new Realm<typeof sqliteChildFn>({
      entry: new URL('./realm/fixtures/sqlite-child-fn.ts', import.meta.url).pathname
    });
    const result = await realm.call(tempPath());
    t.equal(result, 42, 'child realm completed VFS-backed sqlite work');
  });
});
