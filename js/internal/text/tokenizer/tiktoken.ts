/**
 * The tiktoken format.
 *
 * A `.tiktoken` file is a ranks table and nothing else: one line per token,
 * holding the token's bytes in base64 and its rank. Everything a tokenizer also
 * needs — the word-splitting regex and the special tokens — lives in tiktoken's
 * source rather than in the file, so the published encodings are named here and a
 * caller loading an unlisted ranks file supplies its own.
 *
 * Ranks are converted into the printable byte alphabet on load, which puts a
 * tiktoken vocabulary in the same representation as a byte-level
 * `tokenizer.json` vocabulary and lets both share one decoder.
 *
 * @internal
 */
import { byteToChar } from './bytes.ts';

/** The pieces a tokenizer needs beyond the ranks table. */
export interface TiktokenEncoding {
  /** Word-splitting pattern applied before merging. */
  pattern: string;
  /** Literal tokens matched ahead of the model. */
  specialTokens: Record<string, number>;
}

/** GPT-2's splitting pattern, shared by the r50k and p50k encodings. */
const GPT2_PATTERN =
  "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+";

/** The cl100k pattern: case-insensitive contractions and bounded digit runs. */
const CL100K_PATTERN =
  "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

/** The o200k pattern, which splits on case runs as well as script and digits. */
const O200K_PATTERN = [
  "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
  "[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
  '\\p{N}{1,3}',
  ' ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*',
  '\\s*[\\r\\n]+',
  '\\s+(?!\\S)',
  '\\s+',
].join('|');

const ENDOFTEXT = '<|endoftext|>';
const FIM_PREFIX = '<|fim_prefix|>';
const FIM_MIDDLE = '<|fim_middle|>';
const FIM_SUFFIX = '<|fim_suffix|>';
const ENDOFPROMPT = '<|endofprompt|>';

/**
 * The published tiktoken encodings.
 *
 * The ranks tables themselves are large downloads rather than baked-in data, so
 * these describe only the surrounding configuration; pair one with a ranks file
 * fetched through `fino:model/hub` or shipped alongside the model.
 */
export const TIKTOKEN_ENCODINGS: Readonly<Record<string, TiktokenEncoding>> = {
  r50k_base: { pattern: GPT2_PATTERN, specialTokens: { [ENDOFTEXT]: 50256 } },
  gpt2: { pattern: GPT2_PATTERN, specialTokens: { [ENDOFTEXT]: 50256 } },
  p50k_base: { pattern: GPT2_PATTERN, specialTokens: { [ENDOFTEXT]: 50256 } },
  p50k_edit: {
    pattern: GPT2_PATTERN,
    specialTokens: {
      [ENDOFTEXT]: 50256,
      [FIM_PREFIX]: 50281,
      [FIM_MIDDLE]: 50282,
      [FIM_SUFFIX]: 50283,
    },
  },
  cl100k_base: {
    pattern: CL100K_PATTERN,
    specialTokens: {
      [ENDOFTEXT]: 100257,
      [FIM_PREFIX]: 100258,
      [FIM_MIDDLE]: 100259,
      [FIM_SUFFIX]: 100260,
      [ENDOFPROMPT]: 100276,
    },
  },
  o200k_base: {
    pattern: O200K_PATTERN,
    specialTokens: { [ENDOFTEXT]: 199999, [ENDOFPROMPT]: 200018 },
  },
};

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode standard base64, tolerating absent padding. */
function _fromBase64(text: string): Uint8Array {
  const source = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((source.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let at = 0;
  for (const char of source) {
    const value = BASE64.indexOf(char);
    if (value === -1) throw new Error(`tiktoken: invalid base64 character "${char}"`);
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (accumulator >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/**
 * Parse a `.tiktoken` ranks file into a byte-alphabet vocabulary.
 *
 * Blank lines are skipped. A malformed line throws rather than being dropped,
 * because a ranks table with a hole in it silently produces different ids.
 */
export function parseTiktokenRanks(text: string): Record<string, number> {
  const vocab: Record<string, number> = {};
  let line = 0;
  for (const raw of text.split('\n')) {
    line++;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const at = trimmed.lastIndexOf(' ');
    if (at === -1) throw new Error(`tiktoken: line ${line} is not "<base64> <rank>"`);
    const rank = Number(trimmed.slice(at + 1));
    if (!Number.isInteger(rank) || rank < 0) {
      throw new Error(`tiktoken: line ${line} has a non-integer rank`);
    }
    const bytes = _fromBase64(trimmed.slice(0, at));
    let token = '';
    for (const byte of bytes) token += byteToChar(byte);
    vocab[token] = rank;
  }
  return vocab;
}
