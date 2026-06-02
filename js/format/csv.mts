/**
 * fino:format/csv — CSV parsing and serialization (RFC 4180 + dialect options).
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Error thrown when CSV input is malformed. */
export class CsvParseError extends ParseError { name = 'CsvParseError'; }

/** Positional CSV row with one string per field. */
export type CsvRow = string[];
/** Object row produced when headers or explicit columns are enabled. */
export type CsvRecord = Record<string, string>;

type CastFn = (value: string, ctx: { column: number; header: string | undefined }) => unknown;

/** Options controlling CSV parsing dialect and row shape. */
export interface CsvParseOptions {
  /** One-character field delimiter. Defaults to comma. */
  delimiter?: string;
  /** One-character quote delimiter. Defaults to double quote. */
  quote?: string;
  /** Optional one-character line comment prefix. */
  comment?: string;
  /** Use the first row as object keys. */
  header?: boolean;
  /** Explicit object keys for each field. */
  columns?: string[];
  skipEmptyLines?: boolean;
  trim?: boolean;
  relaxColumnCount?: boolean;
  cast?: boolean | CastFn;
}

/** Options controlling CSV output dialect and header emission. */
export interface CsvStringifyOptions {
  /** One-character field delimiter. Defaults to comma. */
  delimiter?: string;
  /** One-character quote delimiter. Defaults to double quote. */
  quote?: string;
  /** Row separator. Defaults to CRLF. */
  lineEnding?: string;
  /** Emit a header row when stringifying records. */
  header?: boolean | string[];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string or bytes into positional rows or records.
 *
 * ```ts no_run
 * import { parse } from 'fino:format/csv';
 *
 * parse('a,b\n1,2\n', { header: true }); // [{ a: '1', b: '2' }]
 * ```
 */
export function parse(input: string | Uint8Array, options?: CsvParseOptions & { header?: false; columns?: undefined }): string[][];
export function parse(input: string | Uint8Array, options: CsvParseOptions & { header: true }): Record<string, string>[];
export function parse(input: string | Uint8Array, options: CsvParseOptions & { columns: string[] }): Record<string, string>[];
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

  const sc = new Scanner(input, { encoding: 'utf-8', format: 'csv' });
  const raw: string[][] = [];

