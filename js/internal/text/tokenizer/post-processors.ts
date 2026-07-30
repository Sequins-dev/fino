/**
 * Post-processors — assembling encoded sequences into the model's input layout.
 *
 * This is where `[CLS] … [SEP]`, `<s> … </s>`, and the type-id split between a
 * sequence and its pair come from. Special tokens added here get a zero-width
 * offset, because they correspond to no text the caller wrote; consumers that
 * map predictions back onto the input rely on that to tell them apart from
 * tokens that do.
 *
 * @internal
 */
import { concatEncodings, emptyEncoding, type Encoding, type PostProcessor } from './types.ts';

/** The `post_processor` field of a `tokenizer.json`. */
export interface PostProcessorSpec {
  type: string;
  [key: string]: unknown;
}

/** One piece of a `TemplateProcessing` template. */
type TemplatePiece =
  | { kind: 'sequence'; sequence: 'A' | 'B'; typeId: number }
  | { kind: 'special'; id: string; typeId: number };

/** A special token a template may reference, with the ids it expands to. */
interface SpecialToken {
  ids: number[];
  tokens: string[];
}

/** A single special token, as its own one-token encoding. */
function _specialEncoding(token: SpecialToken, typeId: number, at: number): Encoding {
  return {
    ids: [...token.ids],
    tokens: [...token.tokens],
    typeIds: token.ids.map(() => typeId),
    attentionMask: token.ids.map(() => 1),
    specialTokensMask: token.ids.map(() => 1),
    offsets: token.ids.map(() => [at, at] as [number, number]),
    sequenceIds: token.ids.map(() => null),
    overflowing: [],
  };
}

/** Re-type an encoding's tokens as belonging to sequence `typeId`. */
function _retype(encoding: Encoding, typeId: number): Encoding {
  return { ...encoding, typeIds: encoding.ids.map(() => typeId) };
}

/**
 * The general post-processor: a template naming where each sequence and each
 * special token goes.
 */
class TemplateProcessing implements PostProcessor {
  #single: TemplatePiece[];
  #pair: TemplatePiece[];
  #specials: Map<string, SpecialToken>;

  constructor(single: TemplatePiece[], pair: TemplatePiece[], specials: Map<string, SpecialToken>) {
    this.#single = single;
    this.#pair = pair;
    this.#specials = specials;
  }

  addedTokens(pair: boolean): number {
    const template = pair ? this.#pair : this.#single;
    let count = 0;
    for (const piece of template) {
      if (piece.kind !== 'special') continue;
      const special = this.#specials.get(piece.id);
      count += special?.ids.length ?? 0;
    }
    return count;
  }

  process(encoding: Encoding, pair: Encoding | null, addSpecialTokens: boolean): Encoding {
    if (!addSpecialTokens) {
      return pair === null ? encoding : concatEncodings(encoding, _retype(pair, 1));
    }
    const template = pair === null ? this.#single : this.#pair;
    let out = emptyEncoding();
    for (const piece of template) {
      if (piece.kind === 'sequence') {
        const source = piece.sequence === 'A' ? encoding : pair;
        if (source === null) continue;
        out = concatEncodings(out, _retype(source, piece.typeId));
        continue;
      }
      const special = this.#specials.get(piece.id);
      if (special === undefined) {
        throw new Error(`tokenizer: template references unknown special token "${piece.id}"`);
      }
      out = concatEncodings(out, _specialEncoding(special, piece.typeId, _anchor(out, encoding)));
    }
    return out;
  }
}

/**
 * Where a special token's zero-width offset should sit.
 *
 * Before any real token it is the start of the input; after some, it is the end
 * of the last real token, so a special token reads as adjacent to the text it
 * brackets rather than always pointing at zero.
 */
function _anchor(built: Encoding, source: Encoding): number {
  for (let i = built.offsets.length - 1; i >= 0; i--) {
    if (built.specialTokensMask[i] === 0) return built.offsets[i][1];
  }
  return source.offsets.length > 0 ? source.offsets[0][0] : 0;
}

function _bertTemplate(cls: SpecialToken, sep: SpecialToken): TemplateProcessing {
  return new TemplateProcessing(
    [
      { kind: 'special', id: '[CLS]', typeId: 0 },
      { kind: 'sequence', sequence: 'A', typeId: 0 },
      { kind: 'special', id: '[SEP]', typeId: 0 },
    ],
    [
      { kind: 'special', id: '[CLS]', typeId: 0 },
      { kind: 'sequence', sequence: 'A', typeId: 0 },
      { kind: 'special', id: '[SEP]', typeId: 0 },
      { kind: 'sequence', sequence: 'B', typeId: 1 },
      { kind: 'special', id: '[SEP]', typeId: 1 },
    ],
    new Map([
      ['[CLS]', cls],
      ['[SEP]', sep],
    ]),
  );
}

function _robertaTemplate(cls: SpecialToken, sep: SpecialToken): TemplateProcessing {
  // RoBERTa keeps every token at type id 0 and separates a pair with a doubled
  // separator rather than a type-id switch.
  return new TemplateProcessing(
    [
      { kind: 'special', id: 'cls', typeId: 0 },
      { kind: 'sequence', sequence: 'A', typeId: 0 },
      { kind: 'special', id: 'sep', typeId: 0 },
    ],
    [
      { kind: 'special', id: 'cls', typeId: 0 },
      { kind: 'sequence', sequence: 'A', typeId: 0 },
      { kind: 'special', id: 'sep', typeId: 0 },
      { kind: 'special', id: 'sep', typeId: 0 },
      { kind: 'sequence', sequence: 'B', typeId: 0 },
      { kind: 'special', id: 'sep', typeId: 0 },
    ],
    new Map([
      ['cls', cls],
      ['sep', sep],
    ]),
  );
}

