import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import {
  Box,
  Button,
  Input,
  List,
  ScrollView,
  Spacer,
  Text,
  decodeTuiInput,
  renderFrame,
} from 'fino:tty/tui';
describe('fino:tty/tui renderFrame', () => {
  it('renders text, borders, padding, gap, and flex rows deterministically', (t) => {
    const frame = renderFrame(
      h(
        Box,
        {
          direction: 'row',
          gap: 1,
          border: true,
          padding: 1,
        },
        h(Text, null, 'A'),
        h(Spacer, { flex: 1 }),
        h(Text, null, 'B'),
      ),
      {
        width: 10,
        height: 5,
      },
    );
    t.equal(
      frame,
      ['+--------+', '|        |', '| A    B |', '|        |', '+--------+'].join('\n'),
      'row layout fills available width',
    );
  });
  it('wraps and clips text inside fixed frames', (t) => {
    const frame = renderFrame(
      h(
        Box,
        {
          width: 8,
          height: 3,
        },
        h(Text, { wrap: true }, 'hello world'),
      ),
      {
        width: 8,
        height: 3,
      },
    );
    t.equal(
      frame,
      ['hello wo', 'rld     ', '        '].join('\n'),
      'wrapped text is clipped to the frame',
    );
  });
  it('renders terminal controls with focus order markers', (t) => {
    const frame = renderFrame(
      h(
        Box,
        { direction: 'column' },
        h(Input, {
          value: 'query',
          focused: true,
        }),
        h(Button, { label: 'Go' }),
        h(List, {
          items: ['one', 'two'],
          selectedIndex: 1,
        }),
        h(ScrollView, { height: 1 }, h(Text, null, 'line 1'), h(Text, null, 'line 2')),
      ),
      {
        width: 12,
        height: 6,
      },
    );
    t.equal(
      frame,
      [
        '> query     ',
        '[ Go ]      ',
        '  one       ',
        '> two       ',
        'line 1      ',
        '            ',
      ].join('\n'),
      'controls render as deterministic terminal primitives',
    );
  });
  it('renders input background styling without changing cell width', (t) => {
    const frame = renderFrame(
      h(Input, {
        value: 'name',
        focused: true,
        background: 'brightBlack',
      }),
      {
        width: 10,
        height: 1,
      },
    );
    t.equal(frame, '\x1B[100m> name    \x1B[0m', 'background wraps the padded input row');
  });
  it('renders background-colored vertical padding bands', (t) => {
    const frame = renderFrame(
      h(
        Box,
        {
          height: 3,
          paddingY: 1,
          background: 'brightBlack',
        },
        h(Text, null, 'entry'),
      ),
      {
        width: 8,
        height: 3,
      },
    );
    t.equal(
      frame,
      ['\x1B[100m        \x1B[0m', '\x1B[100mentry   \x1B[0m', '\x1B[100m        \x1B[0m'].join(
        '\n',
      ),
      'background covers blank padding rows',
    );
  });
});
describe('fino:tty/tui input decoding', () => {
  it('decodes printable text, control keys, and arrows', (t) => {
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('a')),
      [
        {
          type: 'key',
          key: 'a',
          text: 'a',
        },
      ],
      'printable key',
    );
    t.deepEqual(
      decodeTuiInput(Uint8Array.of(3)),
      [
        {
          type: 'key',
          key: 'c',
          ctrl: true,
        },
      ],
      'ctrl-c',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[A')),
      [
        {
          type: 'key',
          key: 'up',
        },
      ],
      'up arrow',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[Z')),
      [
        {
          type: 'key',
          key: 'tab',
          shift: true,
        },
      ],
      'shift-tab',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[1;5D')),
      [
        {
          type: 'key',
          key: 'left',
          ctrl: true,
        },
      ],
      'ctrl-left arrow',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[1;2C')),
      [
        {
          type: 'key',
          key: 'right',
          shift: true,
        },
      ],
      'shift-right arrow',
    );
  });
  it('decodes SGR mouse events', (t) => {
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[<0;12;5M')),
      [
        {
          type: 'mouse',
          action: 'press',
          button: 'left',
          x: 11,
          y: 4,
          ctrl: false,
          alt: false,
          shift: false,
        },
      ],
      'left press uses zero-based coordinates',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[<0;12;5m')),
      [
        {
          type: 'mouse',
          action: 'release',
          button: 'left',
          x: 11,
          y: 4,
          ctrl: false,
          alt: false,
          shift: false,
        },
      ],
      'SGR release uses the lowercase terminator',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[<35;12;5M')),
      [
        {
          type: 'mouse',
          action: 'move',
          button: 'none',
          x: 11,
          y: 4,
          ctrl: false,
          alt: false,
          shift: false,
        },
      ],
      'motion with no button held is a hover move, not a release',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[<32;12;5M')),
      [
        {
          type: 'mouse',
          action: 'drag',
          button: 'left',
          x: 11,
          y: 4,
          ctrl: false,
          alt: false,
          shift: false,
        },
      ],
      'motion with a button held is a drag',
    );
    t.deepEqual(
      decodeTuiInput(new TextEncoder().encode('\x1B[<64;2;3M')),
      [
        {
          type: 'mouse',
          action: 'wheel',
          button: 'wheel-up',
          x: 1,
          y: 2,
          ctrl: false,
          alt: false,
          shift: false,
        },
      ],
      'wheel event',
    );
  });
});
describe('fino:tty/tui terminal resize', () => {
  it('onResize reports the current size immediately and again on SIGWINCH', async (t) => {
    const { onResize } = await import('internal:tty/bindings');
    const { kill, pid, SIGWINCH, signalArmed } = await import('fino:process');
    const sizes: Array<{ width: number; height: number }> = [];
    const stop = onResize((size) => sizes.push(size));
    t.equal(sizes.length, 1, 'synchronous initial callback');
    t.ok(sizes[0]!.width > 0 && sizes[0]!.height > 0, 'initial size is sane');
    await signalArmed('SIGWINCH');
    kill(pid, SIGWINCH);
    for (let attempt = 0; attempt < 200 && sizes.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    t.ok(sizes.length >= 2, 'SIGWINCH delivered a resize callback');
    stop();
    const settled = sizes.length;
    kill(pid, SIGWINCH);
    await new Promise((resolve) => setTimeout(resolve, 50));
    t.equal(sizes.length, settled, 'disposer unsubscribes');
  });
});
describe('fino:tty/tui ANSI clipping', () => {
  it('clips over-wide styled rows without leaking SGR state', (t) => {
    const styled = '\x1b[44mthis line is far too wide for the frame\x1b[0m';
    const frame = renderFrame(h(Text, null, styled), { width: 10, height: 1 });
    t.ok(frame.endsWith('\x1b[0m'), 'clipped styled line closes with a reset');
    t.equal(
      frame.replace(/\x1b\[[0-9;]*m/g, '').length,
      10,
      'visible width matches the frame width',
    );
    t.ok(frame.startsWith('\x1b[44m'), 'leading style preserved');
  });

  it('pads short styled rows and still terminates with a reset', (t) => {
    const frame = renderFrame(h(Text, null, '\x1b[31mhi\x1b[0m'), { width: 6, height: 1 });
    t.equal(frame.replace(/\x1b\[[0-9;]*m/g, ''), 'hi    ', 'padded to width');
    const lastReset = frame.lastIndexOf('\x1b[0m');
    t.ok(frame.slice(lastReset + 4).trim() === '', 'nothing styled after the final reset');
  });
});
describe('fino:tty/tui mouse modes', () => {
  it('requests motion tracking only when asked', async (t) => {
    const { enterMouseMode, exitMouseMode } = await import('internal:tty/bindings');
    t.ok(!enterMouseMode().includes('1003'), 'no any-motion tracking by default');
    t.ok(enterMouseMode({ motion: true }).includes('\x1B[?1003h'), 'motion mode opt-in');
    t.ok(enterMouseMode().includes('\x1B[?1006h'), 'SGR coordinates always requested');
    t.ok(exitMouseMode().includes('\x1B[?1003l'), 'exit disables motion tracking');
  });
});
describe('fino:tty/tui selection', () => {
  it('normalizes endpoints regardless of drag direction', async (t) => {
    const { normalizeSelection } = await import('fino:tty/tui');
    const forward = normalizeSelection({ anchor: { x: 2, y: 1 }, focus: { x: 8, y: 4 } });
    const backward = normalizeSelection({ anchor: { x: 8, y: 4 }, focus: { x: 2, y: 1 } });
    t.deepEqual(forward, backward, 'both drag directions normalize the same');
    t.deepEqual(forward.start, { x: 2, y: 1 }, 'earliest point first');
  });

  it('extracts plain text across rows, ignoring styling and padding', async (t) => {
    const { selectionText } = await import('fino:tty/tui');
    const rows = ['\x1b[31mhello world\x1b[0m   ', 'second line      ', 'third            '];
    t.equal(
      selectionText(rows, { anchor: { x: 6, y: 0 }, focus: { x: 6, y: 1 } }),
      'world\nsecond',
      'multi-row selection strips ANSI and trailing padding',
    );
    t.equal(
      selectionText(rows, { anchor: { x: 0, y: 1 }, focus: { x: 6, y: 1 } }),
      'second',
      'single-row selection',
    );
  });

  it('highlights only the selected cells', async (t) => {
    const { highlightSelection } = await import('fino:tty/tui');
    const rows = ['abcdef', 'ghijkl'];
    const painted = highlightSelection(rows, { anchor: { x: 2, y: 0 }, focus: { x: 4, y: 0 } });
    t.equal(painted[0], 'ab\x1b[7mcd\x1b[0mef', 'inverse wraps the selected span');
    t.equal(painted[1], 'ghijkl', 'untouched rows unchanged');
  });

  it('treats a zero-width selection as empty', async (t) => {
    const { selectionIsEmpty, highlightSelection } = await import('fino:tty/tui');
    const empty = { anchor: { x: 3, y: 1 }, focus: { x: 3, y: 1 } };
    t.equal(selectionIsEmpty(empty), true, 'same point is empty');
    t.deepEqual(highlightSelection(['abc'], empty), ['abc'], 'empty selection paints nothing');
  });

  it('keeps a selection inside its region', async (t) => {
    const { selectionText, highlightSelection, normalizeSelection } = await import('fino:tty/tui');
    // Two panes side by side: a sidebar in columns 0-9, content from 11 on.
    const rows = ['sidebar-a │content one   ', 'sidebar-b │content two   '];
    const region = { x: 11, y: 0, width: 14, height: 2 };
    const dragged = { anchor: { x: 12, y: 0 }, focus: { x: 2, y: 1 }, region };
    t.deepEqual(
      normalizeSelection(dragged).end,
      { x: 11, y: 1 },
      'an endpoint dragged out of the region clamps to its edge',
    );
    t.equal(
      selectionText(rows, { anchor: { x: 11, y: 0 }, focus: { x: 24, y: 1 }, region }),
      'content one\ncontent two',
      'text stops at the region edge instead of running into the pane beside it',
    );
    const painted = highlightSelection(rows, {
      anchor: { x: 0, y: 0 },
      focus: { x: 25, y: 0 },
      region,
    });
    t.equal(
      painted[0],
      'sidebar-a │\x1b[7mcontent one   \x1b[0m',
      'the highlight never paints outside the region',
    );
  });

  it('encodes clipboard writes as OSC 52', async (t) => {
    const { copyToClipboard } = await import('fino:tty/tui');
    const sequence = copyToClipboard('hi');
    t.equal(sequence, `\x1B]52;c;${btoa('hi')}\x07`, 'base64 OSC 52 payload');
  });
});
describe('fino:tty/tui signal-driven rendering', () => {
  it('re-commits frames when an observed signal changes', async (t) => {
    const { createRoot, createSignal } = await import('fino:ui');
    const { frameSink } = await import('fino:tty/tui');
    const count = createSignal(0);
    const frames: string[] = [];
    const sink = frameSink({ width: 10, height: 1 });
    const root = createRoot(() => h(Text, null, `n=${count.get()}`), {
      commit(tree) {
        const frame = sink.commit(tree);
        frames.push(frame);
        return frame;
      },
    });
    t.equal(frames.length, 1, 'first pass renders immediately');
    t.equal(frames[0]!.trimEnd(), 'n=0', 'initial value painted');
    count.set(1);
    t.equal(frames.length, 2, 'signal write re-renders without an imperative call');
    t.equal(frames[1]!.trimEnd(), 'n=1', 'new value painted');
    count.set(1);
    t.equal(frames.length, 2, 'writing the same value does not re-render');
    root.dispose();
    count.set(2);
    t.equal(frames.length, 2, 'disposed root stops observing');
  });
});
