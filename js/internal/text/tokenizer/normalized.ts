/**
 * Offset-preserving string for the tokenizer pipeline.
 *
 * Every stage before the model — normalization, pre-tokenization, byte-level
 * remapping — rewrites text. `NormalizedString` carries, alongside the rewritten
 * text, the range of the *original* input that produced each UTF-16 unit, so the
 * ids a model finally emits can be reported against offsets the caller can index
 * their own string with.
 *
 * Unicode normalization is applied per *normalization segment* — a starter code
 * point plus the combining marks and Hangul V/T jamo that follow it — rather
 * than over the whole string. Normalization is closed over those segments, so
 * the result matches whole-string normalization while keeping alignment
 * computable. Within one segment, offsets are segment-granular: every output
 * unit maps to the segment's full original range. Outside combining sequences a
 * segment is a single code point, which is the common case.
 *
 * @internal
 */

/** A code point of `text` together with the original range it came from. */
interface Unit {
  /** UTF-16 index in `text` where the code point starts. */
  index: number;
  /** Start of the originating range in the original string. */
  start: number;
  /** End of the originating range in the original string, exclusive. */
  end: number;
}

/**
 * Continues the current normalization segment: combining marks, and the Hangul
 * V/T jamo that NFC composes into a preceding L jamo.
 */
const CONTINUES_SEGMENT = /^[\p{M}ᅠ-ᇿ]$/u;

const IS_WHITESPACE = /^\s$/u;

/** Unicode normalization forms accepted by `NormalizedString.normalize()`. */
export type NormalizationForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

/**
 * Rewritten text plus the alignment back to the original string.
 *
 * Instances are immutable: every operation returns a new `NormalizedString`.
 */
export class NormalizedString {
  /** The input the alignment is expressed against. */
  readonly original: string;
  /** The rewritten text produced by the stages applied so far. */
  readonly text: string;
  /** Original start offset for each UTF-16 unit of `text`. */
  readonly starts: Int32Array;
  /** Original end offset, exclusive, for each UTF-16 unit of `text`. */
  readonly ends: Int32Array;

