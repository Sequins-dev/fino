/**
 * fino:tty/components/statusbar — a one-line segmented status bar.
 *
 * Left segments render in order joined by dim ` · ` separators; right
 * segments render right-aligned, joined by single spaces (the attention-dot
 * cluster). Keyed segments emit hit regions so hosts with mouse capture can
 * route clicks; keyboard-only hosts simply ignore them. The bar keeps the
 * terminal's own background — segments color text only.
 */
import { tk, style } from 'fino:tty/components/theme';
import { visibleWidth } from 'fino:tty/tui';
import { clipAnsi, padAnsi } from 'fino:tty/components/text';
import type { HitRegion, RenderedPane } from 'fino:tty/components/pane';

/** One status-bar segment: text, an optional hit key, an optional style token. */
export interface Segment {
  text: string;
  /** Hit-region key for mouse hosts; segments without one are inert. */
  key?: string;
  /** Theme token(s) applied to the text. */
  style?: string;
}

/**
 * Render the status bar as a single row plus hit regions for keyed segments.
 *
 * When the two groups overflow the width, the left group is clipped and the
 * right group survives — the attention dots must stay visible.
 */
export function renderStatusBar(opts: {
  left: Segment[];
  right?: Segment[];
  width: number;
}): RenderedPane {
  const hits: HitRegion[] = [];
  const sep = style(' · ', tk.dim);
  let leftText = '';
  let column = 0;
  for (let index = 0; index < opts.left.length; index++) {
    const segment = opts.left[index]!;
    if (index > 0) {
      leftText += sep;
      column += 3;
    }
    const width = visibleWidth(segment.text);
    if (segment.key !== undefined) {
      hits.push({ row: 0, startCol: column, endCol: column + width, key: segment.key });
    }
    leftText += segment.style !== undefined ? style(segment.text, segment.style) : segment.text;
    column += width;
  }
  const rightSegments = opts.right ?? [];
  let rightText = '';
  let rightWidth = 0;
  for (let index = 0; index < rightSegments.length; index++) {
    const segment = rightSegments[index]!;
    if (index > 0) {
      rightText += ' ';
      rightWidth += 1;
    }
    rightText += segment.style !== undefined ? style(segment.text, segment.style) : segment.text;
    rightWidth += visibleWidth(segment.text);
  }
  if (rightWidth === 0) {
    return { lines: [clipAnsi(leftText, opts.width)], hits };
  }
  const leftBudget = Math.max(0, opts.width - rightWidth - 1);
  const left = padAnsi(clipAnsi(leftText, leftBudget), leftBudget);
  const rightStart = opts.width - rightWidth;
  for (let index = 0, col = rightStart; index < rightSegments.length; index++) {
    const segment = rightSegments[index]!;
    const width = visibleWidth(segment.text);
    if (segment.key !== undefined) {
      hits.push({ row: 0, startCol: col, endCol: col + width, key: segment.key });
    }
    col += width + 1;
  }
  return { lines: [`${left} ${rightText}`], hits };
}
