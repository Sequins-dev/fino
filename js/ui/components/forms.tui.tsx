/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/forms.tui — terminal forms for buttons, toggles, and text entry.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { Box, Clickable, Input, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { applyTextAreaEdit, applyTextEdit } from 'internal:ui/components/text-edit';
import { Button, NumberInput, RadioGroup, Slider, TextArea, TextInput , Checkbox, Radio, Switch } from 'internal:ui/components/forms';
import type {
  CheckboxProps,
  RadioProps,
  SwitchProps,
  ButtonProps,
  NumberInputProps,
  RadioGroupProps,
  SliderProps,
  TextAreaProps,
  TextInputProps,
} from 'internal:ui/components/forms';

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (max !== undefined) out = Math.min(out, max);
  if (min !== undefined) out = Math.max(out, min);
  return out;
}

mapRenderTargetLowering(Button, 'tui', (all: ButtonProps): VNode => {
  const { children = [], ...props } = all as ButtonProps & { children?: NormalizedChild[] };
  const { label, onClick, focused, disabled, id, ...rest } = props;
  return (
    <Clickable id={id} onClick={onClick} disabled={disabled} {...rest}>
      <Text
        style={disabled ? [styles.dim] : focused ? [styles.bold, styles.inverse] : []}
      >{`[ ${label} ]`}</Text>
    </Clickable>
  );
});

mapRenderTargetLowering(RadioGroup, 'tui', (all: RadioGroupProps): VNode => {
  const { children = [], ...props } = all as RadioGroupProps & { children?: NormalizedChild[] };
  const { value, options, onChange, direction, gap, focusedKey, id, ...rest } =
    props;
  return (
    <Box id={id} direction={direction ?? 'column'} gap={gap ?? 0} {...rest}>
      {options.map((option) => (
        <Radio
          key={option.key}
          id={id !== undefined ? `${id}:${option.key}` : undefined}
          selected={option.key === value}
          label={option.label}
          disabled={option.disabled}
          focused={option.key === focusedKey}
          onSelect={onChange ? () => onChange(option.key) : undefined}
        />
      ))}
    </Box>
  );
});

mapRenderTargetLowering(TextInput, 'tui', (all: TextInputProps): VNode => {
  const { children = [], ...props } = all as TextInputProps & { children?: NormalizedChild[] };
  const {
    value,
    placeholder,
    caret,
    selection,
    focused,
    onKey,
    onChange,
    onSubmit,
    password,
    id,
    ...rest
  } = props;
  const editKey =
    onChange !== undefined || onSubmit !== undefined
      ? (event: Parameters<NonNullable<TextInputProps['onKey']>>[0]): boolean | void => {
          if (onKey?.(event) === true) return true;
          if (event.key === 'enter' && !event.ctrl && !event.alt) {
            if (onSubmit === undefined) return false;
            onSubmit(value);
            return true;
          }
          if (onChange === undefined) return false;
          const next = applyTextEdit({ value, caret: caret ?? value.length, selection }, event);
          if (next === null) return false;
          onChange(next.value, next.caret, next.selection);
          return true;
        }
      : onKey;
  // Masking happens only at paint: the caret and selection indices are
  // computed against the real `value`, so a same-length run of `•` keeps
  // that math correct without the reducer ever seeing the masked form.
  const shown = password === true ? '•'.repeat(value.length) : value;
  return (
    <Clickable id={id} onKey={editKey} {...rest}>
      <Input
        value={shown}
        placeholder={placeholder}
        caret={caret}
        selection={selection}
        focused={focused}
      />
    </Clickable>
  );
});

mapRenderTargetLowering(TextArea, 'tui', (all: TextAreaProps): VNode => {
  const { children = [], ...props } = all as TextAreaProps & { children?: NormalizedChild[] };
  const { value, caret, selection, rows, focused, onChange, onSubmit, onKey, id, ...rest } =
    props;
  const editKey =
    onChange !== undefined || onSubmit !== undefined
      ? (event: Parameters<NonNullable<TextAreaProps['onKey']>>[0]): boolean | void => {
          if (onKey?.(event) === true) return true;
          if (event.key === 'enter' && event.ctrl === true && !event.alt) {
            if (onSubmit === undefined) return false;
            onSubmit(value);
            return true;
          }
          if (onChange === undefined) return false;
          const next = applyTextAreaEdit({ value, caret: caret ?? value.length, selection }, event);
          if (next === null) return false;
          onChange(next.value, next.caret, next.selection);
          return true;
        }
      : onKey;
  return (
    <Clickable id={id} onKey={editKey} {...rest}>
      <Box border paddingX={1} height={(rows ?? 4) + 2}>
        <Text wrap={false} caret={focused === true ? (caret ?? value.length) : undefined}>
          {value}
        </Text>
      </Box>
    </Clickable>
  );
});

