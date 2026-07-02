/**
* Parquet page compression, dispatched to `fino:compress`.
*
* Supports UNCOMPRESSED, SNAPPY (raw block — the Parquet default), GZIP, ZSTD,
* and BROTLI. LZO and the raw-LZ4 variants are not yet wired (fino:compress
* speaks the LZ4 frame format, not Parquet's raw-block LZ4).
*
* @internal
*/
import { compress, decompress } from 'fino:compress';
import { Compression, ParquetError } from './types.ts';
const CODEC_FORMAT: Record<number, 'snappy' | 'gzip' | 'zstd' | 'brotli'> = {
  [Compression.SNAPPY]: 'snappy',
  [Compression.GZIP]: 'gzip',
  [Compression.ZSTD]: 'zstd',
  [Compression.BROTLI]: 'brotli'
};
/** Whether a compression codec can be read/written. @internal */
export function isCodecSupported(codec: number): boolean {
  return codec === Compression.UNCOMPRESSED || CODEC_FORMAT[codec] !== undefined;
}
/** Decompress a page body. @internal */
export function decompressPage(codec: number, bytes: Uint8Array): Uint8Array {
  if (codec === Compression.UNCOMPRESSED) return bytes;
  const format = CODEC_FORMAT[codec];
  if (format === undefined) throw new ParquetError(`unsupported Parquet compression codec ${codec}`);
  return decompress(bytes, { format });
}
/** Compress a page body. @internal */
export function compressPage(codec: number, bytes: Uint8Array): Uint8Array {
  if (codec === Compression.UNCOMPRESSED) return bytes;
  const format = CODEC_FORMAT[codec];
  if (format === undefined) throw new ParquetError(`unsupported Parquet compression codec ${codec}`);
  return compress(bytes, { format });
}
