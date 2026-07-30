/**
 * Decoders — turning token surface forms back into text.
 *
 * Decoding is not the inverse of encoding in general: normalization discards
 * information, so a decoder reconstructs plausible text rather than the exact
 * input. What it must be is the inverse of the *vocabulary's* surface
 * conventions — the byte alphabet, the `##` continuation prefix, the `▁` word
 * mark — which is exactly the set of rewrites the spec's decoder describes.
 *
 * A decoder is a chain: it rewrites the token list, and the tokenizer joins the
 * result with no separator.
 *
 * @internal
 */
import { charToByte } from './bytes.ts';
import { compilePattern, type PatternSpec } from './normalizers.ts';
import type { Decoder } from './types.ts';

/** The `decoder` field of a `tokenizer.json`. */
export interface DecoderSpec {
  type: string;
  [key: string]: unknown;
}

const LOSSY = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

/**
 * Undo the byte-level alphabet.
 *
 * The whole token list is flattened to bytes before a single UTF-8 decode,
 * because a multi-byte character is routinely split across two BPE tokens and
 * decoding each token alone would turn it into replacement characters.
 */
class ByteLevelDecoder implements Decoder {
  decodeChain(tokens: string[]): string[] {
    const bytes: number[] = [];
    for (const token of tokens) {
      const mapped: number[] = [];
      let complete = true;
      for (const char of token) {
        const byte = charToByte(char);
        if (byte === undefined) {
          complete = false;
          break;
        }
        mapped.push(byte);
      }
      if (complete) bytes.push(...mapped);
      else for (const raw of ENCODER.encode(token)) bytes.push(raw);
    }
    return [LOSSY.decode(new Uint8Array(bytes))];
  }
}

/** Fold `<0xXX>` runs back into the bytes they stand for. */
class ByteFallbackDecoder implements Decoder {
  decodeChain(tokens: string[]): string[] {
    const out: string[] = [];
    let pending: number[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      out.push(LOSSY.decode(new Uint8Array(pending)));
      pending = [];
    };
    for (const token of tokens) {
      const match = /^<0x([0-9A-Fa-f]{2})>$/.exec(token);
      if (match !== null) {
        pending.push(parseInt(match[1], 16));
        continue;
      }
      flush();
      out.push(token);
    }
    flush();
    return out;
  }
}

const CLEANUPS: ReadonlyArray<readonly [string, string]> = [
  [' .', '.'],
  [' ?', '?'],
  [' !', '!'],
  [' ,', ','],
  [" ' ", "'"],
  [" n't", "n't"],
  [" 'm", "'m"],
  [' do not', " don't"],
  [" 's", "'s"],
  [" 've", "'ve"],
  [" 're", "'re"],
];

/** Tidy the spacing that a space-joined subword decode leaves behind. */
function cleanup(text: string): string {
  let out = text;
  for (const [from, to] of CLEANUPS) out = out.split(from).join(to);
  return out;
}

