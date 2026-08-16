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
import { stdin, signal as processSignal } from '../process.ts';
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
import { layout as layoutPrimitives, measure as measurePrimitives } from 'internal:tty/layout';
import type {
  BorderStyle,
  Constraints,
  LayoutNode,
  Measured,
  WrapMode,
} from 'internal:tty/layout';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { TuiDispatcher } from 'internal:tty/events';
import { lowerTui } from 'internal:tty/lower';
import { frameToAnsi, frameToScreen } from 'fino:tty/frame';
import type { Frame } from 'fino:tty/frame';
import type { Color } from 'fino:tty/style';
export { h, Fragment, createSignal, batch };
export type { BorderStyle, Constraints, Measured, WrapMode };

/**
 * Measure a tree against constraints.
 *
 * Components are lowered for the terminal first, so a caller measures what the
 * terminal will actually paint rather than the semantic tree that describes it.
 * An already-lowered tree passes through untouched.
 */
export function measure(node: VNode | LayoutNode | string, constraints: Constraints): Measured {
  return measurePrimitives(
    typeof node === 'string' ? node : lowerTui(node as VNode),
    constraints,
  );
}

/**
 * Lay a tree out into a frame, lowering it for the terminal first.
 */
export function layout(node: VNode | LayoutNode, constraints: Constraints): Frame {
  return layoutPrimitives(lowerTui(node as VNode), constraints);
}
/**
 * The host-neutral primitives are defined by `fino:ui/components`; this
 * module re-exports them so terminal apps import one place, and implements
 * their terminal behavior in the layout engine and dispatcher.
 */
export {
  Box,
  Text,
  Spacer,
  Input,
  Layer,
  Clickable,
  Scroll,
  Scroll as ScrollView,
  Rule,
} from 'fino:ui/components';
export type {
  StyleProps,
  FlexChildProps,
  BoxProps,
  TextProps,
  SpacerProps,
  InputProps,
  LayerProps,
  ClickableProps,
  ScrollProps,
  ScrollProps as ScrollViewProps,
  RuleProps,
} from 'fino:ui/components';
/** Props accepted by `Button`. */
export interface ButtonProps extends Props {
  label?: string;
  focused?: boolean;
  background?: Color;
}
/** Props accepted by `List`. */
export interface ListProps extends Props {
  items: string[];
  selectedIndex?: number;
}
/** Focus control surface exposed by a live TUI app. */
export interface TuiFocus {
  /** Signal carrying the focused node's `id`, for components to render focus. */
  readonly focusedId: { get(): string | null };
  next(): boolean;
  prev(): boolean;
  focus(id: string): boolean;
  blur(): void;
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
  /** Focus traversal and state for the retained tree. */
  focus: TuiFocus;
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
/** Push button primitive rendered as bracketed terminal text. */
export function Button(props: ButtonProps): VNode {
  return h('button', props);
}
/** Vertical list primitive with a selected row marker. */
export function List(props: ListProps): VNode {
  return h('list', props);
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
  const modified = /^\x1b\[1;(\d+)([A-DHF])$/.exec(sequence);
  if (modified) {
    const name = (
      {
        A: 'up',
        B: 'down',
        C: 'right',
        D: 'left',
        H: 'home',
        F: 'end',
      } as Record<string, string>
    )[modified[2]!]!;
    return keyEvent(name, modifierBits(Number(modified[1])));
  }
  const tilde = /^\x1b\[(\d+)(?:;(\d+))?~$/.exec(sequence);
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
    if (name) {
      return keyEvent(name, tilde[2] !== undefined ? modifierBits(Number(tilde[2])) : {});
    }
  }
  return null;
}
// xterm modifier parameter: value - 1 is a bitfield of 1=shift, 2=alt, 4=ctrl.
function modifierBits(parameter: number): Partial<TuiKeyEvent> {
  const bits = parameter - 1;
  const extra: Partial<TuiKeyEvent> = {};
  if (bits & 1) extra.shift = true;
  if (bits & 2) extra.alt = true;
  if (bits & 4) extra.ctrl = true;
  return extra;
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
      const csi = sgr ?? /^\x1b\[(?:\d+(?:;\d+)?~|(?:\d+;\d+)?[A-Za-z])/.exec(text.slice(i));
      if (csi) {
        const event = decodeCsi(csi[0]);
        if (event) events.push(event);
        i += csi[0].length;
        continue;
      }
      if (i + 1 < text.length) {
        const following = text.charCodeAt(i + 1);
        // macOS Terminal sends ESC+DEL for option-delete.
        if (following === 127 || following === 8) {
          events.push(keyEvent('backspace', { alt: true }));
        } else {
          events.push(keyEvent(text[i + 1]!, { alt: true }));
        }
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
 * Copy `text` to the system clipboard via an OSC 52 clipboard-set request —
 * the terminal-native mechanism most modern emulators honor (iTerm2, kitty,
 * WezTerm, tmux with `set-clipboard on`, …). Fire-and-forget: the terminal
 * applies it silently, with no confirmation reported back to the app, and
 * emulators that don't support OSC 52 simply ignore the sequence.
 *
 * ```ts no_run
 * import { copyToClipboard } from 'fino:tty/tui';
 * copyToClipboard('kubectl get pods -A');
 * ```
 */
export function copyToClipboard(text: string): void {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  void writeStdout(`\x1b]52;c;${btoa(binary)}\x07`);
}
/**
 * Lay a tree out into a styled-cell frame without touching a terminal.
 *
 * This is the one-shot path: the tree is laid out fresh with no retained
 * state. Pass the result to `frameToAnsi()`/`frameToScreen()` from
 * `fino:tty/frame`, or use `renderFrame()` for the padded-string form.
 */
export function layoutFrame(element: VNode, options: RenderFrameOptions): Frame {
  return layoutPrimitives(lowerTui(element), {
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
      renderer.render(lowerTui(tree), root);
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
      return layoutPrimitives(node, {
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
  let width = options.width ?? size.width;
  let height = options.height ?? size.height;
  let lastTree: VNode | null = null;
  const input =
    options.input || options.onEvent ? createTuiInput({ mouse: options.mouse ?? true }) : undefined;
  const hostRoot = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(hostRoot);
  let lastFrame: Frame | null = null;
  let cursorShown = false;
  void writeStdout(enterAlternateScreen() + hideCursor() + disableAutoWrap() + '\x1B[2J');
  const sink: Sink<Frame> = {
    commit(tree: VNode): Frame {
      lastTree = tree;
      renderer.render(lowerTui(tree), hostRoot);
      const node = hostRoot.children[0];
      const frame = node
        ? layoutPrimitives(node, { width, height })
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
  // The viewport tracks the terminal unless the caller pinned a size.
  const winch =
    options.width !== undefined && options.height !== undefined
      ? null
      : processSignal('SIGWINCH').subscribe(() => {
          if (stopped) return;
          const next = queryTerminalSize();
          const nextWidth = options.width ?? next.width;
          const nextHeight = options.height ?? next.height;
          if (nextWidth === width && nextHeight === height) return;
          width = nextWidth;
          height = nextHeight;
          lastFrame = null;
          void writeStdout('\x1B[2J');
          if (lastTree) sink.commit(lastTree);
        });
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
      winch?.dispose();
      root?.dispose();
      root = null;
      stopped = true;
      input?.close();
      void writeStdout(enableAutoWrap() + showCursor() + exitMouseMode() + exitAlternateScreen());
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
