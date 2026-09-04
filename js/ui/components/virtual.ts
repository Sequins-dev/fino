/** Reusable sparse virtual-window state and its host-neutral viewport. @internal */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps, UiMouseEvent } from 'fino:ui/components';

/** Visible slice computed by {@link VirtualScroll}. */
export interface VirtualWindow {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
}

/**
 * Sparse scroll model for lists too large to render whole.
 *
 * Memory is proportional to explicitly measured rows, not total item count.
 * Callers own the model outside component bodies and render only the returned
 * window.
 */
export class VirtualScroll {
  #estimate: number;
  #count = 0;
  #heights = new Map<number, number>();
  #offset = 0;
  #follow: boolean;

  constructor(options: { estimate?: number; follow?: boolean } = {}) {
    this.#estimate = normalizeRows(options.estimate ?? 1);
    this.#follow = options.follow === true;
  }

  get count(): number {
    return this.#count;
  }

  /** Current scroll offset in rows. */
  get offset(): number {
    return this.#offset;
  }

  /** Whether the viewport follows the end as content grows. */
  get follow(): boolean {
    return this.#follow;
  }

  /** Total estimated row height without iterating over every item. */
  get totalRows(): number {
    return this.#prefixRows(this.#count);
  }

  /** Replace item count and discard measurements beyond the new boundary. */
  setCount(count: number): void {
    this.#count = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    for (const index of this.#heights.keys()) {
      if (index >= this.#count) this.#heights.delete(index);
    }
  }

  /** Record a measured row height for one item. */
  setHeight(index: number, rows: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.#count) return;
    const height = normalizeRows(rows);
    if (height === this.#estimate) this.#heights.delete(index);
    else this.#heights.set(index, height);
  }

  /** Scroll by a row delta and clamp to the current viewport boundary. */
  scrollBy(rows: number, viewportRows: number): void {
    this.scrollTo(this.#offset + rows, viewportRows);
  }

  /** Scroll to a row offset and update end-following state. */
  scrollTo(offset: number, viewportRows: number): void {
    const max = this.#maxOffset(viewportRows);
    const next = Math.floor(Number.isFinite(offset) ? offset : 0);
    this.#offset = Math.max(0, Math.min(next, max));
    this.#follow = this.#offset >= max;
  }

  /** Pin the viewport to the current end. */
  scrollToEnd(viewportRows: number): void {
    this.#offset = this.#maxOffset(viewportRows);
    this.#follow = true;
  }

  /** Route a terminal wheel event using three rows per notch. */
  handleWheel(event: UiMouseEvent, viewportRows: number): boolean {
    if (event.action !== 'wheel') return false;
    if (event.button === 'wheel-up') this.scrollBy(-3, viewportRows);
    else if (event.button === 'wheel-down') this.scrollBy(3, viewportRows);
    else return false;
    return true;
  }

  /** Compute the bounded item slice worth rendering for one viewport. */
  window(viewportRows: number, overscan = 2): VirtualWindow {
    const viewport = normalizeRows(viewportRows);
    const extra = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : 0));
    const max = this.#maxOffset(viewport);
    if (this.#follow) this.#offset = max;
    else this.#offset = Math.min(this.#offset, max);

    let low = 0;
    let high = this.#count + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#prefixRows(middle) <= this.#offset) low = middle + 1;
      else high = middle;
    }
    let start = Math.max(0, low - 1);
    let end = start;
    let covered = this.#prefixRows(start);
    while (end < this.#count && covered < this.#offset + viewport) {
      covered += this.#heightOf(end++);
    }
    start = Math.max(0, start - extra);
    end = Math.min(this.#count, end + extra);
    const topPad = this.#prefixRows(start);
    const bottomPad = Math.max(0, this.totalRows - this.#prefixRows(end));
    return { start, end, topPad, bottomPad };
  }

  #heightOf(index: number): number {
    return this.#heights.get(index) ?? this.#estimate;
  }

  #prefixRows(end: number): number {
    const boundary = Math.max(0, Math.min(this.#count, end));
    let total = boundary * this.#estimate;
    for (const [index, height] of this.#heights) {
      if (index < boundary) total += height - this.#estimate;
    }
    return total;
  }

  #maxOffset(viewportRows: number): number {
    return Math.max(0, this.totalRows - normalizeRows(viewportRows));
  }
}

function normalizeRows(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

/** Props accepted by {@link VirtualList}. */
export interface VirtualListProps extends StyleProps, FlexChildProps, Props {
  height: number;
  window: VirtualWindow;
  offset: number;
  onMouse?: (event: UiMouseEvent) => boolean | void;
  onScroll?: (offset: number) => void;
  children?: Child;
}

/** Viewport that renders only a caller-provided virtual window. */
export function VirtualList(props: VirtualListProps): VNode {
  return h('ui:virtual-list', props);
}
