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
 * `Button`, `List`, `ScrollView`, and `Layer` (content painted above the
 * normal flow). All accept style props (`color`, `background`, `bold`, …)
 * resolved against `fino:tty/style` tokens during layout.
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
  type Child,
  type Props,
  type Root,
  type Sink,
  type VNode,
} from 'fino:ui';
import { writeStdout } from '../tty.ts';
import { stdin } from '../process.ts';
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
  showCursor,
  queryTerminalSize,
} from '../internal/tty/bindings.ts';
import { layout, measure } from 'internal:tty/layout';
import type { BorderStyle, Constraints, Measured, WrapMode } from 'internal:tty/layout';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { frameToAnsi, frameToScreen } from 'fino:tty/frame';
import type { Frame } from 'fino:tty/frame';
import type { Color, Style } from 'fino:tty/style';
export { h, Fragment, createSignal, batch, layout, measure };
export type { BorderStyle, Constraints, Measured, WrapMode };
type Direction = 'row' | 'column';
type Align = 'start' | 'center' | 'end' | 'stretch';
/** Style props accepted by every terminal primitive. */
export interface StyleProps {
  color?: Color;
  background?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  /** Style token(s) merged left-to-right beneath the individual props above. */
  style?: Style | Style[];
  /** Hit-region id reported in `Frame.hits` for mouse routing. */
  id?: string;
}
/** Flex-child props accepted by every terminal primitive. */
export interface FlexChildProps {
  /** Share of leftover main-axis space. */
  grow?: number;
  /** Share of main-axis deficit absorbed when content overflows. */
  shrink?: number;
  /** Main-axis start size, overriding the measured size. */
  basis?: number;
  /** Shorthand for `grow`. */
  flex?: number;
  alignSelf?: Align;
  margin?: number;
  marginX?: number;
  marginY?: number;
}
/** Props accepted by `Box`. */
export interface BoxProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  direction?: Direction;
  /** Wrap children onto new lines when the main axis overflows (row only). */
  wrap?: boolean;
  /** Main-axis distribution of leftover space. */
  justify?: 'start' | 'center' | 'end' | 'between';
  /** Cross-axis placement of children. */
  align?: Align;
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  /** Draw a border: `true` for the default style, or a named style. */
  border?: boolean | BorderStyle;
  borderStyle?: BorderStyle;
  borderColor?: Color;
  overflow?: 'hidden' | 'visible';
  children?: Child;
}
/** Props accepted by `Text`. */
export interface TextProps extends StyleProps, FlexChildProps, Props {
  /** `true` means word wrap; `'char'` breaks at exact cell boundaries. */
  wrap?: boolean | WrapMode;
  align?: 'start' | 'center' | 'end';
  /** Clip overflowing lines with a trailing ellipsis instead of hard-cutting. */
  truncate?: boolean;
  /** Character offset of the caret within this node's text. */
  caret?: number;
  width?: number;
  height?: number;
  children?: Child;
}
/** Props accepted by `Spacer`. */
export interface SpacerProps extends FlexChildProps, Props {
  width?: number;
  height?: number;
}
/** Props accepted by `Input`. */
export interface InputProps extends StyleProps, FlexChildProps, Props {
  value?: string;
  placeholder?: string;
  focused?: boolean;
  /** Character offset of the caret within `value`. */
  caret?: number;
}
/** Props accepted by `Button`. */
export interface ButtonProps extends StyleProps, FlexChildProps, Props {
  label?: string;
  focused?: boolean;
}
/** Props accepted by `List`. */
export interface ListProps extends StyleProps, FlexChildProps, Props {
  items: string[];
  selectedIndex?: number;
}
/** Props accepted by `ScrollView`. */
export interface ScrollViewProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  /** First content row shown at the top of the viewport. */
  offset?: number;
  children?: Child;
}
/** Props accepted by `Layer`. */
export interface LayerProps extends StyleProps, Props {
  /** Cell position the layer attaches to; omitted centers it. */
  anchor?: { x: number; y: number };
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'center';
  width?: number;
  height?: number;
  children?: Child;
}
/** Options for deterministic terminal snapshot rendering. */
export interface RenderFrameOptions {
  width: number;
  height: number;
}
/** Current terminal viewport size in character cells. */
export interface TerminalSize {
  width: number;
  height: number;
}
/** Options for live fullscreen terminal rendering. */
export interface RenderOptions {
  width?: number;
  height?: number;
  input?: boolean;
  mouse?: boolean;
  onEvent?: (event: TuiEvent, app: TuiApp) => void | Promise<void>;
}
/** Handle returned by `render()` for updating or stopping a fullscreen app. */
export interface TuiApp {
  update(element: VNode): void;
  stop(): void;
  input?: TuiInput;
  /** The most recently painted frame. */
  frame(): Frame | null;
}
/** Keyboard event decoded from terminal input. */
export interface TuiKeyEvent {
  type: 'key';
  key: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}
