# scanner

fino:parsing/scanner - General-purpose scanning infrastructure for binary and text formats.

Supports binary buffer scanning (always), text scanning (opt-in via encoding), and
mixed binary/text parsing (common in real protocols: HTTP/1 ASCII headers + binary body,
HPACK varint prefixes + UTF-8 strings, ZIP central directory + UTF-8 names).

```ts
// Binary protocol
import { Scanner } from 'fino:parsing/scanner';
const s = new Scanner(buffer);
const version = s.readU8();
const length  = s.readU32BE();
const payload = s.eatBytes(length);
```

```ts
// Text format
import { Scanner, ParseError } from 'fino:parsing/scanner';
class MyError extends ParseError { name = 'MyError'; }
const s = new Scanner(source, { encoding: 'utf-8', format: 'myformat' });
while (!s.done) {
  const tok = s.eatWhile(code => code !== 0x3B); // eat until ';'
  if (!s.done) s.expect(';');
}
```

## Encoding

```ts
type Encoding = 'utf-8' | 'ascii' | 'latin1' | 'utf-16le' | 'utf-16be'
```

Text encodings supported by scanner text operations.

A scanner created from bytes has no text encoding unless one is supplied.
Text operations such as `peek()`, `eat()`, and `text()` require one of these
encodings.

```ts
import { Scanner, type Encoding } from 'fino:parsing/scanner';

const encoding: Encoding = 'utf-8';
const scanner = new Scanner(new Uint8Array([0x41]), { encoding });
scanner.eat(); // 'A'
```

## ScannerOptions

```ts
interface ScannerOptions {
```

Options controlling scanner text decoding and error labels.

`encoding` enables text operations for byte input. `format` and `filename`
are used in parse errors and rendered diagnostics.

```ts
import { Scanner, type ScannerOptions } from 'fino:parsing/scanner';

const options: ScannerOptions = { encoding: 'utf-8', format: 'json', filename: 'data.json' };
const scanner = new Scanner('{"ok":true}', options);
```

### encoding

```ts
encoding?: Encoding
```

Text encoding used by scanner text operations.

Defaults to `'utf-8'` for string input and `null` for byte input. Without an
encoding, text operations throw and binary operations remain available.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0x68, 0x69]), { encoding: 'ascii' }).eat(2);
```

### format

```ts
format?: string
```

Human-readable format label used in parse errors.

Defaults to `'parse'`. Use a format name such as `'csv'` or `'xml'` to make
diagnostics clear for callers.

```ts
import { Scanner } from 'fino:parsing/scanner';

const error = new Scanner('', { format: 'demo' }).error('missing input');
error.format; // 'demo'
```

### filename

```ts
filename?: string
```

Optional source filename used in rendered diagnostics.

The scanner does not read this file; the value is diagnostic metadata only.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('x', { encoding: 'utf-8', filename: 'input.txt' });
scanner.error('bad token').filename;
```

## ScannerMark

```ts
interface ScannerMark {
```

Saved scanner position, including line and column when text tracking is active.

Marks can be passed to `text()`, `bytesSlice()`, `restore()`, or `error()` to
recover spans and render diagnostics. Byte operations after text scanning can
invalidate line/column tracking; marks captured before that still preserve
their own location metadata.

```ts
import { Scanner, type ScannerMark } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
const mark: ScannerMark = scanner.mark();
scanner.eat(2);
scanner.text(mark); // 'ab'
```

### offset

```ts
readonly offset: number
```

Byte offset from the start of the scanner buffer.

The offset is zero-based and is always present, even for pure binary
scanners.

```ts
import { Scanner } from 'fino:parsing/scanner';

const mark = new Scanner('abc', { encoding: 'utf-8' }).mark();
mark.offset;
```

### line

```ts
readonly line?: number
```

One-based line number, when text position tracking is available.

The property is omitted for binary scanners or after byte operations have
invalidated text tracking.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('a\nb', { encoding: 'utf-8' });
scanner.eat(2);
scanner.mark().line;
```

### column

```ts
readonly column?: number
```

One-based column number, when text position tracking is available.

The property is omitted under the same conditions as `line`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
scanner.eat();
scanner.mark().column;
```

