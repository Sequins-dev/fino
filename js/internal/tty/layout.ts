/**
 * Terminal layout engine: a flexbox subset over styled cells.
 *
 * Measures and paints host-neutral primitive trees (`box`, `text`, `spacer`,
 * `input`, `button`, `list`, `scrollview`, `layer`) into a cell canvas that
 * compacts to a `Frame`. Cells are the intermediate representation — no ANSI
 * exists here; styles stay data until the frame is encoded at the wire edge.
 *
 * Works on plain VNodes (one-shot renders) and on the retained node tree from
 * `internal:tty/host` (live renders), which layers measurement caching on top
 * via node identity.
 *
 * @internal
 */
import { EMPTY_STYLE, internStyle, mergeStyle } from 'fino:tty/style';
import type { Color, Style } from 'fino:tty/style';
import { parseAnsi, stringWidth, graphemes, clusterWidth } from 'fino:tty/frame';
import type { CursorPlacement, Frame, HitRect, Rect, Row, Segment } from 'fino:tty/frame';

/** Anything the engine can lay out: a VNode or a retained terminal node. */
export interface LayoutNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<LayoutNode | string>;
  /** Retained text nodes carry their content here under type '#text'. */
  readonly text?: string | null;
}

export interface Measured {
  readonly width: number;
  readonly height: number;
}

export interface Constraints {
  readonly width: number;
  readonly height?: number;
}

type Align = 'start' | 'center' | 'end' | 'stretch';
type Justify = 'start' | 'center' | 'end' | 'between';
export type WrapMode = 'none' | 'char' | 'word';
export type BorderStyle = 'single' | 'ascii' | 'heavy' | 'double';

// Rounded corner glyphs exist only for the light line weight; ascii gets the
// classic slash corners, and heavy/double stay square.
const ROUNDED_CORNERS: Partial<Record<BorderStyle, [string, string, string, string]>> = {
  single: ['╭', '╮', '╰', '╯'],
  ascii: ['/', '\\', '\\', '/'],
};

