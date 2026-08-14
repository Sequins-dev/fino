import { describe, it } from 'fino:test/test';
import { h, createSignal, createRoot } from 'fino:ui';
import {
  Box,
  Text,
  Spacer,
  Layer,
  renderFrame,
  layoutFrame,
  measure,
  terminalSink,
} from 'fino:tty/tui';
import { hitTest, rowToAnsi } from 'fino:tty/frame';
import { internStyle } from 'fino:tty/style';

function lines(frame: string): string[] {
  return frame.split('\n');
}

describe('internal:tty/layout flexbox', () => {
  it('measures nested boxes from their content', (t) => {
    const tree = h(
      Box,
      { direction: 'column', gap: 1, padding: 1 },
      h(Box, { direction: 'row', gap: 2 }, h(Text, null, 'ab'), h(Text, null, 'cde')),
      h(Text, null, 'wide row here'),
    );
    const size = measure(tree, { width: 40 });
    t.equal(size.width, 15, 'widest child plus padding');
    t.equal(size.height, 5, 'two children, one gap, vertical padding');
  });

  it('grows children by weight and honors basis', (t) => {
    const frame = renderFrame(
      h(
        Box,
        { direction: 'row' },
        h(Text, { grow: 1, basis: 2 }, 'aa'),
        h(Text, { grow: 3, basis: 2 }, 'bb'),
      ),
      { width: 14, height: 1 },
    );
    // free = 14 - 4 = 10 → shares 2 and 8 (floor + remainder order)
    t.equal(lines(frame)[0], 'aa  bb        ', 'grow distributes leftover main axis');
  });

  it('shrinks only children that opt in', (t) => {
    const frame = renderFrame(
      h(Box, { direction: 'row' }, h(Text, { shrink: 1 }, 'abcdefgh'), h(Text, null, 'keep')),
      { width: 8, height: 1 },
    );
    t.equal(lines(frame)[0], 'abcdkeep', 'shrinking child gives up cells, rigid child is intact');
  });

  it('justifies content when nothing grows', (t) => {
    const center = renderFrame(
      h(Box, { direction: 'row', justify: 'center' }, h(Text, null, 'ab')),
      {
        width: 8,
        height: 1,
      },
    );
    t.equal(lines(center)[0], '   ab   ', 'center');
    const end = renderFrame(h(Box, { direction: 'row', justify: 'end' }, h(Text, null, 'ab')), {
      width: 8,
      height: 1,
    });
    t.equal(lines(end)[0], '      ab', 'end');
    const between = renderFrame(
      h(
        Box,
        { direction: 'row', justify: 'between' },
        h(Text, null, 'a'),
        h(Text, null, 'b'),
        h(Text, null, 'c'),
      ),
      { width: 9, height: 1 },
    );
    t.equal(lines(between)[0], 'a   b   c', 'between distributes gaps evenly');
  });

  it('aligns on the cross axis, including stretch', (t) => {
    const frame = renderFrame(
      h(
        Box,
        { direction: 'row', height: 3, align: 'center' },
        h(Text, null, 'mid'),
        h(Text, { alignSelf: 'end' }, 'low'),
      ),
      { width: 8, height: 3 },
    );
    t.deepEqual(lines(frame), ['        ', 'mid     ', '   low  '], 'center and per-child end');
  });

  it('skips gaps for empty children', (t) => {
    const empty = null;
    const frame = renderFrame(
      h(
        Box,
        { direction: 'column', gap: 1 },
        h(Text, null, 'one'),
        empty,
        h(Box, { direction: 'column' }),
        h(Text, null, 'two'),
      ),
      { width: 5, height: 5 },
    );
    t.deepEqual(
      lines(frame),
      ['one  ', '     ', 'two  ', '     ', '     '],
      'an empty box contributes no row and no gap',
    );
  });

  it('applies margins outside the child box', (t) => {
    const frame = renderFrame(h(Box, { direction: 'column' }, h(Text, { margin: 1 }, 'in')), {
      width: 6,
      height: 3,
    });
    t.deepEqual(lines(frame), ['      ', ' in   ', '      '], 'margin insets on all sides');
  });

  it('wraps row children onto new lines', (t) => {
    const frame = renderFrame(
      h(
        Box,
        { direction: 'row', wrap: true, gap: 1 },
        h(Text, null, 'aaa'),
        h(Text, null, 'bbb'),
        h(Text, null, 'ccc'),
      ),
      { width: 7, height: 2 },
    );
    t.deepEqual(lines(frame), ['aaa bbb', 'ccc    '], 'overflowing children start a new line');
  });

  it('clamps against min and max sizes', (t) => {
    const size = measure(h(Box, { minWidth: 10, maxHeight: 2 }, h(Text, null, 'hi\nthere\nyou')), {
      width: 40,
    });
    t.equal(size.width, 10, 'minWidth raises the measured width');
    t.equal(size.height, 2, 'maxHeight caps the measured height');
  });
});

