/**
 * fino:tty/inline — inline terminal rendering with a pinned footer.
 *
 * Where `render()` from `fino:tty/tui` takes the alternate screen and owns the
 * viewport, this renderer stays in the primary buffer. Finalized output is
 * pushed into the terminal's own scrollback — natively selectable, scrollable,
 * and still there after the process exits — while a small footer pinned to the
 * bottom rows is repainted in place. That is the shape a REPL or a coding agent
 * wants: a transcript the terminal owns, above a composer the app owns.
 *
 * The footer is a component tree, laid out through the same retained pipeline
 * `render()` uses, so focus, key dispatch and the component catalog all work
 * inside it. Only viewport ownership differs.
 *
 * Pushing history uses a DECSTBM scroll region confined to the rows above the
 * footer: the cursor parks on the last occupied history row and writes `\r\n`
 * per line, which fills any blank rows first and then scrolls the region, so
 * rows evicted off the top enter real scrollback while the footer stays put.
 * The region is always reset inside the same composed write, so an interrupted
 * process never leaves the terminal with a stale margin.
 *
 * Mouse capture is off by default. Inline mode exists so the terminal keeps
 * selection, scrolling and find; an app that needs pointer input can turn it on
 * per app or take the alternate screen for a modal overlay.
 *
 * ```ts no_run
 * import { Text } from 'fino:ui/components';
 * import { renderInline } from 'fino:tty/inline';
 *
 * const app = renderInline(() => Text({ children: ['> '] }), {
 *   onEvent(event) {
 *     if (event.type === 'key' && event.key === 'enter') app.printAbove(['committed']);
 *   },
 * });
 * ```
 */
import { createRoot, type Root, type Sink, type VNode } from 'fino:ui';
import { writeStdout } from '../tty.ts';
import {
  cursorTo,
  disableAutoWrap,
  enableAutoWrap,
  eraseLine,
  eraseScrollback,
  eraseToLineEnd,
  hideCursor,
  onResize,
  queryTerminalSize,
  resetScrollRegion,
  setScrollRegion,
  showCursor,
} from '../internal/tty/bindings.ts';
import { clipRow, rowToAnsi } from 'fino:tty/frame';
import type { Frame, Row } from 'fino:tty/frame';
import {
  createTuiInput,
  layout,
  measure,
  retainedTerminal,
  type TerminalSize,
  type TuiEvent,
  type TuiFocus,
  type TuiInput,
} from './tui.ts';

/** Options for {@link renderInline}. */
export interface InlineOptions {
  /** Fixed width in cells; defaults to the terminal width and tracks resizes. */
  width?: number;
  /** Read keyboard input; defaults to true, and an `onEvent` handler implies it. */
  input?: boolean;
  /**
   * Capture the mouse. Defaults to false — inline mode exists to leave
   * selection, scrolling and find to the terminal.
   */
  mouse?: boolean;
  /**
   * Clamp footer growth to this many rows, always at most one less than the
   * terminal height. Defaults to 20. A taller footer keeps its last rows.
   */
  maxFooterRows?: number;
  /** Called for each decoded event no tree handler consumed. */
  onEvent?: (event: TuiEvent, app: InlineApp) => void | Promise<void>;
  /** Called after geometry is re-established at a new terminal size. */
  onResize?: (size: TerminalSize, app: InlineApp) => void;
}

