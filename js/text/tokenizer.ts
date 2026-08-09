/**
 * fino:text/tokenizer - text to token ids, in pure TypeScript.
 *
 * Loads the tokenizers published models actually ship with — a Hugging Face
 * `tokenizer.json` carrying a BPE or WordPiece vocabulary, or a tiktoken ranks
 * file — and reproduces their encoding exactly, including the normalizer,
 * pre-tokenizer, post-processor, and decoder stages that decide where token
 * boundaries fall. There is no native dependency: `tokenizers` is Rust with no C
 * ABI and sentencepiece is C++ only, so binding either would mean shipping a
 * compiled artifact, while BPE and WordPiece over a vocabulary are string
 * processing that TypeScript does well.
 *
 * Encoding is deterministic and stateless. A tokenizer serializes back to the
 * spec it was built from, so a `DataLoader` worker can rebuild an identical one
 * from a structured-cloneable value and produce byte-identical ids — which is
 * also how dataset-scale tokenization gets parallelized, since a single encode
 * is CPU-bound and short.
 *
 * `Encoding.offsets` index the original input string, so a prediction can be
 * mapped back onto the caller's own text. Special tokens the post-processor added
 * carry a zero-width offset to mark that they came from no input.
 *
 * Unigram vocabularies and tokenizer *training* are deliberately absent: Unigram
 * needs the sentencepiece character map that accompanies it, and loading one
 * without the other yields ids that look right and are not. Both throw a specific
 * error rather than degrading quietly. A llama.cpp GGUF vocabulary is reached the
 * same way any other source is — by building a spec object and handing it to
 * `Tokenizer.fromJSON` — which keeps this module independent of llama.cpp.
 *
 * ```ts no_run
 * import { Tokenizer } from 'fino:text/tokenizer';
 *
 * const tokenizer = await Tokenizer.fromFile('./tokenizer.json');
 * const encoded = tokenizer.encode('Hello, world!');
 * console.log(encoded.ids, encoded.tokens);
 * console.log(tokenizer.decode(encoded.ids));
 * ```
 */
import { DiskFileSystem } from 'fino:file';
import { NormalizedString } from '../internal/text/tokenizer/normalized.ts';
import { buildNormalizer, type NormalizerSpec } from '../internal/text/tokenizer/normalizers.ts';
import {
  buildPreTokenizer,
  type PreTokenizerSpec,
} from '../internal/text/tokenizer/pre-tokenizers.ts';
import { buildModel } from '../internal/text/tokenizer/models.ts';
import {
  buildPostProcessor,
  defaultPostProcessor,
  type PostProcessorSpec,
} from '../internal/text/tokenizer/post-processors.ts';
import { buildDecoder, type DecoderSpec } from '../internal/text/tokenizer/decoders.ts';
import {
  AddedVocabulary,
  makeAddedToken,
  type AddedToken,
  type AddedTokenOptions,
} from '../internal/text/tokenizer/added-tokens.ts';
import {
  parseTiktokenRanks,
  TIKTOKEN_ENCODINGS,
  type TiktokenEncoding,
} from '../internal/text/tokenizer/tiktoken.ts';
import {
  cloneEncoding,
  emptyEncoding,
  sliceEncoding,
  type Decoder,
  type Encoding,
  type Model,
  type Normalizer,
  type PaddingOptions,
  type PostProcessor,
  type PreTokenizer,
  type Split,
  type TruncationOptions,
} from '../internal/text/tokenizer/types.ts';

export type {
  Direction,
  Encoding,
  PaddingOptions,
  TruncationOptions,
  TruncationStrategy,
} from '../internal/text/tokenizer/types.ts';
export type { AddedToken, AddedTokenOptions } from '../internal/text/tokenizer/added-tokens.ts';
export type { TiktokenEncoding } from '../internal/text/tokenizer/tiktoken.ts';
export { TIKTOKEN_ENCODINGS, parseTiktokenRanks } from '../internal/text/tokenizer/tiktoken.ts';
export { byteAlphabet } from '../internal/text/tokenizer/bytes.ts';

/** An added-token entry as a `tokenizer.json` spells it. */
export interface AddedTokenSpec {
  id: number;
  content: string;
  single_word?: boolean;
  lstrip?: boolean;
  rstrip?: boolean;
  normalized?: boolean;
  special?: boolean;
}

