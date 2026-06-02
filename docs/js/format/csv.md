# csv

fino:format/csv — CSV parsing and serialization (RFC 4180 + dialect options).

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

Error thrown when CSV input is malformed.

### name

```ts
name
```

## CsvRow

```ts
type CsvRow = string[]
```

Positional CSV row with one string per field.

## CsvRecord

```ts
type CsvRecord = Record<string, string>
```

Object row produced when headers or explicit columns are enabled.

## CsvParseOptions

```ts
interface CsvParseOptions {
```

Options controlling CSV parsing dialect and row shape.

### delimiter

```ts
delimiter?: string
```

One-character field delimiter. Defaults to comma.

### quote

```ts
quote?: string
```

One-character quote delimiter. Defaults to double quote.

### comment

```ts
comment?: string
```

Optional one-character line comment prefix.

### header

```ts
header?: boolean
```

Use the first row as object keys.

### columns

```ts
columns?: string[]
```

Explicit object keys for each field.

### skipEmptyLines

```ts
skipEmptyLines?: boolean
```

### trim

```ts
trim?: boolean
```

### relaxColumnCount

```ts
relaxColumnCount?: boolean
```

### cast

```ts
cast?: boolean | CastFn
```

## CsvStringifyOptions

```ts
interface CsvStringifyOptions {
```

Options controlling CSV output dialect and header emission.

### delimiter

```ts
delimiter?: string
```

One-character field delimiter. Defaults to comma.

### quote

```ts
quote?: string
```

One-character quote delimiter. Defaults to double quote.

### lineEnding

```ts
lineEnding?: string
```

Row separator. Defaults to CRLF.

### header

```ts
header?: boolean | string[]
```

Emit a header row when stringifying records.

## parse

```ts
function parse(input: string | Uint8Array, options?: CsvParseOptions & { header?: false; columns?: undefined }): string[][]
function parse(input: string | Uint8Array, options: CsvParseOptions & { header: true }): Record<string, string>[]
function parse(input: string | Uint8Array, options: CsvParseOptions & { columns: string[] }): Record<string, string>[]
function parse(input: string | Uint8Array, options?: CsvParseOptions): string[][] | Record<string, string>[]
```

Parse a CSV string or bytes into positional rows or records.

```ts
import { parse } from 'fino:format/csv';

parse('a,b\n1,2\n', { header: true }); // [{ a: '1', b: '2' }]
```

## parseStream

```ts
async function* parseStream( src: AsyncIterable<Uint8Array>, options: CsvParseOptions = {}, ): AsyncIterableIterator<CsvRow | CsvRecord>
```

Parse a CSV byte stream row-by-row without buffering the entire input.
Each chunk from `src` is processed incrementally; quoted fields containing
embedded newlines are handled correctly across chunk boundaries.

## stringify

```ts
function stringify( rows: string[][] | Record<string, unknown>[], options: CsvStringifyOptions = {}, ): string
```

Serialize rows or records to CSV.

```ts
import { stringify } from 'fino:format/csv';

stringify([{ a: '1', b: '2' }]); // 'a,b\r\n1,2\r\n'
```