/** Handle returned by {@link renderInline}. */
export interface InlineApp {
  /**
   * Commit finalized content into the terminal's scrollback, above the footer.
   *
   * A component tree is laid out at the current width and committed row by
   * row. Strings are written verbatim, so pre-wrap them: a line wider than the
   * terminal soft-wraps and evicts an extra row.
   */
  printAbove(content: VNode | string[]): void;
  /**
   * Clear the screen and the terminal's scrollback and start committing from
   * the top again.
   *
   * Rows already committed cannot be re-wrapped, so an app whose transcript
   * should follow a new terminal width has to discard and re-emit it. Anything
   * the reader had scrolled back to is lost — this is for deliberate rebuilds,
   * not routine repainting.
   */
  resetHistory(): void;
  /** Replace the footer tree, stopping any reactive root given to `renderInline`. */
  update(element: VNode): void;
  /** Current terminal size. */
  size(): TerminalSize;
  /** Rows the footer currently occupies. */
  footerRows(): number;
  /** Toggle mouse capture, returning the resulting state. */
  setMouse(enabled: boolean): boolean;
  /** The most recently laid-out footer frame. */
  frame(): Frame | null;
  /** Focus traversal over the footer's retained tree. */
  focus: TuiFocus;
  /** Raw input reader when input was enabled. */
  input?: TuiInput;
  /**
   * Clear the footer, park the cursor on the row after the last committed
   * line, and restore terminal state. Idempotent.
   */
  stop(): void;
}

/**
 * Geometry and paint state threaded through {@link composeInline}.
 *
 * `footerRows` is the height of the pinned viewport, so the footer's first row
 * is `height - footerRows + 1` once history has grown to meet it.
 * `historyBottom` is the last screen row occupied by committed history, or 0
 * when none is visible; rows between it and the footer are blank and are
 * filled before anything scrolls.
 *
 * @internal
 */
export interface InlineState {
  width: number;
  height: number;
  footerRows: number;
  historyBottom: number;
  /** Footer rows as last painted, post-clip, for diffing repaints. */
  lastLines: string[];
  /** Cursor as last parked, or null while hidden. */
  cursor: { row: number; column: number } | null;
}

/**
 * One flush worth of work for {@link composeInline}.
 *
 * @internal
 */
export interface InlineOps {
  /** Lines to commit above the footer, oldest first. */
  history?: string[];
  /** Encoded footer rows; omit to keep the current footer. */
  lines?: string[];
  /** Where the cursor sits within the footer, or null to hide it. */
  cursor?: { row: number; column: number } | null;
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
 * Row the footer starts on: directly below the committed history, or pinned to
 * the bottom of the screen once history has grown to meet it.
 *
 * Keeping the footer against the content is what stops a blank band from
 * opening between the transcript and the composer while the screen is still
 * filling. The footer follows the conversation down the way a shell prompt
 * follows its output, and stops when there is nowhere left to go.
 *
 * @internal
 */
export function footerTop(height: number, footerRows: number, historyBottom: number): number {
  return Math.min(height - footerRows + 1, historyBottom + 1);
}

/**
 * Compose one inline flush into terminal output and the geometry it leaves.
 *
 * Pure: every decision is a function of `state` and `ops`, which is what makes
 * the placement rules testable without a terminal.
 *
 * @internal
 */
export function composeInline(
  state: InlineState,
  ops: InlineOps,
): { out: string; state: InlineState } {
  const { width, height } = state;
  const oldRows = state.footerRows;
  const oldTop = footerTop(height, oldRows, state.historyBottom);
  let historyBottom = state.historyBottom;
  let out = '';

  const lines = ops.lines;
  const footerRows = lines ? Math.max(1, Math.min(lines.length, height - 1)) : oldRows;
  // The lowest row history may ever occupy: one above where the footer pins.
  const regionBottom = Math.max(1, height - footerRows);

  // A footer that just grew can overlap rows history already owns. Scroll the
  // transcript up by the overlap before anything else touches the screen.
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
    // as the terminal leaves the cursor in the pending-wrap state, still on the
    // last column, and erasing to end there would delete what was just written.
    if (historyBottom === 0) {
      out += cursorTo(1, 1) + eraseToLineEnd() + (history[0] ?? '');
      historyBottom = 1;
      rest = history.slice(1);
    } else {
      out += cursorTo(Math.min(historyBottom, regionBottom), 1);
    }
    for (const line of rest) {
      out += '\r\n' + eraseToLineEnd() + line;
      historyBottom = Math.min(historyBottom + 1, regionBottom);
    }
    out += resetScrollRegion();
  }

