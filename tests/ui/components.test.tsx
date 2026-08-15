/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { createRenderer, createSignal } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Button,
  Checkbox,
  ContextMenu,
  Details,
  Expander,
  HStack,
  ListSelection,
  MenuList,
  Modal,
  Panel,
  Radio,
  RadioGroup,
  Rule,
  Select,
  Switch,
  Tabs,
  Text,
  TextInput,
  VStack,
  createDisclosure,
  createTextField,
} from 'fino:ui/components';
import { layoutFrame, renderFrame } from 'fino:tty/tui';
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

describe('fino:ui/components layout and forms', () => {
  it('renders stacks, rules, and panels with titles', (t) => {
    const frame = lines(
      <Panel title="Session" width={16}>
        <VStack>
          <Text>hello</Text>
          <Rule />
          <HStack gap={1}>
            <Text>a</Text>
            <Text>b</Text>
          </HStack>
        </VStack>
      </Panel>,
      16,
      5,
    );
    t.equal(strip(frame[0]!), '┌─ Session ────┐', 'title sits in the border');
    t.equal(strip(frame[1]!), '│ hello        │', 'content row inside the panel padding');
    t.equal(strip(frame[2]!), '│ ──────────── │', 'rule fills the inner width');
    t.equal(strip(frame[3]!), '│ a b          │', 'row stack with gap');
  });

  it('renders form controls in their states', (t) => {
    const on = lines(
      <VStack>
        <Checkbox checked label="alpha" />
        <Checkbox checked={false} label="beta" />
        <Radio selected label="one" />
        <Switch on label="power" />
        <Switch on={false} label="power" />
        <Button label="Save" />
      </VStack>,
      20,
      6,
    );
    t.equal(strip(on[0]!), '[x] alpha', 'checked box');
    t.equal(strip(on[1]!), '[ ] beta', 'unchecked box');
    t.equal(strip(on[2]!), '● one', 'selected radio');
    t.equal(strip(on[3]!), '──● power', 'switch on');
    t.equal(strip(on[4]!), '●── power', 'switch off');
    t.equal(strip(on[5]!), '[ Save ]', 'button');
  });

  it('toggles a checkbox through a click', (t) => {
    const app = live();
    const checked = createSignal(false);
    const view = (): VNode => (
      <VStack>
        <Checkbox checked={checked.get()} label="notify" onChange={(next) => checked.set(next)} />
      </VStack>
    );
    app.render(view());
    click(app, 5, 0);
    t.equal(checked.get(), true, 'click toggles on');
    app.render(view());
    t.ok(app.text()[0]!.includes('[x]'), 'rerender shows the checked state');
    click(app, 1, 0);
    t.equal(checked.get(), false, 'click on the glyph toggles back off');
  });

  it('reduces text edits through createTextField', (t) => {
    const field = createTextField('abc');
    t.equal(field.caret.get(), 3, 'caret starts at the end');
    t.equal(field.apply({ type: 'key', key: 'home' }), true, 'home is consumed');
    t.equal(field.caret.get(), 0, 'home moves the caret to the start');
    field.apply({ type: 'key', key: 'x', text: 'x' });
    t.equal(field.value.get(), 'xabc', 'printable characters insert at the caret');
    t.equal(field.caret.get(), 1, 'caret follows the insertion');
    field.apply({ type: 'key', key: 'delete' });
    t.equal(field.value.get(), 'xbc', 'delete removes after the caret');
    field.apply({ type: 'key', key: 'end' });
    field.apply({ type: 'key', key: 'backspace' });
    t.equal(field.value.get(), 'xb', 'backspace removes before the caret');
    t.equal(field.apply({ type: 'key', key: 'up' }), false, 'non-edit keys are not consumed');
    field.set('hi');
    t.deepEqual([field.value.get(), field.caret.get()], ['hi', 2], 'set defaults caret to the end');
  });

  it('jumps and deletes by word with alt', (t) => {
    const field = createTextField('foo bar_baz qux');
    field.apply({ type: 'key', key: 'left', alt: true });
    t.equal(field.caret.get(), 12, 'alt+left jumps to the start of the last word');
    field.apply({ type: 'key', key: 'b', alt: true });
    t.equal(field.caret.get(), 4, 'alt+b jumps over the underscore word');
    field.apply({ type: 'key', key: 'f', alt: true });
    t.equal(field.caret.get(), 11, 'alt+f jumps to the end of the word');
    field.apply({ type: 'key', key: 'backspace', alt: true });
    t.equal(field.value.get(), 'foo  qux', 'alt+backspace deletes the word before the caret');
    t.equal(field.caret.get(), 4, 'caret lands at the deletion point');
    field.apply({ type: 'key', key: 'delete', alt: true });
    t.equal(field.value.get(), 'foo ', 'alt+delete removes separators and the next word');
  });

  it('extends, collapses, and edits selections', (t) => {
    const field = createTextField('hello world');
    field.apply({ type: 'key', key: 'home' });
    field.apply({ type: 'key', key: 'right', shift: true });
    field.apply({ type: 'key', key: 'right', shift: true });
    t.deepEqual(field.selection.get(), { start: 0, end: 2 }, 'shift+right extends from the anchor');
    t.equal(field.caret.get(), 2, 'caret is the moving head');
    field.apply({ type: 'key', key: 'right', shift: true, alt: true });
    t.deepEqual(field.selection.get(), { start: 0, end: 5 }, 'shift+alt+right extends by word');
    field.apply({ type: 'key', key: 'left', shift: true, alt: true });
    t.equal(field.selection.get(), null, 'shrinking back to the anchor collapses');
    field.apply({ type: 'key', key: 'end', shift: true });
    t.deepEqual(field.selection.get(), { start: 0, end: 11 }, 'shift+end selects to the end');
    field.apply({ type: 'key', key: 'left' });
    t.equal(field.caret.get(), 0, 'plain left collapses to the left edge');
    t.equal(field.selection.get(), null, 'collapse clears the selection');
    field.apply({ type: 'key', key: 'right', shift: true, alt: true });
    field.apply({ type: 'key', key: 'x', text: 'x' });
    t.equal(field.value.get(), 'x world', 'typing replaces the selection');
    t.equal(field.caret.get(), 1, 'caret follows the replacement');
    field.apply({ type: 'key', key: 'end', shift: true });
    field.apply({ type: 'key', key: 'backspace' });
    t.equal(field.value.get(), 'x', 'backspace deletes the selection');
  });

  it('paints the selected range inverse', (t) => {
    const frame = layoutFrame(<TextInput value="hello world" selection={{ start: 6, end: 11 }} />, {
      width: 20,
      height: 1,
    });
    const segments = frame.rows[0]!.segments;
    const selected = segments.find((segment) => segment.text === 'world');
    t.ok(selected !== undefined, 'selection splits into its own segment');
    t.equal(
      (selected!.style as { inverse?: boolean }).inverse,
      true,
      'selected range renders inverse',
    );
    const plain = segments.find((segment) => segment.text.includes('hello'));
    t.ok(
      plain !== undefined && (plain.style as { inverse?: boolean }).inverse !== true,
      'unselected text stays plain',
    );
  });

  it('edits a text input through the semantic value contract', (t) => {
    const app = live();
    const field = createTextField('hi');
    const submitted: string[] = [];
    const view = (): VNode => (
      <TextInput
        value={field.value.get()}
        caret={field.caret.get()}
        focused
        onChange={field.set}
        onSubmit={(value) => submitted.push(value)}
      />
    );
    app.render(view());
    // Key routing only reaches a focused node (captureKeys is for overlays
    // catching Escape while nothing is focused) — click the field first, the
    // same way a real terminal app's Tab/click focus flow would.
    click(app, 1, 0);
    app.dispatcher.dispatch({ type: 'key', key: '!', text: '!' });
    t.equal(field.value.get(), 'hi!', 'typed character lands through onChange');
    app.render(view());
    app.dispatcher.dispatch({ type: 'key', key: 'left' });
    app.render(view());
    t.equal(field.caret.get(), 2, 'arrow moves the caret through onChange');
    app.dispatcher.dispatch({ type: 'key', key: 'backspace' });
    app.render(view());
    t.equal(field.value.get(), 'h!', 'backspace edits at the moved caret');
    app.dispatcher.dispatch({ type: 'key', key: 'enter' });
    t.deepEqual(submitted, ['h!'], 'enter fires onSubmit with the current value');
    t.ok(app.text()[0]!.includes('h!'), 'frame shows the edited value');
  });

  it('drives a radio group by click', (t) => {
    const app = live();
    const value = createSignal('a');
    const view = (): VNode => (
      <RadioGroup
        value={value.get()}
        options={[
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Beta' },
        ]}
        onChange={(key) => value.set(key)}
      />
    );
    app.render(view());
    click(app, 4, 1);
    t.equal(value.get(), 'b', 'clicking the second row selects it');
  });
});

