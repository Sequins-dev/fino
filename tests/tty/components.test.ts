import { describe, it } from 'fino:test/test';
import { stripAnsi, type TuiKeyEvent } from 'fino:tty/tui';
import { tk, style } from 'fino:tty/components/theme';
import { padAnsi, clipAnsi, wrapPlain, indent } from 'fino:tty/components/text';
import { Spinner, SPINNER_FRAMES } from 'fino:tty/components/spinner';
import { renderBox, renderRule } from 'fino:tty/components/box';
import { SelectList, type ListItem } from 'fino:tty/components/list';
import { Composer } from 'fino:tty/components/composer';

function key(
  name: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; text?: string } = {},
): TuiKeyEvent {
  return { type: 'key', key: name, ...mods };
}

function typeText(composer: Composer, text: string, width = 40): void {
  for (const ch of text) composer.handleKey(key(ch, { text: ch }), width);
}

describe('components/theme', () => {
  it('composes tokens around text and closes with a reset', (t) => {
    t.equal(style('hi', tk.bold, tk.cyan), '\x1b[1m\x1b[36mhi\x1b[0m', 'tokens then text then reset');
    t.equal(style('hi', tk.dim), '\x1b[2mhi\x1b[0m', 'single token');
    t.equal(style('hi'), 'hi', 'no tokens returns text unchanged');
  });
});

describe('components/text', () => {
  it('pads by visible width and never clips', (t) => {
    t.equal(padAnsi('hi', 4), 'hi  ', 'pads with trailing spaces');
    t.equal(padAnsi('hello', 3), 'hello', 'longer text is untouched');
    t.equal(padAnsi(style('hi', tk.cyan), 4), style('hi', tk.cyan) + '  ', 'styled text measured visibly');
  });
  it('clips with an ellipsis only when clipping happens', (t) => {
    t.equal(clipAnsi('hi', 5), 'hi', 'short text untouched');
    t.equal(clipAnsi('hello', 5), 'hello', 'exact fit untouched');
    t.equal(clipAnsi('hello world', 5), 'hell…', 'clip ends in ellipsis taking one cell');
    t.equal(clipAnsi('hello', 0), '', 'zero width yields empty');
    const styled = clipAnsi(style('hello world', tk.green), 5);
    t.equal(stripAnsi(styled), 'hell…', 'styled clip has the same visible text');
    t.ok(styled.includes(tk.reset), 'reset preserved before the ellipsis');
    t.ok(styled.startsWith(tk.green), 'styling preserved on the kept text');
  });
  it('word-wraps plain text', (t) => {
    t.deepEqual(wrapPlain('hello wide world', 6), ['hello', 'wide', 'world'], 'breaks on spaces');
    t.deepEqual(wrapPlain('abcdefgh', 3), ['abc', 'def', 'gh'], 'hard-breaks long words');
    t.deepEqual(wrapPlain('ab\ncd', 10), ['ab', 'cd'], 'honors embedded newlines');
    t.deepEqual(wrapPlain('', 5), [''], 'empty input wraps to one empty line');
  });
  it('indents with distinct continuation prefixes', (t) => {
    t.deepEqual(indent(['a', 'b'], '- ', '  '), ['- a', '  b'], 'first and continuation differ');
    t.deepEqual(indent(['a', 'b'], '> '), ['> a', '> b'], 'continuation defaults to prefix');
  });
});

describe('components/spinner', () => {
  it('cycles through the frames and wraps', (t) => {
    const spinner = new Spinner();
    t.equal(spinner.frame(), SPINNER_FRAMES[0], 'starts on the first frame');
    spinner.tick();
    t.equal(spinner.frame(), SPINNER_FRAMES[1], 'tick advances');
    for (let i = 1; i < SPINNER_FRAMES.length; i++) spinner.tick();
    t.equal(spinner.frame(), SPINNER_FRAMES[0], 'wraps after the last frame');
  });
});

