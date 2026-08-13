/**
 * fino:commands/code/ui/overlay — full-screen modal views over the inline app.
 *
 * The chat surface is keyboard-only so the terminal keeps text selection;
 * modal views (session manager, model picker) trade that for mouse
 * interaction by entering the alternate screen with capture on. This module
 * is the bridge: an {@link OverlayView} renders lines plus hit regions, and
 * the {@link OverlayController} hosts one at a time — opening it through
 * `InlineApp.enterOverlay`, routing events, and restoring the inline surface
 * (capture off) when it closes.
 */
import { createSignal, h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Box,
  Text,
  type InlineApp,
  type OverlayHandle,
  type TerminalSize,
  type TuiEvent,
  type TuiKeyEvent,
  type TuiMouseEvent,
} from 'fino:tty/tui';
import type { HitRegion, RenderedPane } from 'fino:tty/components/pane';

/** A modal view hosted by the {@link OverlayController}. */
export interface OverlayView {
  /** Render the full screen at `size`; hits drive hover and clicks. */
  render(size: TerminalSize): RenderedPane;
  /** Handle a key; `'close'` dismisses the overlay. */
  handleKey(event: TuiKeyEvent): 'close' | 'handled';
  /** Handle a mouse event with the hit key under the pointer, if any. */
  handleMouse?(event: TuiMouseEvent, hitKey: string | undefined): 'close' | 'handled';
  /** Called after the overlay closes, however it closes. */
  onClose?(): void;
}

/**
 * Hosts at most one overlay view over an inline app.
 *
 * `open` enters the alternate screen with mouse capture; `handleEvent`
 * forwards keys and hit-tested mouse events to the view while it is open;
 * `refresh` repaints it (state changed outside an event); `close` restores
 * the inline surface. Opening a second view closes the first.
 */
export class OverlayController {
  #app: InlineApp;
  #view: OverlayView | null = null;
  #handle: OverlayHandle | null = null;
  #pane: RenderedPane | null = null;
  #revision = createSignal(0);

  /** Bind to the inline app whose surface overlays cover. */
  constructor(app: InlineApp) {
    this.#app = app;
  }

  /** The open view, or null. */
  get active(): OverlayView | null {
    return this.#view;
  }

  /** Open a view, closing any current one first. */
  open(view: OverlayView): void {
    this.close();
    this.#view = view;
    this.#handle = this.#app.enterOverlay(() => this.#tree(), { mouse: true });
  }

  /** Repaint the open view after external state changed. */
  refresh(): void {
    if (this.#view !== null) this.#revision.set(this.#revision.get() + 1);
  }

  /** Close the open view and restore the inline surface. */
  close(): void {
    const view = this.#view;
    if (view === null) return;
    this.#view = null;
    this.#pane = null;
    this.#handle?.close();
    this.#handle = null;
    view.onClose?.();
  }

  /**
   * Route an event to the open view. Returns false when no overlay is open
   * (the caller handles the event itself).
   */
  handleEvent(event: TuiEvent): boolean {
    const view = this.#view;
    if (view === null) return false;
    if (event.type === 'key') {
      if (view.handleKey(event) === 'close') this.close();
      else this.refresh();
      return true;
    }
    const hit = this.#hitAt(event.x, event.y);
    if (view.handleMouse !== undefined) {
      if (view.handleMouse(event, hit) === 'close') this.close();
      else this.refresh();
    }
    return true;
  }

  #hitAt(x: number, y: number): string | undefined {
    const pane = this.#pane;
    if (pane === null) return undefined;
    for (const hit of pane.hits) {
      if (hit.row === y && x >= hit.startCol && x < hit.endCol) return hit.key;
    }
    return undefined;
  }

  #tree(): VNode {
    this.#revision.get();
    const view = this.#view;
    const size = this.#app.size();
    const pane: RenderedPane = view !== null ? view.render(size) : { lines: [], hits: [] };
    this.#pane = pane;
    return h(
      Box,
      { direction: 'column' },
      ...pane.lines.map((line) => h(Text, null, line)),
    );
  }
}

export type { HitRegion, RenderedPane };