/**
 * Trim whitespace out of byte-level offsets.
 *
 * A byte-level pre-tokenizer attaches the leading space to the following word,
 * so a token's offsets cover a space the user would not consider part of it.
 * Trimming moves the start past that whitespace without changing any id.
 */
class ByteLevelProcessing implements PostProcessor {
  #trimOffsets: boolean;
  #addPrefixSpace: boolean;
  constructor(trimOffsets: boolean, addPrefixSpace: boolean) {
    this.#trimOffsets = trimOffsets;
    this.#addPrefixSpace = addPrefixSpace;
  }
  addedTokens(): number {
    return 0;
  }
  process(encoding: Encoding, pair: Encoding | null): Encoding {
    const trim = (target: Encoding): Encoding => {
      if (!this.#trimOffsets) return target;
      return {
        ...target,
        offsets: target.offsets.map((range, index) => {
          const token = target.tokens[index];
          if (target.specialTokensMask[index] === 1) return range;
          let leading = _countSpaces(token, false);
          const trailing = _countSpaces(token, true);
          // A prefix space the pre-tokenizer invented is not text the caller
          // wrote, so trimming it would point the token at the wrong character.
          if (leading === 1 && this.#addPrefixSpace && (index === 0 || range[0] === 0)) {
            leading = 0;
          }
          const start = Math.min(range[0] + leading, range[1]);
          const end = trailing > 0 ? Math.max(range[1] - trailing, start) : range[1];
          return [start, end] as [number, number];
        }),
      };
    };
    const first = trim(encoding);
    if (pair === null) return first;
    return concatEncodings(first, _retype(trim(pair), 1));
  }
}

/** The byte alphabet's stand-in for a space, which reads as a word boundary. */
const BYTE_LEVEL_SPACE = 'Ġ';

/** Count the space-like code points at one end of a token. */
function _countSpaces(token: string, fromEnd: boolean): number {
  const points = [...token];
  if (fromEnd) points.reverse();
  let count = 0;
  for (const point of points) {
    if (point !== BYTE_LEVEL_SPACE && !/^\s$/u.test(point)) break;
    count++;
  }
  return count;
}

class Sequence implements PostProcessor {
  #stages: PostProcessor[];
  constructor(stages: PostProcessor[]) {
    this.#stages = stages;
  }
  addedTokens(pair: boolean): number {
    let count = 0;
    for (const stage of this.#stages) count += stage.addedTokens(pair);
    return count;
  }
  process(encoding: Encoding, pair: Encoding | null, addSpecialTokens: boolean): Encoding {
    // Only the first stage still sees two separate sequences; once a stage has
    // joined them, later stages refine the single result.
    let current = encoding;
    let remaining = pair;
    for (const stage of this.#stages) {
      current = stage.process(current, remaining, addSpecialTokens);
      remaining = null;
    }
    return current;
  }
}

/** The default: concatenate, giving the pair type id 1. */
class Concat implements PostProcessor {
  addedTokens(): number {
    return 0;
  }
  process(encoding: Encoding, pair: Encoding | null): Encoding {
    return pair === null ? encoding : concatEncodings(encoding, _retype(pair, 1));
  }
}

/** The identity post-processor, used when a spec provides none. */
export function defaultPostProcessor(): PostProcessor {
  return new Concat();
}

function _piece(raw: Record<string, unknown>): TemplatePiece {
  const sequence = raw.Sequence as { id: string; type_id: number } | undefined;
  if (sequence !== undefined) {
    return {
      kind: 'sequence',
      sequence: sequence.id === 'B' ? 'B' : 'A',
      typeId: sequence.type_id ?? 0,
    };
  }
  const special = raw.SpecialToken as { id: string; type_id: number } | undefined;
  if (special !== undefined) {
    return { kind: 'special', id: special.id, typeId: special.type_id ?? 0 };
  }
  throw new Error('tokenizer: template piece must be a Sequence or a SpecialToken');
}

function _template(raw: unknown): TemplatePiece[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => _piece(entry as Record<string, unknown>));
}

function _pairToken(raw: unknown, label: string): SpecialToken {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error(`tokenizer: ${label} must be a [token, id] pair`);
  }
  return { tokens: [String(raw[0])], ids: [Number(raw[1])] };
}

/** Build a post-processor from its `tokenizer.json` spec. */
export function buildPostProcessor(spec: PostProcessorSpec | null | undefined): PostProcessor {
  if (spec === null || spec === undefined) return new Concat();
  switch (spec.type) {
    case 'TemplateProcessing': {
      const specials = new Map<string, SpecialToken>();
      const raw = (spec.special_tokens as Record<string, unknown>) ?? {};
      for (const [key, value] of Object.entries(raw)) {
        const entry = value as { id?: string; ids?: number[]; tokens?: string[] };
        specials.set(key, { ids: entry.ids ?? [], tokens: entry.tokens ?? [] });
      }
      return new TemplateProcessing(_template(spec.single), _template(spec.pair), specials);
    }
    case 'BertProcessing':
      return _bertTemplate(_pairToken(spec.cls, 'cls'), _pairToken(spec.sep, 'sep'));
    case 'RobertaProcessing':
      return _robertaTemplate(_pairToken(spec.cls, 'cls'), _pairToken(spec.sep, 'sep'));
    case 'ByteLevel':
      return new ByteLevelProcessing(
        (spec.trim_offsets as boolean) ?? true,
        (spec.add_prefix_space as boolean) ?? true,
      );
    case 'Sequence': {
      const stages = ((spec.processors as PostProcessorSpec[]) ?? []).map(buildPostProcessor);
      return new Sequence(stages);
    }
    default:
      throw new Error(`tokenizer: unsupported post-processor type "${spec.type}"`);
  }
}