describe('fino:ui/components disclosure', () => {
  it('shows and hides details content', (t) => {
    const closed = lines(
      <Details title="Advanced" open={false}>
        <Text>secret</Text>
      </Details>,
      20,
      3,
    );
    t.equal(strip(closed[0]!), '▸ Advanced', 'closed summary');
    t.equal(strip(closed[1]!), '', 'content hidden');
    const open = lines(
      <Details title="Advanced" open>
        <Text>secret</Text>
      </Details>,
      20,
      3,
    );
    t.equal(strip(open[0]!), '▾ Advanced', 'open summary');
    t.equal(strip(open[1]!), '  secret', 'content indented beneath');
  });

  it('places the details expander by position', (t) => {
    const at = (expander: 'start' | 'end' | 'none'): string =>
      strip(
        lines(
          <Details title="More" open={false} expander={expander}>
            <Text>body</Text>
          </Details>,
          20,
          2,
        )[0]!,
      );
    t.equal(at('start'), '▸ More', 'start leads the title');
    t.equal(at('end'), 'More ▸', 'end trails the title');
    t.equal(at('none'), 'More', 'none renders no affordance');
  });

  it('toggles a standalone expander by click', (t) => {
    const app = live();
    const open = createSignal(false);
    const view = (): VNode => <Expander open={open.get()} onToggle={(next) => open.set(next)} />;
    app.render(view());
    t.equal(strip(app.text()[0]!), '▸', 'closed glyph');
    click(app, 0, 0);
    t.equal(open.get(), true, 'click toggles open');
    app.render(view());
    t.equal(strip(app.text()[0]!), '▾', 'open glyph');
    click(app, 0, 0);
    t.equal(open.get(), false, 'click toggles closed');
  });

  it('toggles details by clicking the summary bar', (t) => {
    const app = live();
    const disclosure = createDisclosure(false);
    const view = (): VNode => (
      <Details title="More" open={disclosure.open.get()} onToggle={(next) => disclosure.set(next)}>
        <Text>body</Text>
      </Details>
    );
    app.render(view());
    click(app, 3, 0);
    t.equal(disclosure.open.get(), true, 'summary click opens');
    app.render(view());
    t.equal(app.text()[1]!.includes('body'), true, 'content appears');
  });

  it('switches tabs by click and marks the active label', (t) => {
    const app = live();
    const tab = createSignal('agent');
    const view = (): VNode => (
      <Tabs
        value={tab.get()}
        onChange={(key) => tab.set(key)}
        items={[
          { key: 'agent', label: 'Agent' },
          { key: 'log', label: 'Log' },
        ]}
      >
        <Text>{tab.get() === 'agent' ? 'agent panel' : 'log panel'}</Text>
      </Tabs>
    );
    app.render(view());
    t.ok(app.text()[2]!.includes('agent panel'), 'first panel shown');
    click(app, 8, 0);
    t.equal(tab.get(), 'log', 'clicking the second label switches');
    app.render(view());
    t.ok(app.text()[2]!.includes('log panel'), 'second panel shown');
  });
});

