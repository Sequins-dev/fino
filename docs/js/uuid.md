# uuid

fino:uuid - UUID v4 and v7 generation, parsing, and validation.

Implements RFC 9562 (May 2024), which obsoletes RFC 4122 and formally
standardizes v7 (time-ordered). Randomness comes from libcrypto via
internal:openssl; no new Rust code is required.

v7 same-millisecond monotonicity uses a module-level 12-bit counter (option
b from RFC 9562 section 6.2): the counter increments on each v7() call within the
same millisecond and resets with fresh random fill when the clock advances.
This guarantees strict ascending order within a single process while
retaining cryptographic randomness across millisecond boundaries.

```ts
import { UUID, v4, v7, parse, validate, version } from 'fino:uuid';

const id = v4();                    // UUID
const row = v7();                   // time-ordered UUID for DB primary keys
const ok = validate(id.toString()); // true
const ver = version(id.toString()); // 4
```

## UUID

```ts
class UUID {
```

Immutable UUID value object.

`UUID` instances wrap 16 bytes and lazily cache their canonical string form.
Static factories generate or parse values; instance methods expose metadata,
bytes, equality, and JSON/string conversion. Generation requires OpenSSL
availability and throws if the crypto backend is unavailable.

```ts
import { UUID } from 'fino:uuid';

const id = UUID.v7();
const text = id.toString();
```

### v4

```ts
static v4(): UUID
```

Generate a random RFC 9562 version 4 UUID.

The UUID contains 122 bits of random data after version and variant bits
are set. Throws when the OpenSSL random backend is unavailable.

```ts
import { UUID } from 'fino:uuid';

const id = UUID.v4();
```

### v7

```ts
static v7(): UUID
```

Generate a time-ordered RFC 9562 version 7 UUID.

The first 48 bits contain the current Unix millisecond timestamp. Calls in
the same process and millisecond use a 12-bit counter so generated strings
sort in creation order until the counter wraps.

```ts
import { UUID } from 'fino:uuid';

const id = UUID.v7();
```

### parse

```ts
static parse(str: string): UUID
```

Parse a canonical UUID string into a `UUID` instance.

Uppercase and lowercase hexadecimal characters are accepted. Invalid
length, missing dashes, or non-hex characters throw `Error`.

```ts
import { UUID } from 'fino:uuid';

const id = UUID.parse('018f6a25-4f31-7c00-9d42-8c15d070f31f');
```

### from

```ts
static from(val: string | UUID | Uint8Array): UUID
```

Convert a UUID-like value into a `UUID` instance.

Passing an existing `UUID` returns it unchanged. Passing a `Uint8Array`
requires exactly 16 bytes and copies the bytes. Passing a string delegates
to `UUID.parse()` and throws on invalid input.

```ts
import { UUID } from 'fino:uuid';

const id = UUID.from('018f6a25-4f31-7c00-9d42-8c15d070f31f');
```

### NIL

```ts
static readonly NIL: UUID
```

Nil UUID value with all bytes set to zero.

Useful as a sentinel value. The exported module-level `NIL` constant is its
string form.

```ts
import { UUID } from 'fino:uuid';

const empty = UUID.NIL.toString();
```

### MAX

```ts
static readonly MAX: UUID
```

Maximum UUID value with all bytes set to `0xff`.

Useful for range bounds. The exported module-level `MAX` constant is its
string form.

```ts
import { UUID } from 'fino:uuid';

const upper = UUID.MAX.toString();
```

### version

```ts
get version(): number
```

UUID version nibble.

Returns the high four bits of byte 6, so generated IDs return `4` or `7`.
Parsed IDs can report any encoded version number.

```ts
import { UUID } from 'fino:uuid';

const version = UUID.v4().version;
```

### variant

```ts
get variant(): number
```

UUID variant classification.

Returns `0` for NCS, `1` for RFC 4122/RFC 9562, `2` for Microsoft, and `3`
for future reserved values. Generated UUIDs use variant `1`.

