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

### fs

```ts
fs?: FileSystem
```

FileSystem provider. Defaults to DiskFileSystem.

### readonly

```ts
readonly?: boolean
```

If true, open read-only.

### safeIntegers

```ts
safeIntegers?: boolean
```

If true, type-map INTEGER columns to number instead of BigInt.

## SqlValue

```ts
type SqlValue = null | undefined | bigint | number | string | Uint8Array
```

Values accepted for SQLite parameter binding and returned from result rows.

## Statement

```ts
class Statement {
```

Prepared SQLite statement with lazy compilation and typed row helpers.

### constructor

```ts
constructor(db: Database, sql: string, safeIntegers: boolean)
```

### run

```ts
async run(...params: SqlValue[]): Promise<{ changes: number; lastInsertRowid: bigint }>
```

Execute the statement. Returns `{ changes, lastInsertRowid }`.

### get

```ts
async get(...params: SqlValue[]): Promise<Record<string, SqlValue> | undefined>
```

Execute and return the first row, or undefined.

### all

```ts
async all(...params: SqlValue[]): Promise<Record<string, SqlValue>[]>
```

Execute and return all rows.

### iterate

```ts
async *iterate(...params: SqlValue[]): AsyncGenerator<Record<string, SqlValue>>
```

Async-iterate rows one at a time.

### finalize

```ts
finalize(): void
```

Finalize (free) this statement.

## Database

```ts
class Database {
```

### ptr

```ts
get ptr(): ArrayBuffer
```

Internal access for Statement to call db-level functions.

### open

```ts
static async open(path: string, opts: DatabaseOptions = {}): Promise<Database>
```

Open a database at `path`. Use `':memory:'` for an in-memory database.
Pass `{ fs }` to route I/O through a custom FileSystem provider.

### exec

```ts
async exec(sql: string): Promise<void>
```

Execute one or more SQL statements with no result rows.

### prepare

```ts
prepare(sql: string): Statement
```

Compile a SQL statement and return a reusable Statement.
Compilation is lazy — it happens on the first `.run/.get/.all/.iterate` call.

### transaction

```ts
async transaction<T>(fn: () => Promise<T>): Promise<T>
```

Run `fn` inside a BEGIN/COMMIT transaction. Rolls back on throw.

### vectorsAvailable

```ts
get vectorsAvailable(): boolean
```

Whether the current sqlite build supports extension loading and sqlite-vec
was found. Probed lazily on first access.

### loadExtension

```ts
loadExtension(path: string, entryPoint?: string): void
```

Load a SQLite extension from `path`. Requires a SQLite build with
extension loading enabled (e.g. Homebrew sqlite on macOS).

### changes

```ts
get changes(): number
```

Number of rows changed by the most recent DML statement.

### lastInsertRowid

```ts
get lastInsertRowid(): bigint
```

Row ID of the most recent INSERT.

### close

```ts
async close(): Promise<void>
```

Close the database and unregister the VFS.

## vec

```ts
function vec(arr: Float32Array | number[]): string
```

Encode a Float32Array or number[] as the `'[x,y,z]'` text literal that
sqlite-vec's vec0 virtual table expects in INSERT and MATCH expressions.

## vecDecode

```ts
function vecDecode(blob: Uint8Array): Float32Array
```

Decode a sqlite-vec BLOB column back to a Float32Array.
sqlite-vec stores vectors as little-endian float32 blobs.
