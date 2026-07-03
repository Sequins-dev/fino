/**
* fino:database — generic relational database facade.
*
* This module provides the common application-facing database shape and routes
* connection strings to concrete engines. SQLite remains available through
* `fino:database/sqlite`; Postgres-specific APIs live in
* `fino:database/postgres`.
*
* The shared API intentionally covers only portable connection, statement,
* query, transaction, and disposal behavior. Engine-specific features such as
* SQLite VFS/extension loading or Postgres LISTEN/NOTIFY remain on concrete
* connection classes.
*
* ```ts no_run
* import { Database, sql } from 'fino:database';
*
* await using db = await Database.open(process.env.DATABASE_URL ?? ':memory:');
* const rows = await db.prepare(sql`SELECT ${1} AS value`).all();
* console.log(rows);
* ```
*/
import * as sqlite from 'fino:database/sqlite';
import { PostgresDatabase } from 'fino:database/postgres';
export type DatabaseDriver = 'sqlite' | 'postgres';
export type DbValue = null | undefined | bigint | number | string | boolean | Uint8Array | Date;
export type DbParams = DbValue | Record<string, DbValue>;
export type DbRow = Record<string, DbValue>;
export interface QueryResult {
  changes: number;
  lastInsertRowid?: bigint;
  command?: string;
}
export interface DatabaseStatement {
  run(...params: DbParams[]): Promise<QueryResult>;
  get(...params: DbParams[]): Promise<DbRow | undefined>;
  all(...params: DbParams[]): Promise<DbRow[]>;
  iterate(...params: DbParams[]): AsyncGenerator<DbRow>;
  finalize(): void;
}
export interface DatabaseConnection {
  readonly driver: DatabaseDriver;
  exec(query: SqlInput): Promise<void>;
  prepare(query: SqlInput): DatabaseStatement;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
export type SqlDialect = DatabaseDriver;
export type SqlInput = string | SqlFragment;
type SqlPart = { kind: 'text'; text: string } | { kind: 'value'; index: number };
/**
* Portable SQL fragment produced by the `sql` tag.
*
* Render with `text('postgres')` or `text('sqlite')` to get dialect-native
* placeholders. Values are kept separately for statement binding.
*/
export interface SqlFragment {
  readonly kind: 'sql';
  readonly values: DbValue[];
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
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'sql' && typeof (value as { text?: unknown }).text === 'function' && Array.isArray((value as { values?: unknown }).values);
}
function appendFragment(parts: SqlPart[], values: DbValue[], fragment: SqlFragment): void {
  const offset = values.length;
  const rendered = fragment.text('postgres');
  let cursor = 0;
  for (const match of rendered.matchAll(/\$(\d+)/g)) {
    if (match.index! > cursor) parts.push({ kind: 'text', text: rendered.slice(cursor, match.index) });
    parts.push({ kind: 'value', index: offset + Number(match[1]) - 1 });
    cursor = match.index! + match[0].length;
  }
  if (cursor < rendered.length) parts.push({ kind: 'text', text: rendered.slice(cursor) });
  values.push(...fragment.values);
}
function makeFragment(strings: TemplateStringsArray, substitutions: unknown[]): SqlFragment {
  const parts: SqlPart[] = [];
  const values: DbValue[] = [];
  for (let index = 0; index < strings.length; index++) {
    if (strings[index]) parts.push({ kind: 'text', text: strings[index]! });
    if (index >= substitutions.length) continue;
    const value = substitutions[index];
    if (isFragment(value)) appendFragment(parts, values, value);
    else {
      values.push(value as DbValue);
      parts.push({ kind: 'value', index: values.length - 1 });
    }
  }
  return new Fragment(parts, values);
}
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(name)) throw new TypeError(`Invalid SQL identifier: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}
export interface SqlTag {
  (strings: TemplateStringsArray, ...substitutions: unknown[]): SqlFragment;
  raw(text: string): SqlFragment;
  identifier(name: string): SqlFragment;
  join(values: unknown[], separator?: SqlFragment | string): SqlFragment;
}
function sqlTag(strings: TemplateStringsArray, ...substitutions: unknown[]): SqlFragment {
  return makeFragment(strings, substitutions);
}
export const sql: SqlTag = Object.assign(sqlTag, {
  raw(text: string): SqlFragment {
    return new Fragment([{ kind: 'text', text: String(text) }], []);
  },
  identifier(name: string): SqlFragment {
    return new Fragment([{ kind: 'text', text: quoteIdentifier(name) }], []);
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
        parts.push({ kind: 'value', index: out.length - 1 });
      }
    });
    return new Fragment(parts, out);
  }
});
function renderInput(input: SqlInput, dialect: SqlDialect): { text: string; values: DbValue[] } {
  if (typeof input === 'string') return { text: input, values: [] };
  return { text: input.text(dialect), values: input.values };
}
type PlaceholderToken = { kind: 'positional' } | { kind: 'named'; name: string };
function isBindRecord(value: unknown): value is Record<string, DbValue> {
  return typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !(value instanceof Date);
}
function postgresPlaceholderPlan(query: string): { text: string; bind(params: DbParams[]): DbValue[] } {
  const tokens: PlaceholderToken[] = [];
  let text = '';
  let quote: "'" | '"' | null = null;
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
    if (ch === "'" || ch === '"') {
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
      tokens.push({ kind: 'named', name });
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
* Generic database opener.
*/
export class Database {
  static async open(target: string | URL, options: Record<string, unknown> = {}): Promise<DatabaseConnection> {
    const value = String(target);
    if (isPostgresTarget(value)) return new GenericDatabase('postgres', await PostgresDatabase.open(value, options as any));
    return new GenericDatabase('sqlite', await sqlite.Database.open(sqlitePathFromTarget(value), options as sqlite.DatabaseOptions));
  }
}
export { PostgresDatabase, sqlite };
