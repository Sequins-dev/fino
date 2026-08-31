/**
 * internal:ui/components/text-edit — the pure edit reducers behind
 * `TextInput`/`TextArea`, and the state helpers that drive them.
 *
 * The reducers are render-target machinery: the terminal target routes key
 * events through them to produce the next value/caret/selection, and the web
 * target lets the browser do the same job natively. Applications use
 * `createTextField`/`createTextArea`, which are re-exported from
 * `fino:ui/components`.
 *
 * @internal
 */
import { createSignal, type Signal } from 'fino:ui';
import type { TextSelection, UiKeyEvent } from 'internal:ui/components/primitives';

/** Value + caret + selection snapshot consumed by `applyTextEdit`. */
export interface TextEditState {
  value: string;
  caret: number;
  /** Active selection; the caret is the moving head, the other edge the anchor. */
  selection?: TextSelection | null;
}

function isWordChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
  );
}
function wordLeft(value: string, from: number): number {
  let i = from;
  while (i > 0 && !isWordChar(value[i - 1]!)) i--;
  while (i > 0 && isWordChar(value[i - 1]!)) i--;
  return i;
}
function wordRight(value: string, from: number): number {
  let i = from;
  while (i < value.length && !isWordChar(value[i]!)) i++;
  while (i < value.length && isWordChar(value[i]!)) i++;
  return i;
}

/**
 * Pure single-line edit reducer: printable characters insert at the caret
 * (replacing any selection), backspace/delete remove the selection or around
 * the caret, left/right/home/end move it, alt jumps and deletes by word
 * (alt+b/alt+f included), and shift extends the selection from its anchor.
 * Returns the next state, or `null` when the event is not an edit key.
 */
export function applyTextEdit(state: TextEditState, event: UiKeyEvent): TextEditState | null {
  if (event.ctrl) return null;
  const value = state.value;
  const caret = Math.max(0, Math.min(value.length, state.caret));
  const raw = state.selection ?? null;
  const selection =
    raw !== null && raw.start !== raw.end
      ? {
          start: Math.max(0, Math.min(value.length, Math.min(raw.start, raw.end))),
          end: Math.max(0, Math.min(value.length, Math.max(raw.start, raw.end))),
        }
      : null;
  const anchor =
    selection === null ? caret : caret === selection.start ? selection.end : selection.start;
  const alt = event.alt === true;
  const shift = event.shift === true;
  const key = alt && event.key === 'b' ? 'left' : alt && event.key === 'f' ? 'right' : event.key;

  const moved = (target: number): TextEditState =>
    shift
      ? {
          value,
          caret: target,
          selection:
            target === anchor
              ? null
              : { start: Math.min(anchor, target), end: Math.max(anchor, target) },
        }
      : { value, caret: target, selection: null };
  const removed = (start: number, end: number): TextEditState =>
    end > start
      ? { value: value.slice(0, start) + value.slice(end), caret: start, selection: null }
      : { value, caret, selection: null };

  switch (key) {
    case 'left':
      if (!shift && !alt && selection !== null) {
        return { value, caret: selection.start, selection: null };
      }
      return moved(alt ? wordLeft(value, caret) : Math.max(0, caret - 1));
    case 'right':
      if (!shift && !alt && selection !== null) {
        return { value, caret: selection.end, selection: null };
      }
      return moved(alt ? wordRight(value, caret) : Math.min(value.length, caret + 1));
    case 'home':
      return moved(0);
    case 'end':
      return moved(value.length);
    case 'backspace':
      if (selection !== null) return removed(selection.start, selection.end);
      return removed(alt ? wordLeft(value, caret) : Math.max(0, caret - 1), caret);
    case 'delete':
      if (selection !== null) return removed(selection.start, selection.end);
      return removed(caret, alt ? wordRight(value, caret) : Math.min(value.length, caret + 1));
    default:
      if (!alt && event.text !== undefined && event.text.length > 0 && key !== 'enter') {
        const start = selection?.start ?? caret;
        const end = selection?.end ?? caret;
        return {
          value: value.slice(0, start) + event.text + value.slice(end),
          caret: start + event.text.length,
          selection: null,
        };
      }
      return null;
  }
}

/** Text field state helper for `TextInput`: value, caret, and selection that survive re-renders. */
export interface TextFieldState {
  readonly value: Signal<string>;
  readonly caret: Signal<number>;
  readonly selection: Signal<TextSelection | null>;
  /** Set the value, placing the caret at `caret` (default: the end) and clearing the selection. */
  set(value: string, caret?: number, selection?: TextSelection | null): void;
  /** Route a key event through the edit reducer; true when consumed. */
  apply(event: UiKeyEvent): boolean;
}
/** Create text field state; wire `value`/`caret`/`selection` props and `onChange={field.set}`. */
export function createTextField(initial = ''): TextFieldState {
  const value = createSignal(initial);
  const caret = createSignal(initial.length);
  const selection = createSignal<TextSelection | null>(null);
  return {
    value,
    caret,
    selection,
    set(next: string, at?: number, range?: TextSelection | null): void {
      value.set(next);
      caret.set(Math.max(0, Math.min(next.length, at ?? next.length)));
      selection.set(range ?? null);
    },
    apply(event: UiKeyEvent): boolean {
      const next = applyTextEdit(
        { value: value.get(), caret: caret.get(), selection: selection.get() },
        event,
      );
      if (next === null) return false;
      value.set(next.value);
      caret.set(next.caret);
      selection.set(next.selection ?? null);
      return true;
    },
  };
}