  while (!sc.done) {
    // Skip comment lines
    if (commentCode !== -1 && sc.peekCode() === commentCode) {
      sc.eatUntil(c => c === 0x0A);
      if (!sc.done) sc.eat(); // consume LF
      continue;
    }

    const row: string[] = [];
    const rowMark = sc.mark();

    while (true) {
      let field: string;

      if (sc.peekCode() === quoteCode) {
        // Quoted field
        sc.eat(); // consume opening quote
        let buf = '';
        while (true) {
          if (sc.done) throw sc.error('unterminated quoted field', rowMark);
          const c = sc.peekCode();
          if (c === quoteCode) {
            sc.eat();
            if (sc.peekCode() === quoteCode) {
              buf += sc.eat(); // doubled quote → literal quote
            } else {
              break; // closing quote
            }
          } else {
            buf += sc.eat();
          }
        }
        field = buf;
      } else {
        // Unquoted field — eat until delimiter, CR, LF, or EOF
        const start = sc.mark();
        sc.eatUntil(c => c === delimCode || c === 0x0A || c === 0x0D);
        field = sc.text(start);
      }

      if (trim) field = field.trim();
      row.push(field);

      // After field: delimiter → next field; CR/LF/EOF → end of row
      if (sc.peekCode() === delimCode) {
        sc.eat(); // consume delimiter
      } else {
        break;
      }
    }

    // Consume line ending
    const lc = sc.peekCode();
    if (lc === 0x0D) {
      sc.eat(); // CR
      if (sc.peekCode() === 0x0A) sc.eat(); // CRLF
    } else if (lc === 0x0A) {
      sc.eat(); // LF
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
        throw new CsvParseError(
          `row ${i + (options.header ? 2 : 1)} has ${dataRows[i]!.length} fields, expected ${headers.length}`,
          { detail: 'column count mismatch', format: 'csv', offset: 0, source: new Uint8Array(0) },
        );
      }
    }
  }

  if (!headers) {
    // Plain string[][] — apply cast if requested
    if (!cast) return dataRows;
    return dataRows.map(row =>
      row.map((v, ci) =>
        typeof cast === 'function'
          ? cast(v, { column: ci, header: undefined }) as string
          : _autocast(v) as string,
      ),
    );
  }

  // Object rows
  return dataRows.map((row, ri) => {
    const obj: Record<string, string | unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const v = row[i] ?? '';
      obj[headers[i]!] = cast
        ? typeof cast === 'function'
          ? cast(v, { column: i, header: headers[i] })
          : _autocast(v)
        : v;
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
 * Each chunk from `src` is processed incrementally; quoted fields containing
 * embedded newlines are handled correctly across chunk boundaries.
 */
export async function* parseStream(
  src: AsyncIterable<Uint8Array>,
  options: CsvParseOptions = {},
): AsyncIterableIterator<CsvRow | CsvRecord> {
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
          if (bytes[i + 1] === quoteCode) { i++; continue; } // doubled quote
          inQuote = false;
        }
      } else {
        if (b === quoteCode) { inQuote = true; }
        else if (b === 0x0D) { return bytes[i + 1] === 0x0A ? i + 2 : i + 1; } // CR/CRLF
        else if (b === 0x0A) { return i + 1; } // LF
      }
    }
    return -1;
  }

  // Parse a single row from a byte slice and return its fields.
  // Returns null for comment lines or blank lines when skipEmpty is set.
  function parseRow(bytes: Uint8Array): string[] | null {
    const sc = new Scanner(bytes, { encoding: 'utf-8', format: 'csv' });
    if (commentCode !== -1 && sc.peekCode() === commentCode) return null;

    const row: string[] = [];
    const rowMark = sc.mark();

    while (true) {
      let field: string;
      if (sc.peekCode() === quoteCode) {
        sc.eat(); // opening quote
        let fieldBuf = '';
        while (true) {
          if (sc.done) throw sc.error('unterminated quoted field', rowMark);
          const c = sc.peekCode();
          if (c === quoteCode) {
            sc.eat();
            if (sc.peekCode() === quoteCode) { fieldBuf += sc.eat(); }
            else break;
          } else {
            fieldBuf += sc.eat();
          }
        }
        field = fieldBuf;
      } else {
        const start = sc.mark();
        sc.eatUntil(c => c === delimCode || c === 0x0A || c === 0x0D);
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
      if (!headerConsumed) {
        // File was only headers — nothing to yield
      } else {
        yield _emitStreamRow(raw, headers, relax, cast);
      }
    }
  }
}

function _emitStreamRow(
  raw: string[],
  headers: string[] | null,
  relax: boolean,
  cast: boolean | CastFn | undefined,
): CsvRow | CsvRecord {
  if (!headers) {
    if (!cast) return raw;
    return raw.map((v, ci) =>
      typeof cast === 'function'
        ? cast(v, { column: ci, header: undefined }) as string
        : _autocast(v) as string,
    );
  }
  if (!relax && raw.length !== headers.length) {
    throw new CsvParseError(
      `row has ${raw.length} fields, expected ${headers.length}`,
      { detail: 'column count mismatch', format: 'csv', offset: 0, source: new Uint8Array(0) },
    );
  }
  const obj: Record<string, string | unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    const v = raw[i] ?? '';
    obj[headers[i]!] = cast
      ? typeof cast === 'function' ? cast(v, { column: i, header: headers[i] }) : _autocast(v)
      : v;
  }
  return obj as CsvRecord;
}

// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------

/** Serialize rows or records to a CSV string. */
/**
 * Serialize rows or records to CSV.
 *
 * ```ts no_run
 * import { stringify } from 'fino:format/csv';
 *
 * stringify([{ a: '1', b: '2' }]); // 'a,b\r\n1,2\r\n'
 * ```
 */
export function stringify(
  rows: string[][] | Record<string, unknown>[],
  options: CsvStringifyOptions = {},
): string {
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
    const fields = isObj
      ? headers!.map(h => String((row as Record<string, unknown>)[h] ?? ''))
      : (row as string[]).map(String);
    parts.push(_row(fields, delim, quote) + le);
  }

  return parts.join('');
}

function _row(fields: string[], delim: string, quote: string): string {
  return fields.map(f => _quoteField(f, delim, quote)).join(delim);
}

function _quoteField(f: string, delim: string, quote: string): string {
  if (f.includes(delim) || f.includes(quote) || f.includes('\r') || f.includes('\n')) {
    return quote + f.replaceAll(quote, quote + quote) + quote;
  }
  return f;
}
