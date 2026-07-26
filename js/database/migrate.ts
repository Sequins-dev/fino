/**
 * fino:database/migrate — reversible database migrations.
 *
 * This module applies ordered `up` migrations, rolls back explicit `down`
 * migrations, and records migration history through the generic
 * `fino:database` connection interface, so the same migration set runs against
 * SQLite and Postgres alike. SQL directive parsing and callable SQL function
 * generation live in `fino:database/sql`; this module uses that engine for
 * `.sql` migration files and re-exports it for compatibility.
 *
 * Migrations are ordered by lexicographic `id`, so the usual convention is a
 * sortable prefix such as `001_create_users` or an ISO timestamp. History is
 * append-only: every `up` and `down` run inserts a row into the history table
 * (`fino_migrations` unless `tableName` is provided), and the set of currently
 * active migrations is derived by replaying that log. Each migration's `up`
 * SQL is checksummed with SHA-256; if an already-applied migration's text
 * changes, planning fails with a `MigrationError` before any later migration
 * runs.
 *
 * By default each migration executes inside `db.transaction()`, so a failing
 * statement leaves behind neither partial schema changes nor a history row.
 * Pass `transaction: false` for statements that cannot run inside a
 * transaction (for example `CREATE INDEX CONCURRENTLY` on Postgres).
 *
 * ```ts no_run
 * import { Database } from 'fino:database';
 * import { loadMigrations, migrate, rollback } from 'fino:database/migrate';
 *
 * await using db = await Database.open('./app.db');
 * const migrations = await loadMigrations('./migrations/*.sql');
 * await migrate(db, migrations);   // apply everything not yet applied
 * await rollback(db, migrations);  // undo the most recent migration
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
  toSqlModuleSource,
} from 'fino:database/sql';
export type {
  CompileSqlModuleOptions,
  ParseSqlModuleOptions,
  SqlFunctionIR,
  SqlModuleIR,
  SqlParamIR,
} from 'fino:database/sql';

const enc = new TextEncoder();

/**
 * Error thrown for migration planning, checksum, history, and execution
 * failures.
 *
 * Raised for duplicate migration ids, checksum drift in an already-applied
 * migration, invalid history table names, rollbacks of migrations that are
 * missing from the provided set or define no `down` body, and migration
 * modules that do not export `up`. Database errors raised while executing
 * migration SQL propagate as-is and are not wrapped.
 *
 * ```ts no_run
 * import { MigrationError, migrate } from 'fino:database/migrate';
 *
 * try {
 *   await migrate(db, migrations);
 * } catch (err) {
 *   if (err instanceof MigrationError) console.error('migration rejected:', err.message);
 *   else throw err;
 * }
 * ```
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
 * Migrations are identified and ordered by `id`, so ids should sort in the
 * order migrations must run. `up` and `down` may be SQL strings, arrays of SQL
 * statements, or functions that return SQL (see `MigrationBody`). `down` is
 * required only when a rollback includes the migration.
 *
 * ```ts no_run
 * import { defineMigration } from 'fino:database/migrate';
 *
 * const createUsers = defineMigration({
 *   id: '001_create_users',
 *   up: 'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
 *   down: 'DROP TABLE users'
 * });
 * ```
 */
export interface Migration {
  /**
   * Unique identifier; migrations run in lexicographic `id` order.
   */
  id: string;
  /**
   * Human-readable name recorded in history. Defaults to the portion of `id`
   * after the first underscore (`001_create_users` → `create_users`).
   */
  name?: string;
  /**
   * SQL applied when the migration runs forward.
   */
  up: MigrationBody;
  /**
   * SQL that reverts `up`. Required only when a rollback reaches this
   * migration.
   */
  down?: MigrationBody;
  /**
   * Explicit checksum recorded in history and compared on later runs. When
   * omitted, the SHA-256 hex digest of the resolved `up` SQL is used —
   * resolving a function body invokes it, so functional migrations with side
   * effects should set this explicitly.
   */
  checksum?: string;
}

/**
 * Function context passed to executable migration bodies.
 *
 * When `up` or `down` is a function, it receives this context: the live
 * connection, the migration's own definition, and the `sql` template tag from
 * `fino:database` for building portable fragments.
 *
 * ```ts no_run
 * import { defineMigration } from 'fino:database/migrate';
 *
 * const seedAdmin = defineMigration({
 *   id: '002_seed_admin',
 *   checksum: 'seed-admin-v1',
 *   up: async ({ db }) => {
 *     await db.prepare('INSERT INTO users VALUES (?, ?)').run('1', 'admin');
 *   },
 *   down: `DELETE FROM users WHERE id = '1'`
 * });
 * ```
 */
