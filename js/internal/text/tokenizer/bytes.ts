/**
 * The GPT-2 byte-level alphabet.
 *
 * Byte-level BPE runs its merge table over bytes, but a vocabulary has to be
 * printable text. GPT-2's answer, which every byte-level tokenizer since has
 * copied verbatim, is a fixed bijection from the 256 byte values onto 256
 * printable code points: bytes that are already printable and non-space map to
 * themselves, and the remaining 68 are lifted to U+0100 and up in byte order.
 *
 * The mapping is a wire format, not a choice — it is what makes `Ġ` the visible
 * form of a leading space in published vocabularies — so it is derived here from
 * the same construction rather than tabulated.
 *
 * @internal
 */

const BYTE_TO_CHAR: string[] = [];
const CHAR_TO_BYTE = new Map<string, number>();

{
  const printable: number[] = [];
  for (let b = 0x21; b <= 0x7e; b++) printable.push(b);
  for (let b = 0xa1; b <= 0xac; b++) printable.push(b);
  for (let b = 0xae; b <= 0xff; b++) printable.push(b);
  const direct = new Set(printable);
  let lifted = 0;
  for (let b = 0; b < 256; b++) {
    const code = direct.has(b) ? b : 0x100 + lifted++;
    const char = String.fromCodePoint(code);
    BYTE_TO_CHAR[b] = char;
    CHAR_TO_BYTE.set(char, b);
  }
}

/** The printable stand-in for a byte value. */
export function byteToChar(byte: number): string {
  return BYTE_TO_CHAR[byte];
}

/** The byte a printable stand-in represents, or `undefined` if it is not one. */
export function charToByte(char: string): number | undefined {
  return CHAR_TO_BYTE.get(char);
}

/** The 256 printable stand-ins, in byte order. */
export function byteAlphabet(): readonly string[] {
  return BYTE_TO_CHAR;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });

/** Rewrite text as one printable stand-in per UTF-8 byte. */
export function encodeByteLevel(text: string): string {
  const bytes = ENCODER.encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += BYTE_TO_CHAR[bytes[i]];
  return out;
}

/**
 * Recover text from printable stand-ins.
 *
 * Code points outside the alphabet are passed through as their own UTF-8 bytes,
 * which keeps decoding lossless for vocabularies that mix byte-level pieces with
 * literal added tokens. Invalid UTF-8 in the recovered bytes decodes to
 * replacement characters rather than throwing, matching how a partial token
 * stream has to render.
 */
export function decodeByteLevel(text: string): string {
  const bytes: number[] = [];
  for (const char of text) {
    const byte = CHAR_TO_BYTE.get(char);
    if (byte === undefined) {
      for (const raw of ENCODER.encode(char)) bytes.push(raw);
      continue;
    }
    bytes.push(byte);
  }
  return DECODER.decode(new Uint8Array(bytes));
}
