import { describe, it } from 'fino:test/test';
import { Database, sqliteAvailable, vec, vecDecode } from 'fino:database/sqlite';

if (!sqliteAvailable) {
  console.log('SKIP: libsqlite3 not found (install via: brew install sqlite or apt install libsqlite3-0)');
  process.exit(0);
}

describe('fino:database/sqlite — basic', () => {
  it('opens and closes an in-memory database', async (t) => {
    const db = await Database.open(':memory:');
    t.ok(!db['#closed'], 'db should be open');  // just tests open() doesn't throw
    await db.close();
  });

  it('exec CREATE TABLE and INSERT', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await db.exec("INSERT INTO t VALUES (1, 'hello')");
    t.equal(db.changes, 1, 'one row inserted');
    await db.close();
  });

  it('prepare + run (positional params)', async (t) => {
    const db   = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
    const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
    const res  = await stmt.run(42n, 'world');
    t.equal(res.changes, 1, 'changes = 1');
    stmt.finalize();
    await db.close();
  });

  it('prepare + run (named params)', async (t) => {
    const db   = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
    const stmt = db.prepare('INSERT INTO t VALUES (:id, :val)');
    const res  = await stmt.run({ id: 1n, val: 'named' });
    t.equal(res.changes, 1, 'changes = 1');
    stmt.finalize();
    await db.close();
  });

  it('lastInsertRowid', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
    const stmt = db.prepare("INSERT INTO t (v) VALUES (?)");
    await stmt.run('a');
    t.ok(db.lastInsertRowid > 0n, 'lastInsertRowid should be positive');
    stmt.finalize();
    await db.close();
  });
});

describe('fino:database/sqlite — type round-trips', () => {
  it('NULL → null', async (t) => {
    const db  = await Database.open(':memory:');
    const row = await db.prepare('SELECT NULL AS v').get();
    t.equal(row!['v'], null, 'null round-trip');
    await db.close();
  });

  it('INTEGER → BigInt', async (t) => {
    const db  = await Database.open(':memory:');
    const row = await db.prepare('SELECT 9007199254740993 AS v').get();
    t.equal(row!['v'], 9007199254740993n, 'large int as BigInt');
    await db.close();
  });

  it('INTEGER → number (safeIntegers: false)', async (t) => {
    const db  = await Database.open(':memory:', { safeIntegers: false });
    const row = await db.prepare('SELECT 42 AS v').get();
    t.equal(row!['v'], 42, 'integer as number');
    await db.close();
  });

  it('REAL → number', async (t) => {
    const db  = await Database.open(':memory:');
    const row = await db.prepare('SELECT 3.14 AS v').get();
    t.ok(Math.abs((row!['v'] as number) - 3.14) < 1e-10, 'float round-trip');
    await db.close();
  });

  it('TEXT → string', async (t) => {
    const db  = await Database.open(':memory:');
    const row = await db.prepare("SELECT 'hello' AS v").get();
    t.equal(row!['v'], 'hello', 'text round-trip');
    await db.close();
  });

  it('BLOB → Uint8Array', async (t) => {
    const db    = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (v BLOB)');
    const data  = new Uint8Array([1, 2, 3, 4]);
    const stmt  = db.prepare('INSERT INTO t VALUES (?)');
    await stmt.run(data);
    stmt.finalize();
    const row = await db.prepare('SELECT v FROM t').get();
    const got = row!['v'] as Uint8Array;
    t.equal(got.byteLength, 4, 'blob length');
    t.deepEqual(Array.from(got), [1, 2, 3, 4], 'blob bytes');
    await db.close();
  });

  it('bound TEXT round-trips', async (t) => {
    const db   = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (v TEXT)');
    const stmt = db.prepare('INSERT INTO t VALUES (?)');
    await stmt.run('unicode: 🎉');
    stmt.finalize();
    const row = await db.prepare('SELECT v FROM t').get();
    t.equal(row!['v'], 'unicode: 🎉', 'unicode text round-trip');
    await db.close();
  });
});

describe('fino:database/sqlite — query methods', () => {
  async function setup() {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?)');
    await ins.run(1n, 'alice');
    await ins.run(2n, 'bob');
    await ins.run(3n, 'carol');
    ins.finalize();
    return db;
  }

  it('all() returns all rows', async (t) => {
    const db   = await setup();
    const rows = await db.prepare('SELECT * FROM t ORDER BY id').all();
    t.equal(rows.length, 3, '3 rows');
    t.equal(rows[0]!['name'], 'alice', 'first row');
    await db.close();
  });

  it('get() returns first row', async (t) => {
    const db  = await setup();
    const row = await db.prepare('SELECT * FROM t WHERE id = ?').get(2n);
    t.equal(row!['name'], 'bob', 'second row');
    await db.close();
  });

  it('get() returns undefined when no match', async (t) => {
    const db  = await setup();
    const row = await db.prepare('SELECT * FROM t WHERE id = ?').get(99n);
    t.equal(row, undefined, 'no match');
    await db.close();
  });

  it('iterate() yields each row', async (t) => {
    const db   = await setup();
    const names: string[] = [];
    for await (const row of db.prepare('SELECT name FROM t ORDER BY id').iterate()) {
      names.push(row['name'] as string);
    }
    t.deepEqual(names, ['alice', 'bob', 'carol'], 'iterate yields all rows');
    await db.close();
  });
});

describe('fino:database/sqlite — transactions', () => {
  it('commits on success', async (t) => {
    const db  = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (v INTEGER)');
    await db.transaction(async () => {
      await db.exec('INSERT INTO t VALUES (1)');
      await db.exec('INSERT INTO t VALUES (2)');
    });
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM t').get();
    t.equal(rows!['n'], 2n, 'both rows committed');
    await db.close();
  });

  it('rolls back on throw', async (t) => {
    const db  = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (v INTEGER)');
    try {
      await db.transaction(async () => {
        await db.exec('INSERT INTO t VALUES (1)');
        throw new Error('intentional rollback');
      });
    } catch {}
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM t').get();
    t.equal(rows!['n'], 0n, 'rolled back');
    await db.close();
  });
});

describe('fino:database/sqlite — Statement finalize', () => {
  it('finalize is idempotent', async (t) => {
    const db   = await Database.open(':memory:');
    const stmt = db.prepare('SELECT 1');
    stmt.finalize();
    stmt.finalize();  // should not throw
    t.ok(true, 'double finalize is safe');
    await db.close();
  });

  it('finalize without compiling is safe', async (t) => {
    const db   = await Database.open(':memory:');
    const stmt = db.prepare('SELECT 1');
    stmt.finalize();  // never compiled
    t.ok(true, 'finalize uncompiled statement is safe');
    await db.close();
  });
});

describe('fino:database/sqlite — vector helpers', () => {
  it('vec() encodes a float array as sqlite-vec text', (t) => {
    t.equal(vec([1.0, 2.0, 3.0]), '[1,2,3]', 'number[] encoding');
    t.equal(vec(new Float32Array([0.5, -1.0])), '[0.5,-1]', 'Float32Array encoding');
  });

  it('vecDecode() decodes a float32 blob', (t) => {
    const arr = new Float32Array([1.5, -2.5, 3.0]);
    const blob = new Uint8Array(arr.buffer);
    const decoded = vecDecode(blob);
    t.equal(decoded.length, 3, 'correct length');
    t.ok(Math.abs(decoded[0]! - 1.5) < 1e-6, 'first element');
    t.ok(Math.abs(decoded[1]! - (-2.5)) < 1e-6, 'second element');
  });
});
