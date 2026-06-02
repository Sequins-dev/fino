# toml

fino:format/toml — TOML 1.0.0 parser and serializer.

TOML is a configuration format optimized for human-edited files with typed
values and predictable table structure. This module parses TOML 1.0.0 into
JavaScript values and serializes compatible JavaScript objects back to TOML.
It is a good fit for application config, project manifests, and small
settings files where comments and stable textual shape matter to users.

The parser covers TOML scalar types, basic and literal strings, integers,
floats, booleans, offset datetimes, local datetimes, local dates, local
times, arrays, inline tables, tables, and arrays of tables. Key uniqueness
and structural rules from the spec are enforced.

Datetime types:
  - Offset datetime   → native Date
  - Local datetime    → TomlLocalDateTime
  - Local date        → TomlLocalDate
  - Local time        → TomlLocalTime

Integer overflow throws by default; pass `{ bigint: true }` to receive
`BigInt` values for integers outside JavaScript's safe integer range.

```ts
import { parse, stringify } from 'fino:format/toml';

const cfg = parse('[server]\nport = 8080\nhosts = ["a", "b"]');
const text = stringify(cfg);
```

```ts
import { parse, TomlLocalDate } from 'fino:format/toml';

const cfg = parse('released = 2026-06-02');
cfg.released instanceof TomlLocalDate; // true
```

Useful references:
  - TOML 1.0.0 specification: https://toml.io/en/v1.0.0

## TomlParseError

```ts
class TomlParseError extends ParseError {
```

Error thrown when TOML input is malformed.

### name

```ts
name
```

## TomlLocalDate

```ts
class TomlLocalDate {
```

TOML local date value without a time or offset.

### year

```ts
readonly year: number
```

### month

```ts
readonly month: number
```

### day

```ts
readonly day: number
```

### constructor

```ts
constructor(y: number, mo: number, d: number)
```

### toString

```ts
toString()
```

### toJSON

```ts
toJSON()
```

## TomlLocalTime

```ts
class TomlLocalTime {
```

TOML local time value without a date or offset.

### hour

```ts
readonly hour: number
```

### minute

```ts
readonly minute: number
```

### second

```ts
readonly second: number
```

### ms

```ts
readonly ms: number
```

### constructor

```ts
constructor(h: number, m: number, s: number, ms = 0)
```

### toString

```ts
toString()
```

### toJSON

```ts
toJSON()
```

## TomlLocalDateTime

```ts
class TomlLocalDateTime {
```

TOML local date-time value without an offset.

### date

```ts
readonly date: TomlLocalDate
```

### time

```ts
readonly time: TomlLocalTime
```

### constructor

```ts
constructor(d: TomlLocalDate, t: TomlLocalTime)
```

### toString

```ts
toString()
```

### toJSON

```ts
toJSON()
```

## TomlValue

```ts
type TomlValue = | string | number | bigint | boolean | Date | TomlLocalDate | TomlLocalTime | TomlLocalDateTime | TomlValue[] | { [k: string]: TomlValue }
```

Value types produced by the TOML parser and accepted by the stringifier.

## TomlParseOptions

```ts
interface TomlParseOptions {
```

Options controlling TOML parsing.

### bigint

```ts
bigint?: boolean
```

## TomlStringifyOptions

```ts
interface TomlStringifyOptions {
```

Options controlling TOML output formatting.

### indent

```ts
indent?: string
```

## parse

```ts
function parse(input: string | Uint8Array, options: TomlParseOptions = {}): Record<string, TomlValue>
```

Parse a TOML document into a plain object.

```ts
import { parse } from 'fino:format/toml';

parse('title = "Fino"\n[server]\nport = 8080\n');
```

## stringify

```ts
function stringify(value: Record<string, TomlValue>, options: TomlStringifyOptions = {}): string
```

Serialize a TOML-compatible object.

```ts
import { stringify } from 'fino:format/toml';

stringify({ server: { port: 8080 } });
```
