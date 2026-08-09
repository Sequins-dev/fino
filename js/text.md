---
weight: 145
---

# Text

Tokenization turns text into the integer ids a model consumes, and back again.
`fino:text/tokenizer` loads the tokenizers published models actually ship with
and reproduces their encoding exactly, in pure TypeScript.

There is no native dependency by choice rather than by omission. Hugging Face's
`tokenizers` is Rust with no C ABI, and sentencepiece exposes C++ only, so
binding either would mean shipping a compiled artifact — and BPE and WordPiece
over a vocabulary are string processing that TypeScript does well.

## Loading a tokenizer

A Hugging Face `tokenizer.json` carries the whole pipeline: the vocabulary, the
merge table, and the normalizer, pre-tokenizer, post-processor, and decoder
stages that decide where token boundaries fall.

```ts no_run
import { Tokenizer } from 'fino:text/tokenizer';

const tokenizer = await Tokenizer.fromFile('./tokenizer.json');
const encoded = tokenizer.encode('Hello, world!');

console.log(encoded.ids);
console.log(encoded.tokens); // for a byte-level BPE: ['Hello', ',', 'Ġworld', '!']
console.log(tokenizer.decode(encoded.ids));
```

`Tokenizer.fromJSON` takes the same spec as an object or a JSON string, which is
how a vocabulary recovered from any other source is loaded — including a
llama.cpp GGUF vocabulary, reached by building a spec object rather than by this
module depending on llama.cpp.

## tiktoken

A `.tiktoken` file is a ranks table and nothing else, so the splitting pattern
and special tokens have to come from somewhere. Name a published encoding and
they are looked up:

```ts no_run
import { Tokenizer, TIKTOKEN_ENCODINGS } from 'fino:text/tokenizer';

const tokenizer = await Tokenizer.fromTiktokenFile('./cl100k_base.tiktoken', 'cl100k_base');
console.log(TIKTOKEN_ENCODINGS.cl100k_base.specialTokens['<|endoftext|>']); // 100257
```

`r50k_base`, `gpt2`, `p50k_base`, `p50k_edit`, `cl100k_base`, and `o200k_base`
are known. For an unlisted table, pass `pattern` and `specialTokens` to
`Tokenizer.fromTiktoken` directly.

## Offsets

`Encoding.offsets` index the *original* input string, not the normalized one, so
a span a model predicts can be mapped back onto the caller's own text even when
normalization changed its length:

```ts no_run
const text = 'The unaffable café.';
const encoded = tokenizer.encode(text);

for (const [index, [start, end]] of encoded.offsets.entries()) {
  console.log(encoded.tokens[index], '<-', text.slice(start, end));
}
```

A lowercasing, accent-stripping tokenizer emits the token `cafe`, and its offsets
still point at `café`. Special tokens that a post-processor added carry a
zero-width offset, which is how they are told apart from tokens that came from
real input.

## Pairs, truncation, and padding

Sequence pairs get the type ids the model expects, and a batch pads to its
longest member so it stacks into one tensor:

```ts no_run
const pair = tokenizer.encode(['what is this?', 'a long context passage'], {
  truncation: { maxLength: 128, strategy: 'only_second' },
});
console.log(pair.typeIds);

const batch = tokenizer.encodeBatch(['short', 'a somewhat longer input'], {
  padding: { padId: 0, padToken: '[PAD]' },
});
console.log(batch.map((encoding) => encoding.attentionMask));
```

Truncation is budgeted against the special tokens the post-processor will add, so
`maxLength` is the length of the final sequence rather than of its contents. What
does not fit is kept in `overflowing`, with `stride` overlapping each window so a
span cut in half stays fully visible in one of them. Each overflow window is
itself post-processed, so any of them can go straight to a model.

## Tokenizing a dataset

Encoding is deterministic and holds no state between calls, and a tokenizer
serializes back to the spec it was built from. That is what lets a
[`DataLoader`](./data.md) worker rebuild an identical tokenizer from a
structured-cloneable value and produce byte-identical ids:

```ts no_run
import { DataLoader, jsonlDataset } from 'fino:data/dataset';
import { Tokenizer } from 'fino:text/tokenizer';

const spec = (await Tokenizer.fromFile('./tokenizer.json')).toJSON();

const loader = new DataLoader(jsonlDataset('./corpus.jsonl'), {
  batchSize: 32,
  collate: (rows) => {
    // Workers rebuild from the spec rather than sharing an instance.
    const tokenizer = Tokenizer.fromJSON(spec);
    return tokenizer.encodeBatch(
      rows.map((row) => String((row as { text: string }).text)),
      { padding: { padId: 0, padToken: '[PAD]' } },
    );
  },
});
```

A single encode is CPU-bound and short, so dataset-scale tokenization is
parallelized by the loader rather than by making the tokenizer concurrent.

## What is not implemented

Two things are absent deliberately, and both throw a specific error rather than
degrading quietly, because a tokenizer that silently skips a stage produces ids
that look right and do not match what the model was trained on:

- **Unigram vocabularies** need the sentencepiece character map that accompanies
  them (`Precompiled`), and loading one without the other is not meaningful.
  The `UnicodeScripts` pre-tokenizer travels with the same family.
- **Tokenizer training.** Loading a published vocabulary and building a new one
  are different problems; only the first is covered.

The `NFKC` and `NFKD` normalizers are also refused, because this runtime's
`String.prototype.normalize` does not currently provide Unicode compatibility
normalization. `NFC`, `NFD`, `BertNormalizer`, `Replace`, `Prepend`, `Strip`,
`StripAccents`, `Nmt`, and `Sequence` all work.
