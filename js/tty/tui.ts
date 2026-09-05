/**
 * fino:tty/tui — terminal render target for `fino:ui` components.
 *
 * The terminal is a retained-mode host: the `fino:ui` reconciler maintains a
 * node tree here, a flexbox-subset layout engine measures and paints it into
 * styled-cell frames (`fino:tty/frame`), and ANSI bytes exist only at the wire
 * edge. Live rendering diffs frames row-wise, so screen writes stay
 * proportional to what changed.
 *
 * Primitives are host-neutral: `Box` (flexbox layout, padding, margin,
 * borders), `Text` (styled runs, wrapping, caret), `Spacer`, `Input`,
 * `Button`, `List`, `Scroll`, `Layer` (content painted above the normal
 * flow), and `Clickable` (focusable pointer/key behavior without visuals).
 * All accept style props (`color`, `background`, `bold`, …)
 * resolved against `fino:tty/style` tokens during layout.
 *
 * ## Layout model
 *
 * Layout uses integer terminal cells rather than browser pixels. It implements
 * row and column flex flow, optional row wrapping, fixed/min/max sizes, weighted
 * growth and shrinkage, margins, padding, gaps, alignment, clipping, and
 * out-of-flow layers. Grapheme clusters are never split across cells, and wide
 * characters occupy two cells. Unlike HTML/CSS there is no cascade, intrinsic
 * font metric, percentage sizing, grid, or automatic scrolling; overflow is
 * clipped unless a box explicitly requests visible overflow, and scroll offsets
 * are controlled by the application.
 *
 * Live apps route mouse input to the topmost painted node and bubble toward
 * its ancestors. Keys start at the focused node; Tab and Shift-Tab traverse
 * enabled `Clickable` nodes, while active overlays may opt into unfocused key
 * capture. Input reads preserve escape sequences and UTF-8 code points split
 * across operating-system reads. Unless dimensions are pinned, `render()`
 * reflows the retained tree after terminal resize notifications.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { Box, Text, renderFrame } from 'fino:tty/tui';
 *
 * const frame = renderFrame(
 *   <Box border padding={1}><Text color="cyan">Hello</Text></Box>,
 *   { width: 20, height: 3 },
 * );
 * ```
 */