function lineStart(value: string, from: number): number {
  const at = value.lastIndexOf('\n', from - 1);
  return at === -1 ? 0 : at + 1;
}
function lineEnd(value: string, from: number): number {
  const at = value.indexOf('\n', from);
  return at === -1 ? value.length : at;
}
function moveVertical(value: string, pos: number, dir: 1 | -1): number {
  const column = pos - lineStart(value, pos);
  if (dir === -1) {
    const start = lineStart(value, pos);
    if (start === 0) return pos;
    const prevStart = lineStart(value, start - 1);
    return prevStart + Math.min(column, start - 1 - prevStart);
  }
  const end = lineEnd(value, pos);
  if (end === value.length) return pos;
  const nextStart = end + 1;
  const nextEnd = lineEnd(value, nextStart);
  return nextStart + Math.min(column, nextEnd - nextStart);
}

/**
 * Pure multi-line edit reducer for `TextArea`: everything `applyTextEdit`
 * does, plus Enter inserts a newline (there is no single-line submit key to
 * reserve it for), Home/End move to the start/end of the *current* line
 * rather than the whole value, and Up/Down move the caret to the same column
 * on the line above/below, clamping short lines. `TextArea` gets its own
 * reducer instead of overloading `applyTextEdit` because those meanings
 * genuinely diverge per line — sharing one function would mean every
 * single-line caller paying for a `value.indexOf('\n', …)` scan, and Home/End
 * would need a mode flag to pick "line" vs "value" boundaries.
 */
export function applyTextAreaEdit(state: TextEditState, event: UiKeyEvent): TextEditState | null {
  if (event.ctrl) return null;
  const value = state.value;
  const caret = Math.max(0, Math.min(value.length, state.caret));
  const raw = state.selection ?? null;
  const selection =
    raw !== null && raw.start !== raw.end
      ? {
          start: Math.max(0, Math.min(value.length, Math.min(raw.start, raw.end))),
          end: Math.max(0, Math.min(value.length, Math.max(raw.start, raw.end))),
        }
      : null;
  const anchor =
    selection === null ? caret : caret === selection.start ? selection.end : selection.start;
  const alt = event.alt === true;
  const shift = event.shift === true;
  const key = alt && event.key === 'b' ? 'left' : alt && event.key === 'f' ? 'right' : event.key;

  const moved = (target: number): TextEditState =>
    shift
      ? {
          value,
          caret: target,
          selection:
            target === anchor
              ? null
              : { start: Math.min(anchor, target), end: Math.max(anchor, target) },
        }
      : { value, caret: target, selection: null };
  const removed = (start: number, end: number): TextEditState =>
    end > start
      ? { value: value.slice(0, start) + value.slice(end), caret: start, selection: null }
      : { value, caret, selection: null };
  const inserted = (text: string): TextEditState => {
    const start = selection?.start ?? caret;
    const end = selection?.end ?? caret;
    return {
      value: value.slice(0, start) + text + value.slice(end),
      caret: start + text.length,
      selection: null,
    };
  };

  switch (key) {
    case 'left':
      if (!shift && !alt && selection !== null) {
        return { value, caret: selection.start, selection: null };
      }
      return moved(alt ? wordLeft(value, caret) : Math.max(0, caret - 1));
    case 'right':
      if (!shift && !alt && selection !== null) {
        return { value, caret: selection.end, selection: null };
      }
      return moved(alt ? wordRight(value, caret) : Math.min(value.length, caret + 1));
    case 'up':
      return moved(moveVertical(value, caret, -1));
    case 'down':
      return moved(moveVertical(value, caret, 1));
    case 'home':
      return moved(lineStart(value, caret));
    case 'end':
      return moved(lineEnd(value, caret));
    case 'backspace':
      if (selection !== null) return removed(selection.start, selection.end);
      return removed(alt ? wordLeft(value, caret) : Math.max(0, caret - 1), caret);
    case 'delete':
      if (selection !== null) return removed(selection.start, selection.end);
      return removed(caret, alt ? wordRight(value, caret) : Math.min(value.length, caret + 1));
    case 'enter':
      return alt ? null : inserted('\n');
    default:
      if (!alt && event.text !== undefined && event.text.length > 0) return inserted(event.text);
      return null;
  }
}

/** Text area state helper for `TextArea`: value, caret, and selection that survive re-renders. */
export interface TextAreaState {
  readonly value: Signal<string>;
  readonly caret: Signal<number>;
  readonly selection: Signal<TextSelection | null>;
  /** Set the value, placing the caret at `caret` (default: the end) and clearing the selection. */
  set(value: string, caret?: number, selection?: TextSelection | null): void;
  /** Route a key event through `applyTextAreaEdit`; true when consumed. */
  apply(event: UiKeyEvent): boolean;
}
/** Create text area state; wire `value`/`caret`/`selection` props and `onChange={area.set}`. */
export function createTextArea(initial = ''): TextAreaState {
  const value = createSignal(initial);
  const caret = createSignal(initial.length);
  const selection = createSignal<TextSelection | null>(null);
  return {
    value,
    caret,
    selection,
    set(next: string, at?: number, range?: TextSelection | null): void {
      value.set(next);
      caret.set(Math.max(0, Math.min(next.length, at ?? next.length)));
      selection.set(range ?? null);
    },
    apply(event: UiKeyEvent): boolean {
      const next = applyTextAreaEdit(
        { value: value.get(), caret: caret.get(), selection: selection.get() },
        event,
      );
      if (next === null) return false;
      value.set(next.value);
      caret.set(next.caret);
      selection.set(next.selection ?? null);
      return true;
    },
  };
}
