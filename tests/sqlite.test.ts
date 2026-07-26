import { describe, it } from 'fino:test/test';
import { Database, sqliteAvailable, vec, vecDecode } from 'fino:database/sqlite';
import { DiskFileSystem } from 'fino:file';
if (!sqliteAvailable) {
  if (process.env['FINO_REQUIRE_SQLITE'] === '1') {
    throw new Error('libsqlite3 not found and FINO_REQUIRE_SQLITE=1');
  }
  console.log(
    'SKIP: libsqlite3 not found (install via: brew install sqlite or apt install libsqlite3-0)',
  );
  process.exit(0);
}
describe('fino:database/sqlite — basic', () => {
  it('Database supports await using disposal', async (t) => {
    let dbRef: Database | null = null;
    {
      await using db = await Database.open(':memory:');
      await db.exec('CREATE TABLE scoped (value TEXT)');
      dbRef = db;
    }
    await t.rejects(
      () => dbRef!.exec('SELECT 1'),
      /closed/,
      'database closes when await using scope exits',
    );
  });
  it('opens and closes an in-memory database', async (t) => {
    const db = await Database.open(':memory:');
    t.ok(!db['#closed'], 'db should be open');
    await db.close();
  });
  it('exec CREATE TABLE and INSERT', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await db.exec("INSERT INTO t VALUES (1, 'hello')");
    t.equal(db.changes, 1, 'one row inserted');
    await db.close();
  });
  it('exec creates file-backed schema visible to later prepares', async (t) => {
    const fs = new DiskFileSystem();
    const dbPath = '/tmp/fino-sqlite-schema-' + Math.floor(Math.random() * 1e9) + '.db';
    try {
      await fs.unlink(dbPath);
    } catch {}
    const db = await Database.open(dbPath);
    try {
      await db.exec('CREATE TABLE modules (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      await db.exec('CREATE TABLE guides (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
      await db.exec(
        'CREATE TABLE symbols (id TEXT PRIMARY KEY, module_id TEXT NOT NULL, name TEXT NOT NULL)',
      );
      const row = await db
        .prepare(`
        SELECT COUNT(*) AS n
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('modules', 'guides', 'symbols')
      `)
        .get();
      t.equal(row!['n'], 3n, 'schema tables are visible on the same connection');
      await db
        .prepare('INSERT INTO symbols VALUES (?, ?, ?)')
        .run('symbol:one', 'module:one', 'one');
      const inserted = await db.prepare('SELECT name FROM symbols WHERE id = ?').get('symbol:one');
      t.equal(inserted!['name'], 'one', 'prepared insert can use file-backed schema');
    } finally {
      await db.close();
      try {
        await fs.unlink(dbPath);
      } catch {}
    }
  });
  it('readonly opens existing databases and rejects writes', async (t) => {
    const fs = new DiskFileSystem();
    const dbPath = '/tmp/fino-sqlite-readonly-' + Math.floor(Math.random() * 1e9) + '.db';
    try {
      await fs.unlink(dbPath);
    } catch {}
    const writable = await Database.open(dbPath);
    try {
      await writable.exec('CREATE TABLE t (value TEXT)');
      await writable.prepare('INSERT INTO t VALUES (?)').run('stored');
    } finally {
      await writable.close();
    }
    const readonly = await Database.open(dbPath, { readonly: true });
    try {
      const row = await readonly.prepare('SELECT value FROM t').get();
      t.equal(row!['value'], 'stored', 'readonly connection can read existing data');
      await t.rejects(
        () => readonly.exec("INSERT INTO t VALUES ('blocked')"),
        /readonly|attempt to write/i,
        'readonly connection rejects writes',
      );
    } finally {
      await readonly.close();
      try {
        await fs.unlink(dbPath);
      } catch {}
    }
  });
  it('readonly open rejects missing files', async (t) => {
    const fs = new DiskFileSystem();
    const dbPath = '/tmp/fino-sqlite-missing-readonly-' + Math.floor(Math.random() * 1e9) + '.db';
    try {
      await fs.unlink(dbPath);
    } catch {}
    await t.rejects(
      () => Database.open(dbPath, { readonly: true }),
      /open|unable|cannot|IOERR|ENOENT/i,
      'readonly mode does not create missing databases',
    );
  });
  it('closed database operations reject consistently', async (t) => {
    const db = await Database.open(':memory:');
    await db.close();
    await t.rejects(() => db.exec('SELECT 1'), /closed/i, 'exec rejects after close');
    t.throws(() => db.prepare('SELECT 1'), /closed/i, 'prepare rejects after close');
    await t.rejects(
      () => db.transaction(async () => {}),
      /closed/i,
      'transaction rejects after close',
    );
    t.throws(
      () => db.loadExtension('/definitely/missing.so'),
      /closed/i,
      'loadExtension rejects after close',
    );
    t.throws(() => db.vectorsAvailable, /closed/i, 'vectorsAvailable rejects after close');
  });
  it('prepare failures do not poison the connection', async (t) => {
    const db = await Database.open(':memory:');
    try {
      await t.rejects(
        () => db.prepare('SELECT * FROM').get(),
        /prepare|syntax|incomplete/i,
        'invalid SQL rejects during lazy prepare',
      );
      const row = await db.prepare('SELECT 42 AS value').get();
      t.equal(row!['value'], 42n, 'connection remains usable after prepare failure');
    } finally {
      await db.close();
    }
  });
  it('extension loading failures leave the connection usable', async (t) => {
    const db = await Database.open(':memory:');
    try {
      t.throws(
        () => db.loadExtension('/definitely/missing/fino-sqlite-extension.so'),
        /sqlite3_load_extension/i,
        'missing extension rejects with sqlite load error',
      );
      const row = await db.prepare('SELECT 1 AS ok').get();
      t.equal(row!['ok'], 1n, 'connection remains usable after load failure');
    } finally {
      await db.close();
    }
  });
  it('release baseline keeps convenience backup and busy-timeout APIs absent', async (t) => {
    const db = await Database.open(':memory:');
    try {
      const surface = db as unknown as Record<string, unknown>;
      for (const name of ['backup', 'serialize', 'deserialize', 'busyTimeout', 'setBusyTimeout']) {
        t.equal(surface[name], undefined, `${name} is not a public Database helper`);
      }
      await db.exec('PRAGMA busy_timeout = 25');
      const row = await db.prepare('PRAGMA busy_timeout').get();
      t.equal(row!['timeout'], 25n, 'SQLite-native busy_timeout remains available via PRAGMA');
    } finally {
      await db.close();
    }
  });
  it('vectorsAvailable is a cached boolean probe', async (t) => {
    const db = await Database.open(':memory:');
    try {
      const first = db.vectorsAvailable;
      const second = db.vectorsAvailable;
      t.equal(typeof first, 'boolean', 'probe returns a boolean');
      t.equal(second, first, 'probe result is cached');
    } finally {
      await db.close();
    }
  });
  it('separate file-backed connections observe committed writes', async (t) => {
    const fs = new DiskFileSystem();
    const dbPath = '/tmp/fino-sqlite-concurrent-' + Math.floor(Math.random() * 1e9) + '.db';
    try {
      await fs.unlink(dbPath);
    } catch {}
    const first = await Database.open(dbPath);
    const second = await Database.open(dbPath);
    try {
      await first.exec('CREATE TABLE t (value TEXT)');
      await first.prepare('INSERT INTO t VALUES (?)').run('visible');
      const row = await second.prepare('SELECT value FROM t').get();
      t.equal(row!['value'], 'visible', 'second connection sees committed write');
    } finally {
      await first.close();
      await second.close();
      try {
        await fs.unlink(dbPath);
      } catch {}
    }
  });
  it('prepare + run (positional params)', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
    const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
    const res = await stmt.run(42n, 'world');
    t.equal(res.changes, 1, 'changes = 1');
    stmt.finalize();
    await db.close();
  });
  it('prepare + run (named params)', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
    const stmt = db.prepare('INSERT INTO t VALUES (:id, :val)');
    const res = await stmt.run({
      id: 1n,
      val: 'named',
    });
    t.equal(res.changes, 1, 'changes = 1');
    stmt.finalize();
    await db.close();
  });
  it('rejects missing named parameters before binding', async (t) => {
    const db = await Database.open(':memory:');
    try {
      await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
      const stmt = db.prepare('INSERT INTO t VALUES (:id, :val)');
      await t.rejects(
        () => stmt.run({ id: 1n }),
        /missing named parameter.*val/i,
        'missing named parameter is rejected',
      );
      stmt.finalize();
    } finally {
      await db.close();
    }
  });
  it('rejects extra named parameters before binding', async (t) => {
    const db = await Database.open(':memory:');
    try {
      await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
      const stmt = db.prepare('INSERT INTO t VALUES (:id, :val)');
      await t.rejects(
        () =>
          stmt.run({
            id: 1n,
            val: 'ok',
            extra: 'unused',
          }),
        /extra named parameter.*extra/i,
        'extra named parameter is rejected',
      );
      stmt.finalize();
    } finally {
      await db.close();
    }
  });
  it('rejects too few positional parameters before binding', async (t) => {
    const db = await Database.open(':memory:');
    try {
      await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
      const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
      await t.rejects(
        () => stmt.run(1n),
        /expected 2 positional parameters, got 1/i,
        'too few positional parameters are rejected',
      );
      stmt.finalize();
    } finally {
      await db.close();
    }
  });
  it('rejects too many positional parameters before binding', async (t) => {
    const db = await Database.open(':memory:');
    try {
      await db.exec('CREATE TABLE t (id INTEGER, val TEXT)');
      const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
      await t.rejects(
        () => stmt.run(1n, 'ok', 'extra'),
        /expected 2 positional parameters, got 3/i,
        'too many positional parameters are rejected',
      );
      stmt.finalize();
    } finally {
      await db.close();
    }
  });
  it('lastInsertRowid', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
    const stmt = db.prepare('INSERT INTO t (v) VALUES (?)');
    await stmt.run('a');
    t.ok(db.lastInsertRowid > 0n, 'lastInsertRowid should be positive');
    stmt.finalize();
    await db.close();
  });
});
describe('fino:database/sqlite — type round-trips', () => {
  it('NULL → null', async (t) => {
    const db = await Database.open(':memory:');
    const row = await db.prepare('SELECT NULL AS v').get();
    t.equal(row!['v'], null, 'null round-trip');
    await db.close();
  });
  it('INTEGER → BigInt', async (t) => {
    const db = await Database.open(':memory:');
    const row = await db.prepare('SELECT 9007199254740993 AS v').get();
    t.equal(row!['v'], 9007199254740993n, 'large int as BigInt');
    await db.close();
  });
  it('INTEGER → number (safeIntegers: false)', async (t) => {
    const db = await Database.open(':memory:', { safeIntegers: false });
    const row = await db.prepare('SELECT 42 AS v').get();
    t.equal(row!['v'], 42, 'integer as number');
    await db.close();
  });
  it('REAL → number', async (t) => {
    const db = await Database.open(':memory:');
    const row = await db.prepare('SELECT 3.14 AS v').get();
    t.ok(Math.abs((row!['v'] as number) - 3.14) < 1e-10, 'float round-trip');
    await db.close();
  });
  it('TEXT → string', async (t) => {
    const db = await Database.open(':memory:');
    const row = await db.prepare("SELECT 'hello' AS v").get();
    t.equal(row!['v'], 'hello', 'text round-trip');
    await db.close();
  });
  it('BLOB → Uint8Array', async (t) => {
    const db = await Database.open(':memory:');
    await db.exec('CREATE TABLE t (v BLOB)');
    const data = new Uint8Array([1, 2, 3, 4]);
    const stmt = db.prepare('INSERT INTO t VALUES (?)');
    await stmt.run(data);
    stmt.finalize();
    const row = await db.prepare('SELECT v FROM t').get();
    const got = row!['v'] as Uint8Array;
    t.equal(got.byteLength, 4, 'blob length');
    t.deepEqual(Array.from(got), [1, 2, 3, 4], 'blob bytes');
    await db.close();
  });
  it('bound TEXT round-trips', async (t) => {
    const db = await Database.open(':memory:');
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
    const db = await setup();
    const rows = await db.prepare('SELECT * FROM t ORDER BY id').all();
    t.equal(rows.length, 3, '3 rows');
    t.equal(rows[0]!['name'], 'alice', 'first row');
    await db.close();
  });
  it('get() returns first row', async (t) => {
    const db = await setup();
    const row = await db.prepare('SELECT * FROM t WHERE id = ?').get(2n);
    t.equal(row!['name'], 'bob', 'second row');
    await db.close();
  });
  it('get() returns undefined when no match', async (t) => {
    const db = await setup();
    const row = await db.prepare('SELECT * FROM t WHERE id = ?').get(99n);
    t.equal(row, undefined, 'no match');
    await db.close();
  });
  it('iterate() yields each row', async (t) => {
    const db = await setup();
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
    const db = await Database.open(':memory:');
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
    const db = await Database.open(':memory:');
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
  it('Statement supports using disposal', async (t) => {
    const db = await Database.open(':memory:');
    let stmtRef: any = null;
    try {
      {
        using stmt = db.prepare('SELECT 1 AS value');
        t.equal((await stmt.get())!['value'], 1n, 'statement works inside using scope');
        stmtRef = stmt;
      }
      await t.rejects(
        () => stmtRef.get(),
        /finalized/,
        'statement finalizes when using scope exits',
      );
    } finally {
      await db.close();
    }
  });
  it('finalize is idempotent', async (t) => {
    const db = await Database.open(':memory:');
    const stmt = db.prepare('SELECT 1');
    stmt.finalize();
    stmt.finalize();
    t.ok(true, 'double finalize is safe');
    await db.close();
  });
  it('finalize without compiling is safe', async (t) => {
    const db = await Database.open(':memory:');
    const stmt = db.prepare('SELECT 1');
    stmt.finalize();
    t.ok(true, 'finalize uncompiled statement is safe');
    await db.close();
  });
  it('finalized statements reject all execution helpers', async (t) => {
    const db = await Database.open(':memory:');
    try {
      await db.exec('CREATE TABLE t (value INTEGER)');
      const stmt = db.prepare('SELECT value FROM t');
      stmt.finalize();
      await t.rejects(() => stmt.run(), /finalized/i, 'run rejects');
      await t.rejects(() => stmt.get(), /finalized/i, 'get rejects');
      await t.rejects(() => stmt.all(), /finalized/i, 'all rejects');
      const iterator = stmt.iterate();
      await t.rejects(() => iterator.next(), /finalized/i, 'iterate rejects');
    } finally {
      await db.close();
    }
  });
});
describe('fino:database/sqlite — vector helpers', () => {
  it('vec() encodes a float array as sqlite-vec text', (t) => {
    t.equal(vec([1, 2, 3]), '[1,2,3]', 'number[] encoding');
    t.equal(vec(new Float32Array([.5, -1])), '[0.5,-1]', 'Float32Array encoding');
  });
  it('vecDecode() decodes a float32 blob', (t) => {
    const arr = new Float32Array([1.5, -2.5, 3]);
    const blob = new Uint8Array(arr.buffer);
    const decoded = vecDecode(blob);
    t.equal(decoded.length, 3, 'correct length');
    t.ok(Math.abs(decoded[0]! - 1.5) < 1e-6, 'first element');
    t.ok(Math.abs(decoded[1]! - -2.5) < 1e-6, 'second element');
  });
});