export interface MigrationContext {
  /**
   * The connection the migration is executing against.
   */
  db: DatabaseConnection;
  /**
   * The migration definition being executed.
   */
  migration: Migration;
  /**
   * The `sql` template tag from `fino:database`.
   */
  sql: typeof sql;
}

/**
 * SQL body accepted by migration execution.
 *
 * A body is a single SQL string, an array of statements executed in order (one
 * `db.exec()` per entry; blank entries are skipped), or a function receiving a
 * `MigrationContext`. Functions may return SQL to execute, or perform their
 * work directly through `ctx.db` and return nothing.
 *
 * When the migration has no explicit `checksum`, its `up` body is resolved to
 * text for checksumming — which invokes function bodies — so functions should
 * either be pure SQL generators or be paired with an explicit `checksum`.
 */
export type MigrationBody =
  | string
  | string[]
  | ((ctx: MigrationContext) => void | string | string[] | Promise<void | string | string[]>);

/**
 * One row of migration history.
 *
 * The history table is append-only: applying a migration inserts an `'up'` row
 * and rolling it back inserts a `'down'` row. Functions such as
 * `getAppliedMigrations()` collapse this log into the set of currently active
 * migrations.
 *
 * ```ts no_run
 * import { getAppliedMigrations } from 'fino:database/migrate';
 *
 * for (const record of await getAppliedMigrations(db)) {
 *   console.log(record.id, new Date(record.appliedAt), `${record.durationMs}ms`);
 * }
 * ```
 */
export interface MigrationRecord {
  /**
   * Id of the migration this row records.
   */
  id: string;
  /**
   * Migration name at the time it was recorded.
   */
  name: string;
  /**
   * Checksum of the migration's `up` SQL when it was applied. Rollback rows
   * repeat the checksum of the run they revert.
   */
  checksum: string;
  /**
   * Whether this row records an apply (`'up'`) or a rollback (`'down'`).
   */
  direction: 'up' | 'down';
  /**
   * Completion time in milliseconds since the Unix epoch.
   */
  appliedAt: number;
  /**
   * Execution time in milliseconds.
   */
  durationMs: number;
}

/**
 * Planned migration state returned by `planMigrations()`.
 *
 * ```ts no_run
 * import { loadMigrations, planMigrations } from 'fino:database/migrate';
 *
 * const plan = await planMigrations(db, await loadMigrations('./migrations/*.sql'));
 * console.log(`${plan.applied.length} applied, ${plan.pending.length} pending`);
 * ```
 */
export interface MigrationPlan {
  /**
   * Currently active migrations, one record per applied migration.
   */
  applied: MigrationRecord[];
  /**
   * Migrations not yet applied, in the order `migrate()` would run them.
   */
  pending: Migration[];
}

/**
 * Options for `loadMigrations()`.
 *
 * ```ts no_run
 * import { loadMigrations } from 'fino:database/migrate';
 *
 * const migrations = await loadMigrations('*.sql', { cwd: '/srv/app/migrations' });
 * ```
 */
export interface LoadMigrationsOptions {
  /**
   * Base directory for glob patterns and relative paths.
   */
  cwd?: string;
  /**
   * Filesystem used to expand globs and read `.sql` files; defaults to a
   * `DiskFileSystem`. TypeScript migration modules are loaded with `import()`
   * regardless of this option.
   */
  fs?: FileSystem;
}

/**
 * Options shared by migration planning and execution.
 *
 * ```ts no_run
 * import { migrate } from 'fino:database/migrate';
 *
 * await migrate(db, migrations, { tableName: 'schema_history', transaction: false });
 * ```
 */
export interface MigrateOptions {
  /**
   * History table name; defaults to `fino_migrations`. Must be a plain SQL
   * identifier (`[A-Za-z_][A-Za-z0-9_]*`) or a `MigrationError` is thrown.
   */
  tableName?: string;
  /**
   * Whether each migration runs inside `db.transaction()`. Defaults to `true`;
   * set to `false` for statements that cannot run in a transaction, at the
   * cost of atomicity when a statement fails.
   */
  transaction?: boolean;
}

/**
 * Options for rollback execution.
 *
 * ```ts no_run
 * import { rollback } from 'fino:database/migrate';
 *
 * await rollback(db, migrations, { steps: 2 });
 * ```
 */
export interface RollbackOptions extends MigrateOptions {
  /**
   * How many active migrations to revert, newest first. Defaults to `1`.
   */
  steps?: number;
}

/**
 * Return `migration` unchanged while preserving the public `Migration` type.
 *
 * An identity helper for writing migrations inline or as TypeScript modules:
 * it adds type checking and editor completion without altering the value.
 *
 * ```ts no_run
 * import { defineMigration } from 'fino:database/migrate';
 *
 * export default defineMigration({
 *   id: '003_add_email',
 *   up: 'ALTER TABLE users ADD COLUMN email TEXT',
 *   down: 'ALTER TABLE users DROP COLUMN email'
 * });
 * ```
 */
