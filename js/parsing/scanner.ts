/**
* fino:parsing/scanner - General-purpose scanning infrastructure for binary and text formats.
*
* Supports binary buffer scanning (always), text scanning (opt-in via encoding), and
* mixed binary/text parsing (common in real protocols: HTTP/1 ASCII headers + binary body,
* HPACK varint prefixes + UTF-8 strings, ZIP central directory + UTF-8 names).
*
* ```ts no_run
* // Binary protocol
* import { Scanner } from 'fino:parsing/scanner';
* const s = new Scanner(buffer);
* const version = s.readU8();
* const length  = s.readU32BE();
* const payload = s.eatBytes(length);
* ```
*
* ```ts no_run
* // Text format
* import { Scanner, ParseError } from 'fino:parsing/scanner';
* class MyError extends ParseError { name = 'MyError'; }
* const s = new Scanner(source, { encoding: 'utf-8', format: 'myformat' });
* while (!s.done) {
*   const tok = s.eatWhile(code => code !== 0x3B); // eat until ';'
*   if (!s.done) s.expect(';');
* }
* ```
*/
import { encodeUtf8, decodeUtf8 } from 'internal:encoding';
/**
* Text encodings supported by scanner text operations.
*
* A scanner created from bytes has no text encoding unless one is supplied.
* Text operations such as `peek()`, `eat()`, and `text()` require one of these
* encodings.
*
* ```ts no_run
* import { Scanner, type Encoding } from 'fino:parsing/scanner';
*
* const encoding: Encoding = 'utf-8';
* const scanner = new Scanner(new Uint8Array([0x41]), { encoding });
* scanner.eat(); // 'A'
* ```
*/
export type Encoding = 'utf-8' | 'ascii' | 'latin1' | 'utf-16le' | 'utf-16be';
/**
* Options controlling scanner text decoding and error labels.
*
* `encoding` enables text operations for byte input. `format` and `filename`
* are used in parse errors and rendered diagnostics.
*
* ```ts no_run
* import { Scanner, type ScannerOptions } from 'fino:parsing/scanner';
*
* const options: ScannerOptions = { encoding: 'utf-8', format: 'json', filename: 'data.json' };
* const scanner = new Scanner('{"ok":true}', options);
* ```
*/
export interface ScannerOptions {
  /**
  * Text encoding used by scanner text operations.
  *
  * Defaults to `'utf-8'` for string input and `null` for byte input. Without an
  * encoding, text operations throw and binary operations remain available.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0x68, 0x69]), { encoding: 'ascii' }).eat(2);
  * ```
  */
  encoding?: Encoding;
  /**
  * Human-readable format label used in parse errors.
  *
  * Defaults to `'parse'`. Use a format name such as `'csv'` or `'xml'` to make
  * diagnostics clear for callers.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const error = new Scanner('', { format: 'demo' }).error('missing input');
  * error.format; // 'demo'
  * ```
  */
  format?: string;
  /**
  * Optional source filename used in rendered diagnostics.
  *
  * The scanner does not read this file; the value is diagnostic metadata only.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('x', { encoding: 'utf-8', filename: 'input.txt' });
  * scanner.error('bad token').filename;
  * ```
  */
  filename?: string;
}
/**
* Saved scanner position, including line and column when text tracking is active.
*
* Marks can be passed to `text()`, `bytesSlice()`, `restore()`, or `error()` to
* recover spans and render diagnostics. Byte operations after text scanning can
* invalidate line/column tracking; marks captured before that still preserve
* their own location metadata.
*
* ```ts no_run
* import { Scanner, type ScannerMark } from 'fino:parsing/scanner';
*
* const scanner = new Scanner('abc', { encoding: 'utf-8' });
* const mark: ScannerMark = scanner.mark();
* scanner.eat(2);
* scanner.text(mark); // 'ab'
* ```
*/
export interface ScannerMark {
  /**
  * Byte offset from the start of the scanner buffer.
  *
  * The offset is zero-based and is always present, even for pure binary
  * scanners.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const mark = new Scanner('abc', { encoding: 'utf-8' }).mark();
  * mark.offset;
  * ```
  */
  readonly offset: number;
  /**
  * One-based line number, when text position tracking is available.
  *
  * The property is omitted for binary scanners or after byte operations have
  * invalidated text tracking.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('a\nb', { encoding: 'utf-8' });
  * scanner.eat(2);
  * scanner.mark().line;
  * ```
  */
  readonly line?: number;
  /**
  * One-based column number, when text position tracking is available.
  *
  * The property is omitted under the same conditions as `line`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * scanner.eat();
  * scanner.mark().column;
  * ```
  */
  readonly column?: number;
}
/**
* Alias for a saved scanner position.
*
* Snapshots are created with `snapshot()` and restored with `restore()`. They
* have the same shape as `ScannerMark`.
*
* ```ts no_run
* import { Scanner, type ScannerSnapshot } from 'fino:parsing/scanner';
*
* const scanner = new Scanner('abc', { encoding: 'utf-8' });
* const snapshot: ScannerSnapshot = scanner.snapshot();
* scanner.eat();
* scanner.restore(snapshot);
* ```
*/
export type ScannerSnapshot = ScannerMark;
/**
* Parse error with source location and renderable text or binary context.
*
* Format-specific parsers can subclass this error and use `Scanner.error()` to
* create instances with consistent offsets, optional line/column data, and
* source snippets. `render()` returns either a text caret snippet or a binary
* hex dump depending on available location metadata.
*
* ```ts no_run
* import { ParseError, Scanner } from 'fino:parsing/scanner';
*
* const scanner = new Scanner('bad', { encoding: 'utf-8', format: 'demo' });
* const error: ParseError = scanner.error('unexpected token');
* console.log(error.render());
* ```
*/
export class ParseError extends Error {
  /**
  * Private property `#source` used by `ParseError`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #source = undefined;
  *
  *   readInternalState() {
  *     return this.#source;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #source: Uint8Array;
  /**
  * Private property `#detail` used by `ParseError`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #detail = undefined;
  *
  *   readInternalState() {
  *     return this.#detail;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #detail: string;
  /**
  * Parser format label, such as `'csv'`, `'xml'`, or `'parse'`.
  *
  * This is copied from `ScannerOptions.format` or the explicit constructor
  * options and appears in rendered diagnostics.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner('', { format: 'demo' }).error('missing').format;
  * ```
  */
  readonly format: string;
  /**
  * Optional filename associated with the source.
  *
  * The filename is diagnostic metadata and may be `undefined`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner('x', { encoding: 'utf-8', filename: 'input.txt' }).error('bad').filename;
  * ```
  */
  readonly filename: string | undefined;
  /**
  * Byte offset where the error starts.
  *
  * Offsets are zero-based and apply to the scanner's internal byte buffer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * scanner.eat();
  * scanner.error('bad').offset;
  * ```
  */
  readonly offset: number;
  /**
  * One-based line number for text errors.
  *
  * The value is `undefined` when no text position is available, for example on
  * binary-only scanners.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner('a\nb', { encoding: 'utf-8' }).error('bad').line;
  * ```
  */
  readonly line: number | undefined;
  /**
  * One-based column number for text errors.
  *
  * The value is `undefined` when no text position is available.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner('abc', { encoding: 'utf-8' }).error('bad').column;
  * ```
  */
  readonly column: number | undefined;
  /**
  * Highlight length in bytes or text columns, depending on diagnostic mode.
  *
  * Defaults to `1` when no explicit span is supplied.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * const from = scanner.mark();
  * scanner.eat(2);
  * scanner.error('bad span', { from, to: scanner.mark() }).length;
  * ```
  */
  readonly length: number;
  /**
  * Create a parse error with explicit source and location metadata.
  *
  * Most parsers should call `Scanner.error()` instead so offsets and line
  * tracking are filled from the current scanner state. Construct directly when
  * adapting diagnostics from another parser.
  *
  * ```ts no_run
  * import { ParseError } from 'fino:parsing/scanner';
  *
  * const error = new ParseError('demo: bad at offset 0', {
  *   detail: 'bad',
  *   format: 'demo',
  *   offset: 0,
  *   source: new Uint8Array([0x62, 0x61, 0x64]),
  * });
  * ```
  */
  constructor(message: string, opts: {
    detail: string;
    format: string;
    filename?: string;
    offset: number;
    line?: number;
    column?: number;
    length?: number;
    source: Uint8Array;
  }) {
    super(message);
    this.name = 'ParseError';
    this.#detail = opts.detail;
    this.format = opts.format;
    this.filename = opts.filename;
    this.offset = opts.offset;
    this.line = opts.line;
    this.column = opts.column;
    this.length = opts.length ?? 1;
    this.#source = opts.source;
  }
  /**
  * Render a diagnostic snippet for humans.
  *
  * Text errors render line context and a caret. Binary errors render a small
  * hex dump around the failing byte. `color` defaults to `false` and
  * `contextLines` defaults to `0`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const error = new Scanner('a\nb', { encoding: 'utf-8' }).error('bad');
  * console.log(error.render({ contextLines: 1 }));
  * ```
  */
  render(options?: {
    color?: boolean;
    contextLines?: number;
  }): string {
    const color = options?.color ?? false;
    const ctx = options?.contextLines ?? 0;
    if (this.line !== undefined && this.column !== undefined) {
      return _textSnippet(this.#source, this.offset, this.line, this.column, this.length, this.filename, this.format, this.#detail, color, ctx);
    }
    return _binaryDump(this.#source, this.offset, this.length, this.filename, this.format, this.#detail, color);
  }
}
/**
* Cursor-based scanner for mixed binary and text parsers.
*
* The scanner owns a byte buffer and advances a cursor through binary and
* text-oriented operations. Text operations require an encoding. Byte
* operations can invalidate line/column tracking; use `mark()` or `snapshot()`
* before switching modes when you need to restore text positions.
*
* ```ts no_run
* import { Scanner } from 'fino:parsing/scanner';
*
* const scanner = new Scanner('name:value\r\n', { encoding: 'utf-8', format: 'header' });
* const name = scanner.readToken('header name');
* scanner.expect(':');
* const value = scanner.eatUntil((code) => code === 0x0D);
* ```
*/
export class Scanner {
  /**
  * Private property `#buf` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #buf = undefined;
  *
  *   readInternalState() {
  *     return this.#buf;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #buf: Uint8Array;
  /**
  * Private property `#view` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #view = undefined;
  *
  *   readInternalState() {
  *     return this.#view;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #view: DataView;
  /**
  * Private property `#offset` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #offset = undefined;
  *
  *   readInternalState() {
  *     return this.#offset;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #offset: number = 0;
  /**
  * Private property `#encoding` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #encoding = undefined;
  *
  *   readInternalState() {
  *     return this.#encoding;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #encoding: Encoding | null;
  /**
  * Private property `#line` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #line = undefined;
  *
  *   readInternalState() {
  *     return this.#line;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #line: number = 1;
  /**
  * Private property `#col` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #col = undefined;
  *
  *   readInternalState() {
  *     return this.#col;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #col: number = 1;
  /**
  * Private property `#lineColValid` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #lineColValid = undefined;
  *
  *   readInternalState() {
  *     return this.#lineColValid;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #lineColValid: boolean = true;
  /**
  * Private property `#format` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #format = undefined;
  *
  *   readInternalState() {
  *     return this.#format;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #format: string;
  /**
  * Private property `#filename` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #filename = undefined;
  *
  *   readInternalState() {
  *     return this.#filename;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #filename: string | undefined;
  /**
  * Create a scanner over string or byte input.
  *
  * String input is encoded as UTF-8 and defaults to UTF-8 text mode. Byte
  * input defaults to binary mode unless `options.encoding` is provided.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const textScanner = new Scanner('abc', { encoding: 'utf-8' });
  * const binaryScanner = new Scanner(new Uint8Array([1, 2, 3]));
  * ```
  */
  constructor(source: string | Uint8Array, options?: ScannerOptions) {
    if (typeof source === 'string') {
      this.#buf = encodeUtf8(source);
      this.#encoding = options?.encoding ?? 'utf-8';
    } else {
      this.#buf = source;
      this.#encoding = options?.encoding ?? null;
    }
    this.#view = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength);
    this.#format = options?.format ?? 'parse';
    this.#filename = options?.filename;
  }
  /**
  * Current byte offset from the start of the scanner buffer.
  *
  * The value advances as text or byte operations consume input.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * scanner.eat();
  * scanner.offset; // 1
  * ```
  */
  get offset(): number {
    return this.#offset;
  }
  /**
  * Whether the scanner cursor is at or past the end of input.
  *
  * Use this to drive parser loops without peeking past the buffer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('a', { encoding: 'utf-8' });
  * scanner.eat();
  * scanner.done; // true
  * ```
  */
  get done(): boolean {
    return this.#offset >= this.#buf.length;
  }
  /**
  * Active text encoding, or `null` for binary-only scanning.
  *
  * Text operations throw when this value is `null`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0x61])).encoding; // null
  * ```
  */
  get encoding(): Encoding | null {
    return this.#encoding;
  }
  /**
  * Number of unread bytes remaining in the buffer.
  *
  * This is byte-oriented even when text scanning is active.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([1, 2, 3]));
  * scanner.eatByte();
  * scanner.remainingBytes; // 2
  * ```
  */
  get remainingBytes(): number {
    return this.#buf.length - this.#offset;
  }
  /**
  * Current one-based line number for text scanning.
  *
  * Throws if no encoding is active or if byte operations invalidated text
  * position tracking. Restore a text snapshot to resynchronize.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('a\nb', { encoding: 'utf-8' });
  * scanner.eat(2);
  * scanner.line; // 2
  * ```
  */
  get line(): number {
    if (this.#encoding === null) throw new Error('Scanner.line: text ops require encoding');
    if (!this.#lineColValid) throw new Error('Scanner.line: position tracking invalidated by byte op; restore a snapshot to re-synchronize');
    return this.#line;
  }
  /**
  * Current one-based column number for text scanning.
  *
  * Throws under the same conditions as `line`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * scanner.eat();
  * scanner.column; // 2
  * ```
  */
  get column(): number {
    if (this.#encoding === null) throw new Error('Scanner.column: text ops require encoding');
    if (!this.#lineColValid) throw new Error('Scanner.column: position tracking invalidated by byte op; restore a snapshot to re-synchronize');
    return this.#col;
  }
  // BYTE OPS
  /**
  * Return a byte at the current cursor plus an optional offset without advancing.
  *
  * Returns `-1` when the requested position is beyond the end of input.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([0x41]));
  * scanner.peekByte(); // 0x41
  * ```
  */
  peekByte(at: number = 0): number {
    const i = this.#offset + at;
    return i < this.#buf.length ? this.#buf[i]! : -1;
  }
  /**
  * Consume and return one byte.
  *
  * Throws `ParseError` at end of input. When text mode is active, this byte
  * operation invalidates line and column tracking.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const byte = new Scanner(new Uint8Array([1, 2])).eatByte();
  * ```
  */
  eatByte(): number {
    if (this.#offset >= this.#buf.length) throw this.error('unexpected end of input');
    const b = this.#buf[this.#offset]!;
    this.#offset++;
    if (this.#encoding !== null) this.#lineColValid = false;
    return b;
  }
  /**
  * Consume `n` bytes and return a view into the scanner buffer.
  *
  * Throws `ParseError` if fewer than `n` bytes remain. The returned
  * `Uint8Array` is a subarray view, not a defensive copy.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([1, 2, 3]));
  * scanner.eatBytes(2); // Uint8Array [1, 2]
  * ```
  */
  eatBytes(n: number): Uint8Array {
    if (this.#offset + n > this.#buf.length) throw this.error(`expected ${n} bytes, got ${this.#buf.length - this.#offset}`);
    const view = this.#buf.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    if (this.#encoding !== null && n > 0) this.#lineColValid = false;
    return view;
  }
  /**
  * Match and consume an exact byte sequence.
  *
  * Returns `true` and advances when all bytes match. Returns `false` and leaves
  * the cursor unchanged when the sequence does not match or is incomplete.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([0x50, 0x4b]));
  * scanner.matchBytes([0x50, 0x4b]); // true
  * ```
  */
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
  /**
  * Consume bytes until a delimiter byte or optional maximum length is reached.
  *
  * The delimiter is not consumed. The returned value is a subarray view of the
  * consumed bytes and may be empty when the cursor already points at the
  * delimiter.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([1, 2, 0, 3]));
  * scanner.eatUntilByte(0); // Uint8Array [1, 2]
  * ```
  */
  eatUntilByte(c: number, max?: number): Uint8Array {
    const start = this.#offset;
    const limit = max !== undefined ? Math.min(this.#buf.length, this.#offset + max) : this.#buf.length;
    while (this.#offset < limit && this.#buf[this.#offset] !== c) this.#offset++;
    if (this.#encoding !== null && this.#offset > start) this.#lineColValid = false;
    return this.#buf.subarray(start, this.#offset);
  }
  /**
  * Return a byte slice between two marks or from a mark to the current cursor.
  *
  * The result is a subarray view and does not advance the scanner.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([1, 2, 3]));
  * const from = scanner.mark();
  * scanner.eatBytes(2);
  * scanner.bytesSlice(from); // Uint8Array [1, 2]
  * ```
  */
  bytesSlice(from: ScannerMark, to?: ScannerMark): Uint8Array {
    return this.#buf.subarray(from.offset, to?.offset ?? this.#offset);
  }
  // Endianness-explicit fixed-width reads; all advance the cursor.
  /**
  * Read an unsigned 8-bit integer and advance by one byte.
  *
  * Throws `ParseError` if no byte remains.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([255])).readU8();
  * ```
  */
  readU8(): number {
    return this.#readNum(1, false, false, false, false) as number;
  }
  /**
  * Read a signed 8-bit integer and advance by one byte.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([255])).readI8(); // -1
  * ```
  */
  readI8(): number {
    return this.#readNum(1, false, false, true, false) as number;
  }
  /**
  * Read an unsigned big-endian 16-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0x01, 0x00])).readU16BE(); // 256
  * ```
  */
  readU16BE(): number {
    return this.#readNum(2, false, false, false, false) as number;
  }
  /**
  * Read an unsigned little-endian 16-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0x00, 0x01])).readU16LE(); // 256
  * ```
  */
  readU16LE(): number {
    return this.#readNum(2, false, true, false, false) as number;
  }
  /**
  * Read a signed big-endian 16-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0xff, 0xff])).readI16BE(); // -1
  * ```
  */
  readI16BE(): number {
    return this.#readNum(2, false, false, true, false) as number;
  }
  /**
  * Read a signed little-endian 16-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0xff, 0xff])).readI16LE(); // -1
  * ```
  */
  readI16LE(): number {
    return this.#readNum(2, false, true, true, false) as number;
  }
  /**
  * Read an unsigned big-endian 32-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0, 0, 0, 1])).readU32BE();
  * ```
  */
  readU32BE(): number {
    return this.#readNum(4, false, false, false, false) as number;
  }
  /**
  * Read an unsigned little-endian 32-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([1, 0, 0, 0])).readU32LE();
  * ```
  */
  readU32LE(): number {
    return this.#readNum(4, false, true, false, false) as number;
  }
  /**
  * Read a signed big-endian 32-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff])).readI32BE();
  * ```
  */
  readI32BE(): number {
    return this.#readNum(4, false, false, true, false) as number;
  }
  /**
  * Read a signed little-endian 32-bit integer.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff])).readI32LE();
  * ```
  */
  readI32LE(): number {
    return this.#readNum(4, false, true, true, false) as number;
  }
  /**
  * Read a big-endian IEEE 754 32-bit float.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0x3f, 0x80, 0, 0])).readF32BE(); // 1
  * ```
  */
  readF32BE(): number {
    return this.#readNum(4, true, false, false, false) as number;
  }
  /**
  * Read a little-endian IEEE 754 32-bit float.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0, 0, 0x80, 0x3f])).readF32LE(); // 1
  * ```
  */
  readF32LE(): number {
    return this.#readNum(4, true, true, false, false) as number;
  }
  /**
  * Read a big-endian IEEE 754 64-bit float.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0x3f, 0xf0, 0, 0, 0, 0, 0, 0])).readF64BE();
  * ```
  */
  readF64BE(): number {
    return this.#readNum(8, true, false, false, false) as number;
  }
  /**
  * Read a little-endian IEEE 754 64-bit float.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0, 0, 0, 0, 0, 0, 0xf0, 0x3f])).readF64LE();
  * ```
  */
  readF64LE(): number {
    return this.#readNum(8, true, true, false, false) as number;
  }
  /**
  * Read an unsigned big-endian 64-bit integer as `bigint`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1])).readU64BE();
  * ```
  */
  readU64BE(): bigint {
    return this.#readNum(8, false, false, false, true) as bigint;
  }
  /**
  * Read an unsigned little-endian 64-bit integer as `bigint`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])).readU64LE();
  * ```
  */
  readU64LE(): bigint {
    return this.#readNum(8, false, true, false, true) as bigint;
  }
  /**
  * Read a signed big-endian 64-bit integer as `bigint`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).readI64BE();
  * ```
  */
  readI64BE(): bigint {
    return this.#readNum(8, false, false, true, true) as bigint;
  }
  /**
  * Read a signed little-endian 64-bit integer as `bigint`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).readI64LE();
  * ```
  */
  readI64LE(): bigint {
    return this.#readNum(8, false, true, true, true) as bigint;
  }
  /**
  * Read a named unsigned big-endian 16-bit field.
  *
  * The field name appears in the end-of-input error message when not enough
  * bytes remain.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0, 10])).readU16BEField('length');
  * ```
  */
  readU16BEField(name: string): number {
    return this.#readField(name, 2, () => this.readU16BE()) as number;
  }
  /**
  * Read a named unsigned big-endian 32-bit field.
  *
  * The field name appears in the end-of-input error message when not enough
  * bytes remain.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner(new Uint8Array([0, 0, 0, 10])).readU32BEField('size');
  * ```
  */
  readU32BEField(name: string): number {
    return this.#readField(name, 4, () => this.readU32BE()) as number;
  }
  /**
  * Consume a fixed number of bytes and decode them as text.
  *
  * Uses the supplied encoding, the scanner's active encoding, or UTF-8 by
  * default. Throws if fewer than `byteLength` bytes remain.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([0x68, 0x69]));
  * scanner.eatText(2, 'ascii'); // 'hi'
  * ```
  */
  eatText(byteLength: number, encoding?: Encoding): string {
    const bytes = this.eatBytes(byteLength);
    return _decodeBytes(bytes, encoding ?? this.#encoding ?? 'utf-8');
  }
  // TEXT OPS
  /**
  * Peek up to `n` Unicode code points without advancing.
  *
  * Requires text mode. Returns fewer characters near end of input and `""`
  * when already done.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('hello', { encoding: 'utf-8' });
  * scanner.peek(2); // 'he'
  * ```
  */
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
  /**
  * Peek a Unicode code point without advancing.
  *
  * `n` counts code points after the current cursor, not bytes. Returns `-1`
  * when the requested character is beyond end of input.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * new Scanner('abc', { encoding: 'utf-8' }).peekCode(); // 0x61
  * ```
  */
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
  /**
  * Consume up to `n` Unicode code points and return them as a string.
  *
  * Requires text mode. The method stops at end of input without throwing.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * scanner.eat(2); // 'ab'
  * ```
  */
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
  /**
  * Match and consume an exact text string.
  *
  * Returns `true` on match and `false` without advancing otherwise. This is an
  * alias-style helper for single characters or short delimiters.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(':value', { encoding: 'utf-8' });
  * scanner.eatChar(':'); // true
  * ```
  */
  eatChar(s: string): boolean {
    this.#requireText('eatChar');
    return this.#matchAndAdvance(s);
  }
  /**
  * Match and consume an exact text string.
  *
  * Returns `true` on match and `false` without advancing otherwise. Use
  * `expect()` when mismatch should throw.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('true', { encoding: 'utf-8' });
  * scanner.match('true'); // true
  * ```
  */
  match(s: string): boolean {
    this.#requireText('match');
    return this.#matchAndAdvance(s);
  }
  /**
  * Consume characters while a predicate returns `true`.
  *
  * The predicate receives Unicode code points. Returns the consumed text and
  * may return `""` when the first character does not match.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc123', { encoding: 'utf-8' });
  * scanner.eatWhile((code) => code >= 0x61 && code <= 0x7a); // 'abc'
  * ```
  */
  eatWhile(pred: (code: number) => boolean): string {
    this.#requireText('eatWhile');
    const enc = this.#encoding!;
    const start = this.#offset;
    while (this.#offset < this.#buf.length) {
      const b = this.#buf[this.#offset]!;
      let cp: number, bw: number;
      // ASCII fast path for single-byte encodings; avoids codepoint decode overhead
      if (b < 128 && enc !== 'utf-16le' && enc !== 'utf-16be') {
        cp = b;
        bw = 1;
      } else {
        [cp, bw] = this.#peekCpAt(this.#offset);
      }
      if (cp === -1 || !pred(cp)) break;
      this.#advanceText(cp, bw);
    }
    return _decodeBytes(this.#buf.subarray(start, this.#offset), enc);
  }
  /**
  * Consume characters until a predicate returns `true`.
  *
  * The delimiter character is not consumed. This is equivalent to
  * `eatWhile(code => !pred(code))`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('name:value', { encoding: 'utf-8' });
  * scanner.eatUntil((code) => code === 0x3a); // 'name'
  * ```
  */
  eatUntil(pred: (code: number) => boolean): string {
    return this.eatWhile((code) => !pred(code));
  }
  /**
  * Require an exact text string and consume it.
  *
  * Throws `ParseError` with either the supplied message or an automatically
  * generated expectation message when the text does not match.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('=value', { encoding: 'utf-8' });
  * scanner.expect('=');
  * ```
  */
  expect(s: string, message?: string): void {
    if (!this.#matchAndAdvance(s)) throw this.error(message ?? `expected '${s}', got '${this.peek() || 'EOF'}'`);
  }
  /**
  * Skip ASCII space and tab characters.
  *
  * Newlines are not consumed. Requires text mode.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(' \tvalue', { encoding: 'utf-8' });
  * scanner.skipSpaceTab();
  * scanner.peek(); // 'v'
  * ```
  */
  skipSpaceTab(): void {
    this.#requireText('skipSpaceTab');
    this.eatWhile((c) => c === 32 || c === 9);
  }
  /**
  * Skip ASCII spaces, tabs, carriage returns, and line feeds.
  *
  * Requires text mode and updates line/column tracking for skipped newlines.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(' \nvalue', { encoding: 'utf-8' });
  * scanner.skipWhitespace();
  * ```
  */
  skipWhitespace(): void {
    this.#requireText('skipWhitespace');
    this.eatWhile((c) => c === 32 || c === 9 || c === 10 || c === 13);
  }
  /**
  * Decode text between two marks or from a mark to the current cursor.
  *
  * Requires text mode. The scanner cursor is not changed.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * const from = scanner.mark();
  * scanner.eat(2);
  * scanner.text(from); // 'ab'
  * ```
  */
  text(from: ScannerMark, to?: ScannerMark): string {
    this.#requireText('text');
    return _decodeBytes(this.#buf.subarray(from.offset, to?.offset ?? this.#offset), this.#encoding!);
  }
  /**
  * Read one CRLF-terminated text line.
  *
  * The returned line excludes the `\r\n` terminator. Bare LF and missing CRLF
  * before end of input throw `ParseError`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('first\r\nsecond\r\n', { encoding: 'utf-8' });
  * scanner.readLineCRLF(); // 'first'
  * ```
  */
  readLineCRLF(): string {
    this.#requireText('readLineCRLF');
    const start = this.#offset;
    while (this.#offset < this.#buf.length) {
      const b = this.#buf[this.#offset]!;
      if (b === 10) throw this.error('expected CRLF line ending, got bare LF', {
        offset: this.#offset,
        line: this.#line,
        column: this.#col
      });
      if (b === 13) {
        if (this.#offset + 1 >= this.#buf.length || this.#buf[this.#offset + 1] !== 10) {
          throw this.error('expected CRLF line ending');
        }
        const line = _decodeBytes(this.#buf.subarray(start, this.#offset), this.#encoding!);
        this.#offset += 2;
        this.#line++;
        this.#col = 1;
        return line;
      }
      const [cp, bw] = this.#peekCpAt(this.#offset);
      if (cp === -1) break;
      this.#advanceText(cp, bw);
    }
    throw this.error('expected CRLF line ending before end of input');
  }
  /**
  * Read CRLF-terminated header lines until an empty line.
  *
  * Returns header lines without terminators and without the final empty line.
  * Bare LF or unterminated input throws via `readLineCRLF()`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('A: b\r\n\r\n', { encoding: 'utf-8' });
  * scanner.readHeaderBlock(); // ['A: b']
  * ```
  */
  readHeaderBlock(): string[] {
    const lines: string[] = [];
    while (true) {
      const line = this.readLineCRLF();
      if (line === '') return lines;
      lines.push(line);
    }
  }
  /**
  * Read ASCII bytes until a delimiter byte.
  *
  * Throws if a consumed byte is non-ASCII. The delimiter is consumed only when
  * `consumeDelimiter` is `true`; otherwise it remains at the cursor.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner(new Uint8Array([0x61, 0x3a, 0x62]));
  * scanner.readAsciiSpanUntilByte(0x3a, true); // Uint8Array [0x61]
  * ```
  */
  readAsciiSpanUntilByte(delimiter: number, consumeDelimiter: boolean = false): Uint8Array {
    const start = this.#offset;
    while (this.#offset < this.#buf.length && this.#buf[this.#offset] !== delimiter) {
      const b = this.#buf[this.#offset]!;
      if (b > 127) throw this.error('expected ASCII byte');
      this.#offset++;
    }
    const span = this.#buf.subarray(start, this.#offset);
    if (consumeDelimiter && this.#offset < this.#buf.length) this.#offset++;
    if (this.#encoding !== null && this.#offset > start) this.#lineColValid = false;
    return span;
  }
  /**
  * Read the remaining text as a delimiter-separated list.
  *
  * ASCII spaces and tabs are trimmed around each part, and empty parts are
  * omitted. Requires text mode and consumes the rest of the input.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('a, b,, c', { encoding: 'utf-8' });
  * scanner.readDelimitedList(','); // ['a', 'b', 'c']
  * ```
  */
  readDelimitedList(delimiter: string): string[] {
    this.#requireText('readDelimitedList');
    const raw = this.eatWhile(() => true);
    const out: string[] = [];
    for (const part of raw.split(delimiter)) {
      const trimmed = _trimAscii(part);
      if (trimmed !== '') out.push(trimmed);
    }
    return out;
  }
  /**
  * Read a protocol-style token.
  *
  * Tokens are visible ASCII characters excluding comma, colon, semicolon, and
  * ASCII control/space characters. Throws when no token is present.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('Content-Type: text/plain', { encoding: 'utf-8' });
  * scanner.readToken('header name'); // 'Content-Type'
  * ```
  */
  readToken(name: string = 'token'): string {
    this.#requireText('readToken');
    const token = this.eatWhile(_isProtocolTokenCode);
    if (token === '') throw this.error(`expected ${name}`);
    return token;
  }
  /**
  * Require a specific protocol token.
  *
  * Reads one token and throws when it does not match `expected`. Set
  * `caseInsensitive` for ASCII case-insensitive comparisons.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('GET /', { encoding: 'utf-8' });
  * scanner.expectToken('get', { caseInsensitive: true, name: 'method' });
  * ```
  */
  expectToken(expected: string, options?: {
    caseInsensitive?: boolean;
    name?: string;
  }): void {
    const actual = this.readToken(options?.name ?? 'token');
    const ok = options?.caseInsensitive ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    if (!ok) throw this.error(`expected ${options?.name ?? 'token'} '${expected}', got '${actual}'`);
  }
  /**
  * Read a strictly formatted decimal or hexadecimal integer token.
  *
  * Defaults to unsigned base-10. Range checks throw `ParseError` with the
  * provided field name when the parsed value is outside `min` or `max`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('2a', { encoding: 'utf-8' });
  * scanner.readStrictInt({ radix: 16, name: 'length', max: 0xff });
  * ```
  */
  readStrictInt(options?: {
    radix?: 10 | 16;
    name?: string;
    min?: number;
    max?: number;
    allowSign?: boolean;
  }): number {
    this.#requireText('readStrictInt');
    const radix = options?.radix ?? 10;
    const name = options?.name ?? 'integer';
    const token = this.readToken(name);
    const sign = options?.allowSign ? '[+-]?' : '';
    const digits = radix === 16 ? '[0-9A-Fa-f]+' : '[0-9]+';
    const re = new RegExp(`^${sign}${digits}$`);
    if (!re.test(token)) throw this.error(`invalid ${name}: '${token}'`);
    const value = parseInt(token, radix);
    if (options?.min !== undefined && value < options.min) throw this.error(`invalid ${name}: ${value} < ${options.min}`);
    if (options?.max !== undefined && value > options.max) throw this.error(`invalid ${name}: ${value} > ${options.max}`);
    return value;
  }
  /**
  * Create a new scanner over the next `byteLength` bytes.
  *
  * The parent scanner advances by `byteLength`. Child options default to the
  * parent encoding, format, and filename unless overridden.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const parent = new Scanner(new Uint8Array([0x61, 0x62]), { encoding: 'ascii' });
  * const child = parent.subScanner(1);
  * child.eat(); // 'a'
  * ```
  */
  subScanner(byteLength: number, options?: ScannerOptions): Scanner {
    const bytes = this.eatBytes(byteLength);
    return new Scanner(bytes, {
      encoding: options?.encoding ?? this.#encoding ?? undefined,
      format: options?.format ?? this.#format,
      filename: options?.filename ?? this.#filename
    });
  }
  /**
  * Move the cursor to an absolute byte offset.
  *
  * Offsets must be integers between `0` and the buffer length inclusive.
  * Jumping in text mode invalidates line/column tracking.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * scanner.jump(2);
  * scanner.peek(); // 'c'
  * ```
  */
  jump(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.#buf.length) throw this.error(`invalid jump offset ${offset}`);
    this.#offset = offset;
    if (this.#encoding !== null) this.#lineColValid = false;
  }
  // SPANS + BACKTRACK
  /**
  * Save the current scanner position.
  *
  * In text mode, the mark includes line and column when tracking is still
  * valid. Use marks for span extraction, diagnostics, and manual backtracking.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * const start = scanner.mark();
  * scanner.eat(3);
  * scanner.text(start); // 'abc'
  * ```
  */
  mark(): ScannerMark {
    if (this.#encoding !== null && this.#lineColValid) {
      return {
        offset: this.#offset,
        line: this.#line,
        column: this.#col
      };
    }
    return { offset: this.#offset };
  }
  /**
  * Save the current scanner position for later restoration.
  *
  * This is an alias for `mark()` with a name that emphasizes backtracking.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('yes', { encoding: 'utf-8' });
  * const snap = scanner.snapshot();
  * scanner.eat();
  * scanner.restore(snap);
  * ```
  */
  snapshot(): ScannerSnapshot {
    return this.mark();
  }
  /**
  * Restore the scanner to a previous snapshot.
  *
  * If the snapshot contains line and column metadata, text position tracking is
  * restored too. Otherwise line/column getters remain invalid until another
  * text-synchronized snapshot is restored.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8' });
  * const snap = scanner.snapshot();
  * scanner.eat(2);
  * scanner.restore(snap);
  * scanner.peek(); // 'a'
  * ```
  */
  restore(s: ScannerSnapshot): void {
    this.#offset = s.offset;
    if (s.line !== undefined && s.column !== undefined) {
      this.#line = s.line;
      this.#col = s.column;
      this.#lineColValid = true;
    } else {
      this.#lineColValid = false;
    }
  }
  // ERROR
  /**
  * Create a `ParseError` at the current position or an explicit span.
  *
  * The error message includes the scanner's format and either line/column or
  * byte offset. Passing a `{ from, to }` span sets the diagnostic highlight
  * length. The method does not throw; callers usually `throw scanner.error(...)`.
  *
  * ```ts no_run
  * import { Scanner } from 'fino:parsing/scanner';
  *
  * const scanner = new Scanner('abc', { encoding: 'utf-8', format: 'demo' });
  * const from = scanner.mark();
  * scanner.eat(2);
  * throw scanner.error('expected digit', { from, to: scanner.mark() });
  * ```
  */
  error(detail: string, span?: ScannerMark | {
    from: ScannerMark;
    to: ScannerMark;
  }): ParseError {
    const at: ScannerMark = span === undefined ? this.mark() : 'from' in span ? span.from : span;
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
      source: this.#buf
    });
  }
  // PRIVATE
  /**
  * Private method `#requireText` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #requireText() {
  *     return 'requireText';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#requireText();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #requireText(op: string): void {
    if (this.#encoding === null) throw new Error(`Scanner.${op}: text ops require encoding`);
  }
  /**
  * Private method `#readNum` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #readNum() {
  *     return 'readNum';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#readNum();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #readNum(byteLen: number, float: boolean, le: boolean, signed: boolean, big: boolean): number | bigint {
    if (this.#offset + byteLen > this.#buf.length) throw this.error(`unexpected end of input (need ${byteLen} bytes, got ${this.#buf.length - this.#offset})`);
    const o = this.#offset;
    this.#offset += byteLen;
    if (this.#encoding !== null) this.#lineColValid = false;
    const v = this.#view;
    if (float) return byteLen === 4 ? v.getFloat32(o, le) : v.getFloat64(o, le);
    if (big) return signed ? v.getBigInt64(o, le) : v.getBigUint64(o, le);
    if (byteLen === 1) return signed ? v.getInt8(o) : v.getUint8(o);
    if (byteLen === 2) return signed ? v.getInt16(o, le) : v.getUint16(o, le);
    return signed ? v.getInt32(o, le) : v.getUint32(o, le);
  }
  /**
  * Private method `#readField` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #readField() {
  *     return 'readField';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#readField();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #readField(name: string, byteLen: number, fn: () => number | bigint): number | bigint {
    if (this.#offset + byteLen > this.#buf.length) {
      throw this.error(`unexpected end of input while reading ${name} (need ${byteLen} bytes, got ${this.#buf.length - this.#offset})`);
    }
    return fn();
  }
  /**
  * Private method `#peekCpAt` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #peekCpAt() {
  *     return 'peekCpAt';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#peekCpAt();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #peekCpAt(offset: number): [number, number] {
    if (offset >= this.#buf.length) return [-1, 0];
    const enc = this.#encoding;
    if (enc === 'utf-16le' || enc === 'utf-16be') {
      if (offset + 1 >= this.#buf.length) return [-1, 0];
      const le = enc === 'utf-16le';
      const w0 = this.#view.getUint16(offset, le);
      if (w0 >= 55296 && w0 <= 56319 && offset + 3 < this.#buf.length) {
        const w1 = this.#view.getUint16(offset + 2, le);
        if (w1 >= 56320 && w1 <= 57343) return [65536 + (w0 - 55296 << 10) + (w1 - 56320), 4];
      }
      return [w0, 2];
    }
    const b = this.#buf[offset]!;
    if (enc === 'ascii' || enc === 'latin1') return [b, 1];
    // UTF-8 decode
    if (b < 128) return [b, 1];
    if ((b & 224) === 192 && offset + 1 < this.#buf.length) return [(b & 31) << 6 | this.#buf[offset + 1]! & 63, 2];
    if ((b & 240) === 224 && offset + 2 < this.#buf.length) return [(b & 15) << 12 | (this.#buf[offset + 1]! & 63) << 6 | this.#buf[offset + 2]! & 63, 3];
    if ((b & 248) === 240 && offset + 3 < this.#buf.length) return [(b & 7) << 18 | (this.#buf[offset + 1]! & 63) << 12 | (this.#buf[offset + 2]! & 63) << 6 | this.#buf[offset + 3]! & 63, 4];
    return [65533, 1];
  }
  /**
  * Private method `#advanceText` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #advanceText() {
  *     return 'advanceText';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#advanceText();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #advanceText(cp: number, bw: number): void {
    this.#offset += bw;
    if (cp === 10) {
      this.#line++;
      this.#col = 1;
    } else {
      this.#col++;
    }
  }
  /**
  * Private method `#matchAndAdvance` used by `Scanner`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #matchAndAdvance() {
  *     return 'matchAndAdvance';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#matchAndAdvance();
  *   }
  * }
  * ```
  *
  * @internal
  */
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
// Module-level helpers
function _encodeForMatch(s: string, encoding: Encoding): Uint8Array {
  if (encoding === 'utf-8' || encoding === 'ascii') return encodeUtf8(s);
  if (encoding === 'latin1') {
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 255;
    return buf;
  }
  // utf-16le / utf-16be
  const le = encoding === 'utf-16le';
  const buf = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (le) {
      buf[i * 2] = c & 255;
      buf[i * 2 + 1] = c >> 8 & 255;
    } else {
      buf[i * 2] = c >> 8 & 255;
      buf[i * 2 + 1] = c & 255;
    }
  }
  return buf;
}
function _decodeBytes(bytes: Uint8Array, encoding: Encoding): string {
  if (encoding === 'utf-8') return decodeUtf8(bytes, false, false);
  if (encoding === 'ascii' || encoding === 'latin1') {
    if (bytes.length === 0) return '';
    if (bytes.length <= 65536) return String.fromCharCode.apply(null, (bytes as unknown) as number[]);
    let s = '';
    for (let i = 0; i < bytes.length; i += 65536) s += String.fromCharCode.apply(null, (bytes.subarray(i, i + 65536) as unknown) as number[]);
    return s;
  }
  // utf-16le / utf-16be
  const le = encoding === 'utf-16le';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(dv.getUint16(i, le));
  return s;
}
function _trimAscii(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const c = value.charCodeAt(start);
    if (c !== 32 && c !== 9) break;
    start++;
  }
  while (end > start) {
    const c = value.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return value.slice(start, end);
}
function _isProtocolTokenCode(code: number): boolean {
  return code > 32 && code < 127 && code !== 44 && code !== 58 && code !== 59;
}
function _textSnippet(source: Uint8Array, offset: number, line: number, column: number, length: number, filename: string | undefined, format: string, detail: string, color: boolean, contextLines: number): string {
  const RESET = color ? '\x1B[0m' : '';
  const RED = color ? '\x1B[31m' : '';
  const CYAN = color ? '\x1B[36m' : '';
  const src = decodeUtf8(source, false, false);
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
  let displayCol = column - 1;
  if (errLine.length > MAX_LINE) {
    const half = Math.floor(MAX_LINE / 2);
    const start = Math.max(0, displayCol - half);
    const pre = start > 0 ? '…' : '';
    const suf = start + MAX_LINE < errLine.length ? '…' : '';
    displayLine = pre + errLine.slice(start, start + MAX_LINE) + suf;
    displayCol = displayCol - start + (pre ? 1 : 0);
  }
  out += `${RED}${lineGutter(line)}${RESET} | ${displayLine}\n`;
  const caretLen = Math.max(1, Math.min(length, errLine.length - (column - 1)));
  const caret = '^' + '~'.repeat(caretLen - 1);
  out += `${emptyG}| ${' '.repeat(displayCol)}${RED}${caret}${RESET} ${detail}\n`;
  for (let i = line; i < Math.min(lines.length, line + contextLines); i++) {
    out += `${lineGutter(i + 1)} | ${lines[i] ?? ''}\n`;
  }
  return out;
}
function _binaryDump(source: Uint8Array, offset: number, length: number, filename: string | undefined, format: string, detail: string, color: boolean): string {
  const RESET = color ? '\x1B[0m' : '';
  const RED = color ? '\x1B[31m' : '';
  const CYAN = color ? '\x1B[36m' : '';
  const loc = filename ? `${filename} offset 0x${offset.toString(16).padStart(4, '0')} (${offset})` : `0x${offset.toString(16).padStart(4, '0')} (${offset})`;
  let out = `${RED}${format} parse error${RESET} at ${CYAN}${loc}${RESET}\n`;
  // Show 1-2 rows of 16 bytes centered on the error offset
  const rowStart = Math.max(0, Math.floor(offset / 16) - 1) * 16;
  const rowEnd = Math.min(source.length, rowStart + 32);
  for (let row = rowStart; row < rowEnd; row += 16) {
    const rowAddr = row.toString(16).padStart(8, '0');
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      const byteOffset = row + i;
      if (i === 8) hex += ' ';
      if (byteOffset < source.length) {
        const b = source[byteOffset]!;
        hex += b.toString(16).padStart(2, '0') + ' ';
        ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
      } else {
        hex += '   ';
        ascii += ' ';
      }
    }
    out += `  ${rowAddr}  ${hex} ${ascii}\n`;
    // Arrow row under the failing byte(s)
    if (offset >= row && offset < row + 16) {
      const col = offset - row;
      const hexCol = col * 3 + (col >= 8 ? 1 : 0);
      const len = Math.min(length, row + 16 - offset);
      const arrowStr = '^^'.repeat(len).slice(0, len * 3 - 1).replace(/ /g, '^');
      out += `  ${' '.repeat(10)}${' '.repeat(hexCol)}${RED}${'^'.repeat(len > 1 ? len * 3 - 1 : 2)}${RESET}\n`;
    }
  }
  out += `  ${detail}\n`;
  return out;
}
