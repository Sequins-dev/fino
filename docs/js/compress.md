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

## CompressOptions

```ts
type CompressOptions = InternalCompressOptions
```

Options for one-shot and streaming compression.

`format` selects the wire format to produce and is required for all public
compression helpers. `level` is optional and backend-dependent: zlib formats
use the usual compression level range, while Brotli support depends on the
runtime Brotli backend being available. Invalid options throw `TypeError`
before native compression is attempted.

```ts
import { compress, type CompressOptions } from 'fino:compress';

const options: CompressOptions = { format: 'gzip', level: 6 };
const output = compress(new TextEncoder().encode('hello'), options);
console.log(output.byteLength);
```

## brotliAvailable

```ts
const brotliAvailable
```

`true` when the Brotli encoder and decoder backend libraries are available.

Use this before selecting `{ format: 'brotli' }` in portable code. When this
value is false, Brotli operations throw from the underlying backend.

```ts
import { brotliAvailable, compress } from 'fino:compress';

const format = brotliAvailable ? 'brotli' : 'gzip';
const bytes = compress(new Uint8Array([1, 2, 3]), { format });
console.log(bytes.byteLength);
```

## compress

```ts
function compress(data: ByteInput, options: CompressOptions): Uint8Array
```

Compress one byte buffer and return a single compressed byte array.

This one-shot helper keeps both input and output in memory. `options.format`
is required, and invalid options throw `TypeError`. Backend compression
failures propagate as errors.

```ts
import { compress } from 'fino:compress';

const input = new TextEncoder().encode('hello');
const gzipped = compress(input, { format: 'gzip', level: 6 });
console.log(gzipped.byteLength);
```

## decompress

```ts
function decompress(data: ByteInput, options: DecompressOptions): Uint8Array
```

Decompress one byte buffer and return a single decompressed byte array.

The input format must match `options.format`. The helper keeps the full
decompressed output in memory and throws when the stream is invalid,
truncated, or uses a format that is unavailable.

```ts
import { compress, decompress } from 'fino:compress';

const packed = compress(new Uint8Array([1, 2, 3]), { format: 'deflate' });
const plain = decompress(packed, { format: 'deflate' });
console.log(plain.length);
```

## Compressor

```ts
class Compressor implements CompressionTransform {
```

Stateful compressor for chunked writes or async iterable transforms.

A compressor may buffer internally and return zero or more output chunks for
each `write()`. Always call `finish()` to flush final bytes. Call `close()`
when abandoning the stream early.

```ts
import { Compressor } from 'fino:compress';

const compressor = new Compressor({ format: 'gzip' });
const chunks = [
  ...compressor.write(new Uint8Array([1, 2])),
  ...compressor.finish(),
];
compressor.close();
console.log(chunks.length);
```

### constructor

```ts
constructor(options: CompressOptions)
```

Create a compressor for the requested format.

Invalid options throw `TypeError`. Brotli construction requires the Brotli
backend to be available. The created compressor owns native state until
`finish()` or `close()` is called.

```ts
import { Compressor } from 'fino:compress';

const compressor = new Compressor({ format: 'deflate-raw' });
compressor.close();
```

### write

```ts
write(chunk: ByteInput): Uint8Array[]
```

Compress a chunk and return any output currently available.

The returned array may be empty when the backend buffers data. Do not treat
an empty array as EOF; call `finish()` when no more input remains.

```ts
import { Compressor } from 'fino:compress';

const compressor = new Compressor({ format: 'gzip' });
const chunks = compressor.write(new Uint8Array([1, 2, 3]));
chunks.push(...compressor.finish());
compressor.close();
```

### finish

```ts
finish(): Uint8Array[]
```

Finish the compression stream and return final output chunks.

Call this exactly once after all writes. It flushes backend state and may
return zero or more chunks. Writing after finish is backend-dependent and
should be avoided; create a new compressor for a new stream.

```ts
import { Compressor } from 'fino:compress';

const compressor = new Compressor({ format: 'deflate' });
const finalChunks = compressor.finish();
compressor.close();
console.log(finalChunks.length);
```

### transform

```ts
transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>
```

Transform an async iterable of byte chunks into compressed chunks.

