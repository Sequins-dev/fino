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
      decodeTuiInput(new TextEncoder().encode('\x1B[<35;12;5M')),
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
      'release event',
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