/**
 * A Hugging Face `tokenizer.json`.
 *
 * Only the fields that affect encoding are read; `version`, training metadata,
 * and unknown keys are preserved by `toJSON()` but otherwise ignored.
 */
export interface TokenizerSpec {
  version?: string;
  truncation?: Record<string, unknown> | null;
  padding?: Record<string, unknown> | null;
  added_tokens?: AddedTokenSpec[];
  normalizer?: NormalizerSpec | null;
  pre_tokenizer?: PreTokenizerSpec | null;
  post_processor?: PostProcessorSpec | null;
  decoder?: DecoderSpec | null;
  model: Record<string, unknown>;
  [key: string]: unknown;
}

/** Per-call encoding options. */
export interface EncodeOptions {
  /** Apply the post-processor's special tokens. Defaults to `true`. */
  addSpecialTokens?: boolean;
  /** Truncation for this call, overriding the tokenizer's default. */
  truncation?: TruncationOptions | null;
  /** Padding for this call, overriding the tokenizer's default. */
  padding?: PaddingOptions | null;
}

/** A single input, or a sequence and its pair. */
export type EncodeInput = string | readonly [string, string];

/** Options for `decode`. */
export interface DecodeOptions {
  /** Drop tokens flagged special. Defaults to `true`. */
  skipSpecialTokens?: boolean;
}

/** Construction options beyond the spec. */
export interface TokenizerOptions {
  truncation?: TruncationOptions | null;
  padding?: PaddingOptions | null;
}

/** Building a tokenizer from a tiktoken ranks table. */
export interface TiktokenOptions {
  /** Ranks as `{token: rank}` in the printable byte alphabet. */
  vocab: Record<string, number>;
  /** Word-splitting pattern; defaults to the named encoding's. */
  pattern?: string;
  /** Literal tokens matched ahead of the model. */
  specialTokens?: Record<string, number>;
}

const DEFAULT_FS = new DiskFileSystem();
const DECODER = new TextDecoder();

/**
 * A loaded tokenizer.
 *
 * Instances are immutable apart from the added vocabulary, which `addTokens` and
 * `addSpecialTokens` extend. Encoding holds no state between calls, so one
 * instance is safe to share across concurrent encodes.
 */
export class Tokenizer {
  #spec: TokenizerSpec;
  #model: Model;
  #normalizer: Normalizer | null;
  #preTokenizer: PreTokenizer | null;
  #postProcessor: PostProcessor;
  #decoder: Decoder | null;
  #added = new AddedVocabulary();
  #truncation: TruncationOptions | null;
  #padding: PaddingOptions | null;
  #nextId: number;
  #baseVocabSize: number;

