import { describe, it } from 'fino:test/test';
import { Database, sqliteAvailable } from 'fino:database/sqlite';
import { DiskFileSystem } from 'fino:file';
import {
  MigrationError,
  MigrationParseError,
  defineMigration,
  loadMigrations,
  migrate,
  rollback
} from 'fino:database/migrate';
import {
  compileSqlModule,
  parseSqlModule,
  toSqlModuleSource
} from 'fino:database/sql';

if (!sqliteAvailable) {
  if (process.env['FINO_REQUIRE_SQLITE'] === '1') {
    throw new Error('libsqlite3 not found and FINO_REQUIRE_SQLITE=1');
  }
  console.log('SKIP: libsqlite3 not found');
  process.exit(0);
}

const fs = new DiskFileSystem();

function tmpName(name: string): string {
  return `/tmp/fino-migrate-${name}-${Math.floor(Math.random() * 1e9)}`;
}

async function mkdirp(path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    try {
      await fs.mkdir(cur);
    } catch {}
  }
}

describe('fino:database/migrate — SQL module parsing', () => {
  it('preserves type imports and complex TypeScript signatures', (t) => {
    const ir = parseSqlModule(`-- import type { User, AccountId } from './types.ts'

-- function findUser(input: User, accountId: AccountId): string
-- Find a user by nested fields.
SELECT * FROM users
WHERE id = {{ input.id }}
  AND account_id = {{ accountId }}
`);
    t.deepEqual(ir.imports, [`import type { User, AccountId } from './types.ts';`]);
    t.equal(ir.functions[0]!.name, 'findUser');
    t.equal(ir.functions[0]!.params[0]!.type, 'User');
    t.equal(ir.functions[0]!.params[1]!.type, 'AccountId');
    t.equal(ir.functions[0]!.returnType, 'string');
    t.deepEqual(ir.functions[0]!.description, ['Find a user by nested fields.']);
  });

  it('renders structural placeholders and raw trusted fragments', (t) => {
    const mod = compileSqlModule(parseSqlModule(`-- function byUser(input: { id: string; status: string; order: string })
SELECT * FROM users
WHERE id = '{{ input.id }}'
  AND status = '{{ input.status }}'
ORDER BY {{! input.order }}
`));
    t.equal(
      mod.byUser({ id: "O'Brien", status: 'active', order: 'created_at DESC' }),
      "SELECT * FROM users\nWHERE id = 'O\\'Brien'\n  AND status = 'active'\nORDER BY created_at DESC"
    );
  });

  it('throws on missing structural fields', (t) => {
    const mod = compileSqlModule(parseSqlModule('-- function q(input: { id: string })\nSELECT {{ input.id }}'));
    t.throws(() => mod.q({}), /input\.id/);
  });

  it('generates a module source with type imports and up/down exports', (t) => {
    const source = toSqlModuleSource(parseSqlModule(`-- import type { User } from './types.ts'
-- function up(input: User)
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);

-- function down()
DROP TABLE users;
`));
    t.ok(source.includes(`import type { User } from './types.ts';`), 'type import is preserved');
    t.ok(source.includes('export function up(input: User): string'), 'up is exported with its type signature');
    t.ok(source.includes('export function down(): string'), 'down is exported');
  });

  it('reports TypeScript signature errors as MigrationParseError', (t) => {
    t.throws(
      () => parseSqlModule('-- function bad(input: )\nSELECT 1', { source: 'bad.sql' }),
      (err) => err instanceof MigrationParseError && /bad\.sql:1/.test(String(err))
    );
  });

  it('imports .sql files as generated SQL modules', async (t) => {
    const dir = tmpName('import');
    await mkdirp(dir);
    await fs.writeFile(`${dir}/queries.sql`, `-- import type { User } from './types.ts'
-- function findUser(input: User)
SELECT * FROM users WHERE id = '{{ input.id }}'

-- function allUsers()
SELECT * FROM users
`);
    const mod = await import(`file://${dir}/queries.sql`) as {
      findUser(input: { id: string }): string;
      allUsers(): string;
      default: {
        findUser(input: { id: string }): string;
        allUsers(): string;
      };
    };
    t.equal(mod.findUser({ id: "O'Brien" }), "SELECT * FROM users WHERE id = 'O\\'Brien'");
    t.equal(mod.default.allUsers(), 'SELECT * FROM users');
  });
});

