# scanner

fino:parsing/scanner — General-purpose scanning infrastructure for binary and text formats.

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

## ScannerOptions

```ts
interface ScannerOptions {
```

Options controlling scanner text decoding and error labels.

### encoding

```ts
encoding?: Encoding
```

### format

```ts
format?: string
```

### filename

```ts
filename?: string
```

## ScannerMark

```ts
interface ScannerMark {
```

Saved scanner position, including line/column when text tracking is active.

### offset

```ts
readonly offset: number
```

### line

```ts
readonly line?: number
```

### column

```ts
readonly column?: number
```

## ScannerSnapshot

```ts
type ScannerSnapshot = ScannerMark
```

Alias for a saved scanner position.

## ParseError

```ts
class ParseError extends Error {
```

Parse error with source location and renderable text or binary context.

### format

```ts
readonly format: string
```

### filename

```ts
readonly filename: string | undefined
```

### offset

```ts
readonly offset: number
```

### line

```ts
readonly line: number | undefined
```

### column

```ts
readonly column: number | undefined
```

### length

```ts
readonly length: number
```

### constructor

```ts
constructor( message: string, opts: { detail: string; format: string; filename?: string; offset: number; line?: number; column?: number; length?: number; source: Uint8Array; }, )
```

### render

```ts
render(options?: { color?: boolean; contextLines?: number }): string
```

## Scanner

```ts
class Scanner {
```

Cursor-based scanner for mixed binary and text parsers.

### constructor

```ts
constructor(source: string | Uint8Array, options?: ScannerOptions)
```

### offset

```ts
get offset(): number
```

### done

```ts
get done(): boolean
```

### encoding

```ts
get encoding(): Encoding | null
```

### remainingBytes

```ts
get remainingBytes(): number
```

### line

```ts
get line(): number
```

### column

```ts
get column(): number
```

### peekByte

```ts
peekByte(at: number = 0): number
```

### eatByte

```ts
eatByte(): number
```

### eatBytes

```ts
eatBytes(n: number): Uint8Array
```

### matchBytes

```ts
matchBytes(b: Uint8Array | readonly number[]): boolean
```

### eatUntilByte

```ts
eatUntilByte(c: number, max?: number): Uint8Array
```

### bytesSlice

```ts
bytesSlice(from: ScannerMark, to?: ScannerMark): Uint8Array
```

### readU8

```ts
readU8(): number
```

### readI8

```ts
readI8(): number
```

### readU16BE

```ts
readU16BE(): number
```

### readU16LE

```ts
readU16LE(): number
```

### readI16BE

```ts
readI16BE(): number
```

### readI16LE

```ts
readI16LE(): number
```

### readU32BE

```ts
readU32BE(): number
```

### readU32LE

```ts
readU32LE(): number
```

### readI32BE

```ts
readI32BE(): number
```

### readI32LE

```ts
readI32LE(): number
```

### readF32BE

```ts
readF32BE(): number
```

### readF32LE

```ts
readF32LE(): number
```

### readF64BE

```ts
readF64BE(): number
```

### readF64LE

```ts
readF64LE(): number
```

### readU64BE

```ts
readU64BE(): bigint
```

### readU64LE

```ts
readU64LE(): bigint
```

### readI64BE

```ts
readI64BE(): bigint
```

### readI64LE

```ts
readI64LE(): bigint
```

### readU16BEField

```ts
readU16BEField(name: string): number
```

### readU32BEField

```ts
readU32BEField(name: string): number
```

### eatText

```ts
eatText(byteLength: number, encoding?: Encoding): string
```

### peek

```ts
peek(n: number = 1): string
```

### peekCode

```ts
peekCode(n: number = 0): number
```

### eat

```ts
eat(n: number = 1): string
```

### eatChar

```ts
eatChar(s: string): boolean
```

### match

```ts
match(s: string): boolean
```

### eatWhile

```ts
eatWhile(pred: (code: number) => boolean): string
```

### eatUntil

```ts
eatUntil(pred: (code: number) => boolean): string
```

### expect

```ts
expect(s: string, message?: string): void
```

### skipSpaceTab

```ts
skipSpaceTab(): void
```

### skipWhitespace

```ts
skipWhitespace(): void
```

### text

```ts
text(from: ScannerMark, to?: ScannerMark): string
```

### readLineCRLF

```ts
readLineCRLF(): string
```

### readHeaderBlock

```ts
readHeaderBlock(): string[]
```

### readAsciiSpanUntilByte

```ts
readAsciiSpanUntilByte(delimiter: number, consumeDelimiter: boolean = false): Uint8Array
```

### readDelimitedList

```ts
readDelimitedList(delimiter: string): string[]
```

### readToken

```ts
readToken(name: string = 'token'): string
```

### expectToken

```ts
expectToken(expected: string, options?: { caseInsensitive?: boolean; name?: string }): void
```

### readStrictInt

```ts
readStrictInt(options?: { radix?: 10 | 16; name?: string; min?: number; max?: number; allowSign?: boolean; }): number
```

### subScanner

```ts
subScanner(byteLength: number, options?: ScannerOptions): Scanner
```

### jump

```ts
jump(offset: number): void
```

### mark

```ts
mark(): ScannerMark
```

### snapshot

```ts
snapshot(): ScannerSnapshot
```

### restore

```ts
restore(s: ScannerSnapshot): void
```

### error

```ts
error(detail: string, span?: ScannerMark | { from: ScannerMark; to: ScannerMark }): ParseError
```
