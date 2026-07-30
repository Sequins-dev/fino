/**
 * Tokenization models — BPE and WordPiece.
 *
 * These are the two algorithms that cover the published vocabularies worth
 * loading: byte-level BPE for the GPT/Llama/Falcon line and WordPiece for the
 * BERT line. Both are constructed from a plain vocabulary and, for BPE, a ranked
 * merge table, so a vocabulary recovered from any source — a `tokenizer.json`, a
 * `.tiktoken` ranks file, or a GGUF vocab read by an adapter — reaches the same
 * implementation.
 *
 * Unigram is deliberately absent: it needs a sentencepiece character map to
 * normalize with, and loading one without the other produces ids that look right
 * and are not.
 *
 * @internal
 */
import type { Model, Token } from './types.ts';

/** A `{token: id}` vocabulary. */
export type Vocab = Record<string, number> | Map<string, number>;

/** Construction options shared by every model. */
interface BaseOptions {
  vocab: Vocab;
  unkToken?: string | null;
}

/** BPE construction options, matching the `tokenizer.json` `model` fields. */
export interface BpeOptions extends BaseOptions {
  /** Ranked merges, as pairs or as space-joined strings. */
  merges: ReadonlyArray<readonly [string, string] | string>;
  continuingSubwordPrefix?: string | null;
  endOfWordSuffix?: string | null;
  fuseUnk?: boolean;
  byteFallback?: boolean;
  ignoreMerges?: boolean;
  dropout?: number | null;
}

/** WordPiece construction options. */
export interface WordPieceOptions extends BaseOptions {
  continuingSubwordPrefix?: string;
  maxInputCharsPerWord?: number;
}

function _toMap(vocab: Vocab): Map<string, number> {
  return vocab instanceof Map ? new Map(vocab) : new Map(Object.entries(vocab));
}

function _invert(vocab: Map<string, number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [token, id] of vocab) out.set(id, token);
  return out;
}

/** Code points of `text` with their UTF-16 ranges. */
function _codePoints(text: string): Array<{ value: string; start: number; end: number }> {
  const out: Array<{ value: string; start: number; end: number }> = [];
  for (let i = 0; i < text.length; ) {
    const size = text.codePointAt(i)! > 0xffff ? 2 : 1;
    out.push({ value: text.slice(i, i + size), start: i, end: i + size });
    i += size;
  }
  return out;
}

/** A candidate merge, ordered by rank then by position for a stable result. */
interface PendingMerge {
  left: number;
  right: number;
  rank: number;
  value: string;
  id: number;
}

/** Min-heap over pending merges. */
class MergeQueue {
  #items: PendingMerge[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(item: PendingMerge): void {
    const items = this.#items;
    items.push(item);
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (_before(items[at], items[parent])) {
        [items[at], items[parent]] = [items[parent], items[at]];
        at = parent;
      } else break;
    }
  }

  pop(): PendingMerge | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length === 0) return top;
    items[0] = last;
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let best = at;
      if (left < items.length && _before(items[left], items[best])) best = left;
      if (right < items.length && _before(items[right], items[best])) best = right;
      if (best === at) break;
      [items[at], items[best]] = [items[best], items[at]];
      at = best;
    }
    return top;
  }
}

function _before(a: PendingMerge, b: PendingMerge): boolean {
  return a.rank !== b.rank ? a.rank < b.rank : a.left < b.left;
}

/**
 * Key for a merge-table lookup.
 *
 * The separator is NUL rather than the space the `merges` wire format uses,
 * because a vocabulary token may legitimately contain a space — a Metaspace
 * vocabulary that keeps literal spaces would otherwise let one pair's key
 * collide with another's.
 */
function _mergeKey(left: string, right: string): string {
  return left + '\u0000' + right;
}

/**
 * Byte Pair Encoding.
 *
 * A word starts as one symbol per code point and merges adjacent pairs in rank
 * order until no ranked pair remains. Merges are driven from a priority queue so
 * the cost is linear in the word length times a log factor rather than quadratic,
 * which matters for the long spans a `use_regex: false` byte-level pre-tokenizer
 * hands over.
 */
export class Bpe implements Model {
  #vocab: Map<string, number>;
  #ids: Map<number, string>;
  #merges: Map<string, { rank: number; value: string; id: number }>;
  #unkToken: string | null;
  #unkId: number | null;
  #fuseUnk: boolean;
  #byteFallback: boolean;
  #ignoreMerges: boolean;
  readonly continuingSubwordPrefix?: string;
  readonly endOfWordSuffix?: string;