import {
  h,
  Fragment,
  createRoot,
  createRenderer,
  createSignal,
  batch,
  type Props,
  type Root,
  type Sink,
  type VNode,
} from 'fino:ui';
import { writeStdout } from '../tty.ts';
import { stdin } from '../process.ts';
import type { ReadResult } from '../internal/stream.ts';
import { timeout as loopTimeout } from '../internal/runtime/loop.ts';
import {
  disableAutoWrap,
  enableAutoWrap,
  enterAlternateScreen,
  enterMouseMode,
  enterRawMode,
  exitAlternateScreen,
  exitMouseMode,
  hideCursor,
  onResize,
  showCursor,
  queryTerminalSize,
} from '../internal/tty/bindings.ts';
import { layout as layoutRetained, measure as measureRetained } from 'internal:tty/layout';
import type { Constraints, Measured } from 'internal:tty/layout';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { TuiDispatcher } from 'internal:tty/events';
import { holdSpinnerClock, lowerTui } from 'internal:tty/lower';
import { frameToAnsi, frameToScreen } from 'fino:tty/frame';
import type { Frame } from 'fino:tty/frame';
import type {
  BorderStyle,
  FlexChildProps,
  StyleProps,
  UiKeyEvent,
  UiMouseEvent,
  WrapMode,
} from 'fino:ui/components';
export { h, Fragment, createSignal, batch };
export type { BorderStyle, Constraints, Measured, WrapMode };
/** Props accepted by `Button`. */
export interface ButtonProps extends StyleProps, FlexChildProps, Props {
  /** Text rendered inside the button brackets. */
  label?: string;
  /** Whether to draw the keyboard-focus marker. */
  focused?: boolean;
}
/** Props accepted by `List`. */
export interface ListProps extends StyleProps, FlexChildProps, Props {
  /** Rows rendered from top to bottom. */
  items: string[];
  /** Zero-based row receiving the selection marker; defaults to zero. */
  selectedIndex?: number;
}
/** Focus control surface exposed by a live TUI app. */
export interface TuiFocus {
  /** Signal carrying the focused node's `id`, for components to render focus. */
  readonly focusedId: { get(): string | null };
  /** Move focus to the next enabled focusable node. */
  next(): boolean;
  /** Move focus to the previous enabled focusable node. */
  prev(): boolean;
  /** Focus the enabled node with `id`, returning whether it was found. */
  focus(id: string): boolean;
  /** Clear the current focus. */
  blur(): void;
}
/** Options for deterministic terminal snapshot rendering. */
export interface RenderFrameOptions {
  /** Output width in terminal cells; negative and fractional values are normalized. */
  width: number;
  /** Output height in terminal rows; negative and fractional values are normalized. */
  height: number;
}
/** Current terminal viewport size in character cells. */
export interface TerminalSize {
  /** Viewport columns. */
  width: number;
  /** Viewport rows. */
  height: number;
}
/** Options for live fullscreen terminal rendering. */
export interface RenderOptions {
  /** Fixed viewport width; defaults to the current terminal width. */
  width?: number;
  /** Fixed viewport height; defaults to the current terminal height. */
  height?: number;
  /** Whether to create a raw input reader. An event handler also enables input. */
  input?: boolean;
  /** Whether the input reader enables SGR mouse reporting; defaults to true. */
  mouse?: boolean;
  /** Called sequentially for each decoded input event until the app stops. */
  onEvent?: (event: TuiEvent, app: TuiApp) => void | Promise<void>;
}
/** Handle returned by `render()` for updating or stopping a fullscreen app. */
export interface TuiApp {
  /** Replace the current tree and stop any reactive root previously supplied to `render()`. */
  update(element: VNode): void;
  /** Stop rendering and restore terminal screen, cursor, mouse, and raw-mode state. */
  stop(): void;
  /** Raw input reader when input was enabled. */
  input?: TuiInput;
  /** The most recently painted frame. */
  frame(): Frame | null;
  /** Focus traversal and state for the retained tree. */
  focus: TuiFocus;
}
/** Keyboard event decoded from terminal input. */
export type TuiKeyEvent = UiKeyEvent;
/** Mouse event decoded from SGR terminal mouse reporting. */
export type TuiMouseEvent = UiMouseEvent;
/** Terminal input event consumed by TUI applications. */
export type TuiEvent = TuiKeyEvent | TuiMouseEvent;
const decoder = new TextDecoder();
/** Host-neutral primitives, re-exported for existing terminal applications. */
export { Box, Clickable, Input, Layer, Rule, Scroll, Spacer, Text } from 'fino:ui/components';
export type {
  BoxProps,
  ClickableProps,
  InputProps,
  LayerProps,
  RuleProps,
  ScrollProps,
  SpacerProps,
  StyleProps,
  TextProps,
} from 'fino:ui/components';

/** Push button primitive rendered as bracketed terminal text. */
export function Button(props: ButtonProps): VNode {
  return h('button', props);
}
/** Vertical list primitive with a selected row marker. */
export function List(props: ListProps): VNode {
  return h('list', props);
}

/** Measure a terminal component tree under the supplied cell constraints. */
export function measure(element: VNode, constraints: Constraints): Measured {
  return measureRetained(lowerTui(element), constraints);
}

/** Lay out and paint a terminal component tree into a structured frame. */
export function layout(element: VNode, constraints: Constraints): Frame {
  return layoutRetained(lowerTui(element), constraints);
}

function frameConstraints(options: RenderFrameOptions): Required<Constraints> {
  return {
    width: Math.max(0, Math.floor(options.width)),
    height: Math.max(0, Math.floor(options.height)),
  };
}

function emptyFrame(constraints: Required<Constraints>): Frame {
  return {
    ...constraints,
    rows: [],
    cursor: null,
    hits: [],
  };
}

/** @internal */
export interface RetainedTerminal {
  readonly sink: Sink<Frame>;
  readonly dispatcher: TuiDispatcher;
  resize(options: RenderFrameOptions): void;
}

/**
 * Build the retained terminal pipeline: lower, reconcile, dispatch, lay out.
 *
 * Shared by `render()` and `fino:tty/inline` so the two renderers differ only
 * in which part of the screen they own, never in how a tree becomes a frame.
 *
 * ```ts no_run
 * import { retainedTerminal } from 'fino:tty/tui';
 *
 * const retained = retainedTerminal({ width: 80, height: 24 });
 * ```
 *
 * @internal
 */