## ScannerSnapshot

```ts
type ScannerSnapshot = ScannerMark
```

Alias for a saved scanner position.

Snapshots are created with `snapshot()` and restored with `restore()`. They
have the same shape as `ScannerMark`.

```ts
import { Scanner, type ScannerSnapshot } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
const snapshot: ScannerSnapshot = scanner.snapshot();
scanner.eat();
scanner.restore(snapshot);
```

## ParseError

```ts
class ParseError extends Error {
```

Parse error with source location and renderable text or binary context.

Format-specific parsers can subclass this error and use `Scanner.error()` to
create instances with consistent offsets, optional line/column data, and
source snippets. `render()` returns either a text caret snippet or a binary
hex dump depending on available location metadata.

```ts
import { ParseError, Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('bad', { encoding: 'utf-8', format: 'demo' });
const error: ParseError = scanner.error('unexpected token');
console.log(error.render());
```

### format

```ts
readonly format: string
```

Parser format label, such as `'csv'`, `'xml'`, or `'parse'`.

This is copied from `ScannerOptions.format` or the explicit constructor
options and appears in rendered diagnostics.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner('', { format: 'demo' }).error('missing').format;
```

### filename

```ts
readonly filename: string | undefined
```

Optional filename associated with the source.

The filename is diagnostic metadata and may be `undefined`.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner('x', { encoding: 'utf-8', filename: 'input.txt' }).error('bad').filename;
```

### offset

```ts
readonly offset: number
```

Byte offset where the error starts.

Offsets are zero-based and apply to the scanner's internal byte buffer.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
scanner.eat();
scanner.error('bad').offset;
```

### line

```ts
readonly line: number | undefined
```

One-based line number for text errors.

The value is `undefined` when no text position is available, for example on
binary-only scanners.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner('a\nb', { encoding: 'utf-8' }).error('bad').line;
```

### column

```ts
readonly column: number | undefined
```

One-based column number for text errors.

The value is `undefined` when no text position is available.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner('abc', { encoding: 'utf-8' }).error('bad').column;
```

### length

```ts
readonly length: number
```

Highlight length in bytes or text columns, depending on diagnostic mode.

Defaults to `1` when no explicit span is supplied.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
const from = scanner.mark();
scanner.eat(2);
scanner.error('bad span', { from, to: scanner.mark() }).length;
```

### constructor

```ts
constructor(message: string, opts: {
  detail: string;
  format: string;
  filename?: string;
  offset: number;
  line?: number;
  column?: number;
  length?: number;
  source: Uint8Array;
})
```

Create a parse error with explicit source and location metadata.

Most parsers should call `Scanner.error()` instead so offsets and line
tracking are filled from the current scanner state. Construct directly when
adapting diagnostics from another parser.

```ts
import { ParseError } from 'fino:parsing/scanner';

const error = new ParseError('demo: bad at offset 0', {
  detail: 'bad',
  format: 'demo',
  offset: 0,
  source: new Uint8Array([0x62, 0x61, 0x64]),
});
```

### render

```ts
render(options?: {
  color?: boolean;
  contextLines?: number;
}): string
```

Render a diagnostic snippet for humans.

