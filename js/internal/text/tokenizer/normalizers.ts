/**
 * Normalizers — the text rewrites a tokenizer applies before splitting.
 *
 * Each normalizer is built from the spec object a Hugging Face `tokenizer.json`
 * carries in its `normalizer` field, so the rewrite a published model was trained
 * with is the rewrite applied here. Unsupported spec types throw at construction
 * rather than silently degrading, because a normalizer that quietly does nothing
 * produces plausible ids that do not match the model's training distribution.
 *
 * @internal
 */
import { NormalizedString, escapeRegExp, type NormalizationForm } from './normalized.ts';
import type { Normalizer } from './types.ts';
import { encodeByteLevel } from './bytes.ts';

/** A `pattern` field, which is either a literal or a regular expression. */
export interface PatternSpec {
  String?: string;
  Regex?: string;
}

/** The `normalizer` field of a `tokenizer.json`. */
export interface NormalizerSpec {
  type: string;
  [key: string]: unknown;
}

const CJK =
  /[㐀-䶿一-鿿豈-﫿]|[\u{20000}-\u{2a6df}]|[\u{2a700}-\u{2b73f}]|[\u{2b740}-\u{2b81f}]|[\u{2b820}-\u{2ceaf}]|[\u{2f800}-\u{2fa1f}]/u;
const CONTROL = /^[\p{Cc}\p{Cf}]$/u;
const WHITESPACE = /^\s$/u;

/**
 * Compile a `pattern` spec into a global regular expression.
 *
 * A `Regex` pattern is taken as-is with Unicode semantics; a `String` pattern is
 * escaped so it matches literally.
 */
export function compilePattern(pattern: PatternSpec | string): RegExp {
  if (typeof pattern === 'string') return new RegExp(escapeRegExp(pattern), 'gu');
  if (typeof pattern.Regex === 'string') return new RegExp(pattern.Regex, 'gu');
  if (typeof pattern.String === 'string') return new RegExp(escapeRegExp(pattern.String), 'gu');
  throw new Error('tokenizer: pattern must specify either String or Regex');
}

