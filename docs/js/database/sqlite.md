# sqlite

fino:database/sqlite — SQLite database access via system libsqlite3.

Uses dlopen to load the system-installed libsqlite3. All file I/O is
routed through the realm's FileSystem provider via a JS-implemented
sqlite3_vfs, so virtual providers (MemoryFileSystem, S3FileSystem, etc.)
work transparently.

Usage:

```ts
import { Database } from 'fino:database/sqlite';
const db = await Database.open('/path/to.db');
await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
const stmt = db.prepare('INSERT INTO t VALUES (?, ?)');
await stmt.run(1n, 'hello');
const rows = await db.prepare('SELECT * FROM t').all();
await db.close();
```

## DatabaseOptions

```ts
interface DatabaseOptions {
```

Options for opening a SQLite database.

Options control the filesystem provider, open mode, and INTEGER result
mapping for the connection. They are read once by `Database.open()`.

```ts
const options = { readonly: true, safeIntegers: true };
console.log(options.readonly);
```

### fs

```ts
fs?: FileSystem
```

FileSystem provider used by Fino's SQLite VFS.

Defaults to a new `DiskFileSystem`. Supplying a custom provider lets SQLite
read and write through virtual filesystems.

```ts
import { DiskFileSystem } from 'fino:file';

const options = { fs: new DiskFileSystem() };
console.log(options.fs);
```

### readonly

```ts
readonly?: boolean
```

Open the database in read-only mode.

The default is `false`, which opens read-write and creates the database if
needed. Read-only connections reject writes at SQLite level and fail when
the file does not exist.

```ts
const options = { readonly: true };
console.log(options.readonly);
```

### safeIntegers

```ts
safeIntegers?: boolean
```

Return INTEGER columns as `bigint` when true.

The default is `true`. Set to `false` to coerce INTEGER results to
JavaScript `number`, accepting precision loss for values outside the safe
integer range.

```ts
const options = { safeIntegers: false };
console.log(options.safeIntegers);
```

## SqlValue

```ts
type SqlValue = null | undefined | bigint | number | string | Uint8Array
```

Values accepted for SQLite parameter binding and returned from result rows.

`null` and `undefined` bind as SQL NULL. Integers may be bound as `number`
or `bigint`; floating-point numbers bind as REAL. Strings bind as UTF-8
text, and `Uint8Array` binds as BLOB.

```ts
const params = [1n, 'name', null, new Uint8Array([1, 2])];
console.log(params.length);
```

## Statement

```ts
class Statement {
```

Prepared SQLite statement with lazy compilation and typed row helpers.

Statements are created by `Database.prepare()` and compile on first use.
Positional parameters are bound from rest arguments; pass one plain object to
bind named parameters without the leading `:`, `$`, or `@`. Call
`finalize()` when a reusable statement is no longer needed.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE users (id INTEGER, name TEXT)');
const stmt = db.prepare('INSERT INTO users VALUES (?, ?)');
await stmt.run(1n, 'Ada');
stmt.finalize();
await db.close();
```

### constructor

```ts
constructor(db: Database, sql: string, safeIntegers: boolean)
```

Create a statement wrapper.

Application code should normally call `Database.prepare()` instead of this
constructor so the statement inherits the database's integer mapping.
Compilation remains lazy until the first execution method is called.

```ts
import { Database, Statement } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
const stmt = new Statement(db, 'SELECT 1 AS value', true);
console.log(await stmt.get());
stmt.finalize();
await db.close();
```

### run

```ts
async run(...params: SqlValue[]): Promise<{
  changes: number;
  lastInsertRowid: bigint;
}>
```

Execute the statement and return write metadata.

Parameters may be positional values or one named-parameter object. The
statement is reset after execution. SQL errors reject with the database
error message. Result rows, if any, are not returned by this method.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE t (name TEXT)');
const result = await db.prepare('INSERT INTO t VALUES (?)').run('hello');
console.log(result.changes, result.lastInsertRowid);
await db.close();
```

### get

```ts
async get(...params: SqlValue[]): Promise<Record<string, SqlValue> | undefined>
```

Execute and return the first row.

Returns `undefined` when the query produces no rows. Column names are used
as object keys. The statement is reset before returning or throwing.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
const row = await db.prepare('SELECT 42 AS answer').get();
console.log(row?.answer);
await db.close();
```

### all

```ts
async all(...params: SqlValue[]): Promise<Record<string, SqlValue>[]>
```

Execute and return all rows.

This buffers every result row in memory. Use `iterate()` for large result
sets. The statement is reset before returning or throwing.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
const rows = await db.prepare('SELECT 1 AS n UNION ALL SELECT 2').all();
console.log(rows.length);
await db.close();
```

### iterate

```ts
async *iterate(...params: SqlValue[]): AsyncGenerator<Record<string, SqlValue>>
```

Async-iterate rows one at a time.

The statement remains active for the duration of iteration and is reset in
a `finally` block when iteration finishes, throws, or is abandoned early.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
for await (const row of db.prepare('SELECT 1 AS n').iterate()) {
  console.log(row.n);
}
await db.close();
```

### finalize

```ts
finalize(): void
```

Finalize and free this statement.

Calling `finalize()` more than once is allowed. Any later execution method
throws `Statement is finalized`.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
const stmt = db.prepare('SELECT 1');
stmt.finalize();
await db.close();
```

## Database

```ts
class Database {
```

SQLite database connection backed by Fino's SQLite VFS.