  constructor(spec: TokenizerSpec, options: TokenizerOptions = {}) {
    this.#spec = spec;
    this.#model = buildModel(spec.model);
    this.#normalizer = buildNormalizer(spec.normalizer);
    this.#preTokenizer = buildPreTokenizer(spec.pre_tokenizer);
    this.#postProcessor = spec.post_processor
      ? buildPostProcessor(spec.post_processor)
      : defaultPostProcessor();
    this.#decoder = buildDecoder(spec.decoder);
    this.#truncation =
      options.truncation !== undefined ? options.truncation : _readTruncation(spec.truncation);
    this.#padding = options.padding !== undefined ? options.padding : _readPadding(spec.padding);
    // Walk the base vocabulary once: a copy of it is expensive for a real
    // vocabulary, so neither the id allocator nor `vocabSize` re-reads it.
    const baseVocab = this.#model.vocab();
    this.#baseVocabSize = baseVocab.size;
    let highest = -1;
    for (const id of baseVocab.values()) highest = Math.max(highest, id);
    for (const entry of spec.added_tokens ?? []) {
      this.#added.add({
        id: entry.id,
        content: entry.content,
        singleWord: entry.single_word ?? false,
        lstrip: entry.lstrip ?? false,
        rstrip: entry.rstrip ?? false,
        normalized: entry.normalized ?? !(entry.special ?? false),
        special: entry.special ?? false,
      });
      highest = Math.max(highest, entry.id);
    }
    this.#nextId = highest + 1;
  }

  /** Parse a `tokenizer.json`, given as text or as an already-parsed object. */
  static fromJSON(source: string | TokenizerSpec, options?: TokenizerOptions): Tokenizer {
    const spec = typeof source === 'string' ? (JSON.parse(source) as TokenizerSpec) : source;
    if (spec === null || typeof spec !== 'object' || typeof spec.model !== 'object') {
      throw new Error('tokenizer: spec must be an object with a "model" field');
    }
    return new Tokenizer(spec, options);
  }

  /** Read and parse a `tokenizer.json` from disk. */
  static async fromFile(path: string, options?: TokenizerOptions): Promise<Tokenizer> {
    return Tokenizer.fromJSON(DECODER.decode(await DEFAULT_FS.readFile(path)), options);
  }

  /**
   * Build a tokenizer from a tiktoken ranks table.
   *
   * Ranks alone do not describe a tokenizer, so `pattern` is required unless the
   * table came from `Tokenizer.fromTiktokenFile` with a known encoding name.
   */
  static fromTiktoken(options: TiktokenOptions, tokenizerOptions?: TokenizerOptions): Tokenizer {
    if (typeof options.pattern !== 'string' || options.pattern.length === 0) {
      throw new Error(
        'tokenizer: a tiktoken ranks table needs its splitting pattern; pass `pattern`, ' +
          'or name a published encoding so the pattern can be looked up',
      );
    }
    const added: AddedTokenSpec[] = Object.entries(options.specialTokens ?? {}).map(
      ([content, id]) => ({
        id,
        content,
        special: true,
        normalized: false,
      }),
    );
    const spec: TokenizerSpec = {
      added_tokens: added,
      normalizer: null,
      // Split into words first, then map each word's bytes into the alphabet the
      // ranks table is written in. `use_regex: false` makes the second stage a
      // pure remapping rather than a second split.
      pre_tokenizer: {
        type: 'Sequence',
        pretokenizers: [
          {
            type: 'Split',
            pattern: { Regex: options.pattern },
            behavior: 'Isolated',
            invert: true,
          },
          { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
        ],
      },
      post_processor: null,
      decoder: { type: 'ByteLevel' },
      // A tiktoken vocabulary is already in the byte alphabet and its ranks are
      // the merge table, which the `tiktoken` model type encodes directly. Naming
      // it in the spec is what lets `toJSON` round-trip into a worker.
      model: { type: 'tiktoken', vocab: options.vocab },
    };
    return new Tokenizer(spec, tokenizerOptions);
  }

  /**
   * Read a `.tiktoken` ranks file, taking the pattern and special tokens from a
   * published encoding name such as `cl100k_base` or `o200k_base`.
   */
  static async fromTiktokenFile(
    path: string,
    encoding: string | TiktokenEncoding,
    options?: TokenizerOptions,
  ): Promise<Tokenizer> {
    const config =
      typeof encoding === 'string'
        ? (TIKTOKEN_ENCODINGS[encoding] as TiktokenEncoding | undefined)
        : encoding;
    if (config === undefined) {
      throw new Error(
        `tokenizer: unknown tiktoken encoding "${String(encoding)}"; known encodings are ` +
          Object.keys(TIKTOKEN_ENCODINGS).join(', '),
      );
    }
    const text = DECODER.decode(await DEFAULT_FS.readFile(path));
    return Tokenizer.fromTiktoken(
      {
        vocab: parseTiktokenRanks(text),
        pattern: config.pattern,
        specialTokens: config.specialTokens,
      },
      options,
    );
  }

  /** The spec this tokenizer encodes with, including any tokens added since. */
  toJSON(): TokenizerSpec {
    return {
      ...this.#spec,
      added_tokens: this.#added.tokens().map((token) => ({
        id: token.id,
        content: token.content,
        single_word: token.singleWord,
        lstrip: token.lstrip,
        rstrip: token.rstrip,
        normalized: token.normalized,
        special: token.special,
      })),
      truncation: this.#truncation === null ? null : { ...this.#truncation },
      padding: this.#padding === null ? null : { ...this.#padding },
    };
  }

  /** Size of the base vocabulary, optionally including added tokens. */
  vocabSize(withAddedTokens = true): number {
    return this.#baseVocabSize + (withAddedTokens ? this.#added.size : 0);
  }

  /** The vocabulary as a plain object, optionally including added tokens. */
  getVocab(withAddedTokens = true): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [token, id] of this.#model.vocab()) out[token] = id;
    if (withAddedTokens) for (const token of this.#added.tokens()) out[token.content] = token.id;
    return out;
  }

  /** The id for a token, or `null` if it is not in the vocabulary. */
  tokenToId(token: string): number | null {
    return this.#added.get(token)?.id ?? this.#model.tokenToId(token) ?? null;
  }

  /** The token for an id, or `null` if the id is out of vocabulary. */
  idToToken(id: number): string | null {
    return this.#added.byId(id)?.content ?? this.#model.idToToken(id) ?? null;
  }

  /**
   * Register tokens matched literally, ahead of the model.
   *
   * A token already in the vocabulary keeps its id; a new one is assigned the
   * next free id. Returns how many were newly added.
   */
  addTokens(tokens: ReadonlyArray<string | (AddedTokenOptions & { content: string })>): number {
    let added = 0;
    for (const entry of tokens) {
      const content = typeof entry === 'string' ? entry : entry.content;
      const options = typeof entry === 'string' ? {} : entry;
      const existing = this.tokenToId(content);
      const id = existing ?? this.#nextId++;
      if (existing === null || this.#added.get(content) === undefined) added++;
      this.#added.add(makeAddedToken(id, content, options));
    }
    return added;
  }

  /** Register tokens matched literally and reported as special. */
  addSpecialTokens(
    tokens: ReadonlyArray<string | (AddedTokenOptions & { content: string })>,
  ): number {
    return this.addTokens(
      tokens.map((entry) =>
        typeof entry === 'string'
          ? { content: entry, special: true, normalized: false }
          : { normalized: false, ...entry, special: true },
      ),
    );
  }

  /** Truncation applied when a call does not override it. */
  get truncation(): TruncationOptions | null {
    return this.#truncation;
  }

  /** Padding applied when a call does not override it. */
  get padding(): PaddingOptions | null {
    return this.#padding;
  }

  /** Encode one input, or a sequence and its pair. */
  encode(input: EncodeInput, options: EncodeOptions = {}): Encoding {
    const [text, pair] = typeof input === 'string' ? [input, null] : [input[0], input[1]];
    const addSpecialTokens = options.addSpecialTokens ?? true;
    let first = this.#encodeText(text, 0);
    let second = pair === null ? null : this.#encodeText(pair, 1);
    const truncation = options.truncation !== undefined ? options.truncation : this.#truncation;
    if (truncation !== null) {
      const added = addSpecialTokens ? this.#postProcessor.addedTokens(second !== null) : 0;
      [first, second] = _truncate(first, second, truncation, added);
    }
    const out = this.#postProcessor.process(first, second, addSpecialTokens);
    // Each overflow window is post-processed in its own right, so a caller can
    // feed any of them to a model directly instead of reassembling the layout.
    out.overflowing = [
      ...first.overflowing.map((window) =>
        this.#postProcessor.process(window, second, addSpecialTokens),
      ),
      ...(second === null ? [] : second.overflowing).map((window) =>
        this.#postProcessor.process(first, window, addSpecialTokens),
      ),
    ];
    const padding = options.padding !== undefined ? options.padding : this.#padding;
    if (padding !== null) return _padOne(out, padding, this.#padLength(padding, out));
    return out;
  }

  /**
   * Encode several inputs.
   *
   * With padding enabled and no explicit `length`, every result is padded to the
   * longest in this batch — which is what makes a batch stackable into one tensor.
   */
  encodeBatch(inputs: readonly EncodeInput[], options: EncodeOptions = {}): Encoding[] {
    const encoded = inputs.map((input) => this.encode(input, { ...options, padding: null }));
    const padding = options.padding !== undefined ? options.padding : this.#padding;
    if (padding === null) return encoded;
    let longest = 0;
    for (const encoding of encoded) longest = Math.max(longest, encoding.ids.length);
    const target = _padTarget(padding, padding.length ?? longest);
    return encoded.map((encoding) => _padOne(encoding, padding, target));
  }

  #padLength(padding: PaddingOptions, encoding: Encoding): number {
    return _padTarget(padding, padding.length ?? encoding.ids.length);
  }

  /** Decode ids back into text. */
  decode(ids: readonly number[], options: DecodeOptions = {}): string {
    const skipSpecial = options.skipSpecialTokens ?? true;
    const tokens: string[] = [];
    for (const id of ids) {
      const added = this.#added.byId(id);
      if (added !== undefined) {
        if (skipSpecial && added.special) continue;
        tokens.push(added.content);
        continue;
      }
      const token = this.#model.idToToken(id);
      if (token !== undefined) tokens.push(token);
    }
    if (this.#decoder === null) return tokens.join(' ');
    return this.#decoder.decodeChain(tokens).join('');
  }

  /** Decode several id sequences. */
  decodeBatch(batch: ReadonlyArray<readonly number[]>, options?: DecodeOptions): string[] {
    return batch.map((ids) => this.decode(ids, options));
  }

  /** Run one input through normalize → pre-tokenize → model. */
  #encodeText(text: string, sequenceIndex: number): Encoding {
    const out = emptyEncoding();
    const source = new NormalizedString(text);
    for (const segment of this.#added.extract(text)) {
      if (segment.token !== null) {
        _pushAdded(out, segment.token, segment.start, segment.end, sequenceIndex);
        continue;
      }
      const raw = source.slice(segment.start, segment.end);
      const normalized = this.#normalizer === null ? raw : this.#normalizer.normalize(raw);
      // Added tokens flagged `normalized` only become visible once the
      // normalizer has run, so the scan repeats over the rewritten text.
      for (const inner of this.#added.extractNormalized(normalized)) {
        if (inner.token !== null) {
          const [start, end] = normalized.originalRange(inner.start, inner.end);
          _pushAdded(out, inner.token, start, end, sequenceIndex);
          continue;
        }
        this.#pushModelTokens(out, normalized.slice(inner.start, inner.end), sequenceIndex);
      }
    }
    return out;
  }

  #pushModelTokens(out: Encoding, value: NormalizedString, sequenceIndex: number): void {
    if (value.isEmpty) return;
    let splits: Split[] = [{ value, tokens: null }];
    if (this.#preTokenizer !== null) splits = this.#preTokenizer.preTokenize(splits);
    for (const split of splits) {
      for (const token of this.#model.tokenize(split.value.text)) {
        out.ids.push(token.id);
        out.tokens.push(token.value);
        out.typeIds.push(sequenceIndex);
        out.attentionMask.push(1);
        out.specialTokensMask.push(0);
        out.offsets.push(split.value.originalRange(token.start, token.end));
        out.sequenceIds.push(sequenceIndex);
      }
    }
  }
}