Text errors render line context and a caret. Binary errors render a small
hex dump around the failing byte. `color` defaults to `false` and
`contextLines` defaults to `0`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const error = new Scanner('a\nb', { encoding: 'utf-8' }).error('bad');
console.log(error.render({ contextLines: 1 }));
```

## Scanner

```ts
class Scanner {
```

Cursor-based scanner for mixed binary and text parsers.

The scanner owns a byte buffer and advances a cursor through binary and
text-oriented operations. Text operations require an encoding. Byte
operations can invalidate line/column tracking; use `mark()` or `snapshot()`
before switching modes when you need to restore text positions.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('name:value\r\n', { encoding: 'utf-8', format: 'header' });
const name = scanner.readToken('header name');
scanner.expect(':');
const value = scanner.eatUntil((code) => code === 0x0D);
```

### constructor

```ts
constructor(source: string | Uint8Array, options?: ScannerOptions)
```

Create a scanner over string or byte input.

String input is encoded as UTF-8 and defaults to UTF-8 text mode. Byte
input defaults to binary mode unless `options.encoding` is provided.

```ts
import { Scanner } from 'fino:parsing/scanner';

const textScanner = new Scanner('abc', { encoding: 'utf-8' });
const binaryScanner = new Scanner(new Uint8Array([1, 2, 3]));
```

### offset

```ts
get offset(): number
```

Current byte offset from the start of the scanner buffer.

The value advances as text or byte operations consume input.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
scanner.eat();
scanner.offset; // 1
```

### done

```ts
get done(): boolean
```

Whether the scanner cursor is at or past the end of input.

Use this to drive parser loops without peeking past the buffer.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('a', { encoding: 'utf-8' });
scanner.eat();
scanner.done; // true
```

### encoding

```ts
get encoding(): Encoding | null
```

Active text encoding, or `null` for binary-only scanning.

Text operations throw when this value is `null`.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0x61])).encoding; // null
```

### remainingBytes

```ts
get remainingBytes(): number
```

Number of unread bytes remaining in the buffer.

This is byte-oriented even when text scanning is active.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([1, 2, 3]));
scanner.eatByte();
scanner.remainingBytes; // 2
```

### line

```ts
get line(): number
```

Current one-based line number for text scanning.

Throws if no encoding is active or if byte operations invalidated text
position tracking. Restore a text snapshot to resynchronize.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('a\nb', { encoding: 'utf-8' });
scanner.eat(2);
scanner.line; // 2
```

### column

```ts
get column(): number
```

Current one-based column number for text scanning.

Throws under the same conditions as `line`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
scanner.eat();
scanner.column; // 2
```

### peekByte

```ts
peekByte(at: number = 0): number
```

Return a byte at the current cursor plus an optional offset without advancing.

Returns `-1` when the requested position is beyond the end of input.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([0x41]));
scanner.peekByte(); // 0x41
```

### eatByte

```ts
eatByte(): number
```

Consume and return one byte.

Throws `ParseError` at end of input. When text mode is active, this byte
operation invalidates line and column tracking.

```ts
import { Scanner } from 'fino:parsing/scanner';

const byte = new Scanner(new Uint8Array([1, 2])).eatByte();
```

### eatBytes

```ts
eatBytes(n: number): Uint8Array
```

Consume `n` bytes and return a view into the scanner buffer.

Throws `ParseError` if fewer than `n` bytes remain. The returned
`Uint8Array` is a subarray view, not a defensive copy.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([1, 2, 3]));
scanner.eatBytes(2); // Uint8Array [1, 2]
```

### matchBytes

```ts
matchBytes(b: Uint8Array | readonly number[]): boolean
```

Match and consume an exact byte sequence.

Returns `true` and advances when all bytes match. Returns `false` and leaves
the cursor unchanged when the sequence does not match or is incomplete.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([0x50, 0x4b]));
scanner.matchBytes([0x50, 0x4b]); // true
```

### eatUntilByte

```ts
eatUntilByte(c: number, max?: number): Uint8Array
```

Consume bytes until a delimiter byte or optional maximum length is reached.

The delimiter is not consumed. The returned value is a subarray view of the
consumed bytes and may be empty when the cursor already points at the
delimiter.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([1, 2, 0, 3]));
scanner.eatUntilByte(0); // Uint8Array [1, 2]
```

### bytesSlice

```ts
bytesSlice(from: ScannerMark, to?: ScannerMark): Uint8Array
```

Return a byte slice between two marks or from a mark to the current cursor.

The result is a subarray view and does not advance the scanner.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([1, 2, 3]));
const from = scanner.mark();
scanner.eatBytes(2);
scanner.bytesSlice(from); // Uint8Array [1, 2]
```

### readU8

```ts
readU8(): number
```

Read an unsigned 8-bit integer and advance by one byte.

Throws `ParseError` if no byte remains.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([255])).readU8();
```

