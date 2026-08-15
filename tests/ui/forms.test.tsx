/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { createRenderer, createSignal } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  ComboBox,
  Field,
  Fieldset,
  IconButton,
  NumberInput,
  Slider,
  TextArea,
  TextInput,
  applyTextAreaEdit,
  createTextArea,
  createTextField,
} from 'fino:ui/components';
import type { ComboBoxOption } from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';
import { renderToHtml } from 'fino:ui/html';
import { toHtml } from 'fino:ui/components/html';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { layout } from 'internal:tty/layout';
import { lowerTui } from 'internal:tty/lower';
import { TuiDispatcher } from 'internal:tty/events';
import type { TuiMouseEventLike } from 'internal:tty/events';

function lines(tree: VNode, width: number, height: number): string[] {
  return renderFrame(tree, { width, height }).split('\n');
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

interface Live {
  dispatcher: TuiDispatcher;
  render(tree: VNode): void;
  text(): string[];
}

function live(width = 30, height = 10): Live {
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(root);
  let frame: string[] = [];
  return {
    dispatcher,
    render(tree: VNode): void {
      renderer.render(lowerTui(tree), root);
      const laid = layout(root.children[0]!, { width, height });
      frame = laid.rows.map((row) => row.segments.map((s) => s.text).join(''));
    },
    text(): string[] {
      return frame;
    },
  };
}

function click(app: Live, x: number, y: number): void {
  const at = (action: 'press' | 'release'): TuiMouseEventLike => ({
    type: 'mouse',
    action,
    button: 'left',
    x,
    y,
    ctrl: false,
    alt: false,
    shift: false,
  });
  app.dispatcher.dispatch(at('press'));
  app.dispatcher.dispatch(at('release'));
}

function key(app: Live, key: string, extra: Partial<TuiMouseEventLike> = {}): void {
  app.dispatcher.dispatch({
    type: 'key',
    key,
    ctrl: false,
    alt: false,
    shift: false,
    ...extra,
  } as never);
}

describe('fino:ui/components Field/Fieldset', () => {
  it('renders a label, required marker, hint, and error in the terminal', (t) => {
    const frame = lines(
      <Field label="Email" hint="We never share this" error="Required" required>
        <TextInput value="" />
      </Field>,
      30,
      4,
    );
    t.ok(strip(frame[0]!).startsWith('Email'), 'label leads the field');
    t.ok(frame[0]!.includes('*'), 'required marker follows the label');
    t.ok(
      frame.some((row) => strip(row).includes('We never share this')),
      'hint renders',
    );
    t.ok(
      frame.some((row) => strip(row).includes('Required')),
      'error renders',
    );
  });

  it('omits the required marker and error line when absent', (t) => {
    const frame = lines(
      <Field label="Name">
        <TextInput value="" />
      </Field>,
      30,
      3,
    );
    t.equal(strip(frame[0]!), 'Name', 'no trailing marker');
    t.ok(
      !frame.some(
        (row) => strip(row).length > 0 && !strip(row).includes('Name') && row !== frame[1],
      ),
      'no stray error/hint rows beyond the control',
    );
  });

  it('renders a native label wrapping the control on the web', (t) => {
    const html = renderToHtml(
      toHtml(
        <Field label="Email" hint="hint text" required>
          <TextInput value="" onChange={() => {}} />
        </Field>,
      ),
    );
    t.ok(html.startsWith('<label class="ui-field ui-field-wrap"'), 'wraps in a native label');
    t.ok(html.includes('Email'), 'label text renders');
    t.ok(html.includes('class="ui-field-required"'), 'required marker renders');
    t.ok(html.includes('<small class="ui-field-hint"'), 'hint becomes a <small>');
  });

  it('wires role=alert and aria-invalid/aria-describedby when an error is given', (t) => {
    const html = renderToHtml(
      toHtml(
        <Field id="pw" label="Password" error="Too short">
          <TextInput value="" onChange={() => {}} />
        </Field>,
      ),
    );
    t.ok(html.includes('role="alert"'), 'error carries role=alert');
    t.ok(html.includes('aria-invalid="true"'), 'aria-invalid wires onto the control');
    t.ok(html.includes('aria-describedby="pw-error"'), 'aria-describedby points at the error id');
  });

  it('uses an explicit for/id pairing instead of wrapping when htmlFor is given', (t) => {
    const html = renderToHtml(
      toHtml(
        <Field label="Email" htmlFor="email-input">
          <TextInput id="email-input" value="" onChange={() => {}} />
        </Field>,
      ),
    );
    t.ok(html.includes('<div class="ui-field"'), 'renders as a div, not a wrapping label');
    t.ok(html.includes('for="email-input"'), 'label targets the control id');
  });

  it('renders a bordered box with the legend in the border', (t) => {
    const frame = lines(
      <Fieldset legend="Notifications" width={20}>
        <TextInput value="" />
      </Fieldset>,
      20,
      3,
    );
    t.equal(strip(frame[0]!), '┌─ Notifications ──┐', 'legend sits in the top border');
  });

  it('renders a real fieldset/legend on the web', (t) => {
    const html = renderToHtml(
      toHtml(
        <Fieldset legend="Notifications">
          <TextInput value="" onChange={() => {}} />
        </Fieldset>,
      ),
    );
    t.ok(html.startsWith('<fieldset class="ui-fieldset"'), 'real fieldset element');
    t.ok(html.includes('<legend>Notifications</legend>'), 'legend element carries the text');
  });
});

describe('fino:ui/components TextInput password mode', () => {
  it('masks displayed characters while onChange reports the real value', (t) => {
    const field = createTextField('secret');
    const frame = lines(
      <TextInput value={field.value.get()} caret={field.caret.get()} password focused />,
      20,
      1,
    );
    t.ok(strip(frame[0]!).includes('••••••'), 'masked characters painted');
    t.ok(!strip(frame[0]!).includes('secret'), 'real characters never painted');
  });

  it('keeps caret/selection math correct against the real value length', (t) => {
    const app = live();
    const field = createTextField('ab');
    const view = (): VNode => (
      <TextInput
        value={field.value.get()}
        caret={field.caret.get()}
        password
        focused
        onChange={field.set}
      />
    );
    app.render(view());
    click(app, 1, 0);
    key(app, 'c', { text: 'c' } as never);
    t.equal(field.value.get(), 'abc', 'typed character lands through onChange on the real value');
  });

  it('renders a native password input on the web', (t) => {
    const html = renderToHtml(toHtml(<TextInput value="hunter2" password onChange={() => {}} />));
    t.ok(html.includes('type="password"'), 'native password input');
    t.ok(
      html.includes('value="hunter2"'),
      'the real value rides the value attribute — masking is a browser rendering concern',
    );
  });
});

describe('fino:ui/components TextArea', () => {
  it('inserts a newline on Enter and reports it through the reducer', (t) => {
    const next = applyTextAreaEdit(
      { value: 'ab', caret: 1, selection: null },
      { type: 'key', key: 'enter' },
    );
    t.deepEqual(
      next,
      { value: 'a\nb', caret: 2, selection: null },
      'enter splits the line at the caret',
    );
  });

  it('moves the caret between visual lines with up/down, clamping short lines', (t) => {
    const state = { value: 'longer\nhi\nlongest', caret: 4, selection: null as null };
    const down = applyTextAreaEdit(state, { type: 'key', key: 'down' })!;
    t.equal(down.caret, 9, 'lands on the same column of the next line (clamped to its length)');
    const down2 = applyTextAreaEdit(down, { type: 'key', key: 'down' })!;
    t.equal(down2.caret, 12, 'continues to the following line at the same column');
    const up = applyTextAreaEdit(down2, { type: 'key', key: 'up' })!;
    t.equal(up.caret, down.caret, 'up mirrors down back to the same position');
  });

  it('home/end move to the current line boundaries, not the whole value', (t) => {
    const state = { value: 'one\ntwo\nthree', caret: 5, selection: null as null };
    const home = applyTextAreaEdit(state, { type: 'key', key: 'home' })!;
    t.equal(home.caret, 4, 'home stops at the start of the current line');
    const end = applyTextAreaEdit(state, { type: 'key', key: 'end' })!;
    t.equal(end.caret, 7, 'end stops at the end of the current line');
  });

  it('creates and mutates state through createTextArea', (t) => {
    const area = createTextArea('a');
    t.equal(area.apply({ type: 'key', key: 'enter' }), true, 'enter is consumed');
    t.equal(area.value.get(), 'a\n', 'newline inserted at the caret');
    area.set('x\ny\nz', 2);
    t.equal(area.caret.get(), 2, 'set places the caret explicitly');
  });

  it('renders every line and paints the caret in the terminal', (t) => {
    const frame = lines(<TextArea value={'one\ntwo'} caret={5} rows={3} focused />, 20, 5);
    t.ok(strip(frame[1]!).includes('one'), 'first line renders inside the border');
    t.ok(strip(frame[2]!).includes('two'), 'second line renders on its own row');
  });

  it('edits through the live dispatcher: Enter inserts a newline, not a submit', (t) => {
    const app = live();
    const area = createTextArea('ab');
    area.set('ab', 1);
    const submitted: string[] = [];
    const view = (): VNode => (
      <TextArea
        value={area.value.get()}
        caret={area.caret.get()}
        rows={3}
        focused
        onChange={area.set}
        onSubmit={(value) => submitted.push(value)}
      />
    );
    app.render(view());
    click(app, 1, 1);
    key(app, 'enter');
    t.equal(area.value.get(), 'a\nb', 'plain enter inserts a newline at the caret');
    t.deepEqual(submitted, [], 'plain enter never submits');
    app.render(view());
    key(app, 'enter', { ctrl: true } as never);
    t.deepEqual(submitted, ['a\nb'], 'ctrl+enter submits the current value');
  });

  it('renders a native textarea with rows on the web', (t) => {
    const html = renderToHtml(toHtml(<TextArea value={'one\ntwo'} rows={6} onChange={() => {}} />));
    t.ok(html.startsWith('<textarea'), 'real textarea element');
    t.ok(html.includes('rows="6"'), 'rows attribute set');
    t.ok(html.includes('>one\ntwo<'), 'value rides as child text, not an attribute');
  });
});

describe('fino:ui/components NumberInput', () => {
  it('renders a bracketed stepper', (t) => {
    const frame = lines(<NumberInput value={42} onChange={() => {}} />, 10, 1);
    t.equal(strip(frame[0]!), '‹ 42 ›', 'decrement, value, increment');
  });

  it('steps by click on the decrement/increment affordances', (t) => {
    const app = live();
    const value = createSignal(5);
    const view = (): VNode => (
      <NumberInput value={value.get()} min={0} max={10} onChange={(next) => value.set(next)} />
    );
    app.render(view());
    click(app, 4, 0);
    t.equal(value.get(), 6, 'clicking the increment affordance steps up');
    app.render(view());
    click(app, 0, 0);
    app.render(view());
    click(app, 0, 0);
    t.equal(value.get(), 4, 'clicking the decrement affordance steps down');
  });

  it('steps by left/right arrow keys while focused, clamped to min/max', (t) => {
    const app = live();
    const value = createSignal(9);
    const view = (): VNode => (
      <NumberInput
        value={value.get()}
        min={0}
        max={10}
        step={2}
        onChange={(next) => value.set(next)}
      />
    );
    app.render(view());
    click(app, 3, 0);
    key(app, 'right');
    t.equal(value.get(), 10, 'right steps up (clamped to max, not 11)');
    app.render(view());
    key(app, 'right');
    t.equal(value.get(), 10, 'stays clamped at max');
    key(app, 'left');
    app.render(view());
    key(app, 'left');
    t.equal(value.get(), 6, 'left steps down twice by the configured step');
  });

  it('renders a native number input with min/max/step on the web', (t) => {
    const html = renderToHtml(
      toHtml(<NumberInput value={4} min={0} max={10} step={2} onChange={() => {}} />),
    );
    t.ok(html.includes('type="number"'), 'native number input');
    t.ok(html.includes('min="0"'), 'min attribute');
    t.ok(html.includes('max="10"'), 'max attribute');
    t.ok(html.includes('step="2"'), 'step attribute');
  });
});

describe('fino:ui/components Slider', () => {
  it('renders a track with the handle positioned by value', (t) => {
    const frame = lines(
      <Slider value={0} min={0} max={100} width={11} onChange={() => {}} />,
      12,
      1,
    );
    t.equal(strip(frame[0]!), '●──────────', 'handle sits at the start for the minimum value');
    const mid = lines(
      <Slider value={100} min={0} max={100} width={11} onChange={() => {}} />,
      12,
      1,
    );
    t.equal(strip(mid[0]!), '──────────●', 'handle sits at the end for the maximum value');
  });

  it('steps by arrow keys while focused', (t) => {
    const app = live();
    const value = createSignal(50);
    const view = (): VNode => (
      <Slider
        id="s"
        value={value.get()}
        min={0}
        max={100}
        step={10}
        onChange={(next) => value.set(next)}
      />
    );
    app.render(view());
    click(app, 5, 0);
    key(app, 'right');
    t.equal(value.get(), 60, 'right increments by the step');
    key(app, 'left');
    key(app, 'left');
    t.equal(value.get(), 40, 'left decrements by the step');
  });

  it('jumps to a position on press, via the track rect (localX)', (t) => {
    const app = live();
    const value = createSignal(50);
    const view = (): VNode => (
      <Slider
        id="s"
        value={value.get()}
        min={0}
        max={100}
        width={11}
        onChange={(next) => value.set(next)}
      />
    );
    app.render(view());
    click(app, 0, 0);
    t.equal(value.get(), 0, 'pressing the first cell jumps to the minimum');
    app.render(view());
    click(app, 10, 0);
    t.equal(value.get(), 100, 'pressing the last cell jumps to the maximum');
  });

  it('renders a native range input on the web', (t) => {
    const html = renderToHtml(
      toHtml(<Slider value={30} min={0} max={100} step={5} onChange={() => {}} />),
    );
    t.ok(html.includes('type="range"'), 'native range input');
    t.ok(html.includes('value="30"'), 'current value rides the value attribute');
    t.ok(html.includes('step="5"'), 'step attribute');
  });
});

const LANGUAGES: ComboBoxOption[] = [
  { key: 'js', label: 'JavaScript' },
  { key: 'ts', label: 'TypeScript' },
  { key: 'py', label: 'Python' },
];

describe('fino:ui/components ComboBox', () => {
  it('filters options by a case-insensitive substring match on the label by default', (t) => {
    const app = live(24, 8);
    const state = {
      value: createSignal(''),
      open: createSignal(false),
      active: createSignal<string | null>(null),
    };
    const view = (): VNode => (
      <ComboBox
        id="lang"
        value={state.value.get()}
        options={LANGUAGES}
        open={state.open.get()}
        activeKey={state.active.get()}
        onActiveChange={(key) => state.active.set(key)}
        onOpenChange={(open) => state.open.set(open)}
        onInput={(value) => state.value.set(value)}
        onSelect={() => {}}
      />
    );
    app.render(view());
    click(app, 1, 0);
    // "javascript" contains a "p" (…scri**p**t), so filter on "y" instead —
    // present in "Python" and "TypeScript", absent from "JavaScript".
    key(app, 'y', { text: 'y' } as never);
    t.equal(state.value.get(), 'y', 'typed text lands through onInput');
    t.equal(state.open.get(), true, 'typing opens the list');
    app.render(view());
    t.ok(
      app.text().some((row) => row.includes('Python')),
      'Python matches the "y" substring',
    );
    t.ok(!app.text().some((row) => row.includes('JavaScript')), 'JavaScript is filtered out');
  });

  it('moves the active row with up/down and picks it with Enter', (t) => {
    const app = live(24, 8);
    const state = {
      value: createSignal(''),
      open: createSignal(true),
      active: createSignal<string | null>(null),
      picked: createSignal<string | null>(null),
    };
    const view = (): VNode => (
      <ComboBox
        id="lang"
        value={state.value.get()}
        options={LANGUAGES}
        open={state.open.get()}
        activeKey={state.active.get()}
        onActiveChange={(key) => state.active.set(key)}
        onOpenChange={(open) => state.open.set(open)}
        onInput={(value) => state.value.set(value)}
        onSelect={(key) => state.picked.set(key)}
      />
    );
    app.render(view());
    click(app, 1, 0);
    key(app, 'down');
    t.equal(state.active.get(), 'js', 'down highlights the first option');
    app.render(view());
    key(app, 'down');
    t.equal(state.active.get(), 'ts', 'down again moves to the next option');
    app.render(view());
    key(app, 'enter');
    t.equal(state.picked.get(), 'ts', 'enter picks the active option');
    t.equal(state.open.get(), false, 'and closes the list');
  });

  it('picks an option by clicking it in the anchored list', (t) => {
    const app = live(24, 8);
    const state = {
      value: createSignal(''),
      open: createSignal(true),
      picked: createSignal<string | null>(null),
    };
    const view = (): VNode => (
      <ComboBox
        id="lang"
        value={state.value.get()}
        options={LANGUAGES}
        open={state.open.get()}
        onOpenChange={(open) => state.open.set(open)}
        onInput={(value) => state.value.set(value)}
        onSelect={(key) => state.picked.set(key)}
      />
    );
    app.render(view());
    t.ok(
      app.text().some((row) => row.includes('JavaScript')),
      'options painted beneath the input',
    );
    click(app, 3, 2);
    t.equal(state.picked.get(), 'js', 'clicking the first row picks it');
    t.equal(state.open.get(), false, 'and closes the list');
  });

  it('renders an input plus an anchored popover list on the web, matching the Select popover pattern', (t) => {
    const html = renderToHtml(
      toHtml(
        <ComboBox
          id="lang"
          value=""
          options={LANGUAGES}
          open
          onOpenChange={() => {}}
          onInput={() => {}}
          onSelect={() => {}}
        />,
      ),
    );
    t.ok(html.includes('<input'), 'text input renders');
    t.ok(
      html.includes('class="ui-popover ui-combo-popover"'),
      'popover reuses the ui-popover markup pattern',
    );
    t.ok(html.includes('JavaScript'), 'filtered options render in the popover');
  });
});

describe('fino:ui/components IconButton', () => {
  it('renders the registry glyph in a clickable', (t) => {
    const frame = lines(<IconButton icon="lock" label="Lock" onClick={() => {}} />, 5, 1);
    t.equal(strip(frame[0]!), '∗', 'terminal glyph for the icon');
  });

  it('fires onClick', (t) => {
    const app = live();
    let clicks = 0;
    app.render(<IconButton id="lock-btn" icon="lock" label="Lock" onClick={() => clicks++} />);
    click(app, 0, 0);
    t.equal(clicks, 1, 'click fires onClick');
  });

  it('renders a button with an aria-label and an icon span on the web', (t) => {
    const html = renderToHtml(toHtml(<IconButton icon="lock" label="Lock" onClick={() => {}} />));
    t.ok(html.includes('aria-label="Lock"'), 'accessible name from label');
    t.ok(html.includes('class="ui-icon"'), 'icon rendered in its own span');
    t.ok(!html.includes('>Lock<'), 'label is not visible text, only the accessible name');
  });

  it('lowers disabled without a handler-less collector, same as Button', (t) => {
    const html = renderToHtml(toHtml(<IconButton icon="lock" label="Lock" />));
    t.ok(html.includes('disabled'), 'handler-less icon button is inert');
  });
});