  constructor(options: BpeOptions) {
    if (typeof options.dropout === 'number' && options.dropout > 0) {
      throw new Error(
        'tokenizer: BPE dropout is a training-time regularizer and makes encoding ' +
          'nondeterministic; load this vocabulary with dropout disabled',
      );
    }
    this.#vocab = _toMap(options.vocab);
    this.#ids = _invert(this.#vocab);
    this.#unkToken = options.unkToken ?? null;
    this.#unkId = this.#unkToken === null ? null : (this.#vocab.get(this.#unkToken) ?? null);
    if (this.#unkToken !== null && this.#unkId === null) {
      throw new Error(`tokenizer: unk_token "${this.#unkToken}" is not in the vocabulary`);
    }
    this.#fuseUnk = options.fuseUnk ?? false;
    this.#byteFallback = options.byteFallback ?? false;
    this.#ignoreMerges = options.ignoreMerges ?? false;
    this.continuingSubwordPrefix = options.continuingSubwordPrefix ?? undefined;
    this.endOfWordSuffix = options.endOfWordSuffix ?? undefined;
    this.#merges = new Map();
    let rank = 0;
    for (const entry of options.merges) {
      const pair = typeof entry === 'string' ? _splitMerge(entry) : entry;
      const value = pair[0] + pair[1];
      const id = this.#vocab.get(value);
      // A merge whose product is not in the vocabulary can never be applied;
      // published tables occasionally carry such rows after vocabulary pruning.
      if (id === undefined) {
        rank++;
        continue;
      }
      this.#merges.set(_mergeKey(pair[0], pair[1]), { rank: rank++, value, id });
    }
  }

  vocab(): Map<string, number> {
    return new Map(this.#vocab);
  }

  tokenToId(token: string): number | undefined {
    return this.#vocab.get(token);
  }

  idToToken(id: number): string | undefined {
    return this.#ids.get(id);
  }

  tokenize(text: string): Token[] {
    if (text.length === 0) return [];
    if (this.#ignoreMerges) {
      const whole = this.#vocab.get(text);
      if (whole !== undefined) return [{ id: whole, value: text, start: 0, end: text.length }];
    }
    const seeded = this.#seed(text);
    if (seeded.length <= 1) return seeded;
    return this.#merge(seeded);
  }

  /** One symbol per code point, decorated with the model's affixes. */
  #seed(text: string): Token[] {
    const points = _codePoints(text);
    const out: Token[] = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      let value = point.value;
      if (i > 0 && this.continuingSubwordPrefix !== undefined) {
        value = this.continuingSubwordPrefix + value;
      }
      if (i === points.length - 1 && this.endOfWordSuffix !== undefined) {
        value = value + this.endOfWordSuffix;
      }
      const id = this.#vocab.get(value);
      if (id !== undefined) {
        out.push({ id, value, start: point.start, end: point.end });
        continue;
      }
      if (this.#byteFallback) {
        const fallback = this.#byteTokens(point);
        if (fallback !== null) {
          out.push(...fallback);
          continue;
        }
      }
      if (this.#unkId === null) continue;
      const previous = out[out.length - 1];
      if (this.#fuseUnk && previous !== undefined && previous.id === this.#unkId) {
        previous.end = point.end;
        continue;
      }
      out.push({
        id: this.#unkId,
        value: this.#unkToken!,
        start: point.start,
        end: point.end,
      });
    }
    return out;
  }