### readI8

```ts
readI8(): number
```

Read a signed 8-bit integer and advance by one byte.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([255])).readI8(); // -1
```

### readU16BE

```ts
readU16BE(): number
```

Read an unsigned big-endian 16-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0x01, 0x00])).readU16BE(); // 256
```

### readU16LE

```ts
readU16LE(): number
```

Read an unsigned little-endian 16-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0x00, 0x01])).readU16LE(); // 256
```

### readI16BE

```ts
readI16BE(): number
```

Read a signed big-endian 16-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0xff, 0xff])).readI16BE(); // -1
```

### readI16LE

```ts
readI16LE(): number
```

Read a signed little-endian 16-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0xff, 0xff])).readI16LE(); // -1
```

### readU32BE

```ts
readU32BE(): number
```

Read an unsigned big-endian 32-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0, 0, 0, 1])).readU32BE();
```

### readU32LE

```ts
readU32LE(): number
```

Read an unsigned little-endian 32-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([1, 0, 0, 0])).readU32LE();
```

### readI32BE

```ts
readI32BE(): number
```

Read a signed big-endian 32-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff])).readI32BE();
```

### readI32LE

```ts
readI32LE(): number
```

Read a signed little-endian 32-bit integer.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff])).readI32LE();
```

### readF32BE

```ts
readF32BE(): number
```

Read a big-endian IEEE 754 32-bit float.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0x3f, 0x80, 0, 0])).readF32BE(); // 1
```

### readF32LE

```ts
readF32LE(): number
```

Read a little-endian IEEE 754 32-bit float.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0, 0, 0x80, 0x3f])).readF32LE(); // 1
```

### readF64BE

```ts
readF64BE(): number
```

Read a big-endian IEEE 754 64-bit float.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0x3f, 0xf0, 0, 0, 0, 0, 0, 0])).readF64BE();
```

### readF64LE

```ts
readF64LE(): number
```

Read a little-endian IEEE 754 64-bit float.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0, 0, 0, 0, 0, 0, 0xf0, 0x3f])).readF64LE();
```

### readU64BE

```ts
readU64BE(): bigint
```

Read an unsigned big-endian 64-bit integer as `bigint`.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1])).readU64BE();
```

### readU64LE

```ts
readU64LE(): bigint
```

Read an unsigned little-endian 64-bit integer as `bigint`.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])).readU64LE();
```

### readI64BE

```ts
readI64BE(): bigint
```

Read a signed big-endian 64-bit integer as `bigint`.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).readI64BE();
```

### readI64LE

```ts
readI64LE(): bigint
```

Read a signed little-endian 64-bit integer as `bigint`.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).readI64LE();
```

### readU16BEField

```ts
readU16BEField(name: string): number
```

Read a named unsigned big-endian 16-bit field.

The field name appears in the end-of-input error message when not enough
bytes remain.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0, 10])).readU16BEField('length');
```

### readU32BEField

```ts
readU32BEField(name: string): number
```

Read a named unsigned big-endian 32-bit field.

The field name appears in the end-of-input error message when not enough
bytes remain.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner(new Uint8Array([0, 0, 0, 10])).readU32BEField('size');
```

### eatText

```ts
eatText(byteLength: number, encoding?: Encoding): string
```

Consume a fixed number of bytes and decode them as text.

Uses the supplied encoding, the scanner's active encoding, or UTF-8 by
default. Throws if fewer than `byteLength` bytes remain.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([0x68, 0x69]));
scanner.eatText(2, 'ascii'); // 'hi'
```

### peek

```ts
peek(n: number = 1): string
```

Peek up to `n` Unicode code points without advancing.

Requires text mode. Returns fewer characters near end of input and `""`
when already done.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('hello', { encoding: 'utf-8' });
scanner.peek(2); // 'he'
```

### peekCode

```ts
peekCode(n: number = 0): number
```

Peek a Unicode code point without advancing.

`n` counts code points after the current cursor, not bytes. Returns `-1`
when the requested character is beyond end of input.

```ts
import { Scanner } from 'fino:parsing/scanner';