class UnicodeNormalizer implements Normalizer {
  #form: NormalizationForm;
  constructor(form: NormalizationForm) {
    this.#form = form;
  }
  normalize(input: NormalizedString): NormalizedString {
    return input.normalize(this.#form);
  }
}

class Lowercase implements Normalizer {
  normalize(input: NormalizedString): NormalizedString {
    return input.lowercase();
  }
}

class StripAccents implements Normalizer {
  normalize(input: NormalizedString): NormalizedString {
    return input.normalize('NFD').filterCodePoints((cp) => !/^\p{Mn}$/u.test(cp));
  }
}

class Strip implements Normalizer {
  #left: boolean;
  #right: boolean;
  constructor(left: boolean, right: boolean) {
    this.#left = left;
    this.#right = right;
  }
  normalize(input: NormalizedString): NormalizedString {
    return input.strip(this.#left, this.#right);
  }
}

class Prepend implements Normalizer {
  #prefix: string;
  constructor(prefix: string) {
    this.#prefix = prefix;
  }
  normalize(input: NormalizedString): NormalizedString {
    return input.prepend(this.#prefix);
  }
}

class Replace implements Normalizer {
  #pattern: RegExp;
  #content: string;
  constructor(pattern: RegExp, content: string) {
    this.#pattern = pattern;
    this.#content = content;
  }
  normalize(input: NormalizedString): NormalizedString {
    return input.replaceAll(this.#pattern, this.#content);
  }
}

/**
 * The composite normalizer BERT-family tokenizers use.
 *
 * `handleChineseChars` pads CJK ideographs with spaces so the pre-tokenizer
 * splits them into single characters, which is how BERT's Chinese vocabulary was
 * built.
 */
class BertNormalizer implements Normalizer {
  #cleanText: boolean;
  #handleChineseChars: boolean;
  #stripAccents: boolean | null;
  #lowercase: boolean;
  constructor(
    cleanText: boolean,
    handleChineseChars: boolean,
    stripAccents: boolean | null,
    lowercase: boolean,
  ) {
    this.#cleanText = cleanText;
    this.#handleChineseChars = handleChineseChars;
    this.#stripAccents = stripAccents;
    this.#lowercase = lowercase;
  }
  normalize(input: NormalizedString): NormalizedString {
    let out = input;
    if (this.#cleanText) {
      out = out.mapCodePoints((cp) => {
        if (cp === '\u0000' || cp === '\ufffd') return '';
        if (cp === '\t' || cp === '\n' || cp === '\r') return ' ';
        if (CONTROL.test(cp)) return '';
        return WHITESPACE.test(cp) ? ' ' : cp;
      });
    }
    if (this.#handleChineseChars) {
      out = out.mapCodePoints((cp) => (CJK.test(cp) ? ` ${cp} ` : cp));
    }
    // `strip_accents: null` means "follow lowercase", which is how the BERT
    // reference implementation ties the two together.
    if (this.#stripAccents ?? this.#lowercase) {
      out = out.normalize('NFD').filterCodePoints((cp) => !/^\p{Mn}$/u.test(cp));
    }
    if (this.#lowercase) out = out.lowercase();
    return out;
  }
}

/**
 * The NMT cleanup sentencepiece applies: drop control and invalid characters,
 * and fold the various Unicode space separators onto a plain space.
 */
class NmtNormalizer implements Normalizer {
  normalize(input: NormalizedString): NormalizedString {
    return input.mapCodePoints((cp) => {
      const code = cp.codePointAt(0)!;
      if (
        (code >= 0x0001 && code <= 0x0008) ||
        code === 0x000b ||
        (code >= 0x000e && code <= 0x001f) ||
        code === 0x007f ||
        code === 0x008f ||
        code === 0x009f
      ) {
        return '';
      }
      if (
        code === 0x0009 ||
        code === 0x000a ||
        code === 0x000c ||
        code === 0x000d ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x2581 ||
        code === 0x200b ||
        code === 0xfeff ||
        code === 0xfffd
      ) {
        return ' ';
      }
      return cp;
    });
  }
}

class ByteLevelNormalizer implements Normalizer {
  normalize(input: NormalizedString): NormalizedString {
    return input.mapCodePoints((cp) => encodeByteLevel(cp));
  }
}

class Sequence implements Normalizer {
  #stages: Normalizer[];
  constructor(stages: Normalizer[]) {
    this.#stages = stages;
  }
  normalize(input: NormalizedString): NormalizedString {
    let out = input;
    for (const stage of this.#stages) out = stage.normalize(out);
    return out;
  }
}

/**
 * Build a normalizer from its `tokenizer.json` spec.
 *
 * A `null` or absent spec yields `null`, meaning the input reaches the
 * pre-tokenizer unchanged.
 */
export function buildNormalizer(spec: NormalizerSpec | null | undefined): Normalizer | null {
  if (spec === null || spec === undefined) return null;
  switch (spec.type) {
    case 'NFC':
    case 'NFD':
      return new UnicodeNormalizer(spec.type);
    case 'NFKC':
    case 'NFKD':
      // `String.prototype.normalize` crashes the process for the compatibility
      // forms on this V8 build — the canonical forms are fine. Refusing here
      // turns a segfault into a diagnosable error; when the runtime gains the
      // data, this case folds back into the one above.
      throw new Error(
        `tokenizer: the ${spec.type} normalizer needs Unicode compatibility normalization, ` +
          "which this runtime's String.prototype.normalize does not currently provide",
      );
    case 'Lowercase':
      return new Lowercase();
    case 'StripAccents':
      return new StripAccents();
    case 'Strip':
      return new Strip((spec.strip_left as boolean) ?? true, (spec.strip_right as boolean) ?? true);
    case 'Prepend':
      return new Prepend((spec.prepend as string) ?? '');
    case 'Replace':
      return new Replace(
        compilePattern(spec.pattern as PatternSpec),
        (spec.content as string) ?? '',
      );
    case 'BertNormalizer':
      return new BertNormalizer(
        (spec.clean_text as boolean) ?? true,
        (spec.handle_chinese_chars as boolean) ?? true,
        (spec.strip_accents as boolean | null) ?? null,
        (spec.lowercase as boolean) ?? true,
      );
    case 'Nmt':
      return new NmtNormalizer();
    case 'ByteLevel':
      return new ByteLevelNormalizer();
    case 'Sequence': {
      const stages = ((spec.normalizers as NormalizerSpec[]) ?? [])
        .map(buildNormalizer)
        .filter((stage): stage is Normalizer => stage !== null);
      return new Sequence(stages);
    }
    case 'Precompiled':
      throw new Error(
        'tokenizer: the Precompiled normalizer is a sentencepiece character map, ' +
          'which arrives with Unigram vocabularies that this tokenizer does not implement',
      );
    default:
      throw new Error(`tokenizer: unsupported normalizer type "${spec.type}"`);
  }
}
