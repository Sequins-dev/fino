import { describe, it } from 'fino:test/test';
import { Database, sql, type SqlFragment } from 'fino:database';
import { sqliteAvailable } from 'fino:database/sqlite';
if (!sqliteAvailable) {
  if (process.env['FINO_REQUIRE_SQLITE'] === '1')
    throw new Error('libsqlite3 not found and FINO_REQUIRE_SQLITE=1');
  console.log('SKIP: libsqlite3 not found');
  process.exit(0);
}
describe('fino:database facade', () => {
  it('routes :memory: and sqlite URLs to SQLite without losing query behavior', async (t) => {
    await using db = await Database.open(':memory:');
    t.equal(db.driver, 'sqlite');
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await db.prepare('INSERT INTO t (name) VALUES (?)').run('Ada');
    const row = await db.prepare('SELECT name FROM t WHERE id = ?').get(1n);
    t.equal(row!.name, 'Ada');
  });
  it('renders tagged SQL fragments for SQLite and Postgres placeholders', (t) => {
    const fragment = sql`SELECT ${sql.identifier('user id')} FROM ${sql.identifier('users')} WHERE id = ${42} AND name IN (${sql.join(['Ada', 'Grace'])})`;
    t.equal(
      fragment.text('postgres'),
      'SELECT "user id" FROM "users" WHERE id = $1 AND name IN ($2, $3)',
    );
    t.equal(
      fragment.text('sqlite'),
      'SELECT "user id" FROM "users" WHERE id = ? AND name IN (?, ?)',
    );
    t.deepEqual(fragment.values, [42, 'Ada', 'Grace']);
  });
  it('rejects unsafe SQL identifiers', (t) => {
    t.throws(() => sql.identifier('users; DROP TABLE users'), /identifier/i);
  });
  it('recognizes SqlFragment values without relying on classes', (t) => {
    const fragment: SqlFragment = sql`SELECT ${1}`;
    t.equal(fragment.kind, 'sql');
    t.deepEqual(fragment.values, [1]);
  });
});
