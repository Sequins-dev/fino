# toml

fino:format/toml - TOML 1.0.0 parser and serializer.

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
  - Offset datetime   -> native Date
  - Local datetime    -> TomlLocalDateTime
  - Local date        -> TomlLocalDate
  - Local time        -> TomlLocalTime

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

Error thrown when TOML input is malformed or violates TOML structure rules.

The error inherits source location and rendering support from `ParseError`.
Invalid values, duplicate keys, duplicate table declarations, and integer
overflow without `bigint: true` are reported through this error type.

```ts
import { TomlParseError, parse } from 'fino:format/toml';

try {
  parse('answer =');
} catch (error) {
  if (error instanceof TomlParseError) console.error(error.render());
}
```

### name

```ts
name
```

Error name reported by `TomlParseError` instances.

This member is emitted by the docs generator when
`--include-private` is enabled. It is maintained by runtime
internals and should be changed only with the surrounding
implementation contract in mind.

```ts
const error = new TomlParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
console.log(error.name);
```

## TomlLocalDate

```ts
class TomlLocalDate {
```

TOML local date value without a time or UTC offset.

`parse()` returns this wrapper for TOML local-date values such as
`2026-06-02`. It preserves the date as written instead of converting through
a timezone. `toString()` and `toJSON()` return TOML-compatible
`YYYY-MM-DD` text.

```ts
import { TomlLocalDate } from 'fino:format/toml';

const date = new TomlLocalDate(2026, 6, 2);
date.toString(); // '2026-06-02'
```

### year

```ts
readonly year: number
```

Four-digit calendar year.

The constructor does not normalize invalid calendar values; parsed TOML is
expected to supply spec-valid values.

```ts
import { TomlLocalDate } from 'fino:format/toml';

new TomlLocalDate(2026, 6, 2).year;
```

### month

```ts
readonly month: number
```

One-based calendar month.

January is `1` and December is `12`.

```ts
import { TomlLocalDate } from 'fino:format/toml';

new TomlLocalDate(2026, 6, 2).month;
```

### day

```ts
readonly day: number
```

One-based day of month.

The value is emitted with two digits by `toString()`.

```ts
import { TomlLocalDate } from 'fino:format/toml';

new TomlLocalDate(2026, 6, 2).day;
```

### constructor

```ts
constructor(y: number, mo: number, d: number)
```

Create a TOML local date wrapper.

The values are stored directly and are not converted to a JavaScript `Date`.

```ts
import { TomlLocalDate } from 'fino:format/toml';

const date = new TomlLocalDate(2026, 6, 2);
```

### toString

```ts
toString()
```

Format the date as TOML local-date text.

The return value is zero-padded and contains no timezone information.

```ts
import { TomlLocalDate } from 'fino:format/toml';

new TomlLocalDate(2026, 6, 2).toString();
```

### toJSON

```ts
toJSON()
```

Return the JSON representation used by `JSON.stringify()`.

The value matches `toString()` so local dates remain timezone-free when
serialized to JSON.

```ts
import { TomlLocalDate } from 'fino:format/toml';

JSON.stringify({ released: new TomlLocalDate(2026, 6, 2) });
```

## TomlLocalTime

```ts
class TomlLocalTime {
```

TOML local time value without a date or UTC offset.

`parse()` returns this wrapper for TOML local-time values such as
`12:30:00`. It preserves wall-clock time and does not attach a timezone or
date.

```ts
import { TomlLocalTime } from 'fino:format/toml';

const time = new TomlLocalTime(9, 30, 0);
time.toString(); // '09:30:00'
```

### hour

```ts
readonly hour: number
```

Hour in 24-hour time.

The value is emitted with two digits by `toString()`.

```ts
import { TomlLocalTime } from 'fino:format/toml';

new TomlLocalTime(9, 30, 0).hour;
```

### minute

```ts
readonly minute: number
```

Minute within the hour.

The value is emitted with two digits by `toString()`.

```ts
import { TomlLocalTime } from 'fino:format/toml';

new TomlLocalTime(9, 30, 0).minute;
```

### second

```ts
readonly second: number
```

Second within the minute.

Fractional precision, when present, is stored separately in `ms`.

```ts
import { TomlLocalTime } from 'fino:format/toml';

new TomlLocalTime(9, 30, 15).second;
```

### ms

```ts
readonly ms: number
```

Millisecond fraction. Defaults to `0`.

Parsed TOML fractional seconds are rounded to the nearest millisecond.

```ts
import { TomlLocalTime } from 'fino:format/toml';

new TomlLocalTime(9, 30, 15, 250).ms;
```

### constructor

```ts
constructor(h: number, m: number, s: number, ms = 0)
```

Create a TOML local time wrapper.

The constructor stores values directly and does not normalize overflow.

```ts
import { TomlLocalTime } from 'fino:format/toml';

const time = new TomlLocalTime(9, 30, 15, 250);
```

### toString

```ts
toString()
```

Format the value as TOML local-time text.

Milliseconds are emitted only when non-zero.

```ts
import { TomlLocalTime } from 'fino:format/toml';

new TomlLocalTime(9, 30, 15, 250).toString();
```