  const top = footerTop(height, footerRows, historyBottom);
  const geometryChanged = top !== oldTop || footerRows !== oldRows;
  if (geometryChanged) {
    // Rows the footer has left behind still show its last paint. Clear the ones
    // history did not just overwrite so nothing stale can scroll away.
    for (let row = oldTop; row < oldTop + oldRows && row <= height; row++) {
      const covered = row >= top && row < top + footerRows;
      if (!covered && row > historyBottom) out += cursorTo(row, 1) + eraseLine();
    }
  }

  let lastLines = state.lastLines;
  if (lines) {
    const next = lines.slice(0, footerRows);
    while (next.length < footerRows) next.push('');
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

  const cursor = ops.cursor !== undefined ? ops.cursor : state.cursor;
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
  return { out: final, state: { width, height, footerRows, historyBottom, lastLines, cursor } };
}

/**
 * Encode frame rows for the footer.
 *
 * Rows stop one column short of the terminal and are erased rather than padded.
 * A row that fills the last column can be recorded as soft-wrapped, and the
 * next time the terminal re-wraps — narrowing the window — it joins that row
 * with the one below, which arrives as the footer sliding right behind a run of
 * padding spaces.
 */
function encodeRows(rows: readonly Row[], count: number, width: number): string[] {
  const cell = Math.max(1, width - 1);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    out.push(row === undefined ? '' : rowToAnsi(clipRow(row, cell)));
  }
  return out;
}

/**
 * Render a component tree as an inline footer above the terminal's scrollback.
 *
 * Passing a function makes the footer reactive: every signal read while
 * rendering becomes a dependency and the footer repaints when one changes.
 *
 * ```ts no_run
 * import { Text } from 'fino:ui/components';
 * import { renderInline } from 'fino:tty/inline';
 *
 * const app = renderInline(Text({ children: ['ready'] }));
 * app.printAbove(['a finished line']);
 * app.stop();
 * ```
 */