Open connections with `Database.open()`. The connection owns a native
`sqlite3*` pointer and a per-connection VFS registration; call `close()` when
finished. Methods throw after the connection has been closed.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE t (value TEXT)');
await db.close();
```

### ptr

```ts
get ptr(): ArrayBuffer
```

Internal sqlite3 pointer for statement helpers.

This getter exposes the native pointer wrapper used by this module. It is
public for `Statement` integration but is not needed by normal application
code. The value becomes invalid after `close()`.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
console.log(db.ptr.byteLength);
await db.close();
```

### open

```ts
static async open(path: string, opts: DatabaseOptions = {}): Promise<Database>
```

Open a database at `path`. Use `':memory:'` for an in-memory database.
Pass `{ fs }` to route I/O through a custom FileSystem provider.

By default, the database opens read-write and is created if missing.
`{ readonly: true }` opens read-only. Each connection registers a private
Fino VFS name so file operations go through the chosen filesystem provider.
Throws when SQLite is unavailable, open fails, or VFS registration fails.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:', { safeIntegers: true });
await db.close();
```

### exec

```ts
async exec(sql: string): Promise<void>
```

Execute one or more SQL statements with no result rows.

This uses `sqlite3_exec()` and is best for schema setup, pragmas, and
simple SQL batches. Use `prepare()` for parameter binding or reading result
rows. Throws on SQL errors or when the database is closed.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
await db.close();
```

### prepare

```ts
prepare(sql: string): Statement
```

Compile a SQL statement and return a reusable Statement.
Compilation is lazy — it happens on the first `.run/.get/.all/.iterate` call.

Throws immediately if the database is closed. SQL syntax errors are thrown
later when the statement first compiles.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
const stmt = db.prepare('SELECT ? AS value');
console.log(await stmt.get(123));
stmt.finalize();
await db.close();
```

### transaction

```ts
async transaction<T>(fn: () => Promise<T>): Promise<T>
```

Run `fn` inside a BEGIN/COMMIT transaction. Rolls back on throw.

The transaction starts with `BEGIN`, commits if `fn` resolves, and attempts
`ROLLBACK` if `fn` throws. Nested transaction behavior depends on SQLite
and the SQL executed by `fn`; this helper does not create savepoints.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE t (value TEXT)');
await db.transaction(async () => {
  await db.prepare('INSERT INTO t VALUES (?)').run('ok');
});
await db.close();
```

### vectorsAvailable

```ts
get vectorsAvailable(): boolean
```

Whether the current sqlite build supports extension loading and sqlite-vec
was found. Probed lazily on first access.

The probe tries `FINO_SQLITE_VEC_PATH` first when present, then common
platform paths. A failed probe caches `false`. Access may enable extension
loading on the connection.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
console.log(db.vectorsAvailable);
await db.close();
```

### loadExtension

```ts
loadExtension(path: string, entryPoint?: string): void
```

Load a SQLite extension from `path`. Requires a SQLite build with
extension loading enabled (e.g. Homebrew sqlite on macOS).

The optional `entryPoint` is passed through to `sqlite3_load_extension`.
Throws with SQLite's extension error message when loading fails, and throws
if the database is closed.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
db.loadExtension('/usr/local/lib/sqlite-vec.dylib');
await db.close();
```

### changes

```ts
get changes(): number
```

Number of rows changed by the most recent DML statement.

This mirrors `sqlite3_changes()` for the connection. It is meaningful after
INSERT, UPDATE, DELETE, and similar statements. It throws only if SQLite
bindings are unavailable.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE t (value TEXT)');
await db.prepare('INSERT INTO t VALUES (?)').run('x');
console.log(db.changes);
await db.close();
```

### lastInsertRowid

```ts
get lastInsertRowid(): bigint
```

Row ID of the most recent INSERT.

This mirrors `sqlite3_last_insert_rowid()` and returns a `bigint`
regardless of `safeIntegers`, because rowids may exceed JavaScript's safe
integer range.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
await db.prepare('INSERT INTO t DEFAULT VALUES').run();
console.log(db.lastInsertRowid);
await db.close();
```

### close

```ts
async close(): Promise<void>
```

Close the database and unregister the VFS.

Calling `close()` more than once is allowed. Statements should be finalized
before closing; SQLite may defer native cleanup until active statements are
released.

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open(':memory:');
await db.close();
```

## vec

```ts
function vec(arr: Float32Array | number[]): string
```

Encode a Float32Array or number[] as the `'[x,y,z]'` text literal that
sqlite-vec's vec0 virtual table expects in INSERT and MATCH expressions.

The returned string is not SQL-escaped; bind it as a parameter or use it only
where sqlite-vec expects a vector literal. Numbers are converted through
`Float32Array` when the input is a regular array.

```ts
import { vec } from 'fino:database/sqlite';

const literal = vec([0.1, 0.2, 0.3]);
console.log(literal);
```

## vecDecode

```ts
function vecDecode(blob: Uint8Array): Float32Array
```

Decode a sqlite-vec BLOB column back to a Float32Array.
sqlite-vec stores vectors as little-endian float32 blobs.

The returned array views a sliced copy of the input buffer, so it is aligned
for `Float32Array` use and independent of the original byte offset. Invalid
byte lengths that are not multiples of four follow `Float32Array`
construction rules and may throw.

```ts
import { vecDecode } from 'fino:database/sqlite';

const bytes = new Uint8Array(new Float32Array([1, 2]).buffer);
const vector = vecDecode(bytes);
console.log(vector[0]);
```
