/**
 * Tests for `fino:text/tokenizer`.
 *
 * The vocabularies here are hand-built and small enough that every expected id
 * is derivable by hand from the merge table, which is the point: a golden file
 * copied from another implementation would test that the two agree without
 * either being checked against the algorithm.
 *
 * The byte-alphabet anchors are the exception — those are fixed facts about the
 * GPT-2 wire format (`Ġ` for a space, `Ċ` for a newline) and are asserted
 * literally, because getting them wrong silently changes every id.
 */
import { describe, it } from 'fino:test/test';
import {
  TIKTOKEN_ENCODINGS,
  Tokenizer,
  byteAlphabet,
  parseTiktokenRanks,
  type TokenizerSpec,
} from 'fino:text/tokenizer';

/** A byte-level BPE whose merges spell out `Hello` and `Ġworld`. */
function byteLevelSpec(overrides: Partial<TokenizerSpec> = {}): TokenizerSpec {
  return {
    model: {
      type: 'BPE',
      vocab: {
        Ġ: 0,
        H: 1,
        e: 2,
        l: 3,
        o: 4,
        w: 5,
        r: 6,
        d: 7,
        '!': 8,
        ',': 9,
        He: 10,
        ll: 11,
        llo: 12,
        Hello: 13,
        Ġw: 14,
        or: 15,
        Ġwor: 16,
        ld: 17,
        Ġworld: 18,
      },
      merges: ['H e', 'l l', 'll o', 'He llo', 'Ġ w', 'o r', 'Ġw or', 'l d', 'Ġwor ld'],
    },
    pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, use_regex: true },
    decoder: { type: 'ByteLevel' },
    post_processor: { type: 'ByteLevel', trim_offsets: true, add_prefix_space: false },
    ...overrides,
  };
}

/** A WordPiece vocabulary shaped like a lowercasing BERT. */
function bertSpec(overrides: Partial<TokenizerSpec> = {}): TokenizerSpec {
  return {
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab: {
        '[PAD]': 0,
        '[UNK]': 1,
        '[CLS]': 2,
        '[SEP]': 3,
        un: 4,
        '##aff': 5,
        '##able': 6,
        the: 7,
        cat: 8,
        '.': 9,
        cafe: 10,
        中: 11,
        文: 12,
      },
    },
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: { type: 'BertProcessing', cls: ['[CLS]', 2], sep: ['[SEP]', 3] },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    added_tokens: [
      { id: 0, content: '[PAD]', special: true },
      { id: 1, content: '[UNK]', special: true },
      { id: 2, content: '[CLS]', special: true },
      { id: 3, content: '[SEP]', special: true },
    ],
    ...overrides,
  };
}

/** Build a `.tiktoken` ranks file from raw byte-string tokens. */
function tiktokenFile(tokens: readonly string[]): string {
  const encoder = new TextEncoder();
  return tokens
    .map((token, rank) => {
      const bytes = encoder.encode(token);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `${btoa(binary)} ${rank}`;
    })
    .join('\n');
}

describe('byte-level alphabet', () => {
  it('matches the published GPT-2 byte construction', async (t) => {
    const alphabet = byteAlphabet();
    t.equal(alphabet.length, 256, 'one stand-in per byte value');
    t.equal(new Set(alphabet).size, 256, 'the mapping is a bijection');
    // Fixed facts about the wire format: getting any of these wrong silently
    // changes every id a published vocabulary produces.
    t.equal(alphabet[0x20], '\u0120', 'a space is \u0120');
    t.equal(alphabet[0x0a], '\u010a', 'a newline is \u010a');
    t.equal(alphabet[0x00], '\u0100', 'NUL is \u0100');
    t.equal(alphabet[0xad], '\u0143', 'a soft hyphen is \u0143');
    t.equal(alphabet[0x41], 'A', 'a printable byte stands for itself');
    t.equal(alphabet[0xa9], '\u00a9', 'a printable high byte stands for itself');
  });

  it('round-trips arbitrary text through encode and decode', async (t) => {
    const vocab: Record<string, number> = {};
    byteAlphabet().forEach((char, id) => {
      vocab[char] = id;
    });
    const tokenizer = Tokenizer.fromJSON({
      model: { type: 'BPE', vocab, merges: [] },
      pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
      decoder: { type: 'ByteLevel' },
    });
    for (const sample of [
      'hello',
      'h\u00e9llo w\u00f6rld',
      '\u4e2d\u6587\u30c6\u30b9\u30c8',
      '\ud83c\udf89 emoji',
      '\t\n mixed \u00ad',
    ]) {
      const encoded = tokenizer.encode(sample);
      t.equal(tokenizer.decode(encoded.ids), sample, `round-trips ${JSON.stringify(sample)}`);
    }
  });

  it('decodes a character split across two tokens', async (t) => {
    const vocab: Record<string, number> = {};
    byteAlphabet().forEach((char, id) => {
      vocab[char] = id;
    });
    const tokenizer = Tokenizer.fromJSON({
      model: { type: 'BPE', vocab, merges: [] },
      pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
      decoder: { type: 'ByteLevel' },
    });
    // Every token here is a single byte, so the emoji spans four of them and can
    // only decode correctly if the decoder joins bytes before decoding UTF-8.
    const encoded = tokenizer.encode('\ud83c\udf89');
    t.equal(encoded.ids.length, 4, 'the emoji is four separate byte tokens');
    t.equal(tokenizer.decode(encoded.ids), '\ud83c\udf89');
  });
});