class WordPieceDecoder implements Decoder {
  #prefix: string;
  #cleanup: boolean;
  constructor(prefix: string, doCleanup: boolean) {
    this.#prefix = prefix;
    this.#cleanup = doCleanup;
  }
  decodeChain(tokens: string[]): string[] {
    return tokens.map((token, index) => {
      let out = token;
      if (index !== 0) {
        out = out.startsWith(this.#prefix) ? out.slice(this.#prefix.length) : ' ' + out;
      }
      return this.#cleanup ? cleanup(out) : out;
    });
  }
}

class MetaspaceDecoder implements Decoder {
  #replacement: string;
  #prepends: boolean;
  constructor(replacement: string, prepends: boolean) {
    this.#replacement = replacement;
    this.#prepends = prepends;
  }
  decodeChain(tokens: string[]): string[] {
    return tokens.map((token, index) => {
      let out = '';
      let first = true;
      for (const char of token) {
        if (char !== this.#replacement) {
          out += char;
          first = false;
          continue;
        }
        // The replacement that the pre-tokenizer prepended stands for nothing
        // the caller wrote, so it is dropped rather than becoming a space.
        if (index === 0 && first && this.#prepends) {
          first = false;
          continue;
        }
        out += ' ';
        first = false;
      }
      return out;
    });
  }
}

class BpeDecoder implements Decoder {
  #suffix: string;
  constructor(suffix: string) {
    this.#suffix = suffix;
  }
  decodeChain(tokens: string[]): string[] {
    const last = tokens.length - 1;
    return tokens.map((token, index) => token.split(this.#suffix).join(index === last ? '' : ' '));
  }
}

class FuseDecoder implements Decoder {
  decodeChain(tokens: string[]): string[] {
    return [tokens.join('')];
  }
}

class StripDecoder implements Decoder {
  #content: string;
  #start: number;
  #stop: number;
  constructor(content: string, start: number, stop: number) {
    this.#content = content;
    this.#start = start;
    this.#stop = stop;
  }
  decodeChain(tokens: string[]): string[] {
    if (this.#content.length === 0) return tokens;
    return tokens.map((token) => {
      let out = token;
      for (let i = 0; i < this.#start && out.startsWith(this.#content); i++) {
        out = out.slice(this.#content.length);
      }
      for (let i = 0; i < this.#stop && out.endsWith(this.#content); i++) {
        out = out.slice(0, out.length - this.#content.length);
      }
      return out;
    });
  }
}

class ReplaceDecoder implements Decoder {
  #pattern: RegExp;
  #content: string;
  constructor(pattern: RegExp, content: string) {
    this.#pattern = pattern;
    this.#content = content;
  }
  decodeChain(tokens: string[]): string[] {
    return tokens.map((token) => token.replace(this.#pattern, this.#content));
  }
}

/**
 * The CTC collapse used by speech models: drop repeats, drop the blank symbol,
 * and turn the word delimiter into a space.
 */
class CtcDecoder implements Decoder {
  #pad: string;
  #delimiter: string;
  #cleanup: boolean;
  constructor(pad: string, delimiter: string, doCleanup: boolean) {
    this.#pad = pad;
    this.#delimiter = delimiter;
    this.#cleanup = doCleanup;
  }
  decodeChain(tokens: string[]): string[] {
    const collapsed: string[] = [];
    let previous: string | null = null;
    for (const token of tokens) {
      if (token !== previous) collapsed.push(token);
      previous = token;
    }
    return collapsed
      .filter((token) => token !== this.#pad)
      .map((token) => {
        const out = token === this.#delimiter ? ' ' : token;
        return this.#cleanup ? cleanup(out) : out;
      });
  }
}

class Sequence implements Decoder {
  #stages: Decoder[];
  constructor(stages: Decoder[]) {
    this.#stages = stages;
  }
  decodeChain(tokens: string[]): string[] {
    let out = tokens;
    for (const stage of this.#stages) out = stage.decodeChain(out);
    return out;
  }
}

/** Build a decoder from its `tokenizer.json` spec. */
export function buildDecoder(spec: DecoderSpec | null | undefined): Decoder | null {
  if (spec === null || spec === undefined) return null;
  switch (spec.type) {
    case 'ByteLevel':
      return new ByteLevelDecoder();
    case 'ByteFallback':
      return new ByteFallbackDecoder();
    case 'WordPiece':
      return new WordPieceDecoder(
        (spec.prefix as string) ?? '##',
        (spec.cleanup as boolean) ?? true,
      );
    case 'Metaspace': {
      const prepends =
        typeof spec.prepend_scheme === 'string'
          ? spec.prepend_scheme !== 'never'
          : ((spec.add_prefix_space as boolean) ?? true);
      return new MetaspaceDecoder((spec.replacement as string) ?? '▁', prepends);
    }
    case 'BPEDecoder':
      return new BpeDecoder((spec.suffix as string) ?? '</w>');
    case 'Fuse':
      return new FuseDecoder();
    case 'Strip':
      return new StripDecoder(
        (spec.content as string) ?? ' ',
        (spec.start as number) ?? 0,
        (spec.stop as number) ?? 0,
      );
    case 'Replace':
      return new ReplaceDecoder(
        compilePattern(spec.pattern as PatternSpec),
        (spec.content as string) ?? '',
      );
    case 'CTC':
      return new CtcDecoder(
        (spec.pad_token as string) ?? '<pad>',
        (spec.word_delimiter_token as string) ?? '|',
        (spec.cleanup as boolean) ?? true,
      );
    case 'Sequence': {
      const stages = ((spec.decoders as DecoderSpec[]) ?? [])
        .map(buildDecoder)
        .filter((stage): stage is Decoder => stage !== null);
      return new Sequence(stages);
    }
    default:
      throw new Error(`tokenizer: unsupported decoder type "${spec.type}"`);
  }
}
