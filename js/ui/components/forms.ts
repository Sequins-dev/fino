/**
 * internal:ui/components/forms — the form controls: buttons, toggles, and
 * text/number entry.
 *
 * @internal
 */
import { h, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  changeAttrs,
  handlerOf,
  register,
} from 'internal:ui/components/html-runtime';
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
export function Button(all: ButtonProps): VNode {
  const { children = [], ...props } = all as ButtonProps & { children?: NormalizedChild[] };
  const { label, onClick, disabled, id } = props;
  const click = handlerOf<() => void>(onClick);
  const enabled = disabled !== true && click !== undefined;
  if (actionsActive() && enabled) {
    const act = register(() => click!());
    return actionForm(
      {},
      h('button', { className: 'ui-button', name: 'do', value: act, ...idAttr(id) }, label),
    );
  }
  const attrs: Props = { className: 'ui-button', type: 'button', ...idAttr(id) };
  if (!enabled) attrs.disabled = true;
  return h('button', attrs, label);
}

// Checkbox, Switch and Radio are one control on the web with three
// presentations, so they share a builder rather than repeating it.
function choiceHtml(kind: 'checkbox' | 'radio', node: VNode): VNode {
  const props = node.props as CheckboxProps & RadioProps & SwitchProps;
  const isSwitch = node.type === 'ui:switch';
  const checked =
    kind === 'checkbox'
      ? isSwitch
        ? props.on === true
        : props.checked === true
      : props.selected === true;
  const change =
    kind === 'radio'
      ? handlerOf<() => void>(props.onSelect)
      : handlerOf<(next: boolean) => void>(props.onChange);
  const enabled = props.disabled !== true && change !== undefined;
  const input: Props = { type: kind, className: isSwitch ? 'ui-switch' : 'ui-check' };
  if (checked) input.checked = true;
  const control = (field: Props): VNode =>
    h(
      'label',
      {
        className: `ui-choice${props.disabled === true ? ' is-disabled' : ''}`,
        ...idAttr(props.id),
      },
      h('input', field),
      props.label !== undefined ? h('span', null, props.label) : null,
    );
  if (actionsActive() && enabled) {
    const act =
      kind === 'radio'
        ? register(() => (change as () => void)())
        : register((value) => (change as (next: boolean) => void)(value === 'true'));
    const field: Props = { ...input, name: 'value', value: 'true', ...changeAttrs() };
    return actionForm(
      { act, change: true },
      ...(kind === 'checkbox'
        ? [h('input', { type: 'hidden', name: 'value', value: 'false' })]
        : []),
      control(field),
    );
  }
  if (!enabled) input.disabled = true;
  return control(input);
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
  return choiceHtml('checkbox', { type: 'ui:checkbox', props, children: [], key: null });
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
  return choiceHtml('radio', { type: 'ui:radio', props, children: [], key: null });
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
export function RadioGroup(all: RadioGroupProps): VNode {
  const { children = [], ...props } = all as RadioGroupProps & { children?: NormalizedChild[] };
  const { value, options, onChange, id } = props;
  const change = handlerOf<(key: string) => void>(onChange);
  const interactive = actionsActive() && change !== undefined;
  const name = interactive ? 'value' : typeof id === 'string' ? id : 'ui-radio';
  const group = h(
    'div',
    { className: 'ui-radio-group', role: 'radiogroup', ...idAttr(id) },
    ...options.map((option) => {
      const input: Props = { type: 'radio', className: 'ui-check', name, value: option.key };
      if (option.key === value) input.checked = true;
      if (option.disabled === true || change === undefined) input.disabled = true;
      else if (interactive) Object.assign(input, changeAttrs());
      return h(
        'label',
        { className: `ui-choice${option.disabled === true ? ' is-disabled' : ''}` },
        h('input', input),
        h('span', null, option.label),
      );
    }),
  );
  if (interactive) {
    const act = register((key) => {
      if (typeof key === 'string' && key.length > 0) change!(key);
    });
    return actionForm({ act, change: true }, group);
  }
  return group;
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
  return choiceHtml('checkbox', { type: 'ui:switch', props, children: [], key: null });
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
export function TextInput(all: TextInputProps): VNode {
  const { children = [], ...props } = all as TextInputProps & { children?: NormalizedChild[] };
  const { value, placeholder, onChange, onSubmit, password, id } = props;
  const change = handlerOf<(value: string, caret?: number) => void>(onChange);
  const submit = handlerOf<(value: string) => void>(onSubmit);
  const attrs: Props = {
    className: 'ui-field',
    type: password === true ? 'password' : 'text',
    value: value ?? '',
    ...idAttr(id),
  };
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  if (actionsActive() && (change !== undefined || submit !== undefined)) {
    // Change-submit and Enter-submit are the same GET round trip; Enter's
    // natural form submission is what makes onSubmit win when both exist.
    const act = register((next) => {
      const text = next ?? '';
      if (submit !== undefined) submit(text);
      else change!(text);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined && submit === undefined) attrs.disabled = true;
  return h('input', attrs);
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
export function TextArea(all: TextAreaProps): VNode {
  const { children = [], ...props } = all as TextAreaProps & { children?: NormalizedChild[] };
  const { value, rows, onChange, id } = props;
  const change = handlerOf<(value: string, caret?: number) => void>(onChange);
  const attrs: Props = { className: 'ui-field', rows: String(rows ?? 4), ...idAttr(id) };
  if (actionsActive() && change !== undefined) {
    const act = register((next) => change(next ?? ''));
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('textarea', attrs, value ?? ''));
  }
  if (change === undefined) attrs.disabled = true;
  return h('textarea', attrs, value ?? '');
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
export function NumberInput(all: NumberInputProps): VNode {
  const { children = [], ...props } = all as NumberInputProps & { children?: NormalizedChild[] };
  const { value, min, max, step, onChange, disabled, id } = props;
  const change = handlerOf<(value: number) => void>(onChange);
  const attrs: Props = {
    className: 'ui-field',
    type: 'number',
    value: String(value),
    ...idAttr(id),
  };
  if (min !== undefined) attrs.min = String(min);
  if (max !== undefined) attrs.max = String(max);
  if (step !== undefined) attrs.step = String(step);
  if (actionsActive() && change !== undefined && disabled !== true) {
    const act = register((next) => {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) change(parsed);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined || disabled === true) attrs.disabled = true;
  return h('input', attrs);
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
export function Slider(all: SliderProps): VNode {
  const { children = [], ...props } = all as SliderProps & { children?: NormalizedChild[] };
  const { value, min, max, step, onChange, orientation, disabled, id } = props;
  const change = handlerOf<(value: number) => void>(onChange);
  const attrs: Props = {
    className: 'ui-field ui-slider',
    type: 'range',
    value: String(value),
    min: String(min ?? 0),
    max: String(max ?? 100),
    ...idAttr(id),
  };
  if (step !== undefined) attrs.step = String(step);
  if (orientation === 'vertical') attrs.style = { writingMode: 'vertical-lr', direction: 'rtl' };
  if (actionsActive() && change !== undefined && disabled !== true) {
    const act = register((next) => {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) change(parsed);
    });
    attrs.name = 'value';
    Object.assign(attrs, changeAttrs());
    return actionForm({ act, change: true }, h('input', attrs));
  }
  if (change === undefined || disabled === true) attrs.disabled = true;
  return h('input', attrs);
}
