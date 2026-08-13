/**
 * fino:tty/components/list — the one selection model used app-wide.
 *
 * A `SelectList` holds items, headers, and separators, keeps a single
 * selection that keyboard, mouse hover, and programmatic moves all share,
 * and renders a scroll window with hit regions so pointing at a row selects
 * the same thing pressing arrows would.
 */
import { tk, style } from './theme.ts';
import { clipAnsi } from './text.ts';
import type { HitRegion, RenderedPane } from './pane.ts';
/**
 * One row of a {@link SelectList}: a selectable item, a dim section header,
 * or a blank separator.
 */
export type ListItem =
  | {
      kind: 'item';
      key: string;
      label: string;
      detail?: string;
      glyph?: string;
      current?: boolean;
      disabled?: boolean;
    }
  | { kind: 'header'; label: string }
  | { kind: 'separator' };
/**
 * A scrollable list with one selection shared by keyboard and mouse.
 *
 * Movement skips headers, separators, and disabled items and clamps at the
 * ends. Rendering shows a `maxRows` window that snaps to keep the selection
 * visible; overflow below is announced on the last row.
 *
 * ```ts
 * import { SelectList } from 'fino:tty/components/list';
 *
 * const list = new SelectList({ maxRows: 5 });
 * list.setItems([{ kind: 'item', key: 'a', label: 'Alpha' }]);
 * list.selectedKey; // 'a'
 * ```
 */