describe('components/box', () => {
  it('renders a titled, footered box at exact width', (t) => {
    const lines = renderBox(['hello', style('x', tk.red)], {
      width: 20,
      title: 'Ti',
      footer: 'Fo',
      borderStyle: tk.cyan,
    });
    t.deepEqual(
      lines.map(stripAnsi),
      [
        '┌─ Ti ─────────────┐',
        '│ hello            │',
        '│ x                │',
        '└─ Fo ─────────────┘',
      ],
      'box snapshot at width 20',
    );
    for (const line of lines) {
      t.equal(stripAnsi(line).length, 20, 'every line is exactly the requested width');
    }
    t.ok(lines[0]!.startsWith(tk.cyan + '┌─' + tk.reset), 'borderStyle wraps the top border chars');
    t.ok(lines[1]!.startsWith(tk.cyan + '│' + tk.reset), 'borderStyle wraps the side border chars');
    t.ok(lines[2]!.includes(style('x', tk.red)), 'body lines keep their own styling');
  });
  it('clips body lines and honors pad', (t) => {
    const lines = renderBox(['abcdefghij'], { width: 10, pad: 0 });
    t.deepEqual(lines.map(stripAnsi), ['┌────────┐', '│abcdefg…│', '└────────┘'], 'pad 0 and clipped body');
  });
  it('renders a rule', (t) => {
    t.equal(renderRule(4), style('────', tk.dim), 'dim by default');
    t.equal(renderRule(3, tk.cyan), style('───', tk.cyan), 'custom token');
  });
});

describe('components/list', () => {
  const item = (n: number): ListItem => ({ kind: 'item', key: `i${n}`, label: `Item ${n}` });
  it('selects the first selectable item and skips non-items when moving', (t) => {
    const list = new SelectList({ maxRows: 10 });
    list.setItems([
      { kind: 'header', label: 'H' },
      { kind: 'item', key: 'a', label: 'A' },
      { kind: 'separator' },
      { kind: 'item', key: 'b', label: 'B', disabled: true },
      { kind: 'item', key: 'c', label: 'C' },
    ]);
    t.equal(list.selectedKey, 'a', 'first selectable item selected');
    t.equal(list.move(-1), false, 'clamped at the top');
    t.equal(list.move(1), true, 'moved down');
    t.equal(list.selectedKey, 'c', 'skipped separator and disabled item');
    t.equal(list.move(1), false, 'clamped at the bottom');
    t.equal(list.move(-1), true, 'moved back up');
    t.equal(list.selectedKey, 'a', 'back to the first item');
  });
  it('keeps the selected key across setItems when asked', (t) => {
    const list = new SelectList({ maxRows: 10 });
    list.setItems([item(0), item(1), item(2)]);
    list.move(1);
    t.equal(list.selectedKey, 'i1', 'moved to the second item');
    list.setItems([item(2), item(1), item(0)], { keepKey: true });
    t.equal(list.selectedKey, 'i1', 'keepKey follows the key, not the index');
    list.setItems([item(3), item(1)], { keepKey: false });
    t.equal(list.selectedKey, 'i3', 'without keepKey the first item wins');
    list.setItems([item(4), item(5)], { keepKey: true });
    t.equal(list.selectedKey, 'i4', 'keepKey falls back when the key is gone');
  });
  it('scrolls a snap-to-selection window with an overflow hint', (t) => {
    const list = new SelectList({ maxRows: 4 });
    list.setItems(Array.from({ length: 10 }, (_, n) => item(n)));
    let pane = list.render(20);
    t.equal(pane.lines.length, 4, 'window is maxRows tall');
    t.equal(stripAnsi(pane.lines[0]!), '▸ Item 0', 'top of the list visible');
    t.equal(stripAnsi(pane.lines[3]!), '… 7 more (↑/↓)', 'overflow hint on the last row');
    t.deepEqual(
      pane.hits,
      [
        { row: 0, startCol: 0, endCol: 20, key: 'i0' },
        { row: 1, startCol: 0, endCol: 20, key: 'i1' },
        { row: 2, startCol: 0, endCol: 20, key: 'i2' },
      ],
      'hit regions cover the visible item rows',
    );
    list.move(1);
    list.move(1);
    list.move(1);
    pane = list.render(20);
    t.equal(stripAnsi(pane.lines[0]!), '▸ Item 1', 'window scrolled to keep selection visible');
    t.equal(stripAnsi(pane.lines[2]!), '▸ Item 3', 'selection on the last item row');
    t.ok(pane.lines[2]!.includes(style('Item 3', tk.bold, tk.white)), 'selected label bold white');
    t.ok(pane.lines[2]!.includes(style('▸', tk.white)), 'selected marker white');
    t.ok(pane.lines[0]!.includes(style('▸', tk.dim)), 'unselected marker dim');
    t.equal(stripAnsi(pane.lines[3]!), '… 6 more (↑/↓)', 'hint counts what is below the window');
    list.movePage(1);
    t.equal(list.selectedKey, 'i7', 'movePage jumps by maxRows');
    list.move(1);
    list.move(1);
    t.equal(list.selectedKey, 'i9', 'clamped page landing plus moves reach the end');
    pane = list.render(20);
    t.equal(pane.lines.length, 4, 'full window at the bottom');
    t.equal(stripAnsi(pane.lines[3]!), '▸ Item 9', 'no hint when nothing is below');
    t.equal(list.selectKey('i0'), true, 'selectKey finds the item');
    pane = list.render(20);
    t.equal(stripAnsi(pane.lines[0]!), '▸ Item 0', 'window snapped back to the top');
    t.equal(list.selectKey('nope'), false, 'unknown key rejected');
  });
  it('renders glyph, detail, current, and footerHint decorations', (t) => {
    const list = new SelectList({ maxRows: 5 });
    list.setItems([
      { kind: 'item', key: 'a', label: 'A', glyph: style('*', tk.yellow), detail: 'd', current: true },
    ]);
    const pane = list.render(30, { footerHint: 'enter to pick' });
    t.equal(stripAnsi(pane.lines[0]!), '▸ * A d ●', 'marker, glyph, label, detail, current dot');
    t.ok(pane.lines[0]!.includes(style('d', tk.dim)), 'detail dim');
    t.ok(pane.lines[0]!.includes(style('●', tk.green)), 'current dot green');
    t.equal(stripAnsi(pane.lines[1]!), 'enter to pick', 'footerHint appended');
    t.ok(pane.lines[1]!.includes(tk.dim), 'footerHint dim');
  });
  it('maps hover rows back through the rendered window', (t) => {
    const list = new SelectList({ maxRows: 5 });
    list.setItems([
      { kind: 'header', label: 'H' },
      { kind: 'item', key: 'a', label: 'A' },
      { kind: 'item', key: 'b', label: 'B' },
    ]);
    const pane = list.render(20);
    t.equal(pane.hits.length, 2, 'only item rows are hittable');
    t.equal(pane.hits[0]!.row, 1, 'hit rows account for the header');
    t.equal(list.hoverAt(2), true, 'hovering another item row selects it');
    t.equal(list.selectedKey, 'b', 'hover moved the selection');
    t.equal(list.hoverAt(2), false, 'hovering the selected row changes nothing');
    t.equal(list.hoverAt(0), false, 'hovering a header changes nothing');
    t.equal(list.hoverAt(9), false, 'hovering outside the window changes nothing');
  });
});

