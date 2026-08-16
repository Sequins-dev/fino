/**
 * internal:ui/components/forms — the form controls: buttons, toggles, and
 * text/number entry.
 *
 * @internal
 */
import { h, type Props, type VNode } from 'fino:ui';
import type {
  Direction,
  FlexChildProps,
  StyleProps,
  TextSelection,
  UiKeyEvent,
} from 'internal:ui/components/primitives';

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
