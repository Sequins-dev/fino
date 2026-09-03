import { describe, it } from 'fino:test/test';
import { createSignal, h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Button,
  Checkbox,
  NumberInput,
  RadioGroup,
  Slider,
  Switch,
  TextArea,
  TextInput,
  createTextArea,
  createTextField,
} from 'fino:ui/components';
import { pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { formsPreviews } from 'internal:ui/components/forms.preview';
import { applyTextAreaEdit, applyTextEdit } from 'internal:ui/components/text-edit';
import { defaultArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode, actions?: Map<string, (value?: string) => void>): string {
  return renderToHtml(toHtml(tree, actions === undefined ? {} : { actions }));
}

describe('form text edit reducers', () => {
  it('shares selection replacement and horizontal deletion behavior', (t) => {
    const replaced = applyTextEdit(
      { value: 'hello', caret: 4, selection: { start: 1, end: 4 } },
      { type: 'key', key: 'x', text: 'X' },
    );
    t.deepEqual(replaced, { value: 'hXo', caret: 2, selection: null });
    const deleted = applyTextAreaEdit(
      { value: 'hello\nworld', caret: 5, selection: { start: 1, end: 4 } },
      { type: 'key', key: 'backspace' },
    );
    t.deepEqual(deleted, { value: 'ho\nworld', caret: 1, selection: null });
  });

  it('moves and deletes by word while preserving shift selection anchors', (t) => {
    const left = applyTextEdit(
      { value: 'one two', caret: 7 },
      { type: 'key', key: 'left', alt: true },
    )!;
    t.equal(left.caret, 4, 'alt-left moves to the preceding word');
    const selected = applyTextEdit(left, { type: 'key', key: 'left', shift: true })!;
    t.deepEqual(selected.selection, { start: 3, end: 4 }, 'shift extends from the original anchor');
    const removed = applyTextEdit(
      { value: 'one two', caret: 7 },
      { type: 'key', key: 'backspace', alt: true },
    )!;
    t.equal(removed.value, 'one ', 'alt-backspace removes one word');
  });

  it('uses line boundaries and vertical clamping only for multiline editing', (t) => {
    const state = { value: 'longer\nhi\nlongest', caret: 4, selection: null as null };
    const down = applyTextAreaEdit(state, { type: 'key', key: 'down' })!;
    t.equal(down.caret, 9, 'down clamps to a shorter line');
    const next = applyTextAreaEdit(down, { type: 'key', key: 'down' })!;
    t.equal(next.caret, 12, 'the next move preserves the resulting column');
    t.equal(
      applyTextAreaEdit({ ...state, caret: 8 }, { type: 'key', key: 'home' })!.caret,
      7,
      'home uses the current line',
    );
    t.equal(
      applyTextEdit(state, { type: 'key', key: 'home' })!.caret,
      0,
      'field home uses value start',
    );
  });

  it('builds field and area state from one controller contract', (t) => {
    const field = createTextField('a');
    const area = createTextArea('a');
    t.equal(field.apply({ type: 'key', key: 'enter' }), false, 'field reserves Enter');
    t.equal(area.apply({ type: 'key', key: 'enter' }), true, 'area inserts Enter');
    t.equal(area.value.get(), 'a\n');
    field.set('hello', 99, { start: 1, end: 3 });
    t.equal(field.caret.get(), 5, 'set clamps the caret');
    t.deepEqual(field.selection.get(), { start: 1, end: 3 });
  });
});

describe('form HTML lowerings', () => {
  it('uses native semantics and the shared action adapter for buttons and choices', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let clicks = 0;
    let checked = false;
    const out = html(
      h(
        'fragment',
        null,
        h(Button, { label: 'Save', onClick: () => clicks++ }),
        h(Checkbox, { checked, label: 'Ready', onChange: (value) => (checked = value) }),
      ),
      actions,
    );
    t.ok(out.includes('<button'), 'button uses native markup');
    t.ok(out.includes('type="checkbox"'), 'choice uses a native input');
    t.equal(actions.size, 2, 'both controls use one deterministic registry');
    actions.get('a0')?.();
    actions.get('a1')?.('true');
    t.equal(clicks, 1);
    t.equal(checked, true);
  });

  it('wires each radio option through one group action', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let selected = '';
    const out = html(
      h(RadioGroup, {
        value: 'a',
        options: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Beta' },
          { key: 'c', label: 'Disabled', disabled: true },
        ],
        onChange: (value) => (selected = value),
      }),
      actions,
    );
    t.equal(actions.size, 1, 'the group registers once rather than once per option');
    t.equal(out.split('name="value"').length - 1, 3, 'all options share the native value name');
    actions.get('a0')?.('b');
    t.equal(selected, 'b');
    actions.get('a0')?.('c');
    t.equal(selected, 'b', 'disabled option values are rejected');
  });

  it('renders native text, number, and range controls with controlled values', (t) => {
    const out = html(
      h(
        'fragment',
        null,
        h(TextInput, { value: 'secret', password: true, onChange: () => {} }),
        h(TextArea, { value: 'one\ntwo', rows: 6, onChange: () => {} }),
        h(NumberInput, { value: 4, min: 0, max: 10, step: 2, onChange: () => {} }),
        h(Slider, { value: 30, min: 0, max: 100, step: 5, onChange: () => {} }),
      ),
    );
    for (const expected of [
      'type="password"',
      '<textarea',
      'rows="6"',
      'type="number"',
      'type="range"',
    ]) {
      t.ok(out.includes(expected), expected);
    }
    t.ok(out.includes('>one\ntwo</textarea>'), 'textarea value is child text');
  });

  it('clamps finite HTML numeric submissions and disables inert controls', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let value = 0;
    const interactive = html(
      h(NumberInput, { value, min: 0, max: 10, onChange: (next) => (value = next) }),
      actions,
    );
    t.ok(interactive.includes('data-fi-change="1"') || interactive.includes('onchange='));
    actions.get('a0')?.('99');
    t.equal(value, 10, 'submission clamps to max');
    actions.get('a0')?.('not-a-number');
    t.equal(value, 10, 'non-finite submissions are ignored');
    t.ok(html(h(Button, { label: 'No handler' })).includes('disabled'));
    t.ok(html(h(Switch, { on: false, label: 'No handler' })).includes('disabled'));
  });
});