```ts
import { UUID } from 'fino:uuid';

const variant = UUID.v7().variant;
```

### timestamp

```ts
get timestamp(): Date | null
```

Timestamp represented by version 1 or version 7 UUIDs.

Returns a `Date` for v7 millisecond timestamps and for v1 100-nanosecond
timestamps converted to Unix time. Returns `null` for UUID versions without
embedded time, including v4.

```ts
import { UUID } from 'fino:uuid';

const createdAt = UUID.v7().timestamp;
```

### toBytes

```ts
toBytes(): Uint8Array
```

Return a copy of the UUID bytes.

The returned `Uint8Array` is detached from the instance state, so mutating
it cannot change the UUID.

```ts
import { UUID } from 'fino:uuid';

const bytes = UUID.v4().toBytes();
```

### equals

```ts
equals(other: UUID): boolean
```

Compare this UUID to another UUID by byte value.

Returns `true` only when all 16 bytes match. It accepts `UUID` instances,
so parse or convert other inputs before comparing.

```ts
import { UUID } from 'fino:uuid';

const same = UUID.NIL.equals(UUID.from(UUID.NIL.toString()));
```

### toString

```ts
toString(): string
```

Return the canonical lower-case UUID string.

The string is computed once and cached. It always uses the
`8-4-4-4-12` dashed hexadecimal form.

```ts
import { UUID } from 'fino:uuid';

const text = UUID.v4().toString();
```

### toJSON

```ts
toJSON(): string
```

Return the canonical string for JSON serialization.

`JSON.stringify()` calls this method, so UUID values serialize as strings
rather than objects.

```ts
import { UUID } from 'fino:uuid';

const json = JSON.stringify({ id: UUID.v4() });
```

## v4

```ts
function v4(): UUID
```

Generate a random UUID version 4.

This is a convenience wrapper around `UUID.v4()`. It returns a `UUID`
instance and throws when the OpenSSL random backend is unavailable.

```ts
import { v4 } from 'fino:uuid';

const id = v4();
```

## v7

```ts
function v7(): UUID
```

Generate a time-ordered UUID version 7.

This is a convenience wrapper around `UUID.v7()`. Values include a
millisecond timestamp and sort well for many database primary-key workloads.

```ts
import { v7 } from 'fino:uuid';

const id = v7();
```

## parse

```ts
function parse(str: string): UUID
```

Parse a UUID string into a `UUID` instance.

Uppercase and lowercase hexadecimal input is accepted. Invalid input throws
`Error`.

```ts
import { parse } from 'fino:uuid';

const id = parse('018f6a25-4f31-7c00-9d42-8c15d070f31f');
```

## validate

```ts
function validate(str: string): boolean
```

Return `true` when `str` is a valid canonical UUID string.

This helper accepts upper or lower case hexadecimal characters and never
throws for invalid UUID text.

```ts
import { validate } from 'fino:uuid';

const ok = validate('018f6a25-4f31-7c00-9d42-8c15d070f31f');
```

## version

```ts
function version(str: string): number
```

Return the UUID version number parsed from `str`.

Invalid UUID text throws through `UUID.parse()`. The result is the version
nibble encoded in the string, not a validation of whether that version is
supported for generation.

```ts
import { version } from 'fino:uuid';

const v = version('018f6a25-4f31-7c00-9d42-8c15d070f31f');
```

## NIL

```ts
const NIL: string
```

Nil UUID string (`00000000-0000-0000-0000-000000000000`).

Use this string sentinel when an API expects UUID text rather than a `UUID`
instance.

```ts
import { NIL } from 'fino:uuid';

const empty = NIL;
```

## MAX

```ts
const MAX: string
```

Max UUID string (`ffffffff-ffff-ffff-ffff-ffffffffffff`).

Use this string sentinel for upper bounds or placeholder values that need the
maximum UUID byte sequence.

```ts
import { MAX } from 'fino:uuid';

const upper = MAX;
```