export function retainedTerminal(options: RenderFrameOptions): RetainedTerminal {
  let constraints = frameConstraints(options);
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(root);
  return {
    dispatcher,
    sink: {
      commit(tree: VNode): Frame {
        renderer.render(lowerTui(tree), root);
        dispatcher.reconcile();
        const node = root.children[0];
        return node === undefined ? emptyFrame(constraints) : layoutRetained(node, constraints);
      },
    },
    resize(next: RenderFrameOptions): void {
      constraints = frameConstraints(next);
    },
  };
}
function keyEvent(key: string, extra: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return {
    type: 'key',
    key,
    ...extra,
  };
}
function decodeCsi(sequence: string): TuiEvent | null {
  if (sequence === '\x1B[A') return keyEvent('up');
  if (sequence === '\x1B[B') return keyEvent('down');
  if (sequence === '\x1B[C') return keyEvent('right');
  if (sequence === '\x1B[D') return keyEvent('left');
  if (sequence === '\x1B[H') return keyEvent('home');
  if (sequence === '\x1B[F') return keyEvent('end');
  if (sequence === '\x1B[Z') return keyEvent('tab', { shift: true });
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (sgr) {
    const code = Number(sgr[1]);
    const x = Math.max(0, Number(sgr[2]) - 1);
    const y = Math.max(0, Number(sgr[3]) - 1);
    const releaseMarker = sgr[4] === 'm';
    const base = code & 3;
    const shift = (code & 4) !== 0;
    const alt = (code & 8) !== 0;
    const ctrl = (code & 16) !== 0;
    const drag = (code & 32) !== 0;
    const wheel = (code & 64) !== 0;
    const button = wheel
      ? (code & 1) === 0
        ? 'wheel-up'
        : 'wheel-down'
      : base === 0
        ? 'left'
        : base === 1
          ? 'middle'
          : base === 2
            ? 'right'
            : 'left';
    const action = wheel
      ? 'wheel'
      : releaseMarker || base === 3
        ? 'release'
        : drag
          ? 'drag'
          : 'press';
    return {
      type: 'mouse',
      action,
      button,
      x,
      y,
      ctrl,
      alt,
      shift,
    };
  }
  const tilde = /^\x1b\[(\d+)~$/.exec(sequence);
  if (tilde) {
    const name = (
      {
        '1': 'home',
        '3': 'delete',
        '4': 'end',
        '5': 'pageup',
        '6': 'pagedown',
      } as Record<string, string>
    )[tilde[1]!];
    if (name) return keyEvent(name);
  }
  return null;
}
/** Whether the suffix beginning at `at` could be an unfinished escape sequence. */
function pendingEscape(text: string, at: number): boolean {
  return /^\x1b(?:\[[\d;<]*)?$/.test(text.slice(at));
}

function decodeInputText(text: string, streaming: boolean): { events: TuiEvent[]; rest: string } {
  const events: TuiEvent[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '\x1B') {
      const sgr = /^\x1b\[<\d+;\d+;\d+[Mm]/.exec(text.slice(i));
      const csi = sgr ?? /^\x1b\[(?:\d+~|[A-Za-z])/.exec(text.slice(i));
      if (csi) {
        const event = decodeCsi(csi[0]);
        if (event) events.push(event);
        i += csi[0].length;
        continue;
      }
      if (streaming && pendingEscape(text, i)) return { events, rest: text.slice(i) };
      if (i + 1 < text.length) {
        events.push(keyEvent(text[i + 1]!, { alt: true }));
        i += 2;
        continue;
      }
      events.push(keyEvent('escape'));
      i++;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code === 3) events.push(keyEvent('c', { ctrl: true }));
    else if (code === 4) events.push(keyEvent('d', { ctrl: true }));
    else if (code === 127 || code === 8) events.push(keyEvent('backspace'));
    else if (code === 13 || code === 10) events.push(keyEvent('enter'));
    else if (code === 9) events.push(keyEvent('tab'));
    else if (code >= 1 && code <= 26)
      events.push(keyEvent(String.fromCharCode(code + 96), { ctrl: true }));
    else events.push(keyEvent(ch, { text: ch }));
    i++;
  }
  return { events, rest: '' };
}

/**
 * Decode one complete terminal input byte chunk into TUI input events.
 *
 * The decoder understands printable UTF-8, common control keys, arrow/function
 * CSI sequences, and SGR mouse reporting (`CSI < code ; x ; y M/m`). SGR mouse
 * coordinates are converted to zero-based `x`/`y` values. A trailing partial
 * sequence is treated literally; `TuiInput` reassembles partial live reads.
 */
export function decodeTuiInput(bytes: Uint8Array): TuiEvent[] {
  return decodeInputText(decoder.decode(bytes), false).events;
}
/** Options for creating a raw terminal input reader. */
export interface TuiInputOptions {
  /** Whether to enable SGR mouse reporting while the reader is open; defaults to true. */
  mouse?: boolean;
}
/**
 * Raw terminal input reader for keyboard and mouse events.
 *
 * One reader owns stdin raw mode and its readability watch at a time. Calls to
 * `read()` are sequential: each returns one decoded event, preserving partial
 * escape sequences and UTF-8 between operating-system reads. `close()` is
 * idempotent, cancels a blocked read, disables mouse reporting when enabled,
 * and restores the terminal mode captured by the constructor.
 */
export class TuiInput {
  #restoreRaw: (() => void) | null;
  #closed = false;
  #queue: TuiEvent[] = [];
  #partial = '';
  #pendingRead: Promise<ReadResult<Uint8Array>> | null = null;
  #abortRead = new AbortController();
  #stream = new TextDecoder();
  #mouse: boolean;
  #closedPromise: Promise<void>;
  #resolveClosed: () => void = () => {};
  /** Enter raw mode and optionally enable mouse reporting immediately. */
  constructor(options: TuiInputOptions = {}) {
    this.#restoreRaw = enterRawMode(0);
    this.#mouse = options.mouse !== false;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    if (this.#mouse) void writeStdout(enterMouseMode());
  }
  /**
   * Turn mouse reporting on or off, returning the resulting state.
   *
   * Inline apps start without capture so the terminal keeps selection, and
   * enable it only while a pointer-driven view is on screen.
   */
  setMouse(enabled: boolean): boolean {
    if (this.#closed || enabled === this.#mouse) return this.#mouse;
    this.#mouse = enabled;
    void writeStdout(enabled ? enterMouseMode() : exitMouseMode());
    return this.#mouse;
  }
  #flushPartial(): void {
    if (this.#partial.length === 0) return;
    const held = this.#partial;
    this.#partial = '';
    this.#queue.push(...decodeInputText(held, false).events);
  }
  /** Read the next decoded keyboard or mouse event from stdin. */
  async read(): Promise<TuiEvent | null> {
    while (!this.#closed) {
      const queued = this.#queue.shift();
      if (queued) return queued;
      this.#pendingRead ??= stdin().read({ signal: this.#abortRead.signal });
      let result: ReadResult<Uint8Array>;
      const read = this.#pendingRead.then(
        (value) => ({ kind: 'read' as const, value }),
        (error) => {
          if (this.#closed) return { kind: 'closed' as const };
          throw error;
        },
      );
      if (this.#partial.length > 0) {
        const hold = loopTimeout(25);
        const settled = await Promise.race([
          read,
          hold.then(() => ({ kind: 'hold' as const })),
          this.#closedPromise.then(() => ({ kind: 'closed' as const })),
        ]);
        if (settled.kind === 'closed') {
          hold.cancel();
          return null;
        }
        if (settled.kind === 'hold') {
          this.#flushPartial();
          continue;
        }
        hold.cancel();
        result = settled.value;
      } else {
        const settled = await Promise.race([
          read,
          this.#closedPromise.then(() => ({ kind: 'closed' as const })),
        ]);
        if (settled.kind === 'closed') return null;
        result = settled.value;
      }
      this.#pendingRead = null;
      if (result.done) {
        if (this.#partial.length === 0) return null;
        this.#flushPartial();
        continue;
      }
      const chunk = this.#partial + this.#stream.decode(result.value, { stream: true });
      const { events, rest } = decodeInputText(chunk, true);
      this.#partial = rest;
      this.#queue.push(...events);
    }
    return null;
  }
  /** Restore raw mode and mouse reporting. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Abort removes the shared stdin readiness watch synchronously. Publish
    // closure only after that cleanup so a replacement reader cannot race it.
    this.#abortRead.abort(new Error('Terminal input closed'));
    this.#resolveClosed();
    if (this.#mouse) void writeStdout(exitMouseMode());
    this.#restoreRaw?.();
    this.#restoreRaw = null;
  }
}
/**
 * Create a raw terminal input reader for TUI applications.
 *
 * The reader enables raw mode immediately. Call `close()` when the application
 * exits so terminal state is restored.
 */
export function createTuiInput(options: TuiInputOptions = {}): TuiInput {
  return new TuiInput(options);
}
/**
 * Return the current terminal viewport size.
 *
 * The TUI host asks the terminal with `ioctl(TIOCGWINSZ)` when possible and
 * falls back to environment dimensions in non-interactive contexts.
 */
export function getTerminalSize(): TerminalSize {
  return queryTerminalSize();
}
/**
 * Measure the visible terminal viewport with an ANSI cursor-position query.
 *
 * This is slower than `getTerminalSize()` but handles terminal panes where
 * `ioctl(TIOCGWINSZ)` or environment dimensions are stale. The function enters
 * raw mode briefly, moves the cursor to a very large coordinate, asks the
 * terminal to report the clamped cursor position, restores the cursor, and
 * returns the reported row/column. If the terminal does not answer quickly, it
 * falls back to `getTerminalSize()`.
 */
export async function measureTerminalSize(): Promise<TerminalSize> {
  const fallback = getTerminalSize();
  let restoreRaw: (() => void) | null = null;
  try {
    restoreRaw = enterRawMode(0);
    await writeStdout('\x1B[s\x1B[9999;9999H\x1B[6n\x1B[u');
    const controller = new AbortController();
    const timer = loopTimeout(150);
    void timer.then(() => controller.abort(new Error('terminal size query timed out')));
    let response = '';
    while (!controller.signal.aborted) {
      const result = await stdin().read({
        maxBytes: 64,
        signal: controller.signal,
      });
      if (result.done) break;
      response += decoder.decode(result.value);
      const match = /\x1b\[(\d+);(\d+)R/.exec(response);
      if (match) {
        timer.cancel();
        const height = Number(match[1]);
        const width = Number(match[2]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          return {
            width: Math.floor(width),
            height: Math.floor(height),
          };
        }
        break;
      }
    }
    timer.cancel();
  } catch (_) {
    return fallback;
  } finally {
    restoreRaw?.();
  }
  return fallback;
}
/**
 * Lay a tree out into a styled-cell frame without touching a terminal.
 *
 * This is the one-shot path: the tree is laid out fresh with no retained
 * state. Pass the result to `frameToAnsi()`/`frameToScreen()` from
 * `fino:tty/frame`, or use `renderFrame()` for the padded-string form.
 */
export function layoutFrame(element: VNode, options: RenderFrameOptions): Frame {
  return layout(element, frameConstraints(options));
}
/**
 * Render an element tree to a deterministic terminal frame.
 *
 * The returned string contains exactly `height` lines joined with `\n`, and
 * each line is padded or clipped to `width` cells.
 */
export function renderFrame(element: VNode, options: RenderFrameOptions): string {
  return frameToAnsi(layoutFrame(element, options));
}
/**
 * Sink that turns each committed tree into a terminal frame string.
 *
 * The frame is a complete screen image rather than a diff, so this is a
 * snapshot sink like `htmlSink()`. Pair it with `renderStatic()` to capture
 * one frame, or with `createRoot()` to drive a live screen from signals.
 *
 * ```ts no_run
 * import { createRoot } from 'fino:ui';
 * import { frameSink } from 'fino:tty/tui';
 *
 * const root = createRoot(App, frameSink({ width: 80, height: 24 }));
 * ```
 */
export function frameSink(options: RenderFrameOptions): Sink<string> {
  return {
    commit(tree: VNode): string {
      return renderFrame(tree, options);
    },
  };
}
/**
 * Sink that reconciles each committed tree into a retained terminal node tree
 * and returns the laid-out `Frame`.
 *
 * Unlike `frameSink()`, consecutive commits reuse the mounted tree, so
 * unchanged subtrees keep their measurement caches. Use this when the caller
 * needs the structured frame — cursor placement, hit regions — rather than
 * encoded text.
 */
export function terminalSink(options: RenderFrameOptions): Sink<Frame> {
  return retainedTerminal(options).sink;
}
/**
 * Render a fullscreen terminal app and return a lifecycle handle.
 *
 * This enters the alternate screen, hides the cursor, and paints frames
 * through the retained host with row-level diffing — only rows whose encoded
 * form changed are rewritten. When a frame places a caret (`Text caret` or a
 * focused `Input`), the terminal cursor is shown there.
 *
 * Passing a function instead of a tree makes the app reactive: every signal
 * read while rendering becomes a dependency, and the screen repaints when one
 * changes. `update()` remains available for callers that drive frames
 * themselves, and takes over from the reactive root when used.
 * Tree handlers receive input before `onEvent`; only unconsumed events reach
 * the fallback callback. `stop()` is idempotent and cancels a blocked input
 * read before restoring raw mode, mouse reporting, cursor state, auto-wrap,
 * and the primary screen.
 *
 * ```ts no_run
 * import { createSignal } from 'fino:ui';
 * import { Text, render } from 'fino:tty/tui';
 *
 * const ticks = createSignal(0);
 * const app = render(() => Text({ children: [String(ticks.get())] }));
 * ticks.set(1);
 * app.stop();
 * ```
 */
export function render(element: VNode | (() => VNode), options: RenderOptions = {}): TuiApp {
  let stopped = false;
  const size = queryTerminalSize();
  let width = options.width ?? size.width;
  let height = options.height ?? size.height;
  let lastTree: VNode | null = null;
  const input =
    options.input || options.onEvent ? createTuiInput({ mouse: options.mouse ?? true }) : undefined;
  const retained = retainedTerminal({ width, height });
  const dispatcher = retained.dispatcher;
  let lastFrame: Frame | null = null;
  let cursorShown = false;
  let restored = false;
  let stopResize: (() => void) | null = null;
  let root: Root<Frame> | null = null;
  const releaseSpinnerClock = holdSpinnerClock();
  void writeStdout(enterAlternateScreen() + hideCursor() + disableAutoWrap() + '\x1B[2J');
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    stopResize?.();
    stopResize = null;
    input?.close();
    releaseSpinnerClock();
    void writeStdout(enableAutoWrap() + showCursor() + exitAlternateScreen());
  };
  const sink: Sink<Frame> = {
    commit(tree: VNode): Frame {
      lastTree = tree;
      const frame = retained.sink.commit(tree);
      if (!stopped) {
        let out = frameToScreen(frame, lastFrame);
        if (frame.cursor) {
          out += `\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H`;
          if (!cursorShown) out += showCursor();
          cursorShown = true;
        } else if (cursorShown) {
          out += hideCursor();
          cursorShown = false;
        }
        if (out.length > 0) void writeStdout(out);
      }
      lastFrame = frame;
      return frame;
    },
  };
  // A tree renders once; a thunk keeps its signal dependencies live. Both go
  // through the same sink, so the paint path does not fork.
  try {
    if (typeof element === 'function') root = createRoot(element, sink);
    else sink.commit(element);
    if (options.width === undefined || options.height === undefined) {
      stopResize = onResize((next) => {
        if (stopped) return;
        const nextWidth = options.width ?? next.width;
        const nextHeight = options.height ?? next.height;
        if (nextWidth === width && nextHeight === height) return;
        width = nextWidth;
        height = nextHeight;
        retained.resize({ width, height });
        lastFrame = null;
        void writeStdout('\x1B[2J');
        if (lastTree) sink.commit(lastTree);
      });
    }
  } catch (error) {
    stopped = true;
    root?.dispose();
    root = null;
    restoreTerminal();
    throw error;
  }
  const app: TuiApp = {
    input,
    focus: {
      focusedId: dispatcher.focusedId,
      next: () => dispatcher.focusNext(),
      prev: () => dispatcher.focusPrev(),
      focus: (id: string) => dispatcher.focusId(id),
      blur: () => dispatcher.blur(),
    },
    frame(): Frame | null {
      return lastFrame;
    },
    update(next: VNode): void {
      root?.dispose();
      root = null;
      sink.commit(next);
    },
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
  if (input) {
    void (async () => {
      while (!stopped) {
        const event = await input.read();
        if (event === null) break;
        // Handlers on the tree see the event first; `onEvent` receives only
        // what no handler consumed.
        if (dispatcher.dispatch(event)) continue;
        await options.onEvent?.(event, app);
      }
    })();
  }
  return app;
}
