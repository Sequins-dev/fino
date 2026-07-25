/**
* Fixture: exercises file-backed sqlite from inside a child realm. The JS
* VFS trampolines callbacks from blocking-pool threads, so this covers the
* cross-realm promise settling path in the FFI bridge.
*/
import { Database } from 'fino:database/sqlite';
export default async function sqliteInChild(path: string): Promise<number> {
  const db = await Database.open(path);
  await db.exec('CREATE TABLE IF NOT EXISTS t (v INTEGER)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  await ins.run(41);
  ins.finalize();
  const row = await db.prepare('SELECT SUM(v) + 1 AS total FROM t').get();
  await db.close();
  return Number(row!.total);
}
