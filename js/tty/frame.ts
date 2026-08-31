/**
 * fino:tty/frame — the styled-cell intermediate representation for terminal
 * output.
 *
 * A `Frame` is what a laid-out component tree becomes: rows of styled text
 * segments, a cursor placement, and hit regions for mouse routing. Segments
 * hold printable text only — no escape sequences, no newlines — so wrapping,
 * clipping, and composition can never corrupt ANSI state. Bytes are produced
 * only at the wire edge by `rowToAnsi()`, `frameToAnsi()`, and
 * `frameToScreen()`.
 *
 * Rows are ragged: trailing blank cells are not materialized. Whether a row
 * gets padded, and with what style, is a decision for the code that writes it
 * to a terminal — a filled final column is recorded as a soft wrap by real
 * terminals, so writers routinely stop one cell short.
 *
 * ```ts
 * import { rowToAnsi, textRow } from 'fino:tty/frame';
 *
 * const row = textRow('ready', { fg: 'green' });
 * const bytes = rowToAnsi(row, { pad: 10 });
 * ```
 */
import { EMPTY_STYLE, applySgr, internStyle, styleToSgr } from 'fino:tty/style';
import type { Style } from 'fino:tty/style';
import { charWidth, graphemes, clusterWidth, stringWidth } from 'internal:tty/width';

export { charWidth, graphemes, clusterWidth, stringWidth };

/**
 * A run of printable text in one style. `text` contains no escape sequences,
 * newlines, or tabs; `width` is its cell width (wide characters count two,
 * combining marks zero).
 */
export interface Segment {
  readonly text: string;
  readonly width: number;
  readonly style: Style;
}

/** One terminal row: styled segments, ragged (no trailing padding). */
export interface Row {
  readonly segments: readonly Segment[];
  /** Sum of segment widths. */
  readonly width: number;
}

/** An axis-aligned cell rectangle. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the terminal cursor should sit after a frame is painted. */
export interface CursorPlacement {
  /** Frame-relative row, 0-based. */
  readonly row: number;
  /** Frame-relative column, 0-based. */
  readonly column: number;
  readonly shape?: 'block' | 'bar' | 'underline';
}

/** The resolved rectangle of a node that carried an `id`, in paint order. */
export interface HitRect extends Rect {
  readonly id: string;
  /** Tree depth; deeper nodes win hit-testing ties. */
  readonly depth: number;
}

/** A complete laid-out surface. `rows` has exactly `height` entries. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly Row[];
  readonly cursor: CursorPlacement | null;
  readonly hits: readonly HitRect[];
}

/** An empty row. */
export const EMPTY_ROW: Row = Object.freeze({ segments: Object.freeze([]), width: 0 });

/** Build a single-segment row from plain text. */
export function textRow(text: string, style: Style = EMPTY_STYLE): Row {
  if (text.length === 0) return EMPTY_ROW;
  const segment: Segment = { text, width: stringWidth(text), style: internStyle(style) };
  return { segments: [segment], width: segment.width };
}

/** Concatenate rows into one. */
export function joinRows(...rows: Row[]): Row {
  const segments: Segment[] = [];
  let width = 0;
  for (const row of rows) {
    for (const segment of row.segments) {
      const last = segments[segments.length - 1];
      if (last && last.style === segment.style) {
        segments[segments.length - 1] = {
          text: last.text + segment.text,
          width: last.width + segment.width,
          style: last.style,
        };
      } else {
        segments.push(segment);
      }
      width += segment.width;
    }
  }
  return { segments, width };
}

/**
 * Cut a row down to at most `width` cells. A wide character straddling the
 * boundary is dropped, leaving the row one cell short rather than corrupting
 * the grid.
 */
export function clipRow(row: Row, width: number): Row {
  if (row.width <= width) return row;
  const segments: Segment[] = [];
  let used = 0;
  for (const segment of row.segments) {
    if (used >= width) break;
    if (used + segment.width <= width) {
      segments.push(segment);
      used += segment.width;
      continue;
    }
    let text = '';
    let taken = 0;
    for (const cluster of graphemes(segment.text)) {
      const w = clusterWidth(cluster);
      if (used + taken + w > width) break;
      text += cluster;
      taken += w;
    }
    if (text.length > 0) {
      segments.push({ text, width: taken, style: segment.style });
      used += taken;
    }
    break;
  }
  return { segments, width: used };
}

/** Options for encoding one row as ANSI bytes. */
export interface EncodeRowOptions {
  /** Pad with spaces to this cell width. */
  readonly pad?: number;
  /** Clip to at most this many cells first. */
  readonly clip?: number;
  /** Style applied to padding cells (a background fill). */
  readonly padStyle?: Style;
}

/**
 * Encode one row as ANSI bytes, starting from and returning to the default
 * style. The result is a pure function of the row and options, so equal rows
 * encode to equal strings — callers use the encoded form as a diff key.
 */