  constructor(original: string, text?: string, starts?: Int32Array, ends?: Int32Array) {
    this.original = original;
    if (text === undefined) {
      this.text = original;
      const n = original.length;
      const s = new Int32Array(n);
      const e = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        s[i] = i;
        e[i] = i + 1;
      }
      this.starts = s;
      this.ends = e;
      return;
    }
    this.starts = starts!;
    this.ends = ends!;
    this.text = text;
  }

  /** `true` when the rewritten text is empty. */
  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  /** The original range covered by the whole rewritten text. */
  get range(): [number, number] {
    if (this.text.length === 0) return [0, 0];
    return [this.starts[0], this.ends[this.text.length - 1]];
  }

  /**
   * The original range covered by `text.slice(from, to)`.
   *
   * An empty slice collapses to a zero-width range at the nearest known
   * boundary so callers never see a reversed span.
   */
  originalRange(from: number, to: number): [number, number] {
    if (to <= from) {
      const at = from < this.starts.length ? this.starts[from] : this.original.length;
      return [at, at];
    }
    return [this.starts[from], this.ends[to - 1]];
  }

  /** A sub-slice of the rewritten text, keeping its alignment. */
  slice(from: number, to: number): NormalizedString {
    return new NormalizedString(
      this.original,
      this.text.slice(from, to),
      this.starts.slice(from, to),
      this.ends.slice(from, to),
    );
  }

  /** Code point boundaries of the rewritten text, in order. */
  #units(): Unit[] {
    const units: Unit[] = [];
    const text = this.text;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      const size = cp > 0xffff ? 2 : 1;
      units.push({ index: i, start: this.starts[i], end: this.ends[i + size - 1] });
      i += size;
    }
    return units;
  }

  /**
   * Rewrite each code point.
   *
   * The callback receives the code point as a string and returns its
   * replacement, which may be empty (dropping it) or several code points long.
   * Every unit of the replacement inherits the original range of the code point
   * it replaced.
   */
  mapCodePoints(fn: (codePoint: string, index: number) => string): NormalizedString {
    const pieces: string[] = [];
    const ranges: Array<[number, number]> = [];
    const text = this.text;
    let changed = false;
    for (const unit of this.#units()) {
      const size = text.codePointAt(unit.index)! > 0xffff ? 2 : 1;
      const cp = text.slice(unit.index, unit.index + size);
      const out = fn(cp, unit.index);
      if (out !== cp) changed = true;
      if (out.length === 0) continue;
      pieces.push(out);
      ranges.push([unit.start, unit.end]);
    }
    if (!changed) return this;
    return _build(this.original, pieces, ranges);
  }

  /** Drop every code point for which `fn` returns `false`. */
  filterCodePoints(fn: (codePoint: string) => boolean): NormalizedString {
    return this.mapCodePoints((cp) => (fn(cp) ? cp : ''));
  }

  /**
   * Replace every match of `pattern` with `replacement`.
   *
   * A string pattern matches literally. Each unit of the replacement inherits
   * the full original range of the text it replaced, so a replacement of a
   * different length still points at something meaningful.
   */
  replaceAll(pattern: string | RegExp, replacement: string): NormalizedString {
    const matcher = _globalize(pattern);
    const text = this.text;
    const pieces: string[] = [];
    const ranges: Array<[number, number]> = [];
    let last = 0;
    let changed = false;
    for (const match of text.matchAll(matcher)) {
      const from = match.index!;
      const to = from + match[0].length;
      if (match[0].length === 0) continue;
      if (from > last) {
        pieces.push(text.slice(last, from));
        ranges.push([this.starts[last], this.ends[from - 1]]);
      }
      if (replacement.length > 0) {
        pieces.push(replacement);
        ranges.push([this.starts[from], this.ends[to - 1]]);
      }
      last = to;
      changed = true;
    }
    if (!changed) return this;
    if (last < text.length) {
      pieces.push(text.slice(last));
      ranges.push([this.starts[last], this.ends[text.length - 1]]);
    }
    return _build(this.original, pieces, ranges);
  }

  /**
   * Apply a Unicode normalization form.
   *
   * Normalization runs per normalization segment so alignment stays computable;
   * see the module note on segment-granular offsets.
   */
  normalize(form: NormalizationForm): NormalizedString {
    const text = this.text;
    const pieces: string[] = [];
    const ranges: Array<[number, number]> = [];
    const units = this.#units();
    let changed = false;
    let i = 0;
    while (i < units.length) {
      let j = i + 1;
      while (j < units.length && CONTINUES_SEGMENT.test(_codePointAt(text, units[j]))) j++;
      const from = units[i].index;
      const to = j < units.length ? units[j].index : text.length;
      const segment = text.slice(from, to);
      const normalized = segment.normalize(form);
      if (normalized !== segment) changed = true;
      if (normalized.length > 0) {
        pieces.push(normalized);
        ranges.push([units[i].start, units[j - 1].end]);
      }
      i = j;
    }
    if (!changed) return this;
    return _build(this.original, pieces, ranges);
  }

  /** Lowercase each code point independently. */
  lowercase(): NormalizedString {
    return this.mapCodePoints((cp) => cp.toLowerCase());
  }

  /** Uppercase each code point independently. */
  uppercase(): NormalizedString {
    return this.mapCodePoints((cp) => cp.toUpperCase());
  }

  /** Remove leading and/or trailing whitespace. */
  strip(left = true, right = true): NormalizedString {
    const text = this.text;
    let from = 0;
    let to = text.length;
    if (left) {
      while (from < to && IS_WHITESPACE.test(text[from])) from++;
    }
    if (right) {
      while (to > from && IS_WHITESPACE.test(text[to - 1])) to--;
    }
    if (from === 0 && to === text.length) return this;
    return this.slice(from, to);
  }

  /**
   * Insert `prefix` before the text.
   *
   * The inserted units are aligned to a zero-width range at the current start,
   * because they correspond to nothing the caller wrote.
   */
  prepend(prefix: string): NormalizedString {
    if (prefix.length === 0 || this.text.length === 0) return this;
    const at = this.starts[0];
    const starts = new Int32Array(prefix.length + this.text.length);
    const ends = new Int32Array(starts.length);
    starts.fill(at, 0, prefix.length);
    ends.fill(at, 0, prefix.length);
    starts.set(this.starts, prefix.length);
    ends.set(this.ends, prefix.length);
    return new NormalizedString(this.original, prefix + this.text, starts, ends);
  }
}

function _codePointAt(text: string, unit: Unit): string {
  const cp = text.codePointAt(unit.index)!;
  return text.slice(unit.index, unit.index + (cp > 0xffff ? 2 : 1));
}

/** Assemble a `NormalizedString` from replacement pieces and their source ranges. */
function _build(
  original: string,
  pieces: readonly string[],
  ranges: readonly [number, number][],
): NormalizedString {
  let length = 0;
  for (const piece of pieces) length += piece.length;
  const starts = new Int32Array(length);
  const ends = new Int32Array(length);
  let at = 0;
  for (let p = 0; p < pieces.length; p++) {
    const [start, end] = ranges[p];
    for (let k = 0; k < pieces[p].length; k++) {
      starts[at] = start;
      ends[at] = end;
      at++;
    }
  }
  return new NormalizedString(original, pieces.join(''), starts, ends);
}

/** Escape a literal so it can be embedded in a regular expression. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _globalize(pattern: string | RegExp): RegExp {
  if (typeof pattern === 'string') return new RegExp(escapeRegExp(pattern), 'gu');
  return pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, pattern.flags + 'g');
}