export function renderInline(
  element: VNode | (() => VNode),
  options: InlineOptions = {},
): InlineApp {
  const terminal = queryTerminalSize();
  let width = options.width ?? terminal.width;
  let height = terminal.height;
  const maxRows = Math.max(1, options.maxFooterRows ?? 20);
  let stopped = false;
  let restored = false;
  let stopResize: (() => void) | null = null;
  let root: Root<Frame> | null = null;
  let lastTree: VNode | null = null;
  let lastFrame: Frame | null = null;
  let mouseOn = options.mouse === true;

  const wantsInput = options.input !== false || options.onEvent !== undefined;
  const input = wantsInput ? createTuiInput({ mouse: mouseOn }) : undefined;
  const retained = retainedTerminal({ width, height: footerBudget() });
  const dispatcher = retained.dispatcher;

  let state: InlineState = {
    width,
    height,
    footerRows: 1,
    historyBottom: 0,
    lastLines: [],
    cursor: null,
  };

  function footerBudget(): number {
    return Math.max(1, Math.min(maxRows, height - 1));
  }

  function flush(ops: InlineOps): void {
    if (restored) return;
    const composed = composeInline(state, ops);
    state = composed.state;
    if (composed.out.length > 0) void writeStdout(composed.out);
  }

  /**
   * Lay the footer out and paint whatever changed.
   *
   * The footer is sized to the height its content asks for, not to the budget:
   * laying it out at the maximum would claim every spare row, leaving the
   * transcript one row to live in and pinning the footer to the top.
   */
  function paint(tree: VNode, forceRepaint = false): Frame {
    lastTree = tree;
    const intrinsic = measure(tree, { width });
    const rows = Math.max(1, Math.min(intrinsic.height, footerBudget()));
    retained.resize({ width, height: rows });
    const frame = retained.sink.commit(tree);
    lastFrame = frame;
    flush({
      lines: encodeRows(frame.rows, rows, width),
      cursor: frame.cursor ? { row: frame.cursor.row, column: frame.cursor.column } : null,
      forceRepaint,
    });
    return frame;
  }

  const sink: Sink<Frame> = { commit: (tree) => paint(tree) };

  void writeStdout(disableAutoWrap());

  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    stopResize?.();
    stopResize = null;
    input?.close();
    // Clear the footer and leave the cursor on the row after the transcript, so
    // the shell prompt lands where the app's output ended.
    let out = resetScrollRegion() + hideCursor();
    const top = footerTop(state.height, state.footerRows, state.historyBottom);
    for (let i = 0; i < state.footerRows; i++) out += cursorTo(top + i, 1) + eraseLine();
    out += cursorTo(Math.min(top, state.height), 1) + showCursor() + enableAutoWrap();
    void writeStdout(out);
  };

  try {
    if (typeof element === 'function') root = createRoot(element, sink);
    else paint(element);
    if (options.width === undefined) {
      stopResize = onResize((next) => {
        if (stopped) return;
        if (next.width === width && next.height === height) return;
        width = next.width;
        height = next.height;
        // The transcript belongs to the terminal, which has already re-wrapped
        // it. Only the footer's own geometry is ours to re-establish.
        state = {
          ...state,
          width,
          height,
          historyBottom: Math.min(state.historyBottom, Math.max(0, height - 1)),
          lastLines: [],
        };
        retained.resize({ width, height: footerBudget() });
        if (lastTree) paint(lastTree, true);
        options.onResize?.({ width, height }, app);
      });
    }
  } catch (error) {
    stopped = true;
    root?.dispose();
    root = null;
    restoreTerminal();
    throw error;
  }

  const app: InlineApp = {
    printAbove(content: VNode | string[]): void {
      if (stopped) return;
      let history: string[];
      if (Array.isArray(content)) {
        history = content;
      } else {
        const frame = layoutHistory(content);
        // Transcript rows may use the full width: the terminal owns them once
        // they scroll, and nothing repaints them in place afterwards.
        history = encodeRows(frame.rows, frame.rows.length, width + 1);
      }
      if (history.length === 0) return;
      flush({ history });
      if (lastTree) paint(lastTree, true);
    },
    resetHistory(): void {
      if (stopped) return;
      void writeStdout(resetScrollRegion() + cursorTo(1, 1) + '\x1B[2J' + eraseScrollback());
      state = { ...state, historyBottom: 0, lastLines: [] };
      if (lastTree) paint(lastTree, true);
    },
    update(next: VNode): void {
      root?.dispose();
      root = null;
      paint(next);
    },
    size: () => ({ width, height }),
    footerRows: () => state.footerRows,
    setMouse(enabled: boolean): boolean {
      mouseOn = input ? input.setMouse(enabled) : false;
      return mouseOn;
    },
    frame: () => lastFrame,
    focus: {
      focusedId: dispatcher.focusedId,
      next: () => dispatcher.focusNext(),
      prev: () => dispatcher.focusPrev(),
      focus: (id: string) => dispatcher.focusId(id),
      blur: () => dispatcher.blur(),
    },
    input,
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        root?.dispose();
      } finally {
        root = null;
        restoreTerminal();
      }
    },
  };

  /**
   * Lay out a tree for the transcript: full width, the height its content asks
   * for.
   *
   * Committed rows are painted once and never revised, so this goes through the
   * stateless layout rather than the retained pipeline — a transcript line has
   * no identity to reconcile, nothing to focus, and no hit regions to keep.
   */
  function layoutHistory(tree: VNode): Frame {
    const intrinsic = measure(tree, { width });
    return layout(tree, { width, height: Math.max(1, intrinsic.height) });
  }

  if (input) {
    void (async () => {
      while (!stopped) {
        const event = await input.read();
        if (event === null) break;
        if (dispatcher.dispatch(event)) continue;
        await options.onEvent?.(event, app);
      }
    })();
  }
  return app;
}
