/**
* fino:format/csv - CSV parsing and serialization (RFC 4180 + dialect options).
*
* This module handles comma-separated and delimiter-separated tabular text for
* data import/export workflows. It supports the RFC 4180 quoting model, custom
* one-character delimiters and quote characters, optional comments, trimming,
* header rows, explicit column names, relaxed column counts, and field casting.
*
* `parse()` returns positional `string[][]` rows by default. Enable
* `header: true` to use the first row as object keys, or pass `columns` to
* supply keys explicitly. `parseStream()` consumes async byte chunks and yields
* parsed rows without requiring the whole input to be present at once.
* `stringify()` serializes arrays or records back to CSV and emits CRLF line
* endings by default.
*
* CSV is not a single fully-standardized ecosystem. When interoperating with
* spreadsheets, databases, or data warehouses, match their delimiter, quote,
* header, encoding, and empty-line conventions explicitly.
*
* ```ts no_run
* import { parse, stringify } from 'fino:format/csv';
*
* const rows = parse('name,age\nAda,36\nGrace,85\n', { header: true });
* // [{ name: 'Ada', age: '36' }, { name: 'Grace', age: '85' }]
*
* const out = stringify(rows, { header: true });
* ```
*
* ```ts no_run
* import { parse } from 'fino:format/csv';
*
* const rows = parse('a;b\n1;2\n', {
*   delimiter: ';',
*   header: true,
*   cast: true,
* });
* ```
*
* Useful references:
*   - RFC 4180: https://www.rfc-editor.org/rfc/rfc4180
*   - W3C CSV on the Web: https://www.w3.org/TR/tabular-data-model/
*/
import { Scanner, ParseError } from 'fino:parsing/scanner';
function _isPostQuoteBoundary(code: number, delimCode: number): boolean {
  return code === -1 || code === delimCode || code === 10 || code === 13;
}
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/**
* Error thrown when CSV input is malformed or violates configured column rules.
*
* `CsvParseError` extends `ParseError`, so callers can inspect the inherited
* offset, line, column, format, and renderable diagnostic context. Dialect
* option validation, such as multi-character delimiters, throws `TypeError`
* before parsing starts instead.
*
* ```ts no_run
* import { CsvParseError, parse } from 'fino:format/csv';
*
* try {
*   parse('"unterminated');
* } catch (error) {
*   if (error instanceof CsvParseError) {
*     console.error(error.render());
*   }
* }
* ```
*/
export class CsvParseError extends ParseError {
  /**
  * Error name, always `'CsvParseError'`.
  *
  * Useful for distinguishing CSV failures in logs or serialized error
  * reports where `instanceof` checks are unavailable.
  */
  name = 'CsvParseError';
}
/**
* Positional CSV row with one entry per parsed field.
*
* Rows are returned by `parse()` and `parseStream()` when neither `header` nor
* `columns` is enabled. Fields are strings by default; enabling `cast` can
* produce non-string runtime values even though the public row shape remains
* tuple-like for CSV compatibility.
*
* ```ts no_run
* import type { CsvRow } from 'fino:format/csv';
* import { parse } from 'fino:format/csv';
*
* const rows: CsvRow[] = parse('name,age\nAda,36\n');
* const firstName = rows[1]?.[0];
* ```
*/
export type CsvRow = string[];
/**
* Object row produced when `header: true` or `columns` is enabled.
*
* Each key is taken from the header row or the explicit `columns` option.
* Missing fields are filled with an empty string; extra fields are ignored for
* records unless column-count validation throws first.
*
* ```ts no_run
* import type { CsvRecord } from 'fino:format/csv';
* import { parse } from 'fino:format/csv';
*
* const rows: CsvRecord[] = parse('name,age\nAda,36\n', { header: true });
* rows[0]?.name;
* ```
*/
export type CsvRecord = Record<string, string>;
type CastFn = (value: string, ctx: {
  column: number;
  header: string | undefined;
}) => unknown;
/**
* Options controlling CSV parsing dialect, row shape, and field conversion.
*
* Defaults match common RFC 4180-style CSV: comma delimiter, double-quote
* quoting, no comment lines, positional rows, no trimming, no empty-line
* skipping, strict column counts for records, and no casting.
*
* ```ts no_run
* import { parse, type CsvParseOptions } from 'fino:format/csv';
*
* const options: CsvParseOptions = {
*   delimiter: ';',
*   header: true,
*   skipEmptyLines: true,
* };
* const rows = parse('name;age\nAda;36\n', options);
* ```
*/
export interface CsvParseOptions {
  /**
  * One-character field delimiter. Defaults to `","`.
  *
  * Multi-character delimiters are rejected with `TypeError` before parsing.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse('a;b\n1;2\n', { delimiter: ';' });
  * ```
  */
  delimiter?: string;
  /**
  * One-character quote delimiter. Defaults to the double quote character.
  *
  * The quote character starts and ends quoted fields, and doubled quote
  * characters inside a quoted field become one literal quote.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse("'a','b'\n'one','two'\n", { quote: "'" });
  * ```
  */
  quote?: string;
  /**
  * Optional one-character line comment prefix.
  *
  * Lines whose first character is the comment prefix are skipped. Comments are
  * recognized only at the start of a row, not after fields.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse('# ignored\na,b\n1,2\n', { comment: '#' });
  * ```
  */
  comment?: string;
  /**
  * Use the first parsed row as object keys. Defaults to `false`.
  *
  * When enabled, the header row is not returned as data. If `columns` is also
  * provided, explicit columns take precedence and the first row is treated as
  * data.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * const records = parse('name,age\nAda,36\n', { header: true });
  * ```
  */
  header?: boolean;
  /**
  * Explicit object keys for each field.
  *
  * Supplying columns returns records without consuming a header row. Missing
  * fields are assigned `""`; by default row lengths must match exactly.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse('Ada,36\n', { columns: ['name', 'age'] });
  * ```
  */
  columns?: string[];
  /**
  * Skip rows that contain exactly one empty field. Defaults to `false`.
  *
  * The option is applied after field parsing and optional trimming, so a blank
  * whitespace-only line is skipped only when `trim` is also enabled.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse('a\n\nb\n', { skipEmptyLines: true });
  * ```
  */
  skipEmptyLines?: boolean;
  /**
  * Trim leading and trailing JavaScript whitespace from every field.
  * Defaults to `false`.
  *
  * Trimming applies to quoted and unquoted fields after quote processing.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse(' name \n Ada \n', { trim: true });
  * ```
  */
  trim?: boolean;
  /**
  * Allow record rows to have a different field count than the header.
  * Defaults to `false`.
  *
  * When disabled, record parsing throws `CsvParseError` on the first mismatch.
  * When enabled, missing fields become `""` and extra fields are ignored.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse('a,b\n1\n', { header: true, relaxColumnCount: true });
  * ```
  */
  relaxColumnCount?: boolean;
  /**
  * Convert fields from strings to typed values. Defaults to `false`.
  *
  * `true` converts `""` and `"null"` to `null`, booleans to booleans, and
  * numeric-looking values with `Number()`. A function receives the raw field
  * plus column index and optional header name.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/csv';
  *
  * parse('name,age\nAda,36\n', {
  *   header: true,
  *   cast: (value, ctx) => ctx.header === 'age' ? Number(value) : value,
  * });
  * ```
  */
  cast?: boolean | CastFn;
}
/**
* Options controlling CSV output dialect and header emission.
*
* Stringification defaults to comma-delimited CSV, double-quote escaping, and
* CRLF row endings. Empty input returns an empty string.
*
* ```ts no_run
* import { stringify, type CsvStringifyOptions } from 'fino:format/csv';
*
* const options: CsvStringifyOptions = { header: true, lineEnding: '\n' };
* stringify([{ name: 'Ada' }], options);
* ```
*/
export interface CsvStringifyOptions {
  /**
  * One-character field delimiter. Defaults to `","`.
  *
  * Fields containing the delimiter are quoted automatically. Multi-character
  * delimiters are rejected with `TypeError`.
  *
  * ```ts no_run
  * import { stringify } from 'fino:format/csv';
  *
  * stringify([['a', 'b']], { delimiter: ';' });
  * ```
  */
  delimiter?: string;
  /**
  * One-character quote delimiter. Defaults to the double quote character.
  *
  * Quote characters inside fields are doubled during output.
  *
  * ```ts no_run
  * import { stringify } from 'fino:format/csv';
  *
  * stringify([["can't", 'stop']], { quote: "'" });
  * ```
  */
  quote?: string;
  /**
  * Row separator appended after each emitted row. Defaults to `"\r\n"`.
  *
  * Use `"\n"` when generating Unix-style text files.
  *
  * ```ts no_run
  * import { stringify } from 'fino:format/csv';
  *
  * stringify([['a'], ['b']], { lineEnding: '\n' });
  * ```
  */
  lineEnding?: string;
  /**
  * Controls header row emission.
  *
  * For record rows, an array fixes header order and selected fields. `true`
  * emits the union of record keys in discovery order. `false` suppresses the
  * header row. For positional rows, only an array emits headers.
  *
  * ```ts no_run
  * import { stringify } from 'fino:format/csv';
  *
  * stringify([{ b: 2, a: 1 }], { header: ['a', 'b'] });
  * ```
  */
  header?: boolean | string[];
}
// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
/**
* Parse a CSV string or UTF-8 byte buffer into positional rows or records.
*
* The return shape depends on `header` and `columns`: positional `string[][]`
* by default, or records when a header source is configured. Malformed quoted
* fields and strict record column mismatches throw `CsvParseError`; invalid
* delimiter or quote options throw `TypeError`.
*
* ```ts no_run
* import { parse } from 'fino:format/csv';
*
* parse('a,b\n1,2\n', { header: true }); // [{ a: '1', b: '2' }]
* ```
*/
export function parse(input: string | Uint8Array, options?: CsvParseOptions & {
  header?: false;
  columns?: undefined;
}): string[][];
export function parse(input: string | Uint8Array, options: CsvParseOptions & {
  header: true;
}): Record<string, string>[];
export function parse(input: string | Uint8Array, options: CsvParseOptions & {
  columns: string[];
}): Record<string, string>[];
export function parse(input: string | Uint8Array, options?: CsvParseOptions): string[][] | Record<string, string>[];
export function parse(input: string | Uint8Array, options: CsvParseOptions = {}): string[][] | Record<string, string>[] {
  const delim = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const comment = options.comment;
  const skipEmpty = options.skipEmptyLines ?? false;
  const trim = options.trim ?? false;
  const relax = options.relaxColumnCount ?? false;
  const cast = options.cast;
  if (delim.length !== 1) throw new TypeError('csv: delimiter must be a single character');
  if (quote.length !== 1) throw new TypeError('csv: quote must be a single character');
  const delimCode = delim.charCodeAt(0);
  const quoteCode = quote.charCodeAt(0);
  const commentCode = comment ? comment.charCodeAt(0) : -1;
  const sc = new Scanner(input, {
    encoding: 'utf-8',
    format: 'csv'
  });
  const raw: string[][] = [];
  while (!sc.done) {
    // Skip comment lines
    if (commentCode !== -1 && sc.peekCode() === commentCode) {
      sc.eatUntil((c) => c === 10);
      if (!sc.done) sc.eat();
      continue;
    }
    const row: string[] = [];
    const rowMark = sc.mark();
    while (true) {
      let field: string;
      if (sc.peekCode() === quoteCode) {
        // Quoted field
        sc.eat();
        let buf = '';
        while (true) {
          if (sc.done) throw sc.error('unterminated quoted field', rowMark);
          const c = sc.peekCode();
          if (c === quoteCode) {
            sc.eat();
            if (sc.peekCode() === quoteCode) {
              buf += sc.eat();
            } else {
              if (!_isPostQuoteBoundary(sc.peekCode(), delimCode)) {
                throw sc.error('unexpected text after closing quoted field');
              }
              break;
            }
          } else {
            buf += sc.eat();
          }
        }
        field = buf;
      } else {
        // Unquoted field: eat until delimiter, CR, LF, or EOF
        const start = sc.mark();
        sc.eatUntil((c) => c === delimCode || c === 10 || c === 13);
        field = sc.text(start);
      }
      if (trim) field = field.trim();
      row.push(field);
      // After field: delimiter -> next field; CR/LF/EOF -> end of row
      if (sc.peekCode() === delimCode) {
        sc.eat();
      } else {
        break;
      }
    }
    // Consume line ending
    const lc = sc.peekCode();
    if (lc === 13) {
      sc.eat();
      if (sc.peekCode() === 10) sc.eat();
    } else if (lc === 10) {
      sc.eat();
    }
    if (skipEmpty && row.length === 1 && row[0] === '') continue;
    raw.push(row);
  }
  // Determine headers
  let headers: string[] | null = null;
  let dataRows = raw;
  if (options.columns) {
    headers = options.columns;
  } else if (options.header) {
    headers = raw[0] ?? [];
    dataRows = raw.slice(1);
  }
  // Column count enforcement
  if (headers && !relax) {
    for (let i = 0; i < dataRows.length; i++) {
      if (dataRows[i]!.length !== headers.length) {
        throw new CsvParseError(`row ${i + (options.header ? 2 : 1)} has ${dataRows[i]!.length} fields, expected ${headers.length}`, {
          detail: 'column count mismatch',
          format: 'csv',
          offset: 0,
          source: new Uint8Array(0)
        });
      }
    }
  }
  if (!headers) {
    // Plain string[][]: apply cast if requested
    if (!cast) return dataRows;
    return dataRows.map((row) => row.map((v, ci) => typeof cast === 'function' ? cast(v, {
      column: ci,
      header: undefined
    }) as string : _autocast(v) as string));
  }
  // Object rows
  return dataRows.map((row, ri) => {
    const obj: Record<string, string | unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const v = row[i] ?? '';
      obj[headers[i]!] = cast ? typeof cast === 'function' ? cast(v, {
        column: i,
        header: headers[i]
      }) : _autocast(v) : v;
    }
    return obj as Record<string, string>;
  });
}
function _autocast(v: string): unknown {
  if (v === '' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (!isNaN(n) && v.trim() !== '') return n;
  return v;
}
// ---------------------------------------------------------------------------
// Parse stream
// ---------------------------------------------------------------------------
/**
* Parse a CSV byte stream row-by-row without buffering the entire input.
*
* Chunks from `src` are accumulated only until a complete row is available.
* Quoted fields containing embedded newlines are handled across chunk
* boundaries. When the stream ends with data after the last newline, that
* remainder is parsed and yielded as a final row. The yielded row shape
* follows `header` and `columns` in the same way as `parse()`. Unterminated
* quoted data or column mismatches throw while iterating; invalid delimiter
* or quote options throw `TypeError` on the first `next()` call.
*
* ```ts no_run
* import { parseStream } from 'fino:format/csv';
*
* async function* bytes() {
*   yield new TextEncoder().encode('name,age\nAda,');
*   yield new TextEncoder().encode('36\n');
* }
*
* for await (const row of parseStream(bytes(), { header: true })) {
*   console.log(row);
* }
* ```
*/
export async function* parseStream(src: AsyncIterable<Uint8Array>, options: CsvParseOptions = {}): AsyncIterableIterator<CsvRow | CsvRecord> {
  const delim = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const comment = options.comment;
  const skipEmpty = options.skipEmptyLines ?? false;
  const trim = options.trim ?? false;
  const relax = options.relaxColumnCount ?? false;
  const cast = options.cast;
  if (delim.length !== 1) throw new TypeError('csv: delimiter must be a single character');
  if (quote.length !== 1) throw new TypeError('csv: quote must be a single character');
  const delimCode = delim.charCodeAt(0);
  const quoteCode = quote.charCodeAt(0);
  const commentCode = comment ? comment.charCodeAt(0) : -1;
  let headers: string[] | null = options.columns ?? null;
  let headerConsumed = options.header !== true || options.columns !== undefined;
  // Find the byte offset one past the end of the next complete row in `bytes`
  // starting at `start`. A row is complete when a newline is found outside a
  // quoted field. Returns -1 if no complete row exists yet (need more data).
  function findRowEnd(bytes: Uint8Array, start: number): number {
    let inQuote = false;
    for (let i = start; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (inQuote) {
        if (b === quoteCode) {
          if (bytes[i + 1] === quoteCode) {
            i++;
            continue;
          }
          inQuote = false;
        }
      } else {
        if (b === quoteCode) {
          inQuote = true;
        } else if (b === 13) {
          return bytes[i + 1] === 10 ? i + 2 : i + 1;
        } else if (b === 10) {
          return i + 1;
        }
      }
    }
    return -1;
  }
  // Parse a single row from a byte slice and return its fields.
  // Returns null for comment lines or blank lines when skipEmpty is set.
  function parseRow(bytes: Uint8Array): string[] | null {
    const sc = new Scanner(bytes, {
      encoding: 'utf-8',
      format: 'csv'
    });
    if (commentCode !== -1 && sc.peekCode() === commentCode) return null;
    const row: string[] = [];
    const rowMark = sc.mark();
    while (true) {
      let field: string;
      if (sc.peekCode() === quoteCode) {
        sc.eat();
        let fieldBuf = '';
        while (true) {
          if (sc.done) throw sc.error('unterminated quoted field', rowMark);
          const c = sc.peekCode();
          if (c === quoteCode) {
            sc.eat();
            if (sc.peekCode() === quoteCode) {
              fieldBuf += sc.eat();
            } else {
              if (!_isPostQuoteBoundary(sc.peekCode(), delimCode)) {
                throw sc.error('unexpected text after closing quoted field');
              }
              break;
            }
          } else {
            fieldBuf += sc.eat();
          }
        }
        field = fieldBuf;
      } else {
        const start = sc.mark();
        sc.eatUntil((c) => c === delimCode || c === 10 || c === 13);
        field = sc.text(start);
      }
      if (trim) field = field.trim();
      row.push(field);
      if (sc.peekCode() === delimCode) sc.eat();
      else break;
    }
    if (skipEmpty && row.length === 1 && row[0] === '') return null;
    return row;
  }
  let tail = new Uint8Array(0);
  for await (const chunk of src) {
    // Append chunk to unprocessed tail
    const merged = new Uint8Array(tail.length + chunk.length);
    merged.set(tail, 0);
    merged.set(chunk, tail.length);
    tail = merged;
    // Drain all complete rows from tail
    let offset = 0;
    while (true) {
      const rowEnd = findRowEnd(tail, offset);
      if (rowEnd === -1) break;
      const rowBytes = tail.subarray(offset, rowEnd);
      offset = rowEnd;
      const raw = parseRow(rowBytes);
      if (raw === null) continue;
      if (!headerConsumed) {
        headers = raw;
        headerConsumed = true;
        continue;
      }
      yield _emitStreamRow(raw, headers, relax, cast);
    }
    tail = tail.slice(offset);
  }
  // Last row (no trailing newline)
  if (tail.length > 0) {
    const raw = parseRow(tail);
    if (raw !== null) {
      if (!headerConsumed) {} else {
        yield _emitStreamRow(raw, headers, relax, cast);
      }
    }
  }
}
function _emitStreamRow(raw: string[], headers: string[] | null, relax: boolean, cast: boolean | CastFn | undefined): CsvRow | CsvRecord {
  if (!headers) {
    if (!cast) return raw;
    return raw.map((v, ci) => typeof cast === 'function' ? cast(v, {
      column: ci,
      header: undefined
    }) as string : _autocast(v) as string);
  }
  if (!relax && raw.length !== headers.length) {
    throw new CsvParseError(`row has ${raw.length} fields, expected ${headers.length}`, {
      detail: 'column count mismatch',
      format: 'csv',
      offset: 0,
      source: new Uint8Array(0)
    });
  }
  const obj: Record<string, string | unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    const v = raw[i] ?? '';
    obj[headers[i]!] = cast ? typeof cast === 'function' ? cast(v, {
      column: i,
      header: headers[i]
    }) : _autocast(v) : v;
  }
  return obj as CsvRecord;
}
// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------
/**
* Serialize rows or records to CSV.
*
* Positional rows are emitted as-is. Record rows use an explicit header array
* when provided or the union of discovered keys otherwise. Fields are converted
* with `String()`, missing record values become `""`, and fields containing the
* delimiter, quote, or newlines are quoted automatically. Empty input returns
* `""`. Throws `TypeError` if `delimiter` is not a single character.
*
* ```ts no_run
* import { stringify } from 'fino:format/csv';
*
* stringify([{ a: '1', b: '2' }]); // 'a,b\r\n1,2\r\n'
* ```
*/
export function stringify(rows: string[][] | Record<string, unknown>[], options: CsvStringifyOptions = {}): string {
  const delim = options.delimiter ?? ',';
  const quote = options.quote ?? '"';
  const le = options.lineEnding ?? '\r\n';
  if (delim.length !== 1) throw new TypeError('csv: delimiter must be a single character');
  if (rows.length === 0) return '';
  // Determine if we have object rows
  const isObj = rows.length > 0 && !Array.isArray(rows[0]);
  let headers: string[] | null = null;
  if (isObj) {
    if (Array.isArray(options.header)) {
      headers = options.header as string[];
    } else {
      // Union of all keys in order
      const seen = new Set<string>();
      for (const row of rows as Record<string, unknown>[]) {
        for (const k of Object.keys(row)) seen.add(k);
      }
      headers = [...seen];
    }
  } else if (options.header !== false && Array.isArray(options.header)) {
    headers = options.header as string[];
  }
  const parts: string[] = [];
  if (headers) parts.push(_row(headers, delim, quote) + le);
  for (const row of rows) {
    const fields = isObj ? headers!.map((h) => String((row as Record<string, unknown>)[h] ?? '')) : (row as string[]).map(String);
    parts.push(_row(fields, delim, quote) + le);
  }
  return parts.join('');
}
function _row(fields: string[], delim: string, quote: string): string {
  return fields.map((f) => _quoteField(f, delim, quote)).join(delim);
}
function _quoteField(f: string, delim: string, quote: string): string {
  if (f.includes(delim) || f.includes(quote) || f.includes('\r') || f.includes('\n')) {
    return quote + f.replaceAll(quote, quote + quote) + quote;
  }
  return f;
}