  /** `<0xXX>` tokens for each UTF-8 byte, or `null` if any is missing. */
  #byteTokens(point: { value: string; start: number; end: number }): Token[] | null {
    const bytes = new TextEncoder().encode(point.value);
    const out: Token[] = [];
    for (const byte of bytes) {
      const value = `<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`;
      const id = this.#vocab.get(value);
      if (id === undefined) return null;
      out.push({ id, value, start: point.start, end: point.end });
    }
    return out;
  }

  /** Apply ranked merges until none of the adjacent pairs is in the table. */
  #merge(symbols: Token[]): Token[] {
    const prev = new Int32Array(symbols.length);
    const next = new Int32Array(symbols.length);
    const alive = new Uint8Array(symbols.length).fill(1);
    for (let i = 0; i < symbols.length; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < symbols.length ? i + 1 : -1;
    }
    const queue = new MergeQueue();
    const offer = (left: number): void => {
      const right = next[left];
      if (right === -1) return;
      const merge = this.#merges.get(_mergeKey(symbols[left].value, symbols[right].value));
      if (merge === undefined) return;
      queue.push({ left, right, rank: merge.rank, value: merge.value, id: merge.id });
    };
    for (let i = 0; i < symbols.length; i++) offer(i);
    while (queue.size > 0) {
      const candidate = queue.pop()!;
      const { left, right } = candidate;
      // The queue keeps stale entries: a pair is only real if both ends are
      // still alive, still adjacent, and — because merging rewrites a symbol's
      // value in place — still products of the merge this entry was pushed for.
      if (alive[left] === 0 || alive[right] === 0 || next[left] !== right) continue;
      const current = this.#merges.get(_mergeKey(symbols[left].value, symbols[right].value));
      if (current === undefined || current.id !== candidate.id) continue;
      symbols[left].value = candidate.value;
      symbols[left].id = candidate.id;
      symbols[left].end = symbols[right].end;
      alive[right] = 0;
      const after = next[right];
      next[left] = after;
      if (after !== -1) prev[after] = left;
      if (prev[left] !== -1) offer(prev[left]);
      offer(left);
    }
    const out: Token[] = [];
    for (let at = 0; at !== -1; at = next[at]) out.push(symbols[at]);
    return out;
  }
}

function _splitMerge(entry: string): [string, string] {
  const at = entry.indexOf(' ');
  if (at === -1) throw new Error(`tokenizer: malformed BPE merge "${entry}"`);
  return [entry.slice(0, at), entry.slice(at + 1)];
}

/**
 * WordPiece.
 *
 * Greedy longest-match-first from the start of the word, with every piece after
 * the first carrying the continuing-subword prefix. A word with any unmatchable
 * position becomes a single unknown token rather than a partial split, which is
 * the behavior BERT's vocabulary was built against.
 */
export class WordPiece implements Model {
  #vocab: Map<string, number>;
  #ids: Map<number, string>;
  #unkToken: string;
  #unkId: number;
  #maxChars: number;
  readonly continuingSubwordPrefix: string;

  constructor(options: WordPieceOptions) {
    this.#vocab = _toMap(options.vocab);
    this.#ids = _invert(this.#vocab);
    this.#unkToken = options.unkToken ?? '[UNK]';
    const unkId = this.#vocab.get(this.#unkToken);
    if (unkId === undefined) {
      throw new Error(`tokenizer: unk_token "${this.#unkToken}" is not in the vocabulary`);
    }
    this.#unkId = unkId;
    this.continuingSubwordPrefix = options.continuingSubwordPrefix ?? '##';
    this.#maxChars = options.maxInputCharsPerWord ?? 100;
  }

