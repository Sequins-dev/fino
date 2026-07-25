/**
* fino:database — generic relational database facade.
*
* This module provides the common application-facing database shape and routes
* connection strings to concrete engines. `Database.open()` inspects the
* target: `postgres://` and `postgresql://` URLs connect through
* `fino:database/postgres`, while everything else — filesystem paths,
* `':memory:'`, and `sqlite://` URLs — opens through `fino:database/sqlite`.
* Both engines are wrapped in the same `DatabaseConnection` interface, so
* application code written against this module stays portable across drivers.
*
* The shared API intentionally covers only portable connection, statement,
* query, transaction, and disposal behavior. Engine-specific features such as
* SQLite VFS/extension loading or Postgres LISTEN/NOTIFY remain on the
* concrete connection classes, which this module re-exports as
* `PostgresDatabase` and the `sqlite` namespace.
*
* Two layers smooth over placeholder differences between the engines. The
* `sql` template tag builds `SqlFragment` values that render `?` placeholders
* for SQLite and `$n` for Postgres while carrying bound values separately from
* the SQL text. Plain string queries prepared on a Postgres connection are
* additionally normalized: `?` positional and `:name` named placeholders are
* rewritten to `$n` (quoted regions and `::` casts are left untouched), so the
* same query string works against both engines.
*
* Connections implement `Symbol.asyncDispose`, so `await using` closes them
* automatically at scope exit.
*
* ```ts no_run
* import { Database, sql } from 'fino:database';
*
* await using db = await Database.open(process.env.DATABASE_URL ?? ':memory:');
* await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
* await db.prepare('INSERT INTO users (name) VALUES (:name)').run({ name: 'Ada' });
* const rows = await db.prepare(sql`SELECT * FROM users WHERE id = ${1}`).all();
* console.log(rows);
* ```
*/
import * as sqlite from 'fino:database/sqlite';
import { PostgresDatabase } from 'fino:database/postgres';
/**
* Identifier for the concrete engine behind a connection.
*
* `Database.open()` selects the driver from the connection target and exposes
* the choice as `DatabaseConnection.driver`, letting portable code branch
* into dialect-specific SQL only where it must.
*/
export type DatabaseDriver = 'sqlite' | 'postgres';
/**
* Portable values accepted for parameter binding and returned in result rows.
*
* `null` and `undefined` bind as SQL NULL. `bigint` and integral `number`
* values bind as integers, other numbers as floating point, strings as text,
* and `Uint8Array` as BLOB/`bytea`. `Date` is serialized to an ISO-8601
* string by the Postgres engine; SQLite has no native date binding, so
* convert dates to strings or numbers explicitly in portable code.
*/
export type DbValue = null | undefined | bigint | number | string | boolean | Uint8Array | Date;
/**
* One argument to statement execution: a positional value or a record of
* named parameters.
*
* Positional values fill `?` (or `$n`) placeholders in order. A record binds
* named placeholders — write `:name` in the SQL and key the record by the
* bare name. Prefer either positional values or a single named record per
* call: SQLite rejects mixing a named record with positional placeholders,
* while the Postgres placeholder rewrite tolerates the combination.
*/
export type DbParams = DbValue | Record<string, DbValue>;
/**
* A single result row: column names mapped to portable values.
*
* Value representation follows the engine's type mapping — for example
* SQLite integers arrive as `number` by default (or `bigint` when the
* connection was opened with the engine's `safeIntegers` option).
*/
export type DbRow = Record<string, DbValue>;
/**
* Outcome of a statement executed with `DatabaseStatement.run()`.
*
* `changes` is always present; the other fields depend on the engine that
* produced the result.
*/
export interface QueryResult {
  /** Number of rows inserted, updated, or deleted by the statement. */
  changes: number;
  /**
  * Rowid of the most recently inserted row. Present on SQLite results only;
  * Postgres omits it.
  */
  lastInsertRowid?: bigint;
  /**
  * Server command tag such as `INSERT 0 1`. Present on Postgres results
  * only; SQLite omits it.
  */
  command?: string;
}
/**
* Prepared statement handle shared by both engines.
*
* Statements come from `DatabaseConnection.prepare()` and may be executed
* repeatedly with different parameters. Each execution method accepts
* positional values or a single record of named parameters (see `DbParams`).
* When the statement was prepared from a `SqlFragment`, the fragment's
* interpolated values are bound first and call-time parameters follow them.
*
* ```ts no_run
* import { Database } from 'fino:database';
*
* await using db = await Database.open(':memory:');
* await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
*
* const insert = db.prepare('INSERT INTO users (name) VALUES (?)');
* await insert.run('Ada');
* await insert.run('Grace');
* insert.finalize();
*
* const byId = db.prepare('SELECT * FROM users WHERE id = :id');
* console.log(await byId.get({ id: 1 }));
*
* for await (const row of db.prepare('SELECT name FROM users').iterate()) {
*   console.log(row.name);
* }
* ```
*/
export interface DatabaseStatement {
  /**
  * Execute the statement for its side effects and resolve with the change
  * count plus engine-specific metadata. Use for INSERT/UPDATE/DELETE and
  * DDL; result rows, if any, are not returned.
  */
  run(...params: DbParams[]): Promise<QueryResult>;
  /**
  * Execute the statement and resolve with the first result row, or
  * `undefined` when the query produces no rows.
  */
  get(...params: DbParams[]): Promise<DbRow | undefined>;
  /** Execute the statement and resolve with every result row as an array. */
  all(...params: DbParams[]): Promise<DbRow[]>;
  /**
  * Execute the statement and yield result rows one at a time, avoiding
  * buffering the full result set in memory.
  */
  iterate(...params: DbParams[]): AsyncGenerator<DbRow>;
  /**
  * Release the engine's underlying prepared statement. Call once the
  * statement will not be executed again; executing after finalization is
  * invalid.
  */
  finalize(): void;
}
/**
* Engine-agnostic connection contract returned by `Database.open()`.
*
* Both the SQLite and Postgres engines are wrapped in this shape: `exec()`
* for fire-and-forget statements, `prepare()` for reusable parameterized
* statements, `transaction()` for atomic groups, and `close()` (aliased as
* `Symbol.asyncDispose`) for teardown. Anything beyond this portable core
* lives on the concrete engine classes.
*
* ```ts no_run
* import { Database, sql } from 'fino:database';
*
* await using db = await Database.open(process.env.DATABASE_URL ?? ':memory:');
* await db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, balance REAL)');
*
* await db.transaction(async () => {
*   await db.prepare(sql`UPDATE accounts SET balance = balance - ${25} WHERE id = ${1}`).run();
*   await db.prepare(sql`UPDATE accounts SET balance = balance + ${25} WHERE id = ${2}`).run();
* });
*
* console.log(db.driver, await db.prepare('SELECT * FROM accounts').all());
* ```
*/
export interface DatabaseConnection {
  /**
  * The engine this connection routes to. Branch on it when a query needs
  * dialect-specific SQL.
  */
  readonly driver: DatabaseDriver;
  /**
  * Run a query for its side effects, discarding any result rows.
  *
  * Plain strings and value-free fragments go through the engine's exec path,
  * which typically permits multiple `;`-separated statements. A fragment
  * carrying interpolated values is instead prepared and run once so the
  * values bind as parameters.
  */
  exec(query: SqlInput): Promise<void>;
  /**
  * Create a reusable `DatabaseStatement` from a string or `SqlFragment`.
  *
  * Plain strings prepared on Postgres are placeholder-normalized: `?` and
  * `:name` become `$n`, skipping quoted text and `::` casts. SQLite strings
  * pass through untouched because SQLite natively understands both forms.
  * Fragments render dialect-native placeholder text with their interpolated
  * values pre-bound ahead of any call-time parameters.
  */
  prepare(query: SqlInput): DatabaseStatement;
  /**
  * Run `fn` inside a transaction: BEGIN first, COMMIT when it resolves, and
  * ROLLBACK when it throws (the original error is rethrown).
  */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Close the connection and release the engine's resources. */
  close(): Promise<void>;
  /**
  * Alias for `close()`, enabling
  * `await using db = await Database.open(...)`.
  */
  [Symbol.asyncDispose](): Promise<void>;
}
/**
* Placeholder dialect used when rendering a `SqlFragment` to text.
*
* Identical to `DatabaseDriver`: `'postgres'` renders `$1`, `$2`, …
* placeholders while `'sqlite'` renders `?`.
*/
export type SqlDialect = DatabaseDriver;
/**
* Query forms accepted by `exec()` and `prepare()`: a raw SQL string or a
* `SqlFragment` built with the `sql` tag.
*/
export type SqlInput = string | SqlFragment;
type SqlPart = {
  kind: 'text';
  text: string;
} | {
  kind: 'value';
  index: number;
};
/**
* Portable SQL fragment produced by the `sql` tag.
*
* A fragment keeps the SQL text and its interpolated values separate so the
* values can be bound as statement parameters instead of being spliced into
* the query string. Fragments compose: interpolating one fragment inside
* another splices its text and renumbers its value slots.
*
* Detection is structural — anything with `kind: 'sql'`, a `values` array,
* and a `text` function is treated as a fragment — so fragments do not need
* to come from this module's own `sql` tag to compose with it.
*
* ```ts no_run
* import { sql, type SqlFragment } from 'fino:database';
*
* const where: SqlFragment = sql`WHERE id = ${42}`;
* const query = sql`SELECT * FROM users ${where}`;
* console.log(query.text('postgres')); // SELECT * FROM users WHERE id = $1
* console.log(query.text('sqlite'));   // SELECT * FROM users WHERE id = ?
* console.log(query.values);           // [42]
* ```
*/
export interface SqlFragment {
  /** Discriminant marking a value as a SQL fragment; always `'sql'`. */
  readonly kind: 'sql';
  /** Interpolated values in placeholder order, ready for statement binding. */
  readonly values: DbValue[];
  /**
  * Render the fragment as SQL text with dialect-native placeholders: `$1`,
  * `$2`, … for `'postgres'` and `?` for `'sqlite'`.
  */
  text(dialect: SqlDialect): string;
}
class Fragment implements SqlFragment {
  readonly kind = 'sql';
  readonly values: DbValue[];
  readonly #parts: SqlPart[];
  constructor(parts: SqlPart[], values: DbValue[]) {
    this.#parts = parts;
    this.values = values;
  }
  text(dialect: SqlDialect): string {
    return this.#parts.map((part) => {
      if (part.kind === 'text') return part.text;
      return dialect === 'postgres' ? `$${part.index + 1}` : '?';
    }).join('');
  }
}
function isFragment(value: unknown): value is SqlFragment {
  return typeof value === 'object' && value !== null && (value as {
    kind?: unknown;
  }).kind === 'sql' && typeof (value as {
    text?: unknown;
  }).text === 'function' && Array.isArray((value as {
    values?: unknown;
  }).values);
}
function appendFragment(parts: SqlPart[], values: DbValue[], fragment: SqlFragment): void {
  const offset = values.length;
  const rendered = fragment.text('postgres');
  let cursor = 0;
  for (const match of rendered.matchAll(/\$(\d+)/g)) {
    if (match.index! > cursor) parts.push({
      kind: 'text',
      text: rendered.slice(cursor, match.index)
    });
    parts.push({
      kind: 'value',
      index: offset + Number(match[1]) - 1
    });
    cursor = match.index! + match[0].length;
  }
  if (cursor < rendered.length) parts.push({
    kind: 'text',
    text: rendered.slice(cursor)
  });
  values.push(...fragment.values);
}
function makeFragment(strings: TemplateStringsArray, substitutions: unknown[]): SqlFragment {
  const parts: SqlPart[] = [];
  const values: DbValue[] = [];
  for (let index = 0; index < strings.length; index++) {
    if (strings[index]) parts.push({
      kind: 'text',
      text: strings[index]!
    });
    if (index >= substitutions.length) continue;
    const value = substitutions[index];
    if (isFragment(value)) appendFragment(parts, values, value);
    else {
      values.push(value as DbValue);
      parts.push({
        kind: 'value',
        index: values.length - 1
      });
    }
  }
  return new Fragment(parts, values);
}
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(name)) throw new TypeError(`Invalid SQL identifier: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}
/**
* Shape of the `sql` template tag: callable as a tag, with helpers for the
* positions placeholders cannot express.
*
* ```ts no_run
* import { sql, type SqlTag } from 'fino:database';
*
* const tag: SqlTag = sql;
* const fragment = tag`SELECT ${1} AS answer`;
* console.log(fragment.values); // [1]
* ```
*/
export interface SqlTag {
  /**
  * Build a `SqlFragment` from a template literal. Interpolated values become
  * bound parameters; interpolated fragments are spliced inline.
  */
  (strings: TemplateStringsArray, ...substitutions: unknown[]): SqlFragment;
  /**
  * Insert `text` verbatim, with no escaping or binding. Only pass trusted,
  * program-controlled SQL — never user input.
  */
  raw(text: string): SqlFragment;
  /**
  * Quote `name` as a double-quoted SQL identifier for table or column
  * positions. Throws `TypeError` unless the name starts with a letter or
  * underscore and contains only letters, digits, underscores, and spaces.
  */
  identifier(name: string): SqlFragment;
  /**
  * Join `values` with `separator` (`', '` by default). Plain values become
  * bound parameters and fragments are spliced; a string separator is
  * inserted as raw SQL.
  */
  join(values: unknown[], separator?: SqlFragment | string): SqlFragment;
}
function sqlTag(strings: TemplateStringsArray, ...substitutions: unknown[]): SqlFragment {
  return makeFragment(strings, substitutions);
}
/**
* Template tag for building parameterized, dialect-portable SQL.
*
* Interpolated values never enter the SQL text: each `${value}` becomes a
* placeholder and the value travels in `SqlFragment.values` for statement
* binding, which makes value positions safe from SQL injection.
* Interpolating another fragment splices it inline with its placeholders
* renumbered, so queries can be assembled from reusable pieces.
*
* The helpers cover what placeholders cannot: `sql.identifier()` validates
* and quotes table or column names, `sql.join()` expands lists (for example
* `IN (...)` membership tests), and `sql.raw()` inserts trusted SQL text
* verbatim.
*
* ```ts no_run
* import { Database, sql } from 'fino:database';
*
* await using db = await Database.open(':memory:');
* const table = sql.identifier('users');
* const names = ['Ada', 'Grace'];
* const query = sql`SELECT * FROM ${table} WHERE name IN (${sql.join(names)})`;
* // postgres: SELECT * FROM "users" WHERE name IN ($1, $2)
* // sqlite:   SELECT * FROM "users" WHERE name IN (?, ?)
* const rows = await db.prepare(query).all();
* console.log(rows);
* ```
*/
export const sql: SqlTag = Object.assign(sqlTag, {
  raw(text: string): SqlFragment {
    return new Fragment([{
      kind: 'text',
      text: String(text)
    }], []);
  },
  identifier(name: string): SqlFragment {
    return new Fragment([{
      kind: 'text',
      text: quoteIdentifier(name)
    }], []);
  },
  join(values: unknown[], separator: SqlFragment | string = ', '): SqlFragment {
    const parts: SqlPart[] = [];
    const out: DbValue[] = [];
    const sep = typeof separator === 'string' ? sql.raw(separator) : separator;
    values.forEach((value, index) => {
      if (index > 0) appendFragment(parts, out, sep);
      if (isFragment(value)) appendFragment(parts, out, value);
      else {
        out.push(value as DbValue);
        parts.push({
          kind: 'value',
          index: out.length - 1
        });
      }
    });
    return new Fragment(parts, out);
  }
});
function renderInput(input: SqlInput, dialect: SqlDialect): {
  text: string;
  values: DbValue[];
} {
  if (typeof input === 'string') return {
    text: input,
    values: []
  };
  return {
    text: input.text(dialect),
    values: input.values
  };
}
type PlaceholderToken = {
  kind: 'positional';
} | {
  kind: 'named';
  name: string;
};
function isBindRecord(value: unknown): value is Record<string, DbValue> {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !(value instanceof Date);
}
function postgresPlaceholderPlan(query: string): {
  text: string;
  bind(params: DbParams[]): DbValue[];
} {
  const tokens: PlaceholderToken[] = [];
  let text = '';
  let quote: '\'' | '"' | null = null;
  for (let index = 0; index < query.length; index++) {
    const ch = query[index]!;
    if (quote !== null) {
      text += ch;
      if (ch === quote) {
        if (query[index + 1] === quote) {
          text += query[++index]!;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      text += ch;
      continue;
    }
    if (ch === '?') {
      tokens.push({ kind: 'positional' });
      text += `$${tokens.length}`;
      continue;
    }
    if (ch === ':' && query[index + 1] === ':') {
      text += '::';
      index++;
      continue;
    }
    if (ch === ':' && /[A-Za-z_]/.test(query[index + 1] ?? '')) {
      let end = index + 2;
      while (/[A-Za-z0-9_]/.test(query[end] ?? '')) end++;
      const name = query.slice(index + 1, end);
      tokens.push({
        kind: 'named',
        name
      });
      text += `$${tokens.length}`;
      index = end - 1;
      continue;
    }
    text += ch;
  }
  return {
    text,
    bind(params: DbParams[]): DbValue[] {
      const named = params.find(isBindRecord);
      let positional = 0;
      return tokens.map((token) => {
        if (token.kind === 'positional') {
          while (isBindRecord(params[positional])) positional++;
          return params[positional++] as DbValue;
        }
        if (!named || !(token.name in named)) throw new Error(`Missing SQL parameter :${token.name}`);
        return named[token.name];
      });
    }
  };
}
class GenericStatement implements DatabaseStatement {
  readonly #driver: DatabaseDriver;
  readonly #inner: any;
  constructor(driver: DatabaseDriver, inner: any) {
    this.#driver = driver;
    this.#inner = inner;
  }
  run(...params: DbParams[]): Promise<QueryResult> {
    return this.#inner.run(...params) as Promise<QueryResult>;
  }
  get(...params: DbParams[]): Promise<DbRow | undefined> {
    return this.#inner.get(...params) as Promise<DbRow | undefined>;
  }
  all(...params: DbParams[]): Promise<DbRow[]> {
    return this.#inner.all(...params) as Promise<DbRow[]>;
  }
  iterate(...params: DbParams[]): AsyncGenerator<DbRow> {
    return this.#inner.iterate(...params) as AsyncGenerator<DbRow>;
  }
  finalize(): void {
    this.#inner.finalize();
  }
  get driver(): DatabaseDriver {
    return this.#driver;
  }
}
class GenericDatabase implements DatabaseConnection {
  readonly driver: DatabaseDriver;
  readonly inner: any;
  constructor(driver: DatabaseDriver, inner: any) {
    this.driver = driver;
    this.inner = inner;
  }
  async exec(query: SqlInput): Promise<void> {
    const rendered = renderInput(query, this.driver);
    if (rendered.values.length === 0) return this.inner.exec(rendered.text);
    await this.prepare(query).run();
  }
  prepare(query: SqlInput): DatabaseStatement {
    const rendered = renderInput(query, this.driver);
    const plan = this.driver === 'postgres' && typeof query === 'string' ? postgresPlaceholderPlan(rendered.text) : null;
    const stmt = this.inner.prepare(plan?.text ?? rendered.text);
    if (plan) {
      return new GenericStatement(this.driver, {
        run: (...params: DbParams[]) => stmt.run(...plan.bind(params)),
        get: (...params: DbParams[]) => stmt.get(...plan.bind(params)),
        all: (...params: DbParams[]) => stmt.all(...plan.bind(params)),
        iterate: (...params: DbParams[]) => stmt.iterate(...plan.bind(params)),
        finalize: () => stmt.finalize()
      });
    }
    if (rendered.values.length === 0) return new GenericStatement(this.driver, stmt);
    return new GenericStatement(this.driver, {
      run: (...params: DbParams[]) => stmt.run(...rendered.values, ...params),
      get: (...params: DbParams[]) => stmt.get(...rendered.values, ...params),
      all: (...params: DbParams[]) => stmt.all(...rendered.values, ...params),
      iterate: (...params: DbParams[]) => stmt.iterate(...rendered.values, ...params),
      finalize: () => stmt.finalize()
    });
  }
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
function isPostgresTarget(target: string): boolean {
  return /^postgres(?:ql)?:\/\//i.test(target);
}
function sqlitePathFromTarget(target: string): string {
  if (!/^sqlite:\/\//i.test(target)) return target;
  const url = new URL(target);
  if (url.hostname && url.hostname !== 'localhost') return `/${url.hostname}${url.pathname}`;
  return decodeURIComponent(url.pathname || ':memory:');
}
/**
* Entry point that opens a connection on whichever engine matches the target.
*
* This is the portable front door of the module: hand it a connection string
* (typically from configuration such as `DATABASE_URL`) and it returns a
* `DatabaseConnection` backed by the right engine. Code that needs
* engine-specific features should open `PostgresDatabase` or
* `sqlite.Database` directly instead.
*
* ```ts no_run
* import { Database } from 'fino:database';
*
* await using pg = await Database.open('postgres://app@localhost/app');
* await using file = await Database.open('./data/app.db');
* await using mem = await Database.open(':memory:');
* console.log(pg.driver, file.driver, mem.driver); // postgres sqlite sqlite
* ```
*/
export class Database {
  /**
  * Open a connection to `target` and resolve with a `DatabaseConnection`.
  *
  * Targets matching `postgres://` or `postgresql://` (case-insensitive)
  * connect over the Postgres wire protocol. Anything else is treated as
  * SQLite: a filesystem path, `':memory:'`, or a `sqlite://` URL whose
  * decoded path names the database file (an empty path means in-memory).
  * `options` passes through to the selected engine's `open()`, so
  * engine-specific settings — SQLite `safeIntegers` or `fs`, Postgres
  * credentials or `tls` — remain available.
  *
  * Throws if the engine's shared library is unavailable or the connection
  * cannot be established.
  */
  static async open(target: string | URL, options: Record<string, unknown> = {}): Promise<DatabaseConnection> {
    const value = String(target);
    if (isPostgresTarget(value)) return new GenericDatabase('postgres', await PostgresDatabase.open(value, options as any));
    return new GenericDatabase('sqlite', await sqlite.Database.open(sqlitePathFromTarget(value), options as sqlite.DatabaseOptions));
  }
}
/**
* Engine-specific entry points, re-exported for direct access: the
* `PostgresDatabase` class and the full `fino:database/sqlite` namespace.
*/
export { PostgresDatabase, sqlite };
