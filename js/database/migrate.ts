/**
* fino:database/migrate — reversible database migrations.
*
* This module applies ordered `up` migrations, rolls back explicit `down`
* migrations, and records migration history through the generic
* `fino:database` connection interface. SQL directive parsing and callable SQL
* function generation live in `fino:database/sql`; this module uses that engine
* for `.sql` migration files and re-exports it for compatibility.
*
* Migration execution validates checksums before running later migrations and
* uses `db.transaction()` by default. History is stored in `fino_migrations`
* unless `tableName` is provided.
*
* ```ts no_run
* import { Database } from 'fino:database';
* import { loadMigrations, migrate, rollback } from 'fino:database/migrate';
*
* await using db = await Database.open('./app.db');
* const migrations = await loadMigrations('./migrations/*.sql');
* await migrate(db, migrations);
* await rollback(db, migrations);
* ```
*/
import { sql, type DatabaseConnection } from 'fino:database';
import { DiskFileSystem } from 'fino:file';
import type { FileSystem } from 'internal:file/provider';
import { digest } from 'internal:openssl';
import { compileSqlModule, parseSqlModule, MigrationParseError } from 'fino:database/sql';

export {
  MigrationParseError,
  compileSqlModule,
  escapeSqlLiteral,
  parseSqlModule,
  toSqlModuleSource
} from 'fino:database/sql';
export type {
  CompileSqlModuleOptions,
  ParseSqlModuleOptions,
  SqlFunctionIR,
  SqlModuleIR,
  SqlParamIR
} from 'fino:database/sql';

const enc = new TextEncoder();

/**
* Error thrown for migration planning, checksum, history, and execution
* failures.
*/
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
* A reversible database migration.
*
* `up` and `down` may be SQL strings, arrays of SQL strings, or functions that
* return SQL. `down` is required only when a rollback includes the migration.
*/
export interface Migration {
  id: string;
  name?: string;
  up: MigrationBody;
  down?: MigrationBody;
  checksum?: string;
}

/**
* Function context passed to executable migrations.
*/
export interface MigrationContext {
  db: DatabaseConnection;
  migration: Migration;
  sql: typeof sql;
}

/**
* SQL body accepted by migration execution.
*/
export type MigrationBody = string | string[] | ((ctx: MigrationContext) => void | string | string[] | Promise<void | string | string[]>);

/**
* One row of migration history.
*/
export interface MigrationRecord {
  id: string;
  name: string;
  checksum: string;
  direction: 'up' | 'down';
  appliedAt: number;
  durationMs: number;
}

/**
* Planned migration state.
*/
export interface MigrationPlan {
  applied: MigrationRecord[];
  pending: Migration[];
}

/**
* Options for loading migration files.
*/
export interface LoadMigrationsOptions {
  cwd?: string;
  fs?: FileSystem;
}

/**
* Options shared by migration planning and execution.
*/
export interface MigrateOptions {
  tableName?: string;
  transaction?: boolean;
}

/**
* Options for rollback execution.
*/
export interface RollbackOptions extends MigrateOptions {
  steps?: number;
}

/**
* Return `migration` unchanged while preserving the public `Migration` type.
*/
export function defineMigration(migration: Migration): Migration {
  return migration;
}

function migrationName(id: string): string {
  return id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
}

function validateTableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new MigrationError(`Invalid migration table name: ${name}`);
  return name;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function resolveBody(body: MigrationBody, ctx: MigrationContext): Promise<string[]> {
  const value = typeof body === 'function' ? await body(ctx) : body;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function checksumFor(body: MigrationBody, migration: Migration, db: DatabaseConnection): Promise<string> {
  if (migration.checksum) return migration.checksum;
  const sqlText = (await resolveBody(body, { db, migration, sql })).join('\n');
  return hex(digest('sha-256', enc.encode(sqlText)));
}

async function ensureHistory(db: DatabaseConnection, tableName: string): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    direction TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )`);
}

async function readHistory(db: DatabaseConnection, tableName: string): Promise<MigrationRecord[]> {
  try {
    const rows = await db.prepare(`SELECT id, name, checksum, direction, applied_at, duration_ms FROM ${tableName} ORDER BY applied_at ASC`).all();
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      name: String(row.name),
      checksum: String(row.checksum),
      direction: row.direction === 'down' ? 'down' : 'up',
      appliedAt: Number(row.applied_at),
      durationMs: Number(row.duration_ms)
    }));
  } catch (err) {
    if (!/no such table|does not exist|undefined_table/i.test(String(err))) throw err;
    return [];
  }
}

function activeRecords(records: MigrationRecord[]): MigrationRecord[] {
  const active = new Map<string, MigrationRecord>();
  for (const record of records) {
    if (record.direction === 'down') active.delete(record.id);
    else active.set(record.id, record);
  }
  return [...active.values()];
}

function sortedUnique(migrations: Migration[]): Migration[] {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) throw new MigrationError(`Duplicate migration id: ${migration.id}`);
    seen.add(migration.id);
  }
  return [...migrations].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
* Read currently applied migrations from the history table.
*
* A missing history table is treated as an empty migration history.
*/
export async function getAppliedMigrations(db: DatabaseConnection, options: MigrateOptions = {}): Promise<MigrationRecord[]> {
  return activeRecords(await readHistory(db, validateTableName(options.tableName ?? 'fino_migrations')));
}

/**
* Compare migrations with database history and return applied and pending sets.
*/
export async function planMigrations(db: DatabaseConnection, migrations: Migration[], options: MigrateOptions = {}): Promise<MigrationPlan> {
  const tableName = validateTableName(options.tableName ?? 'fino_migrations');
  const applied = activeRecords(await readHistory(db, tableName));
  const appliedById = new Map(applied.map((record) => [record.id, record]));
  const pending: Migration[] = [];
  for (const migration of sortedUnique(migrations)) {
    const active = appliedById.get(migration.id);
    if (!active) {
      pending.push(migration);
      continue;
    }
    const nextChecksum = await checksumFor(migration.up, migration, db);
    if (active.checksum !== nextChecksum) throw new MigrationError(`Migration checksum changed for ${migration.id}`);
  }
  return { applied, pending };
}

async function runStatements(db: DatabaseConnection, statements: string[]): Promise<void> {
  for (const statement of statements) {
    if (statement.trim()) await db.exec(statement);
  }
}

async function record(db: DatabaseConnection, tableName: string, migration: Migration, checksum: string, direction: 'up' | 'down', started: number): Promise<MigrationRecord> {
  const appliedAt = Date.now();
  const durationMs = Math.max(0, appliedAt - started);
  await db.prepare(`INSERT INTO ${tableName}(id, name, checksum, direction, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(migration.id, migration.name ?? migrationName(migration.id), checksum, direction, appliedAt, durationMs);
  return { id: migration.id, name: migration.name ?? migrationName(migration.id), checksum, direction, appliedAt, durationMs };
}

/**
* Apply all pending `up` migrations.
*
* Each migration runs inside `db.transaction()` unless `transaction` is `false`.
* Checksum drift in already-applied migrations rejects before later migrations
* are executed.
*/
export async function migrate(db: DatabaseConnection, migrations: Migration[], options: MigrateOptions = {}): Promise<MigrationRecord[]> {
  const tableName = validateTableName(options.tableName ?? 'fino_migrations');
  await ensureHistory(db, tableName);
  const plan = await planMigrations(db, migrations, { ...options, tableName });
  const applied: MigrationRecord[] = [];
  for (const migration of plan.pending) {
    const started = Date.now();
    const checksum = await checksumFor(migration.up, migration, db);
    const task = async () => {
      await runStatements(db, await resolveBody(migration.up, { db, migration, sql }));
      applied.push(await record(db, tableName, migration, checksum, 'up', started));
    };
    if (options.transaction === false) await task();
    else await db.transaction(task);
  }
  return applied;
}