const BORDERS: Record<BorderStyle, [string, string, string, string, string, string]> = {
  single: ['┌', '┐', '└', '┘', '─', '│'],
  ascii: ['+', '+', '+', '+', '-', '|'],
  heavy: ['┏', '┓', '┗', '┛', '━', '┃'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
};

function num(props: Record<string, unknown>, name: string): number | undefined {
  const value = props[name];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function str(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name];
  return typeof value === 'string' ? value : undefined;
}

function styleFromProps(props: Record<string, unknown>): Style {
  let style = EMPTY_STYLE;
  const token = props.style;
  if (Array.isArray(token)) {
    for (const entry of token) style = mergeStyle(style, entry as Style);
  } else if (token && typeof token === 'object') {
    style = mergeStyle(style, token as Style);
  }
  const own: {
    fg?: Color;
    bg?: Color;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
    strike?: boolean;
  } = {};
  if (props.color !== undefined) own.fg = props.color as Color;
  if (props.background !== undefined) own.bg = props.background as Color;
  for (const attr of ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'] as const) {
    if (typeof props[attr] === 'boolean') own[attr] = props[attr] as boolean;
  }
  return mergeStyle(style, own);
}

interface Cell {
  text: string;
  width: 0 | 1 | 2;
  style: Style;
}

/** Paint surface: a grid of cells with clipping, compacted to a Frame. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  #cells: Cell[][];
  #clips: Rect[] = [];
  #hits: HitRect[] = [];
  #cursor: CursorPlacement | null = null;

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.#cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({
        text: ' ',
        width: 1 as const,
        style: EMPTY_STYLE,
      })),
    );
    this.#clips.push({ x: 0, y: 0, width: this.width, height: this.height });
  }

  get clip(): Rect {
    return this.#clips[this.#clips.length - 1]!;
  }

  clipPush(rect: Rect): void {
    const current = this.clip;
    const x1 = Math.max(current.x, rect.x);
    const y1 = Math.max(current.y, rect.y);
    const x2 = Math.min(current.x + current.width, rect.x + rect.width);
    const y2 = Math.min(current.y + current.height, rect.y + rect.height);
    this.#clips.push({ x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) });
  }

  clipPop(): void {
    if (this.#clips.length > 1) this.#clips.pop();
  }

  #inClip(x: number, y: number): boolean {
    const clip = this.clip;
    return x >= clip.x && x < clip.x + clip.width && y >= clip.y && y < clip.y + clip.height;
  }

  #clearWideAt(row: Cell[], x: number): void {
    const cell = row[x];
    if (!cell) return;
    if (cell.width === 0 && x > 0) {
      row[x - 1] = { text: ' ', width: 1, style: row[x - 1]!.style };
      row[x] = { text: ' ', width: 1, style: cell.style };
    } else if (cell.width === 2 && x + 1 < row.length) {
      row[x] = { text: ' ', width: 1, style: cell.style };
      row[x + 1] = { text: ' ', width: 1, style: row[x + 1]!.style };
    }
  }

  /** Apply a background style to every cell of a rect. */
  fill(rect: Rect, style: Style): void {
    if (style === EMPTY_STYLE) return;
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      if (y < 0 || y >= this.height) continue;
      const row = this.#cells[y]!;
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if (x < 0 || x >= this.width || !this.#inClip(x, y)) continue;
        const cell = row[x]!;
        row[x] = { text: cell.text, width: cell.width, style: mergeStyle(style, cell.style) };
      }
    }
  }

  /** Write one styled character (cluster) at a cell position. */
  put(x: number, y: number, cluster: string, width: 1 | 2, style: Style): void {
    if (y < 0 || y >= this.height || x < 0 || x + width > this.width) return;
    if (!this.#inClip(x, y) || (width === 2 && !this.#inClip(x + 1, y))) return;
    const row = this.#cells[y]!;
    this.#clearWideAt(row, x);
    if (width === 2) this.#clearWideAt(row, x + 1);
    row[x] = { text: cluster, width, style };
    if (width === 2) row[x + 1] = { text: '', width: 0, style };
  }

  /** Draw pre-wrapped rows at an origin. */
  draw(x: number, y: number, rows: readonly Row[]): void {
    for (let r = 0; r < rows.length; r++) {
      let cx = x;
      for (const segment of rows[r]!.segments) {
        for (const cluster of graphemes(segment.text)) {
          const w = clusterWidth(cluster);
          if (w === 0) continue;
          this.put(cx, y + r, cluster, w, segment.style);
          cx += w;
        }
      }
    }
  }

  /** Dim every cell — the backdrop behind a modal layer. */
  shade(): void {
    const dimmed = internStyle({ dim: true });
    for (const row of this.#cells) {
      for (let x = 0; x < row.length; x++) {
        const cell = row[x]!;
        row[x] = { text: cell.text, width: cell.width, style: mergeStyle(cell.style, dimmed) };
      }
    }
  }

  markHit(id: string, rect: Rect, depth: number): void {
    this.#hits.push({ id, depth, ...rect });
  }

  /** Painted rect of the node that carried `id`, for anchoring layers. */
  findHit(id: string): HitRect | undefined {
    for (let i = this.#hits.length - 1; i >= 0; i--) {
      if (this.#hits[i]!.id === id) return this.#hits[i];
    }
    return undefined;
  }

  setCursor(placement: CursorPlacement): void {
    this.#cursor = placement;
  }

  /** Compact cells into a frame: adjacent equal-style cells merge, trailing default blanks trim. */
  toFrame(): Frame {
    const rows: Row[] = [];
    for (const cells of this.#cells) {
      let end = cells.length;
      while (end > 0) {
        const cell = cells[end - 1]!;
        if (cell.text === ' ' && cell.width === 1 && cell.style === EMPTY_STYLE) end--;
        else break;
      }
      const segments: Segment[] = [];
      let text = '';
      let width = 0;
      let style: Style = EMPTY_STYLE;
      for (let x = 0; x < end; x++) {
        const cell = cells[x]!;
        if (cell.width === 0) continue;
        if (cell.style !== style && text.length > 0) {
          segments.push({ text, width, style });
          text = '';
          width = 0;
        }
        style = cell.style;
        text += cell.text;
        width += cell.width;
      }
      if (text.length > 0) segments.push({ text, width, style });
      let total = 0;
      for (const segment of segments) total += segment.width;
      rows.push({ segments, width: total });
    }
    return {
      width: this.width,
      height: this.height,
      rows,
      cursor: this.#cursor,
      hits: this.#hits,
    };
  }
}

interface Piece {
  cluster: string;
  width: number;
  style: Style;
  space: boolean;
  newline: boolean;
  /** Character offset (in code points) of this cluster in the source text. */
  offset: number;
  chars: number;
}

function toPieces(segments: readonly Segment[], startOffset: number): Piece[] {
  const pieces: Piece[] = [];
  let offset = startOffset;
  for (const segment of segments) {
    for (const cluster of graphemes(segment.text)) {
      const chars = Array.from(cluster).length;
      pieces.push({
        cluster,
        width: cluster === '\n' ? 0 : clusterWidth(cluster),
        style: segment.style,
        space: cluster === ' ',
        newline: cluster === '\n',
        offset,
        chars,
      });
      offset += chars;
    }
  }
  return pieces;
}

function breakPieces(pieces: Piece[], width: number, mode: WrapMode): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let lineWidth = 0;

  function push(): void {
    lines.push(line);
    line = [];
    lineWidth = 0;
  }

  for (const piece of pieces) {
    if (piece.newline) {
      push();
      continue;
    }
    if (mode === 'none') {
      line.push(piece);
      lineWidth += piece.width;
      continue;
    }
    if (lineWidth + piece.width > width) {
      if (mode === 'word') {
        let breakAt = -1;
        for (let j = line.length - 1; j >= 0; j--) {
          if (line[j]!.space) {
            breakAt = j;
            break;
          }
        }
        if (piece.space) {
          push();
          continue;
        }
        if (breakAt >= 0) {
          const carried = line.slice(breakAt + 1);
          line = line.slice(0, breakAt);
          push();
          line = carried;
          lineWidth = 0;
          for (const c of line) lineWidth += c.width;
        } else {
          push();
        }
      } else {
        push();
      }
    }
    if (!(line.length === 0 && piece.space && mode === 'word' && lines.length > 0)) {
      line.push(piece);
      lineWidth += piece.width;
    }
  }
  push();
  return lines;
}

