/**
 * Shared vocabulary for the tokenizer pipeline stages.
 *
 * The stages are deliberately narrow: a normalizer rewrites one string, a
 * pre-tokenizer splits it, a model turns each split into tokens, a post-processor
 * assembles sequences, and a decoder joins token strings back into text. Nothing
 * here holds mutable state between calls, which is what lets a tokenizer be
 * rebuilt from its serialized spec inside a `DataLoader` worker and produce
 * byte-identical output.
 *
 * @internal
 */
import type { NormalizedString } from './normalized.ts';

/** One token produced by a model, positioned within the split it came from. */
export interface Token {
  /** Vocabulary id. */
  id: number;
  /** Vocabulary surface form, including any subword prefix or suffix. */
  value: string;
  /** UTF-16 start index within the split's rewritten text. */
  start: number;
  /** UTF-16 end index, exclusive, within the split's rewritten text. */
  end: number;
}

/** A pre-tokenized span, and the tokens a model produced for it. */
export interface Split {
  /** The span's text with its alignment back to the original input. */
  value: NormalizedString;
  /** Tokens for this span, or `null` before the model has run. */
  tokens: Token[] | null;
}

/** Rewrites text before splitting. */
export interface Normalizer {
  normalize(input: NormalizedString): NormalizedString;
}

/** Splits normalized text into the spans a model tokenizes independently. */
export interface PreTokenizer {
  preTokenize(splits: Split[]): Split[];
}

/** Turns one pre-tokenized span into vocabulary tokens. */
export interface Model {
  tokenize(value: string): Token[];
  tokenToId(token: string): number | undefined;
  idToToken(id: number): string | undefined;
  /** The base vocabulary, excluding tokens added after construction. */
  vocab(): Map<string, number>;
  /** Optional decoding hint: the model's own inverse, if it has one. */
  readonly continuingSubwordPrefix?: string;
  readonly endOfWordSuffix?: string;
}

/** Assembles one or two encoded sequences into the model's expected layout. */
export interface PostProcessor {
  /** Number of tokens this processor adds, for truncation budgeting. */
  addedTokens(pair: boolean): number;
  process(encoding: Encoding, pair: Encoding | null, addSpecialTokens: boolean): Encoding;
}

/** Joins token surface forms back into text. */
export interface Decoder {
  decodeChain(tokens: string[]): string[];
}

/** Truncation strategy for sequences longer than `maxLength`. */
export type TruncationStrategy = 'longest_first' | 'only_first' | 'only_second';

/** How to truncate or pad relative to the sequence. */
export type Direction = 'right' | 'left';

/** Truncation configuration. */
export interface TruncationOptions {
  maxLength: number;
  strategy?: TruncationStrategy;
  stride?: number;
  direction?: Direction;
}

/** Padding configuration. */
export interface PaddingOptions {
  /** Pad every sequence to this length; omit to pad to the longest in a batch. */
  length?: number;
  /** Round the padded length up to a multiple of this value. */
  padToMultipleOf?: number;
  direction?: Direction;
  padId?: number;
  padTypeId?: number;
  padToken?: string;
}

/**
 * The result of encoding one input.
 *
 * All arrays are parallel and the same length. `offsets` index the *original*
 * input string, so `text.slice(...offsets[i])` is the source of token `i`; a
 * zero-width offset marks a token that came from no input text, such as a
 * special token the post-processor added.
 */
export interface Encoding {
  /** Vocabulary ids. */
  ids: number[];
  /** Vocabulary surface forms. */
  tokens: string[];
  /** Sequence membership: `0` for the first sequence, `1` for the pair. */
  typeIds: number[];
  /** `1` for real tokens, `0` for padding. */
  attentionMask: number[];
  /** `1` for special tokens the caller did not write, `0` otherwise. */
  specialTokensMask: number[];
  /** Original `[start, end)` character range per token. */
  offsets: Array<[number, number]>;
  /** Which input sequence each token belongs to, or `null` for added tokens. */
  sequenceIds: Array<number | null>;
  /** Sequences that did not fit under a truncation budget. */
  overflowing: Encoding[];
}

/** An empty encoding, used as the identity when assembling sequences. */
export function emptyEncoding(): Encoding {
  return {
    ids: [],
    tokens: [],
    typeIds: [],
    attentionMask: [],
    specialTokensMask: [],
    offsets: [],
    sequenceIds: [],
    overflowing: [],
  };
}

/** Concatenate `b` onto `a`, dropping overflow (the caller owns that decision). */
export function concatEncodings(a: Encoding, b: Encoding): Encoding {
  return {
    ids: [...a.ids, ...b.ids],
    tokens: [...a.tokens, ...b.tokens],
    typeIds: [...a.typeIds, ...b.typeIds],
    attentionMask: [...a.attentionMask, ...b.attentionMask],
    specialTokensMask: [...a.specialTokensMask, ...b.specialTokensMask],
    offsets: [...a.offsets, ...b.offsets],
    sequenceIds: [...a.sequenceIds, ...b.sequenceIds],
    overflowing: [],
  };
}

/** A copy of `encoding` with `typeIds` and `sequenceIds` set to `index`. */
export function withSequenceIndex(encoding: Encoding, index: number): Encoding {
  return {
    ...encoding,
    typeIds: encoding.ids.map(() => index),
    sequenceIds: encoding.ids.map(() => index),
    overflowing: encoding.overflowing.map((over) => withSequenceIndex(over, index)),
  };
}

/** A shallow copy safe to mutate. */
export function cloneEncoding(encoding: Encoding): Encoding {
  return {
    ids: [...encoding.ids],
    tokens: [...encoding.tokens],
    typeIds: [...encoding.typeIds],
    attentionMask: [...encoding.attentionMask],
    specialTokensMask: [...encoding.specialTokensMask],
    offsets: encoding.offsets.map((pair) => [pair[0], pair[1]] as [number, number]),
    sequenceIds: [...encoding.sequenceIds],
    overflowing: encoding.overflowing.map(cloneEncoding),
  };
}

/** Take `[from, to)` of an encoding, keeping every parallel array aligned. */
export function sliceEncoding(encoding: Encoding, from: number, to: number): Encoding {
  return {
    ids: encoding.ids.slice(from, to),
    tokens: encoding.tokens.slice(from, to),
    typeIds: encoding.typeIds.slice(from, to),
    attentionMask: encoding.attentionMask.slice(from, to),
    specialTokensMask: encoding.specialTokensMask.slice(from, to),
    offsets: encoding.offsets.slice(from, to).map((pair) => [pair[0], pair[1]] as [number, number]),
    sequenceIds: encoding.sequenceIds.slice(from, to),
    overflowing: [],
  };
}
