/**
 * fino:tty/inline — inline terminal renderer with a pinned bottom viewport.
 *
 * Where `render()` from `fino:tty/tui` owns the whole alternate screen, this
 * renderer keeps the app in the terminal's primary buffer: finalized output is
 * pushed into the terminal's real scrollback (so it is natively selectable and
 * scrollable, and it survives exit), while a small dynamic footer — the bottom
 * N rows — is repainted in place. Mouse capture defaults to off so the
 * terminal keeps text selection; a fullscreen overlay mode with capture is
 * available for modal views.
 *
 * The scrollback push uses a DECSTBM scroll region confined to the rows above
 * the footer: parking the cursor at the last occupied history row and writing
 * `\r\n` per line first fills any blank rows, then scrolls the region so rows
 * evicted off the top enter real scrollback. Margins are only ever set inside
 * a single composed write and reset before it ends, so a crash never leaves
 * the terminal with a stale scroll region.
 *
 * ```ts no_run
 * import { renderInline } from 'fino:tty/tui';
 *
 * const app = renderInline(() => ({ lines: ['❯ ', 'status'], cursor: { row: 0, column: 2 } }), {
 *   onEvent(event, app) {
 *     if (event.type === 'key' && event.key === 'enter') app.printAbove(['committed line']);
 *   },
 * });
 * ```
 */
import { createRoot, h, type Root, type Sink, type VNode } from 'fino:ui';
import { writeStdout } from '../tty.ts';
import { stdin, signal, exit } from '../process.ts';
import { timeout as loopTimeout } from '../internal/runtime/loop.ts';
import {
  cursorTo,
  enableAutoWrap,
  disableAutoWrap,
  enterAlternateScreen,
  eraseBelow,
  eraseLine,
  eraseScrollback,
  eraseToLineEnd,
  eraseVisible,
  exitAlternateScreen,
  exitMouseMode,
  hideCursor,
  onResize,
  queryCursorPosition,
  queryTerminalSize,
  resetScrollRegion,
  setScrollRegion,
  showCursor,
} from '../internal/tty/bindings.ts';
import {
  createTuiInput,
  decodeTuiInput,
  fitAnsi,
  renderFrame,
  type TerminalSize,
  type TuiEvent,
  type TuiInput,
} from './tui.ts';

/** One footer paint: pre-styled rows plus where the visible cursor sits. */
export interface InlineFrame {
  /** Footer rows, top to bottom. The frame height is `lines.length`. */
  lines: string[];
  /**
   * Zero-based cell within the footer where the cursor is shown, or `null`
   * (and `undefined`) to hide it.
   */
  cursor?: { row: number; column: number } | null;
}

/** Options for {@link renderInline}. */
export interface InlineOptions {
  /** Read keyboard input; defaults to true (also implied by `onEvent`). */
  input?: boolean;
  /**
   * Capture the mouse from startup. Defaults to false — the whole point of
   * inline mode is leaving selection, scrolling, and find to the terminal.
   */
  mouse?: boolean;
  /** Report motion events while capture is on (overlay hover). Default false. */
  motion?: boolean;
  /**
   * Clamp footer growth to this many rows (default 20, always at most one
   * less than the terminal height). Overflowing frames keep their last rows.
   */
  maxFooterRows?: number;
  onEvent?: (event: TuiEvent, app: InlineApp) => void | Promise<void>;
  /** Fires after geometry is re-established at a new terminal size. */
  onResize?: (size: TerminalSize, app: InlineApp) => void;
}

/** Options for {@link InlineApp.enterOverlay}. */
export interface OverlayOptions {
  /** Capture the mouse while the overlay is open. Default true. */
  mouse?: boolean;
}

/** Handle for a fullscreen overlay opened over an inline app. */
export interface OverlayHandle {
  /** Replace the overlay tree (takes over from a reactive thunk). */
  update(element: VNode): void;
  /** Current overlay size; tracks live terminal resizes. */
  size(): TerminalSize;
  /** Close the overlay and restore the inline surface. */
  close(): void;
}

