/**
 * fino:scanner — General-purpose scanning infrastructure for binary and text formats.
 *
 * Supports binary buffer scanning (always), text scanning (opt-in via encoding), and
 * mixed binary/text parsing (common in real protocols: HTTP/1 ASCII headers + binary body,
 * HPACK varint prefixes + UTF-8 strings, ZIP central directory + UTF-8 names).
 *
 * ```ts
 * // Binary protocol
 * import { Scanner } from 'fino:scanner';
 * const s = new Scanner(buffer);
 * const version = s.readU8();
 * const length  = s.readU32BE();
 * const payload = s.eatBytes(length);
 * ```
 *
 * ```ts
 * // Text format
 * import { Scanner, ParseError } from 'fino:scanner';
 * class MyError extends ParseError { name = 'MyError'; }
 * const s = new Scanner(source, { encoding: 'utf-8', format: 'myformat' });
 * while (!s.done) {
 *   const tok = s.eatWhile(code => code !== 0x3B); // eat until ';'
 *   if (!s.done) s.expect(';');
 * }
 * ```
 */

import { encodeUtf8, decodeUtf8 } from './internal/globals/encoding.mts';

export type Encoding = 'utf-8' | 'ascii' | 'latin1' | 'utf-16le' | 'utf-16be';

export interface ScannerOptions {
  encoding?: Encoding;
  format?: string;
  filename?: string;
}

export interface ScannerMark {
  readonly offset: number;
  readonly line?: number;
  readonly column?: number;
}

export type ScannerSnapshot = ScannerMark;

export class ParseError extends Error {
  #source: Uint8Array;
  #detail: string;

  readonly format: string;
  readonly filename: string | undefined;
  readonly offset: number;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly length: number;

  constructor(
    message: string,
    opts: {
      detail: string;
      format: string;
      filename?: string;
      offset: number;
      line?: number;
      column?: number;
      length?: number;
      source: Uint8Array;
    },
  ) {
    super(message);
    this.name = 'ParseError';
    this.#detail   = opts.detail;
    this.format    = opts.format;
    this.filename  = opts.filename;
    this.offset    = opts.offset;
    this.line      = opts.line;
    this.column    = opts.column;
    this.length    = opts.length ?? 1;
    this.#source   = opts.source;
  }

  render(options?: { color?: boolean; contextLines?: number }): string {
    const color = options?.color ?? false;
    const ctx   = options?.contextLines ?? 0;
    if (this.line !== undefined && this.column !== undefined) {
      return _textSnippet(
        this.#source, this.offset, this.line, this.column, this.length,
        this.filename, this.format, this.#detail, color, ctx,
      );
    }
    return _binaryDump(
      this.#source, this.offset, this.length,
      this.filename, this.format, this.#detail, color,
    );
  }
}

export class Scanner {
  #buf: Uint8Array;
  #view: DataView;
  #offset: number = 0;
  #encoding: Encoding | null;
  #line: number = 1;
  #col: number = 1;
  #lineColValid: boolean = true;
  #format: string;
  #filename: string | undefined;

  constructor(source: string | Uint8Array, options?: ScannerOptions) {
    if (typeof source === 'string') {
      this.#buf = encodeUtf8(source);
      this.#encoding = options?.encoding ?? 'utf-8';
    } else {
      this.#buf = source;
      this.#encoding = options?.encoding ?? null;
    }
    this.#view   = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength);
    this.#format = options?.format ?? 'parse';
    this.#filename = options?.filename;
  }