### toJSON

```ts
toJSON()
```

Return the JSON representation used by `JSON.stringify()`.

The value matches `toString()` and remains date- and timezone-free.

```ts
import { TomlLocalTime } from 'fino:format/toml';

JSON.stringify({ startsAt: new TomlLocalTime(9, 30, 0) });
```

## TomlLocalDateTime

```ts
class TomlLocalDateTime {
```

TOML local date-time value without a UTC offset.

`parse()` returns this wrapper for TOML local datetimes such as
`2026-06-02T09:30:00`. Offset datetimes are returned as native `Date`
instances instead.

```ts
import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';

const value = new TomlLocalDateTime(
  new TomlLocalDate(2026, 6, 2),
  new TomlLocalTime(9, 30, 0),
);
```

### date

```ts
readonly date: TomlLocalDate
```

Local date component.

This component carries no timezone and is preserved independently from
JavaScript `Date`.

```ts
import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';

new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)).date;
```

### time

```ts
readonly time: TomlLocalTime
```

Local time component.

The component includes optional millisecond precision but no timezone.

```ts
import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';

new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)).time;
```

### constructor

```ts
constructor(d: TomlLocalDate, t: TomlLocalTime)
```

Create a TOML local date-time wrapper from local date and time parts.

No timezone conversion or validation is performed by the constructor.

```ts
import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';

const value = new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0));
```

### toString

```ts
toString()
```

Format the value as TOML local-date-time text.

The returned string uses `T` between date and time and includes no offset.

```ts
import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';

new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)).toString();
```

### toJSON

```ts
toJSON()
```

Return the JSON representation used by `JSON.stringify()`.

The value matches `toString()` and stays offset-free.

```ts
import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';

JSON.stringify({
  start: new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)),
});
```

## TomlValue

```ts
type TomlValue = | string | number | bigint | boolean | Date | TomlLocalDate | TomlLocalTime | TomlLocalDateTime | TomlValue[] | { /** * TOML table key mapped to another TOML-compatible value. * * Nested objects become TOML tables or inline tables depending on * stringifier context. * * ```ts no_run * import type { TomlValue } from 'fino:format/toml'; * * const table: TomlValue = { server: { port: 8080 } }; * ``` */ [k: string]: TomlValue; }
```

Value types produced by the TOML parser and accepted by the stringifier.

Offset datetimes are native `Date` values; local temporal values use the
wrapper classes exported by this module. Objects represent TOML tables and
arrays represent TOML arrays or arrays of tables depending on context.

```ts
import { stringify, type TomlValue } from 'fino:format/toml';

const value: TomlValue = { server: { port: 8080, enabled: true } };
stringify(value as Record<string, TomlValue>);
```

## TomlParseOptions

```ts
interface TomlParseOptions {
```

Options controlling TOML parsing.

Parsing is strict by default and throws on integers outside JavaScript's safe
integer range. Enable `bigint` when preserving oversized TOML integers is
more important than returning only `number` values.

```ts
import { parse, type TomlParseOptions } from 'fino:format/toml';

const options: TomlParseOptions = { bigint: true };
parse('huge = 9223372036854775807', options);
```

### bigint

```ts
bigint?: boolean
```

Return oversized TOML integers as `BigInt` instead of throwing.

Defaults to `false`. Safe integers are still returned as `number`.

```ts
import { parse } from 'fino:format/toml';

const cfg = parse('huge = 9223372036854775807', { bigint: true });
```

## TomlStringifyOptions

```ts
interface TomlStringifyOptions {
```

Options controlling TOML output formatting.

The current stringifier emits one key per line, table headers for nested
objects, and arrays of tables for arrays of object values.

```ts
import { stringify, type TomlStringifyOptions } from 'fino:format/toml';

const options: TomlStringifyOptions = { indent: '' };
stringify({ server: { port: 8080 } }, options);
```

### indent

```ts
indent?: string
```

Reserved indentation string for TOML output. Defaults to `""`.

The current formatter stores this value for future formatting support, but
TOML tables and arrays are emitted in a compact one-entry-per-line style.

```ts
import { stringify } from 'fino:format/toml';

stringify({ server: { port: 8080 } }, { indent: '' });
```

## parse

```ts
function parse(input: string | Uint8Array, options: TomlParseOptions = {}): Record<string, TomlValue>
```

Parse a TOML document into a plain object.

The parser enforces TOML 1.0.0 key uniqueness, table structure, scalar
syntax, and integer range rules. It returns an object with a null prototype
internally, but callers should treat the result as a plain record of
`TomlValue`.

```ts
import { parse } from 'fino:format/toml';

parse('title = "Fino"\n[server]\nport = 8080\n');
```

## stringify

```ts
function stringify(value: Record<string, TomlValue>, options: TomlStringifyOptions = {}): string
```

Serialize a TOML-compatible object.

The stringifier emits TOML scalars before nested tables, converts native
`Date` values to UTC offset datetimes, and emits local wrappers through
their `toString()` methods. It does not preserve comments or original source
formatting from a parsed document.

```ts
import { stringify } from 'fino:format/toml';

stringify({ server: { port: 8080 } });
```