/** Handle returned by {@link renderInline}. */
export interface InlineApp {
  /**
   * Commit finalized lines into the terminal's real scrollback, above the
   * footer. Lines are written verbatim — pre-wrap them to the width at commit
   * time; a line wider than the terminal soft-wraps and can evict one extra
   * row per wrap.
   */
  printAbove(lines: string[]): void;
  /**
   * Clear the screen and the terminal's scrollback, and start committing
   * again from the top.
   *
   * Rows already written cannot be re-wrapped, so an app that wants its
   * transcript to follow a new terminal width has to discard what it emitted
   * and re-emit it from its own source. Everything the user had scrolled
   * back to is lost, so this is for deliberate rebuilds, not routine
   * repainting.
   */
  resetHistory(): void;
  /** Repaint the footer. Takes over from a reactive footer thunk. */
  update(frame: InlineFrame): void;
  /** Current terminal size. */
  size(): TerminalSize;
  /** Rows the footer currently occupies. */
  footerRows(): number;
  /** Toggle mouse capture; returns the resulting state. */
  setMouse(enabled: boolean): boolean;
  /**
   * Open a fullscreen modal overlay in the alternate screen with mouse
   * capture on. While it is open, `printAbove` queues and the footer is
   * frozen; closing restores the inline surface exactly.
   */
  enterOverlay(element: VNode | (() => VNode), options?: OverlayOptions): OverlayHandle;
  /**
   * Flush pending output, clear the footer, park the cursor on the line after
   * the last committed one, and restore terminal state.
   */
  stop(): Promise<void>;
  input?: TuiInput;
}

/**
 * Geometry and paint state threaded through {@link composeInlineFrame}.
 *
 * `footerRows` is the height of the pinned viewport; the footer's first row is
 * `height - footerRows + 1`. `historyBottom` is the last screen row occupied
 * by committed history (0 when none is visible); the rows between it and the
 * footer are blank and get filled before anything scrolls.
 */
export interface InlineComposeState {
  width: number;
  height: number;
  footerRows: number;
  historyBottom: number;
  /** Footer rows as last painted (post-clip), for diffing repaints. */
  lastLines: string[];
  /** Cursor as last parked, or null while hidden. */
  cursor: { row: number; column: number } | null;
}

/** One flush worth of work for {@link composeInlineFrame}. */
export interface InlineComposeOps {
  /** Lines to commit above the footer, oldest first. */
  history?: string[];
  /** New footer frame; omit to keep the current footer. */
  frame?: InlineFrame;
  /** Repaint every footer row even when unchanged. */
  forceRepaint?: boolean;
}

function sameCursor(
  a: { row: number; column: number } | null,
  b: { row: number; column: number } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.row === b.row && a.column === b.column;
}

/**
 * Row the footer starts on: directly below the committed history, or pinned
 * to the bottom of the screen once history has grown to meet it.
 *
 * Keeping the footer against the content is what stops a blank row from
 * opening up between the transcript and the composer while the screen is
 * still filling — the footer follows the conversation down, the way a shell
 * prompt follows its output, and only stops when there is nowhere left to go.
 */
export function footerTop(height: number, footerRows: number, historyBottom: number): number {
  return Math.min(height - footerRows + 1, historyBottom + 1);
}

/**
 * Compose one inline paint into a single escape-sequence string.
 *
 * Pure: returns the output and the successor state without touching the
 * terminal, so the exact sequence of region pushes, footer movement, repaints,
 * and cursor parking is unit-testable. Order within the write is fixed: a
 * taller footer first evicts the history rows it is about to claim (those
 * rows are visible history and must reach scrollback rather than be painted
 * over), then history lines are pushed, then rows the footer has vacated are
 * cleared, then footer rows repaint, and finally the cursor is parked
 * absolutely — DECSTBM homes the cursor as a side effect, so nothing may
 * assume its position.
 */
