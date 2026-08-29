/** HTML lowerings and styles for form components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import {
  componentStyleAttrs,
  controlledNativeInput,
  controlledNativeValue,
  nativeAction,
} from 'internal:ui/components/html-runtime';
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
  numericRange,
} from 'internal:ui/components/forms';
import type { CheckboxProps, RadioProps, SwitchProps } from 'internal:ui/components/forms';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

mapComponentLowering(Button, 'html', (props) => {
  const { label, onClick, disabled } = props;
  return nativeAction(
    h('button', componentStyleAttrs(props as Props, 'ui-button'), label),
    onClick,
    disabled === true,
  );
});

type ChoiceProps = CheckboxProps | RadioProps | SwitchProps;

function choiceHtml(
  props: ChoiceProps,
  kind: 'checkbox' | 'radio',
  checked: boolean,
  onValue: ((value?: string) => void) | undefined,
  switchRole = false,
): VNode {
  const control = (attrs: Props): VNode => {
    const input: Props = {
      ...attrs,
      type: kind,
      className: switchRole ? 'ui-switch' : 'ui-check',
      value: 'true',
    };
    if (checked) input.checked = true;
    if (switchRole) input.role = 'switch';
    return h(
      'label',
      componentStyleAttrs(
        props as Props,
        `ui-choice${props.disabled === true ? ' is-disabled' : ''}`,
      ),
      h('input', input),
      props.label === undefined ? null : h('span', null, props.label),
    );
  };
  const before =
    kind === 'checkbox'
      ? [h('input', { type: 'hidden', name: 'value', value: 'false' })]
      : undefined;
  return controlledNativeValue(onValue, control, { disabled: props.disabled, before });
}

mapComponentLowering(Checkbox, 'html', (props) =>
  choiceHtml(
    props,
    'checkbox',
    props.checked,
    props.onChange === undefined ? undefined : (value) => props.onChange!(value === 'true'),
  ),
);

mapComponentLowering(Radio, 'html', (props) =>
  choiceHtml(
    props,
    'radio',
    props.selected,
    props.onSelect === undefined ? undefined : () => props.onSelect!(),
  ),
);

mapComponentLowering(Switch, 'html', (props) =>
  choiceHtml(
    props,
    'checkbox',
    props.on,
    props.onChange === undefined ? undefined : (value) => props.onChange!(value === 'true'),
    true,
  ),
);

mapComponentLowering(RadioGroup, 'html', (props) => {
  const { value, options, onChange, disabled } = props;
  return controlledNativeValue(
    onChange === undefined
      ? undefined
      : (key) => {
          if (
            key !== undefined &&
            options.some((option) => option.key === key && !option.disabled)
          ) {
            onChange(key);
          }
        },
    (attrs) =>
      h(
        'div',
        componentStyleAttrs(props as Props, 'ui-radio-group'),
        ...options.map((option) => {
          const input: Props = {
            ...attrs,
            type: 'radio',
            className: 'ui-check',
            value: option.key,
          };
          if (option.key === value) input.checked = true;
          if (option.disabled === true) input.disabled = true;
          return h(
            'label',
            { className: `ui-choice${option.disabled === true ? ' is-disabled' : ''}` },
            h('input', input),
            h('span', null, option.label),
          );
        }),
      ),
    { disabled },
  );
});

mapComponentLowering(TextInput, 'html', (props) => {
  const { value, placeholder, password, onChange, onSubmit, disabled } = props;
  const attrs = componentStyleAttrs(props as Props, 'ui-form-field');
  attrs.type = password === true ? 'password' : 'text';
  attrs.value = value;
  if (placeholder !== undefined) attrs.placeholder = placeholder;
  const onValue =
    onChange === undefined && onSubmit === undefined
      ? undefined
      : (next?: string): void => {
          const text = next ?? '';
          if (onSubmit !== undefined) onSubmit(text);
          else onChange!(text, text.length, null);
        };
  return controlledNativeInput(h('input', attrs), onValue, { disabled });
});

mapComponentLowering(TextArea, 'html', (props) => {
  const { value, rows, onChange, disabled } = props;
  const attrs = componentStyleAttrs(props as Props, 'ui-form-field');
  attrs.rows = String(rows ?? 4);
  return controlledNativeInput(
    h('textarea', attrs, value),
    onChange === undefined ? undefined : (next) => onChange(next ?? '', (next ?? '').length, null),
    { disabled },
  );
});

function numericInput(
  props: Props,
  kind: 'number' | 'range',
  value: number,
  min: number | undefined,
  max: number | undefined,
  step: number | undefined,
  onChange: ((value: number) => void) | undefined,
  disabled: boolean | undefined,
): VNode {
  const attrs = componentStyleAttrs(props, `ui-form-field${kind === 'range' ? ' ui-slider' : ''}`);
  Object.assign(attrs, { type: kind, value: String(value) });
  if (min !== undefined) attrs.min = String(min);
  if (max !== undefined) attrs.max = String(max);
  if (step !== undefined) attrs.step = String(step);
  return controlledNativeInput(
    h('input', attrs),
    onChange === undefined
      ? undefined
      : (next) => {
          const parsed = Number(next);
          if (Number.isFinite(parsed)) onChange(clampNumber(parsed, min, max));
        },
    { disabled },
  );
}

mapComponentLowering(NumberInput, 'html', (props) =>
  numericInput(
    props as Props,
    'number',
    props.value,
    props.min,
    props.max,
    props.step,
    props.onChange,
    props.disabled,
  ),
);

mapComponentLowering(Slider, 'html', (props) => {
  const range = numericRange(props.min, props.max);
  const node = numericInput(
    props as Props,
    'range',
    clampNumber(props.value, range.min, range.max),
    range.min,
    range.max,
    props.step,
    props.onChange,
    props.disabled,
  );
  if (props.orientation !== 'vertical') return node;
  const control = node.type === 'form' ? node.children[node.children.length - 1] : node;
  if (typeof control === 'string') return node;
  control.props.style = {
    ...((control.props.style ?? {}) as Record<string, string>),
    writingMode: 'vertical-lr',
    direction: 'rtl',
  };
  return node;
});

registerHtmlCss(`
.ui-button {
  border: 1px solid var(--ui-border); border-radius: 0.375rem;
  background: var(--ui-surface); padding: 0.375rem 0.75rem; cursor: pointer;
}
.ui-button:hover:not(:disabled) { border-color: var(--ui-accent); }
.ui-button:disabled, .ui-choice.is-disabled { opacity: 0.45; cursor: default; }
.ui-choice { display: inline-flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.ui-radio-group { display: flex; flex-direction: column; gap: 0.375rem; }
.ui-form-field {
  box-sizing: border-box; min-width: 12ch; border: 1px solid var(--ui-border);
  border-radius: 0.375rem; background: var(--ui-surface); color: var(--tui-fg);
  padding: 0.375rem 0.5rem; font: inherit;
}
.ui-form-field:focus { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.ui-slider { padding: 0; accent-color: var(--ui-accent); }
`);