Output chunks are yielded as the backend produces them, followed by final
flush chunks. Errors from the source iterable or compression backend
propagate through iteration.

```ts
import { Compressor } from 'fino:compress';

async function* source() {
  yield new Uint8Array([1, 2, 3]);
}
const compressor = new Compressor({ format: 'gzip' });
for await (const chunk of compressor.transform(source())) {
  console.log(chunk.byteLength);
}
compressor.close();
```

### close

```ts
close(): void
```

Release native compression state.

Use `close()` when abandoning a compressor before `finish()`, or after
consuming a transformed stream. Repeated calls are delegated to the backend.

```ts
import { Compressor } from 'fino:compress';

const compressor = new Compressor({ format: 'gzip' });
compressor.close();
```

## Decompressor

```ts
class Decompressor implements CompressionTransform {
```

Stateful decompressor for chunked writes or async iterable transforms.

A decompressor may buffer partial frames internally. Always call `finish()`
after the last compressed chunk so truncated streams are detected and final
output is flushed.

```ts
import { Decompressor, compress } from 'fino:compress';

const packed = compress(new Uint8Array([1, 2]), { format: 'gzip' });
const decompressor = new Decompressor({ format: 'gzip' });
const chunks = [...decompressor.write(packed), ...decompressor.finish()];
decompressor.close();
console.log(chunks.length);
```

### constructor

```ts
constructor(options: DecompressOptions)
```

Create a decompressor for the requested format.

`options.format` must match the compressed stream. Invalid options throw
`TypeError`; unavailable Brotli support throws from the Brotli backend.

```ts
import { Decompressor } from 'fino:compress';

const decompressor = new Decompressor({ format: 'deflate' });
decompressor.close();
```

### write

```ts
write(chunk: ByteInput): Uint8Array[]
```

Decompress a chunk and return any output currently available.

The returned array may be empty while the backend waits for more input.
Invalid or mismatched compressed data throws.

```ts
import { Decompressor, compress } from 'fino:compress';

const packed = compress(new Uint8Array([1]), { format: 'gzip' });
const decompressor = new Decompressor({ format: 'gzip' });
const chunks = decompressor.write(packed);
chunks.push(...decompressor.finish());
decompressor.close();
```

### finish

```ts
finish(): Uint8Array[]
```

Finish the decompression stream and return final output chunks.

This checks for a complete compressed stream and flushes pending output.
Truncated data or malformed trailing state throws.

```ts
import { Decompressor } from 'fino:compress';

const decompressor = new Decompressor({ format: 'gzip' });
const finalChunks = decompressor.finish();
decompressor.close();
console.log(finalChunks.length);
```

### transform

```ts
transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>
```

Transform an async iterable of compressed chunks into decompressed chunks.

The returned iterable yields output as it becomes available and validates
the end of stream when the source completes. Source and backend errors
propagate through iteration.

```ts
import { Decompressor } from 'fino:compress';

async function* compressedChunks() {
  yield new Uint8Array();
}
const decompressor = new Decompressor({ format: 'gzip' });
for await (const chunk of decompressor.transform(compressedChunks())) {
  console.log(chunk.byteLength);
}
decompressor.close();
```

### close

```ts
close(): void
```

Release native decompression state.

Call this when abandoning a stream early or after a transform has finished.
Repeated calls are delegated to the backend.

```ts
import { Decompressor } from 'fino:compress';

const decompressor = new Decompressor({ format: 'deflate-raw' });
decompressor.close();
```

## createCompressor

```ts
function createCompressor(options: CompressOptions): Compressor
```

Create a stateful compressor for the requested format.

This is a factory wrapper around `new Compressor(options)`. It returns an
object that must be finished or closed to release backend state.

```ts
import { createCompressor } from 'fino:compress';

const compressor = createCompressor({ format: 'gzip' });
compressor.close();
```

## createDecompressor

```ts
function createDecompressor(options: DecompressOptions): Decompressor
```

Create a stateful decompressor for the requested format.

This is a factory wrapper around `new Decompressor(options)`. The selected
format must match the stream that will be written.

```ts
import { createDecompressor } from 'fino:compress';

const decompressor = createDecompressor({ format: 'gzip' });
decompressor.close();
```
