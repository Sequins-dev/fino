/**
 * Benchmarks for fino:compress
 *
 * Run with: cargo run -- bench benchmarks/compress.bench.ts
 */
import {
  compress,
  decompress,
  createCompressor,
  createDecompressor,
  brotliAvailable,
} from 'fino:compress';
import { bench } from 'fino:bench';
const payload = new TextEncoder().encode('hello '.repeat(128));
const formats = brotliAvailable
  ? (['gzip', 'deflate', 'deflate-raw', 'brotli'] as const)
  : (['gzip', 'deflate', 'deflate-raw'] as const);
const compressedByFormat = new Map(
  formats.map((format) => [format, compress(payload, { format })]),
);
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
bench('compress', (b) => {
  for (const format of formats) {
    const compressed = compressedByFormat.get(format)!;
    b.measure(`${format} compress`, () => compress(payload, { format }));
    b.measure(`${format} decompress`, () => decompress(compressed, { format }));
    b.measure(`${format} stream compress`, () => {
      const compressor = createCompressor({ format });
      return concat([
        ...compressor.write(payload.slice(0, payload.byteLength / 2)),
        ...compressor.write(payload.slice(payload.byteLength / 2)),
        ...compressor.finish(),
      ]);
    });
    b.measure(`${format} stream decompress`, () => {
      const decompressor = createDecompressor({ format });
      return concat([
        ...decompressor.write(compressed.slice(0, compressed.byteLength / 2)),
        ...decompressor.write(compressed.slice(compressed.byteLength / 2)),
        ...decompressor.finish(),
      ]);
    });
  }
});