describe('fino:ui/components menus and overlays', () => {
  it('renders windowed menu lists with selection markers', (t) => {
    const items = [
      { kind: 'header', label: 'Models' } as const,
      { key: 'a', label: 'alpha', detail: 'fast' },
      { key: 'b', label: 'beta' },
      { key: 'c', label: 'gamma' },
    ];
    const frame = lines(<MenuList items={items} selectedKey="b" top={0} maxRows={3} />, 20, 4);
    t.equal(strip(frame[0]!), 'Models', 'header row');
    t.equal(strip(frame[1]!), '  alpha fast', 'unselected row with detail');
    t.equal(strip(frame[2]!), '▸ beta', 'selected row is marked');
    t.equal(strip(frame[3]!), '… 1 more', 'overflow note');
  });

  it('moves a ListSelection with keys, skipping non-items', (t) => {
    const selection = new ListSelection({ maxRows: 2 });
    selection.setItems([
      { kind: 'header', label: 'H' },
      { key: 'a', label: 'a' },
      { key: 'b', label: 'b', disabled: true },
      { key: 'c', label: 'c' },
    ]);
    t.equal(selection.selectedKey, 'a', 'first selectable wins');
    selection.handleKey({ type: 'key', key: 'down' });
    t.equal(selection.selectedKey, 'c', 'movement skips disabled rows');
    t.equal(selection.top > 0, true, 'window follows the selection');
    selection.handleKey({ type: 'key', key: 'up' });
    t.equal(selection.selectedKey, 'a', 'up returns');
  });

  it('selects from a menu by click', (t) => {
    const app = live();
    const picked: string[] = [];
    app.render(
      <MenuList
        items={[
          { key: 'a', label: 'alpha' },
          { key: 'b', label: 'beta' },
        ]}
        selectedKey="a"
        onSelect={(key) => picked.push(key)}
      />,
    );
    click(app, 3, 1);
    t.deepEqual(picked, ['b'], 'row click reports its key');
  });

  it('centers a modal over a dimmed backdrop and dismisses on escape', (t) => {
    const app = live(24, 8);
    const dismissed: boolean[] = [];
    app.render(
      <VStack>
        <Text>underneath content</Text>
        <Modal title="Confirm" onDismiss={() => dismissed.push(true)}>
          <Text>Are you sure?</Text>
        </Modal>
      </VStack>,
    );
    const rows = app.text();
    t.ok(
      rows.some((row) => row.includes('Are you sure?')),
      'modal content painted',
    );
    t.ok(
      rows.some((row) => row.includes('Confirm')),
      'title in the border',
    );
    app.dispatcher.dispatch({ type: 'key', key: 'escape' });
    t.deepEqual(dismissed, [true], 'escape bubbles to the modal root');
  });

  it('opens a context menu at a position and dismisses on outside click', (t) => {
    const app = live(30, 8);
    const events: string[] = [];
    app.render(
      <VStack>
        <Text>row one</Text>
        <ContextMenu
          at={{ x: 4, y: 1 }}
          items={[
            { key: 'rename', label: 'Rename' },
            { key: 'delete', label: 'Delete' },
          ]}
          onSelect={(key) => events.push(`select:${key}`)}
          onDismiss={() => events.push('dismiss')}
        />
      </VStack>,
    );
    t.ok(
      app.text().some((row) => row.includes('Rename')),
      'menu painted at the anchor',
    );
    t.ok(app.text()[0]!.includes('row one'), 'content beneath the menu stays visible');
    click(app, 6, 3);
    t.deepEqual(events, ['select:rename'], 'clicking a row selects');
    click(app, 28, 0);
    t.deepEqual(events, ['select:rename', 'dismiss'], 'clicking outside dismisses');
  });

  it('anchors a select popover under its trigger', (t) => {
    const app = live(24, 8);
    const state = { open: createSignal(false), value: createSignal<string | null>(null) };
    const view = (): VNode => (
      <VStack>
        <Select
          id="model"
          value={state.value.get()}
          open={state.open.get()}
          onOpenChange={(next) => state.open.set(next)}
          onChange={(key) => state.value.set(key)}
          placeholder="Pick a model"
          options={[
            { key: 'fast', label: 'fast-1' },
            { key: 'smart', label: 'smart-2' },
          ]}
        />
        <Text>below</Text>
      </VStack>
    );
    app.render(view());
    t.ok(app.text()[0]!.includes('Pick a model'), 'placeholder shown');
    click(app, 2, 0);
    t.equal(state.open.get(), true, 'trigger click opens');
    app.render(view());
    t.ok(
      app.text().some((row) => row.includes('fast-1')),
      'options painted beneath the trigger',
    );
    click(app, 4, 2);
    t.equal(state.value.get(), 'fast', 'option click changes the value');
    t.equal(state.open.get(), false, 'and closes the popover');
  });
});
