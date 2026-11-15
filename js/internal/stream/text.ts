/**
 * internal:stream/text — incremental text decoding and line framing.
 *
 * These pull-driven transforms accept sync or async iterables and propagate
 * early return and failure upstream. Decoding owns one TextDecoder per traversal
 * and flushes it only at natural EOF. Framing owns one unfinished line; limits
 * are opt-in and measured in UTF-16 code units, excluding its line terminator.
 * Neither layer trims whitespace, drops blank lines, or parses protocol fields.
 *
 * Encoding reference: https://encoding.spec.whatwg.org/#interface-textdecoder
 * SSE newline rules: https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
 *
 * @internal
 */

/** Streaming decoder configuration, using TextDecoder's encoding semantics. */
export interface TextDecodeOptions {
  /** Encoding label. Defaults to UTF-8. Unsupported labels throw RangeError. */
  encoding?: string;
  /** Reject malformed input, including an incomplete EOF tail. Defaults to false. */
  fatal?: boolean;
  /** Preserve the initial BOM rather than stripping it. Defaults to false. */
  ignoreBOM?: boolean;
}

/** Line framing policy, independent of the text's encoding or protocol. */
export interface SplitLinesOptions {
  /** LF with optional preceding CR, or LF/CRLF/bare CR. Defaults to `lf`. */
  terminators?: 'lf' | 'universal';
  /** Emit or discard an unterminated final line. Defaults to `emit`. */
  finalLine?: 'emit' | 'discard';
  /** Maximum line length in UTF-16 code units. Defaults to Infinity. */
  maxLineLength?: number;
}

/** Combined decoder and line-framing options for `readLines`. */
export interface ReadLinesOptions extends TextDecodeOptions, SplitLinesOptions {}

/**
 * Decode byte chunks incrementally into text chunks.
 *
 * Chunk boundaries never split a decoded character. Replacement decoding is
 * the default; `fatal` rejects invalid input. Source views are read within their
 * exact visible spans, and a final decoder flush handles trailing bytes at EOF.
 * Early consumer return closes the source without manufacturing an EOF tail.
 */
export async function* decodeText(
  source: AsyncIterable<ArrayBuffer | ArrayBufferView> | Iterable<ArrayBuffer | ArrayBufferView>,
  options: TextDecodeOptions = {},
): AsyncGenerator<string> {
  const decoder = new TextDecoder(options.encoding ?? 'utf-8', {
    fatal: options.fatal ?? false,
    ignoreBOM: options.ignoreBOM ?? false,
  });
  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

/**
 * Split text chunks into lines without terminators, preserving empty lines.
 *
 * `lf` treats bare CR as data and strips CR only immediately before LF.
 * `universal` treats bare CR as a terminator and consumes a following LF even
 * across chunks. A trailing terminator does not manufacture an extra line.
 * `maxLineLength` bounds the unfinished line before accepting each fragment;
 * overflow throws RangeError and closes the source. Whitespace remains intact.
 */
export async function* splitLines(
  source: AsyncIterable<string> | Iterable<string>,
  options: SplitLinesOptions = {},
): AsyncGenerator<string> {
  const terminators = options.terminators ?? 'lf';
  const finalLine = options.finalLine ?? 'emit';
  const maxLength = options.maxLineLength ?? Infinity;
  if (terminators !== 'lf' && terminators !== 'universal')
    throw new TypeError('Unknown line terminator policy');
  if (finalLine !== 'emit' && finalLine !== 'discard')
    throw new TypeError('Unknown final-line policy');
  if (maxLength !== Infinity && (!Number.isSafeInteger(maxLength) || maxLength < 0))
    throw new RangeError('maxLineLength must be a non-negative safe integer or Infinity');

  let parts: string[] = [];
  let length = 0;
  let skipLF = false;
  const append = (part: string) => {
    if (part.length === 0) return;
    const nextLength = length + part.length;
    const nextLast = part.at(-1)!;
    // LF framing may retain one CR until the next chunk reveals its terminator.
    const allowance = terminators === 'lf' && nextLast === '\r' ? 1 : 0;
    if (nextLength > maxLength + allowance)
      throw new RangeError(`Line exceeds maxLineLength (${maxLength})`);
    parts.push(part);
    length = nextLength;
  };
  const takeLine = (stripCR: boolean) => {
    const line = parts.join('');
    parts = [];
    length = 0;
    return stripCR && line.endsWith('\r') ? line.slice(0, -1) : line;
  };

  for await (const chunk of source) {
    if (typeof chunk !== 'string') throw new TypeError('Line source chunks must be strings');
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index]!;
      if (skipLF) {
        skipLF = false;
        if (char === '\n') {
          start = index + 1;
          continue;
        }
      }
      if (char !== '\n' && !(terminators === 'universal' && char === '\r')) continue;
      append(chunk.slice(start, index));
      yield takeLine(terminators === 'lf');
      skipLF = terminators === 'universal' && char === '\r';
      start = index + 1;
    }
    append(chunk.slice(start));
  }
  if (length > maxLength) throw new RangeError(`Line exceeds maxLineLength (${maxLength})`);
  if (length > 0 && finalLine === 'emit') yield takeLine(false);
}

/**
 * Compose incremental text decoding with `splitLines` over byte chunks.
 *
 * The source is consumed on demand and closed on early return or failure.
 * Options retain the same defaults as each individual transform.
 *
 * ```ts no_run
 * import { readLines } from 'fino:stream';
 * for await (const line of readLines(response.body, { maxLineLength: 65536 })) {
 *   console.log(line);
 * }
 * ```
 */
export function readLines(
  source: AsyncIterable<ArrayBuffer | ArrayBufferView> | Iterable<ArrayBuffer | ArrayBufferView>,
  options: ReadLinesOptions = {},
): AsyncGenerator<string> {
  return splitLines(decodeText(source, options), options);
}
