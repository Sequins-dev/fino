/**
 * internal:data/arrow/errors — error types for `fino:data/arrow`.
 *
 * The Arrow toolkit distinguishes two failure modes and gives each its own
 * error class. `ArrowError` reports invalid API usage: the caller's own data
 * or arguments are at fault — mismatched column lengths in a record batch,
 * a type `vectorFromArray` cannot build, a sliced column handed to the IPC
 * writer. `ArrowParseError` reports malformed or unsupported *bytes*: an IPC
 * stream or file that fails to decode. It extends `ParseError` from
 * `fino:parsing/scanner`, so callers get byte offsets and a `render()` method
 * that produces a hex dump around the failing position.
 *
 * Both classes are re-exported from the public `fino:data/arrow` module;
 * import them from there for `instanceof` checks. The distinction lets a
 * consumer separate "fix my code" errors from "this input is corrupt" errors:
 *
 * ```ts no_run
 * import { ArrowParseError, tableFromIPC } from 'fino:data/arrow';
 *
 * try {
 *   const table = tableFromIPC(bytes);
 * } catch (err) {
 *   if (err instanceof ArrowParseError) {
 *     console.error(err.render()); // hex dump at the failing offset
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 *
 * @internal
 */
import { ParseError } from 'fino:parsing/scanner';
/**
 * Error thrown for invalid Arrow usage: bad buffer lengths, unsupported types
 * passed to a builder, or malformed values.
 *
 * This is the "caller error" class — it signals a problem with the arguments
 * or data handed to the Arrow API rather than with decoded bytes. Typical
 * sources: constructing a `RecordBatch` whose columns differ in length or
 * count from the schema, combining batches with mismatched schemas into a
 * `Table`, asking `vectorFromArray` to build an unsupported type, or writing
 * a sliced column through the IPC writer. Decoding failures throw
 * `ArrowParseError` instead.
 *
 * ```ts no_run
 * import { ArrowError, RecordBatch, Schema, Field, int32, vectorFromArray } from 'fino:data/arrow';
 *
 * const schema = new Schema([new Field('a', int32()), new Field('b', int32())]);
 * try {
 *   new RecordBatch(schema, [vectorFromArray([1, 2, 3], int32())]);
 * } catch (err) {
 *   err instanceof ArrowError; // true: 2 fields, 1 column
 * }
 * ```
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
 *
 * Raised by `tableFromIPC`, `RecordBatchReader`, and `RecordBatchFileReader`
 * for truncated buffers, missing magic bytes or continuation markers, streams
 * with no schema message, and legacy pre-0.15 encapsulated messages. The
 * inherited `offset` property locates the failing byte in the input, and
 * `render()` formats a hex dump around it for logging.
 *
 * ```ts no_run
 * import { ArrowParseError, tableFromIPC } from 'fino:data/arrow';
 *
 * try {
 *   tableFromIPC(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
 * } catch (err) {
 *   if (err instanceof ArrowParseError) {
 *     console.error(`bad IPC data at byte ${err.offset}`);
 *     console.error(err.render());
 *   }
 * }
 * ```
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
 * Convenience used by the IPC reader and metadata decoder so every decode
 * failure carries the same shape: a `Malformed Arrow IPC: ...` message, the
 * `'arrow'` format tag, and the source bytes needed for `render()` to produce
 * a hex dump. Never returns.
 *
 * ```ts no_run
 * import { parseError } from 'internal:data/arrow/errors';
 *
 * function readMagic(bytes: Uint8Array): void {
 *   if (bytes.length < 6) parseError(bytes, 0, 'buffer too short for ARROW1 magic');
 * }
 * ```
 *
 * @internal
 */
export function parseError(source: Uint8Array, offset: number, detail: string): never {
  throw new ArrowParseError(`Malformed Arrow IPC: ${detail}`, {
    detail,
    format: 'arrow',
    offset,
    source,
  });
}