function piecesToRow(entries: Piece[]): Row {
  const segments: Segment[] = [];
  let text = '';
  let w = 0;
  let style: Style = EMPTY_STYLE;
  let total = 0;
  for (const piece of entries) {
    if (piece.style !== style && text.length > 0) {
      segments.push({ text, width: w, style });
      text = '';
      w = 0;
    }
    style = piece.style;
    text += piece.cluster;
    w += piece.width;
    total += piece.width;
  }
  if (text.length > 0) segments.push({ text, width: w, style });
  return { segments, width: total };
}

/** Wrap styled segments to a cell width. Hard newlines always break. */
export function wrapSegments(segments: readonly Segment[], width: number, mode: WrapMode): Row[] {
  if (width <= 0) return [{ segments: [], width: 0 }];
  return breakPieces(toPieces(segments, 0), width, mode).map(piecesToRow);
}

function nodeChildren(node: LayoutNode): ReadonlyArray<LayoutNode | string> {
  return node.children;
}

function childText(node: LayoutNode): string {
  if (node.type === '#text') return node.text ?? '';
  let out = '';
  for (const child of nodeChildren(node)) {
    out += typeof child === 'string' ? child : childText(child);
  }
  return out;
}

function textSegments(node: LayoutNode, base: Style): { rows: Row[]; multiline: boolean } {
  const content = childText(node);
  if (content.includes('\x1b')) {
    return { rows: parseAnsi(content, base), multiline: true };
  }
  const lines = content.split('\n');
  return {
    rows: lines.map((line) => {
      const width = stringWidth(line);
      return {
        segments: line.length > 0 ? [{ text: line, width, style: base }] : [],
        width,
      } as Row;
    }),
    multiline: lines.length > 1,
  };
}

function wrapMode(props: Record<string, unknown>): WrapMode {
  const wrap = props.wrap;
  if (wrap === true) return 'word';
  if (wrap === 'word' || wrap === 'char' || wrap === 'none') return wrap;
  return 'none';
}

function wrappedTextRows(node: LayoutNode, width: number, base: Style): Row[] {
  const { rows } = textSegments(node, base);
  const mode = wrapMode(node.props);
  const out: Row[] = [];
  for (const row of rows) {
    if (mode === 'none') {
      out.push(row);
    } else {
      out.push(...wrapSegments(row.segments, width, mode));
    }
  }
  return out.length === 0 ? [{ segments: [], width: 0 }] : out;
}

interface ChildLayout {
  grow: number;
  shrink: number;
  basis: number | undefined;
  marginX: number;
  marginY: number;
  alignSelf: Align | undefined;
}

function childLayoutProps(node: LayoutNode | string): ChildLayout {
  if (typeof node === 'string' || node.type === '#text') {
    return { grow: 0, shrink: 0, basis: undefined, marginX: 0, marginY: 0, alignSelf: undefined };
  }
  const props = node.props;
  const flex = num(props, 'flex');
  const margin = num(props, 'margin') ?? 0;
  const alignSelf = str(props, 'alignSelf') as Align | undefined;
  return {
    grow: num(props, 'grow') ?? flex ?? 0,
    shrink: num(props, 'shrink') ?? 0,
    basis: num(props, 'basis'),
    marginX: num(props, 'marginX') ?? margin,
    marginY: num(props, 'marginY') ?? margin,
    alignSelf,
  };
}

const measureCache = new WeakMap<object, Map<string, Measured>>();
const nodeRects = new WeakMap<object, Rect>();

/** Frame-relative rect a node was last painted at, for event dispatch. */
export function nodeRect(node: object): Rect | undefined {
  return nodeRects.get(node);
}

/** Drop cached measurements for a retained node (called by the host on change). */
export function invalidateMeasure(node: object): void {
  measureCache.delete(node);
}

interface BoxSpec {
  direction: 'row' | 'column';
  rounded: boolean;
  wrap: boolean;
  gap: number;
  justify: Justify;
  align: Align;
  border: BorderStyle | null;
  borderColor: Color | undefined;
  insetX: number;
  insetY: number;
}

