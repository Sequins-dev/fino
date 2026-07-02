/**
* Error types for `fino:data/arrow`.
*
* @internal
*/
import { ParseError } from 'fino:parsing/scanner';
/**
* Error thrown for invalid Arrow usage: bad buffer lengths, unsupported types
* passed to a builder, or malformed values.
*/
export class ArrowError extends Error {
  /**
  * Error name reported by `ArrowError` instances.
  *
  * @internal
  */
  override name = 'ArrowError';
}
/**
* Error thrown when decoding an Arrow IPC stream or file that is malformed or
* uses an unsupported feature. Extends `ParseError` for hex-dump diagnostics.
*/
export class ArrowParseError extends ParseError {
  /**
  * Error name reported by `ArrowParseError` instances.
  *
  * @internal
  */
  override name = 'ArrowParseError';
}
/**
* Raise an `ArrowParseError` at `offset` in `source`.
*
* @internal
*/
export function parseError(source: Uint8Array, offset: number, detail: string): never {
  throw new ArrowParseError(`Malformed Arrow IPC: ${detail}`, {
    detail,
    format: 'arrow',
    offset,
    source
  });
}
