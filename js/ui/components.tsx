/** @jsxImportSource fino:ui */
/**
 * fino:ui/components — host-neutral UI primitives and the semantic component
 * catalog.
 *
 * Two vocabularies live here. The structural primitives — `box`, `text`,
 * `layer`, `clickable`, `input`, `scrollview` (plus the `spacer` and `rule`
 * helpers) — describe layout, and render targets implement them directly.
 * Catalog components sit above them and are purely semantic: `Checkbox()`
 * emits a `ui:checkbox` node carrying `checked`, `label`, and `onChange`, and
 * says nothing about presentation. Each render target owns the lowering:
 * `internal:tty/lower` turns semantic nodes into the glyph-and-box
 * compositions the terminal paints, and `fino:ui/components/html` turns the
 * same nodes into native web markup (`<input type="checkbox">`, `<details>`,
 * `<select>`).
 *
 * State never lives inside a component: interactive components take values
 * and change callbacks, and small state helpers (`createDisclosure`,
 * `ListSelection`) hold what must survive across renders. Focus is rendered
 * from a `focused` prop, wired by the app from its render target's focus
 * signal.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { Panel, Button, Details } from 'fino:ui/components';
 * import { createSignal } from 'fino:ui';
 *
 * const open = createSignal(false);
 * const view = () => (
 *   <Panel title="Session">
 *     <Details title="Advanced" open={open.get()} onToggle={(next) => open.set(next)}>
 *       <Button label="Reset" onClick={() => {}} />
 *     </Details>
 *   </Panel>
 * );
 * ```
 */
import { h, createSignal, type Child, type Props, type VNode, type Signal } from 'fino:ui';
import type { Color, Style } from 'fino:tty/style';
import { styles } from 'fino:ui/components/theme';

export type { Color, Style };
export { styles };

export type Direction = 'row' | 'column';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';
export type WrapMode = 'none' | 'char' | 'word';
export type BorderStyle = 'single' | 'ascii' | 'heavy' | 'double';

/** Style props accepted by every primitive. */
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
  /** Hit-region id, reported by the render target for mouse routing. */
  id?: string;
}

/** Flex-child props accepted by every primitive. */
export interface FlexChildProps {
  grow?: number;
  shrink?: number;
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
  justify?: Justify;
  align?: Align;
  gap?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  border?: boolean | BorderStyle;
  borderStyle?: BorderStyle;
  /** Round the corners: `╭╮╰╯` for single (and `/\\` for ascii) borders in the
   * terminal, border-radius on the web. Composes with any line style. */
  rounded?: boolean;
  borderColor?: Color;
  /** Text drawn into the top border edge. */
  borderTitle?: string;
  overflow?: 'hidden' | 'visible';
  children?: Child;
}