function boxSpec(node: LayoutNode): BoxSpec {
  const props = node.props;
  const borderProp = props.border;
  const borderStyle = str(props, 'borderStyle') as BorderStyle | undefined;
  const border: BorderStyle | null =
    borderProp === true
      ? (borderStyle ?? 'single')
      : typeof borderProp === 'string' && borderProp in BORDERS
        ? (borderProp as BorderStyle)
        : null;
  const padding = num(props, 'padding') ?? 0;
  const paddingX = num(props, 'paddingX') ?? padding;
  const paddingY = num(props, 'paddingY') ?? padding;
  const borderInset = border ? 1 : 0;
  const justify = (str(props, 'justify') as Justify | undefined) ?? 'start';
  const align = (str(props, 'align') as Align | undefined) ?? 'stretch';
  return {
    direction: str(props, 'direction') === 'row' ? 'row' : 'column',
    rounded: props.rounded === true,
    wrap: props.wrap === true,
    gap: num(props, 'gap') ?? 0,
    justify,
    align,
    border,
    borderColor: props.borderColor as Color | undefined,
    insetX: borderInset + paddingX,
    insetY: borderInset + paddingY,
  };
}

function clampAxis(
  props: Record<string, unknown>,
  axis: 'width' | 'height',
  value: number,
): number {
  const min = num(props, axis === 'width' ? 'minWidth' : 'minHeight');
  const max = num(props, axis === 'width' ? 'maxWidth' : 'maxHeight');
  let out = value;
  if (max !== undefined) out = Math.min(out, max);
  if (min !== undefined) out = Math.max(out, min);
  return out;
}

/** Content-based size of a node under a width constraint. */
export function measure(node: LayoutNode | string, constraints: Constraints): Measured {
  if (typeof node === 'string') {
    return { width: stringWidth(node), height: 1 };
  }
  const cacheKey = `${constraints.width}x${constraints.height ?? ''}`;
  let cached = measureCache.get(node);
  if (cached?.has(cacheKey)) return cached.get(cacheKey)!;
  const result = measureUncached(node, constraints);
  if (!cached) {
    cached = new Map();
    measureCache.set(node, cached);
  }
  cached.set(cacheKey, result);
  return result;
}

function measureUncached(node: LayoutNode, constraints: Constraints): Measured {
  const props = node.props;
  const explicitW = num(props, 'width');
  const explicitH = num(props, 'height');
  const availW = Math.max(0, explicitW ?? constraints.width);

  let size: Measured;
  switch (node.type) {
    case '#text':
      size = { width: stringWidth(node.text ?? ''), height: 1 };
      break;
    case 'text': {
      const rows = wrappedTextRows(node, availW, EMPTY_STYLE);
      let widest = 0;
      for (const row of rows) widest = Math.max(widest, row.width);
      size = { width: Math.min(widest, availW), height: rows.length };
      break;
    }
    case 'spacer':
      size = { width: num(props, 'width') ?? 0, height: num(props, 'height') ?? 1 };
      break;
    case 'input': {
      const value = str(props, 'value') ?? str(props, 'placeholder') ?? '';
      size = { width: Math.max(1, stringWidth(value) + 2), height: 1 };
      break;
    }
    case 'button': {
      const label = str(props, 'label') ?? childText(node);
      const prefix = props.focused === true ? 2 : 0;
      size = { width: stringWidth(label) + 4 + prefix, height: 1 };
      break;
    }
    case 'list': {
      const items = Array.isArray(props.items) ? (props.items as string[]) : [];
      let widest = 0;
      for (const item of items) widest = Math.max(widest, stringWidth(item) + 2);
      size = { width: widest, height: items.length };
      break;
    }
    case 'scrollview': {
      const inner = measureFlex(
        { ...node, props: { ...props, direction: 'column' } } as LayoutNode,
        { width: availW },
        {
          direction: 'column',
          wrap: false,
          gap: 0,
          justify: 'start',
          align: 'start',
          border: null,
          borderColor: undefined,
          insetX: 0,
          insetY: 0,
        },
      );
      size = { width: inner.width, height: explicitH ?? inner.height };
      break;
    }
    case 'layer':
      size = { width: 0, height: 0 };
      break;
    case 'rule':
      size = { width: availW, height: 1 };
      break;
    default:
      size = measureFlex(node, constraints, boxSpec(node));
      break;
  }
  return {
    width: clampAxis(props, 'width', explicitW ?? size.width),
    height: clampAxis(props, 'height', explicitH ?? size.height),
  };
}

function layoutChildren(node: LayoutNode): Array<LayoutNode | string> {
  const out: Array<LayoutNode | string> = [];
  for (const child of nodeChildren(node)) {
    if (typeof child !== 'string' && child.type === 'layer') continue;
    out.push(child);
  }
  return out;
}

