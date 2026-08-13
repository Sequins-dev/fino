/**
 * fino:tty/tui — terminal host renderer for `fino:ui` components.
 *
 * This module is the first host for the portable `fino:ui` core. It provides
 * terminal component primitives, deterministic frame rendering for tests, and a
 * small fullscreen live renderer. The layout engine is intentionally a Fino
 * subset: row/column direction, fixed sizes, flex spacers, gap, padding,
 * borders, simple alignment, wrapping, and clipping.
 *
 * V1 is terminal-only and POSIX-oriented. It includes raw keyboard input and
 * SGR mouse events for fullscreen apps, but it does not implement DOM/HTML
 * output, React hooks, or inline terminal regions.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { Box, Text, renderFrame } from 'fino:tty/tui';
 *
 * const frame = renderFrame(
 *   <Box border padding={1}><Text>Hello</Text></Box>,
 *   { width: 20, height: 3 },
 * );
 * ```
 */
import {
  h,
  Fragment,
  createRoot,
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
  onResize,
  setClipboard,
  showCursor,
  queryTerminalSize,
} from '../internal/tty/bindings.ts';
export { h, Fragment, createSignal, batch };
type Direction = 'row' | 'column';
type Align = 'start' | 'center' | 'end';
type TuiKind = 'box' | 'text' | 'spacer' | 'input' | 'button' | 'list' | 'scrollview';
type BackgroundColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack';
interface InternalNode extends VNode {
  type: TuiKind;
}
/** Props accepted by `Box`. */
export interface BoxProps extends Props {
  width?: number;
  height?: number;
  flex?: number;
  direction?: Direction;
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  border?: boolean;
  align?: Align;
  background?: BackgroundColor;
  children?: Child;
}
/** Props accepted by `Text`. */
export interface TextProps extends Props {
  wrap?: boolean;
  align?: Align;
  background?: BackgroundColor;
  children?: Child;
}
/** Props accepted by `Spacer`. */
export interface SpacerProps extends Props {
  width?: number;
  height?: number;
  flex?: number;
}
/** Props accepted by `Input`. */
export interface InputProps extends Props {
  value?: string;
  placeholder?: string;
  focused?: boolean;
  background?: BackgroundColor;
}
/** Props accepted by `Button`. */
export interface ButtonProps extends Props {
  label?: string;
  focused?: boolean;
}
/** Props accepted by `List`. */
export interface ListProps extends Props {
  items: string[];
  selectedIndex?: number;
}
/** Props accepted by `ScrollView`. */
export interface ScrollViewProps extends Props {
  width?: number;
  height?: number;
  offset?: number;
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
  /**
   * Report mouse motion without a held button so the app can render hover
   * affordances. Off by default; motion events are frequent.
   */
  motion?: boolean;
  onEvent?: (event: TuiEvent, app: TuiApp) => void | Promise<void>;
  /**
   * Called after the terminal is resized and the app has repainted at the
   * new size. Only fires when neither `width` nor `height` was fixed in the
   * options — explicit sizes opt out of live resizing. Use it to re-layout
   * application state that depends on the viewport.
   */
  onResize?: (size: TerminalSize, app: TuiApp) => void;
}
/** Handle returned by `render()` for updating or stopping a fullscreen app. */
export interface TuiApp {
  update(element: VNode): void;
  stop(): void;
  input?: TuiInput;
  /** Current viewport size; tracks live terminal resizes. */
  size(): TerminalSize;
  /**
   * Turn mouse capture on or off while the app runs.
   *
   * Capturing the mouse suppresses the terminal's own text selection, so
   * apps that want the user to select and copy content should expose a way
   * to release it. Returns the resulting state; `false` when the app was
   * created without mouse input at all.
   */
  setMouse(enabled: boolean): boolean;
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
/** Terminal box container with row/column layout, padding, gap, and borders. */
export function Box(props: BoxProps): VNode {
  return h('box', props) as InternalNode;
}
/** Terminal text node with optional wrapping. */
export function Text(props: TextProps): VNode {
  return h('text', props) as InternalNode;
}
/** Flexible or fixed empty space inside a `Box`. */
export function Spacer(props: SpacerProps): VNode {
  return h('spacer', props) as InternalNode;
}
/** Single-line text input primitive for terminal forms. */
export function Input(props: InputProps): VNode {
  return h('input', props) as InternalNode;
}
/** Push button primitive rendered as bracketed terminal text. */
export function Button(props: ButtonProps): VNode {
  return h('button', props) as InternalNode;
}
/** Vertical list primitive with a selected row marker. */
export function List(props: ListProps): VNode {
  return h('list', props) as InternalNode;
}
/** Clipped viewport over child content. */
export function ScrollView(props: ScrollViewProps): VNode {
  return h('scrollview', props) as InternalNode;
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
  const modified = /^\x1b\[1;(\d+)([ABCDHF])$/.exec(sequence);
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
    const bits = Number(modified[1]) - 1;
    return keyEvent(name, {
      ...(bits & 1 ? { shift: true } : {}),
      ...(bits & 2 ? { alt: true } : {}),
      ...(bits & 4 ? { ctrl: true } : {}),
    });
  }
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
            : 'none';
    // Button bits 3 with the motion bit set is pointer movement with nothing
    // held (mode 1003 hover); without the motion bit it is a plain release.
    const action = wheel
      ? 'wheel'
      : releaseMarker
        ? 'release'
        : drag
          ? base === 3
            ? 'move'
            : 'drag'
          : base === 3
            ? 'release'
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
      const csi = sgr ?? /^\x1b\[(?:\d+~|\d+;\d+[A-Za-z~]|[A-Za-z])/.exec(text.slice(i));
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
  /**
   * Report mouse motion even when no button is held, so applications can
   * implement hover affordances. Costs one input event per cell crossed.
   */
  motion?: boolean;
}
/** Raw terminal input reader for keyboard and mouse events. */
export class TuiInput {
  #restoreRaw: (() => void) | null;
  #closed = false;
  #queue: TuiEvent[] = [];
  #mouse: boolean;
  #motion: boolean;
  constructor(options: TuiInputOptions = {}) {
    this.#restoreRaw = enterRawMode(0);
    this.#mouse = options.mouse !== false;
    this.#motion = options.motion === true;
    if (this.#mouse) void writeStdout(enterMouseMode({ motion: this.#motion }));
  }
  /** Whether mouse reporting is currently captured by the application. */
  get mouse(): boolean {
    return this.#mouse;
  }
  /**
   * Turn mouse reporting on or off while the app runs.
   *
   * While reporting is on, the terminal routes clicks and drags to the
   * application, which suppresses the terminal's own text selection. Turning
   * it off hands the mouse back to the terminal so the user can select and
   * copy text, at the cost of in-app mouse interaction.
   */
  setMouse(enabled: boolean): void {
    if (this.#closed || enabled === this.#mouse) return;
    this.#mouse = enabled;
    void writeStdout(enabled ? enterMouseMode({ motion: this.#motion }) : exitMouseMode());
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
function numberProp(props: Props, name: string, fallback: number): number {
  const value = props[name];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}
function stringProp(props: Props, name: string, fallback: string): string {
  const value = props[name];
  return typeof value === 'string' ? value : fallback;
}
function boolProp(props: Props, name: string, fallback: boolean): boolean {
  const value = props[name];
  return typeof value === 'boolean' ? value : fallback;
}
function spaces(width: number): string {
  return ' '.repeat(Math.max(0, width));
}
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text);
}
function visibleLength(text: string): number {
  return Array.from(text.replace(ANSI_RE, '')).length;
}
function fit(text: string, width: number): string {
  const chars = Array.from(text);
  return chars.slice(0, width).join('').padEnd(width, ' ');
}
function fitAnsi(text: string, width: number): string {
  if (!hasAnsi(text)) return fit(text, width);
  // Clip by visible width, preserving escape sequences, and always close with
  // a reset: a styled line truncated mid-run must never leak its SGR state
  // into the rows painted after it.
  let out = '';
  let seen = 0;
  let index = 0;
  while (index < text.length && seen < width) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(text);
    if (match && match.index === index) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(index)!);
    out += ch;
    seen += 1;
    index += ch.length;
  }
  return out + '\x1b[0m' + spaces(width - seen);
}
function backgroundCode(background: unknown): string | null {
  switch (background) {
    case 'black':
      return '40';
    case 'red':
      return '41';
    case 'green':
      return '42';
    case 'yellow':
      return '43';
    case 'blue':
      return '44';
    case 'magenta':
      return '45';
    case 'cyan':
      return '46';
    case 'white':
      return '47';
    case 'brightBlack':
      return '100';
    default:
      return null;
  }
}
function styleLine(line: string, props: Props): string {
  const bg = backgroundCode(props.background);
  return bg === null ? line : `\x1b[${bg}m${line}\x1b[0m`;
}
function blank(width: number, height: number): string[] {
  return Array.from({ length: Math.max(0, height) }, () => spaces(width));
}
function overlay(base: string[], lines: string[], x: number, y: number): void {
  for (let row = 0; row < lines.length; row++) {
    const target = y + row;
    if (target < 0 || target >= base.length) continue;
    const line = base[target] ?? '';
    const source = lines[row] ?? '';
    const width = line.length;
    if (x >= width) continue;
    const left = line.slice(0, Math.max(0, x));
    const middle = hasAnsi(source)
      ? fitAnsi(source, Math.max(0, width - x))
      : source.slice(0, Math.max(0, width - x));
    const middleWidth = hasAnsi(middle) ? visibleLength(middle) : middle.length;
    const right = line.slice(Math.min(width, x + middleWidth));
    base[target] = left + middle + right;
  }
}
function textContent(node: VNode): string {
  let out = '';
  for (const child of node.children) {
    out += typeof child === 'string' ? child : textContent(child);
  }
  return out;
}
function wrapText(text: string, width: number, wrap: boolean): string[] {
  if (width <= 0) return [];
  if (!wrap) return [hasAnsi(text) ? fitAnsi(text, width) : fit(text, width)];
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) {
    lines.push(fit(chars.slice(index, index + width).join(''), width));
  }
  return lines.length === 0 ? [spaces(width)] : lines;
}
function intrinsicWidth(child: VNode | string): number {
  if (typeof child === 'string') return Array.from(child).length;
  const explicit = child.props.width;
  if (typeof explicit === 'number') return Math.max(0, Math.floor(explicit));
  switch (child.type) {
    case 'text':
      return Math.max(1, Array.from(textContent(child)).length);
    case 'spacer':
      return numberProp(child.props, 'width', 0);
    case 'input':
      return Math.max(
        1,
        Array.from(stringProp(child.props, 'value', stringProp(child.props, 'placeholder', '')))
          .length + 2,
      );
    case 'button':
      return Array.from(stringProp(child.props, 'label', '')).length + 4;
    case 'list': {
      const items = Array.isArray(child.props.items) ? (child.props.items as string[]) : [];
      return items.reduce((max, item) => Math.max(max, Array.from(item).length + 2), 0);
    }
    default:
      return 0;
  }
}
function intrinsicHeight(child: VNode | string): number {
  if (typeof child === 'string') return 1;
  const explicit = child.props.height;
  if (typeof explicit === 'number') return Math.max(0, Math.floor(explicit));
  switch (child.type) {
    case 'list':
      return Array.isArray(child.props.items) ? (child.props.items as string[]).length : 0;
    case 'scrollview':
      return numberProp(child.props, 'height', 1);
    default:
      return 1;
  }
}
function renderTextNode(node: VNode, width: number, height: number): string[] {
  const lines = wrapText(textContent(node), width, boolProp(node.props, 'wrap', false));
  return blank(width, height).map((line, index) => styleLine(lines[index] ?? line, node.props));
}
function renderList(node: VNode, width: number, height: number): string[] {
  const items = Array.isArray(node.props.items) ? (node.props.items as string[]) : [];
  const selectedIndex = numberProp(node.props, 'selectedIndex', 0);
  return blank(width, height).map((line, index) => {
    const item = items[index];
    if (item === undefined) return line;
    const prefix = index === selectedIndex ? '> ' : '  ';
    return fit(prefix + item, width);
  });
}
function renderLeaf(node: VNode, width: number, height: number): string[] {
  switch (node.type) {
    case 'text':
      return renderTextNode(node, width, height);
    case 'spacer':
      return blank(width, height);
    case 'input': {
      const value = stringProp(node.props, 'value', stringProp(node.props, 'placeholder', ''));
      return [
        styleLine(
          fit((boolProp(node.props, 'focused', false) ? '> ' : '  ') + value, width),
          node.props,
        ),
        ...blank(width, height - 1),
      ];
    }
    case 'button': {
      const label = stringProp(node.props, 'label', textContent(node));
      const prefix = boolProp(node.props, 'focused', false) ? '> ' : '';
      return [fit(`${prefix}[ ${label} ]`, width), ...blank(width, height - 1)];
    }
    case 'list':
      return renderList(node, width, height);
    default:
      return renderBox(node, width, height);
  }
}
function renderColumn(
  children: (VNode | string)[],
  width: number,
  height: number,
  gap: number,
): string[] {
  const out = blank(width, height);
  let y = 0;
  for (const child of children) {
    if (y >= height) break;
    const childHeight = Math.min(
      height - y,
      typeof child !== 'string' && child.type === 'text' && boolProp(child.props, 'wrap', false)
        ? height - y
        : intrinsicHeight(child),
    );
    const lines =
      typeof child === 'string' ? [fit(child, width)] : renderElement(child, width, childHeight);
    overlay(out, lines, 0, y);
    y += childHeight + gap;
  }
  return out;
}
function renderRow(
  children: (VNode | string)[],
  width: number,
  height: number,
  gap: number,
): string[] {
  const out = blank(width, height);
  const gaps = Math.max(0, children.length - 1) * gap;
  let fixed = 0;
  let flex = 0;
  for (const child of children) {
    if (typeof child !== 'string' && child.type === 'spacer') {
      flex += numberProp(child.props, 'flex', 0);
      fixed += numberProp(child.props, 'width', 0);
    } else {
      fixed += intrinsicWidth(child);
    }
  }
  let remaining = Math.max(0, width - fixed - gaps);
  let x = 0;
  for (const child of children) {
    if (x >= width) break;
    let childWidth = intrinsicWidth(child);
    if (typeof child !== 'string' && child.type === 'spacer') {
      const weight = numberProp(child.props, 'flex', 0);
      const share = flex > 0 ? Math.floor((remaining * weight) / flex) : 0;
      childWidth += share;
      remaining -= share;
      flex -= weight;
    }
    childWidth = Math.min(childWidth, width - x);
    const lines =
      typeof child === 'string'
        ? [fit(child, childWidth)]
        : renderElement(child, childWidth, height);
    overlay(out, lines, x, 0);
    x += childWidth + gap;
  }
  return out;
}
function renderBox(node: VNode, width: number, height: number): string[] {
  const border = boolProp(node.props, 'border', false);
  const padding = numberProp(node.props, 'padding', 0);
  const paddingX = numberProp(node.props, 'paddingX', padding);
  const paddingY = numberProp(node.props, 'paddingY', padding);
  const gap = numberProp(node.props, 'gap', 0);
  const direction = stringProp(node.props, 'direction', 'column') === 'row' ? 'row' : 'column';
  const out = blank(width, height);
  if (width <= 0 || height <= 0) return out;
  if (border && width >= 2 && height >= 2) {
    out[0] = '+' + '-'.repeat(Math.max(0, width - 2)) + '+';
    for (let row = 1; row < height - 1; row++) out[row] = '|' + spaces(width - 2) + '|';
    out[height - 1] = '+' + '-'.repeat(Math.max(0, width - 2)) + '+';
  }
  const insetX = (border ? 1 : 0) + paddingX;
  const insetY = (border ? 1 : 0) + paddingY;
  const contentWidth = Math.max(0, width - insetX * 2);
  const contentHeight = Math.max(0, height - insetY * 2);
  const children = node.children as (VNode | string)[];
  const content =
    direction === 'row'
      ? renderRow(children, contentWidth, contentHeight, gap)
      : renderColumn(children, contentWidth, contentHeight, gap);
  overlay(out, content, insetX, insetY);
  return out.map((line) => styleLine(line, node.props));
}
function renderElement(node: VNode, width: number, height: number): string[] {
  if (node.type === 'box') return renderBox(node, width, height);
  if (node.type === 'scrollview') {
    const offset = numberProp(node.props, 'offset', 0);
    const inner = renderColumn(
      node.children as (VNode | string)[],
      width,
      Math.max(height + offset, height),
      0,
    );
    return blank(width, height).map((line, index) => inner[index + offset] ?? line);
  }
  return renderLeaf(node, width, height);
}
/**
 * Render an element tree to a deterministic terminal frame.
 *
 * The returned string contains exactly `height` lines joined with `\n`, and
 * each line is padded or clipped to `width` cells.
 */
/** A point in the terminal grid, in zero-based cell coordinates. */
export interface SelectionPoint {
  x: number;
  y: number;
}
/**
 * A text selection over rendered frame rows.
 *
 * `anchor` is where the drag started and `focus` where it currently is;
 * either may come first on screen, so consumers should normalize with
 * `normalizeSelection()` rather than assuming an order.
 */
export interface Selection {
  anchor: SelectionPoint;
  focus: SelectionPoint;
}
/**
 * Order a selection's endpoints top-to-bottom, left-to-right.
 *
 * Returns the pair as `{ start, end }` so rendering and extraction can walk
 * forward regardless of which direction the user dragged.
 *
 * ```ts no_run
 * import { normalizeSelection } from 'fino:tty/tui';
 *
 * normalizeSelection({ anchor: { x: 8, y: 4 }, focus: { x: 2, y: 1 } });
 * // { start: { x: 2, y: 1 }, end: { x: 8, y: 4 } }
 * ```
 */
export function normalizeSelection(selection: Selection): {
  start: SelectionPoint;
  end: SelectionPoint;
} {
  const { anchor, focus } = selection;
  const forward = focus.y > anchor.y || (focus.y === anchor.y && focus.x >= anchor.x);
  return forward ? { start: anchor, end: focus } : { start: focus, end: anchor };
}
/** Whether a selection covers at least one cell. */
export function selectionIsEmpty(selection: Selection): boolean {
  return selection.anchor.x === selection.focus.x && selection.anchor.y === selection.focus.y;
}
function visibleCells(line: string): string[] {
  const cells: string[] = [];
  let index = 0;
  while (index < line.length) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(line);
    if (match && match.index === index) {
      index += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(index)!);
    cells.push(ch);
    index += ch.length;
  }
  return cells;
}
function selectionSpan(
  row: number,
  start: SelectionPoint,
  end: SelectionPoint,
  width: number,
): { from: number; to: number } | null {
  if (row < start.y || row > end.y) return null;
  const from = row === start.y ? start.x : 0;
  const to = row === end.y ? end.x : width;
  return to <= from ? null : { from, to };
}
/**
 * Extract the plain text covered by a selection from rendered frame rows.
 *
 * Styling is stripped and trailing padding on each row is trimmed, so the
 * result is what the user visually selected rather than the frame's
 * fixed-width cells. Rows are joined with newlines.
 *
 * ```ts no_run
 * import { selectionText } from 'fino:tty/tui';
 *
 * const copied = selectionText(frame.split('\n'), selection);
 * ```
 */
export function selectionText(lines: string[], selection: Selection): string {
  const { start, end } = normalizeSelection(selection);
  const out: string[] = [];
  for (let row = start.y; row <= end.y; row++) {
    const line = lines[row];
    if (line === undefined) continue;
    const cells = visibleCells(line);
    const span = selectionSpan(row, start, end, cells.length);
    if (!span) continue;
    out.push(cells.slice(span.from, span.to).join('').replace(/\s+$/, ''));
  }
  return out.join('\n');
}
/**
 * Overlay a selection highlight onto rendered frame rows.
 *
 * Selected cells are re-emitted inverted, with the surrounding styling of the
 * row preserved on either side. Rows outside the selection are returned
 * unchanged, so this is safe to apply to a whole frame every paint.
 *
 * ```ts no_run
 * import { highlightSelection } from 'fino:tty/tui';
 *
 * const painted = highlightSelection(rows, selection);
 * ```
 */
export function highlightSelection(lines: string[], selection: Selection): string[] {
  if (selectionIsEmpty(selection)) return lines;
  const { start, end } = normalizeSelection(selection);
  return lines.map((line, row) => {
    const cells = visibleCells(line);
    const span = selectionSpan(row, start, end, cells.length);
    if (!span) return line;
    const before = cells.slice(0, span.from).join('');
    const selected = cells.slice(span.from, span.to).join('');
    const after = cells.slice(span.to).join('');
    // Rebuilding from visible cells drops the row's own styling inside the
    // selection, which is the point: the highlight must read uniformly.
    return `${before}\x1b[7m${selected}\x1b[0m${after}`;
  });
}
/**
 * Return the terminal sequence that copies `text` to the system clipboard.
 *
 * Uses OSC 52, so the terminal emulator performs the copy and it works over
 * SSH and inside multiplexers. Write the result to stdout.
 *
 * ```ts no_run
 * import { writeStdout } from 'fino:tty';
 * import { copyToClipboard } from 'fino:tty/tui';
 *
 * await writeStdout(copyToClipboard(selected));
 * ```
 */
export function copyToClipboard(text: string): string {
  return setClipboard(text);
}
export function renderFrame(element: VNode, options: RenderFrameOptions): string {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  return renderElement(element, width, height)
    .slice(0, height)
    .map((line) => fitAnsi(line, width))
    .join('\n');
}
function renderScreen(element: VNode, options: RenderFrameOptions): string {
  const lines = renderFrame(element, options).split('\n');
  let out = '';
  for (let row = 0; row < lines.length; row++) {
    out += `\x1b[${row + 1};1H${lines[row]}`;
  }
  return out;
}
/**
 * Sink that turns each committed tree into a terminal frame.
 *
 * The frame is a complete screen image rather than a diff, so this is a snapshot
 * sink like `htmlSink()`. Pair it with `renderStatic()` to capture one frame, or
 * with `createRoot()` to drive a live screen from signals.
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
 * Render a fullscreen terminal app and return a lifecycle handle.
 *
 * This enters the alternate screen, hides the cursor, writes the current frame,
 * and restores terminal state from `stop()`. Width and height default to the
 * current terminal size when available, and auto-measured apps track live
 * terminal resizes: on `SIGWINCH` the screen clears and repaints at the new
 * size, `options.onResize` fires so the app can re-layout its own state, and
 * `app.size()` reports the current viewport. Passing explicit `width`/`height`
 * fixes the viewport and disables resize tracking.
 *
 * Passing a function instead of a tree makes the app reactive: every signal read
 * while rendering becomes a dependency, and the screen repaints when one
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
  const input =
    options.input || options.onEvent
      ? createTuiInput({ mouse: options.mouse ?? true, motion: options.motion ?? false })
      : undefined;
  let frame = '';
  let lastTree: VNode | null = null;
  let commitCount = 0;
  function paint(): void {
    if (stopped) return;
    const lines = frame.split('\n');
    let out = '';
    for (let row = 0; row < lines.length; row++) out += `\x1b[${row + 1};1H${lines[row]}`;
    void writeStdout(out);
  }
  void writeStdout(enterAlternateScreen() + hideCursor() + disableAutoWrap() + '\x1B[2J');
  const sink: Sink<string> = {
    commit(tree: VNode): string {
      lastTree = tree;
      commitCount += 1;
      frame = renderFrame(tree, { width, height });
      paint();
      return frame;
    },
  };
  // A tree renders once; a thunk keeps its signal dependencies live. Both go
  // through the same sink, so the paint path does not fork.
  let root: Root<string> | null = null;
  if (typeof element === 'function') root = createRoot(element, sink);
  else sink.commit(element);
  // Explicit width/height fix the viewport (deterministic tests, embedding);
  // auto-measured apps track SIGWINCH and repaint at the new size.
  let stopResize: (() => void) | undefined;
  const app: TuiApp = {
    input,
    update(next: VNode): void {
      root?.dispose();
      root = null;
      sink.commit(next);
    },
    size(): TerminalSize {
      return { width, height };
    },
    setMouse(enabled: boolean): boolean {
      input?.setMouse(enabled);
      return input?.mouse ?? false;
    },
    stop(): void {
      if (stopped) return;
      stopResize?.();
      root?.dispose();
      root = null;
      stopped = true;
      input?.close();
      void writeStdout(enableAutoWrap() + showCursor() + exitMouseMode() + exitAlternateScreen());
    },
  };
  if (options.width === undefined && options.height === undefined) {
    const applyResize = (next: TerminalSize): void => {
      if (stopped || (next.width === width && next.height === height)) return;
      width = next.width;
      height = next.height;
      void writeStdout('\x1B[2J');
      if (root) {
        root.dispose();
        root = createRoot(element as () => VNode, sink);
        options.onResize?.({ width, height }, app);
        return;
      }
      // Let the app re-layout first; only repaint the stale tree when the
      // resize callback did not already commit a fresh one.
      const before = commitCount;
      options.onResize?.({ width, height }, app);
      if (commitCount === before && lastTree) sink.commit(lastTree);
    };
    let first = true;
    const disposeSignal = onResize((next) => {
      if (first) {
        first = false;
        return;
      }
      applyResize(next);
    });
    // SIGWINCH delivery can be unreliable depending on the host; a cheap
    // ioctl poll guarantees the viewport eventually converges.
    const pollTimer = setInterval(() => applyResize(queryTerminalSize()), 750);
    stopResize = () => {
      clearInterval(pollTimer);
      disposeSignal();
    };
  }
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