  get offset(): number   { return this.#offset; }
  get done(): boolean    { return this.#offset >= this.#buf.length; }
  get encoding(): Encoding | null { return this.#encoding; }

  get line(): number {
    if (this.#encoding === null) throw new Error('Scanner.line: text ops require encoding');
    if (!this.#lineColValid) throw new Error('Scanner.line: position tracking invalidated by byte op; restore a snapshot to re-synchronize');
    return this.#line;
  }

  get column(): number {
    if (this.#encoding === null) throw new Error('Scanner.column: text ops require encoding');
    if (!this.#lineColValid) throw new Error('Scanner.column: position tracking invalidated by byte op; restore a snapshot to re-synchronize');
    return this.#col;
  }

  // ── BYTE OPS ──────────────────────────────────────────────────────────────

  peekByte(at: number = 0): number {
    const i = this.#offset + at;
    return i < this.#buf.length ? this.#buf[i]! : -1;
  }

  eatByte(): number {
    if (this.#offset >= this.#buf.length) throw this.error('unexpected end of input');
    const b = this.#buf[this.#offset]!;
    this.#offset++;
    if (this.#encoding !== null) this.#lineColValid = false;
    return b;
  }

  eatBytes(n: number): Uint8Array {
    if (this.#offset + n > this.#buf.length)
      throw this.error(`expected ${n} bytes, got ${this.#buf.length - this.#offset}`);
    const view = this.#buf.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    if (this.#encoding !== null && n > 0) this.#lineColValid = false;
    return view;
  }

  matchBytes(b: Uint8Array | readonly number[]): boolean {
    const len = b.length;
    if (len === 0) return true;
    if (this.#offset + len > this.#buf.length) return false;
    for (let i = 0; i < len; i++) {
      if (this.#buf[this.#offset + i] !== b[i]) return false;
    }
    this.#offset += len;
    if (this.#encoding !== null) this.#lineColValid = false;
    return true;
  }

  eatUntilByte(c: number, max?: number): Uint8Array {
    const start = this.#offset;
    const limit = max !== undefined
      ? Math.min(this.#buf.length, this.#offset + max)
      : this.#buf.length;
    while (this.#offset < limit && this.#buf[this.#offset] !== c) this.#offset++;
    if (this.#encoding !== null && this.#offset > start) this.#lineColValid = false;
    return this.#buf.subarray(start, this.#offset);
  }

  bytesSlice(from: ScannerMark, to?: ScannerMark): Uint8Array {
    return this.#buf.subarray(from.offset, to?.offset ?? this.#offset);
  }

  // Endianness-explicit fixed-width reads — all advance the cursor.
  readU8():    number { return this.#readNum(1, false, false, false, false) as number; }
  readI8():    number { return this.#readNum(1, false, false, true,  false) as number; }
  readU16BE(): number { return this.#readNum(2, false, false, false, false) as number; }
  readU16LE(): number { return this.#readNum(2, false, true,  false, false) as number; }
  readI16BE(): number { return this.#readNum(2, false, false, true,  false) as number; }
  readI16LE(): number { return this.#readNum(2, false, true,  true,  false) as number; }
  readU32BE(): number { return this.#readNum(4, false, false, false, false) as number; }
  readU32LE(): number { return this.#readNum(4, false, true,  false, false) as number; }
  readI32BE(): number { return this.#readNum(4, false, false, true,  false) as number; }
  readI32LE(): number { return this.#readNum(4, false, true,  true,  false) as number; }
  readF32BE(): number { return this.#readNum(4, true,  false, false, false) as number; }
  readF32LE(): number { return this.#readNum(4, true,  true,  false, false) as number; }
  readF64BE(): number { return this.#readNum(8, true,  false, false, false) as number; }
  readF64LE(): number { return this.#readNum(8, true,  true,  false, false) as number; }
  readU64BE(): bigint { return this.#readNum(8, false, false, false, true)  as bigint; }
  readU64LE(): bigint { return this.#readNum(8, false, true,  false, true)  as bigint; }
  readI64BE(): bigint { return this.#readNum(8, false, false, true,  true)  as bigint; }
  readI64LE(): bigint { return this.#readNum(8, false, true,  true,  true)  as bigint; }

  eatText(byteLength: number, encoding?: Encoding): string {
    const bytes = this.eatBytes(byteLength);
    return _decodeBytes(bytes, encoding ?? this.#encoding ?? 'utf-8');
  }

  // ── TEXT OPS ──────────────────────────────────────────────────────────────

  peek(n: number = 1): string {
    this.#requireText('peek');
    let off = this.#offset;
    let result = '';
    for (let i = 0; i < n && off < this.#buf.length; i++) {
      const [cp, bw] = this.#peekCpAt(off);
      if (cp === -1) break;
      result += String.fromCodePoint(cp);
      off += bw;
    }
    return result;
  }

  peekCode(n: number = 0): number {
    this.#requireText('peekCode');
    let off = this.#offset;
    for (let i = 0; i < n; i++) {
      const [, bw] = this.#peekCpAt(off);
      if (bw === 0) return -1;
      off += bw;
    }
    return this.#peekCpAt(off)[0];
  }

  eat(n: number = 1): string {
    this.#requireText('eat');
    let result = '';
    for (let i = 0; i < n && this.#offset < this.#buf.length; i++) {
      const [cp, bw] = this.#peekCpAt(this.#offset);
      if (cp === -1) break;
      result += String.fromCodePoint(cp);
      this.#advanceText(cp, bw);
    }
    return result;
  }

  eatChar(s: string): boolean {
    this.#requireText('eatChar');
    return this.#matchAndAdvance(s);
  }

  match(s: string): boolean {
    this.#requireText('match');
    return this.#matchAndAdvance(s);
  }

  eatWhile(pred: (code: number) => boolean): string {
    this.#requireText('eatWhile');
    const enc = this.#encoding!;
    const start = this.#offset;
    while (this.#offset < this.#buf.length) {
      const b = this.#buf[this.#offset]!;
      let cp: number, bw: number;
      // ASCII fast path for single-byte encodings — avoids codepoint decode overhead
      if (b < 0x80 && enc !== 'utf-16le' && enc !== 'utf-16be') {
        cp = b; bw = 1;
      } else {
        [cp, bw] = this.#peekCpAt(this.#offset);
      }
      if (cp === -1 || !pred(cp)) break;
      this.#advanceText(cp, bw);
    }
    return _decodeBytes(this.#buf.subarray(start, this.#offset), enc);
  }

  eatUntil(pred: (code: number) => boolean): string {
    return this.eatWhile(code => !pred(code));
  }

  expect(s: string, message?: string): void {
    if (!this.#matchAndAdvance(s))
      throw this.error(message ?? `expected '${s}', got '${this.peek() || 'EOF'}'`);
  }

  skipSpaceTab(): void {
    this.#requireText('skipSpaceTab');
    this.eatWhile(c => c === 0x20 || c === 0x09);
  }

  skipWhitespace(): void {
    this.#requireText('skipWhitespace');
    this.eatWhile(c => c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D);
  }

  text(from: ScannerMark, to?: ScannerMark): string {
    this.#requireText('text');
    return _decodeBytes(
      this.#buf.subarray(from.offset, to?.offset ?? this.#offset),
      this.#encoding!,
    );
  }

  // ── SPANS + BACKTRACK ─────────────────────────────────────────────────────

  mark(): ScannerMark {
    if (this.#encoding !== null && this.#lineColValid) {
      return { offset: this.#offset, line: this.#line, column: this.#col };
    }
    return { offset: this.#offset };
  }

  snapshot(): ScannerSnapshot {
    return this.mark();
  }

  restore(s: ScannerSnapshot): void {
    this.#offset = s.offset;
    if (s.line !== undefined && s.column !== undefined) {
      this.#line = s.line;
      this.#col  = s.column;
      this.#lineColValid = true;
    } else {
      this.#lineColValid = false;
    }
  }

  // ── ERROR ─────────────────────────────────────────────────────────────────

  error(detail: string, span?: ScannerMark | { from: ScannerMark; to: ScannerMark }): ParseError {
    const at: ScannerMark = span === undefined
      ? this.mark()
      : 'from' in span ? span.from : span;
    const toMark: ScannerMark | undefined = span !== undefined && 'from' in span ? span.to : undefined;
    const length = toMark !== undefined ? Math.max(1, toMark.offset - at.offset) : 1;

    let locStr: string;
    if (at.line !== undefined) {
      locStr = `line ${at.line}, column ${at.column}`;
      if (this.#filename) locStr += ` (${this.#filename})`;
    } else {
      const hex = at.offset.toString(16).toUpperCase().padStart(4, '0');
      locStr = `offset 0x${hex} (${at.offset})`;
    }
    const message = `${this.#format}: ${detail} at ${locStr}`;

    return new ParseError(message, {
      detail,
      format: this.#format,
      filename: this.#filename,
      offset: at.offset,
      line: at.line,
      column: at.column,
      length,
      source: this.#buf,
    });
  }

  // ── PRIVATE ───────────────────────────────────────────────────────────────

  #requireText(op: string): void {
    if (this.#encoding === null)
      throw new Error(`Scanner.${op}: text ops require encoding`);
  }

  #readNum(byteLen: number, float: boolean, le: boolean, signed: boolean, big: boolean): number | bigint {
    if (this.#offset + byteLen > this.#buf.length)
      throw this.error(`unexpected end of input (need ${byteLen} bytes, got ${this.#buf.length - this.#offset})`);
    const o = this.#offset;
    this.#offset += byteLen;
    if (this.#encoding !== null) this.#lineColValid = false;
    const v = this.#view;
    if (float) return byteLen === 4 ? v.getFloat32(o, le) : v.getFloat64(o, le);
    if (big)   return signed ? v.getBigInt64(o, le) : v.getBigUint64(o, le);
    if (byteLen === 1) return signed ? v.getInt8(o)  : v.getUint8(o);
    if (byteLen === 2) return signed ? v.getInt16(o, le) : v.getUint16(o, le);
    return signed ? v.getInt32(o, le) : v.getUint32(o, le);
  }

  #peekCpAt(offset: number): [number, number] {
    if (offset >= this.#buf.length) return [-1, 0];
    const enc = this.#encoding;

    if (enc === 'utf-16le' || enc === 'utf-16be') {
      if (offset + 1 >= this.#buf.length) return [-1, 0];
      const le = enc === 'utf-16le';
      const w0 = this.#view.getUint16(offset, le);
      if (w0 >= 0xD800 && w0 <= 0xDBFF && offset + 3 < this.#buf.length) {
        const w1 = this.#view.getUint16(offset + 2, le);
        if (w1 >= 0xDC00 && w1 <= 0xDFFF)
          return [0x10000 + ((w0 - 0xD800) << 10) + (w1 - 0xDC00), 4];
      }
      return [w0, 2];
    }

    const b = this.#buf[offset]!;
    if (enc === 'ascii' || enc === 'latin1') return [b, 1];

    // UTF-8 decode
    if (b < 0x80) return [b, 1];
    if ((b & 0xE0) === 0xC0 && offset + 1 < this.#buf.length)
      return [(b & 0x1F) << 6 | (this.#buf[offset + 1]! & 0x3F), 2];
    if ((b & 0xF0) === 0xE0 && offset + 2 < this.#buf.length)
      return [(b & 0x0F) << 12 | (this.#buf[offset + 1]! & 0x3F) << 6 | (this.#buf[offset + 2]! & 0x3F), 3];
    if ((b & 0xF8) === 0xF0 && offset + 3 < this.#buf.length)
      return [(b & 0x07) << 18 | (this.#buf[offset + 1]! & 0x3F) << 12 | (this.#buf[offset + 2]! & 0x3F) << 6 | (this.#buf[offset + 3]! & 0x3F), 4];
    return [0xFFFD, 1];
  }

  #advanceText(cp: number, bw: number): void {
    this.#offset += bw;
    if (cp === 0x0A) { this.#line++; this.#col = 1; }
    else { this.#col++; }
  }

  #matchAndAdvance(s: string): boolean {
    const encoded = _encodeForMatch(s, this.#encoding!);
    if (this.#offset + encoded.length > this.#buf.length) return false;
    for (let i = 0; i < encoded.length; i++) {
      if (this.#buf[this.#offset + i] !== encoded[i]) return false;
    }
    // Advance through the characters (updates line/col)
    let byteI = 0;
    while (byteI < encoded.length) {
      const [cp, bw] = this.#peekCpAt(this.#offset);
      this.#advanceText(cp, bw);
      byteI += bw;
    }
    return true;
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function _encodeForMatch(s: string, encoding: Encoding): Uint8Array {
  if (encoding === 'utf-8' || encoding === 'ascii') return encodeUtf8(s);
  if (encoding === 'latin1') {
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xFF;
    return buf;
  }
  // utf-16le / utf-16be
  const le = encoding === 'utf-16le';
  const buf = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (le) { buf[i * 2] = c & 0xFF; buf[i * 2 + 1] = (c >> 8) & 0xFF; }
    else    { buf[i * 2] = (c >> 8) & 0xFF; buf[i * 2 + 1] = c & 0xFF; }
  }
  return buf;
}

function _decodeBytes(bytes: Uint8Array, encoding: Encoding): string {
  if (encoding === 'utf-8') return decodeUtf8(bytes, false, false);
  if (encoding === 'ascii' || encoding === 'latin1') {
    if (bytes.length === 0) return '';
    if (bytes.length <= 65536) return String.fromCharCode.apply(null, bytes as unknown as number[]);
    let s = '';
    for (let i = 0; i < bytes.length; i += 65536)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 65536) as unknown as number[]);
    return s;
  }
  // utf-16le / utf-16be
  const le = encoding === 'utf-16le';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2)
    s += String.fromCharCode(dv.getUint16(i, le));
  return s;
}

function _textSnippet(
  source: Uint8Array,
  offset: number,
  line: number,
  column: number,
  length: number,
  filename: string | undefined,
  format: string,
  detail: string,
  color: boolean,
  contextLines: number,
): string {
  const RESET = color ? '\x1b[0m' : '';
  const RED   = color ? '\x1b[31m' : '';
  const CYAN  = color ? '\x1b[36m' : '';

  const src   = decodeUtf8(source, false, false);
  const lines = src.split('\n');
  const errLine = lines[line - 1] ?? '';

  const lineCol = `line ${line}, column ${column}`;
  const loc = filename ? `${lineCol} (${filename})` : lineCol;
  let out = `${RED}${format} parse error${RESET} at ${CYAN}${loc}${RESET}\n`;

  const maxLineNum = Math.min(lines.length, line + contextLines);
  const gutterW = String(maxLineNum).length;
  const emptyG = ' '.repeat(gutterW + 1);
  const lineGutter = (n: number) => String(n).padStart(gutterW);

  out += `${emptyG}|\n`;

  for (let i = Math.max(0, line - 1 - contextLines); i < line - 1; i++) {
    out += `${lineGutter(i + 1)} | ${lines[i] ?? ''}\n`;
  }

  // Truncate very long lines, keeping caret visible
  const MAX_LINE = 120;
  let displayLine = errLine;
  let displayCol  = column - 1; // 0-indexed
  if (errLine.length > MAX_LINE) {
    const half  = Math.floor(MAX_LINE / 2);
    const start = Math.max(0, displayCol - half);
    const pre   = start > 0 ? '…' : '';
    const suf   = start + MAX_LINE < errLine.length ? '…' : '';
    displayLine = pre + errLine.slice(start, start + MAX_LINE) + suf;
    displayCol  = displayCol - start + (pre ? 1 : 0);
  }

  out += `${RED}${lineGutter(line)}${RESET} | ${displayLine}\n`;

  const caretLen = Math.max(1, Math.min(length, errLine.length - (column - 1)));
  const caret    = '^' + '~'.repeat(caretLen - 1);
  out += `${emptyG}| ${' '.repeat(displayCol)}${RED}${caret}${RESET} ${detail}\n`;

  for (let i = line; i < Math.min(lines.length, line + contextLines); i++) {
    out += `${lineGutter(i + 1)} | ${lines[i] ?? ''}\n`;
  }

  return out;
}

function _binaryDump(
  source: Uint8Array,
  offset: number,
  length: number,
  filename: string | undefined,
  format: string,
  detail: string,
  color: boolean,
): string {
  const RESET = color ? '\x1b[0m' : '';
  const RED   = color ? '\x1b[31m' : '';
  const CYAN  = color ? '\x1b[36m' : '';

  const loc = filename
    ? `${filename} offset 0x${offset.toString(16).padStart(4, '0')} (${offset})`
    : `0x${offset.toString(16).padStart(4, '0')} (${offset})`;
  let out = `${RED}${format} parse error${RESET} at ${CYAN}${loc}${RESET}\n`;

  // Show 1–2 rows of 16 bytes centred on the error offset
  const rowStart = Math.max(0, (Math.floor(offset / 16) - 1)) * 16;
  const rowEnd   = Math.min(source.length, rowStart + 32);

  for (let row = rowStart; row < rowEnd; row += 16) {
    const rowAddr = row.toString(16).padStart(8, '0');
    let hex  = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      const byteOffset = row + i;
      if (i === 8) hex += ' ';
      if (byteOffset < source.length) {
        const b = source[byteOffset]!;
        hex   += b.toString(16).padStart(2, '0') + ' ';
        ascii += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.';
      } else {
        hex   += '   ';
        ascii += ' ';
      }
    }
    out += `  ${rowAddr}  ${hex} ${ascii}\n`;

    // Arrow row under the failing byte(s)
    if (offset >= row && offset < row + 16) {
      const col = offset - row;
      const hexCol = col * 3 + (col >= 8 ? 1 : 0); // account for middle space
      const len = Math.min(length, row + 16 - offset);
      const arrowStr = '^^'.repeat(len).slice(0, len * 3 - 1).replace(/ /g, '^');
      out += `  ${' '.repeat(10)}${' '.repeat(hexCol)}${RED}${'^'.repeat(len > 1 ? len * 3 - 1 : 2)}${RESET}\n`;
    }
  }

  out += `  ${detail}\n`;
  return out;
}
