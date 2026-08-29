/**
 * Form component definitions and target-neutral numeric behavior.
 *
 * Components in this module only describe intent. HTML and terminal modules
 * own native markup, painting, and event routing.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import type {
  Direction,
  FlexChildProps,
  StyleProps,
  TextSelection,
  UiKeyEvent,
} from 'fino:ui/components';

/** Props shared by focusable form controls. */
export interface FormControlProps extends StyleProps, FlexChildProps, Props {
  /** Whether the terminal target paints the focused presentation. */
  focused?: boolean;
  /** Whether interaction is disabled. */
  disabled?: boolean;
}

/** Props accepted by {@link Button}. */
export interface ButtonProps extends FormControlProps {
  /** Visible action label. */
  label: string;
  /** Called when the button is activated. */
  onClick?: () => void;
}

/** Push button. */
export function Button(props: ButtonProps): VNode {
  return h('ui:button', props);
}

/** Props accepted by {@link Checkbox}. */
export interface CheckboxProps extends FormControlProps {
  /** Controlled checked state. */
  checked: boolean;
  /** Optional visible label. */
  label?: string;
  /** Called with the next checked state. */
  onChange?: (checked: boolean) => void;
}

/** Boolean checkbox. */
export function Checkbox(props: CheckboxProps): VNode {
  return h('ui:checkbox', props);
}

/** Props accepted by {@link Radio}. */
export interface RadioProps extends FormControlProps {
  /** Whether this option is selected. */
  selected: boolean;
  /** Optional visible label. */
  label?: string;
  /** Called when the option is selected. */
  onSelect?: () => void;
}

/** Single radio option. */
export function Radio(props: RadioProps): VNode {
  return h('ui:radio', props);
}

/** One option rendered by {@link RadioGroup}. */
export interface RadioOption {
  /** Stable submitted value. */
  key: string;
  /** Visible option label. */
  label: string;
  /** Whether this option is disabled. */
  disabled?: boolean;
}

/** Props accepted by {@link RadioGroup}. */
export interface RadioGroupProps extends StyleProps, FlexChildProps, Props {
  /** Controlled selected option key. */
  value: string;
  /** Ordered option definitions. */
  options: RadioOption[];
  /** Called with the selected option key. */
  onChange?: (key: string) => void;
  /** Terminal layout direction; defaults to `column`. */
  direction?: Direction;
  /** Space between options. */
  gap?: number;
  /** Option key painted as focused by the terminal target. */
  focusedKey?: string;
  /** Whether interaction is disabled for the whole group. */
  disabled?: boolean;
}

/** Controlled radio set rendered from an option list. */
export function RadioGroup(props: RadioGroupProps): VNode {
  return h('ui:radio-group', props);
}

/** Props accepted by {@link Switch}. */
export interface SwitchProps extends FormControlProps {
  /** Controlled on/off state. */
  on: boolean;
  /** Optional visible label. */
  label?: string;
  /** Called with the next on/off state. */
  onChange?: (on: boolean) => void;
}

/** Boolean switch with a distinct presentation from a checkbox. */
export function Switch(props: SwitchProps): VNode {
  return h('ui:switch', props);
}

/** Props shared by editable text controls. */
export interface TextControlProps extends FormControlProps {
  /** Controlled text value. */
  value: string;
  /** Character offset of the caret. */
  caret?: number;
  /** Active selection; the caret is the moving head. */
  selection?: TextSelection | null;
  /** Called after editing with the complete next edit state. */
  onChange?: (value: string, caret?: number, selection?: TextSelection | null) => void;
  /** Called by the target's explicit submit gesture. */
  onSubmit?: (value: string) => void;
  /** Raw key hook consulted before built-in terminal editing. */
  onKey?: (event: UiKeyEvent) => boolean | void;
}

/** Props accepted by {@link TextInput}. */
export interface TextInputProps extends TextControlProps {
  /** Text shown while `value` is empty. */
  placeholder?: string;
  /** Mask presentation without changing the controlled value. */
  password?: boolean;
}

/** Single-line editable text field. */
export function TextInput(props: TextInputProps): VNode {
  return h('ui:text-input', props);
}

/** Props accepted by {@link TextArea}. */
export interface TextAreaProps extends TextControlProps {
  /** Visible text rows; defaults to four. */
  rows?: number;
}

/** Multi-line editable text field. */
export function TextArea(props: TextAreaProps): VNode {
  return h('ui:text-area', props);
}

/** Props accepted by {@link NumberInput}. */
export interface NumberInputProps extends FormControlProps {
  /** Controlled numeric value. */
  value: number;
  /** Inclusive minimum. */
  min?: number;
  /** Inclusive maximum. */
  max?: number;
  /** Increment per step; defaults to one. */
  step?: number;
  /** Called with a finite, clamped value. */
  onChange?: (value: number) => void;
}

/** Numeric stepper. */
export function NumberInput(props: NumberInputProps): VNode {
  return h('ui:number-input', props);
}

/** Props accepted by {@link Slider}. */
export interface SliderProps extends FormControlProps {
  /** Controlled numeric value. */
  value: number;
  /** Inclusive minimum; defaults to zero. */
  min?: number;
  /** Inclusive maximum; defaults to 100. */
  max?: number;
  /** Increment per step; defaults to one. */
  step?: number;
  /** Called with a finite, stepped, clamped value. */
  onChange?: (value: number) => void;
  /** Track orientation; defaults to horizontal. */
  orientation?: 'horizontal' | 'vertical';
  /** Track length in cells or rows; defaults to 20 or eight. */
  width?: number;
}

/** Range slider. */
export function Slider(props: SliderProps): VNode {
  return h('ui:slider', props);
}

/** Normalize possibly reversed or non-finite numeric range inputs. */
export function numericRange(min?: number, max?: number): { min: number; max: number } {
  const start = Number.isFinite(min) ? min! : 0;
  const end = Number.isFinite(max) ? max! : 100;
  return start <= end ? { min: start, max: end } : { min: end, max: start };
}

/** Clamp a value to optional finite bounds. */
export function clampNumber(value: number, min?: number, max?: number): number {
  let next = value;
  if (Number.isFinite(max)) next = Math.min(next, max!);
  if (Number.isFinite(min)) next = Math.max(next, min!);
  return next;
}

/** Step a numeric value and clamp it to its bounds. */
export function stepNumber(value: number, delta: number, min?: number, max?: number): number {
  return clampNumber(value + delta, min, max);
}

/** Map a range fraction to its nearest valid step. */
export function numberAtFraction(fraction: number, min: number, max: number, step = 1): number {
  const span = max - min;
  if (span <= 0) return min;
  const raw = min + Math.max(0, Math.min(1, fraction)) * span;
  const quantum = Number.isFinite(step) && step > 0 ? step : 1;
  return clampNumber(min + Math.round((raw - min) / quantum) * quantum, min, max);
}