export function composeInlineFrame(
  state: InlineComposeState,
  ops: InlineComposeOps,
): { out: string; state: InlineComposeState } {
  const { width, height } = state;
  const oldRows = state.footerRows;
  const oldTop = footerTop(height, oldRows, state.historyBottom);
  let historyBottom = state.historyBottom;
  let out = '';

  const frame = ops.frame;
  const footerRows = frame
    ? Math.max(1, Math.min(frame.lines.length, height - 1))
    : oldRows;
  // The lowest row history may ever occupy: one above the footer's pinned
  // position, whatever the footer's current position happens to be.
  const regionBottom = Math.max(1, height - footerRows);

  if (historyBottom > regionBottom) {
    const need = historyBottom - regionBottom;
    const oldRegionBottom = Math.max(regionBottom, height - oldRows);
    out +=
      setScrollRegion(1, oldRegionBottom) +
      cursorTo(oldRegionBottom, 1) +
      '\n'.repeat(need) +
      resetScrollRegion();
    historyBottom -= need;
  }

  const history = ops.history ?? [];
  if (history.length > 0) {
    out += setScrollRegion(1, regionBottom);
    let rest = history;
    // The row is cleared before the text, never after: a line exactly as wide
    // as the terminal leaves the cursor in the pending-wrap state, still on
    // the last column, and an erase-to-end there would delete the character
    // just written.
    if (historyBottom === 0) {
      out += cursorTo(1, 1) + eraseToLineEnd() + (history[0] ?? '');
      historyBottom = 1;
      rest = history.slice(1);
    } else {
      out += cursorTo(Math.min(historyBottom, regionBottom), 1);
    }
    for (const line of rest) {
      out += `\r\n` + eraseToLineEnd() + line;
      historyBottom = Math.min(historyBottom + 1, regionBottom);
    }
    out += resetScrollRegion();
  }

  const top = footerTop(height, footerRows, historyBottom);
  const geometryChanged = top !== oldTop || footerRows !== oldRows;
  if (geometryChanged) {
    // Rows the footer has left behind still show its last paint; clear the
    // ones history did not just overwrite so nothing stale can scroll away.
    for (let row = oldTop; row < oldTop + oldRows && row <= height; row++) {
      const covered = row >= top && row < top + footerRows;
      if (!covered && row > historyBottom) out += cursorTo(row, 1) + eraseLine();
    }
  }

  let lastLines = state.lastLines;
  // Footer rows stop one column short and are erased rather than padded. A row
  // that fills the last column can be recorded as soft-wrapped, and the next
  // time the terminal re-wraps — narrowing the window — it joins that row with
  // the one below, which arrives as the composer sliding right behind a run of
  // padding spaces.
  const cell = Math.max(1, width - 1);
  if (frame) {
    const next: string[] = [];
    for (let i = 0; i < footerRows; i++) {
      next.push(fitAnsi(frame.lines[i] ?? '', cell, { pad: false }));
    }
    const repaintAll = geometryChanged || ops.forceRepaint === true;
    for (let i = 0; i < next.length; i++) {
      if (repaintAll || next[i] !== lastLines[i]) {
        out += cursorTo(top + i, 1) + eraseToLineEnd() + next[i];
      }
    }
    lastLines = next;
  } else if (ops.forceRepaint === true) {
    for (let i = 0; i < lastLines.length && i < footerRows; i++) {
      out += cursorTo(top + i, 1) + eraseToLineEnd() + lastLines[i];
    }
  }

  const cursor = frame !== undefined ? (frame.cursor ?? null) : state.cursor;
  const cursorChanged = !sameCursor(cursor, state.cursor);
  if (out === '' && !cursorChanged) {
    return { out: '', state: { ...state, footerRows, historyBottom, lastLines, cursor } };
  }
  let final = hideCursor() + out;
  if (cursor !== null) {
    const row = Math.max(0, Math.min(cursor.row, footerRows - 1));
    const column = Math.max(0, Math.min(cursor.column, width - 1));
    final += cursorTo(top + row, column + 1) + showCursor();
  }
  return {
    out: final,
    state: { width, height, footerRows, historyBottom, lastLines, cursor },
  };
}

interface OverlayState {
  element: VNode | (() => VNode);
  root: Root<string> | null;
  lastTree: VNode | null;
  size: TerminalSize;
  handle: OverlayHandle;
}

/** How long a resize waits for a rebuild before repainting on its own. */
const RESIZE_RECOVERY_MS = 400;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