export function defineMigration(migration: Migration): Migration {
  return migration;
}

function migrationName(id: string): string {
  return id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
}

function validateTableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new MigrationError(`Invalid migration table name: ${name}`);
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

async function checksumFor(
  body: MigrationBody,
  migration: Migration,
  db: DatabaseConnection,
): Promise<string> {
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
    const rows = await db
      .prepare(
        `SELECT id, name, checksum, direction, applied_at, duration_ms FROM ${tableName} ORDER BY applied_at ASC`,
      )
      .all();
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      name: String(row.name),
      checksum: String(row.checksum),
      direction: row.direction === 'down' ? 'down' : 'up',
      appliedAt: Number(row.applied_at),
      durationMs: Number(row.duration_ms),
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
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read currently applied migrations from the history table.
 *
 * Replays the append-only history log, so migrations that were later rolled
 * back do not appear. A missing history table is treated as an empty migration
 * history, making this safe to call against a fresh database.
 *
 * ```ts no_run
 * import { getAppliedMigrations } from 'fino:database/migrate';
 *
 * const applied = await getAppliedMigrations(db);
 * console.log(applied.map((record) => record.id));
 * ```
 */
export async function getAppliedMigrations(
  db: DatabaseConnection,
  options: MigrateOptions = {},
): Promise<MigrationRecord[]> {
  return activeRecords(
    await readHistory(db, validateTableName(options.tableName ?? 'fino_migrations')),
  );
}

/**
 * Compare migrations with database history and return applied and pending sets.
 *
 * Migrations are de-duplicated and sorted by `id` before comparison; duplicate
 * ids throw a `MigrationError`. For each migration that is already active, the
 * current checksum of its `up` body is compared against the recorded one, and
 * a mismatch throws a `MigrationError` naming the drifted migration.
 *
 * This is a dry run: nothing is executed and no history is written, so it
 * suits a `migrate --dry-run` style status command.
 *
 * ```ts no_run
 * import { loadMigrations, planMigrations } from 'fino:database/migrate';
 *
 * const plan = await planMigrations(db, await loadMigrations('./migrations/*.sql'));
 * for (const migration of plan.pending) console.log('would apply', migration.id);
 * ```
 */
export async function planMigrations(
  db: DatabaseConnection,
  migrations: Migration[],
  options: MigrateOptions = {},
): Promise<MigrationPlan> {
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
    if (active.checksum !== nextChecksum)
      throw new MigrationError(`Migration checksum changed for ${migration.id}`);
  }
  return { applied, pending };
}

async function runStatements(db: DatabaseConnection, statements: string[]): Promise<void> {
  for (const statement of statements) {
    if (statement.trim()) await db.exec(statement);
  }
}