export function rowToAnsi(row: Row, options: EncodeRowOptions = {}): string {
  const clipped = options.clip !== undefined ? clipRow(row, options.clip) : row;
  let out = '';
  let current = EMPTY_STYLE;
  for (const segment of clipped.segments) {
    if (segment.text.length === 0) continue;
    out += styleToSgr(current, segment.style);
    current = segment.style;
    out += segment.text;
  }
  if (options.pad !== undefined && clipped.width < options.pad) {
    const padStyle = options.padStyle ? internStyle(options.padStyle) : EMPTY_STYLE;
    out += styleToSgr(current, padStyle);
    current = padStyle;
    out += ' '.repeat(options.pad - clipped.width);
  }
  out += styleToSgr(current, EMPTY_STYLE);
  return out;
}

/** Encode a whole frame, `\n`-joined, each row padded to the frame width. */
export function frameToAnsi(frame: Frame, options: { pad?: boolean } = {}): string {
  const pad = options.pad !== false;
  return frame.rows
    .map((row) =>
      rowToAnsi(row, pad ? { clip: frame.width, pad: frame.width } : { clip: frame.width }),
    )
    .join('\n');
}

/**
 * Encode an absolute-addressed repaint of `frame`, touching only rows whose
 * encoded form differs from `previous`. Rows the previous frame had beyond
 * the new height are erased. `origin` is 1-based screen coordinates.
 */
export function frameToScreen(
  frame: Frame,
  previous: Frame | null,
  origin: { row: number; column: number } = { row: 1, column: 1 },
): string {
  let out = '';
  const before =
    previous && previous.width === frame.width
      ? previous.rows.map((row) => rowToAnsi(row, { clip: previous.width }))
      : null;
  for (let i = 0; i < frame.rows.length; i++) {
    const encoded = rowToAnsi(frame.rows[i]!, { clip: frame.width });
    if (before && before[i] === encoded) continue;
    // Erase before writing: on a row that fills the terminal the cursor stays
    // parked in the last column with a wrap pending, so a trailing erase would
    // delete the character just written.
    out += `\x1b[${origin.row + i};${origin.column}H\x1b[K${encoded}`;
  }
  if (previous) {
    for (let i = frame.rows.length; i < previous.rows.length; i++) {
      out += `\x1b[${origin.row + i};${origin.column}H\x1b[K`;
    }
  }
  return out;
}

/** The id of the topmost hit region containing the cell, if any. */
export function hitTest(frame: Frame, x: number, y: number): string | undefined {
  const path = hitPath(frame, x, y);
  return path[path.length - 1];
}

/** All hit region ids containing the cell, outermost first. */
export function hitPath(frame: Frame, x: number, y: number): string[] {
  const containing: HitRect[] = [];
  for (const hit of frame.hits) {
    if (x >= hit.x && x < hit.x + hit.width && y >= hit.y && y < hit.y + hit.height) {
      containing.push(hit);
    }
  }
  containing.sort((a, b) => a.depth - b.depth);
  return containing.map((hit) => hit.id);
}

const TAB_STOP = 8;

/**
 * Parse text that may contain SGR escape sequences into styled rows. `\n`
 * splits rows, `\r` is dropped, and tabs expand to 8-column stops. Non-SGR
 * escape sequences are discarded — cursor movement embedded in cell data
 * would corrupt a grid, so producers of control sequences must not route
 * through this.
 */
export function parseAnsi(text: string, base: Style = EMPTY_STYLE): Row[] {
  const rows: Row[] = [];
  let segments: Segment[] = [];
  let rowWidth = 0;
  let pending = '';
  let pendingWidth = 0;
  let style = internStyle(base);

  function flushSegment(): void {
    if (pending.length === 0) return;
    segments.push({ text: pending, width: pendingWidth, style });
    rowWidth += pendingWidth;
    pending = '';
    pendingWidth = 0;
  }

  function flushRow(): void {
    flushSegment();
    rows.push({ segments, width: rowWidth });
    segments = [];
    rowWidth = 0;
  }

  function setStyle(next: Style): void {
    if (next === style) return;
    flushSegment();
    style = next;
  }

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\x1b') {
      const next = text[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < text.length && !/[a-zA-Z@`~]/.test(text[j]!)) j++;
        const final = text[j];
        if (final === 'm') {
          const body = text.slice(i + 2, j);
          const params = body.length === 0 ? [0] : body.split(/[;:]/).map((p) => Number(p) || 0);
          setStyle(applySgr(style, params));
        }
        i = j + 1;
        continue;
      }
      if (next === ']') {
        let j = i + 2;
        while (j < text.length && text[j] !== '\x07') {
          if (text[j] === '\x1b' && text[j + 1] === '\\') {
            j++;
            break;
          }
          j++;
        }
        i = j + 1;
        continue;
      }
      i += next === undefined ? 1 : 2;
      continue;
    }
    if (ch === '\n') {
      flushRow();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\t') {
      const column = rowWidth + pendingWidth;
      const spaces = TAB_STOP - (column % TAB_STOP);
      pending += ' '.repeat(spaces);
      pendingWidth += spaces;
      i++;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    if (cp >= 0x20 && cp !== 0x7f) {
      pending += char;
      pendingWidth += charWidth(cp);
    }
    i += char.length;
  }
  flushRow();
  return rows;
}

/** The cell width of text after stripping escape sequences. */
export function visibleWidth(text: string): number {
  let total = 0;
  for (const row of parseAnsi(text)) total += row.width;
  return total;
}

/** Text content of a row with styling discarded. */
export function rowText(row: Row): string {
  let out = '';
  for (const segment of row.segments) out += segment.text;
  return out;
}
