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

import { h, Fragment, createSignal, batch, type Child, type Props, type VNode } from 'fino:ui';
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

export { h, Fragment, createSignal, batch };

type Direction = 'row' | 'column';
type Align = 'start' | 'center' | 'end';
type TuiKind = 'box' | 'text' | 'spacer' | 'input' | 'button' | 'list' | 'scrollview';
type BackgroundColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'brightBlack';

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
  onEvent?: (event: TuiEvent, app: TuiApp) => void | Promise<void>;
}

/** Handle returned by `render()` for updating or stopping a fullscreen app. */
export interface TuiApp {
  update(element: VNode): void;
  stop(): void;
  input?: TuiInput;
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
  return { type: 'key', key, ...extra };
}

function decodeCsi(sequence: string): TuiEvent | null {
  if (sequence === '\x1b[A') return keyEvent('up');
  if (sequence === '\x1b[B') return keyEvent('down');
  if (sequence === '\x1b[C') return keyEvent('right');
  if (sequence === '\x1b[D') return keyEvent('left');
  if (sequence === '\x1b[H') return keyEvent('home');
  if (sequence === '\x1b[F') return keyEvent('end');
  if (sequence === '\x1b[Z') return keyEvent('tab', { shift: true });

  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (sgr) {
    const code = Number(sgr[1]);
    const x = Math.max(0, Number(sgr[2]) - 1);
    const y = Math.max(0, Number(sgr[3]) - 1);
    const releaseMarker = sgr[4] === 'm';
    const base = code & 0b11;
    const shift = (code & 4) !== 0;
    const alt = (code & 8) !== 0;
    const ctrl = (code & 16) !== 0;
    const drag = (code & 32) !== 0;
    const wheel = (code & 64) !== 0;
    const button = wheel
      ? ((code & 1) === 0 ? 'wheel-up' : 'wheel-down')
      : base === 0 ? 'left' : base === 1 ? 'middle' : base === 2 ? 'right' : 'left';
    const action = wheel ? 'wheel' : releaseMarker || base === 3 ? 'release' : drag ? 'drag' : 'press';
    return { type: 'mouse', action, button, x, y, ctrl, alt, shift };
  }

  const tilde = /^\x1b\[(\d+)~$/.exec(sequence);
  if (tilde) {
    const name = ({ '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown' } as Record<string, string>)[tilde[1]!];
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
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (ch === '\x1b') {
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
    if (code === 0x03) events.push(keyEvent('c', { ctrl: true }));
    else if (code === 0x04) events.push(keyEvent('d', { ctrl: true }));
    else if (code === 0x7f || code === 0x08) events.push(keyEvent('backspace'));
    else if (code === 0x0d || code === 0x0a) events.push(keyEvent('enter'));
    else if (code === 0x09) events.push(keyEvent('tab'));
    else if (code >= 0x01 && code <= 0x1a) events.push(keyEvent(String.fromCharCode(code + 96), { ctrl: true }));
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
    await writeStdout('\x1b[s\x1b[9999;9999H\x1b[6n\x1b[u');

    const controller = new AbortController();
    const timer = loopTimeout(150);
    void timer.then(() => controller.abort(new Error('terminal size query timed out')));

    let response = '';
    while (!controller.signal.aborted) {
      const chunk = await stdin().read({ maxBytes: 64, signal: controller.signal });
      if (chunk === null) break;
      response += decoder.decode(chunk);
      const match = /\x1b\[(\d+);(\d+)R/.exec(response);
      if (match) {
        timer.cancel();
        const height = Number(match[1]);
        const width = Number(match[2]);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          return { width: Math.floor(width), height: Math.floor(height) };
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
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
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
  return text + spaces(width - visibleLength(text));
}

function backgroundCode(background: unknown): string | null {
  switch (background) {
    case 'black': return '40';
    case 'red': return '41';
    case 'green': return '42';
    case 'yellow': return '43';
    case 'blue': return '44';
    case 'magenta': return '45';
    case 'cyan': return '46';
    case 'white': return '47';
    case 'brightBlack': return '100';
    default: return null;
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
    const middle = hasAnsi(source) ? fitAnsi(source, Math.max(0, width - x)) : source.slice(0, Math.max(0, width - x));
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
  if (!wrap) return [fit(text, width)];
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
    case 'text': return Math.max(1, Array.from(textContent(child)).length);
    case 'spacer': return numberProp(child.props, 'width', 0);
    case 'input': return Math.max(1, Array.from(stringProp(child.props, 'value', stringProp(child.props, 'placeholder', ''))).length + 2);
    case 'button': return Array.from(stringProp(child.props, 'label', '')).length + 4;
    case 'list': {
      const items = Array.isArray(child.props.items) ? child.props.items as string[] : [];
      return items.reduce((max, item) => Math.max(max, Array.from(item).length + 2), 0);
    }
    default: return 0;
  }
}

function intrinsicHeight(child: VNode | string): number {
  if (typeof child === 'string') return 1;
  const explicit = child.props.height;
  if (typeof explicit === 'number') return Math.max(0, Math.floor(explicit));
  switch (child.type) {
    case 'list': return Array.isArray(child.props.items) ? (child.props.items as string[]).length : 0;
    case 'scrollview': return numberProp(child.props, 'height', 1);
    default: return 1;
  }
}

function renderTextNode(node: VNode, width: number, height: number): string[] {
  const lines = wrapText(textContent(node), width, boolProp(node.props, 'wrap', false));
  return blank(width, height).map((line, index) => styleLine(lines[index] ?? line, node.props));
}

function renderList(node: VNode, width: number, height: number): string[] {
  const items = Array.isArray(node.props.items) ? node.props.items as string[] : [];
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
      return [styleLine(fit((boolProp(node.props, 'focused', false) ? '> ' : '  ') + value, width), node.props), ...blank(width, height - 1)];
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

function renderColumn(children: (VNode | string)[], width: number, height: number, gap: number): string[] {
  const out = blank(width, height);
  let y = 0;
  for (const child of children) {
    if (y >= height) break;
    const childHeight = Math.min(height - y, typeof child !== 'string' && child.type === 'text' && boolProp(child.props, 'wrap', false)
      ? height - y
      : intrinsicHeight(child));
    const lines = typeof child === 'string'
      ? [fit(child, width)]
      : renderElement(child, width, childHeight);
    overlay(out, lines, 0, y);
    y += childHeight + gap;
  }
  return out;
}

function renderRow(children: (VNode | string)[], width: number, height: number, gap: number): string[] {
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
      const share = flex > 0 ? Math.floor(remaining * weight / flex) : 0;
      childWidth += share;
      remaining -= share;
      flex -= weight;
    }
    childWidth = Math.min(childWidth, width - x);
    const lines = typeof child === 'string'
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
  const content = direction === 'row'
    ? renderRow(children, contentWidth, contentHeight, gap)
    : renderColumn(children, contentWidth, contentHeight, gap);
  overlay(out, content, insetX, insetY);
  return out.map((line) => styleLine(line, node.props));
}

function renderElement(node: VNode, width: number, height: number): string[] {
  if (node.type === 'box') return renderBox(node, width, height);
  if (node.type === 'scrollview') {
    const offset = numberProp(node.props, 'offset', 0);
    const inner = renderColumn(node.children as (VNode | string)[], width, Math.max(height + offset, height), 0);
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
export function renderFrame(element: VNode, options: RenderFrameOptions): string {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  return renderElement(element, width, height).slice(0, height).map((line) => fitAnsi(line, width)).join('\n');
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
 * Render a fullscreen terminal app and return a lifecycle handle.
 *
 * This enters the alternate screen, hides the cursor, writes the current frame,
 * and restores terminal state from `stop()`. Width and height default to the
 * current terminal size when available.
 */
export function render(element: VNode, options: RenderOptions = {}): TuiApp {
  let current = element;
  let stopped = false;
  const size = queryTerminalSize();
  const width = options.width ?? size.width;
  const height = options.height ?? size.height;
  const input = options.input || options.onEvent ? createTuiInput({ mouse: options.mouse ?? true }) : undefined;

  function paint(): void {
    if (stopped) return;
    void writeStdout(renderScreen(current, { width, height }));
  }

  void writeStdout(enterAlternateScreen() + hideCursor() + disableAutoWrap() + '\x1b[2J');
  paint();

  const app: TuiApp = {
    input,
    update(next: VNode): void {
      current = next;
      paint();
    },
    stop(): void {
      if (stopped) return;
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
