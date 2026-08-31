/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/forms.preview — preview previews for buttons, toggles, and text entry.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/preview` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import {
  Button,
  Checkbox,
  ComboBox,
  Field,
  Fieldset,
  HStack,
  IconButton,
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
import type { ComboBoxOption } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

const COMBO_OPTIONS: ComboBoxOption[] = [
  { key: 'js', label: 'JavaScript' },
  { key: 'ts', label: 'TypeScript' },
  { key: 'py', label: 'Python' },
  { key: 'rs', label: 'Rust' },
  { key: 'go', label: 'Go' },
];

export function formsPreviews(): PreviewGroup {
  const checked = createSignal(true);
  const radio = createSignal('b');
  const power = createSignal(false);
  const text = createTextField('hello');
  const password = createTextField('');
  const notes = createTextArea('Line one\nLine two');
  const age = createSignal(28);
  const volume = createSignal(40);
  const combo = createTextField('');
  const comboOpen = createSignal(false);
  const comboActive = createSignal<string | null>(null);
  const comboPicked = createSignal<string | null>(null);
  const starred = createSignal(false);
  return {
    title: 'Forms',
    previews: [
      {
        key: 'buttons',
        name: 'Button',
        controls: {
          label: { type: 'text', default: 'Save' },
          disabled: { type: 'boolean', default: false },
          focused: { type: 'boolean', default: false },
        },
        view: (args) => (
          <Button
            label={String(args.label)}
            disabled={args.disabled === true}
            focused={args.focused === true}
            onClick={() => {}}
          />
        ),
      },
      {
        key: 'checkbox',
        name: 'Checkbox',
        view: () => (
          <VStack>
            <Checkbox
              checked={checked.get()}
              label="Notifications"
              onChange={(next) => checked.set(next)}
            />
            <Checkbox checked={false} label="Disabled" disabled />
          </VStack>
        ),
      },
      {
        key: 'radio',
        name: 'RadioGroup',
        view: () => (
          <RadioGroup
            value={radio.get()}
            onChange={(key) => radio.set(key)}
            options={[
              { key: 'a', label: 'Alpha' },
              { key: 'b', label: 'Beta' },
              { key: 'c', label: 'Gamma' },
            ]}
          />
        ),
      },
      {
        key: 'switch',
        name: 'Switch',
        view: () => (
          <VStack>
            <Switch on={power.get()} label="Power" onChange={(next) => power.set(next)} />
            <Switch on label="Locked on" />
          </VStack>
        ),
      },
      {
        key: 'text-input',
        name: 'TextInput',
        view: () => (
          <VStack gap={1}>
            <TextInput
              value={text.value.get()}
              caret={text.caret.get()}
              selection={text.selection.get()}
              focused
              onChange={text.set}
            />
            <TextInput value="" placeholder="Type here…" />
          </VStack>
        ),
      },
      {
        key: 'password',
        name: 'TextInput (password)',
        view: () => (
          <VStack gap={1}>
            <TextInput
              value={password.value.get()}
              caret={password.caret.get()}
              selection={password.selection.get()}
              password
              focused
              onChange={password.set}
            />
            <Text style={[styles.muted]}>{`real value: ${password.value.get() || '(empty)'}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'text-area',
        name: 'TextArea',
        view: () => (
          <TextArea
            value={notes.value.get()}
            caret={notes.caret.get()}
            selection={notes.selection.get()}
            rows={4}
            focused
            onChange={notes.set}
          />
        ),
      },
      {
        key: 'field',
        name: 'Field',
        controls: {
          required: { type: 'boolean', default: true },
          error: { type: 'text', default: '' },
        },
        view: (args) => (
          <Field
            id="field-email"
            htmlFor="field-email-input"
            label="Email"
            hint="We only use this for release notes."
            error={String(args.error).length > 0 ? String(args.error) : undefined}
            required={args.required === true}
          >
            <TextInput id="field-email-input" value="" placeholder="you@example.com" />
          </Field>
        ),
      },
      {
        key: 'fieldset',
        name: 'Fieldset',
        view: () => (
          <Fieldset legend="Preferences" width={30}>
            <Checkbox
              checked={checked.get()}
              label="Product updates"
              onChange={(next) => checked.set(next)}
            />
            <Checkbox checked={false} label="Marketing" disabled />
          </Fieldset>
        ),
      },
      {
        key: 'number-input',
        name: 'NumberInput',
        view: () => (
          <VStack gap={1}>
            <NumberInput value={age.get()} min={0} max={120} onChange={(next) => age.set(next)} />
            <Text style={[styles.muted]}>{`age: ${age.get()}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'slider',
        name: 'Slider',
        controls: {
          orientation: {
            type: 'select',
            options: ['horizontal', 'vertical'],
            default: 'horizontal',
          },
        },
        view: (args) => (
          <VStack gap={1}>
            <Slider
              id="preview-slider"
              value={volume.get()}
              orientation={args.orientation as 'horizontal' | 'vertical'}
              onChange={(next) => volume.set(next)}
            />
            <Text style={[styles.muted]}>{`volume: ${volume.get()}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'combobox',
        name: 'ComboBox',
        view: () => (
          <VStack gap={1} width={26}>
            <ComboBox
              id="preview-combo"
              value={combo.value.get()}
              options={COMBO_OPTIONS}
              open={comboOpen.get()}
              activeKey={comboActive.get()}
              onActiveChange={(key) => comboActive.set(key)}
              onOpenChange={(open) => comboOpen.set(open)}
              onInput={combo.set}
              onSelect={(key) => {
                comboPicked.set(key);
                const picked = COMBO_OPTIONS.find((option) => option.key === key);
                if (picked) combo.set(picked.label);
              }}
            />
            <Text style={[styles.muted]}>{`picked: ${comboPicked.get() ?? '—'}`}</Text>
          </VStack>
        ),
      },
      {
        key: 'icon-button',
        name: 'IconButton',
        view: () => (
          <HStack gap={1}>
            <IconButton
              id="preview-icon-button"
              icon={starred.get() ? 'lock' : 'file'}
              label={starred.get() ? 'Unstar' : 'Star'}
              onClick={() => starred.set(!starred.get())}
            />
            <Text style={[styles.muted]}>{starred.get() ? 'starred' : 'not starred'}</Text>
          </HStack>
        ),
      },
    ],
  };
}
