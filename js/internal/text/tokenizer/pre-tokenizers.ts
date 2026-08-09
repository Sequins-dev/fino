/**
 * Pre-tokenizers — the split into spans the model tokenizes independently.
 *
 * A pre-tokenizer decides what a "word" is, and that decision is the single
 * biggest source of divergence between tokenizer implementations: BPE merges
 * never cross a span boundary, so getting the boundaries wrong changes the ids
 * even when the merge table is right. Each split keeps its alignment back to the
 * original input, and byte-level remapping happens inside the split rather than
 * over the whole string so those offsets survive it.
 *
 * @internal
 */
import { NormalizedString } from './normalized.ts';
import { compilePattern, type PatternSpec } from './normalizers.ts';
import { encodeByteLevel } from './bytes.ts';
import type { PreTokenizer, Split } from './types.ts';

/** The `pre_tokenizer` field of a `tokenizer.json`. */
export interface PreTokenizerSpec {
  type: string;
  [key: string]: unknown;
}

/** What happens to the text a split pattern matched. */
export type SplitBehavior =
  | 'Removed'
  | 'Isolated'
  | 'MergedWithPrevious'
  | 'MergedWithNext'
  | 'Contiguous';

/**
 * GPT-2's contraction-aware word regex, the de-facto byte-level BPE boundary.
 *
 * The trailing `\s+(?!\S)` before `\s+` is what makes a run of spaces attach to
 * the following word except at the end of the input.
 */
const GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

const WHITESPACE_WORD = /\w+|[^\w\s]+/gu;
const NOT_WHITESPACE = /\S+/gu;
const PUNCTUATION = /[\p{P}\p{S}]/gu;
const DIGITS = /\p{N}+/gu;
const SINGLE_DIGITS = /\p{N}/gu;

interface Range {
  start: number;
  end: number;
  matched: boolean;
}

/**
 * Match ranges of `pattern` over `text`, interleaved with the gaps between.
 *
 * `invert` swaps which of the two is the delimiter, so "keep the words" can be
 * written as "remove the delimiters" over a word pattern.
 */
function _ranges(text: string, pattern: RegExp, invert: boolean): Range[] {
  const out: Range[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    const start = match.index!;
    const end = start + match[0].length;
    if (start > at) out.push({ start: at, end: start, matched: invert });
    out.push({ start, end, matched: !invert });
    at = end;
  }
  if (at < text.length) out.push({ start: at, end: text.length, matched: invert });
  return out;
}

/** Split one span on a pattern, per the delimiter behavior. */
export function splitOn(
  value: NormalizedString,
  pattern: RegExp,
  behavior: SplitBehavior,
  invert = false,
): NormalizedString[] {
  const ranges = _ranges(value.text, pattern, invert);
  if (ranges.length === 0) return value.isEmpty ? [] : [value];
  const out: Array<[number, number]> = [];
  let lastWasDelimiter = false;
  // `MergedWithNext` cannot be emitted until the span that follows is known.
  let pending: [number, number] | null = null;
  for (const range of ranges) {
    if (!range.matched) {
      if (pending !== null) {
        out.push([pending[0], range.end]);
        pending = null;
      } else {
        out.push([range.start, range.end]);
      }
      lastWasDelimiter = false;
      continue;
    }
    switch (behavior) {
      case 'Removed':
        break;
      case 'Isolated':
        out.push([range.start, range.end]);
        break;
      case 'MergedWithPrevious':
        if (out.length > 0) out[out.length - 1][1] = range.end;
        else out.push([range.start, range.end]);
        break;
      case 'MergedWithNext':
        if (pending !== null) pending[1] = range.end;
        else pending = [range.start, range.end];
        break;
      case 'Contiguous':
        if (lastWasDelimiter && out.length > 0) out[out.length - 1][1] = range.end;
        else out.push([range.start, range.end]);
        break;
    }
    lastWasDelimiter = true;
  }
  if (pending !== null) out.push(pending);
  return out.map(([start, end]) => value.slice(start, end)).filter((slice) => !slice.isEmpty);
}

