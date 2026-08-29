/** Co-located previews for form components. @internal */
import { createSignal, h } from 'fino:ui';
import {
  Button,
  Checkbox,
  Field,
  HStack,
  NumberInput,
  RadioGroup,
  Slider,
  Switch,
  Text,
  TextArea,
  TextInput,
  VStack,
  createTextArea,
  createTextField,
  styles,
} from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build form-family previews for a catalog host. */
export function formsPreviews(): PreviewGroup {
  const checked = createSignal(true);
  const choice = createSignal('stable');
  const power = createSignal(false);
  const field = createTextField('hello');
  const area = createTextArea('Line one\nLine two');
  const count = createSignal(4);
  const volume = createSignal(40);
  return {
    title: 'Forms',
    previews: [
      {
        key: 'button',
        name: 'Button',
        controls: {
          label: { type: 'text', default: 'Save' },
          disabled: { type: 'boolean', default: false },
        },
        view: (args) =>
          h(Button, {
            label: String(args.label),
            disabled: args.disabled === true,
            onClick: () => {},
          }),
      },
      {
        key: 'choices',
        name: 'Choices',
        view: () =>
          h(
            VStack,
            { gap: 1 },
            h(Checkbox, {
              checked: checked.get(),
              label: 'Notifications',
              onChange: (next) => checked.set(next),
            }),
            h(Switch, { on: power.get(), label: 'Power', onChange: (next) => power.set(next) }),
            h(RadioGroup, {
              value: choice.get(),
              onChange: (next) => choice.set(next),
              options: [
                { key: 'fast', label: 'Fast' },
                { key: 'stable', label: 'Stable' },
              ],
            }),
          ),
      },
      {
        key: 'text',
        name: 'Text editing',
        view: () =>
          h(
            VStack,
            { gap: 1 },
            h(
              Field,
              { label: 'Name' },
              h(TextInput, {
                value: field.value.get(),
                caret: field.caret.get(),
                selection: field.selection.get(),
                focused: true,
                onChange: field.set,
              }),
            ),
            h(TextArea, {
              value: area.value.get(),
              caret: area.caret.get(),
              selection: area.selection.get(),
              rows: 3,
              onChange: area.set,
            }),
          ),
      },
      {
        key: 'numeric',
        name: 'Numeric controls',
        view: () =>
          h(
            VStack,
            { gap: 1 },
            h(NumberInput, {
              value: count.get(),
              min: 0,
              max: 10,
              onChange: (next) => count.set(next),
            }),
            h(
              HStack,
              { gap: 1 },
              h(Slider, { value: volume.get(), onChange: (next) => volume.set(next) }),
              h(Text, { style: [styles.muted] }, String(volume.get())),
            ),
          ),
      },
    ],
  };
}