  vocab(): Map<string, number> {
    return new Map(this.#vocab);
  }

  tokenToId(token: string): number | undefined {
    return this.#vocab.get(token);
  }

  idToToken(id: number): string | undefined {
    return this.#ids.get(id);
  }

  tokenize(text: string): Token[] {
    if (text.length === 0) return [];
    const points = _codePoints(text);
    if (points.length > this.#maxChars) {
      return [{ id: this.#unkId, value: this.#unkToken, start: 0, end: text.length }];
    }
    const out: Token[] = [];
    let at = 0;
    while (at < points.length) {
      let end = points.length;
      let found: Token | null = null;
      while (end > at) {
        const from = points[at].start;
        const to = points[end - 1].end;
        const candidate =
          at === 0 ? text.slice(from, to) : this.continuingSubwordPrefix + text.slice(from, to);
        const id = this.#vocab.get(candidate);
        if (id !== undefined) {
          found = { id, value: candidate, start: from, end: to };
          break;
        }
        end--;
      }
      if (found === null) {
        return [{ id: this.#unkId, value: this.#unkToken, start: 0, end: text.length }];
      }
      out.push(found);
      at = end;
    }
    return out;
  }
}

/**
 * BPE with an implicit merge table, the form tiktoken ships.
 *
 * A `.tiktoken` file carries only ranks, no merge list — because for a byte-level
 * vocabulary the ranks *are* the merge table: the pair to merge next is whichever
 * adjacent pair concatenates to the lowest-ranked token in the vocabulary. Since
 * a token's rank and its id are the same number, this needs no extra state
 * beyond the vocabulary itself.
 *
 * Symbols are single bytes, held in the printable byte alphabet so that
 * concatenating symbol strings is concatenating bytes.
 */
export class RankedBpe implements Model {
  #vocab: Map<string, number>;
  #ids: Map<number, string>;

  constructor(vocab: Vocab) {
    this.#vocab = _toMap(vocab);
    this.#ids = _invert(this.#vocab);
  }

  vocab(): Map<string, number> {
    return new Map(this.#vocab);
  }

  tokenToId(token: string): number | undefined {
    return this.#vocab.get(token);
  }

  idToToken(id: number): string | undefined {
    return this.#ids.get(id);
  }

  tokenize(text: string): Token[] {
    if (text.length === 0) return [];
    const whole = this.#vocab.get(text);
    if (whole !== undefined) return [{ id: whole, value: text, start: 0, end: text.length }];
    const symbols: Token[] = [];
    for (const point of _codePoints(text)) {
      const id = this.#vocab.get(point.value);
      if (id === undefined) {
        throw new Error(
          `tokenizer: byte ${JSON.stringify(point.value)} is missing from the ranks table; ` +
            'a tiktoken vocabulary must cover all 256 single bytes',
        );
      }
      symbols.push({ id, value: point.value, start: point.start, end: point.end });
    }
    if (symbols.length <= 1) return symbols;
    const prev = new Int32Array(symbols.length);
    const next = new Int32Array(symbols.length);
    const alive = new Uint8Array(symbols.length).fill(1);
    for (let i = 0; i < symbols.length; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < symbols.length ? i + 1 : -1;
    }
    const queue = new MergeQueue();
    const offer = (left: number): void => {
      const right = next[left];
      if (right === -1) return;
      const value = symbols[left].value + symbols[right].value;
      const id = this.#vocab.get(value);
      if (id === undefined) return;
      queue.push({ left, right, rank: id, value, id });
    };
    for (let i = 0; i < symbols.length; i++) offer(i);
    while (queue.size > 0) {
      const candidate = queue.pop()!;
      const { left, right } = candidate;
      if (alive[left] === 0 || alive[right] === 0 || next[left] !== right) continue;
      if (symbols[left].value + symbols[right].value !== candidate.value) continue;
      symbols[left].value = candidate.value;
      symbols[left].id = candidate.id;
      symbols[left].end = symbols[right].end;
      alive[right] = 0;
      const after = next[right];
      next[left] = after;
      if (after !== -1) prev[after] = left;
      if (prev[left] !== -1) offer(prev[left]);
      offer(left);
    }
    const out: Token[] = [];
    for (let at = 0; at !== -1; at = next[at]) out.push(symbols[at]);
    return out;
  }
}

/** Build a model from the `model` field of a `tokenizer.json`. */
export function buildModel(spec: Record<string, unknown>): Model {
  switch (spec.type) {
    case 'BPE':
      return new Bpe({
        vocab: (spec.vocab as Record<string, number>) ?? {},
        merges: (spec.merges as Array<[string, string] | string>) ?? [],
        unkToken: (spec.unk_token as string | null) ?? null,
        continuingSubwordPrefix: (spec.continuing_subword_prefix as string | null) ?? null,
        endOfWordSuffix: (spec.end_of_word_suffix as string | null) ?? null,
        fuseUnk: (spec.fuse_unk as boolean) ?? false,
        byteFallback: (spec.byte_fallback as boolean) ?? false,
        ignoreMerges: (spec.ignore_merges as boolean) ?? false,
        dropout: (spec.dropout as number | null) ?? null,
      });
    case 'WordPiece':
      return new WordPiece({
        vocab: (spec.vocab as Record<string, number>) ?? {},
        unkToken: (spec.unk_token as string) ?? '[UNK]',
        continuingSubwordPrefix: (spec.continuing_subword_prefix as string) ?? '##',
        maxInputCharsPerWord: (spec.max_input_chars_per_word as number) ?? 100,
      });
    case 'tiktoken':
      return new RankedBpe((spec.vocab as Record<string, number>) ?? {});
    case 'Unigram':
      throw new Error(
        'tokenizer: Unigram vocabularies need the sentencepiece character map that ' +
          'accompanies them; this tokenizer implements BPE and WordPiece',
      );
    default:
      throw new Error(`tokenizer: unsupported model type "${String(spec.type)}"`);
  }
}
