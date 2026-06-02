# uuid

fino:uuid — UUID v4 and v7 generation, parsing, and validation.

Implements RFC 9562 (May 2024), which obsoletes RFC 4122 and formally
standardizes v7 (time-ordered). Randomness comes from libcrypto via
internal:openssl; no new Rust code is required.

v7 same-millisecond monotonicity uses a module-level 12-bit counter (option
b from RFC 9562 §6.2): the counter increments on each v7() call within the
same millisecond and resets with fresh random fill when the clock advances.
This guarantees strict ascending order within a single process while
retaining cryptographic randomness across millisecond boundaries.

```ts
import { UUID, v4, v7, parse, validate, version } from 'fino:uuid';

const id  = v4();                   // UUID
const row = v7();                   // time-ordered UUID for DB primary keys
const ok  = validate(id.toString()); // true
const ver = version(id.toString()); // 4
```

## UUID

```ts
class UUID {
```

### v4

```ts
static v4(): UUID
```

### v7

```ts
static v7(): UUID
```

### parse

```ts
static parse(str: string): UUID
```

### from

```ts
static from(val: string | UUID | Uint8Array): UUID
```

### NIL

```ts
static readonly NIL: UUID
```

### MAX

```ts
static readonly MAX: UUID
```

### version

```ts
get version(): number
```

### variant

```ts
get variant(): number
```

### timestamp

```ts
get timestamp(): Date | null
```

### toBytes

```ts
toBytes(): Uint8Array
```

### equals

```ts
equals(other: UUID): boolean
```

### toString

```ts
toString(): string
```

### toJSON

```ts
toJSON(): string
```

## v4

```ts
function v4(): UUID
```

Generate a random UUID version 4.

## v7

```ts
function v7(): UUID
```

Generate a time-ordered UUID version 7.

## parse

```ts
function parse(str: string): UUID
```

Parse a UUID string into a `UUID` instance, throwing on invalid input.

## validate

```ts
function validate(str: string): boolean
```

Return `true` when `str` is a valid canonical UUID string.

## version

```ts
function version(str: string): number
```

Return the UUID version number parsed from `str`.

## NIL

```ts
const NIL: string
```

Nil UUID string (`00000000-0000-0000-0000-000000000000`).

## MAX

```ts
const MAX: string
```

Max UUID string (`ffffffff-ffff-ffff-ffff-ffffffffffff`).