/** Apply a per-span split function across every span that has no tokens yet. */
function _mapSplits(splits: Split[], fn: (value: NormalizedString) => NormalizedString[]): Split[] {
  const out: Split[] = [];
  for (const split of splits) {
    if (split.tokens !== null) {
      out.push(split);
      continue;
    }
    for (const value of fn(split.value)) out.push({ value, tokens: null });
  }
  return out;
}

class SplitPreTokenizer implements PreTokenizer {
  #pattern: RegExp;
  #behavior: SplitBehavior;
  #invert: boolean;
  constructor(pattern: RegExp, behavior: SplitBehavior, invert: boolean) {
    this.#pattern = pattern;
    this.#behavior = behavior;
    this.#invert = invert;
  }
  preTokenize(splits: Split[]): Split[] {
    return _mapSplits(splits, (value) =>
      splitOn(value, this.#pattern, this.#behavior, this.#invert),
    );
  }
}

/**
 * Byte-level splitting and remapping.
 *
 * `addPrefixSpace` makes the first word of an input look like a mid-sentence
 * word, which is why GPT-2 encodes `"Hello"` and `" Hello"` to the same id when
 * it is enabled.
 */
class ByteLevelPreTokenizer implements PreTokenizer {
  #addPrefixSpace: boolean;
  #useRegex: boolean;
  constructor(addPrefixSpace: boolean, useRegex: boolean) {
    this.#addPrefixSpace = addPrefixSpace;
    this.#useRegex = useRegex;
  }
  preTokenize(splits: Split[]): Split[] {
    return _mapSplits(splits, (value) => {
      let source = value;
      if (this.#addPrefixSpace && !source.text.startsWith(' ')) source = source.prepend(' ');
      const words = this.#useRegex ? splitOn(source, GPT2_SPLIT, 'Isolated', true) : [source];
      return words
        .map((word) => word.mapCodePoints((cp) => encodeByteLevel(cp)))
        .filter((word) => !word.isEmpty);
    });
  }
}

/**
 * Sentencepiece-style splitting: whitespace becomes a visible replacement
 * character, and a span starts at each replacement.
 */
class Metaspace implements PreTokenizer {
  #replacement: string;
  #prependScheme: 'always' | 'never' | 'first';
  #split: boolean;
  constructor(replacement: string, prependScheme: 'always' | 'never' | 'first', split: boolean) {
    this.#replacement = replacement;
    this.#prependScheme = prependScheme;
    this.#split = split;
  }
  preTokenize(splits: Split[]): Split[] {
    let first = true;
    return _mapSplits(splits, (value) => {
      const isFirst = first;
      first = false;
      let source = value.mapCodePoints((cp) => (cp === ' ' ? this.#replacement : cp));
      const prepend =
        this.#prependScheme === 'always' || (this.#prependScheme === 'first' && isFirst);
      if (prepend && !source.text.startsWith(this.#replacement)) {
        source = source.prepend(this.#replacement);
      }
      if (!this.#split) return source.isEmpty ? [] : [source];
      return splitOn(source, new RegExp(_escape(this.#replacement), 'gu'), 'MergedWithNext');
    });
  }
}

class BertPreTokenizer implements PreTokenizer {
  preTokenize(splits: Split[]): Split[] {
    return _mapSplits(splits, (value) => {
      const words = splitOn(value, NOT_WHITESPACE, 'Removed', true);
      return words.flatMap((word) => splitOn(word, PUNCTUATION, 'Isolated'));
    });
  }
}

class Digits implements PreTokenizer {
  #individual: boolean;
  constructor(individual: boolean) {
    this.#individual = individual;
  }
  preTokenize(splits: Split[]): Split[] {
    return _mapSplits(splits, (value) =>
      splitOn(value, this.#individual ? SINGLE_DIGITS : DIGITS, 'Isolated'),
    );
  }
}

class FixedLength implements PreTokenizer {
  #length: number;
  constructor(length: number) {
    this.#length = length;
  }
  preTokenize(splits: Split[]): Split[] {
    return _mapSplits(splits, (value) => {
      const out: NormalizedString[] = [];
      for (let at = 0; at < value.text.length; at += this.#length) {
        out.push(value.slice(at, Math.min(at + this.#length, value.text.length)));
      }
      return out;
    });
  }
}

class Sequence implements PreTokenizer {
  #stages: PreTokenizer[];
  constructor(stages: PreTokenizer[]) {
    this.#stages = stages;
  }
  preTokenize(splits: Split[]): Split[] {
    let out = splits;
    for (const stage of this.#stages) out = stage.preTokenize(out);
    return out;
  }
}

function _escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _behavior(value: unknown): SplitBehavior {
  const name = typeof value === 'string' ? value : 'Isolated';
  switch (name) {
    case 'Removed':
    case 'Isolated':
    case 'MergedWithPrevious':
    case 'MergedWithNext':
    case 'Contiguous':
      return name;
    default:
      throw new Error(`tokenizer: unsupported split behavior "${name}"`);
  }
}

/** Build a pre-tokenizer from its `tokenizer.json` spec. */
export function buildPreTokenizer(spec: PreTokenizerSpec | null | undefined): PreTokenizer | null {
  if (spec === null || spec === undefined) return null;
  switch (spec.type) {
    case 'ByteLevel':
      return new ByteLevelPreTokenizer(
        (spec.add_prefix_space as boolean) ?? true,
        (spec.use_regex as boolean) ?? true,
      );
    case 'Whitespace':
      return new SplitPreTokenizer(WHITESPACE_WORD, 'Removed', true);
    case 'WhitespaceSplit':
      return new SplitPreTokenizer(NOT_WHITESPACE, 'Removed', true);
    case 'BertPreTokenizer':
      return new BertPreTokenizer();
    case 'Punctuation':
      return new SplitPreTokenizer(PUNCTUATION, _behavior(spec.behavior), false);
    case 'Digits':
      return new Digits((spec.individual_digits as boolean) ?? false);
    case 'CharDelimiterSplit':
      return new SplitPreTokenizer(
        new RegExp(_escape(String(spec.delimiter ?? ' ')), 'gu'),
        'Removed',
        false,
      );
    case 'Split':
      return new SplitPreTokenizer(
        compilePattern(spec.pattern as PatternSpec),
        _behavior(spec.behavior),
        (spec.invert as boolean) ?? false,
      );
    case 'Metaspace': {
      // `add_prefix_space` is the pre-`prepend_scheme` spelling of the same knob.
      const scheme =
        typeof spec.prepend_scheme === 'string'
          ? (spec.prepend_scheme as 'always' | 'never' | 'first')
          : ((spec.add_prefix_space as boolean) ?? true)
            ? 'always'
            : 'never';
      return new Metaspace(
        (spec.replacement as string) ?? '▁',
        scheme,
        (spec.split as boolean) ?? true,
      );
    }
    case 'FixedLength':
      return new FixedLength((spec.length as number) ?? 1);
    case 'Sequence': {
      const stages = ((spec.pretokenizers as PreTokenizerSpec[]) ?? [])
        .map(buildPreTokenizer)
        .filter((stage): stage is PreTokenizer => stage !== null);
      return new Sequence(stages);
    }
    case 'UnicodeScripts':
      throw new Error(
        'tokenizer: the UnicodeScripts pre-tokenizer accompanies Unigram vocabularies, ' +
          'which this tokenizer does not implement',
      );
    default:
      throw new Error(`tokenizer: unsupported pre-tokenizer type "${spec.type}"`);
  }
}
