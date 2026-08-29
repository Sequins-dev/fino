/** Terminal lowerings for form components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { Box, Clickable, Input, Text } from 'fino:ui/components';
import type { UiKeyEvent, UiMouseEvent } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import {
  Button,
  Checkbox,
  NumberInput,
  Radio,
  RadioGroup,
  Slider,
  Switch,
  TextArea,
  TextInput,
  clampNumber,
  numberAtFraction,
  numericRange,
  stepNumber,
} from 'internal:ui/components/forms';
import type { TextControlProps } from 'internal:ui/components/forms';
import { applyTextAreaEdit, applyTextEdit } from 'internal:ui/components/text-edit';
import type { TextEditState } from 'internal:ui/components/text-edit';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(Button, 'tui', (props) => {
  const { label, onClick, focused, disabled, ...rest } = props;
  const inert = disabled === true || onClick === undefined;
  return h(
    Clickable,
    { ...rest, onClick, disabled: inert } as Props,
    h(
      Text,
      { style: inert ? [styles.dim] : focused ? [styles.bold, styles.inverse] : [] },
      `[ ${label} ]`,
    ),
  );
});

function choiceTui(
  rest: Props,
  label: string | undefined,
  disabled: boolean,
  glyph: string,
  activate: (() => void) | undefined,
  style: Props['style'],
): VNode {
  return h(
    Clickable,
    { ...rest, direction: 'row', gap: 1, onClick: activate, disabled } as Props,
    h(Text, { style }, glyph),
    label === undefined ? null : h(Text, { dim: disabled }, label),
  );
}

mapComponentLowering(Checkbox, 'tui', (props) => {
  const { checked, label, onChange, focused, disabled, ...rest } = props;
  const inert = disabled === true || onChange === undefined;
  return choiceTui(
    rest as Props,
    label,
    inert,
    checked ? '[x]' : '[ ]',
    inert ? undefined : () => onChange!(!checked),
    inert ? [styles.dim] : focused ? [styles.bold, styles.accent] : [],
  );
});

mapComponentLowering(Radio, 'tui', (props) => {
  const { selected, label, onSelect, focused, disabled, ...rest } = props;
  const inert = disabled === true || onSelect === undefined;
  return choiceTui(
    rest as Props,
    label,
    inert,
    selected ? '●' : '○',
    onSelect,
    inert ? [styles.dim] : focused ? [styles.bold, styles.accent] : [],
  );
});

mapComponentLowering(Switch, 'tui', (props) => {
  const { on, label, onChange, focused, disabled, ...rest } = props;
  const inert = disabled === true || onChange === undefined;
  return choiceTui(
    rest as Props,
    label,
    inert,
    on ? '──●' : '●──',
    inert ? undefined : () => onChange!(!on),
    inert
      ? [styles.dim]
      : on
        ? [styles.success, ...(focused ? [styles.bold] : [])]
        : [styles.muted, ...(focused ? [styles.bold] : [])],
  );
});

mapComponentLowering(RadioGroup, 'tui', (props) => {
  const { value, options, onChange, direction, gap, focusedKey, disabled, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: direction ?? 'column', gap: gap ?? 0 } as Props,
    ...options.map((option) =>
      h(Radio, {
        key: option.key,
        id: typeof props.id === 'string' ? `${props.id}:${option.key}` : undefined,
        selected: option.key === value,
        label: option.label,
        disabled: disabled === true || option.disabled === true,
        focused: option.key === focusedKey,
        onSelect:
          onChange === undefined || disabled === true || option.disabled === true
            ? undefined
            : () => onChange(option.key),
      }),
    ),
  );
});

function editKeyHandler(
  props: TextControlProps,
  reduce: (state: TextEditState, event: UiKeyEvent) => TextEditState | null,
  submit: (event: UiKeyEvent) => boolean,
): ((event: UiKeyEvent) => boolean | void) | undefined {
  const { value, caret, selection, onChange, onKey, onSubmit } = props;
  if (onChange === undefined && onSubmit === undefined) return onKey;
  return (event) => {
    if (onKey?.(event) === true) return true;
    if (submit(event)) {
      if (onSubmit === undefined) return false;
      onSubmit(value);
      return true;
    }
    if (onChange === undefined) return false;
    const next = reduce({ value, caret: caret ?? value.length, selection }, event);
    if (next === null) return false;
    onChange(next.value, next.caret, next.selection);
    return true;
  };
}

mapComponentLowering(TextInput, 'tui', (props) => {
  const {
    value,
    placeholder,
    caret,
    selection,
    focused,
    password,
    disabled,
    onChange: _onChange,
    onSubmit: _onSubmit,
    onKey: _onKey,
    ...rest
  } = props;
  const onKey = editKeyHandler(
    props,
    applyTextEdit,
    (event) => event.key === 'enter' && !event.ctrl && !event.alt,
  );
  return h(
    Clickable,
    { ...rest, onKey, disabled: disabled === true || onKey === undefined } as Props,
    h(Input, {
      value: password === true ? '•'.repeat(value.length) : value,
      placeholder,
      caret,
      selection,
      focused,
    }),
  );
});

mapComponentLowering(TextArea, 'tui', (props) => {
  const {
    value,
    caret,
    selection,
    rows,
    focused,
    disabled,
    onChange: _onChange,
    onSubmit: _onSubmit,
    onKey: _onKey,
    ...rest
  } = props;
  const onKey = editKeyHandler(
    props,
    applyTextAreaEdit,
    (event) => event.key === 'enter' && event.ctrl === true && !event.alt,
  );
  return h(
    Clickable,
    { ...rest, onKey, disabled: disabled === true || onKey === undefined } as Props,
    h(
      Box,
      { border: true, paddingX: 1, height: (rows ?? 4) + 2 },
      h(
        Text,
        { wrap: false, caret: focused === true ? (caret ?? value.length) : undefined },
        value,
      ),
    ),
  );
});

mapComponentLowering(NumberInput, 'tui', (props) => {
  const { value, min, max, step, onChange, focused, disabled, ...rest } = props;
  const quantum = Number.isFinite(step) && step! > 0 ? step! : 1;
  const enabled = onChange !== undefined && disabled !== true;
  const canDecrease = enabled && (min === undefined || value > min);
  const canIncrease = enabled && (max === undefined || value < max);
  const change = (delta: number): void => onChange!(stepNumber(value, delta, min, max));
  const onKey = enabled
    ? (event: UiKeyEvent): boolean => {
        if (event.ctrl || event.alt) return false;
        if (event.key === 'left' || event.key === 'down') {
          change(-quantum);
          return true;
        }
        if (event.key === 'right' || event.key === 'up') {
          change(quantum);
          return true;
        }
        return false;
      }
    : undefined;
  return h(
    Clickable,
    { ...rest, direction: 'row', gap: 1, disabled: !enabled, onKey } as Props,
    h(
      Clickable,
      {
        id: typeof props.id === 'string' ? `${props.id}:dec` : undefined,
        focusable: false,
        disabled: !canDecrease,
        onClick: canDecrease ? () => change(-quantum) : undefined,
      },
      h(Text, { style: canDecrease ? [styles.accent] : [styles.dim] }, '‹'),
    ),
    h(Text, { style: disabled ? [styles.dim] : focused ? [styles.bold] : [] }, String(value)),
    h(
      Clickable,
      {
        id: typeof props.id === 'string' ? `${props.id}:inc` : undefined,
        focusable: false,
        disabled: !canIncrease,
        onClick: canIncrease ? () => change(quantum) : undefined,
      },
      h(Text, { style: canIncrease ? [styles.accent] : [styles.dim] }, '›'),
    ),
  );
});

mapComponentLowering(Slider, 'tui', (props) => {
  const { value, step, onChange, orientation, width, focused, disabled, ...rest } = props;
  const range = numericRange(props.min, props.max);
  const quantum = Number.isFinite(step) && step! > 0 ? step! : 1;
  const vertical = orientation === 'vertical';
  const cells = Math.max(3, Math.floor(width ?? (vertical ? 8 : 20)));
  const span = Math.max(Number.EPSILON, range.max - range.min);
  const fraction = (clampNumber(value, range.min, range.max) - range.min) / span;
  const handleAt = Math.round(fraction * (cells - 1));
  const enabled = onChange !== undefined && disabled !== true;
  const onMouse = enabled
    ? (event: UiMouseEvent): boolean => {
        if (event.action !== 'press' && event.action !== 'drag') return false;
        const local = vertical ? event.localY : event.localX;
        if (local === undefined) return false;
        const at = vertical ? 1 - local / (cells - 1) : local / (cells - 1);
        onChange!(numberAtFraction(at, range.min, range.max, quantum));
        return true;
      }
    : undefined;
  const onKey = enabled
    ? (event: UiKeyEvent): boolean => {
        if (event.ctrl || event.alt) return false;
        if (event.key === 'left' || event.key === 'down') {
          onChange!(stepNumber(value, -quantum, range.min, range.max));
          return true;
        }
        if (event.key === 'right' || event.key === 'up') {
          onChange!(stepNumber(value, quantum, range.min, range.max));
          return true;
        }
        return false;
      }
    : undefined;
  const track = vertical
    ? Array.from({ length: cells }, (_, row) => (cells - 1 - row === handleAt ? '●' : '│')).join(
        '\n',
      )
    : Array.from({ length: cells }, (_, column) => (column === handleAt ? '●' : '─')).join('');
  return h(
    Clickable,
    {
      ...rest,
      direction: vertical ? 'column' : undefined,
      disabled: !enabled,
      onMouse,
      onKey,
    } as Props,
    h(Text, { style: disabled ? [styles.dim] : focused ? [styles.accent] : [] }, track),
  );
});