function _pushAdded(
  out: Encoding,
  token: AddedToken,
  start: number,
  end: number,
  sequenceIndex: number,
): void {
  out.ids.push(token.id);
  out.tokens.push(token.content);
  out.typeIds.push(sequenceIndex);
  out.attentionMask.push(1);
  out.specialTokensMask.push(token.special ? 1 : 0);
  out.offsets.push([start, end]);
  out.sequenceIds.push(sequenceIndex);
}

function _readTruncation(
  raw: Record<string, unknown> | null | undefined,
): TruncationOptions | null {
  if (raw === null || raw === undefined) return null;
  const maxLength = Number(raw.max_length ?? raw.maxLength);
  if (!Number.isFinite(maxLength)) return null;
  return {
    maxLength,
    strategy: (raw.strategy as TruncationOptions['strategy']) ?? 'longest_first',
    stride: Number(raw.stride ?? 0),
    direction: ((raw.direction as string) ?? 'right').toLowerCase() === 'left' ? 'left' : 'right',
  };
}

function _readPadding(raw: Record<string, unknown> | null | undefined): PaddingOptions | null {
  if (raw === null || raw === undefined) return null;
  const fixed = raw.strategy as { Fixed?: number } | string | undefined;
  const length = typeof fixed === 'object' && fixed !== null ? fixed.Fixed : undefined;
  return {
    length: typeof length === 'number' ? length : undefined,
    padToMultipleOf: (raw.pad_to_multiple_of as number | undefined) ?? undefined,
    direction: ((raw.direction as string) ?? 'right').toLowerCase() === 'left' ? 'left' : 'right',
    padId: Number(raw.pad_id ?? 0),
    padTypeId: Number(raw.pad_type_id ?? 0),
    padToken: (raw.pad_token as string) ?? '[PAD]',
  };
}