async function record(
  db: DatabaseConnection,
  tableName: string,
  migration: Migration,
  checksum: string,
  direction: 'up' | 'down',
  started: number,
): Promise<MigrationRecord> {
  const appliedAt = Date.now();
  const durationMs = Math.max(0, appliedAt - started);
  await db
    .prepare(
      `INSERT INTO ${tableName}(id, name, checksum, direction, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      migration.id,
      migration.name ?? migrationName(migration.id),
      checksum,
      direction,
      appliedAt,
      durationMs,
    );
  return {
    id: migration.id,
    name: migration.name ?? migrationName(migration.id),
    checksum,
    direction,
    appliedAt,
    durationMs,
  };
}

/**
 * Apply all pending `up` migrations.
 *
 * Creates the history table if needed, plans against current history — which
 * rejects checksum drift before anything runs — then applies pending
 * migrations in `id` order. Each migration executes inside `db.transaction()`
 * unless `transaction` is `false`, so a failing statement rolls back both the
 * migration's changes and its history row. Already-applied migrations are
 * skipped, making repeated calls idempotent.
 *
 * Returns records for the migrations applied by this call; an up-to-date
 * database yields an empty array.
 *
 * ```ts no_run
 * import { Database } from 'fino:database';
 * import { loadMigrations, migrate } from 'fino:database/migrate';
 *
 * await using db = await Database.open(process.env.DATABASE_URL ?? ':memory:');
 * const applied = await migrate(db, await loadMigrations('./migrations/*.sql'));
 * for (const record of applied) console.log(`applied ${record.id} in ${record.durationMs}ms`);
 * ```
 */
export async function migrate(
  db: DatabaseConnection,
  migrations: Migration[],
  options: MigrateOptions = {},
): Promise<MigrationRecord[]> {
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
 * Active migrations are reverted newest first (descending `id`); `steps`
 * controls how many and defaults to `1`. Every reverted migration must be
 * present in `migrations` and define `down`, otherwise a `MigrationError` is
 * thrown. Each rollback runs inside `db.transaction()` unless `transaction` is
 * `false`, and appends a `'down'` history row rather than deleting the
 * original record. Returns records for the reverted migrations.
 *
 * ```ts no_run
 * import { loadMigrations, rollback } from 'fino:database/migrate';
 *
 * const migrations = await loadMigrations('./migrations/*.sql');
 * await rollback(db, migrations);               // undo the most recent migration
 * await rollback(db, migrations, { steps: 2 }); // undo the next two
 * ```
 */
export async function rollback(
  db: DatabaseConnection,
  migrations: Migration[],
  options: RollbackOptions = {},
): Promise<MigrationRecord[]> {
  const tableName = validateTableName(options.tableName ?? 'fino_migrations');
  await ensureHistory(db, tableName);
  const active = activeRecords(await readHistory(db, tableName)).sort((a, b) =>
    a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
  const byId = new Map(sortedUnique(migrations).map((migration) => [migration.id, migration]));
  const steps = options.steps ?? 1;
  const rolledBack: MigrationRecord[] = [];
  for (const activeRecord of active.slice(0, steps)) {
    const migration = byId.get(activeRecord.id);
    if (!migration)
      throw new MigrationError(`No migration definition found for rollback: ${activeRecord.id}`);
    if (!migration.down)
      throw new MigrationError(`Migration ${activeRecord.id} does not define down SQL`);
    const started = Date.now();
    const task = async () => {
      await runStatements(db, await resolveBody(migration.down!, { db, migration, sql }));
      rolledBack.push(
        await record(db, tableName, migration, activeRecord.checksum, 'down', started),
      );
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
    ...(functions.down ? { down: () => functions.down() } : {}),
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
 * Each pattern is either a literal path or a glob (any of `*`, `?`, `{`, `[`
 * triggers glob expansion through the filesystem's `glob()`); `cwd` anchors
 * both forms. Matched paths are sorted, and each migration's `id` is derived
 * from the file basename with `.sql`, `.ts`, or `.sql.ts` stripped, so
 * filenames like `001_create_users.sql` produce ordered ids.
 *
 * `.sql` files may be plain SQL — the whole file becomes the `up` body — or
 * directive SQL (see `fino:database/sql`) with an exported `up()` function and
 * optional `down()`. Other files are imported as modules and must export `up`;
 * exported `down`, `id`, and `name` are used when present. Throws a
 * `MigrationError` for modules without a usable `up` export or for duplicate
 * ids, and a `MigrationParseError` for directive SQL that does not export
 * `up()`.
 *
 * ```ts no_run
 * import { loadMigrations, migrate } from 'fino:database/migrate';
 *
 * // migrations/001_users.sql:
 * //   -- function up()
 * //   CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
 * //
 * //   -- function down()
 * //   DROP TABLE users;
 * const migrations = await loadMigrations('./migrations/*.sql');
 * await migrate(db, migrations);
 * ```
 */
export async function loadMigrations(
  pattern: string | string[],
  options: LoadMigrationsOptions = {},
): Promise<Migration[]> {
  const fs = options.fs ?? new DiskFileSystem();
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const paths: string[] = [];
  for (const pat of patterns) {
    if (/[*?{[]/.test(pat)) {
      for await (const entry of (fs as DiskFileSystem).glob(pat, {
        cwd: options.cwd,
        onlyFiles: true,
      }))
        paths.push(entry.path.toString());
    } else {
      paths.push(options.cwd ? `${options.cwd}/${pat}` : pat);
    }
  }
  const migrations: Migration[] = [];
  const textDecoder = new TextDecoder();
  for (const path of paths.sort()) {
    if (/\.sql$/i.test(path)) {
      migrations.push(
        migrationFromSql(idFromPath(path), textDecoder.decode(await fs.readFile(path)), path),
      );
    } else {
      const mod = (await import(path.startsWith('/') ? `file://${path}` : path)) as Record<
        string,
        unknown
      >;
      const id = typeof mod.id === 'string' ? mod.id : idFromPath(path);
      if (typeof mod.up !== 'function' && typeof mod.up !== 'string' && !Array.isArray(mod.up))
        throw new MigrationError(`Migration module ${path} must export up`);
      migrations.push(
        defineMigration({
          id,
          name: typeof mod.name === 'string' ? mod.name : migrationName(id),
          up: mod.up as MigrationBody,
          ...(mod.down !== undefined ? { down: mod.down as MigrationBody } : {}),
        }),
      );
    }
  }
  return sortedUnique(migrations);
}
