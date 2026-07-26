/**
 * Parquet page compression, dispatched to `fino:compress`.
 *
 * Parquet compresses each page body independently with the codec recorded in
 * the column chunk's metadata (`CompressionCodec` in `parquet.thrift`). This
 * module maps those numeric codec ids — the `Compression` enum from
 * `internal:data/parquet/types` — onto `fino:compress` formats and provides
 * the whole-buffer compress/decompress calls used by the column reader and
 * the writer.
 *
 * Supported codecs: UNCOMPRESSED (pass-through), SNAPPY (raw block — the
 * Parquet default), GZIP, ZSTD, and BROTLI. LZO and the two LZ4 variants are
 * not yet wired: `fino:compress` speaks the LZ4 frame format, while Parquet's
 * LZ4 codecs are raw-block (LZ4_RAW) or the deprecated Hadoop block framing
 * (LZ4). Passing an unwired codec throws `ParquetError`.
 *
 * The SNAPPY, ZSTD, and BROTLI formats rely on system libraries discovered by
 * `fino:compress` (`libsnappy`, `libzstd`, `libbrotli*`). `isCodecSupported`
 * only checks the codec mapping, not library availability — if the backing
 * library is missing, the call into `fino:compress` throws at
 * compress/decompress time.
 *
 * ```ts no_run
 *   import { compressPage, decompressPage } from 'internal:data/parquet/compression';
 *   import { Compression } from 'internal:data/parquet/types';
 *
 *   const body = encodeDataPage(values);
 *   const compressed = compressPage(Compression.SNAPPY, body);
 *   // ... written as a page, later read back:
 *   const restored = decompressPage(Compression.SNAPPY, compressed);
 * ```
 *
 * Codec list: https://github.com/apache/parquet-format/blob/master/Compression.md
 *
 * @internal
 */
import { compress, decompress } from 'fino:compress';
import { Compression, ParquetError } from './types.ts';
const CODEC_FORMAT: Record<number, 'snappy' | 'gzip' | 'zstd' | 'brotli'> = {
  [Compression.SNAPPY]: 'snappy',
  [Compression.GZIP]: 'gzip',
  [Compression.ZSTD]: 'zstd',
  [Compression.BROTLI]: 'brotli',
};
/**
 * Whether this module can read and write pages using the given codec.
 *
 * Returns `true` for UNCOMPRESSED, SNAPPY, GZIP, ZSTD, and BROTLI; `false`
 * for LZO, LZ4, LZ4_RAW, and any unknown codec id. The writer uses this to
 * reject unsupported `compression` options up front instead of failing
 * mid-write on the first page.
 *
 * This is a mapping check only — it does not probe whether the backing system
 * library (for example `libsnappy`) is actually loadable. A codec that passes
 * here can still throw from `compressPage`/`decompressPage` on a machine
 * missing that library.
 *
 * ```ts no_run
 *   import { isCodecSupported } from 'internal:data/parquet/compression';
 *   import { Compression, ParquetError } from 'internal:data/parquet/types';
 *
 *   if (!isCodecSupported(Compression.LZO)) {
 *     throw new ParquetError("compression 'lzo' is not supported");
 *   }
 * ```
 *
 * @internal
 */
export function isCodecSupported(codec: number): boolean {
  return codec === Compression.UNCOMPRESSED || CODEC_FORMAT[codec] !== undefined;
}
/**
 * Decompress a page body read from a column chunk.
 *
 * `codec` is the numeric `CompressionCodec` from the chunk's metadata and
 * `bytes` is the page payload after the page header (for DATA_PAGE_V2 with
 * `isCompressed`, only the values section — levels are never compressed).
 * For UNCOMPRESSED the input is returned as-is, same reference, no copy;
 * otherwise a freshly allocated buffer holds the decompressed bytes.
 *
 * Throws `ParquetError` if the codec has no `fino:compress` mapping (LZO,
 * LZ4, LZ4_RAW, or an unknown id). Truncated or corrupt page data, or a
 * missing backend library, surfaces as an error from `fino:compress`.
 *
 * ```ts no_run
 *   import { decompressPage } from 'internal:data/parquet/compression';
 *
 *   const raw = fileBytes.subarray(pageStart, pageStart + header.compressedPageSize);
 *   const body = decompressPage(chunkMeta.codec, raw);
 * ```
 *
 * @internal
 */
export function decompressPage(codec: number, bytes: Uint8Array): Uint8Array {
  if (codec === Compression.UNCOMPRESSED) return bytes;
  const format = CODEC_FORMAT[codec];
  if (format === undefined)
    throw new ParquetError(`unsupported Parquet compression codec ${codec}`);
  return decompress(bytes, { format });
}
/**
 * Compress a page body before it is framed with a page header.
 *
 * The writer calls this on each encoded page (dictionary and data alike) and
 * records the input length as `uncompressed_page_size` and the output length
 * as `compressed_page_size`. For UNCOMPRESSED the input is returned as-is,
 * same reference, no copy. Each format's default compression level is used;
 * Parquet metadata carries no level, so the choice does not affect readers.
 *
 * Throws `ParquetError` if the codec has no `fino:compress` mapping (LZO,
 * LZ4, LZ4_RAW, or an unknown id). A missing backend library (for example
 * `libsnappy` for SNAPPY) surfaces as an error from `fino:compress`.
 *
 * ```ts no_run
 *   import { compressPage } from 'internal:data/parquet/compression';
 *   import { Compression } from 'internal:data/parquet/types';
 *
 *   const body = compressPage(Compression.ZSTD, encodedValues);
 *   const header = encodePageHeader({
 *     uncompressedPageSize: encodedValues.byteLength,
 *     compressedPageSize: body.byteLength
 *   });
 * ```
 *
 * @internal
 */
export function compressPage(codec: number, bytes: Uint8Array): Uint8Array {
  if (codec === Compression.UNCOMPRESSED) return bytes;
  const format = CODEC_FORMAT[codec];
  if (format === undefined)
    throw new ParquetError(`unsupported Parquet compression codec ${codec}`);
  return compress(bytes, { format });
}