describe('components/composer', () => {
  it('runs the editing keymap', (t) => {
    const composer = new Composer();
    const w = 40;
    t.equal(composer.handleKey(key('h', { text: 'h' }), w), 'edited', 'typing edits');
    typeText(composer, 'ello');
    t.equal(composer.text, 'hello', 'typed text accumulates');
    t.equal(composer.handleKey(key('enter'), w), 'submit', 'enter submits');
    t.equal(composer.text, 'hello', 'submit leaves the text for the caller');
    composer.clear();
    t.equal(composer.text, '', 'clear empties the buffer');
    typeText(composer, 'ab');
    t.equal(composer.handleKey(key('enter', { alt: true }), w), 'edited', 'alt+enter edits');
    typeText(composer, 'cd');
    t.equal(composer.text, 'ab\ncd', 'alt+enter inserted a newline');
    t.equal(composer.handleKey(key('enter', { shift: true }), w), 'edited', 'shift+enter edits');
    t.equal(composer.text, 'ab\ncd\n', 'shift+enter inserted a newline');
    t.equal(composer.handleKey(key('f5'), w), 'unhandled', 'unknown keys are unhandled');
  });
  it('selects and deletes by word', (t) => {
    const composer = new Composer();
    const w = 40;
    typeText(composer, 'hello world');
    t.equal(composer.handleKey(key('left', { alt: true, shift: true }), w), 'edited', 'word select edits');
    t.equal(composer.buffer.selectedText(), 'world', 'shift+alt+left selected the last word');
    t.equal(composer.handleKey(key('backspace', { alt: true }), w), 'edited', 'word delete edits');
    t.equal(composer.text, 'hello ', 'selection deleted');
    t.equal(composer.handleKey(key('home'), w), 'edited', 'home edits');
    t.equal(composer.handleKey(key('right', { alt: true, shift: true }), w), 'edited');
    t.equal(composer.buffer.selectedText(), 'hello', 'shift+alt+right selected forward');
    composer.handleKey(key('end'), w);
    t.equal(composer.handleKey(key('b', { alt: true }), w), 'edited', 'alt+b edits');
    t.equal(composer.buffer.cursor, 0, 'alt+b jumped a word left');
    t.equal(composer.handleKey(key('f', { alt: true }), w), 'edited', 'alt+f edits');
    t.equal(composer.buffer.cursor, 5, 'alt+f jumped a word right');
    t.equal(composer.handleKey(key('delete', { alt: true }), w), 'edited', 'forward word delete');
    t.equal(composer.text, 'hello', 'trailing space word removed');
  });
  it('replaces everything after ctrl+a, clears on ctrl+u', (t) => {
    const composer = new Composer();
    const w = 40;
    typeText(composer, 'old text');
    t.equal(composer.handleKey(key('a', { ctrl: true }), w), 'edited', 'ctrl+a edits');
    typeText(composer, 'x');
    t.equal(composer.text, 'x', 'typing over a select-all replaces the text');
    t.equal(composer.handleKey(key('u', { ctrl: true }), w), 'edited', 'ctrl+u edits');
    t.equal(composer.text, '', 'ctrl+u cleared');
  });
  it('walks wrapped lines before recalling history at the edges', (t) => {
    const composer = new Composer();
    const w = 12;
    composer.setHistory(['one', 'two']);
    composer.buffer.setText('aaaa bbbb cccc');
    t.equal(composer.cursor({ width: w }).row, 1, 'cursor starts on the wrapped line');
    t.equal(composer.handleKey(key('up'), w), 'edited', 'up edits');
    t.equal(composer.text, 'aaaa bbbb cccc', 'up moved within the buffer, no recall');
    t.equal(composer.cursor({ width: w }).row, 0, 'cursor moved to the first line');
    composer.handleKey(key('up'), w);
    t.equal(composer.text, 'two', 'up at the top edge recalled newest history');
    composer.handleKey(key('up'), w);
    t.equal(composer.text, 'one', 'up again walked back');
    composer.handleKey(key('up'), w);
    t.equal(composer.text, 'one', 'history clamps at the oldest entry');
    composer.handleKey(key('down'), w);
    t.equal(composer.text, 'two', 'down walks forward');
    composer.handleKey(key('down'), w);
    t.equal(composer.text, '', 'down past the newest entry clears');
  });
  it('reports the terminal cursor position after the prompt', (t) => {
    const composer = new Composer();
    t.deepEqual(composer.cursor({ width: 40 }), { row: 0, column: 2 }, 'empty buffer parks after the prompt');
    composer.buffer.setText('hi');
    t.deepEqual(composer.cursor({ width: 40 }), { row: 0, column: 4 }, 'first row offsets by prompt width');
    composer.buffer.setText('aaaa bbbb cccc');
    t.deepEqual(composer.cursor({ width: 12 }), { row: 1, column: 6 }, 'continuation rows offset to match');
  });
  it('renders prompt, placeholder, and inverse selection with no fake cursor', (t) => {
    const composer = new Composer();
    let lines = composer.render({ width: 20, placeholder: 'type here' });
    t.equal(lines.length, 1, 'empty buffer renders one line');
    t.equal(stripAnsi(lines[0]!), '❯ type here', 'placeholder after the prompt');
    t.ok(lines[0]!.includes(tk.cyan), 'prompt cyan');
    t.ok(lines[0]!.includes(tk.dim + 'type here'), 'placeholder dim');
    composer.buffer.setText('aaaa bbbb cccc');
    lines = composer.render({ width: 12 });
    t.deepEqual(lines.map(stripAnsi), ['❯ aaaa bbbb ', '  cccc'], 'wrapped rows with matching indent');
    for (const line of lines) {
      t.ok(!line.includes(tk.inverse), 'no inverse cell without a selection — no fake cursor');
    }
    composer.handleKey(key('a', { ctrl: true }), 12);
    lines = composer.render({ width: 12 });
    t.ok(lines[0]!.includes(tk.inverse), 'selection painted inverse');
    t.ok(lines[1]!.includes(tk.inverse), 'selection spans wrapped rows');
  });
});