function measureFlex(node: LayoutNode, constraints: Constraints, spec: BoxSpec): Measured {
  const props = node.props;
  const explicitW = num(props, 'width');
  const outerW = explicitW ?? constraints.width;
  const innerW = Math.max(0, outerW - spec.insetX * 2);
  const row = spec.direction === 'row';

  interface Sized {
    main: number;
    cross: number;
  }
  const sized: Sized[] = [];
  for (const child of layoutChildren(node)) {
    const cl = childLayoutProps(child);
    const m = measure(child, { width: Math.max(0, innerW - cl.marginX * 2) });
    const main = (cl.basis ?? (row ? m.width : m.height)) + (row ? cl.marginX : cl.marginY) * 2;
    const cross = (row ? m.height : m.width) + (row ? cl.marginY : cl.marginX) * 2;
    if (main === 0 && cross === 0 && cl.grow === 0) continue;
    sized.push({ main, cross });
  }
  const gapCount = Math.max(0, sized.length - 1);

  if (spec.wrap && row) {
    let lineMain = 0;
    let lineCross = 0;
    let widest = 0;
    let height = 0;
    let count = 0;
    for (const item of sized) {
      const gap = count > 0 ? spec.gap : 0;
      if (count > 0 && lineMain + gap + item.main > innerW) {
        widest = Math.max(widest, lineMain);
        height += lineCross;
        lineMain = 0;
        lineCross = 0;
        count = 0;
      }
      lineMain += (count > 0 ? spec.gap : 0) + item.main;
      lineCross = Math.max(lineCross, item.cross);
      count++;
    }
    widest = Math.max(widest, lineMain);
    height += lineCross;
    return {
      width: (explicitW ?? Math.min(widest, innerW)) + (explicitW ? 0 : spec.insetX * 2),
      height: height + spec.insetY * 2,
    };
  }

  let mainTotal = 0;
  let crossMax = 0;
  for (const item of sized) {
    mainTotal += item.main;
    crossMax = Math.max(crossMax, item.cross);
  }
  mainTotal += gapCount * spec.gap;
  if (row) {
    return {
      width: (explicitW ?? Math.min(mainTotal, innerW)) + (explicitW ? 0 : spec.insetX * 2),
      height: crossMax + spec.insetY * 2,
    };
  }
  return {
    width: (explicitW ?? Math.min(crossMax, innerW)) + (explicitW ? 0 : spec.insetX * 2),
    height: mainTotal + spec.insetY * 2,
  };
}