describe('BPE encoding', () => {
  it('applies merges in rank order and reports original offsets', async (t) => {
    const tokenizer = Tokenizer.fromJSON(byteLevelSpec());
    const encoded = tokenizer.encode('Hello, world!');

    t.deepEqual(encoded.tokens, ['Hello', ',', 'Ġworld', '!']);
    t.deepEqual(encoded.ids, [13, 9, 18, 8]);
    t.deepEqual(encoded.attentionMask, [1, 1, 1, 1]);
    t.deepEqual(encoded.specialTokensMask, [0, 0, 0, 0]);
    t.deepEqual(
      encoded.offsets,
      [
        [0, 5],
        [5, 6],
        [7, 12],
        [12, 13],
      ],
      'trim_offsets moves Ġworld past the space it absorbed',
    );
    t.equal('Hello, world!'.slice(7, 12), 'world', 'the offset indexes the original text');
    t.equal(tokenizer.decode(encoded.ids), 'Hello, world!');
  });

  it('keeps offsets untrimmed when trim_offsets is off', async (t) => {
    const tokenizer = Tokenizer.fromJSON(
      byteLevelSpec({
        post_processor: { type: 'ByteLevel', trim_offsets: false, add_prefix_space: false },
      }),
    );
    t.deepEqual(tokenizer.encode('Hello, world!').offsets[2], [6, 12]);
  });

  it('treats a leading word like a mid-sentence word when add_prefix_space is set', async (t) => {
    const tokenizer = Tokenizer.fromJSON(
      byteLevelSpec({
        pre_tokenizer: { type: 'ByteLevel', add_prefix_space: true, use_regex: true },
      }),
    );
    t.deepEqual(tokenizer.encode('world').tokens, ['Ġworld']);
    t.deepEqual(tokenizer.encode(' world').tokens, ['Ġworld'], 'the prefix space is idempotent');
  });

  it('splits on the GPT-2 contraction boundaries', async (t) => {
    const tokenizer = Tokenizer.fromJSON({
      model: {
        type: 'BPE',
        vocab: { I: 0, "'": 1, m: 2, "'m": 3, Ġa: 4, a: 5, Ġ: 6 },
        merges: ["' m", 'Ġ a'],
      },
      pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, use_regex: true },
      decoder: { type: 'ByteLevel' },
    });
    t.deepEqual(tokenizer.encode("I'm a").tokens, ['I', "'m", 'Ġa']);
  });

  it('honors end_of_word_suffix and its decoder', async (t) => {
    const tokenizer = Tokenizer.fromJSON({
      model: {
        type: 'BPE',
        end_of_word_suffix: '</w>',
        vocab: {
          l: 0,
          o: 1,
          w: 2,
          'w</w>': 3,
          lo: 4,
          'low</w>': 5,
          'lo w</w>': 6,
        },
        merges: ['l o', 'lo w</w>'],
      },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      decoder: { type: 'BPEDecoder', suffix: '</w>' },
    });
    const encoded = tokenizer.encode('low');
    t.deepEqual(encoded.tokens, ['low</w>']);
    t.equal(tokenizer.decode(encoded.ids), 'low');
  });

  it('falls back to byte tokens when a character is out of vocabulary', async (t) => {
    const vocab: Record<string, number> = { a: 0 };
    let next = 1;
    for (let byte = 0; byte < 256; byte++) {
      vocab[`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`] = next++;
    }
    const tokenizer = Tokenizer.fromJSON({
      model: { type: 'BPE', vocab, merges: [], byte_fallback: true },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      decoder: { type: 'Sequence', decoders: [{ type: 'ByteFallback' }, { type: 'Fuse' }] },
    });
    const encoded = tokenizer.encode('aé');
    t.deepEqual(encoded.tokens, ['a', '<0xC3>', '<0xA9>'], 'é becomes its two UTF-8 bytes');
    t.equal(tokenizer.decode(encoded.ids), 'aé', 'ByteFallback reassembles the character');
  });

  it('fuses consecutive unknown characters when fuse_unk is set', async (t) => {
    const spec = {
      model: {
        type: 'BPE',
        vocab: { '<unk>': 0, a: 1 },
        merges: [],
        unk_token: '<unk>',
        fuse_unk: true,
      },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      decoder: null,
    };
    const fused = Tokenizer.fromJSON(spec as TokenizerSpec);
    const encoded = fused.encode('axya');
    t.deepEqual(encoded.tokens, ['a', '<unk>', 'a'], 'xy collapses to one unknown');
    t.deepEqual(encoded.offsets[1], [1, 3], 'the fused offsets span both characters');

    const unfused = Tokenizer.fromJSON({
      ...spec,
      model: { ...spec.model, fuse_unk: false },
    } as TokenizerSpec);
    t.deepEqual(unfused.encode('axya').tokens, ['a', '<unk>', '<unk>', 'a']);
  });

  it('short-circuits whole words when ignore_merges is set', async (t) => {
    const spec = byteLevelSpec();
    const model = { ...(spec.model as Record<string, unknown>) };
    const vocab = { ...(model.vocab as Record<string, number>), 'Hello,': 99 };
    const tokenizer = Tokenizer.fromJSON({
      ...spec,
      model: { ...model, vocab, ignore_merges: true },
      pre_tokenizer: { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
    });
    t.deepEqual(tokenizer.encode('Hello,').tokens, ['Hello,'], 'the whole span is taken as-is');
  });

  it('rejects a nondeterministic dropout setting', async (t) => {
    t.throws(
      () =>
        Tokenizer.fromJSON({
          model: { type: 'BPE', vocab: { a: 0 }, merges: [], dropout: 0.1 },
        }),
      /dropout/i,
    );
  });

  it('skips merges whose product was pruned from the vocabulary', async (t) => {
    const tokenizer = Tokenizer.fromJSON({
      model: {
        type: 'BPE',
        vocab: { a: 0, b: 1, c: 2, bc: 3 },
        // `ab` is ranked first but absent from the vocabulary, so it cannot apply
        // and must not shift `b c`'s effective rank into a different outcome.
        merges: ['a b', 'b c'],
      },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      decoder: null,
    });
    t.deepEqual(tokenizer.encode('abc').tokens, ['a', 'bc']);
  });
});

