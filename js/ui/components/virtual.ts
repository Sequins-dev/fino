/**
 * internal:ui/components/virtual — the windowing model and viewport for lists
 * too large to render whole.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import {
  VIRTUAL_ROW_PX,
  actionForm,
  actionsActive,
  flexChildCss,
  handlerOf,
  register,
  resolveStyle,
  sizeCss,
  styleCss,
} from 'internal:ui/components/html-runtime';
import type { FlexChildProps, StyleProps, UiMouseEvent } from 'internal:ui/components/primitives';

/** The visible slice a `VirtualScroll` model computed for one paint. */
export interface VirtualWindow {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  /** Rows of excluded items above the window, rendered as a spacer. */
  topPad: number;
  /** Rows of excluded items below the window, rendered as a spacer. */
  bottomPad: number;
}

/**
 * Scroll model for lists too large to render whole: items get a row-height
 * estimate, corrected per index as real heights are measured, and `window()`
 * yields the slice worth building VNodes for. Only the windowed items exist
 * in the tree — spacers stand in for everything else, so scroll geometry
 * stays exact while memory stays bounded. Lives outside the tree like every
 * other state model.
 */
export class VirtualScroll {
  #estimate: number;
  #count = 0;
  #heights = new Map<number, number>();
  #offset = 0;
  #follow = false;

  constructor(options: { estimate?: number; follow?: boolean } = {}) {
    this.#estimate = Math.max(1, Math.floor(options.estimate ?? 1));
    this.#follow = options.follow === true;
  }

  get count(): number {
    return this.#count;
  }

  /** Current scroll offset in rows from the top of the full list. */
  get offset(): number {
    return this.#offset;
  }

  /** Whether the view sticks to the end as content grows. */
  get follow(): boolean {
    return this.#follow;
  }

  /** Total row height of the list under current estimates. */
  get totalRows(): number {
    let total = 0;
    for (let index = 0; index < this.#count; index++) total += this.#heightOf(index);
    return total;
  }

  #heightOf(index: number): number {
    return this.#heights.get(index) ?? this.#estimate;
  }

