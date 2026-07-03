---
weight: 10
---
# Database Guide

The database APIs currently focus on SQLite. The SQLite module uses the system
`libsqlite3` library and routes file I/O through Fino's filesystem provider, so
database access can participate in realm-specific filesystem behavior.

## Open a Database

Use `Database.open` with a file path:

```ts
import { Database } from 'fino:database/sqlite';

const db = await Database.open('./app.db');
```

Close the database when the application is done with it:

```ts
await db.close();
```

## Create Tables

Use `exec` for SQL that does not return rows:

```ts
await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  )
`);
```

`exec` is useful for schema setup, migrations, and multi-statement setup blocks.

## Insert and Update Rows

Prepare statements when binding values:

```ts
const insertUser = db.prepare(`
  INSERT INTO users (name, email)
  VALUES (?, ?)
`);

const result = await insertUser.run('Ada', 'ada@example.com');

console.log(result.lastInsertRowid);
```

Use named parameters when that makes call sites clearer:

```ts
const updateEmail = db.prepare(`
  UPDATE users
  SET email = $email
  WHERE id = $id
`);

await updateEmail.run({ id: 1, email: 'ada@fino.dev' });
```

## Read Rows

Use `get` for zero-or-one row and `all` for all rows:

```ts
const user = await db
  .prepare('SELECT id, name, email FROM users WHERE id = ?')
  .get(1);

const users = await db
  .prepare('SELECT id, name, email FROM users ORDER BY name')
  .all();

console.log(user, users.length);
```

SQLite values map to JavaScript values: text becomes strings, blobs become
`Uint8Array`, null stays null, and numbers become JavaScript numbers unless
safe integer mode is enabled.

## Safe Integers

Open with `safeIntegers: true` when integer precision matters:

```ts
const db = await Database.open('./app.db', { safeIntegers: true });

const row = await db.prepare('SELECT 9223372036854775807 AS id').get();
console.log(typeof row?.id); // bigint
```

Use this for IDs, counters, or timestamps that may exceed JavaScript's safe
integer range.

## Vector Helpers

The SQLite module includes helpers for encoding and decoding float vectors as
blobs:

```ts
import { vec, vecDecode } from 'fino:database/sqlite';

const encoded = vec([0.1, 0.2, 0.3]);
const decoded = vecDecode(encoded);
```

Use these helpers when storing vector-like numeric data in SQLite blob columns.

## Migrations

Use `fino:database/sql` when you want to import or compile `.sql` files as
callable query modules:

```sql
-- import type { UserFilter } from './types.ts'

-- function findUsers(filter: UserFilter)
SELECT *
FROM users
WHERE status = '{{ filter.status }}'
```

```ts
import { findUsers } from './queries.sql';

findUsers({ status: 'active' });
```

Use `fino:database/migrate` to load SQL migration files and apply pending
`up` functions. Directive SQL files can also export `down` for explicit
rollback:

```sql
-- function up()
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- function down()
DROP TABLE users;
```

```ts
import { Database } from 'fino:database';
import { loadMigrations, migrate, rollback } from 'fino:database/migrate';

await using db = await Database.open('./app.db');
const migrations = await loadMigrations('./migrations/*.sql');

await migrate(db, migrations);
await rollback(db, migrations);
```

Migration history is stored in `fino_migrations` by default. The migration
loader uses the same SQL function engine as direct `.sql` imports, including
TypeScript import preservation and structural placeholders such as
`{{ user.id }}`.
