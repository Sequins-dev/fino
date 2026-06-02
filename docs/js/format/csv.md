# csv

fino:format/csv - CSV parsing and serialization (RFC 4180 + dialect options).

This module handles comma-separated and delimiter-separated tabular text for
data import/export workflows. It supports the RFC 4180 quoting model, custom
one-character delimiters and quote characters, optional comments, trimming,
header rows, explicit column names, relaxed column counts, and field casting.

`parse()` returns positional `string[][]` rows by default. Enable
`header: true` to use the first row as object keys, or pass `columns` to
supply keys explicitly. `parseStream()` consumes async byte chunks and yields
parsed rows without requiring the whole input to be present at once.
`stringify()` serializes arrays or records back to CSV and emits CRLF line
endings by default.

CSV is not a single fully-standardized ecosystem. When interoperating with
spreadsheets, databases, or data warehouses, match their delimiter, quote,
header, encoding, and empty-line conventions explicitly.

```ts
import { parse, stringify } from 'fino:format/csv';

const rows = parse('name,age\nAda,36\nGrace,85\n', { header: true });
// [{ name: 'Ada', age: '36' }, { name: 'Grace', age: '85' }]

const out = stringify(rows, { header: true });
```

```ts
import { parse } from 'fino:format/csv';

const rows = parse('a;b\n1;2\n', {
  delimiter: ';',
  header: true,
  cast: true,
});
```

Useful references:
  - RFC 4180: https://www.rfc-editor.org/rfc/rfc4180
  - W3C CSV on the Web: https://www.w3.org/TR/tabular-data-model/

## CsvParseError

```ts
class CsvParseError extends ParseError {
```

Error thrown when CSV input is malformed or violates configured column rules.

`CsvParseError` extends `ParseError`, so callers can inspect the inherited
offset, line, column, format, and renderable diagnostic context. Dialect
option validation, such as multi-character delimiters, throws `TypeError`
before parsing starts instead.

```ts
import { CsvParseError, parse } from 'fino:format/csv';

try {
  parse('"unterminated');
} catch (error) {
  if (error instanceof CsvParseError) {
    console.error(error.render());
  }
}
```

### name

```ts
name
```

Error name reported by `CsvParseError` instances.

This member is emitted by the docs generator when
`--include-private` is enabled. It is maintained by runtime
internals and should be changed only with the surrounding
implementation contract in mind.

```ts
const error = new CsvParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
console.log(error.name);
```

## CsvRow

```ts
type CsvRow = string[]
```

Positional CSV row with one entry per parsed field.

Rows are returned by `parse()` and `parseStream()` when neither `header` nor
`columns` is enabled. Fields are strings by default; enabling `cast` can
produce non-string runtime values even though the public row shape remains
tuple-like for CSV compatibility.

```ts
import type { CsvRow } from 'fino:format/csv';
import { parse } from 'fino:format/csv';

const rows: CsvRow[] = parse('name,age\nAda,36\n');
const firstName = rows[1]?.[0];
```

## CsvRecord

```ts
type CsvRecord = Record<string, string>
```

Object row produced when `header: true` or `columns` is enabled.

Each key is taken from the header row or the explicit `columns` option.
Missing fields are filled with an empty string; extra fields are ignored for
records unless column-count validation throws first.

```ts
import type { CsvRecord } from 'fino:format/csv';
import { parse } from 'fino:format/csv';

const rows: CsvRecord[] = parse('name,age\nAda,36\n', { header: true });
rows[0]?.name;
```

## CsvParseOptions

```ts
interface CsvParseOptions {
```

Options controlling CSV parsing dialect, row shape, and field conversion.

Defaults match common RFC 4180-style CSV: comma delimiter, double-quote
quoting, no comment lines, positional rows, no trimming, no empty-line
skipping, strict column counts for records, and no casting.

```ts
import { parse, type CsvParseOptions } from 'fino:format/csv';

const options: CsvParseOptions = {
  delimiter: ';',
  header: true,
  skipEmptyLines: true,
};
const rows = parse('name;age\nAda;36\n', options);
```

### delimiter

```ts
delimiter?: string
```

One-character field delimiter. Defaults to `","`.

Multi-character delimiters are rejected with `TypeError` before parsing.

```ts
import { parse } from 'fino:format/csv';

parse('a;b\n1;2\n', { delimiter: ';' });
```

### quote

```ts
quote?: string
```

One-character quote delimiter. Defaults to the double quote character.

The quote character starts and ends quoted fields, and doubled quote
characters inside a quoted field become one literal quote.

```ts
import { parse } from 'fino:format/csv';

parse("'a','b'\n'one','two'\n", { quote: "'" });
```

### comment

```ts
comment?: string
```

Optional one-character line comment prefix.

Lines whose first character is the comment prefix are skipped. Comments are
recognized only at the start of a row, not after fields.

```ts
import { parse } from 'fino:format/csv';

parse('# ignored\na,b\n1,2\n', { comment: '#' });
```

### header

```ts
header?: boolean
```

Use the first parsed row as object keys. Defaults to `false`.

When enabled, the header row is not returned as data. If `columns` is also
provided, explicit columns take precedence and the first row is treated as
data.

```ts
import { parse } from 'fino:format/csv';

const records = parse('name,age\nAda,36\n', { header: true });
```

### columns

```ts
columns?: string[]
```

Explicit object keys for each field.

Supplying columns returns records without consuming a header row. Missing
fields are assigned `""`; by default row lengths must match exactly.

```ts
import { parse } from 'fino:format/csv';

parse('Ada,36\n', { columns: ['name', 'age'] });
```