/** Props accepted by `Text`. */
export interface TextProps extends StyleProps, FlexChildProps, Props {
  wrap?: boolean | WrapMode;
  align?: 'start' | 'center' | 'end';
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

/** Character range of an active text selection; `start < end` after clamping. */
export interface TextSelection {
  start: number;
  end: number;
}

/** Props accepted by `Input`. */
export interface InputProps extends StyleProps, FlexChildProps, Props {
  value?: string;
  placeholder?: string;
  focused?: boolean;
  caret?: number;
  /** Highlighted range, painted inverse by the terminal target. */
  selection?: TextSelection | null;
}

/** Props accepted by `Layer`. */
export interface LayerProps extends StyleProps, Props {
  /** Explicit cell position the layer attaches to. */
  anchor?: { x: number; y: number };
  /** Anchor beneath the painted rect of the node with this hit id. */
  anchorId?: string;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'center';
  /** Dim everything beneath the layer. */
  backdrop?: boolean;
  /** Skip the opaque backing fill, letting content beneath show through. */
  transparent?: boolean;
  width?: number;
  height?: number;
  children?: Child;
}

/** Key event delivered to component handlers by the render target. */
export interface UiKeyEvent {
  type: 'key';
  key: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** Mouse event delivered to component handlers by the render target. */
export interface UiMouseEvent {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  button: string;
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * `x`/`y` relative to the deepest hit node's own painted rect — the
   * terminal target sets this (from the same rect hit-testing already
   * resolves), so a control like `Slider` can compute click-to-position
   * without knowing its own screen offset. Absent on targets that have no
   * such concept, and absent when nothing was hit.
   */
  localX?: number;
  localY?: number;
}

/** Props accepted by `Clickable`. */
export interface ClickableProps extends StyleProps, FlexChildProps, Props {
  onClick?: () => void;
  onKey?: (event: UiKeyEvent) => boolean | void;
  onMouse?: (event: UiMouseEvent) => boolean | void;
  onFocus?: () => void;
  onBlur?: () => void;
  focusable?: boolean;
  /** Receive key events while nothing is focused — for overlay surfaces. */
  captureKeys?: boolean;
  disabled?: boolean;
  direction?: Direction;
  align?: Align;
  justify?: Justify;
  gap?: number;
  width?: number;
  height?: number;
  children?: Child;
}

/** Props accepted by `Scroll`. */
export interface ScrollProps extends StyleProps, FlexChildProps, Props {
  width?: number;
  height?: number;
  /** First content row shown at the top of the viewport. */
  offset?: number;
  children?: Child;
}

/** Props accepted by `Rule`. */
export interface RuleProps extends StyleProps, FlexChildProps, Props {
  /** Fill character, default `─`. */
  char?: string;
  /** Cells left undrawn at the right edge. */
  inset?: number;
}

/** Layout container with the flexbox model, padding, margins, and borders. */
export function Box(props: BoxProps): VNode {
  return h('box', props);
}
/** Styled text runs with wrapping, truncation, and caret reporting. */
export function Text(props: TextProps): VNode {
  return h('text', props);
}
/** Flexible or fixed empty space. */
export function Spacer(props: SpacerProps): VNode {
  return h('spacer', props);
}
/** Single-line editable text field. */
export function Input(props: InputProps): VNode {
  return h('input', props);
}
/** Content rendered above the normal flow, anchored or centered. */
export function Layer(props: LayerProps): VNode {
  return h('layer', props);
}
/**
 * Non-visual behavior container: lays out like a plain `Box`, and a click
 * anywhere within — or Enter/Space while focused — fires `onClick`.
 */
export function Clickable(props: ClickableProps): VNode {
  return h('clickable', props);
}
/** Scrollable viewport over child content. */
export function Scroll(props: ScrollProps): VNode {
  return h('scrollview', props);
}
/** Horizontal line filling its container. */
export function Rule(props: RuleProps = {}): VNode {
  return h('rule', props);
}

/** Props accepted by `Stack`, `HStack`, and `VStack`. */
export interface StackProps extends Omit<BoxProps, 'direction'> {
  children?: Child;
}
/** Vertical box, `gap` between children. */
export function VStack(props: StackProps): VNode {
  return h('box', { ...props, direction: 'column' });
}
/** Horizontal box, `gap` between children. */
export function HStack(props: StackProps): VNode {
  return h('box', { ...props, direction: 'row' });
}
/** Alias of `VStack`, matching the common stacking default. */
export function Stack(props: StackProps): VNode {
  return VStack(props);
}

/** Props accepted by `Panel`. */
export interface PanelProps extends BoxProps {
  /** Panel heading. */
  title?: string;
}
/** Titled content region: a bordered box in the terminal, a card on the web. */
export function Panel(props: PanelProps): VNode {
  return h('ui:panel', props);
}

/** Props accepted by `Field`. */
export interface FieldProps extends FlexChildProps, Props {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** DOM id of the control this field labels; becomes the web `<label for>`. Unused in the terminal. */
  htmlFor?: string;
  /** Hit-region id for the field's own wrapper, distinct from `htmlFor`. */
  id?: string;
  children?: Child;
}
/**
 * Form field wrapper: a label (with a `required` marker) above the control,
 * an optional dim hint, and an optional error line. In the terminal these
 * stack as plain rows; on the web the label wraps the control natively
 * (associating it with no explicit `for` needed) unless `htmlFor` names the
 * control's id explicitly, and `error` wires `role="alert"` plus
 * `aria-invalid`/`aria-describedby` onto the first native form control found
 * among `children`.
 */
export function Field(props: FieldProps): VNode {
  return h('ui:field', props);
}

/** Props accepted by `Fieldset`. */
export interface FieldsetProps extends BoxProps {
  legend: string;
}
/** Group of fields under a legend: a bordered box with the legend in the border (terminal), a real `<fieldset><legend>` (web). */
export function Fieldset(props: FieldsetProps): VNode {
  return h('ui:fieldset', props);
}

/** Props accepted by `Button`. */
export interface ButtonProps extends StyleProps, FlexChildProps, Props {
  label: string;
  onClick?: () => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Push button. */
export function Button(props: ButtonProps): VNode {
  return h('ui:button', props);
}

/** Props accepted by `Checkbox`. */
export interface CheckboxProps extends StyleProps, FlexChildProps, Props {
  checked: boolean;
  label?: string;
  onChange?: (checked: boolean) => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Checkbox with a label, toggled by click or Enter/Space. */
export function Checkbox(props: CheckboxProps): VNode {
  return h('ui:checkbox', props);
}

/** Props accepted by `Radio`. */
export interface RadioProps extends StyleProps, FlexChildProps, Props {
  selected: boolean;
  label?: string;
  onSelect?: () => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** Single radio option. */
export function Radio(props: RadioProps): VNode {
  return h('ui:radio', props);
}

/** Props accepted by `RadioGroup`. */
export interface RadioGroupProps extends StyleProps, FlexChildProps, Props {
  value: string;
  options: Array<{ key: string; label: string; disabled?: boolean }>;
  onChange?: (key: string) => void;
  direction?: Direction;
  gap?: number;
  focusedKey?: string;
  id?: string;
}
/** Radio set rendered from an option list. */
export function RadioGroup(props: RadioGroupProps): VNode {
  return h('ui:radio-group', props);
}

/** Props accepted by `Switch`. */
export interface SwitchProps extends StyleProps, FlexChildProps, Props {
  on: boolean;
  label?: string;
  onChange?: (on: boolean) => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/** On/off toggle switch. */
export function Switch(props: SwitchProps): VNode {
  return h('ui:switch', props);
}

/** Props accepted by `TextInput`. */
export interface TextInputProps extends StyleProps, FlexChildProps, Props {
  value: string;
  placeholder?: string;
  caret?: number;
  /** Active selection; the caret is the moving head. */
  selection?: TextSelection | null;
  focused?: boolean;
  /**
   * Value change from editing. The render target maintains the edit — typed
   * characters, backspace/delete, caret and selection movement — and reports
   * the new state here; pair with `createTextField().set`.
   */
  onChange?: (value: string, caret?: number, selection?: TextSelection | null) => void;
  /** Enter (terminal) or form submission (web) with the current value. */
  onSubmit?: (value: string) => void;
  /** Raw key hook, consulted before the edit reducer. */
  onKey?: (event: UiKeyEvent) => boolean | void;
  /**
   * Mask the displayed characters (`•` in the terminal, `type="password"` on
   * the web) without touching `value` — the real text is what `onChange`
   * reports and what the caret/selection math operates on; only the paint
   * step masks.
   */
  password?: boolean;
  id?: string;
}
/** Single-line editable text field. */
export function TextInput(props: TextInputProps): VNode {
  return h('ui:text-input', props);
}

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

/** Props accepted by `TextArea`. */
export interface TextAreaProps extends StyleProps, FlexChildProps, Props {
  value: string;
  caret?: number;
  selection?: TextSelection | null;
  /** Visible row count; default 4. */
  rows?: number;
  focused?: boolean;
  /**
   * Value change from editing, via `applyTextAreaEdit` in the terminal.
   * Pair with `createTextArea().set`.
   */
  onChange?: (value: string, caret?: number, selection?: TextSelection | null) => void;
  /**
   * Explicit submit, e.g. ctrl+enter — plain Enter always inserts a newline
   * since there is no other line-insertion key. The web target has no
   * native gesture for this (a `<textarea>` inside a `<form>` never submits
   * on Enter), so `onSubmit` only fires from the terminal.
   */
  onSubmit?: (value: string) => void;
  onKey?: (event: UiKeyEvent) => boolean | void;
  id?: string;
}
/** Multi-line editable text field. */
export function TextArea(props: TextAreaProps): VNode {
  return h('ui:text-area', props);
}

/** Props accepted by `NumberInput`. */
export interface NumberInputProps extends StyleProps, FlexChildProps, Props {
  value: number;
  min?: number;
  max?: number;
  /** Increment per step; default 1. */
  step?: number;
  onChange?: (value: number) => void;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/**
 * Numeric stepper: decrement/increment affordances flank the value, clamped
 * to `min`/`max`. In the terminal, clicking either affordance or pressing
 * left/right while focused steps the value; on the web it is a native
 * `<input type="number">`.
 */
export function NumberInput(props: NumberInputProps): VNode {
  return h('ui:number-input', props);
}

/** Props accepted by `Slider`. */
export interface SliderProps extends StyleProps, FlexChildProps, Props {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  orientation?: 'horizontal' | 'vertical';
  /** Track length in cells (horizontal) or rows (vertical); default 20/8. */
  width?: number;
  focused?: boolean;
  disabled?: boolean;
  id?: string;
}
/**
 * Continuous value picker: a track with a handle. In the terminal, left/down
 * decrement and right/up increment while focused, and pressing or dragging
 * anywhere on the track jumps the handle there (via the mouse event's
 * `localX`/`localY`, relative to the track's own painted rect); on the web
 * it is a native `<input type="range">`, which gets dragging for free.
 */
export function Slider(props: SliderProps): VNode {
  return h('ui:slider', props);
}

/** Where a disclosure component places its `Expander`. */
export type ExpanderPosition = 'start' | 'end' | 'none';

/** Props accepted by `Expander`. */
export interface ExpanderProps extends StyleProps, FlexChildProps, Props {
  open: boolean;
  onToggle?: (open: boolean) => void;
  disabled?: boolean;
  id?: string;
}
/**
 * Standalone disclosure affordance: the rotating open/closed marker,
 * placeable anywhere in a composition. Clickable when `onToggle` is given.
 */
export function Expander(props: ExpanderProps): VNode {
  return h('ui:expander', props);
}

/** Props accepted by `Details`. */
export interface DetailsProps extends StyleProps, FlexChildProps, Props {
  title: string;
  open: boolean;
  onToggle?: (open: boolean) => void;
  /** Expander placement in the summary row; default `'start'`. */
  expander?: ExpanderPosition;
  focused?: boolean;
  id?: string;
  children?: Child;
}
/**
 * Collapsible section: an always-visible summary that toggles the content
 * beneath it, like an HTML `<details>` element.
 */
export function Details(props: DetailsProps): VNode {
  return h('ui:details', props);
}

/** One tab in a `Tabs` strip. */
export interface TabItem {
  key: string;
  label: string;
  disabled?: boolean;
}

/** Props accepted by `TabList`. */
export interface TabListProps extends StyleProps, FlexChildProps, Props {
  items: TabItem[];
  value: string;
  onChange?: (key: string) => void;
  id?: string;
}
/** The tab strip alone: one active tab among labeled peers. */
export function TabList(props: TabListProps): VNode {
  return h('ui:tab-list', props);
}

/** Props accepted by `Tabs`. */
export interface TabsProps extends TabListProps {
  children?: Child;
}
/**
 * Tab strip with a content area beneath. The caller renders the active
 * panel as children — there is no hidden panel state.
 */
export function Tabs(props: TabsProps): VNode {
  return h('ui:tabs', props);
}

/** Entries accepted by `MenuList` and `ListSelection`. */
export type MenuItem =
  | {
      kind?: 'item';
      key: string;
      label: string;
      detail?: string;
      glyph?: string;
      disabled?: boolean;
    }
  | { kind: 'header'; label: string }
  | { kind: 'separator' };

function isSelectable(item: MenuItem): item is Extract<MenuItem, { key: string }> {
  return (
    (item.kind === undefined || item.kind === 'item') && !('disabled' in item && item.disabled)
  );
}

/**
 * Selection model for menu lists: a selected key, header-skipping movement,
 * and a scroll window that follows the selection. Lives outside the tree —
 * component functions cannot hold state across renders.
 */
export class ListSelection {
  #items: MenuItem[] = [];
  #selected: string | null = null;
  #top = 0;
  #maxRows: number;