describe('WordPiece encoding', () => {
  it('splits greedily longest-first with the continuation prefix', async (t) => {
    const tokenizer = Tokenizer.fromJSON(bertSpec());
    const encoded = tokenizer.encode('The unaffable café.');

    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'un', '##aff', '##able', 'cafe', '.', '[SEP]']);
    t.deepEqual(encoded.ids, [2, 7, 4, 5, 6, 10, 9, 3]);
    t.deepEqual(encoded.specialTokensMask, [1, 0, 0, 0, 0, 0, 0, 1]);
    t.deepEqual(encoded.offsets, [
      [0, 0],
      [0, 3],
      [4, 6],
      [6, 9],
      [9, 13],
      [14, 18],
      [18, 19],
      [19, 19],
    ]);
    t.equal(
      'The unaffable café.'.slice(14, 18),
      'café',
      'the accent-stripped token still points at the original characters',
    );
    t.equal(tokenizer.decode(encoded.ids), 'the unaffable cafe.');
    t.equal(
      tokenizer.decode(encoded.ids, { skipSpecialTokens: false }),
      '[CLS] the unaffable cafe. [SEP]',
    );
  });

  it('emits one unknown for a word it cannot cover', async (t) => {
    const tokenizer = Tokenizer.fromJSON(bertSpec());
    const encoded = tokenizer.encode('zebra', { addSpecialTokens: false });
    t.deepEqual(encoded.tokens, ['[UNK]']);
    t.deepEqual(encoded.offsets, [[0, 5]], 'the unknown covers the whole word');
  });

  it('emits one unknown for a word past max_input_chars_per_word', async (t) => {
    const spec = bertSpec();
    const tokenizer = Tokenizer.fromJSON({
      ...spec,
      model: { ...(spec.model as Record<string, unknown>), max_input_chars_per_word: 8 },
    });
    // `un` + `##aff` + `##able` covers this word at the default limit, but it is
    // nine characters against a limit of eight.
    t.deepEqual(tokenizer.encode('unaffable', { addSpecialTokens: false }).tokens, ['[UNK]']);
    t.deepEqual(
      Tokenizer.fromJSON(spec).encode('unaffable', { addSpecialTokens: false }).tokens,
      ['un', '##aff', '##able'],
      'the same word splits normally under the default limit',
    );
  });

  it('isolates CJK characters so a per-character vocabulary matches', async (t) => {
    const tokenizer = Tokenizer.fromJSON(bertSpec());
    t.deepEqual(tokenizer.encode('中文', { addSpecialTokens: false }).tokens, ['中', '文']);
  });

  it('assigns type ids across a sequence pair', async (t) => {
    const tokenizer = Tokenizer.fromJSON(bertSpec());
    const encoded = tokenizer.encode(['the cat', 'the cat']);
    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'cat', '[SEP]', 'the', 'cat', '[SEP]']);
    t.deepEqual(encoded.typeIds, [0, 0, 0, 0, 1, 1, 1]);
    t.deepEqual(encoded.sequenceIds, [null, 0, 0, null, 1, 1, null]);
  });

  it('keeps every token at type id zero for a RoBERTa-style pair', async (t) => {
    const tokenizer = Tokenizer.fromJSON(
      bertSpec({
        post_processor: { type: 'RobertaProcessing', cls: ['[CLS]', 2], sep: ['[SEP]', 3] },
      }),
    );
    const encoded = tokenizer.encode(['the cat', 'the cat']);
    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'cat', '[SEP]', '[SEP]', 'the', 'cat', '[SEP]']);
    t.deepEqual(encoded.typeIds, [0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('normalizers', () => {
  it('keeps offsets aligned across a length-changing normalization', async (t) => {
    // The vocabulary is spelled in the decomposed form NFD produces: `e`
    // followed by the combining acute U+0301, rather than the single
    // precomposed character U+00E9 the input uses.
    const tokenizer = Tokenizer.fromJSON({
      model: {
        type: 'WordPiece',
        vocab: { '[UNK]': 0, 'e\u0301te': 1, test: 2 },
        unk_token: '[UNK]',
      },
      normalizer: { type: 'NFD' },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      decoder: null,
    });
    // The input is the precomposed spelling: three characters, four normalized.
    const encoded = tokenizer.encode('\u00e9te test', { addSpecialTokens: false });
    t.deepEqual(encoded.tokens, ['e\u0301te', 'test']);
    t.deepEqual(
      encoded.offsets[0],
      [0, 3],
      'the four-character token maps back to the three it came from',
    );
    t.deepEqual(encoded.offsets[1], [4, 8]);
    t.equal('\u00e9te test'.slice(0, 3), '\u00e9te', 'the offset indexes the original string');
  });

  it('refuses the compatibility normalization forms this runtime cannot do', async (t) => {
    // String.prototype.normalize('NFKC') crashes the process on this V8 build,
    // so the tokenizer must reject the spec rather than reach it.
    for (const type of ['NFKC', 'NFKD']) {
      t.throws(
        () =>
          Tokenizer.fromJSON({
            model: { type: 'WordPiece', vocab: { '[UNK]': 0 }, unk_token: '[UNK]' },
            normalizer: { type },
          }),
        /compatibility normalization/i,
        `${type} is refused with an explanation`,
      );
    }
  });

  it('applies a normalizer sequence in order', async (t) => {
    const tokenizer = Tokenizer.fromJSON({
      model: { type: 'WordPiece', vocab: { '[UNK]': 0, abc: 1 }, unk_token: '[UNK]' },
      normalizer: {
        type: 'Sequence',
        normalizers: [
          { type: 'Replace', pattern: { String: '-' }, content: '' },
          { type: 'Lowercase' },
        ],
      },
      pre_tokenizer: { type: 'WhitespaceSplit' },
      decoder: null,
    });
    t.deepEqual(tokenizer.encode('A-B-C', { addSpecialTokens: false }).tokens, ['abc']);
  });

  it('refuses a sentencepiece character map instead of ignoring it', async (t) => {
    t.throws(
      () =>
        Tokenizer.fromJSON({
          model: { type: 'WordPiece', vocab: { '[UNK]': 0 }, unk_token: '[UNK]' },
          normalizer: { type: 'Precompiled', precompiled_charsmap: '' },
        }),
      /Precompiled|Unigram/i,
    );
  });
});

describe('Metaspace', () => {
  it('round-trips sentencepiece-style word marks', async (t) => {
    const tokenizer = Tokenizer.fromJSON({
      model: {
        type: 'BPE',
        vocab: {
          '▁': 0,
          t: 1,
          h: 2,
          e: 3,
          c: 4,
          a: 5,
          '▁t': 6,
          '▁th': 7,
          '▁the': 8,
          '▁c': 9,
          '▁ca': 10,
          '▁cat': 11,
        },
        merges: ['▁ t', '▁t h', '▁th e', '▁ c', '▁c a', '▁ca t'],
      },
      pre_tokenizer: { type: 'Metaspace', replacement: '▁', prepend_scheme: 'always', split: true },
      decoder: { type: 'Metaspace', replacement: '▁', prepend_scheme: 'always' },
    });
    const encoded = tokenizer.encode('the cat');
    t.deepEqual(encoded.tokens, ['▁the', '▁cat']);
    t.deepEqual(encoded.offsets, [
      [0, 3],
      [3, 7],
    ]);
    t.equal(tokenizer.decode(encoded.ids), 'the cat', 'the prepended mark is not a space');
  });
});

describe('added tokens', () => {
  it('matches special tokens ahead of the model', async (t) => {
    const tokenizer = Tokenizer.fromJSON(
      byteLevelSpec({
        added_tokens: [{ id: 50, content: '<|endoftext|>', special: true, normalized: false }],
        post_processor: null,
      }),
    );
    const encoded = tokenizer.encode('Hello<|endoftext|>Hello');
    t.deepEqual(encoded.tokens, ['Hello', '<|endoftext|>', 'Hello']);
    t.deepEqual(encoded.ids, [13, 50, 13]);
    t.deepEqual(encoded.specialTokensMask, [0, 1, 0]);
    t.deepEqual(encoded.offsets[1], [5, 18]);
    t.equal(tokenizer.decode(encoded.ids), 'HelloHello', 'special tokens are skipped by default');
    t.equal(tokenizer.decode(encoded.ids, { skipSpecialTokens: false }), 'Hello<|endoftext|>Hello');
  });

  it('matches the longest added token at a position', async (t) => {
    const tokenizer = Tokenizer.fromJSON(
      byteLevelSpec({
        added_tokens: [
          { id: 60, content: '<|end|>', special: true, normalized: false },
          { id: 61, content: '<|end|><|end|>', special: true, normalized: false },
        ],
        post_processor: null,
      }),
    );
    t.deepEqual(tokenizer.encode('<|end|><|end|>').ids, [61], 'the longer token wins');
  });

  it('honors single_word, lstrip, and rstrip', async (t) => {
    const single = Tokenizer.fromJSON(
      byteLevelSpec({
        added_tokens: [
          { id: 70, content: 'or', special: false, normalized: false, single_word: true },
        ],
        post_processor: null,
      }),
    );
    t.equal(single.encode('world').ids.includes(70), false, 'no match inside a word');
    t.equal(single.encode('or').ids.includes(70), true, 'matches when standing alone');

    const stripped = Tokenizer.fromJSON(
      byteLevelSpec({
        added_tokens: [
          {
            id: 71,
            content: '<sep>',
            special: true,
            normalized: false,
            lstrip: true,
            rstrip: true,
          },
        ],
        post_processor: null,
      }),
    );
    const encoded = stripped.encode('Hello  <sep>  Hello');
    t.deepEqual(encoded.ids, [13, 71, 13]);
    t.deepEqual(encoded.offsets[1], [5, 14], 'the offsets absorb the surrounding whitespace');
  });

  it('adds tokens after construction and keeps them in the serialized spec', async (t) => {
    const tokenizer = Tokenizer.fromJSON(byteLevelSpec({ post_processor: null }));
    const added = tokenizer.addSpecialTokens(['<|pad|>']);
    t.equal(added, 1);
    const id = tokenizer.tokenToId('<|pad|>');
    t.ok(id !== null && id >= 19, 'the new token took the next free id');
    t.deepEqual(tokenizer.encode('Hello<|pad|>').tokens, ['Hello', '<|pad|>']);

    const rebuilt = Tokenizer.fromJSON(JSON.parse(JSON.stringify(tokenizer.toJSON())));
    t.deepEqual(rebuilt.encode('Hello<|pad|>').ids, tokenizer.encode('Hello<|pad|>').ids);
  });

  it('reports vocabulary lookups through added tokens', async (t) => {
    const tokenizer = Tokenizer.fromJSON(bertSpec());
    t.equal(tokenizer.tokenToId('[CLS]'), 2);
    t.equal(tokenizer.idToToken(2), '[CLS]');
    t.equal(tokenizer.tokenToId('nope'), null);
    t.equal(tokenizer.idToToken(9999), null);
    t.equal(tokenizer.vocabSize(false), 13, 'the base vocabulary is the model vocabulary');
  });
});

describe('template post-processing', () => {
  it('assembles a custom template', async (t) => {
    const tokenizer = Tokenizer.fromJSON(
      byteLevelSpec({
        added_tokens: [
          { id: 40, content: '<s>', special: true, normalized: false },
          { id: 41, content: '</s>', special: true, normalized: false },
        ],
        post_processor: {
          type: 'TemplateProcessing',
          single: [
            { SpecialToken: { id: '<s>', type_id: 0 } },
            { Sequence: { id: 'A', type_id: 0 } },
            { SpecialToken: { id: '</s>', type_id: 0 } },
          ],
          pair: [
            { Sequence: { id: 'A', type_id: 0 } },
            { SpecialToken: { id: '</s>', type_id: 0 } },
            { Sequence: { id: 'B', type_id: 1 } },
          ],
          special_tokens: {
            '<s>': { id: '<s>', ids: [40], tokens: ['<s>'] },
            '</s>': { id: '</s>', ids: [41], tokens: ['</s>'] },
          },
        },
      }),
    );
    const single = tokenizer.encode('Hello');
    t.deepEqual(single.ids, [40, 13, 41]);
    t.deepEqual(single.specialTokensMask, [1, 0, 1]);

    const pair = tokenizer.encode(['Hello', 'Hello']);
    t.deepEqual(pair.ids, [13, 41, 13]);
    t.deepEqual(pair.typeIds, [0, 0, 1]);

    t.deepEqual(
      tokenizer.encode('Hello', { addSpecialTokens: false }).ids,
      [13],
      'the template is skipped on request',
    );
  });
});

describe('truncation and padding', () => {
  const spec = bertSpec();

  it('truncates a single sequence within the special-token budget', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: { maxLength: 4 },
      padding: null,
    });
    const encoded = tokenizer.encode('the cat the cat');
    t.equal(encoded.ids.length, 4, 'CLS and SEP are counted against maxLength');
    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'cat', '[SEP]']);
  });

  it('shortens the longer side under longest_first', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: { maxLength: 7, strategy: 'longest_first' },
      padding: null,
    });
    const encoded = tokenizer.encode(['the cat the cat', 'the']);
    t.equal(encoded.ids.length, 7);
    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'cat', 'the', '[SEP]', 'the', '[SEP]']);
  });

  it('keeps the remainder as overflow with a stride overlap', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: { maxLength: 4, strategy: 'only_first', stride: 1 },
      padding: null,
    });
    const encoded = tokenizer.encode('the cat the cat the cat');
    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'cat', '[SEP]']);
    t.ok(encoded.overflowing.length > 0, 'the dropped tail is reachable');
    t.deepEqual(
      encoded.overflowing[0].tokens,
      ['[CLS]', 'cat', 'the', '[SEP]'],
      'the window overlaps by the stride and is itself model-ready',
    );
  });

  it('keeps the tail when truncating from the left', async (t) => {
    const right = Tokenizer.fromJSON(spec, {
      truncation: { maxLength: 4, direction: 'right' },
      padding: null,
    });
    const left = Tokenizer.fromJSON(spec, {
      truncation: { maxLength: 4, direction: 'left' },
      padding: null,
    });
    t.deepEqual(right.encode('the cat the cat').tokens, ['[CLS]', 'the', 'cat', '[SEP]']);
    t.deepEqual(
      left.encode('the cat the cat').tokens,
      ['[CLS]', 'the', 'cat', '[SEP]'],
      'the last two content tokens are kept',
    );
    t.deepEqual(
      left.encode('the cat the').tokens,
      ['[CLS]', 'cat', 'the', '[SEP]'],
      'and they are the tail, not the head',
    );
  });

  it('walks overflow windows backwards when truncating from the left', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: { maxLength: 4, direction: 'left', strategy: 'only_first', stride: 1 },
      padding: null,
    });
    const encoded = tokenizer.encode('the cat the cat the');
    t.deepEqual(encoded.tokens, ['[CLS]', 'cat', 'the', '[SEP]'], 'the kept window is the tail');
    t.ok(encoded.overflowing.length > 0, 'earlier windows are reachable');
    t.deepEqual(
      encoded.overflowing[0].tokens,
      ['[CLS]', 'the', 'cat', '[SEP]'],
      'the first overflow window is the one just before the tail',
    );
  });

  it('refuses a budget that leaves no room for content', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, { truncation: { maxLength: 2 }, padding: null });
    t.throws(() => tokenizer.encode('the cat'), /no room/i);
  });

  it('pads a single sequence to a fixed length', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: null,
      padding: { length: 6, padId: 0, padToken: '[PAD]' },
    });
    const encoded = tokenizer.encode('the cat');
    t.deepEqual(encoded.tokens, ['[CLS]', 'the', 'cat', '[SEP]', '[PAD]', '[PAD]']);
    t.deepEqual(encoded.attentionMask, [1, 1, 1, 1, 0, 0]);
    t.deepEqual(encoded.offsets[5], [0, 0]);
  });

  it('pads on the left when asked', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: null,
      padding: { length: 6, direction: 'left', padId: 0, padToken: '[PAD]' },
    });
    t.deepEqual(tokenizer.encode('the cat').tokens, [
      '[PAD]',
      '[PAD]',
      '[CLS]',
      'the',
      'cat',
      '[SEP]',
    ]);
  });

  it('rounds a padded length up to a multiple', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: null,
      padding: { padToMultipleOf: 8, padId: 0, padToken: '[PAD]' },
    });
    t.equal(tokenizer.encode('the cat').ids.length, 8);
  });

  it('pads a batch to its longest member', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: null,
      padding: { padId: 0, padToken: '[PAD]' },
    });
    const batch = tokenizer.encodeBatch(['the', 'the cat', 'the cat the']);
    t.deepEqual(
      batch.map((encoding) => encoding.ids.length),
      [5, 5, 5],
      'every member is stackable into one tensor',
    );
    t.deepEqual(batch[0].tokens, ['[CLS]', 'the', '[SEP]', '[PAD]', '[PAD]']);
    t.deepEqual(batch[0].attentionMask, [1, 1, 1, 0, 0]);
  });

  it('leaves a batch ragged when padding is disabled per call', async (t) => {
    const tokenizer = Tokenizer.fromJSON(spec, {
      truncation: null,
      padding: { padId: 0, padToken: '[PAD]' },
    });
    const batch = tokenizer.encodeBatch(['the', 'the cat'], { padding: null });
    t.deepEqual(
      batch.map((encoding) => encoding.ids.length),
      [3, 4],
    );
  });
});