mapRenderTargetLowering(NumberInput, 'tui', (all: NumberInputProps): VNode => {
  const { children = [], ...props } = all as NumberInputProps & { children?: NormalizedChild[] };
  const { value, min, max, step, onChange, focused, disabled, id, ...rest } =
    props;
  const s = step ?? 1;
  const canDec = onChange !== undefined && disabled !== true && (min === undefined || value > min);
  const canInc = onChange !== undefined && disabled !== true && (max === undefined || value < max);
  const stepBy = (delta: number): void => onChange!(clampNumber(value + delta, min, max));
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onKey={
        onChange !== undefined && disabled !== true
          ? (event) => {
              if (event.ctrl || event.alt) return false;
              if (event.key === 'left' || event.key === 'down') {
                stepBy(-s);
                return true;
              }
              if (event.key === 'right' || event.key === 'up') {
                stepBy(s);
                return true;
              }
              return false;
            }
          : undefined
      }
      {...rest}
    >
      <Clickable
        id={id !== undefined ? `${id}:dec` : undefined}
        focusable={false}
        disabled={!canDec}
        onClick={canDec ? () => stepBy(-s) : undefined}
      >
        <Text style={canDec ? [styles.accent] : [styles.dim]}>‹</Text>
      </Clickable>
      <Text style={disabled === true ? [styles.dim] : focused === true ? [styles.bold] : []}>
        {String(value)}
      </Text>
      <Clickable
        id={id !== undefined ? `${id}:inc` : undefined}
        focusable={false}
        disabled={!canInc}
        onClick={canInc ? () => stepBy(s) : undefined}
      >
        <Text style={canInc ? [styles.accent] : [styles.dim]}>›</Text>
      </Clickable>
    </Clickable>
  );
});

mapRenderTargetLowering(Slider, 'tui', (all: SliderProps): VNode => {
  const { children = [], ...props } = all as SliderProps & { children?: NormalizedChild[] };
  const { value, min, max, step, onChange, orientation, width, focused, disabled, id, ...rest } =
    props;
  const lo = min ?? 0;
  const hi = max ?? 100;
  const s = step ?? 1;
  const span = Math.max(1e-9, hi - lo);
  const vertical = orientation === 'vertical';
  const cells = Math.max(3, width ?? (vertical ? 8 : 20));
  const fraction = Math.max(0, Math.min(1, (clampNumber(value, lo, hi) - lo) / span));
  const handleAt = Math.round(fraction * (cells - 1));
  const enabled = onChange !== undefined && disabled !== true;
  const commit = (frac: number): void => {
    const raw = lo + Math.max(0, Math.min(1, frac)) * span;
    onChange!(clampNumber(Math.round(raw / s) * s, lo, hi));
  };
  const onMouse = enabled
    ? (event: UiMouseEvent): boolean => {
        if (event.action !== 'press' && event.action !== 'drag') return false;
        const local = vertical ? event.localY : event.localX;
        if (local === undefined) return false;
        commit(vertical ? 1 - local / (cells - 1) : local / (cells - 1));
        return true;
      }
    : undefined;
  const onKey = enabled
    ? (event: UiKeyEvent): boolean => {
        if (event.ctrl || event.alt) return false;
        if (event.key === 'left' || event.key === 'down') {
          onChange!(clampNumber(value - s, lo, hi));
          return true;
        }
        if (event.key === 'right' || event.key === 'up') {
          onChange!(clampNumber(value + s, lo, hi));
          return true;
        }
        return false;
      }
    : undefined;
  const trackStyle = disabled === true ? [styles.dim] : focused === true ? [styles.accent] : [];
  if (vertical) {
    // One `Text` spanning the whole column, not a `Text` per row: a mouse
    // event's `localY` is relative to the deepest node it hit, so a stack of
    // one-row nodes reports 0 for every row and every click reads as the top
    // of the track. The horizontal track is a single node for the same reason.
    const column = Array.from({ length: cells }, (_, row) =>
      cells - 1 - row === handleAt ? '●' : '│',
    ).join('\n');
    return (
      <Clickable
        id={id}
        direction="column"
        disabled={disabled}
        onMouse={onMouse}
        onKey={onKey}
        {...rest}
      >
        <Text style={trackStyle}>{column}</Text>
      </Clickable>
    );
  }
  const track = Array.from({ length: cells }, (_, i) => (i === handleAt ? '●' : '─')).join('');
  return (
    <Clickable id={id} disabled={disabled} onMouse={onMouse} onKey={onKey} {...rest}>
      <Text style={trackStyle}>{track}</Text>
    </Clickable>
  );
});

mapRenderTargetLowering(Checkbox, 'tui', (props: CheckboxProps): VNode => {
  const { checked, label, onChange, focused, disabled, id, ...rest } = props;
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onClick={onChange ? () => onChange(!checked) : undefined}
      {...rest}
    >
      <Text style={disabled ? [styles.dim] : focused ? [styles.bold, styles.accent] : []}>
        {checked ? '[x]' : '[ ]'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
});

mapRenderTargetLowering(Radio, 'tui', (props: RadioProps): VNode => {
  const { selected, label, onSelect, focused, disabled, id, ...rest } = props;
  return (
    <Clickable id={id} direction="row" gap={1} disabled={disabled} onClick={onSelect} {...rest}>
      <Text style={disabled ? [styles.dim] : focused ? [styles.bold, styles.accent] : []}>
        {selected ? '●' : '○'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
});

mapRenderTargetLowering(Switch, 'tui', (props: SwitchProps): VNode => {
  const { on, label, onChange, focused, disabled, id, ...rest } = props;
  return (
    <Clickable
      id={id}
      direction="row"
      gap={1}
      disabled={disabled}
      onClick={onChange ? () => onChange(!on) : undefined}
      {...rest}
    >
      <Text
        style={
          disabled
            ? [styles.dim]
            : on
              ? [styles.success, ...(focused ? [styles.bold] : [])]
              : [styles.muted, ...(focused ? [styles.bold] : [])]
        }
      >
        {on ? '──●' : '●──'}
      </Text>
      {label !== undefined ? <Text dim={disabled}>{label}</Text> : null}
    </Clickable>
  );
});