function _padTarget(padding: PaddingOptions, length: number): number {
  const multiple = padding.padToMultipleOf;
  if (multiple === undefined || multiple <= 0) return length;
  return Math.ceil(length / multiple) * multiple;
}

function _padOne(encoding: Encoding, padding: PaddingOptions, target: number): Encoding {
  const missing = target - encoding.ids.length;
  if (missing <= 0) return encoding;
  const out = cloneEncoding(encoding);
  const padId = padding.padId ?? 0;
  const padToken = padding.padToken ?? '[PAD]';
  const padTypeId = padding.padTypeId ?? 0;
  const ids = new Array<number>(missing).fill(padId);
  const tokens = new Array<string>(missing).fill(padToken);
  const typeIds = new Array<number>(missing).fill(padTypeId);
  const mask = new Array<number>(missing).fill(0);
  const special = new Array<number>(missing).fill(1);
  const offsets = Array.from({ length: missing }, () => [0, 0] as [number, number]);
  const sequences = new Array<number | null>(missing).fill(null);
  if ((padding.direction ?? 'right') === 'left') {
    out.ids = [...ids, ...out.ids];
    out.tokens = [...tokens, ...out.tokens];
    out.typeIds = [...typeIds, ...out.typeIds];
    out.attentionMask = [...mask, ...out.attentionMask];
    out.specialTokensMask = [...special, ...out.specialTokensMask];
    out.offsets = [...offsets, ...out.offsets];
    out.sequenceIds = [...sequences, ...out.sequenceIds];
  } else {
    out.ids.push(...ids);
    out.tokens.push(...tokens);
    out.typeIds.push(...typeIds);
    out.attentionMask.push(...mask);
    out.specialTokensMask.push(...special);
    out.offsets.push(...offsets);
    out.sequenceIds.push(...sequences);
  }
  out.overflowing = encoding.overflowing.map((over) => _padOne(over, padding, target));
  return out;
}