interface Placed {
  child: LayoutNode | string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function placeFlex(node: LayoutNode, spec: BoxSpec, innerW: number, innerH: number): Placed[] {
  const children = layoutChildren(node);
  const row = spec.direction === 'row';
  const mainSize = row ? innerW : innerH;
  const crossSize = row ? innerH : innerW;

  interface Item {
    child: LayoutNode | string;
    cl: ChildLayout;
    main: number;
    cross: number;
    marginMain: number;
    marginCross: number;
    /** Zero-size children still get placed (they may carry layers) but never a gap. */
    empty: boolean;
  }

  const items: Item[] = [];
  for (const child of children) {
    const cl = childLayoutProps(child);
    const marginMain = row ? cl.marginX : cl.marginY;
    const marginCross = row ? cl.marginY : cl.marginX;
    const availCross = Math.max(0, crossSize - marginCross * 2);
    const m = measure(child, { width: row ? Math.max(0, mainSize) : availCross });
    let main = cl.basis ?? (row ? m.width : m.height);
    const cross = row ? m.height : m.width;
    const isSpacer = typeof child !== 'string' && child.type === 'spacer';
    if (isSpacer && cl.grow > 0) {
      main =
        cl.basis ?? (row ? (num(child.props, 'width') ?? 0) : (num(child.props, 'height') ?? 0));
    }
    const empty = main === 0 && cross === 0 && cl.grow === 0;
    items.push({ child, cl, main, cross, marginMain, marginCross, empty });
  }

  const lines: Item[][] = [];
  if (spec.wrap && row) {
    let line: Item[] = [];
    let used = 0;
    for (const item of items) {
      const outer = item.main + item.marginMain * 2;
      const gap = line.length > 0 ? spec.gap : 0;
      if (line.length > 0 && used + gap + outer > mainSize) {
        lines.push(line);
        line = [];
        used = 0;
      }
      line.push(item);
      used += (line.length > 1 ? spec.gap : 0) + outer;
    }
    if (line.length > 0) lines.push(line);
  } else {
    lines.push(items);
  }

  const placed: Placed[] = [];
  let crossOffset = 0;
  for (const line of lines) {
    const occupied = line.filter((item) => !item.empty).length;
    const gapTotal = Math.max(0, occupied - 1) * spec.gap;
    let usedMain = gapTotal;
    let growTotal = 0;
    let shrinkTotal = 0;
    for (const item of line) {
      usedMain += item.main + item.marginMain * 2;
      growTotal += item.cl.grow;
      shrinkTotal += item.cl.shrink;
    }
    let free = mainSize - usedMain;
    if (free > 0 && growTotal > 0) {
      let remaining = free;
      let weightLeft = growTotal;
      for (const item of line) {
        if (item.cl.grow <= 0) continue;
        const share = Math.floor((remaining * item.cl.grow) / weightLeft);
        item.main += share;
        remaining -= share;
        weightLeft -= item.cl.grow;
      }
      free = 0;
    } else if (free < 0 && shrinkTotal > 0) {
      let deficit = -free;
      let weightLeft = shrinkTotal;
      for (const item of line) {
        if (item.cl.shrink <= 0) continue;
        const share = Math.min(item.main, Math.floor((deficit * item.cl.shrink) / weightLeft));
        item.main -= share;
        deficit -= share;
        weightLeft -= item.cl.shrink;
      }
      free = -deficit;
    }

    let cursor = 0;
    if (free > 0) {
      if (spec.justify === 'center') cursor = Math.floor(free / 2);
      else if (spec.justify === 'end') cursor = free;
    }
    const betweenExtra =
      spec.justify === 'between' && line.length > 1 && free > 0 ? free / (line.length - 1) : 0;

    let lineCross = 0;
    for (const item of line) lineCross = Math.max(lineCross, item.cross + item.marginCross * 2);
    if (lines.length === 1 && !spec.wrap) lineCross = Math.max(lineCross, crossSize);

    let betweenAccum = 0;
    let placedAny = false;
    for (let i = 0; i < line.length; i++) {
      const item = line[i]!;
      if (!item.empty && placedAny) cursor += spec.gap;
      const alignSelf = item.cl.alignSelf ?? spec.align;
      let itemCross = item.cross;
      if (alignSelf === 'stretch')
        itemCross = Math.max(itemCross, lineCross - item.marginCross * 2);
      let crossPos = item.marginCross;
      if (alignSelf === 'center')
        crossPos += Math.floor((lineCross - itemCross - item.marginCross * 2) / 2);
      else if (alignSelf === 'end') crossPos += lineCross - itemCross - item.marginCross * 2;
      const mainPos = cursor + item.marginMain;
      placed.push({
        child: item.child,
        x: row ? mainPos : crossOffset + crossPos,
        y: row ? crossOffset + crossPos : mainPos,
        width: row ? item.main : itemCross,
        height: row ? itemCross : item.main,
      });
      cursor += item.main + item.marginMain * 2;
      if (!item.empty) placedAny = true;
      if (betweenExtra > 0 && i < line.length - 1) {
        betweenAccum += betweenExtra;
        const step = Math.floor(betweenAccum);
        cursor += step;
        betweenAccum -= step;
      }
    }
    crossOffset += lineCross;
  }
  return placed;
}

interface PaintContext {
  canvas: Canvas;
  depth: number;
  layers: Array<{ node: LayoutNode; inherited: Style; depth: number }>;
}

function paintBorder(
  canvas: Canvas,
  rect: Rect,
  border: BorderStyle,
  rounded: boolean,
  style: Style,
): void {
  if (rect.width < 2 || rect.height < 2) return;
  const [stl, str_, sbl, sbr, hbar, vbar] = BORDERS[border];
  const corners = rounded ? ROUNDED_CORNERS[border] : undefined;
  const [tl, tr, bl, br] = corners ?? [stl, str_, sbl, sbr];
  canvas.put(rect.x, rect.y, tl, 1, style);
  canvas.put(rect.x + rect.width - 1, rect.y, tr, 1, style);
  canvas.put(rect.x, rect.y + rect.height - 1, bl, 1, style);
  canvas.put(rect.x + rect.width - 1, rect.y + rect.height - 1, br, 1, style);
  for (let x = rect.x + 1; x < rect.x + rect.width - 1; x++) {
    canvas.put(x, rect.y, hbar, 1, style);
    canvas.put(x, rect.y + rect.height - 1, hbar, 1, style);
  }
  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y++) {
    canvas.put(rect.x, y, vbar, 1, style);
    canvas.put(rect.x + rect.width - 1, y, vbar, 1, style);
  }
}

function alignOffset(align: string | undefined, space: number): number {
  if (space <= 0) return 0;
  if (align === 'center') return Math.floor(space / 2);
  if (align === 'end') return space;
  return 0;
}

