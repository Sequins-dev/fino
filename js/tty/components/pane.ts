/**
 * fino:tty/components/pane — shared shapes for mouse-aware pane renderers.
 *
 * A pane renderer returns styled lines plus the clickable regions inside
 * them, so the caller can route mouse events back to the widget that drew
 * each row.
 */
/**
 * A clickable span within a rendered pane.
 *
 * `row` is 0-based within the pane's lines; `startCol`/`endCol` are 0-based
 * visible-cell columns with `endCol` exclusive. `key` identifies the target
 * the span activates.
 */
export interface HitRegion {
  row: number;
  startCol: number;
  endCol: number;
  key: string;
}
/**
 * The output of a mouse-context renderer: ANSI-styled lines and the hit
 * regions that map pointer positions back to keys.
 *
 * ```ts
 * import type { RenderedPane } from 'fino:tty/components/pane';
 *
 * const pane: RenderedPane = { lines: ['▸ item'], hits: [{ row: 0, startCol: 0, endCol: 6, key: 'item' }] };
 * ```
 */
export interface RenderedPane {
  lines: string[];
  hits: HitRegion[];
}
