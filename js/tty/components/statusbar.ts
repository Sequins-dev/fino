/**
 * fino:tty/components/statusbar — a one-line segmented status bar.
 *
 * Segments render left to right, joined by dim ` · ` separators, and the line
 * stops where its content stops. Nothing is right-aligned and nothing is
 * padded: a status bar that stretched to the far edge would have to be
 * re-laid-out the instant a window narrowed, and until it was it would spill
 * onto the row below. Keyed segments emit hit regions so hosts with mouse
 * capture can route clicks; keyboard-only hosts ignore them. The bar keeps the
 * terminal's own background — segments color text only.
 */
import { tk, style } from 'fino:tty/components/theme';
import { visibleWidth } from 'fino:tty/tui';
import { clipAnsi } from 'fino:tty/components/text';
import type { HitRegion, RenderedPane } from 'fino:tty/components/pane';

/** One status-bar segment: text, an optional hit key, an optional style token. */
export interface Segment {
  /** Segment text; may carry its own styling, which is left intact. */
  text: string;
  /** Hit-region key for mouse hosts; segments without one are inert. */
  key?: string;
  /** Theme token(s) applied to the text. */
  style?: string;
  /**
   * Join to the previous segment with a single space instead of the ` · `
   * separator, for something that belongs to it rather than standing alone.
   */
  attached?: boolean;
}

/**
 * Render the status bar as a single row plus hit regions for keyed segments.
 *
 * Empty segments are dropped rather than leaving a stray separator behind.
 */
export function renderStatusBar(opts: { segments: Segment[]; width: number }): RenderedPane {
  const hits: HitRegion[] = [];
  const separator = style(' · ', tk.dim);
  let line = '';
  let column = 0;
  for (const segment of opts.segments) {
    if (segment.text.length === 0) continue;
    if (column > 0) {
      line += segment.attached === true ? ' ' : separator;
      column += segment.attached === true ? 1 : 3;
    }
    const width = visibleWidth(segment.text);
    if (segment.key !== undefined) {
      hits.push({ row: 0, startCol: column, endCol: column + width, key: segment.key });
    }
    line += segment.style !== undefined ? style(segment.text, segment.style) : segment.text;
    column += width;
  }
  return { lines: [clipAnsi(line, opts.width)], hits };
}