function paintNode(
  node: LayoutNode | string,
  ctx: PaintContext,
  rect: Rect,
  inherited: Style,
): void {
  const { canvas } = ctx;
  if (typeof node === 'string') {
    canvas.draw(rect.x, rect.y, [
      {
        segments: [{ text: node, width: stringWidth(node), style: inherited }],
        width: stringWidth(node),
      },
    ]);
    return;
  }
  if (node.type === '#text') {
    const text = node.text ?? '';
    canvas.draw(rect.x, rect.y, [
      {
        segments: [{ text, width: stringWidth(text), style: inherited }],
        width: stringWidth(text),
      },
    ]);
    return;
  }
  const props = node.props;
  const own = mergeStyle(inherited, styleFromProps(props));
  ctx.depth++;
  const depth = ctx.depth;
  nodeRects.set(node, rect);
  const id = str(props, 'id');
  if (id) canvas.markHit(id, rect, depth);

  const bg = styleFromProps(props).bg;
  if (bg !== undefined) canvas.fill(rect, internStyle({ bg }));

  switch (node.type) {
    case 'text': {
      const rows = wrappedTextRows(node, rect.width, own);
      const alignProp = str(props, 'align');
      const truncate = props.truncate === true;
      canvas.clipPush(rect);
      for (let i = 0; i < rows.length && i < rect.height; i++) {
        let row = rows[i]!;
        if (truncate && row.width > rect.width && rect.width > 1) {
          const clipped = wrapSegments(row.segments, rect.width - 1, 'char')[0]!;
          row = {
            segments: [...clipped.segments, { text: '…', width: 1, style: own }],
            width: clipped.width + 1,
          };
        }
        const dx = alignOffset(alignProp, rect.width - row.width);
        canvas.draw(rect.x + dx, rect.y + i, [row]);
      }
      canvas.clipPop();
      const caret = num(props, 'caret');
      if (caret !== undefined) {
        const placed = caretPosition(node, rect.width, caret);
        if (placed) {
          canvas.setCursor({ row: rect.y + placed.row, column: rect.x + placed.column });
        }
      }
      break;
    }
    case 'spacer':
      break;
    case 'rule': {
      const char = str(props, 'char') ?? '─';
      const inset = num(props, 'inset') ?? 0;
      const cells = Math.max(0, rect.width - inset);
      canvas.clipPush(rect);
      canvas.draw(rect.x, rect.y, [
        { segments: [{ text: char.repeat(cells), width: cells, style: own }], width: cells },
      ]);
      canvas.clipPop();
      break;
    }
    case 'input': {
      const focused = props.focused === true;
      const value = str(props, 'value') ?? '';
      const placeholder = str(props, 'placeholder') ?? '';
      const shown = value.length > 0 ? value : placeholder;
      const prefix = focused ? '> ' : '  ';
      const textStyle = value.length > 0 ? own : mergeStyle(own, { dim: true });
      canvas.clipPush(rect);
      canvas.draw(rect.x, rect.y, [
        {
          segments: [
            { text: prefix, width: 2, style: own },
            { text: shown, width: stringWidth(shown), style: textStyle },
          ],
          width: 2 + stringWidth(shown),
        },
      ]);
      canvas.clipPop();
      const caret = num(props, 'caret');
      if (focused) {
        const column = 2 + (caret !== undefined ? Math.min(caret, value.length) : value.length);
        canvas.setCursor({ row: rect.y, column: rect.x + Math.min(column, rect.width - 1) });
      }
      break;
    }
    case 'button': {
      const label = str(props, 'label') ?? childText(node);
      const focused = props.focused === true;
      const text = `${focused ? '> ' : ''}[ ${label} ]`;
      canvas.clipPush(rect);
      canvas.draw(rect.x, rect.y, [
        { segments: [{ text, width: stringWidth(text), style: own }], width: stringWidth(text) },
      ]);
      canvas.clipPop();
      break;
    }
    case 'list': {
      const items = Array.isArray(props.items) ? (props.items as string[]) : [];
      const selected = num(props, 'selectedIndex') ?? 0;
      canvas.clipPush(rect);
      for (let i = 0; i < items.length && i < rect.height; i++) {
        const text = (i === selected ? '> ' : '  ') + items[i]!;
        canvas.draw(rect.x, rect.y + i, [
          { segments: [{ text, width: stringWidth(text), style: own }], width: stringWidth(text) },
        ]);
      }
      canvas.clipPop();
      break;
    }
    case 'scrollview': {
      const offset = num(props, 'offset') ?? 0;
      const spec: BoxSpec = {
        direction: 'column',
        wrap: false,
        gap: 0,
        justify: 'start',
        align: 'start',
        border: null,
        borderColor: undefined,
        insetX: 0,
        insetY: 0,
      };
      const content = measureFlex(node, { width: rect.width }, spec);
      const placed = placeFlex(node, spec, rect.width, Math.max(content.height, rect.height));
      canvas.clipPush(rect);
      for (const p of placed) {
        paintNode(
          p.child,
          ctx,
          { x: rect.x + p.x, y: rect.y + p.y - offset, width: p.width, height: p.height },
          own,
        );
      }
      canvas.clipPop();
      break;
    }
    default: {
      const spec = boxSpec(node);
      if (spec.border) {
        const borderStyle =
          spec.borderColor !== undefined ? mergeStyle(own, { fg: spec.borderColor }) : own;
        paintBorder(canvas, rect, spec.border, spec.rounded, borderStyle);
        const title = str(props, 'borderTitle');
        if (title && rect.width > 4) {
          const shown = ` ${title} `;
          const clipped = wrapSegments(
            [{ text: shown, width: stringWidth(shown), style: own }],
            rect.width - 4,
            'char',
          )[0]!;
          canvas.draw(rect.x + 2, rect.y, [clipped]);
        }
      }
      const innerRect: Rect = {
        x: rect.x + spec.insetX,
        y: rect.y + spec.insetY,
        width: Math.max(0, rect.width - spec.insetX * 2),
        height: Math.max(0, rect.height - spec.insetY * 2),
      };
      const placed = placeFlex(node, spec, innerRect.width, innerRect.height);
      const clip = props.overflow === 'visible' ? null : innerRect;
      if (clip) canvas.clipPush(clip);
      for (const p of placed) {
        paintNode(
          p.child,
          ctx,
          { x: innerRect.x + p.x, y: innerRect.y + p.y, width: p.width, height: p.height },
          own,
        );
      }
      if (clip) canvas.clipPop();
      break;
    }
  }
  for (const child of nodeChildren(node)) {
    if (typeof child !== 'string' && child.type === 'layer') {
      ctx.layers.push({ node: child, inherited: own, depth: ctx.depth });
    }
  }
}

