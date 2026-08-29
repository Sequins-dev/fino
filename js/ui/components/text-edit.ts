/**
 * Pure text-edit reducers and reusable controlled state helpers.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import type { Signal } from 'fino:ui';
import type { TextSelection, UiKeyEvent } from 'fino:ui/components';

/** Value, caret, and selection consumed and returned by text reducers. */
export interface TextEditState {
  value: string;
  caret: number;
  selection?: TextSelection | null;
}

interface EditContext {
  value: string;
  caret: number;
  selection: TextSelection | null;
  anchor: number;
  alt: boolean;
  shift: boolean;
  key: string;
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function wordLeft(value: string, from: number): number {
  let at = from;
  while (at > 0 && !isWordChar(value[at - 1]!)) at--;
  while (at > 0 && isWordChar(value[at - 1]!)) at--;
  return at;
}

function wordRight(value: string, from: number): number {
  let at = from;
  while (at < value.length && !isWordChar(value[at]!)) at++;
  while (at < value.length && isWordChar(value[at]!)) at++;
  return at;
}

function editContext(state: TextEditState, event: UiKeyEvent): EditContext | null {
  if (event.ctrl) return null;
  const value = state.value;
  const caret = Math.max(0, Math.min(value.length, state.caret));
  const raw = state.selection ?? null;
  const selection =
    raw === null || raw.start === raw.end
      ? null
      : {
          start: Math.max(0, Math.min(value.length, Math.min(raw.start, raw.end))),
          end: Math.max(0, Math.min(value.length, Math.max(raw.start, raw.end))),
        };
  return {
    value,
    caret,
    selection,
    anchor:
      selection === null ? caret : caret === selection.start ? selection.end : selection.start,
    alt: event.alt === true,
    shift: event.shift === true,
    key:
      event.alt === true && event.key === 'b'
        ? 'left'
        : event.alt === true && event.key === 'f'
          ? 'right'
          : event.key,
  };
}

function moved(context: EditContext, target: number): TextEditState {
  if (!context.shift) return { value: context.value, caret: target, selection: null };
  return {
    value: context.value,
    caret: target,
    selection:
      target === context.anchor
        ? null
        : { start: Math.min(context.anchor, target), end: Math.max(context.anchor, target) },
  };
}

function removed(context: EditContext, start: number, end: number): TextEditState {
  if (end <= start) return { value: context.value, caret: context.caret, selection: null };
  return {
    value: context.value.slice(0, start) + context.value.slice(end),
    caret: start,
    selection: null,
  };
}

function inserted(context: EditContext, text: string): TextEditState {
  const start = context.selection?.start ?? context.caret;
  const end = context.selection?.end ?? context.caret;
  return {
    value: context.value.slice(0, start) + text + context.value.slice(end),
    caret: start + text.length,
    selection: null,
  };
}

function horizontalEdit(context: EditContext): TextEditState | null {
  const { alt, caret, key, selection, value } = context;
  if (key === 'left') {
    if (!context.shift && !alt && selection !== null) return moved(context, selection.start);
    return moved(context, alt ? wordLeft(value, caret) : Math.max(0, caret - 1));
  }
  if (key === 'right') {
    if (!context.shift && !alt && selection !== null) return moved(context, selection.end);
    return moved(context, alt ? wordRight(value, caret) : Math.min(value.length, caret + 1));
  }
  if (key === 'backspace') {
    if (selection !== null) return removed(context, selection.start, selection.end);
    return removed(context, alt ? wordLeft(value, caret) : Math.max(0, caret - 1), caret);
  }
  if (key === 'delete') {
    if (selection !== null) return removed(context, selection.start, selection.end);
    return removed(
      context,
      caret,
      alt ? wordRight(value, caret) : Math.min(value.length, caret + 1),
    );
  }
  return null;
}

function lineStart(value: string, from: number): number {
  const at = value.lastIndexOf('\n', from - 1);
  return at === -1 ? 0 : at + 1;
}

function lineEnd(value: string, from: number): number {
  const at = value.indexOf('\n', from);
  return at === -1 ? value.length : at;
}

function moveVertical(value: string, position: number, direction: -1 | 1): number {
  const column = position - lineStart(value, position);
  if (direction === -1) {
    const start = lineStart(value, position);
    if (start === 0) return position;
    const previous = lineStart(value, start - 1);
    return previous + Math.min(column, start - 1 - previous);
  }
  const end = lineEnd(value, position);
  if (end === value.length) return position;
  const next = end + 1;
  return next + Math.min(column, lineEnd(value, next) - next);
}

/** Apply one key to a single-line edit state, or return `null` when unhandled. */
export function applyTextEdit(state: TextEditState, event: UiKeyEvent): TextEditState | null {
  const context = editContext(state, event);
  if (context === null) return null;
  const horizontal = horizontalEdit(context);
  if (horizontal !== null) return horizontal;
  if (context.key === 'home') return moved(context, 0);
  if (context.key === 'end') return moved(context, context.value.length);
  if (
    !context.alt &&
    event.text !== undefined &&
    event.text.length > 0 &&
    context.key !== 'enter'
  ) {
    return inserted(context, event.text);
  }
  return null;
}

/** Apply one key to a multi-line edit state, or return `null` when unhandled. */
export function applyTextAreaEdit(state: TextEditState, event: UiKeyEvent): TextEditState | null {
  const context = editContext(state, event);
  if (context === null) return null;
  const horizontal = horizontalEdit(context);
  if (horizontal !== null) return horizontal;
  if (context.key === 'up') return moved(context, moveVertical(context.value, context.caret, -1));
  if (context.key === 'down') return moved(context, moveVertical(context.value, context.caret, 1));
  if (context.key === 'home') return moved(context, lineStart(context.value, context.caret));
  if (context.key === 'end') return moved(context, lineEnd(context.value, context.caret));
  if (!context.alt && context.key === 'enter') return inserted(context, '\n');
  if (!context.alt && event.text !== undefined && event.text.length > 0) {
    return inserted(context, event.text);
  }
  return null;
}

/** Reusable controlled state returned by {@link createTextField} and {@link createTextArea}. */
export interface TextEditController {
  /** Current value. */
  readonly value: Signal<string>;
  /** Current caret offset. */
  readonly caret: Signal<number>;
  /** Current selection. */
  readonly selection: Signal<TextSelection | null>;
  /** Replace the complete edit state. */
  set(value: string, caret?: number, selection?: TextSelection | null): void;
  /** Apply one key through the controller's reducer. */
  apply(event: UiKeyEvent): boolean;
}

function createTextController(
  initial: string,
  reduce: (state: TextEditState, event: UiKeyEvent) => TextEditState | null,
): TextEditController {
  const value = createSignal(initial);
  const caret = createSignal(initial.length);
  const selection = createSignal<TextSelection | null>(null);
  const set = (next: string, at?: number, range?: TextSelection | null): void => {
    value.set(next);
    caret.set(Math.max(0, Math.min(next.length, at ?? next.length)));
    selection.set(range ?? null);
  };
  return {
    value,
    caret,
    selection,
    set,
    apply(event): boolean {
      const next = reduce(
        { value: value.get(), caret: caret.get(), selection: selection.get() },
        event,
      );
      if (next === null) return false;
      set(next.value, next.caret, next.selection);
      return true;
    },
  };
}

/** Create persistent state for a single-line {@link TextInput}. */
export function createTextField(initial = ''): TextEditController {
  return createTextController(initial, applyTextEdit);
}

/** Create persistent state for a multi-line {@link TextArea}. */
export function createTextArea(initial = ''): TextEditController {
  return createTextController(initial, applyTextAreaEdit);
}