/**
* Roll back applied migrations by executing their `down` bodies.
*
* By default one migration is rolled back. `steps` controls how many active
* migrations are reverted, newest first.
*/
export async function rollback(db: DatabaseConnection, migrations: Migration[], options: RollbackOptions = {}): Promise<MigrationRecord[]> {
  const tableName = validateTableName(options.tableName ?? 'fino_migrations');
  await ensureHistory(db, tableName);
  const active = activeRecords(await readHistory(db, tableName)).sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const byId = new Map(sortedUnique(migrations).map((migration) => [migration.id, migration]));
  const steps = options.steps ?? 1;
  const rolledBack: MigrationRecord[] = [];
  for (const activeRecord of active.slice(0, steps)) {
    const migration = byId.get(activeRecord.id);
    if (!migration) throw new MigrationError(`No migration definition found for rollback: ${activeRecord.id}`);
    if (!migration.down) throw new MigrationError(`Migration ${activeRecord.id} does not define down SQL`);
    const started = Date.now();
    const task = async () => {
      await runStatements(db, await resolveBody(migration.down!, { db, migration, sql }));
      rolledBack.push(await record(db, tableName, migration, activeRecord.checksum, 'down', started));
    };
    if (options.transaction === false) await task();
    else await db.transaction(task);
  }
  return rolledBack;
}

function migrationFromSql(id: string, text: string, source: string): Migration {
  const ir = parseSqlModule(text, { source });
  if (ir.functions.length === 0) return defineMigration({ id, name: migrationName(id), up: text });
  const functions = compileSqlModule(ir);
  const up = functions.up;
  if (!up) throw new MigrationParseError('directive migration must export up()', source, 1);
  return defineMigration({
    id,
    name: migrationName(id),
    up: () => up(),
    ...functions.down ? { down: () => functions.down() } : {}
  });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function idFromPath(path: string): string {
  return basename(path).replace(/\.sql(?:\.ts)?$|\.ts$/i, '');
}

/**
* Load migrations from SQL files, TypeScript migration modules, or globs.
*
* SQL files may be plain SQL or directive SQL with exported `up()` and optional
* `down()`. TypeScript modules are imported and must export `up`; exported
* `down`, `id`, or `name` are used when present.
*/
export async function loadMigrations(pattern: string | string[], options: LoadMigrationsOptions = {}): Promise<Migration[]> {
  const fs = options.fs ?? new DiskFileSystem();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const paths: string[] = [];
  for (const pat of patterns) {
    if (/[*?{[]/.test(pat)) {
      for await (const entry of (fs as DiskFileSystem).glob(pat, { cwd: options.cwd, onlyFiles: true })) paths.push(entry.path.toString());
    } else {
      paths.push(options.cwd ? `${options.cwd}/${pat}` : pat);
    }
  }
  const migrations: Migration[] = [];
  for (const path of paths.sort()) {
    if (/\.sql$/i.test(path)) {
      migrations.push(migrationFromSql(idFromPath(path), await fs.readFile(path), path));
    } else {
      const mod = await import(path.startsWith('/') ? `file://${path}` : path) as Record<string, unknown>;
      const id = typeof mod.id === 'string' ? mod.id : idFromPath(path);
      if (typeof mod.up !== 'function' && typeof mod.up !== 'string' && !Array.isArray(mod.up)) throw new MigrationError(`Migration module ${path} must export up`);
      migrations.push(defineMigration({
        id,
        name: typeof mod.name === 'string' ? mod.name : migrationName(id),
        up: mod.up as MigrationBody,
        ...mod.down !== undefined ? { down: mod.down as MigrationBody } : {}
      }));
    }
  }
  return sortedUnique(migrations);
}