/**
 * Character offset → wrapped (row, column) within a text node. Offsets count
 * code points of the node's full text, including characters that wrapping
 * consumes (break spaces, newlines) — a caret pointing at a consumed
 * character lands at the start of the following line.
 */
export function caretPosition(
  node: LayoutNode,
  width: number,
  caret: number,
): { row: number; column: number } | null {
  const { rows } = textSegments(node, EMPTY_STYLE);
  const mode = wrapMode(node.props);
  let rowIndex = 0;
  let offset = 0;
  let last: { row: number; column: number } | null = null;
  for (const source of rows) {
    const pieces = toPieces(source.segments, offset);
    let sourceChars = 0;
    for (const piece of pieces) sourceChars += piece.chars;
    const lines = mode === 'none' || width <= 0 ? [pieces] : breakPieces(pieces, width, mode);
    for (const line of lines) {
      let column = 0;
      for (const piece of line) {
        if (caret <= piece.offset) return { row: rowIndex, column };
        if (caret < piece.offset + piece.chars) return { row: rowIndex, column };
        column += piece.width;
      }
      last = { row: rowIndex, column };
      const next = line[line.length - 1];
      if (next && caret <= next.offset + next.chars) return last;
      rowIndex++;
    }
    offset += sourceChars + 1;
    if (caret < offset && last) return last;
  }
  return last;
}

function paintLayer(
  entry: { node: LayoutNode; inherited: Style; depth: number },
  ctx: PaintContext,
): void {
  const { canvas } = ctx;
  const node = entry.node;
  const props = node.props;
  const spec: BoxSpec = {
    direction: 'column',
    wrap: false,
    gap: 0,
    justify: 'start',
    align: 'start',
    border: null,
    borderColor: undefined,
    insetX: 0,
    insetY: 0,
  };
  const content = measureFlex(node, { width: canvas.width }, spec);
  const width = Math.min(num(props, 'width') ?? content.width, canvas.width);
  const height = Math.min(num(props, 'height') ?? content.height, canvas.height);
  let anchor = props.anchor as { x: number; y: number } | undefined;
  const anchorId = str(props, 'anchorId');
  if (!anchor && anchorId) {
    const target = canvas.findHit(anchorId);
    if (target) anchor = { x: target.x, y: target.y + target.height - 1 };
  }
  const placement = str(props, 'placement') ?? (anchor ? 'bottom-start' : 'center');
  let x: number;
  let y: number;
  if (anchor) {
    x = placement.endsWith('end') ? anchor.x - width + 1 : anchor.x;
    y = placement.startsWith('top') ? anchor.y - height : anchor.y + 1;
  } else {
    x = Math.floor((canvas.width - width) / 2);
    y = Math.floor((canvas.height - height) / 2);
  }
  x = Math.max(0, Math.min(x, canvas.width - width));
  y = Math.max(0, Math.min(y, canvas.height - height));
  if (props.backdrop === true) canvas.shade();
  const rect: Rect = { x, y, width, height };
  if (props.transparent !== true) {
    for (let ry = rect.y; ry < rect.y + rect.height; ry++) {
      for (let rx = rect.x; rx < rect.x + rect.width; rx++) {
        canvas.put(rx, ry, ' ', 1, EMPTY_STYLE);
      }
    }
  }
  const inner = { ...node, type: 'box' } as LayoutNode;
  paintNode(inner, ctx, rect, entry.inherited);
}

/** Lay a tree out and paint it into a frame. */
export function layout(node: LayoutNode, constraints: Constraints): Frame {
  const width = Math.max(0, Math.floor(constraints.width));
  const measured = measure(node, { width });
  const height = Math.max(0, Math.floor(constraints.height ?? measured.height));
  const canvas = new Canvas(width, height);
  const ctx: PaintContext = { canvas, depth: 0, layers: [] };
  paintNode(node, ctx, { x: 0, y: 0, width, height }, EMPTY_STYLE);
  let guard = 0;
  while (ctx.layers.length > 0 && guard++ < 16) {
    const pending = ctx.layers.splice(0, ctx.layers.length);
    for (const entry of pending) paintLayer(entry, ctx);
  }
  return canvas.toFrame();
}
