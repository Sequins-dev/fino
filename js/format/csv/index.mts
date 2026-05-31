/**
 * fino:format/csv — CSV parsing and serialization (RFC 4180 + dialect options).
 *
 * @example
 *   import { parse, stringify } from 'fino:format/csv';
 *
 *   const rows = parse('a,b\n1,2\n3,4', { header: true });
 *   // [{ a: '1', b: '2' }, { a: '3', b: '4' }]
 *
 *   const out = stringify([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
 *   // 'a,b\r\n1,2\r\n3,4\r\n'
 */

import { CsvParseError } from '../_error.mts';
import { decodeUtf8 } from '../../internal/globals/encoding.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CsvRow = string[];
export type CsvRecord = Record<string, string>;

type CastFn = (value: string, ctx: { column: number; header: string | undefined }) => unknown;

export interface CsvParseOptions {
  delimiter?: string;
  quote?: string;
  comment?: string;
  header?: boolean;
  columns?: string[];
  skipEmptyLines?: boolean;
  trim?: boolean;
  relaxColumnCount?: boolean;
  cast?: boolean | CastFn;
}

export interface CsvStringifyOptions {
  delimiter?: string;
  quote?: string;
  lineEnding?: string;
  header?: boolean | string[];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Parse a CSV string or bytes into rows. */
export function parse(input: string | Uint8Array, options?: CsvParseOptions & { header?: false; columns?: undefined }): string[][];
export function parse(input: string | Uint8Array, options: CsvParseOptions & { header: true }): Record<string, string>[];
export function parse(input: string | Uint8Array, options: CsvParseOptions & { columns: string[] }): Record<string, string>[];
export function parse(input: string | Uint8Array, options?: CsvParseOptions): string[][] | Record<string, string>[];
export function parse(input: string | Uint8Array, options: CsvParseOptions = {}): string[][] | Record<string, string>[] {
  const src = typeof input === 'string' ? input : decodeUtf8(input, true, true);
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

  const makeError = (msg: string, line: number, col: number, offset: number, snippet: string) =>
    new CsvParseError(msg, line, col, offset, snippet);

  const raw: string[][] = [];
  let pos = 0;
  let lineNum = 1;

  while (pos < src.length) {
    // Skip comment lines
    if (commentCode !== -1 && src.charCodeAt(pos) === commentCode) {
      while (pos < src.length && src.charCodeAt(pos) !== 0x0a) pos++;
      if (pos < src.length) { pos++; lineNum++; }
      continue;
    }

    const row: string[] = [];
    let rowStart = pos;
    let lineStart = lineNum;

    // Parse one row
    while (true) {
      let field: string;

      if (src.charCodeAt(pos) === quoteCode) {
        // Quoted field
        pos++; // consume opening quote
        let buf = '';
        while (true) {
          if (pos >= src.length) {
            const snip = src.slice(Math.max(0, rowStart), rowStart + 40);
            throw makeError('unterminated quoted field', lineStart, 1, rowStart, snip);
          }
          const c = src.charCodeAt(pos);
          if (c === quoteCode) {
            pos++;
            if (src.charCodeAt(pos) === quoteCode) {
              buf += quote; pos++; // doubled quote → literal quote
            } else {
              break; // closing quote
            }
          } else {
            if (c === 0x0a) lineNum++;
            buf += src[pos]!;
            pos++;
          }
        }
        field = buf;
      } else {
        // Unquoted field — read until delimiter, CR, LF, or EOF
        const start = pos;
        while (pos < src.length) {
          const c = src.charCodeAt(pos);
          if (c === delimCode || c === 0x0a || c === 0x0d) break;
          pos++;
        }
        field = src.slice(start, pos);
      }

      if (trim) field = field.trim();
      row.push(field);

      // After field: delimiter → next field; CR/LF/EOF → end of row
      const c = src.charCodeAt(pos);
      if (c === delimCode) {
        pos++;
      } else {
        break;
      }
    }

    // Consume line ending
    const c = src.charCodeAt(pos);
    if (c === 0x0d && src.charCodeAt(pos + 1) === 0x0a) { pos += 2; lineNum++; }
    else if (c === 0x0d || c === 0x0a) { pos++; lineNum++; }

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
          i + (options.header ? 2 : 1), 1, 0, '',
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
// Stringify
// ---------------------------------------------------------------------------

/** Serialize rows or records to a CSV string. */
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