describe('fino:database/migrate — runner', () => {
  it('applies up migrations and rolls back with down migrations', async (t) => {
    await using db = await Database.open(':memory:');
    const applied = await migrate(db, [
      defineMigration({
        id: '001_create_users',
        up: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
        down: 'DROP TABLE users'
      })
    ]);
    t.equal(applied.length, 1);
    await db.prepare('INSERT INTO users VALUES (?, ?)').run('1', 'Ada');
    await migrate(db, [
      defineMigration({
        id: '001_create_users',
        up: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
        down: 'DROP TABLE users'
      })
    ]);
    const rows = await db.prepare('SELECT id FROM users').all();
    t.equal(rows.length, 1, 'migrate is idempotent');
    const rolledBack = await rollback(db, [
      defineMigration({
        id: '001_create_users',
        up: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
        down: 'DROP TABLE users'
      })
    ]);
    t.equal(rolledBack.length, 1);
    await t.rejects(() => db.prepare('SELECT * FROM users').all(), /no such table|prepare/i);
  });

  it('rejects checksum drift before applying later migrations', async (t) => {
    await using db = await Database.open(':memory:');
    await migrate(db, [
      defineMigration({ id: '001_create_users', up: 'CREATE TABLE users (id TEXT)' })
    ]);
    let checksumError: unknown;
    try {
      await migrate(db, [
        defineMigration({ id: '001_create_users', up: 'CREATE TABLE users (id TEXT, name TEXT)' }),
        defineMigration({ id: '002_never_runs', up: 'CREATE TABLE never_runs (id TEXT)' })
      ]);
    } catch (err) {
      checksumError = err;
    }
    t.ok(checksumError instanceof MigrationError, `expected MigrationError, got ${String(checksumError)}`);
    t.ok(/checksum/i.test(String(checksumError)), 'checksum drift is reported');
    await t.rejects(() => db.prepare('SELECT * FROM never_runs').all(), /no such table|prepare/i);
  });

  it('loads directive SQL files and executes exported up/down functions', async (t) => {
    const dir = tmpName('files');
    await mkdirp(dir);
    await fs.writeFile(`${dir}/001_users.sql`, `-- function up()
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);

-- function down()
DROP TABLE users;
`);
    const migrations = await loadMigrations(`${dir}/*.sql`);
    t.equal(migrations[0]!.id, '001_users');
    await using db = await Database.open(':memory:');
    await migrate(db, migrations);
    await db.prepare('INSERT INTO users VALUES (?, ?)').run('1', 'Grace');
    const row = await db.prepare('SELECT name FROM users WHERE id = ?').get('1');
    t.equal(row!.name, 'Grace');
    await rollback(db, migrations);
    await t.rejects(() => db.prepare('SELECT * FROM users').all(), /no such table|prepare/i);
  });

  it('rolls back transaction state when a migration fails', async (t) => {
    await using db = await Database.open(':memory:');
    await t.rejects(
      () => migrate(db, [
        defineMigration({
          id: '001_broken',
          up: [
            'CREATE TABLE broken (id TEXT)',
            'INSERT INTO missing_table VALUES (1)'
          ],
          down: 'DROP TABLE broken'
        })
      ]),
      /missing_table|prepare|no such table/i
    );
    await t.rejects(() => db.prepare('SELECT * FROM broken').all(), /no such table|prepare/i);
    const rows = await db.prepare('SELECT id FROM fino_migrations').all();
    t.equal(rows.length, 0, 'failed migration is not recorded');
  });

  it('requires down SQL for rollback', async (t) => {
    await using db = await Database.open(':memory:');
    const migrations = [defineMigration({ id: '001_create_users', up: 'CREATE TABLE users (id TEXT)' })];
    await migrate(db, migrations);
    await t.rejects(() => rollback(db, migrations), (err) => err instanceof MigrationError && /down/i.test(String(err)));
  });
});