new Scanner('abc', { encoding: 'utf-8' }).peekCode(); // 0x61
```

### eat

```ts
eat(n: number = 1): string
```

Consume up to `n` Unicode code points and return them as a string.

Requires text mode. The method stops at end of input without throwing.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
scanner.eat(2); // 'ab'
```

### eatChar

```ts
eatChar(s: string): boolean
```

Match and consume an exact text string.

Returns `true` on match and `false` without advancing otherwise. This is an
alias-style helper for single characters or short delimiters.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(':value', { encoding: 'utf-8' });
scanner.eatChar(':'); // true
```

### match

```ts
match(s: string): boolean
```

Match and consume an exact text string.

Returns `true` on match and `false` without advancing otherwise. Use
`expect()` when mismatch should throw.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('true', { encoding: 'utf-8' });
scanner.match('true'); // true
```

### eatWhile

```ts
eatWhile(pred: (code: number) => boolean): string
```

Consume characters while a predicate returns `true`.

The predicate receives Unicode code points. Returns the consumed text and
may return `""` when the first character does not match.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc123', { encoding: 'utf-8' });
scanner.eatWhile((code) => code >= 0x61 && code <= 0x7a); // 'abc'
```

### eatUntil

```ts
eatUntil(pred: (code: number) => boolean): string
```

Consume characters until a predicate returns `true`.

The delimiter character is not consumed. This is equivalent to
`eatWhile(code => !pred(code))`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('name:value', { encoding: 'utf-8' });
scanner.eatUntil((code) => code === 0x3a); // 'name'
```

### expect

```ts
expect(s: string, message?: string): void
```

Require an exact text string and consume it.

Throws `ParseError` with either the supplied message or an automatically
generated expectation message when the text does not match.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('=value', { encoding: 'utf-8' });
scanner.expect('=');
```

### skipSpaceTab

```ts
skipSpaceTab(): void
```

Skip ASCII space and tab characters.

Newlines are not consumed. Requires text mode.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(' \tvalue', { encoding: 'utf-8' });
scanner.skipSpaceTab();
scanner.peek(); // 'v'
```

### skipWhitespace

```ts
skipWhitespace(): void
```

Skip ASCII spaces, tabs, carriage returns, and line feeds.

Requires text mode and updates line/column tracking for skipped newlines.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(' \nvalue', { encoding: 'utf-8' });
scanner.skipWhitespace();
```

### text

```ts
text(from: ScannerMark, to?: ScannerMark): string
```

Decode text between two marks or from a mark to the current cursor.

Requires text mode. The scanner cursor is not changed.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
const from = scanner.mark();
scanner.eat(2);
scanner.text(from); // 'ab'
```

### readLineCRLF

```ts
readLineCRLF(): string
```

Read one CRLF-terminated text line.

The returned line excludes the `\r\n` terminator. Bare LF and missing CRLF
before end of input throw `ParseError`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('first\r\nsecond\r\n', { encoding: 'utf-8' });
scanner.readLineCRLF(); // 'first'
```

### readHeaderBlock

```ts
readHeaderBlock(): string[]
```

Read CRLF-terminated header lines until an empty line.

Returns header lines without terminators and without the final empty line.
Bare LF or unterminated input throws via `readLineCRLF()`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('A: b\r\n\r\n', { encoding: 'utf-8' });
scanner.readHeaderBlock(); // ['A: b']
```

### readAsciiSpanUntilByte

```ts
readAsciiSpanUntilByte(delimiter: number, consumeDelimiter: boolean = false): Uint8Array
```

Read ASCII bytes until a delimiter byte.

Throws if a consumed byte is non-ASCII. The delimiter is consumed only when
`consumeDelimiter` is `true`; otherwise it remains at the cursor.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner(new Uint8Array([0x61, 0x3a, 0x62]));
scanner.readAsciiSpanUntilByte(0x3a, true); // Uint8Array [0x61]
```

### readDelimitedList

```ts
readDelimitedList(delimiter: string): string[]
```

Read the remaining text as a delimiter-separated list.

ASCII spaces and tabs are trimmed around each part, and empty parts are
omitted. Requires text mode and consumes the rest of the input.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('a, b,, c', { encoding: 'utf-8' });
scanner.readDelimitedList(','); // ['a', 'b', 'c']
```