  constructor(options: { maxRows?: number } = {}) {
    this.#maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  }

  setMaxRows(rows: number): void {
    this.#maxRows = rows;
    this.#snap();
  }

  setItems(items: MenuItem[], options: { keepKey?: boolean } = {}): void {
    this.#items = items;
    const keys = items.filter(isSelectable).map((item) => item.key);
    if (!(options.keepKey !== false && this.#selected !== null && keys.includes(this.#selected))) {
      this.#selected = keys[0] ?? null;
    }
    this.#snap();
  }

  get items(): readonly MenuItem[] {
    return this.#items;
  }

  get selectedKey(): string | null {
    return this.#selected;
  }

  get selected(): MenuItem | undefined {
    return this.#items.find((item) => isSelectable(item) && item.key === this.#selected);
  }

  get top(): number {
    return this.#top;
  }

  get maxRows(): number {
    return this.#maxRows;
  }

  selectKey(key: string): boolean {
    const found = this.#items.find((item) => isSelectable(item) && item.key === key);
    if (!found) return false;
    this.#selected = key;
    this.#snap();
    return true;
  }

  move(delta: number): boolean {
    const keys = this.#items.filter(isSelectable).map((item) => item.key);
    if (keys.length === 0) return false;
    const current = this.#selected === null ? -1 : keys.indexOf(this.#selected);
    const next = Math.max(0, Math.min(keys.length - 1, (current === -1 ? 0 : current) + delta));
    if (keys[next] === this.#selected) return false;
    this.#selected = keys[next]!;
    this.#snap();
    return true;
  }

  movePage(direction: 1 | -1): boolean {
    const page = Number.isFinite(this.#maxRows) ? Math.max(1, this.#maxRows - 1) : 10;
    return this.move(direction * page);
  }

  /** Route a key event: up/down/pageup/pagedown/home/end move the selection. */
  handleKey(event: UiKeyEvent): boolean {
    if (event.ctrl || event.alt) return false;
    switch (event.key) {
      case 'up':
        return this.move(-1);
      case 'down':
        return this.move(1);
      case 'pageup':
        return this.movePage(-1);
      case 'pagedown':
        return this.movePage(1);
      case 'home':
        return this.move(-this.#items.length);
      case 'end':
        return this.move(this.#items.length);
      default:
        return false;
    }
  }

  #snap(): void {
    if (!Number.isFinite(this.#maxRows)) {
      this.#top = 0;
      return;
    }
    const index = this.#items.findIndex(
      (item) => isSelectable(item) && item.key === this.#selected,
    );
    if (index === -1) return;
    if (index < this.#top) this.#top = index;
    if (index >= this.#top + this.#maxRows) this.#top = index - this.#maxRows + 1;
    this.#top = Math.max(0, Math.min(this.#top, Math.max(0, this.#items.length - this.#maxRows)));
  }
}

/** Props accepted by `MenuRow`. */
export interface MenuRowProps extends Props {
  label: string;
  detail?: string;
  glyph?: string;
  marker?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  id?: string;
}
/** One selectable menu row: optional glyph, label, dim detail. */
export function MenuRow(props: MenuRowProps): VNode {
  return h('ui:menu-row', props);
}

/** Section heading inside a menu. */
export function MenuHeader(props: { label: string } & Props): VNode {
  return h('ui:menu-header', props);
}

/** Divider inside a menu. */
export function MenuSeparator(props: Props = {}): VNode {
  return h('ui:menu-separator', props);
}

/** Props accepted by `MenuList`. */
export interface MenuListProps extends Props {
  items: readonly MenuItem[];
  selectedKey?: string | null;
  /** First visible row when windowing; pair with `maxRows`. */
  top?: number;
  maxRows?: number;
  marker?: string;
  onSelect?: (key: string) => void;
  /** Row ids become `${id}:${key}` for hit routing. */
  id?: string;
}
/** Menu rendered from data: rows, headers, separators, windowed by `top`/`maxRows`. */
export function MenuList(props: MenuListProps): VNode {
  return h('ui:menu-list', props);
}

/** Props accepted by `Modal`. */
export interface ModalProps extends Props {
  title?: string;
  onDismiss?: () => void;
  width?: number;
  height?: number;
  children?: Child;
}
/**
 * Centered dialog above a dimmed backdrop. Esc — from anywhere, the modal
 * root consumes it — and clicks outside both dismiss.
 */
export function Modal(props: ModalProps): VNode {
  return h('ui:modal', props);
}

/** Props accepted by `ContextMenu`. */
export interface ContextMenuProps extends Props {
  /** Cell position the menu opens at — typically the click position. */
  at: { x: number; y: number };
  items: readonly MenuItem[];
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  onDismiss: () => void;
  id?: string;
}
/**
 * Menu overlaying the content at a position. A full-screen catch layer
 * beneath it dismisses on any outside click.
 */
export function ContextMenu(props: ContextMenuProps): VNode {
  return h('ui:context-menu', props);
}

/** Props accepted by `Select`. */
export interface SelectProps extends Props {
  value: string | null;
  options: Array<{ key: string; label: string; disabled?: boolean }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (key: string) => void;
  placeholder?: string;
  focused?: boolean;
  /** Required for anchoring the popover to the trigger. */
  id: string;
}
/** Select box: a trigger and an option list that opens beneath it. */
export function Select(props: SelectProps): VNode {
  return h('ui:select', props);
}

/** One option in a `ComboBox` list. */
export interface ComboBoxOption {
  key: string;
  label: string;
  disabled?: boolean;
}

/**
 * Default `ComboBox` filter: a case-insensitive substring match over
 * `label`. An empty (or whitespace-only) query keeps every option.
 */
export function defaultComboBoxFilter(
  options: readonly ComboBoxOption[],
  query: string,
): ComboBoxOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

/** Props accepted by `ComboBox`. */
export interface ComboBoxProps extends Props {
  /** The typed text — free-form, not necessarily an option's label or key. */
  value: string;
  options: readonly ComboBoxOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Typed-text change from editing, via `applyTextEdit` in the terminal. */
  onInput: (value: string, caret?: number, selection?: TextSelection | null) => void;
  onSelect: (key: string) => void;
  /**
   * The row highlighted while browsing the open list with arrow keys.
   * Separate from `value`, which is free-typed text rather than a picked
   * option — unlike `Select`, where the selected key doubles as the
   * highlighted row, `ComboBox` has no such value to borrow, so browsing
   * needs its own piece of state.
   */
  activeKey?: string | null;
  onActiveChange?: (key: string | null) => void;
  placeholder?: string;
  caret?: number;
  selection?: TextSelection | null;
  focused?: boolean;
  disabled?: boolean;
  /** Overrides the default substring match; see `defaultComboBoxFilter`. */
  filter?: (options: readonly ComboBoxOption[], query: string) => ComboBoxOption[];
  /** Required for anchoring the popover to the input. */
  id: string;
}
/**
 * Text input filtering a selectable list: typing narrows `options` (through
 * `filter`, defaulting to `defaultComboBoxFilter`) and opens an anchored
 * list beneath the input, built on `MenuList` the same way `Select` anchors
 * its popover.
 */
export function ComboBox(props: ComboBoxProps): VNode {
  return h('ui:combobox', props);
}

/** Disclosure state helper for `Details`, `Modal`, `Select`, and menus. */
export interface Disclosure {
  readonly open: Signal<boolean>;
  toggle(): void;
  set(open: boolean): void;
}
/** Create toggleable open/closed state that survives re-renders. */
export function createDisclosure(defaultOpen = false): Disclosure {
  const open = createSignal(defaultOpen);
  return {
    open,
    toggle: () => open.set(!open.get()),
    set: (next: boolean) => open.set(next),
  };
}

/** Token color variants used by `Badge` and `Tag`. */
export type ToneVariant = 'accent' | 'muted' | 'danger' | 'success' | 'warning';
/** Semantic status variants used by `Toast` and `Timeline`. */
export type StatusVariant = 'info' | 'success' | 'danger' | 'warning';

/** Props accepted by `Badge`. */
export interface BadgeProps extends FlexChildProps, Props {
  label: string;
  variant?: ToneVariant;
  id?: string;
}
/** Small inline status label in a tone color. */
export function Badge(props: BadgeProps): VNode {
  return h('ui:badge', props);
}

/** Frame set cycled by `Spinner` in the terminal target. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Props accepted by `Spinner`. */
export interface SpinnerProps extends FlexChildProps, Props {
  /** Optional fixed frame index; omitted, the render target animates. */
  tick?: number;
  frames?: string[];
  id?: string;
}
/** Indeterminate activity indicator. */
export function Spinner(props: SpinnerProps): VNode {
  return h('ui:spinner', props);
}

/** Props accepted by `ProgressBar`. */
export interface ProgressBarProps extends FlexChildProps, Props {
  /** Completion fraction, 0..1. */
  value: number;
  width?: number;
  showPercent?: boolean;
  id?: string;
}
/** Horizontal completion bar, optionally labeled with a percent. */
export function ProgressBar(props: ProgressBarProps): VNode {
  return h('ui:progress', props);
}

/** Props accepted by `KeyHint`. */
export interface KeyHintProps extends FlexChildProps, Props {
  keys: Array<{ key: string; label: string }>;
  separator?: string;
  id?: string;
}
/** Key legend row: `y approve · n reject`. */
export function KeyHint(props: KeyHintProps): VNode {
  return h('ui:key-hint', props);
}

/** Props accepted by `Tag`. */
export interface TagProps extends FlexChildProps, Props {
  label: string;
  onRemove?: () => void;
  color?: ToneVariant;
  id?: string;
}
/** Chip in a tone color, with an optional remover. */
export function Tag(props: TagProps): VNode {
  return h('ui:tag', props);
}

/** Props accepted by `TagGroup`. */
export interface TagGroupProps extends FlexChildProps, Props {
  gap?: number;
  id?: string;
  children?: Child;
}
/** Wrapping row of tags. */
export function TagGroup(props: TagGroupProps): VNode {
  const { gap, children, ...rest } = props;
  return (
    <Box direction="row" wrap gap={gap ?? 1} {...rest}>
      {children}
    </Box>
  );
}

/** Props accepted by `Breadcrumbs`. */
export interface BreadcrumbsProps extends FlexChildProps, Props {
  items: Array<{ key: string; label: string }>;
  onNavigate?: (key: string) => void;
  id?: string;
}
/** Path row: clickable ancestors, then the current item. */
export function Breadcrumbs(props: BreadcrumbsProps): VNode {
  return h('ui:breadcrumbs', props);
}

/** Props accepted by `Pagination`. */
export interface PaginationProps extends FlexChildProps, Props {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  /** Pages shown on each side of the current page. Defaults to 1. */
  siblings?: number;
  id?: string;
}
/**
 * Pager: a previous chevron, direct page buttons with `…` where pages are
 * skipped, and a next chevron. The current page is highlighted and inert;
 * chevrons disable at the boundaries and `…` markers are inert. See
 * `paginationRange` for the exact sequence rule.
 */
export function Pagination(props: PaginationProps): VNode {
  return h('ui:pagination', props);
}

/**
 * Compute the page-button sequence for `Pagination`: the first page, a
 * window of `siblings` pages either side of `page` (default 1), and the
 * last page — with an `'ellipsis'` marker wherever the window skips more
 * than one page. A skip of exactly one page is shown as that page instead
 * of collapsing it into `…`, since an ellipsis only earns its place when it
 * hides two or more pages.
 *
 * `page` clamps into `[1, pages]` and `pages` clamps to at least 1, so a
 * one-page (or zero/negative-page) pager degenerates to `[1]`.
 *
 * ```ts no_run
 * paginationRange(7, 20, 1); // [1, 'ellipsis', 6, 7, 8, 'ellipsis', 20]
 * paginationRange(2, 3, 1);  // [1, 2, 3]
 * ```
 */
export function paginationRange(
  page: number,
  pages: number,
  siblings = 1,
): Array<number | 'ellipsis'> {
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const span = Math.max(0, Math.floor(siblings));
  let left = Math.max(1, current - span);
  let right = Math.min(total, current + span);
  if (left - 2 === 1) left -= 1;
  if (total - right - 1 === 1) right += 1;
  const range: Array<number | 'ellipsis'> = [];
  if (left > 1) {
    range.push(1);
    if (left > 2) range.push('ellipsis');
  }
  for (let index = left; index <= right; index++) range.push(index);
  if (right < total) {
    if (right < total - 1) range.push('ellipsis');
    range.push(total);
  }
  return range;
}

/** Props accepted by `Steps`. */
export interface StepsProps extends FlexChildProps, Props {
  steps: Array<{ key: string; label: string }>;
  current: string;
  id?: string;
}
/** Step strip: done, current, and upcoming steps in order. */
export function Steps(props: StepsProps): VNode {
  return h('ui:steps', props);
}

/** One section of an `Accordion`. */
export interface AccordionSection {
  key: string;
  title: string;
  content: Child;
}
/** Props accepted by `Accordion`. */
export interface AccordionProps extends FlexChildProps, Props {
  sections: AccordionSection[];
  openKeys: string[];
  onToggle?: (key: string) => void;
  /** Expander placement forwarded to every section's `Details`. */
  expander?: ExpanderPosition;
  id?: string;
}
/**
 * Stack of `Details` sections. The caller owns `openKeys` — pair with
 * `createAccordion(true)` when only one section may stay open.
 */
export function Accordion(props: AccordionProps): VNode {
  const { sections, openKeys, onToggle, expander, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      {sections.map((section) => (
        <Details
          key={section.key}
          id={id !== undefined ? `${id}:${section.key}` : undefined}
          title={section.title}
          open={openKeys.includes(section.key)}
          expander={expander}
          onToggle={onToggle ? () => onToggle(section.key) : undefined}
        >
          {section.content}
        </Details>
      ))}
    </Box>
  );
}

/** Accordion open-key state helper. */
export interface AccordionState {
  readonly openKeys: Signal<string[]>;
  toggle(key: string): void;
}
/** Create accordion open-key state; `single` closes other sections on toggle. */
export function createAccordion(single = false): AccordionState {
  const openKeys = createSignal<string[]>([]);
  return {
    openKeys,
    toggle(key: string): void {
      const current = openKeys.get();
      if (current.includes(key)) {
        openKeys.set(current.filter((open) => open !== key));
      } else {
        openKeys.set(single ? [key] : [...current, key]);
      }
    },
  };
}

/** Props accepted by `Popover`. */
export interface PopoverProps extends Props {
  open: boolean;
  /** Hit id of the trigger the popover anchors beneath. */
  anchorId: string;
  onDismiss?: () => void;
  children?: Child;
}
/** Overlay anchored beneath a trigger. Esc dismisses; no backdrop. */
export function Popover(props: PopoverProps): VNode {
  return h('ui:popover', props);
}

/** Props accepted by `Tooltip`. */
export interface TooltipProps extends Props {
  text: string;
  /** Shown state — the app decides when; there is no hover tracking. */
  open: boolean;
  anchorId: string;
}
/** One-line hint anchored beneath a trigger. */
export function Tooltip(props: TooltipProps): VNode {
  return h('ui:tooltip', props);
}

/** Props accepted by `Toast`. */
export interface ToastProps extends Props {
  message: string;
  variant?: StatusVariant;
}
/** One notification with a status variant. */
export function Toast(props: ToastProps): VNode {
  return h('ui:toast', props);
}

/** Props accepted by `ToastStack`. */
export interface ToastStackProps extends Props {
  toasts: Array<{ id: string; message: string; variant?: StatusVariant }>;
}
/** Notification column pinned to the top-right corner. */
export function ToastStack(props: ToastStackProps): VNode {
  return h('ui:toast-stack', props);
}

/** One column of a `Table`. */
export interface TableColumn {
  key: string;
  header: string;
  /** Explicit cell width; narrower content truncates with `…`. */
  width?: number;
  align?: 'start' | 'end';
}
/** Props accepted by `Table`. */
export interface TableProps extends FlexChildProps, Props {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  selectedIndex?: number;
  onSelectRow?: (index: number) => void;
  id?: string;
}
/** Data table: a header row over data rows, with selectable rows. */
export function Table(props: TableProps): VNode {
  return h('ui:table', props);
}

/** Per-target representations of one registry icon. */
export interface IconForms {
  /** Terminal form: a character or short glyph run. */
  tui: string;
  /** Web form: emoji or markup a render target may inline. */
  html: string;
}

/**
 * Built-in icon registry: semantic names to per-target forms. The registry is
 * data — each render target picks its own column via `iconForm`.
 */
// The terminal column stays monochrome width-1 glyphs — colored emoji read
// wrong in a TUI. Folder open/closed double as the file tree's expander.
export const ICONS: Record<string, IconForms> = {
  folder: { tui: '▸', html: '📁' },
  'folder-open': { tui: '▾', html: '📂' },
  file: { tui: '·', html: '📄' },
  code: { tui: '◆', html: '📜' },
  doc: { tui: '¶', html: '📝' },
  config: { tui: '⚙', html: '🔧' },
  image: { tui: '▣', html: '🎨' },
  lock: { tui: '∗', html: '🔒' },
  shell: { tui: '$', html: '🐚' },
  'chevron-right': { tui: '▸', html: '▸' },
  'chevron-down': { tui: '▾', html: '▾' },
};

/**
 * Resolve an icon name to its form for a target, consulting `overrides`
 * before the built-in registry. Unknown names fall back to the `file` icon.
 */
export function iconForm(
  name: string,
  target: keyof IconForms,
  overrides?: Record<string, IconForms>,
): string {
  const entry = overrides?.[name] ?? ICONS[name] ?? ICONS.file!;
  return entry[target];
}

/** Props accepted by `Icon`. */
export interface IconProps extends StyleProps, FlexChildProps, Props {
  /** Registry icon name. */
  name: string;
  /** Accessible label; icons are decorative without one. */
  label?: string;
  /** Per-name registry overrides. */
  icons?: Record<string, IconForms>;
  id?: string;
}
/** Registry-backed icon; each render target draws its own form. */
export function Icon(props: IconProps): VNode {
  return h('ui:icon', props);
}

/** Props accepted by `IconButton`. */
export interface IconButtonProps extends StyleProps, FlexChildProps, Props {
  /** Registry icon name. */
  icon: string;
  /** Accessible name — the icon alone carries no text, so this is required. */
  label: string;
  onClick?: () => void;
  focused?: boolean;
  disabled?: boolean;
  /** Per-name registry overrides, forwarded to `iconForm`. */
  icons?: Record<string, IconForms>;
  id?: string;
}
/** Icon-only button: a focusable click target whose accessible name comes from `label`, not visible text. */
export function IconButton(props: IconButtonProps): VNode {
  return h('ui:icon-button', props);
}

/** One node of a `FileTree`; `children` left undefined marks a leaf. */
export interface FileTreeNode {
  key: string;
  label: string;
  /** Explicit registry icon name; wins over every extension table. */
  icon?: string;
  children?: FileTreeNode[];
}
/** Props accepted by `FileTree`. */
export interface FileTreeProps extends FlexChildProps, Props {
  nodes: FileTreeNode[];
  expanded: string[];
  selectedKey?: string | null;
  /** Extension → registry icon name (no dot, lowercased), layered over `FILE_ICONS`. */
  icons?: Record<string, string>;
  /** Directory icon names; the icon doubles as the expander. */
  folderIcons?: { open: string; closed: string };
  onToggle?: (key: string) => void;
  onSelect?: (key: string) => void;
  id?: string;
}

/** Built-in extension → icon-name table consulted by `fileIcon` after the user table. */
export const FILE_ICONS: Record<string, string> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  md: 'doc',
  json: 'config',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  lock: 'lock',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
};

/**
 * Resolve a tree node's icon name: an explicit `icon` wins, directories get
 * the folder icons (open variant when `open`), then the file extension maps
 * through the user table and `FILE_ICONS`; anything else is `file`. The
 * result is a registry name — pass it through `iconForm` for a target form.
 */
export function fileIcon(
  node: { label: string; icon?: string; children?: unknown },
  icons?: Record<string, string>,
  open = false,
  folderIcons?: { open: string; closed: string },
): string {
  if (node.icon !== undefined) return node.icon;
  if (node.children !== undefined) {
    return open ? (folderIcons?.open ?? 'folder-open') : (folderIcons?.closed ?? 'folder');
  }
  const dot = node.label.lastIndexOf('.');
  const ext = dot > 0 ? node.label.slice(dot + 1).toLowerCase() : '';
  return icons?.[ext] ?? FILE_ICONS[ext] ?? 'file';
}
/**
 * Tree of expandable directories and selectable rows. Expanding never also
 * selects: the toggle affordance is distinct from the row.
 */
export function FileTree(props: FileTreeProps): VNode {
  return h('ui:file-tree', props);
}

/** Tree expansion state helper for `FileTree`. */
export interface TreeState {
  readonly expanded: Signal<string[]>;
  toggle(key: string): void;
  isExpanded(key: string): boolean;
}
/** Create tree expansion state that survives re-renders. */
export function createTreeState(defaultExpanded: string[] = []): TreeState {
  const expanded = createSignal<string[]>(defaultExpanded);
  return {
    expanded,
    toggle(key: string): void {
      const current = expanded.get();
      expanded.set(
        current.includes(key) ? current.filter((open) => open !== key) : [...current, key],
      );
    },
    isExpanded: (key: string) => expanded.get().includes(key),
  };
}

/** One entry of a `Timeline`. */
export interface TimelineEntry {
  key: string;
  title: string;
  detail?: string;
  variant?: StatusVariant;
}
/** Props accepted by `Timeline`. */
export interface TimelineProps extends FlexChildProps, Props {
  entries: TimelineEntry[];
  id?: string;
}
/** Vertical event list with status-colored markers and details. */
export function Timeline(props: TimelineProps): VNode {
  return h('ui:timeline', props);
}

/** The visible slice a `VirtualScroll` model computed for one paint. */
export interface VirtualWindow {
  /** First item index to render. */
  start: number;
  /** One past the last item index to render. */
  end: number;
  /** Rows of excluded items above the window, rendered as a spacer. */
  topPad: number;
  /** Rows of excluded items below the window, rendered as a spacer. */
  bottomPad: number;
}

/**
 * Scroll model for lists too large to render whole: items get a row-height
 * estimate, corrected per index as real heights are measured, and `window()`
 * yields the slice worth building VNodes for. Only the windowed items exist
 * in the tree — spacers stand in for everything else, so scroll geometry
 * stays exact while memory stays bounded. Lives outside the tree like every
 * other state model.
 */
export class VirtualScroll {
  #estimate: number;
  #count = 0;
  #heights = new Map<number, number>();
  #offset = 0;
  #follow = false;

  constructor(options: { estimate?: number; follow?: boolean } = {}) {
    this.#estimate = Math.max(1, Math.floor(options.estimate ?? 1));
    this.#follow = options.follow === true;
  }

  get count(): number {
    return this.#count;
  }

  /** Current scroll offset in rows from the top of the full list. */
  get offset(): number {
    return this.#offset;
  }

  /** Whether the view sticks to the end as content grows. */
  get follow(): boolean {
    return this.#follow;
  }

  /** Total row height of the list under current estimates. */
  get totalRows(): number {
    let total = 0;
    for (let index = 0; index < this.#count; index++) total += this.#heightOf(index);
    return total;
  }

  #heightOf(index: number): number {
    return this.#heights.get(index) ?? this.#estimate;
  }

  setCount(count: number): void {
    this.#count = Math.max(0, count);
    for (const index of this.#heights.keys()) {
      if (index >= this.#count) this.#heights.delete(index);
    }
  }

  /** Correct one item's estimated height with its measured row count. */
  setHeight(index: number, rows: number): void {
    if (index < 0 || index >= this.#count) return;
    this.#heights.set(index, Math.max(1, Math.floor(rows)));
  }

  #maxOffset(viewportRows: number): number {
    return Math.max(0, this.totalRows - Math.max(1, viewportRows));
  }

  scrollBy(rows: number, viewportRows: number): void {
    this.scrollTo(this.#offset + rows, viewportRows);
  }

  scrollTo(offset: number, viewportRows: number): void {
    const max = this.#maxOffset(viewportRows);
    this.#offset = Math.max(0, Math.min(Math.floor(offset), max));
    this.#follow = this.#offset >= max;
  }

  scrollToEnd(viewportRows: number): void {
    this.#offset = this.#maxOffset(viewportRows);
    this.#follow = true;
  }

  /** Route a wheel event: three rows per notch. Returns true when consumed. */
  handleWheel(event: UiMouseEvent, viewportRows: number): boolean {
    if (event.action !== 'wheel') return false;
    if (event.button === 'wheel-up') {
      this.scrollBy(-3, viewportRows);
      return true;
    }
    if (event.button === 'wheel-down') {
      this.scrollBy(3, viewportRows);
      return true;
    }
    return false;
  }

  /** The slice to render for a viewport, with `overscan` extra items each side. */
  window(viewportRows: number, overscan = 2): VirtualWindow {
    const viewport = Math.max(1, viewportRows);
    if (this.#follow) this.#offset = this.#maxOffset(viewport);
    let start = 0;
    let topPad = 0;
    while (start < this.#count && topPad + this.#heightOf(start) <= this.#offset) {
      topPad += this.#heightOf(start);
      start++;
    }
    let end = start;
    let covered = topPad;
    while (end < this.#count && covered < this.#offset + viewport) {
      covered += this.#heightOf(end);
      end++;
    }
    for (let extra = 0; extra < overscan && start > 0; extra++) {
      start--;
      topPad -= this.#heightOf(start);
    }
    end = Math.min(this.#count, end + overscan);
    let bottomPad = 0;
    for (let index = end; index < this.#count; index++) bottomPad += this.#heightOf(index);
    return { start, end, topPad, bottomPad };
  }
}

/** Props accepted by `VirtualList`. */
export interface VirtualListProps extends StyleProps, FlexChildProps, Props {
  /** Viewport height in rows. */
  height: number;
  /** The window computed by a `VirtualScroll` model for this paint. */
  window: VirtualWindow;
  /** Scroll offset from the same model. */
  offset: number;
  /** Wheel routing, typically `(e) => model.handleWheel(e, height)`. */
  onMouse?: (event: UiMouseEvent) => boolean | void;
  /**
   * Row offset the browser scrolled to. The TUI target ignores this — wheel
   * routing there goes through `onMouse` — but the HTML target has no wheel
   * events of its own; it wires its scroll container to this instead, so
   * scrolling in a browser moves the window server-side.
   */
  onScroll?: (offset: number) => void;
  children?: Child;
}
/**
 * Scrollable viewport over a windowed item slice: the caller builds VNodes
 * only for `window.start..window.end`, and spacers preserve the geometry of
 * everything excluded. Emits the semantic `ui:virtual-list` node; each
 * render target owns its own composition — see `internal:tty/lower` for the
 * terminal's clickable+scrollview shape and `fino:ui/components/html` for
 * the browser's scrollable container.
 */
export function VirtualList(props: VirtualListProps): VNode {
  const { children, ...rest } = props;
  return h('ui:virtual-list', rest, children);
}

/** Props accepted by `Heading`. */
export interface HeadingProps extends StyleProps, FlexChildProps, Props {
  /** Heading level 1-6; defaults to 1. Levels 1-2 render in the accent color. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: Child;
}
/** Section heading. Level 1 additionally draws a rule beneath it. */
export function Heading(props: HeadingProps): VNode {
  return h('ui:heading', props);
}

/** Props accepted by `Bold`. */
export interface BoldProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/**
 * Bold inline emphasis. Compose it as a row sibling of surrounding `Text`
 * (e.g. inside an `HStack`) rather than nesting it inside a `Text` — the
 * terminal's `Text` flattens descendant nodes to one plain styled run, so
 * styling on a `Bold` nested inside it is silently dropped there (see the
 * module guide's Typography section).
 */
export function Bold(props: BoldProps): VNode {
  return h('ui:bold', props);
}

/** Props accepted by `Italic`. */
export interface ItalicProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/** Italic inline emphasis. Compose it as a row sibling, not nested inside a `Text` — see `Bold`. */
export function Italic(props: ItalicProps): VNode {
  return h('ui:italic', props);
}

/** Props accepted by `Link`. */
export interface LinkProps extends FlexChildProps, Props {
  /**
   * Navigation target. On the web this becomes a real `<a href>` — `Link` is
   * the one catalog component allowed to navigate — once the HTML target's
   * `safeHref` scheme allowlist (`http(s):`, `mailto:`, `tel:`, and relative
   * forms) accepts it; anything else, e.g. `javascript:`, renders as text
   * with no `href` attribute rather than a live anchor. In the terminal it is
   * rendered as styled, underlined text (see the module guide for why OSC 8
   * terminal hyperlinks aren't used).
   */
  href?: string;
  /** In-app activation. Wins over `href` when both are given. */
  onActivate?: () => void;
  id?: string;
  children?: Child;
}
/**
 * Link: navigational with `href`, an in-app activator with `onActivate`, or
 * both — see `href` and `onActivate` for how they combine. Compose it as a
 * row sibling, not nested inside a `Text` — see `Bold`.
 */
export function Link(props: LinkProps): VNode {
  return h('ui:link', props);
}

/** Props accepted by `Blockquote`. */
export interface BlockquoteProps extends FlexChildProps, Props {
  id?: string;
  children?: Child;
}
/** Quoted content, set off with a leading gutter rule and dimmed text. */
export function Blockquote(props: BlockquoteProps): VNode {
  return h('ui:blockquote', props);
}

/** Props accepted by `List`. */
export interface ListProps extends FlexChildProps, Props {
  /** Numbered markers instead of bullets. */
  ordered?: boolean;
  /** Item content, one entry per row; entries may be strings or nested VNodes. */
  items: Child[];
  id?: string;
}
/** Bulleted or numbered list, with a hanging indent for wrapped item lines. */
export function List(props: ListProps): VNode {
  return h('ui:list', props);
}

/** Props accepted by `Code`. */
export interface CodeProps extends FlexChildProps, Props {
  code: string;
  /** Highlighting language; unrecognized or omitted languages render plain. */
  language?: string;
  showLineNumbers?: boolean;
  /** Shown in a header bar above the code; also gives `copyable` a home when there is no filename. */
  filename?: string;
  /**
   * Show a copy-to-clipboard affordance. On the web it copies client-side
   * (a server round trip cannot write the clipboard); in the terminal it
   * calls `onCopy` — the lowering only emits nodes, it cannot itself write to
   * the terminal — so pass `onCopy` (e.g. `fino:tty/tui`'s
   * `copyToClipboard`) for the affordance to do anything there.
   */
  copyable?: boolean;
  onCopy?: (code: string) => void;
  id?: string;
}
/**
 * Syntax-highlighted code block. Highlighting reuses the OXC-backed tokens
 * from `fino:format/typescript` for JS/TS/JSX family languages; anything
 * else renders as plain monospace text.
 */
export function Code(props: CodeProps): VNode {
  return h('ui:code', props);
}

/** Props accepted by `InlineCode`. */
export interface InlineCodeProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/** Inline code span. Compose it as a row sibling, not nested inside a `Text` — see `Bold`. */
export function InlineCode(props: InlineCodeProps): VNode {
  return h('ui:inline-code', props);
}

/** Props accepted by `Card`. */
export interface CardProps extends FlexChildProps, Props {
  title?: string;
  subtitle?: string;
  /**
   * Media slot. The web renders a real `<img src alt>` — `src` passes
   * through the HTML target's `safeHref` allowlist the same as a `Link`
   * `href`, since an image URL is just as app-controlled. The terminal
   * cannot paint images, so it paints a dim `[ alt ]` placeholder line
   * instead.
   */
  image?: { src: string; alt: string };
  /** Footer row of control buttons. */
  actions?: Child;
  id?: string;
  children?: Child;
}
/**
 * Content container: an optional media slot, title/subtitle, body, and a
 * footer row of `actions`. A bordered box in the terminal, a real
 * `<article>` on the web.
 */
export function Card(props: CardProps): VNode {
  return h('ui:card', props);
}

/** Trend direction shown by `Stat`. */
export type Trend = 'up' | 'down' | 'flat';

/** Props accepted by `Stat`. */
export interface StatProps extends FlexChildProps, Props {
  label: string;
  value: string;
  hint?: string;
  trend?: Trend;
  id?: string;
}
/**
 * Named statistic: a dim label above a bold value, with an optional trend
 * indicator (`▲`/`▼`/`–`, colored success/danger/muted). The trend glyph
 * itself carries the direction — not just its color — and the web target
 * additionally names it through `aria-label`, so the signal never rests on
 * color alone.
 */
export function Stat(props: StatProps): VNode {
  return h('ui:stat', props);
}

/** Status values shown by `StatusDot`. */
export type StatusDotStatus = 'ok' | 'busy' | 'error' | 'idle' | 'warning';

/** Props accepted by `StatusDot`. */
export interface StatusDotProps extends FlexChildProps, Props {
  status: StatusDotStatus;
  label?: string;
  id?: string;
}
/**
 * Status indicator: a colored `●` plus an optional `label`. On the web the
 * status is always conveyed as text too — the visible `label` when given, an
 * `aria-label` naming the status when not — never color alone.
 */
export function StatusDot(props: StatusDotProps): VNode {
  return h('ui:status-dot', props);
}

/** Props accepted by `EmptyState`. */
export interface EmptyStateProps extends FlexChildProps, Props {
  /** Registry icon name; see `ICONS`/`iconForm`. */
  icon?: string;
  title: string;
  description?: string;
  action?: Child;
  /** Per-name registry overrides, forwarded to `iconForm`. */
  icons?: Record<string, IconForms>;
  id?: string;
}
/**
 * Centered indicator for an empty content area: an optional icon, a title, a
 * dim description, and an optional `action`. Centering is ordinary
 * `justify`/`align` on a `Box` — give it room to fill (`grow`, an explicit
 * `height`, …) for the centering to be visible.
 */
export function EmptyState(props: EmptyStateProps): VNode {
  return h('ui:empty-state', props);
}

/** Props accepted by `HoverCard`. */
export interface HoverCardProps extends Props {
  /** Shown state — the app decides when, like `Tooltip`; there is no hover tracking. */
  open: boolean;
  /** Hit id of the trigger the card anchors beneath. */
  anchorId: string;
  title?: string;
  children?: Child;
}
/**
 * Structured floating card anchored beneath a trigger, built on the same
 * `Layer`/`anchorId` mechanism as `Tooltip` and `Popover`. The three overlays
 * differ in what they carry and how they leave: `Tooltip` is a one-line text
 * hint, `HoverCard` is structured content (a `title` plus arbitrary
 * `children`) with no dismissal of its own — the app drives `open` exactly
 * like `Tooltip` — and `Popover` is interactive content with `onDismiss`
 * wired to Esc and outside clicks.
 */
export function HoverCard(props: HoverCardProps): VNode {
  return h('ui:hover-card', props);
}

/** Props accepted by `FloatingActionBar`. */
export interface FloatingActionBarProps extends Props {
  /**
   * Hit id of the container the bar floats within. `Layer` — the terminal's
   * only overlay primitive — has no notion of "this component's own
   * enclosing container": anchoring always means anchoring to a known hit
   * id, the same mechanism `Popover` and `Tooltip` use for their trigger. Give
   * the container itself an `id` and pass it here.
   */
  anchorId: string;
  placement?: 'bottom-center' | 'bottom-end';
  children?: Child;
}
/**
 * Action bar floating at the bottom of its container (not the viewport) —
 * for affordances like "jump to latest". `Layer`'s placement model has no
 * anchored-center option (only start/end alignment relative to an anchor),
 * so in the terminal `'bottom-center'` renders left-aligned, same as
 * `'bottom-end'` minus the right offset — see `internal:tty/lower`'s
 * `floatingActionBar` composer for the documented gap. The web target
 * centers it for real with flexbox.
 */
export function FloatingActionBar(props: FloatingActionBarProps): VNode {
  return h('ui:floating-action-bar', props);
}

// ---------------------------------------------------------------------------
// Time & pickers
//
// None of these components read a clock — there is no ambient "now". Every
// date/time value crosses the boundary as an ISO string (`YYYY-MM-DD` dates,
// `HH:MM`/`HH:MM:SS` 24h times), never a `Date` object (not portable JSON),
// and the caller supplies "today"/"now" explicitly wherever a component needs
// it. The date/time math below is pure and exported so it is unit-testable
// without rendering anything.
// ---------------------------------------------------------------------------

/** One day cell of a `Calendar` month grid. */
export interface MonthDayCell {
  /** ISO date, `'YYYY-MM-DD'`. */
  date: string;
  /** Day-of-month number, always relative to the cell's own month. */
  day: number;
  /** `false` for leading/trailing days borrowed from the adjacent month. */
  currentMonth: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

// `Date.UTC(year, month, 0)` lands on day 0 of 0-based month index `month`,
// i.e. the last day of the *previous* 0-based month — which, since `month`
// here is 1-based, is exactly the last day of month `month`. Using `Date`
// only for this arithmetic (never `new Date()` with no arguments, which
// would read the clock) keeps leap years and month-length quirks correct
// without hand-rolling a Gregorian table.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse a `'YYYY-MM'` month string into numeric parts. Malformed input falls back to `1970-01`. */
export function parseIsoMonth(month: string): { year: number; month: number } {
  const [y, m] = month.split('-').map(Number);
  const year = Number.isFinite(y) ? y! : 1970;
  const monthNum = Number.isFinite(m) && m! >= 1 && m! <= 12 ? m! : 1;
  return { year, month: monthNum };
}

/** Shift a `'YYYY-MM'` month string by `delta` months; negative moves backward across year boundaries. */
export function shiftMonth(month: string, delta: number): string {
  const { year, month: m } = parseIsoMonth(month);
  const total = year * 12 + (m - 1) + Math.trunc(delta);
  const nextYear = Math.floor(total / 12);
  const nextMonth = ((total % 12) + 12) % 12;
  return `${String(nextYear).padStart(4, '0')}-${pad2(nextMonth + 1)}`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Human-readable month label: `monthLabel(2024, 6) === 'June 2024'`. */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[Math.max(0, Math.min(11, month - 1))]} ${year}`;
}

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Two-letter weekday headers starting from `weekStartsOn` (default Sunday). */
export function weekdayLabels(weekStartsOn: 0 | 1 = 0): string[] {
  return [...WEEKDAY_LABELS.slice(weekStartsOn), ...WEEKDAY_LABELS.slice(0, weekStartsOn)];
}

/**
 * Build the week rows a `Calendar` paints for `year`/`month` (1-12): complete
 * weeks of `MonthDayCell`s, with leading/trailing days borrowed from the
 * adjacent months to pad the first and last rows (`currentMonth: false` on
 * those). Pure and clock-free — every input is explicit, so leap years and
 * month-length boundaries are exercised directly by tests instead of waiting
 * for the calendar to land on them.
 *
 * ```ts no_run
 * monthGrid(2024, 2)[0]; // February 2024 (leap year) starts on a Thursday
 * // → [{ date: '2024-01-28', day: 28, currentMonth: false }, …, { date: '2024-02-01', day: 1, currentMonth: true }, …]
 * ```
 */
export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1 = 0): MonthDayCell[][] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leading = (firstWeekday - weekStartsOn + 7) % 7;
  const thisMonthDays = daysInMonth(year, month);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonthDays = daysInMonth(prevYear, prevMonth);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  const cells: MonthDayCell[] = [];
  for (let i = 0; i < leading; i++) {
    const day = prevMonthDays - leading + 1 + i;
    cells.push({ date: isoDate(prevYear, prevMonth, day), day, currentMonth: false });
  }
  for (let day = 1; day <= thisMonthDays; day++) {
    cells.push({ date: isoDate(year, month, day), day, currentMonth: true });
  }
  let trailingDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({
      date: isoDate(nextYear, nextMonth, trailingDay),
      day: trailingDay,
      currentMonth: false,
    });
    trailingDay++;
  }

  const weeks: MonthDayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Props accepted by `Calendar`. */
export interface CalendarProps extends FlexChildProps, Props {
  /** Displayed month, `'YYYY-MM'`. */
  month: string;
  /** Selected date, `'YYYY-MM-DD'`. */
  selected?: string;
  /** Today's date, `'YYYY-MM-DD'` — supplied by the caller; the component never reads a clock. */
  today?: string;
  weekStartsOn?: 0 | 1;
  onSelect?: (date: string) => void;
  onMonthChange?: (month: string) => void;
  id?: string;
}
/**
 * Month grid of selectable days, with prev/next month controls. Every date
 * the component needs — the displayed month, the selection, and "today" —
 * arrives as an ISO string from the caller; `monthGrid` does the date math.
 */
export function Calendar(props: CalendarProps): VNode {
  return h('ui:calendar', props);
}

/** Props accepted by `DigitalClock`. */
export interface DigitalClockProps extends StyleProps, FlexChildProps, Props {
  /** `'HH:MM'` or `'HH:MM:SS'`, 24h. */
  time: string;
  /** Show the seconds field; default false. Independent of how much precision `time` carries. */
  seconds?: boolean;
  label?: string;
  id?: string;
}
/**
 * Prominent readout of a supplied time. The caller owns the clock: pass a
 * fixed value for a static display, or re-render with a fresh `time` on
 * whatever cadence the app chooses for a live one — there is no self-driven
 * tick inside the component (contrast `Spinner`, which is presentational
 * enough to animate on a frame counter it is handed; a clock is not).
 */
export function DigitalClock(props: DigitalClockProps): VNode {
  return h('ui:digital-clock', props);
}

/** Normalize a time string to `'HH:MM'` or, with `seconds`, `'HH:MM:SS'`. */
export function formatClockTime(time: string, seconds = false): string {
  const [h, m, s] = time.split(':');
  const hh = (h ?? '00').padStart(2, '0');
  const mm = (m ?? '00').padStart(2, '0');
  const ss = (s ?? '00').padStart(2, '0');
  return seconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

/** Props accepted by `DatePicker`. */
export interface DatePickerProps extends Props {
  /** Selected date, `'YYYY-MM-DD'`. */
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (date: string) => void;
  /** Month the popover calendar shows, `'YYYY-MM'`; defaults to `value`'s month, then `'1970-01'`. */
  month?: string;
  onMonthChange?: (month: string) => void;
  /** Today's date, forwarded to the popover `Calendar`. */
  today?: string;
  weekStartsOn?: 0 | 1;
  focused?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Required for anchoring the popover to the trigger, same as `Select`. */
  id: string;
}
/**
 * Date picker: a trigger showing `value` (or `placeholder`) plus a `Calendar`
 * in an anchored `Layer`, mirroring how `Select` composes its popover. The
 * web target renders only a native `<input type="date">` — see the module
 * guide for why the popover calendar is terminal-only.
 */
export function DatePicker(props: DatePickerProps): VNode {
  return h('ui:date-picker', props);
}

/** Numeric hour/minute/second parts of a clock-time string. */
export interface ClockParts {
  hours: number;
  minutes: number;
  seconds: number;
}
/** Parse `'HH:MM'`/`'HH:MM:SS'` into clamped numeric parts. Undefined or malformed input is midnight. */
export function parseClockTime(time: string | undefined): ClockParts {
  if (time === undefined) return { hours: 0, minutes: 0, seconds: 0 };
  const [h, m, s] = time.split(':').map(Number);
  const clamp = (value: number | undefined, max: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value!))) : 0;
  return { hours: clamp(h, 23), minutes: clamp(m, 59), seconds: clamp(s, 59) };
}
/** Format numeric clock parts back to `'HH:MM'` or, with `seconds` given, `'HH:MM:SS'`. */
export function formatTimeParts(hours: number, minutes: number, seconds?: number): string {
  const base = `${pad2(hours)}:${pad2(minutes)}`;
  return seconds !== undefined ? `${base}:${pad2(seconds)}` : base;
}

/**
 * A `size`-wide window of values from a `max`-valued modular ring (0..max-1),
 * centered on `current`. Paints a scrollable-looking column of a few
 * neighboring hours/minutes/seconds without holding any scroll state — the
 * window is recomputed from the current value on every render, the same
 * "state lives outside the tree" rule the rest of the catalog follows.
 *
 * ```ts no_run
 * timeColumnWindow(0, 24, 5); // [22, 23, 0, 1, 2] — wraps around midnight
 * ```
 */
export function timeColumnWindow(current: number, max: number, size = 5): number[] {
  const half = Math.floor(size / 2);
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    out.push((((current - half + i) % max) + max) % max);
  }
  return out;
}

/** Props accepted by `TimePicker`. */
export interface TimePickerProps extends Props {
  /** Selected time, `'HH:MM'` or `'HH:MM:SS'`. */
  value?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (time: string) => void;
  /** Minute increment for the minute column/arrow-key stepping; default 1. */
  step?: number;
  seconds?: boolean;
  focused?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Required for anchoring the popover to the trigger, same as `Select`. */
  id: string;
}
/**
 * Time picker: a trigger plus an anchored popover of hour/minute(/second)
 * columns, mirroring `Select`/`DatePicker`. The web target renders only a
 * native `<input type="time" step>`.
 */
export function TimePicker(props: TimePickerProps): VNode {
  return h('ui:time-picker', props);
}

/** Parse `'#rrggbb'` (with or without the leading `#`) into 0-255 RGB parts, or `null` if malformed. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (match === null) return null;
  const value = match[1]!;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** Props accepted by `ColorPicker`. */
export interface ColorPickerProps extends Props {
  /** `'#rrggbb'`. */
  value: string;
  onChange: (value: string) => void;
  swatches?: string[];
  /** Popover mode when given alongside `onOpenChange` and `id`; otherwise the swatch grid renders inline. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
}
/**
 * Color picker: a swatch preview and hex readout, with an optional
 * `swatches` palette to pick from — inline by default, or behind a
 * trigger/popover (like `Select`) when `open`/`onOpenChange`/`id` are all
 * given. The terminal paints swatches with real RGB when the terminal
 * reports truecolor support, falling back to the nearest of the 256-color
 * palette otherwise (`fino:tty/style`'s `supportsTruecolor`/`nearestAnsi256`)
 * — detected in the lowering, never inside this component. The web target
 * renders a native `<input type="color">` alongside the swatch row.
 */
export function ColorPicker(props: ColorPickerProps): VNode {
  return h('ui:color-picker', props);
}