### skipEmptyLines

```ts
skipEmptyLines?: boolean
```

Skip rows that contain exactly one empty field. Defaults to `false`.

The option is applied after field parsing and optional trimming, so a blank
whitespace-only line is skipped only when `trim` is also enabled.

```ts
import { parse } from 'fino:format/csv';

parse('a\n\nb\n', { skipEmptyLines: true });
```

### trim

```ts
trim?: boolean
```

Trim leading and trailing JavaScript whitespace from every field.
Defaults to `false`.

Trimming applies to quoted and unquoted fields after quote processing.

```ts
import { parse } from 'fino:format/csv';

parse(' name \n Ada \n', { trim: true });
```

### relaxColumnCount

```ts
relaxColumnCount?: boolean
```

Allow record rows to have a different field count than the header.
Defaults to `false`.

When disabled, record parsing throws `CsvParseError` on the first mismatch.
When enabled, missing fields become `""` and extra fields are ignored.

```ts
import { parse } from 'fino:format/csv';

parse('a,b\n1\n', { header: true, relaxColumnCount: true });
```

### cast

```ts
cast?: boolean | CastFn
```

Convert fields from strings to typed values. Defaults to `false`.

`true` converts `""` and `"null"` to `null`, booleans to booleans, and
numeric-looking values with `Number()`. A function receives the raw field
plus column index and optional header name.

```ts
import { parse } from 'fino:format/csv';

parse('name,age\nAda,36\n', {
  header: true,
  cast: (value, ctx) => ctx.header === 'age' ? Number(value) : value,
});
```

## CsvStringifyOptions

```ts
interface CsvStringifyOptions {
```

Options controlling CSV output dialect and header emission.

Stringification defaults to comma-delimited CSV, double-quote escaping, and
CRLF row endings. Empty input returns an empty string.

```ts
import { stringify, type CsvStringifyOptions } from 'fino:format/csv';

const options: CsvStringifyOptions = { header: true, lineEnding: '\n' };
stringify([{ name: 'Ada' }], options);
```

### delimiter

```ts
delimiter?: string
```

One-character field delimiter. Defaults to `","`.

Fields containing the delimiter are quoted automatically. Multi-character
delimiters are rejected with `TypeError`.

```ts
import { stringify } from 'fino:format/csv';

stringify([['a', 'b']], { delimiter: ';' });
```

### quote

```ts
quote?: string
```

One-character quote delimiter. Defaults to the double quote character.

Quote characters inside fields are doubled during output.

```ts
import { stringify } from 'fino:format/csv';

stringify([["can't", 'stop']], { quote: "'" });
```

### lineEnding

```ts
lineEnding?: string
```

Row separator appended after each emitted row. Defaults to `"\r\n"`.

Use `"\n"` when generating Unix-style text files.

```ts
import { stringify } from 'fino:format/csv';

stringify([['a'], ['b']], { lineEnding: '\n' });
```

### header

```ts
header?: boolean | string[]
```

Controls header row emission.

For record rows, an array fixes header order and selected fields. `true`
emits the union of record keys in discovery order. `false` suppresses the
header row. For positional rows, only an array emits headers.

```ts
import { stringify } from 'fino:format/csv';

stringify([{ b: 2, a: 1 }], { header: ['a', 'b'] });
```

## parse

```ts
function parse(input: string | Uint8Array, options?: CsvParseOptions & {
  header?: false;
  columns?: undefined;
}): string[][]
function parse(input: string | Uint8Array, options: CsvParseOptions & {
  header: true;
}): Record<string, string>[]
function parse(input: string | Uint8Array, options: CsvParseOptions & {
  columns: string[];
}): Record<string, string>[]
function parse(
  input: string | Uint8Array,
  options?: CsvParseOptions
): string[][] | Record<string, string>[]
```

Parse a CSV string or UTF-8 byte buffer into positional rows or records.

The return shape depends on `header` and `columns`: positional `string[][]`
by default, or records when a header source is configured. Malformed quoted
fields and strict record column mismatches throw `CsvParseError`; invalid
delimiter or quote options throw `TypeError`.

```ts
import { parse } from 'fino:format/csv';

parse('a,b\n1,2\n', { header: true }); // [{ a: '1', b: '2' }]
```

## parseStream

```ts
async function* parseStream(
  src: AsyncIterable<Uint8Array>,
  options: CsvParseOptions = {
  },
): AsyncIterableIterator<CsvRow | CsvRecord>
```

Parse a CSV byte stream row-by-row without buffering the entire input.

Chunks from `src` are accumulated only until a complete row is available.
Quoted fields containing embedded newlines are handled across chunk
boundaries. The yielded row shape follows `header` and `columns` in the same
way as `parse()`. Unterminated quoted data or column mismatches throw while
iterating.

```ts
import { parseStream } from 'fino:format/csv';

async function* bytes() {
  yield new TextEncoder().encode('name,age\nAda,');
  yield new TextEncoder().encode('36\n');
}

for await (const row of parseStream(bytes(), { header: true })) {
  console.log(row);
}
```

## stringify

```ts
function stringify(
  rows: string[][] | Record<string, unknown>[],
  options: CsvStringifyOptions = {
  }
): string
```

Serialize rows or records to CSV.

Positional rows are emitted as-is. Record rows use an explicit header array
when provided or the union of discovered keys otherwise. Fields are converted
with `String()`, missing record values become `""`, and fields requiring
escaping are quoted. Empty input returns `""`.

```ts
import { stringify } from 'fino:format/csv';

stringify([{ a: '1', b: '2' }]); // 'a,b\r\n1,2\r\n'
```
