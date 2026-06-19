/**
 * Benchmarks for fino:database/sqlite
 *
 * Run with: cargo run -- bench benchmarks/database/sqlite.bench.mts
 */

import { Database, sqliteAvailable, vec, vecDecode } from 'fino:database/sqlite';
import { bench } from 'fino:bench';
import { DiskFileSystem } from 'fino:file';

const vecBlob = new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer);
const fs = new DiskFileSystem();
const diskPath = '/tmp/fino-sqlite-bench-' + Math.floor(Math.random() * 1_000_000_000) + '.db';

function formatOpsPerSecond(iterations: number, elapsedMs: number): string {
  const ops = iterations / (elapsedMs / 1000);
  if (ops >= 1_000_000) return (ops / 1_000_000).toFixed(2) + 'm i/s';
  if (ops >= 1_000) return (ops / 1_000).toFixed(2) + 'k i/s';
  return ops.toFixed(2) + ' i/s';
}

function formatTimePerIteration(elapsedMs: number, iterations: number): string {
  const ns = elapsedMs * 1_000_000 / iterations;
  if (ns >= 1_000_000) return (ns / 1_000_000).toFixed(2) + 'ms/i';
  if (ns >= 1_000) return (ns / 1_000).toFixed(2) + 'us/i';
  return ns.toFixed(2) + 'ns/i';
}

async function measureAsync(name: string, fn: () => Promise<void>, minMs = 250): Promise<void> {
  let iterations = 0;
  const start = Date.now();
  let elapsed = 0;
  do {
    await fn();
    iterations++;
    elapsed = Date.now() - start;
  } while (elapsed < minMs);
  console.log(`${name} - ${formatOpsPerSecond(iterations, elapsed)} (${formatTimePerIteration(elapsed, iterations)})`);
}

bench('database/sqlite helpers', (b) => {
  b.measure('sqliteAvailable flag', () => sqliteAvailable);
  b.measure('Database class reference', () => Database);
  b.measure('vec encode', () => vec([1, 2, 3, 4]));
  b.measure('vecDecode', () => vecDecode(vecBlob));
});

if (!sqliteAvailable) {
  console.log('SKIP: libsqlite3 not found; SQLite DB-backed benchmarks were not registered');
} else {
  console.log('# database/sqlite db-backed');

  const queryDb = await Database.open(':memory:');
  await queryDb.exec('CREATE TABLE lookup (id INTEGER PRIMARY KEY, label TEXT)');
  const insertLookup = queryDb.prepare('INSERT INTO lookup VALUES (?, ?)');
  for (let i = 1; i <= 32; i++) await insertLookup.run(BigInt(i), `label-${i}`);
  insertLookup.finalize();

  const getStmt = queryDb.prepare('SELECT label FROM lookup WHERE id = ?');
  const allStmt = queryDb.prepare('SELECT * FROM lookup ORDER BY id');
  const iterateStmt = queryDb.prepare('SELECT * FROM lookup ORDER BY id');

  const insertDb = await Database.open(':memory:');
  await insertDb.exec('CREATE TABLE inserts (value TEXT)');
  const runInsertStmt = insertDb.prepare('INSERT INTO inserts VALUES (?)');

  try { await fs.unlink(diskPath); } catch {}
  {
    const diskDb = await Database.open(diskPath, { fs });
    await diskDb.exec('CREATE TABLE disk_lookup (id INTEGER PRIMARY KEY, label TEXT)');
    await diskDb.exec("INSERT INTO disk_lookup VALUES (1, 'disk')");
    await diskDb.close();
  }

  await measureAsync('open + close :memory:', async () => {
    const db = await Database.open(':memory:');
    await db.close();
  });

  await measureAsync('prepare + finalize', async () => {
    const stmt = queryDb.prepare('SELECT label FROM lookup WHERE id = ?');
    await stmt.get(1n);
    stmt.finalize();
  });

  await measureAsync('run insert', async () => {
    await runInsertStmt.run('value');
  });

  await measureAsync('get one row', async () => {
    const row = await getStmt.get(16n);
    if (row!['label'] !== 'label-16') throw new Error('unexpected row');
  });

  await measureAsync('all rows', async () => {
    const rows = await allStmt.all();
    if (rows.length !== 32) throw new Error('unexpected row count');
  });

  await measureAsync('iterate rows', async () => {
    let count = 0;
    for await (const _row of iterateStmt.iterate()) count++;
    if (count !== 32) throw new Error('unexpected iteration count');
  });

  await measureAsync('transaction with insert', async () => {
    await insertDb.transaction(async () => {
      await runInsertStmt.run('tx-a');
      await runInsertStmt.run('tx-b');
    });
  });

  await measureAsync('disk/VFS open + select + close', async () => {
    const db = await Database.open(diskPath, { fs, readonly: true });
    const row = await db.prepare('SELECT label FROM disk_lookup WHERE id = 1').get();
    if (row!['label'] !== 'disk') throw new Error('unexpected disk row');
    await db.close();
  });
}