describe('internal:tty/layout styling and content', () => {
  it('inherits styles down the tree and fills backgrounds across rects', (t) => {
    const frame = layoutFrame(
      h(Box, { background: 'blue', bold: true, padding: 1 }, h(Text, { color: 'yellow' }, 'hi')),
      { width: 6, height: 3 },
    );
    const middle = frame.rows[1]!;
    t.equal(middle.segments[0]!.style, internStyle({ bg: 'blue' }), 'padding cell keeps the fill');
    t.equal(
      middle.segments[1]!.style,
      internStyle({ bg: 'blue', bold: true, fg: 'yellow' }),
      'text merges inherited attrs with its own color',
    );
    t.equal(frame.rows[0]!.width, 6, 'fill spans the whole row');
  });

  it('parses embedded ANSI in text children against the inherited style', (t) => {
    const frame = layoutFrame(h(Text, { dim: true }, 'a \x1b[32mok\x1b[39m z'), {
      width: 10,
      height: 1,
    });
    const row = frame.rows[0]!;
    t.equal(row.segments[0]!.style, internStyle({ dim: true }), 'plain run inherits');
    t.equal(row.segments[1]!.style, internStyle({ dim: true, fg: 'green' }), 'SGR layers on top');
  });

  it('truncates with an ellipsis', (t) => {
    const frame = renderFrame(h(Text, { truncate: true }, 'abcdefghij'), { width: 6, height: 1 });
    t.equal(lines(frame)[0], 'abcde…', 'ellipsis replaces the clipped tail');
  });

  it('renders multiline text from newlines', (t) => {
    const frame = renderFrame(h(Text, null, 'one\ntwo'), { width: 5, height: 2 });
    t.deepEqual(lines(frame), ['one  ', 'two  '], 'hard newlines split rows');
  });

  it('places wide characters on the grid without splitting', (t) => {
    const frame = layoutFrame(h(Text, null, '日本語'), { width: 5, height: 1 });
    t.equal(frame.rows[0]!.width, 4, 'a straddling wide char is dropped at the clip edge');
    t.equal(rowToAnsi(frame.rows[0]!), '日本', 'two full glyphs survive');
  });

  it('reports the caret cell for wrapped text', (t) => {
    const frame = layoutFrame(h(Text, { wrap: true, caret: 8 }, 'hello world'), {
      width: 6,
      height: 2,
    });
    t.deepEqual(frame.cursor, { row: 1, column: 2 }, 'caret lands inside the wrapped row');
  });

  it('records hit regions with depth', (t) => {
    const frame = layoutFrame(
      h(
        Box,
        { id: 'outer', direction: 'column' },
        h(Text, { id: 'title' }, 'Title'),
        h(Box, { id: 'body', height: 2 }, h(Text, null, 'content')),
      ),
      { width: 10, height: 3 },
    );
    t.equal(hitTest(frame, 2, 0), 'title', 'text region');
    t.equal(hitTest(frame, 2, 1), 'body', 'nested box wins over outer');
    t.equal(hitTest(frame, 9, 2), 'body', 'body spans its full rect');
  });
});

describe('internal:tty/layout layers', () => {
  it('paints layers above the flow, centered by default', (t) => {
    const frame = renderFrame(
      h(
        Box,
        { direction: 'column' },
        h(Text, null, 'aaaaaaaaaa'),
        h(Text, null, 'aaaaaaaaaa'),
        h(Text, null, 'aaaaaaaaaa'),
        h(Layer, null, h(Box, { border: true }, h(Text, null, 'hi'))),
      ),
      { width: 10, height: 3 },
    );
    t.deepEqual(
      lines(frame),
      ['aaa┌──┐aaa', 'aaa│hi│aaa', 'aaa└──┘aaa'],
      'layer content overpaints the base tree',
    );
  });

  it('anchors layers at a position and clamps to the viewport', (t) => {
    const frame = renderFrame(
      h(
        Box,
        { direction: 'column' },
        h(Text, null, 'base'),
        h(Layer, { anchor: { x: 8, y: 0 } }, h(Text, null, 'menu')),
      ),
      { width: 10, height: 3 },
    );
    t.equal(lines(frame)[1], '      menu', 'anchored below the cell, clamped to the right edge');
  });
});

describe('fino:tty/tui terminalSink', () => {
  it('returns structured frames and reuses the retained tree across commits', (t) => {
    const label = createSignal('one');
    const sink = terminalSink({ width: 8, height: 2 });
    const root = createRoot(
      () => h(Box, { direction: 'column' }, h(Text, { id: 'label' }, label.get())),
      sink,
    );
    t.equal(rowToAnsi(root.output.rows[0]!), 'one', 'first commit');
    t.equal(hitTest(root.output, 0, 0), 'label', 'hits survive');
    label.set('two');
    t.equal(rowToAnsi(root.output.rows[0]!), 'two', 'reactive commit updates the frame');
    root.dispose();
  });
});
