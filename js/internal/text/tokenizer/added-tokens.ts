/**
 * The added vocabulary — tokens matched literally, ahead of the model.
 *
 * Special tokens like `[CLS]` and `<|endoftext|>`, and any token a caller adds,
 * must survive as single ids even though a byte-level BPE would happily shred
 * them into pieces. So they are extracted from the input first and the model only
 * ever sees what is left between them.
 *
 * Matching is leftmost-longest and independent of insertion order, which is what
 * makes the result the same whether a tokenizer was built from a spec or had
 * tokens added one at a time.
 *
 * @internal
 */
import type { NormalizedString } from './normalized.ts';

/** A token matched literally rather than by the model. */
export interface AddedToken {
  /** Vocabulary id. */
  id: number;
  /** The literal text to match. */
  content: string;
  /** Match only when not surrounded by word characters. */
  singleWord: boolean;
  /** Extend the match left over whitespace. */
  lstrip: boolean;
  /** Extend the match right over whitespace. */
  rstrip: boolean;
  /** Match against normalized text rather than the raw input. */
  normalized: boolean;
  /** Report as a special token in `specialTokensMask`. */
  special: boolean;
}

/** A stretch of input, either one added token or text for the model. */
export interface Segment {
  /** UTF-16 start index in the text that was scanned. */
  start: number;
  /** UTF-16 end index, exclusive, in the text that was scanned. */
  end: number;
  /** The added token found here, or `null` for model text. */
  token: AddedToken | null;
}

const WORD = /^[\p{L}\p{N}_]$/u;
const SPACE = /^\s$/u;

/** Options accepted when adding a token, beyond its content. */
export type AddedTokenOptions = Partial<Omit<AddedToken, 'id' | 'content'>>;

/**
 * The set of literally-matched tokens, split by whether they match raw or
 * normalized text.
 */
export class AddedVocabulary {
  #byContent = new Map<string, AddedToken>();
  #byId = new Map<number, AddedToken>();
  #raw: string[] = [];
  #normalized: string[] = [];
  #rawByFirst = new Map<string, string[]>();
  #normalizedByFirst = new Map<string, string[]>();

  /** Every added token, in id order. */
  tokens(): AddedToken[] {
    return [...this.#byId.values()].sort((a, b) => a.id - b.id);
  }

  /** The added token with this content, if any. */
  get(content: string): AddedToken | undefined {
    return this.#byContent.get(content);
  }

  /** The added token with this id, if any. */
  byId(id: number): AddedToken | undefined {
    return this.#byId.get(id);
  }

  /** `true` when `id` names an added token flagged special. */
  isSpecial(id: number): boolean {
    return this.#byId.get(id)?.special ?? false;
  }

  /** Number of added tokens. */
  get size(): number {
    return this.#byId.size;
  }

  /**
   * Register a token.
   *
   * Re-adding the same content replaces the earlier entry, so a spec's flags can
   * be refined by a later `addSpecialTokens` call without duplicating ids.
   */
  add(token: AddedToken): void {
    const existing = this.#byContent.get(token.content);
    if (existing !== undefined) this.#remove(existing);
    this.#byContent.set(token.content, token);
    this.#byId.set(token.id, token);
    const bucket = token.normalized ? this.#normalized : this.#raw;
    const index = token.normalized ? this.#normalizedByFirst : this.#rawByFirst;
    bucket.push(token.content);
    bucket.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    const first = _firstCodePoint(token.content);
    const list = index.get(first) ?? [];
    list.push(token.content);
    list.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    index.set(first, list);
  }

  #remove(token: AddedToken): void {
    this.#byContent.delete(token.content);
    this.#byId.delete(token.id);
    const bucket = token.normalized ? this.#normalized : this.#raw;
    const index = token.normalized ? this.#normalizedByFirst : this.#rawByFirst;
    const at = bucket.indexOf(token.content);
    if (at !== -1) bucket.splice(at, 1);
    const first = _firstCodePoint(token.content);
    const list = index.get(first);
    if (list !== undefined) {
      const listAt = list.indexOf(token.content);
      if (listAt !== -1) list.splice(listAt, 1);
    }
  }

  /** Split raw input on the added tokens that match unnormalized text. */
  extract(text: string): Segment[] {
    return this.#scan(text, this.#rawByFirst, this.#raw.length > 0);
  }

  /** Split already-normalized text on the added tokens that match it. */
  extractNormalized(value: NormalizedString): Segment[] {
    return this.#scan(value.text, this.#normalizedByFirst, this.#normalized.length > 0);
  }

  #scan(text: string, index: Map<string, string[]>, any: boolean): Segment[] {
    if (!any || text.length === 0) {
      return text.length === 0 ? [] : [{ start: 0, end: text.length, token: null }];
    }
    const out: Segment[] = [];
    let plain = 0;
    let at = 0;
    while (at < text.length) {
      const found = this.#matchAt(text, at, index);
      if (found === null) {
        at += text.codePointAt(at)! > 0xffff ? 2 : 1;
        continue;
      }
      // `lstrip` can reach back into text already accounted for; the match may
      // not start before the last emitted boundary.
      const start = Math.max(found.start, plain);
      if (start > plain) out.push({ start: plain, end: start, token: null });
      out.push({ ...found, start });
      plain = found.end;
      at = found.end;
    }
    if (plain < text.length) out.push({ start: plain, end: text.length, token: null });
    return out;
  }

  /** The longest added token matching at `at`, with strip flags applied. */
  #matchAt(text: string, at: number, index: Map<string, string[]>): Segment | null {
    const candidates = index.get(_firstCodePoint(text.slice(at, at + 2)));
    if (candidates === undefined) return null;
    for (const content of candidates) {
      if (!text.startsWith(content, at)) continue;
      const token = this.#byContent.get(content)!;
      let start = at;
      let end = at + content.length;
      if (token.singleWord) {
        const before = start > 0 ? text[start - 1] : '';
        const after = end < text.length ? text[end] : '';
        if ((before !== '' && WORD.test(before)) || (after !== '' && WORD.test(after))) continue;
      }
      if (token.lstrip) {
        while (start > 0 && SPACE.test(text[start - 1])) start--;
      }
      if (token.rstrip) {
        while (end < text.length && SPACE.test(text[end])) end++;
      }
      return { start, end, token };
    }
    return null;
  }
}

function _firstCodePoint(text: string): string {
  if (text.length === 0) return '';
  const cp = text.codePointAt(0)!;
  return text.slice(0, cp > 0xffff ? 2 : 1);
}

/** Fill in the defaults for a token added by content alone. */
export function makeAddedToken(
  id: number,
  content: string,
  options: AddedTokenOptions = {},
): AddedToken {
  return {
    id,
    content,
    singleWord: options.singleWord ?? false,
    lstrip: options.lstrip ?? false,
    rstrip: options.rstrip ?? false,
    normalized: options.normalized ?? !(options.special ?? false),
    special: options.special ?? false,
  };
}