describe('tiktoken', () => {
  it('exposes the published encoding configurations', async (t) => {
    t.equal(TIKTOKEN_ENCODINGS.cl100k_base.specialTokens['<|endoftext|>'], 100257);
    t.equal(TIKTOKEN_ENCODINGS.o200k_base.specialTokens['<|endoftext|>'], 199999);
    t.equal(TIKTOKEN_ENCODINGS.r50k_base.specialTokens['<|endoftext|>'], 50256);
    t.ok(
      TIKTOKEN_ENCODINGS.cl100k_base.pattern.includes("(?i:'s|'t|'re|'ve|'m|'ll|'d)"),
      'cl100k matches contractions case-insensitively',
    );
    for (const [name, encoding] of Object.entries(TIKTOKEN_ENCODINGS)) {
      t.ok(new RegExp(encoding.pattern, 'gu') instanceof RegExp, `${name} pattern compiles`);
    }
  });

  it('parses a ranks file and merges by rank', async (t) => {
    // Ranks are the merge table: the lowest-ranked adjacent pair merges first.
    const ranks = tiktokenFile([
      'h',
      'i',
      't',
      'e',
      'r',
      ' ',
      'hi',
      ' there',
      'th',
      'the',
      'ther',
      'there',
      ' t',
    ]);
    const tokenizer = Tokenizer.fromTiktoken({
      vocab: parseTiktokenRanks(ranks),
      pattern: TIKTOKEN_ENCODINGS.cl100k_base.pattern,
      specialTokens: { '<|endoftext|>': 999 },
    });
    const encoded = tokenizer.encode('hi there');
    t.deepEqual(encoded.tokens.length > 0, true);
    t.equal(tokenizer.decode(encoded.ids), 'hi there', 'decoding recovers the input');
    t.deepEqual(encoded.ids, [6, 7], 'hi and " there" are single ranks');
  });

  it('treats special tokens literally and survives a spec round-trip', async (t) => {
    const ranks = tiktokenFile(['h', 'i', 'hi']);
    const tokenizer = Tokenizer.fromTiktoken({
      vocab: parseTiktokenRanks(ranks),
      pattern: TIKTOKEN_ENCODINGS.cl100k_base.pattern,
      specialTokens: { '<|endoftext|>': 100 },
    });
    const encoded = tokenizer.encode('hi<|endoftext|>hi');
    t.deepEqual(encoded.ids, [2, 100, 2]);
    t.deepEqual(encoded.specialTokensMask, [0, 1, 0]);

    const rebuilt = Tokenizer.fromJSON(JSON.parse(JSON.stringify(tokenizer.toJSON())));
    t.deepEqual(
      rebuilt.encode('hi<|endoftext|>hi').ids,
      encoded.ids,
      'a worker rebuilding from the spec produces identical ids',
    );
  });

  it('requires a splitting pattern, which ranks alone do not carry', async (t) => {
    t.throws(() => Tokenizer.fromTiktoken({ vocab: { a: 0 } }), /pattern/i);
  });

  it('reports a ranks table that does not cover every single byte', async (t) => {
    const tokenizer = Tokenizer.fromTiktoken({
      vocab: parseTiktokenRanks(tiktokenFile(['h', 'i'])),
      pattern: TIKTOKEN_ENCODINGS.cl100k_base.pattern,
    });
    t.throws(() => tokenizer.encode('hz'), /all 256 single bytes/i);
  });

  it('rejects a malformed ranks line rather than dropping it', async (t) => {
    t.throws(() => parseTiktokenRanks('aGk='), /base64|rank|<rank>/i);
    t.throws(() => parseTiktokenRanks('aGk= notanumber'), /rank/i);
  });
});