  setCount(count: number): void {
    this.#count = Math.max(0, count);
    for (const index of this.#heights.keys()) {
      if (index >= this.#count) this.#heights.delete(index);
    }
  }

  /** Correct one item's estimated height with its measured row count. */
  setHeight(index: number, rows: number): void {
    if (index < 0 || index >= this.#count) return;
    this.#heights.set(index, Math.max(1, Math.floor(rows)));
  }

  #maxOffset(viewportRows: number): number {
    return Math.max(0, this.totalRows - Math.max(1, viewportRows));
  }

  scrollBy(rows: number, viewportRows: number): void {
    this.scrollTo(this.#offset + rows, viewportRows);
  }

  scrollTo(offset: number, viewportRows: number): void {
    const max = this.#maxOffset(viewportRows);
    this.#offset = Math.max(0, Math.min(Math.floor(offset), max));
    this.#follow = this.#offset >= max;
  }

  scrollToEnd(viewportRows: number): void {
    this.#offset = this.#maxOffset(viewportRows);
    this.#follow = true;
  }

  /** Route a wheel event: three rows per notch. Returns true when consumed. */
  handleWheel(event: UiMouseEvent, viewportRows: number): boolean {
    if (event.action !== 'wheel') return false;
    if (event.button === 'wheel-up') {
      this.scrollBy(-3, viewportRows);
      return true;
    }
    if (event.button === 'wheel-down') {
      this.scrollBy(3, viewportRows);
      return true;
    }
    return false;
  }

  /** The slice to render for a viewport, with `overscan` extra items each side. */
  window(viewportRows: number, overscan = 2): VirtualWindow {
    const viewport = Math.max(1, viewportRows);
    if (this.#follow) this.#offset = this.#maxOffset(viewport);
    let start = 0;
    let topPad = 0;
    while (start < this.#count && topPad + this.#heightOf(start) <= this.#offset) {
      topPad += this.#heightOf(start);
      start++;
    }
    let end = start;
    let covered = topPad;
    while (end < this.#count && covered < this.#offset + viewport) {
      covered += this.#heightOf(end);
      end++;
    }
    for (let extra = 0; extra < overscan && start > 0; extra++) {
      start--;
      topPad -= this.#heightOf(start);
    }
    end = Math.min(this.#count, end + overscan);
    let bottomPad = 0;
    for (let index = end; index < this.#count; index++) bottomPad += this.#heightOf(index);
    return { start, end, topPad, bottomPad };
  }
}

/** Props accepted by `VirtualList`. */
export interface VirtualListProps extends StyleProps, FlexChildProps, Props {
  /** Viewport height in rows. */
  height: number;
  /** The window computed by a `VirtualScroll` model for this paint. */
  window: VirtualWindow;
  /** Scroll offset from the same model. */
  offset: number;
  /** Wheel routing, typically `(e) => model.handleWheel(e, height)`. */
  onMouse?: (event: UiMouseEvent) => boolean | void;
  /**
   * Row offset the browser scrolled to. The TUI target ignores this — wheel
   * routing there goes through `onMouse` — but the HTML target has no wheel
   * events of its own; it wires its scroll container to this instead, so
   * scrolling in a browser moves the window server-side.
   */
  onScroll?: (offset: number) => void;
  children?: Child;
}
/**
 * Scrollable viewport over a windowed item slice: the caller builds VNodes
 * only for `window.start..window.end`, and spacers preserve the geometry of
 * everything excluded. Emits the semantic `ui:virtual-list` node; each
 * render target owns its own composition — see `internal:tty/lower` for the
 * terminal's clickable+scrollview shape and `fino:ui/components/html` for
 * the browser's scrollable container.
 */
function virtualSpacerHtml(rows: number): VNode {
  return h('div', {
    style: { height: `${rows * VIRTUAL_ROW_PX}px`, flex: '0 0 auto' },
    'aria-hidden': 'true',
  });
}
/**
 * `ui:virtual-list` on the web: there is no wheel event to hook, so instead
 * of `onMouse` this wires `onScroll` to a real scrollable `<div>` — marked
 * `data-fi-scroll` with its row height, and (when interactive) wrapped in an
 * action form carrying a hidden `value` field the client fills in with the
 * scrolled-to row before submitting. Without an `onScroll` handler the
 * container renders inert, same as any other handler-less control.
 */
export function VirtualList(all: VirtualListProps): VNode {
  const { children = [], ...props } = all as VirtualListProps & { children?: NormalizedChild[] };
  const { height, window: slice, offset, onMouse: _onMouse, onScroll, id, ...rest } = props;
  const scroll = handlerOf<(offset: number) => void>(onScroll);
  const css: Record<string, string> = {
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  };
  sizeCss(rest, css);
  flexChildCss(rest, css);
  styleCss(resolveStyle(rest as Props), css);
  css.height = `${Math.max(1, Math.floor(height)) * VIRTUAL_ROW_PX}px`;
  const attrs: Props = { className: 'ui-virtual', style: css, ...idAttr(id) };
  const interactive = actionsActive() && scroll !== undefined;
  if (interactive) {
    attrs['data-fi-scroll'] = '1';
    attrs['data-fi-row-height'] = String(VIRTUAL_ROW_PX);
  }
  const container = h(
    'div',
    attrs,
    slice.topPad > 0 ? virtualSpacerHtml(slice.topPad) : null,
    ...children,
    slice.bottomPad > 0 ? virtualSpacerHtml(slice.bottomPad) : null,
  );
  if (!interactive) return container;
  const act = register((value) => scroll!(Number(value ?? 0)));
  return actionForm(
    { act, change: true },
    h('input', { type: 'hidden', name: 'value', value: String(Math.max(0, Math.floor(offset))) }),
    container,
  );
}