/**
 * Cut a sequence down to `limit`, keeping the dropped remainder as overflow.
 *
 * `stride` overlaps each window with the previous one so a span cut in half is
 * still fully visible in one of them.
 */
function _windows(encoding: Encoding, limit: number, stride: number, direction: string): Encoding {
  if (encoding.ids.length <= limit) return encoding;
  const step = Math.max(1, limit - Math.min(stride, Math.max(0, limit - 1)));
  const kept =
    direction === 'left'
      ? sliceEncoding(encoding, encoding.ids.length - limit, encoding.ids.length)
      : sliceEncoding(encoding, 0, limit);
  const overflowing: Encoding[] = [];
  if (direction === 'left') {
    for (let end = encoding.ids.length - step; end > 0; end -= step) {
      overflowing.push(sliceEncoding(encoding, Math.max(0, end - limit), end));
      if (end - limit <= 0) break;
    }
  } else {
    for (let start = step; start < encoding.ids.length; start += step) {
      overflowing.push(
        sliceEncoding(encoding, start, Math.min(start + limit, encoding.ids.length)),
      );
    }
  }
  kept.overflowing = overflowing;
  return kept;
}

/** Fit a sequence and its pair into the truncation budget. */
function _truncate(
  first: Encoding,
  second: Encoding | null,
  options: TruncationOptions,
  addedTokens: number,
): [Encoding, Encoding | null] {
  const limit = options.maxLength - addedTokens;
  const stride = options.stride ?? 0;
  const direction = options.direction ?? 'right';
  if (limit <= 0) {
    throw new Error(
      `tokenizer: truncation maxLength ${options.maxLength} leaves no room for content after ` +
        `${addedTokens} special tokens`,
    );
  }
  const strategy = options.strategy ?? 'longest_first';
  if (second === null) return [_windows(first, limit, stride, direction), null];
  if (strategy === 'only_first') return [_windows(first, limit, stride, direction), second];
  if (strategy === 'only_second') return [first, _windows(second, limit, stride, direction)];
  // `longest_first` shortens whichever sequence is currently longer, one token at
  // a time, so a long question against a short context keeps the context intact.
  let keepFirst = first.ids.length;
  let keepSecond = second.ids.length;
  while (keepFirst + keepSecond > limit) {
    if (keepFirst >= keepSecond) keepFirst--;
    else keepSecond--;
  }
  const cut = (encoding: Encoding, keep: number): Encoding =>
    keep >= encoding.ids.length
      ? encoding
      : direction === 'left'
        ? sliceEncoding(encoding, encoding.ids.length - keep, encoding.ids.length)
        : sliceEncoding(encoding, 0, keep);
  return [cut(first, keepFirst), cut(second, keepSecond)];
}