describe('unsupported configurations', () => {
  it('names what is missing instead of degrading quietly', async (t) => {
    t.throws(() => Tokenizer.fromJSON({ model: { type: 'Unigram', vocab: [] } }), /Unigram/i);
    t.throws(() => Tokenizer.fromJSON({ model: { type: 'Nonesuch' } }), /unsupported model type/i);
    t.throws(
      () =>
        Tokenizer.fromJSON({
          model: { type: 'BPE', vocab: { a: 0 }, merges: [] },
          pre_tokenizer: { type: 'UnicodeScripts' },
        }),
      /UnicodeScripts/i,
    );
    t.throws(
      () =>
        Tokenizer.fromJSON({
          model: { type: 'BPE', vocab: { a: 0 }, merges: [] },
          decoder: { type: 'Nonesuch' },
        }),
      /unsupported decoder/i,
    );
    t.throws(
      () =>
        Tokenizer.fromJSON({ model: { type: 'BPE', vocab: {}, merges: [], unk_token: '<unk>' } }),
      /not in the vocabulary/i,
    );
    t.throws(() => Tokenizer.fromJSON('{"nope":1}'), /model/i);
  });
});

describe('determinism', () => {
  it('produces identical ids across repeated and rebuilt tokenizers', async (t) => {
    const tokenizer = Tokenizer.fromJSON(byteLevelSpec());
    const samples = ['Hello, world!', 'Hello', ' world', 'Hello Hello world', ''];
    const first = samples.map((text) => tokenizer.encode(text).ids);
    const second = samples.map((text) => tokenizer.encode(text).ids);
    t.deepEqual(second, first, 'encoding holds no state between calls');

    const spec = JSON.parse(JSON.stringify(tokenizer.toJSON()));
    const rebuilt = Tokenizer.fromJSON(spec);
    t.deepEqual(
      samples.map((text) => rebuilt.encode(text).ids),
      first,
      'a tokenizer rebuilt from its spec agrees exactly',
    );
    t.deepEqual(
      JSON.parse(JSON.stringify(rebuilt.toJSON())),
      spec,
      'the spec is a fixed point, so worker transfer is stable',
    );
  });

  it('serializes to a structured-cloneable value for worker transfer', async (t) => {
    const tokenizer = Tokenizer.fromJSON(bertSpec());
    const cloned = structuredClone(tokenizer.toJSON());
    const rebuilt = Tokenizer.fromJSON(cloned as TokenizerSpec);
    t.deepEqual(rebuilt.encode('the cat').ids, tokenizer.encode('the cat').ids);
  });
});