class InlineAppImpl implements InlineApp {
  #options: InlineOptions;
  #footer: (() => InlineFrame) | null = null;
  #state: InlineComposeState;
  #root: Root<InlineFrame> | null = null;
  #input?: TuiInput;
  #pendingHistory: string[] = [];
  #pendingFrame: InlineFrame | null = null;
  #lastFrame: InlineFrame;
  #forceRepaint = false;
  #flushScheduled = false;
  #chain: Promise<void> = Promise.resolve();
  #ready = false;
  #stopped = false;
  #overlay: OverlayState | null = null;
  #resizePending = false;
  #resizeFallback?: ReturnType<typeof setTimeout>;
  #preEvents: TuiEvent[] = [];
  #stopResize?: () => void;
  #disposeSignals: Array<() => void> = [];

  constructor(footer: InlineFrame | (() => InlineFrame), options: InlineOptions) {
    this.#options = options;
    const size = queryTerminalSize();
    this.#state = {
      width: size.width,
      height: size.height,
      footerRows: 1,
      historyBottom: 0,
      lastLines: [],
      cursor: null,
    };
    this.#lastFrame = { lines: [''], cursor: null };
    const wantsInput = options.input !== false || options.onEvent !== undefined;
    if (wantsInput) {
      this.#input = createTuiInput({
        mouse: options.mouse ?? false,
        motion: options.motion ?? false,
      });
    }
    const sink: Sink<InlineFrame> = {
      commit: (tree: VNode): InlineFrame => {
        const frame = (tree.props as { frame: InlineFrame }).frame;
        this.#lastFrame = frame;
        this.#pendingFrame = frame;
        this.#schedule();
        return frame;
      },
    };
    if (typeof footer === 'function') {
      this.#footer = footer;
      this.#root = createRoot(() => h('inline-footer', { frame: footer() }), sink);
    } else {
      this.#lastFrame = footer;
      this.#pendingFrame = footer;
    }
    for (const [name, code] of [
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      try {
        const handle = signal(name).subscribe(() => {
          void this.stop().then(() => exit(code));
        });
        this.#disposeSignals.push(() => handle.dispose());
      } catch (_) {
        // signals unavailable (non-POSIX host); inline mode still works
      }
    }
    void this.#init();
  }

  get input(): TuiInput | undefined {
    return this.#input;
  }

  async #init(): Promise<void> {
    const row = await this.#queryCursorRow();
    if (this.#stopped) return;
    const size = queryTerminalSize();
    this.#state.width = size.width;
    this.#state.height = size.height;
    const frame = this.#clampFrame(this.#pendingFrame ?? this.#lastFrame);
    const rows = Math.max(1, Math.min(frame.lines.length, size.height - 1));
    const regionBottom = Math.max(1, size.height - rows);
    let init = '';
    if (row !== null) {
      // The reported row holds the cursor, so committed history ends above
      // it; the footer then opens exactly where the shell left off.
      const occupied = Math.max(0, row - 1);
      if (occupied > regionBottom) {
        init += cursorTo(size.height, 1) + '\n'.repeat(occupied - regionBottom);
        this.#state.historyBottom = regionBottom;
      } else {
        this.#state.historyBottom = occupied;
      }
    } else {
      // No cursor report: scroll a full footer's worth so whatever the shell
      // left on the bottom rows is preserved above the viewport.
      init += cursorTo(size.height, 1) + '\n'.repeat(rows);
      this.#state.historyBottom = regionBottom;
    }
    if (init !== '') this.#write(hideCursor() + init);
    this.#ready = true;
    this.#forceRepaint = true;
    this.#pendingFrame = this.#pendingFrame ?? this.#lastFrame;
    this.#flush();
    this.#watchResize();
    this.#pumpEvents();
  }

  async #queryCursorRow(): Promise<number | null> {
    if (!this.#input) return null;
    try {
      await writeStdout(queryCursorPosition());
      const controller = new AbortController();
      const timer = loopTimeout(150);
      void timer.then(() => controller.abort(new Error('cursor query timed out')));
      const bytes: number[] = [];
      while (!controller.signal.aborted) {
        const chunk = await Promise.race([
          stdin().read({ maxBytes: 64, signal: controller.signal }),
          timer.then(() => null),
        ]);
        if (chunk === null) break;
        for (const byte of chunk) bytes.push(byte);
        const text = decoder.decode(new Uint8Array(bytes));
        const match = /\x1b\[(\d+);(\d+)R/.exec(text);
        if (match) {
          timer.cancel();
          const rest = text.slice(0, match.index) + text.slice(match.index + match[0].length);
          if (rest.length > 0) this.#preEvents.push(...decodeTuiInput(encoder.encode(rest)));
          const row = Number(match[1]);
          return Number.isFinite(row) && row > 0 ? Math.floor(row) : null;
        }
      }
      timer.cancel();
      if (bytes.length > 0) this.#preEvents.push(...decodeTuiInput(new Uint8Array(bytes)));
    } catch (_) {
      // fall through to the scroll-up fallback
    }
    return null;
  }

  #pumpEvents(): void {
    const input = this.#input;
    const onEvent = this.#options.onEvent;
    if (!input || !onEvent) return;
    void (async () => {
      const queued = this.#preEvents;
      this.#preEvents = [];
      for (const event of queued) {
        if (this.#stopped) return;
        await onEvent(event, this);
      }
      while (!this.#stopped) {
        const event = await input.read();
        if (event === null) break;
        await onEvent(event, this);
      }
    })();
  }

  #watchResize(): void {
    let first = true;
    const dispose = onResize((next) => {
      if (first) {
        first = false;
        return;
      }
      this.#applyResize(next);
    });
    const poll = setInterval(() => this.#applyResize(queryTerminalSize()), 750);
    this.#stopResize = () => {
      clearInterval(poll);
      dispose();
    };
  }

  #applyResize(next: TerminalSize): void {
    if (this.#stopped) return;
    const overlay = this.#overlay;
    if (overlay) {
      if (next.width === overlay.size.width && next.height === overlay.size.height) return;
      overlay.size = { ...next };
      this.#write(cursorTo(1, 1) + '\x1b[2J');
      if (overlay.root && typeof overlay.element === 'function') {
        overlay.root.dispose();
        overlay.root = createRoot(
          overlay.element as () => VNode,
          this.#overlaySink(overlay),
        );
      } else if (overlay.lastTree) {
        this.#paintOverlay(overlay, overlay.lastTree);
      }
      return;
    }
    if (next.width === this.#state.width && next.height === this.#state.height) return;
    // Painting stops until the caller rebuilds. A resize moves the terminal's
    // content by an emulator-specific amount, and output is written
    // asynchronously, so a repaint composed now can land against a grid that
    // has already changed size again — stamping a fresh footer beside the one
    // the terminal carried off, once per event, faster than any erase aimed at
    // a particular row can chase it. Holding the surface still until it is
    // cleared wholesale is the only way to keep exactly one of everything.
    this.#state.width = next.width;
    this.#state.height = next.height;
    this.#state.footerRows = Math.max(1, Math.min(this.#state.footerRows, next.height - 1));
    this.#resizePending = true;
    if (this.#resizeFallback !== undefined) clearTimeout(this.#resizeFallback);
    // A caller with nothing to rebuild from still has to get its surface back.
    this.#resizeFallback = setTimeout(() => this.#recoverFromResize(), RESIZE_RECOVERY_MS);
    this.#options.onResize?.({ ...next }, this);
  }

  /** Repaint on a cleared screen when no rebuild came after a resize. */
  #recoverFromResize(): void {
    this.#resizeFallback = undefined;
    if (!this.#resizePending || this.#stopped) return;
    this.#resizePending = false;
    this.#state.historyBottom = 0;
    this.#state.lastLines = [];
    this.#write(hideCursor() + resetScrollRegion() + cursorTo(1, 1) + eraseVisible());
    this.#forceRepaint = true;
    this.#pendingFrame = this.#pendingFrame ?? this.#lastFrame;
    this.#schedule();
  }

  #clampFrame(frame: InlineFrame): InlineFrame {
    const max = Math.max(
      1,
      Math.min(this.#options.maxFooterRows ?? 20, this.#state.height - 1),
    );
    let lines = frame.lines.length === 0 ? [''] : frame.lines;
    let cursor = frame.cursor ?? null;
    if (lines.length > max) {
      const dropped = lines.length - max;
      lines = lines.slice(dropped);
      cursor =
        cursor !== null && cursor.row >= dropped
          ? { row: cursor.row - dropped, column: cursor.column }
          : null;
    }
    return { lines, cursor };
  }

  #schedule(): void {
    if (this.#flushScheduled || this.#stopped) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    if (!this.#ready || this.#stopped || this.#overlay !== null) return;
    // Held after a resize: whatever is composed now would be placed against
    // geometry the terminal has already moved on from.
    if (this.#resizePending) return;
    const history = this.#pendingHistory;
    const frame = this.#pendingFrame;
    const force = this.#forceRepaint;
    this.#pendingHistory = [];
    this.#pendingFrame = null;
    this.#forceRepaint = false;
    if (history.length === 0 && frame === null && !force) return;
    const { out, state } = composeInlineFrame(this.#state, {
      history,
      frame: frame !== null ? this.#clampFrame(frame) : undefined,
      forceRepaint: force,
    });
    this.#state = state;
    if (out !== '') this.#write(out);
  }

  #write(out: string): void {
    this.#chain = this.#chain.then(() => writeStdout(out)).catch(() => undefined);
  }

  printAbove(lines: string[]): void {
    if (this.#stopped) return;
    for (const line of lines) {
      if (line.includes('\n')) this.#pendingHistory.push(...line.split('\n'));
      else this.#pendingHistory.push(line);
    }
    this.#schedule();
  }

  resetHistory(): void {
    if (this.#stopped) return;
    this.#resizePending = false;
    if (this.#resizeFallback !== undefined) {
      clearTimeout(this.#resizeFallback);
      this.#resizeFallback = undefined;
    }
    this.#pendingHistory = [];
    this.#write(eraseScrollback());
    this.#state.historyBottom = 0;
    this.#state.lastLines = [];
    this.#forceRepaint = true;
    this.#pendingFrame = this.#pendingFrame ?? this.#lastFrame;
    this.#schedule();
  }

  update(frame: InlineFrame): void {
    if (this.#stopped) return;
    this.#root?.dispose();
    this.#root = null;
    this.#lastFrame = frame;
    this.#pendingFrame = frame;
    this.#schedule();
  }

  size(): TerminalSize {
    return { width: this.#state.width, height: this.#state.height };
  }

  footerRows(): number {
    return this.#state.footerRows;
  }

  setMouse(enabled: boolean): boolean {
    const sequence = this.#input?.takeMouse(enabled) ?? '';
    if (sequence !== '') this.#write(sequence);
    return this.#input?.mouse ?? false;
  }

  #overlaySink(overlay: OverlayState): Sink<string> {
    return {
      commit: (tree: VNode): string => {
        overlay.lastTree = tree;
        return this.#paintOverlay(overlay, tree);
      },
    };
  }

  #paintOverlay(overlay: OverlayState, tree: VNode): string {
    const { width, height } = overlay.size;
    const lines = renderFrame(tree, { width, height }).split('\n');
    let out = '';
    for (let row = 0; row < lines.length; row++) out += cursorTo(row + 1, 1) + lines[row];
    if (this.#overlay === overlay && !this.#stopped) this.#write(out);
    return out;
  }

  enterOverlay(element: VNode | (() => VNode), options: OverlayOptions = {}): OverlayHandle {
    if (this.#stopped) throw new Error('inline app is stopped');
    if (this.#overlay !== null) throw new Error('an overlay is already open');
    const overlay: OverlayState = {
      element,
      root: null,
      lastTree: null,
      size: this.size(),
      handle: undefined as unknown as OverlayHandle,
    };
    this.#overlay = overlay;
    this.#write(
      hideCursor() +
        resetScrollRegion() +
        enterAlternateScreen() +
        disableAutoWrap() +
        '\x1b[2J' +
        (this.#input?.takeMouse(options.mouse ?? true) ?? ''),
    );
    const sink = this.#overlaySink(overlay);
    if (typeof element === 'function') overlay.root = createRoot(element as () => VNode, sink);
    else sink.commit(element);
    const handle: OverlayHandle = {
      update: (next: VNode): void => {
        if (this.#overlay !== overlay) return;
        overlay.root?.dispose();
        overlay.root = null;
        sink.commit(next);
      },
      size: (): TerminalSize => ({ ...overlay.size }),
      close: (): void => this.#closeOverlay(overlay),
    };
    overlay.handle = handle;
    return handle;
  }

  #closeOverlay(overlay: OverlayState): void {
    if (this.#overlay !== overlay) return;
    overlay.root?.dispose();
    this.#overlay = null;
    this.#write(
      (this.#input?.takeMouse(this.#options.mouse ?? false) ?? '') +
        enableAutoWrap() +
        exitAlternateScreen(),
    );
    const size = queryTerminalSize();
    if (size.width !== this.#state.width || size.height !== this.#state.height) {
      this.#applyResize(size);
      return;
    }
    this.#forceRepaint = true;
    this.#pendingFrame = this.#pendingFrame ?? this.#lastFrame;
    this.#schedule();
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#chain;
      return;
    }
    if (this.#overlay !== null) this.#closeOverlay(this.#overlay);
    this.#stopResize?.();
    if (this.#resizeFallback !== undefined) clearTimeout(this.#resizeFallback);
    this.#resizePending = false;
    for (const dispose of this.#disposeSignals) dispose();
    this.#disposeSignals = [];
    this.#root?.dispose();
    this.#root = null;
    if (this.#ready && this.#pendingHistory.length > 0) {
      const { out, state } = composeInlineFrame(this.#state, { history: this.#pendingHistory });
      this.#pendingHistory = [];
      this.#state = state;
      if (out !== '') this.#write(out);
    }
    const top = footerTop(this.#state.height, this.#state.footerRows, this.#state.historyBottom);
    const park = Math.min(this.#state.historyBottom + 1, this.#state.height);
    this.#write(
      resetScrollRegion() +
        cursorTo(top, 1) +
        eraseBelow() +
        cursorTo(park, 1) +
        showCursor() +
        enableAutoWrap() +
        exitMouseMode(),
    );
    this.#stopped = true;
    await this.#chain;
    this.#input?.close();
  }
}

/**
 * Render an inline app: a repainted footer pinned to the bottom of the
 * terminal with committed output flowing into real scrollback above it.
 *
 * Passing a thunk makes the footer reactive — signals read while it runs
 * become dependencies and the footer repaints when one changes; `update()`
 * takes over from the thunk, mirroring `render()`. Unlike `render()`, the
 * terminal stays in the primary buffer, the cursor stays visible (parked
 * where the frame's `cursor` points), autowrap stays on, and the mouse is
 * not captured unless asked.
 *
 * Startup queries the cursor position so committed output continues directly
 * below whatever the shell already printed. The footer height follows the
 * frame's line count, growing by evicting visible history into scrollback and
 * shrinking by clearing the vacated rows.
 *
 * ```ts no_run
 * import { renderInline } from 'fino:tty/tui';
 *
 * const app = renderInline(() => ({ lines: ['❯ type here', 'ready'], cursor: null }));
 * app.printAbove(['hello from scrollback']);
 * await app.stop();
 * ```
 */
export function renderInline(
  footer: InlineFrame | (() => InlineFrame),
  options: InlineOptions = {},
): InlineApp {
  return new InlineAppImpl(footer, options);
}

/**
 * Run an inline app and guarantee terminal restoration.
 *
 * Calls `run` with the live app and always awaits {@link InlineApp.stop} on
 * the way out — including when `run` throws — so the scroll region, cursor,
 * autowrap, and raw mode are restored even on error paths.
 *
 * ```ts no_run
 * import { withInlineApp } from 'fino:tty/tui';
 *
 * await withInlineApp(() => ({ lines: ['ready'] }), {}, async (app) => {
 *   app.printAbove(['one line of history']);
 * });
 * ```
 */
export async function withInlineApp(
  footer: InlineFrame | (() => InlineFrame),
  options: InlineOptions,
  run: (app: InlineApp) => Promise<void>,
): Promise<void> {
  const app = renderInline(footer, options);
  try {
    await run(app);
  } finally {
    await app.stop();
  }
}
