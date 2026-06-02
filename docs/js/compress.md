# compress

fino:compress — one-shot and streaming compression helpers.

This module exposes the compression formats commonly used by HTTP payloads,
archive formats, and data interchange tools: gzip, zlib-wrapped deflate,
raw deflate, and Brotli. The one-shot helpers are convenient when the entire
input already fits in memory. The `Compressor` and `Decompressor` classes
support incremental writes and async iterable transforms for pipelines that
produce or consume chunks over time.

Format names map to the wire formats rather than implementation details:
  - `gzip`: RFC 1952 gzip member format.
  - `deflate`: RFC 1950 zlib wrapper around RFC 1951 DEFLATE data.
  - `deflate-raw`: raw RFC 1951 DEFLATE stream with no wrapper.
  - `brotli`: RFC 7932 Brotli stream when the runtime Brotli backend is
    available.

`compress()` and `decompress()` return a single `Uint8Array`. Streaming
objects return arrays of output chunks from `write()` and `finish()` because
compressors may buffer internally and may produce zero, one, or many chunks
for each input chunk. Always call `finish()` before using the final output,
and call `close()` when abandoning a stream early.

## Examples

```ts
import { compress, decompress } from 'fino:compress';

const encoded = new TextEncoder().encode('hello');
const gzipped = compress(encoded, { format: 'gzip', level: 6 });
const plain = decompress(gzipped, { format: 'gzip' });
```

```ts
import { Compressor } from 'fino:compress';

const compressor = new Compressor({ format: 'deflate' });
const chunks = [
  ...compressor.write(new TextEncoder().encode('part one')),
  ...compressor.write(new TextEncoder().encode('part two')),
  ...compressor.finish(),
];
compressor.close();
```

```ts
import { createDecompressor } from 'fino:compress';

const decoder = createDecompressor({ format: 'brotli' });
for await (const chunk of decoder.transform(compressedChunks)) {
  await output.write(chunk);
}
decoder.close();
```

Useful references:
  - zlib format: https://www.rfc-editor.org/rfc/rfc1950
  - DEFLATE format: https://www.rfc-editor.org/rfc/rfc1951
  - gzip format: https://www.rfc-editor.org/rfc/rfc1952
  - Brotli format: https://www.rfc-editor.org/rfc/rfc7932

## brotliAvailable

```ts
const brotliAvailable
```

`true` when the Brotli encoder and decoder backend libraries are available.

## compress

```ts
function compress(data: ByteInput, options: CompressOptions): Uint8Array
```

Compress one byte buffer and return a single compressed byte array.

## decompress

```ts
function decompress(data: ByteInput, options: DecompressOptions): Uint8Array
```

Decompress one byte buffer and return a single decompressed byte array.

## Compressor

```ts
class Compressor implements CompressionTransform {
```

Stateful compressor for chunked writes or async iterable transforms.

### constructor

```ts
constructor(options: CompressOptions)
```

### write

```ts
write(chunk: ByteInput): Uint8Array[]
```

Compress a chunk and return any output currently available.

### finish

```ts
finish(): Uint8Array[]
```

Finish the stream and return final output chunks.

### transform

```ts
transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>
```

Transform an async iterable of byte chunks into compressed chunks.

### close

```ts
close(): void
```

Release native compression state.

## Decompressor

```ts
class Decompressor implements CompressionTransform {
```

Stateful decompressor for chunked writes or async iterable transforms.

### constructor

```ts
constructor(options: DecompressOptions)
```

### write

```ts
write(chunk: ByteInput): Uint8Array[]
```

Decompress a chunk and return any output currently available.

### finish

```ts
finish(): Uint8Array[]
```

Finish the stream and return final output chunks.

### transform

```ts
transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>
```

Transform an async iterable of compressed chunks into decompressed chunks.

### close

```ts
close(): void
```

Release native decompression state.

## createCompressor

```ts
function createCompressor(options: CompressOptions): Compressor
```

Create a stateful compressor for the requested format.

## createDecompressor

```ts
function createDecompressor(options: DecompressOptions): Decompressor
```

Create a stateful decompressor for the requested format.

## ByteInput

```ts
type ByteInput = Uint8Array | ArrayBuffer
```

Binary input accepted by compression helpers.

## CompressOptions

```ts
interface CompressOptions {
```

Options for one-shot or streaming compression.

### format

```ts
format: CompressionFormat
```

### level

```ts
level?: number
```

## CompressionFormat

```ts
type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli'
```

Compression formats accepted by `fino:compress`.

## DecompressOptions

```ts
interface DecompressOptions {
```

Options for one-shot or streaming decompression.

### format

```ts
format: CompressionFormat
```