/** Mouse event decoded from SGR terminal mouse reporting. */
export interface TuiMouseEvent {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  button: 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down';
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
/** Terminal input event consumed by TUI applications. */
export type TuiEvent = TuiKeyEvent | TuiMouseEvent;
const decoder = new TextDecoder();
/** Terminal box container: flexbox layout, padding, margins, and borders. */
export function Box(props: BoxProps): VNode {
  return h('box', props);
}
/** Terminal text node with styled runs, wrapping, and caret reporting. */
export function Text(props: TextProps): VNode {
  return h('text', props);
}
/** Flexible or fixed empty space inside a `Box`. */
export function Spacer(props: SpacerProps): VNode {
  return h('spacer', props);
}
/** Single-line text input primitive for terminal forms. */
export function Input(props: InputProps): VNode {
  return h('input', props);
}
/** Push button primitive rendered as bracketed terminal text. */
export function Button(props: ButtonProps): VNode {
  return h('button', props);
}
/** Vertical list primitive with a selected row marker. */
export function List(props: ListProps): VNode {
  return h('list', props);
}
/** Clipped viewport over child content. */
export function ScrollView(props: ScrollViewProps): VNode {
  return h('scrollview', props);
}
/** Content painted above the normal flow, anchored or centered. */
export function Layer(props: LayerProps): VNode {
  return h('layer', props);
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
/**
 * Decode one terminal input byte chunk into TUI input events.
 *
 * The decoder understands printable UTF-8, common control keys, arrow/function
 * CSI sequences, and SGR mouse reporting (`CSI < code ; x ; y M/m`). SGR mouse
 * coordinates are converted to zero-based `x`/`y` values.
 */
export function decodeTuiInput(bytes: Uint8Array): TuiEvent[] {
  const text = decoder.decode(bytes);
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
  return events;
}
/** Options for creating a raw terminal input reader. */
export interface TuiInputOptions {
  mouse?: boolean;
}
/** Raw terminal input reader for keyboard and mouse events. */
export class TuiInput {
  #restoreRaw: (() => void) | null;
  #closed = false;
  #queue: TuiEvent[] = [];
  constructor(options: TuiInputOptions = {}) {
    this.#restoreRaw = enterRawMode(0);
    void writeStdout(options.mouse === false ? '' : enterMouseMode());
  }
  /** Read the next decoded keyboard or mouse event from stdin. */
  async read(): Promise<TuiEvent | null> {
    while (!this.#closed) {
      const queued = this.#queue.shift();
      if (queued) return queued;
      const bytes = await stdin().read();
      if (bytes === null) return null;
      this.#queue.push(...decodeTuiInput(bytes));
    }
    return null;
  }
  /** Restore raw mode and mouse reporting. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void writeStdout(exitMouseMode());
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
      const chunk = await stdin().read({
        maxBytes: 64,
        signal: controller.signal,
      });
      if (chunk === null) break;
      response += decoder.decode(chunk);
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
  return layout(element, {
    width: Math.max(0, Math.floor(options.width)),
    height: Math.max(0, Math.floor(options.height)),
  });
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
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  return {
    commit(tree: VNode): Frame {
      renderer.render(tree, root);
      const node = root.children[0];
      if (!node) {
        return {
          width: options.width,
          height: options.height,
          rows: [],
          cursor: null,
          hits: [],
        };
      }
      return layout(node, {
        width: Math.max(0, Math.floor(options.width)),
        height: Math.max(0, Math.floor(options.height)),
      });
    },
  };
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
  const width = options.width ?? size.width;
  const height = options.height ?? size.height;
  const input =
    options.input || options.onEvent ? createTuiInput({ mouse: options.mouse ?? true }) : undefined;
  const hostRoot = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  let lastFrame: Frame | null = null;
  let cursorShown = false;
  void writeStdout(enterAlternateScreen() + hideCursor() + disableAutoWrap() + '\x1B[2J');
  const sink: Sink<Frame> = {
    commit(tree: VNode): Frame {
      renderer.render(tree, hostRoot);
      const node = hostRoot.children[0];
      const frame = node
        ? layout(node, { width, height })
        : { width, height, rows: [], cursor: null, hits: [] };
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
  let root: Root<Frame> | null = null;
  if (typeof element === 'function') root = createRoot(element, sink);
  else sink.commit(element);
  const app: TuiApp = {
    input,
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
      root?.dispose();
      root = null;
      stopped = true;
      input?.close();
      void writeStdout(enableAutoWrap() + showCursor() + exitMouseMode() + exitAlternateScreen());
    },
  };
  if (input && options.onEvent) {
    void (async () => {
      while (!stopped) {
        const event = await input.read();
        if (event === null) break;
        await options.onEvent?.(event, app);
      }
    })();
  }
  return app;
}