describe('form terminal lowerings', () => {
  it('activates buttons and each choice presentation', (t) => {
    const app = createTuiHarness(30, 5);
    let clicks = 0;
    const checked = createSignal(false);
    const switched = createSignal(false);
    const selected = createSignal('a');
    const view = (): VNode =>
      h(
        'fragment',
        null,
        h(Button, { label: 'Save', onClick: () => clicks++ }),
        h(Checkbox, {
          checked: checked.get(),
          label: 'Check',
          onChange: (next) => checked.set(next),
        }),
        h(Switch, { on: switched.get(), label: 'Power', onChange: (next) => switched.set(next) }),
        h(RadioGroup, {
          value: selected.get(),
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          onChange: (next) => selected.set(next),
        }),
      );
    app.render(view());
    t.equal(plainLine(app.lines()[0]!), '[ Save ]');
    app.click(1, 0);
    app.click(1, 1);
    app.click(1, 2);
    app.click(1, 4);
    t.equal(clicks, 1);
    t.equal(checked.get(), true);
    t.equal(switched.get(), true);
    t.equal(selected.get(), 'b');
  });

  it('keeps disabled and handler-less controls out of focus order', (t) => {
    const app = createTuiHarness(20, 3);
    app.render(
      h(
        'fragment',
        null,
        h(Button, { label: 'No handler' }),
        h(Checkbox, {
          id: 'disabled',
          checked: false,
          label: 'Disabled',
          onChange: () => {},
          disabled: true,
        }),
        h(Switch, { id: 'active', on: false, label: 'Active', onChange: () => {} }),
      ),
    );
    t.equal(app.dispatcher.focusNext(), true, 'one active control remains');
    t.equal(app.dispatcher.focused?.props.id, 'active');
    t.equal(app.dispatcher.focusNext(), true, 'focus wraps directly to the same active control');
    t.equal(app.dispatcher.focused?.props.id, 'active');
  });

  it('edits and submits a masked single-line field against its real value', (t) => {
    const app = createTuiHarness(20, 1);
    const field = createTextField('ab');
    const submitted: string[] = [];
    const view = (): VNode =>
      h(TextInput, {
        value: field.value.get(),
        caret: field.caret.get(),
        selection: field.selection.get(),
        password: true,
        focused: true,
        onChange: field.set,
        onSubmit: (value) => submitted.push(value),
      });
    app.render(view());
    t.ok(plainLine(app.lines()[0]!).includes('••'));
    app.click(1, 0);
    app.key({ key: 'c', text: 'c' });
    t.equal(field.value.get(), 'abc');
    app.render(view());
    app.key({ key: 'enter' });
    t.deepEqual(submitted, ['abc']);
  });

  it('keeps plain Enter for textarea editing and ctrl-Enter for submit', (t) => {
    const app = createTuiHarness(20, 5);
    const area = createTextArea('ab');
    area.set('ab', 1);
    const submitted: string[] = [];
    const view = (): VNode =>
      h(TextArea, {
        value: area.value.get(),
        caret: area.caret.get(),
        rows: 3,
        focused: true,
        onChange: area.set,
        onSubmit: (value) => submitted.push(value),
      });
    app.render(view());
    app.click(1, 1);
    app.key({ key: 'enter' });
    t.equal(area.value.get(), 'a\nb');
    app.render(view());
    app.key({ key: 'enter', ctrl: true });
    t.deepEqual(submitted, ['a\nb']);
  });

  it('steps number inputs by click and key while clamping both bounds', (t) => {
    const app = createTuiHarness(10, 1);
    const value = createSignal(9);
    const view = (): VNode =>
      h(NumberInput, {
        id: 'count',
        value: value.get(),
        min: 0,
        max: 10,
        step: 2,
        onChange: (next) => value.set(next),
      });
    app.render(view());
    app.click(4, 0);
    t.equal(value.get(), 10, 'increment clamps at max');
    app.render(view());
    app.key({ key: 'right' });
    t.equal(value.get(), 10, 'key stays clamped');
    app.key({ key: 'left' });
    t.equal(value.get(), 8);
  });

  it('maps horizontal and vertical slider cells through one range function', (t) => {
    const horizontal = createTuiHarness(24, 1);
    const hValue = createSignal(50);
    const hView = (): VNode =>
      h(Slider, {
        value: hValue.get(),
        min: 0,
        max: 100,
        width: 21,
        onChange: (next) => hValue.set(next),
      });
    horizontal.render(hView());
    horizontal.click(0, 0);
    t.equal(hValue.get(), 0);
    horizontal.render(hView());
    horizontal.click(20, 0);
    t.equal(hValue.get(), 100);

    const vertical = createTuiHarness(3, 10);
    const vValue = createSignal(50);
    const vView = (): VNode =>
      h(Slider, {
        value: vValue.get(),
        min: 0,
        max: 100,
        width: 9,
        orientation: 'vertical',
        onChange: (next) => vValue.set(next),
      });
    vertical.render(vView());
    vertical.click(0, 0);
    t.equal(vValue.get(), 100, 'top is max');
    vertical.render(vView());
    vertical.click(0, 8);
    t.equal(vValue.get(), 0, 'bottom is min');
  });
});

describe('form previews and styles', () => {
  it('keeps previews co-located and registers family CSS once', (t) => {
    const group = formsPreviews();
    t.equal(group.title, 'Forms');
    t.deepEqual(
      group.previews.map((preview) => preview.key),
      ['button', 'choices', 'text', 'numeric'],
    );
    t.deepEqual(defaultArgs(group.previews[0]!), { label: 'Save', disabled: false });
    t.equal(pageCss().split('.ui-button {').length - 1, 1);
    t.ok(html(group.previews[2]!.view({})).includes('ui-form-field'));
  });
});