export class SelectList {
  #items: ListItem[] = [];
  #selected = -1;
  #maxRows: number;
  #marker: string;
  #lastRows: number[] = [];
  #top = 0;
  constructor(opts: { maxRows: number; marker?: string }) {
    this.#maxRows = Math.max(1, opts.maxRows);
    this.#marker = opts.marker ?? '▸';
  }
  /**
   * Resize the visible window.
   *
   * Views that fill a viewport call this before rendering so the list uses
   * whatever height the terminal currently offers rather than a fixed one.
   */
  setMaxRows(rows: number): void {
    this.#maxRows = Math.max(1, Math.floor(rows));
  }
  /** Rows the list will show at most, including any overflow hint. */
  get maxRows(): number {
    return this.#maxRows;
  }
  #selectable(index: number): boolean {
    const item = this.#items[index];
    return item !== undefined && item.kind === 'item' && item.disabled !== true;
  }
  /**
   * Replace the items.
   *
   * With `keepKey` the current selection survives when its key still exists;
   * otherwise the first selectable item is selected.
   */
  setItems(items: ListItem[], opts: { keepKey?: boolean } = {}): void {
    const keep = opts.keepKey === true ? this.selectedKey : undefined;
    this.#items = [...items];
    this.#selected = -1;
    this.#top = 0;
    if (keep !== undefined) {
      for (let index = 0; index < this.#items.length; index++) {
        const item = this.#items[index]!;
        if (item.kind === 'item' && item.key === keep && item.disabled !== true) {
          this.#selected = index;
          break;
        }
      }
    }
    if (this.#selected === -1) {
      for (let index = 0; index < this.#items.length; index++) {
        if (this.#selectable(index)) {
          this.#selected = index;
          break;
        }
      }
    }
    this.#snap();
  }
  /** The selected item — always kind `'item'` — or `undefined`. */
  get selected(): ListItem | undefined {
    const item = this.#items[this.#selected];
    return item !== undefined && item.kind === 'item' ? item : undefined;
  }
  /** The selected item's key, or `undefined`. */
  get selectedKey(): string | undefined {
    const item = this.selected;
    return item !== undefined && item.kind === 'item' ? item.key : undefined;
  }
  /**
   * Move the selection by `delta` selectable items, skipping headers,
   * separators, and disabled rows and clamping at the ends.
   *
   * Returns whether the selection moved at all.
   */
  move(delta: number): boolean {
    if (delta === 0) return false;
    const step = delta < 0 ? -1 : 1;
    let remaining = Math.abs(delta);
    let index = this.#selected;
    let moved = false;
    while (remaining > 0) {
      let next = index + step;
      while (next >= 0 && next < this.#items.length && !this.#selectable(next)) next += step;
      if (next < 0 || next >= this.#items.length) break;
      index = next;
      moved = true;
      remaining -= 1;
    }
    if (!moved) return false;
    this.#selected = index;
    this.#snap();
    return true;
  }
  /** Move a whole window (`maxRows` selectable items) at a time. */
  movePage(delta: number): boolean {
    return this.move((delta < 0 ? -1 : 1) * this.#maxRows);
  }
  /** Select the enabled item with `key`; returns whether it was found. */
  selectKey(key: string): boolean {
    for (let index = 0; index < this.#items.length; index++) {
      const item = this.#items[index]!;
      if (item.kind === 'item' && item.key === key && item.disabled !== true) {
        this.#selected = index;
        this.#snap();
        return true;
      }
    }
    return false;
  }
  /**
   * Select whatever item sits on `row` of the last `render()`'s lines.
   *
   * Headers, separators, hint rows, and disabled items are ignored. Returns
   * whether the selection changed.
   */
  hoverAt(row: number): boolean {
    const index = this.#lastRows[row];
    if (index === undefined || index === -1) return false;
    if (!this.#selectable(index) || index === this.#selected) return false;
    this.#selected = index;
    return true;
  }
  #snap(): void {
    const total = this.#items.length;
    const max = this.#maxRows;
    if (total <= max) {
      this.#top = 0;
      return;
    }
    const selected = this.#selected === -1 ? 0 : this.#selected;
    if (selected < this.#top) this.#top = selected;
    for (;;) {
      const overflow = this.#top + max < total;
      const lastVisible = this.#top + max - (overflow ? 2 : 1);
      if (selected <= lastVisible) break;
      this.#top += 1;
    }
  }
  #itemLine(item: ListItem & { kind: 'item' }, selected: boolean, width: number): string {
    const marker = style(this.#marker, selected ? tk.white : tk.dim);
    const label =
      item.disabled === true
        ? style(item.label, tk.dim)
        : selected
          ? style(item.label, tk.bold, tk.white)
          : item.label;
    let line = `${marker} ${item.glyph !== undefined ? `${item.glyph} ` : ''}${label}`;
    if (item.detail !== undefined) line += ` ${style(item.detail, tk.dim)}`;
    if (item.current === true) line += ` ${style('●', tk.green)}`;
    return clipAnsi(line, width);
  }
  /**
   * Render the visible window.
   *
   * Every visible item row gets a full-width {@link HitRegion} keyed by the
   * item; overflow below the window becomes a dim `… N more (↑/↓)` last row,
   * and `footerHint` adds one more dim row after the list.
   */
  render(width: number, opts: { footerHint?: string } = {}): RenderedPane {
    const lines: string[] = [];
    const hits: HitRegion[] = [];
    this.#lastRows = [];
    const total = this.#items.length;
    const overflow = total > this.#maxRows && this.#top + this.#maxRows < total;
    const end = Math.min(total, this.#top + this.#maxRows - (overflow ? 1 : 0));
    for (let index = this.#top; index < end; index++) {
      const item = this.#items[index]!;
      const row = lines.length;
      if (item.kind === 'separator') {
        lines.push('');
        this.#lastRows.push(-1);
        continue;
      }
      if (item.kind === 'header') {
        lines.push(clipAnsi(style(item.label, tk.dim), width));
        this.#lastRows.push(-1);
        continue;
      }
      lines.push(this.#itemLine(item, index === this.#selected, width));
      this.#lastRows.push(index);
      hits.push({ row, startCol: 0, endCol: width, key: item.key });
    }
    if (overflow) {
      lines.push(clipAnsi(style(`… ${total - end} more (↑/↓)`, tk.dim), width));
      this.#lastRows.push(-1);
    }
    if (opts.footerHint !== undefined) {
      lines.push(clipAnsi(style(opts.footerHint, tk.dim), width));
      this.#lastRows.push(-1);
    }
    return { lines, hits };
  }
}