### readToken

```ts
readToken(name: string = 'token'): string
```

Read a protocol-style token.

Tokens are visible ASCII characters excluding comma, colon, semicolon, and
ASCII control/space characters. Throws when no token is present.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('Content-Type: text/plain', { encoding: 'utf-8' });
scanner.readToken('header name'); // 'Content-Type'
```

### expectToken

```ts
expectToken(expected: string, options?: {
  caseInsensitive?: boolean;
  name?: string;
}): void
```

Require a specific protocol token.

Reads one token and throws when it does not match `expected`. Set
`caseInsensitive` for ASCII case-insensitive comparisons.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('GET /', { encoding: 'utf-8' });
scanner.expectToken('get', { caseInsensitive: true, name: 'method' });
```

### readStrictInt

```ts
readStrictInt(options?: {
  radix?: 10 | 16;
  name?: string;
  min?: number;
  max?: number;
  allowSign?: boolean;
}): number
```

Read a strictly formatted decimal or hexadecimal integer token.

Defaults to unsigned base-10. Range checks throw `ParseError` with the
provided field name when the parsed value is outside `min` or `max`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('2a', { encoding: 'utf-8' });
scanner.readStrictInt({ radix: 16, name: 'length', max: 0xff });
```

### subScanner

```ts
subScanner(byteLength: number, options?: ScannerOptions): Scanner
```

Create a new scanner over the next `byteLength` bytes.

The parent scanner advances by `byteLength`. Child options default to the
parent encoding, format, and filename unless overridden.

```ts
import { Scanner } from 'fino:parsing/scanner';

const parent = new Scanner(new Uint8Array([0x61, 0x62]), { encoding: 'ascii' });
const child = parent.subScanner(1);
child.eat(); // 'a'
```

### jump

```ts
jump(offset: number): void
```

Move the cursor to an absolute byte offset.

Offsets must be integers between `0` and the buffer length inclusive.
Jumping in text mode invalidates line/column tracking.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
scanner.jump(2);
scanner.peek(); // 'c'
```

### mark

```ts
mark(): ScannerMark
```

Save the current scanner position.

In text mode, the mark includes line and column when tracking is still
valid. Use marks for span extraction, diagnostics, and manual backtracking.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
const start = scanner.mark();
scanner.eat(3);
scanner.text(start); // 'abc'
```

### snapshot

```ts
snapshot(): ScannerSnapshot
```

Save the current scanner position for later restoration.

This is an alias for `mark()` with a name that emphasizes backtracking.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('yes', { encoding: 'utf-8' });
const snap = scanner.snapshot();
scanner.eat();
scanner.restore(snap);
```

### restore

```ts
restore(s: ScannerSnapshot): void
```

Restore the scanner to a previous snapshot.

If the snapshot contains line and column metadata, text position tracking is
restored too. Otherwise line/column getters remain invalid until another
text-synchronized snapshot is restored.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8' });
const snap = scanner.snapshot();
scanner.eat(2);
scanner.restore(snap);
scanner.peek(); // 'a'
```

### error

```ts
error(detail: string, span?: ScannerMark | {
  from: ScannerMark;
  to: ScannerMark;
}): ParseError
```

Create a `ParseError` at the current position or an explicit span.

The error message includes the scanner's format and either line/column or
byte offset. Passing a `{ from, to }` span sets the diagnostic highlight
length. The method does not throw; callers usually `throw scanner.error(...)`.

```ts
import { Scanner } from 'fino:parsing/scanner';

const scanner = new Scanner('abc', { encoding: 'utf-8', format: 'demo' });
const from = scanner.mark();
scanner.eat(2);
throw scanner.error('expected digit', { from, to: scanner.mark() });
```
