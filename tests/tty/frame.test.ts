import { describe, it } from 'fino:test/test';
import {
  EMPTY_ROW,
  clipRow,
  frameToAnsi,
  frameToScreen,
  hitPath,
  hitTest,
  joinRows,
  parseAnsi,
  rowText,
  rowToAnsi,
  textRow,
  visibleWidth,
} from 'fino:tty/frame';
import type { Frame, Row } from 'fino:tty/frame';
import { internStyle } from 'fino:tty/style';

const red = internStyle({ fg: 'red' });
const bold = internStyle({ bold: true });

function frameOf(rows: Row[], width: number, hits: Frame['hits'] = []): Frame {
  return { width, height: rows.length, rows, cursor: null, hits };
}

describe('fino:tty/frame', () => {
  it('builds and joins rows with run merging', (t) => {
    const row = joinRows(textRow('a', red), textRow('b', red), textRow('c', bold));
    t.equal(row.segments.length, 2, 'same-style neighbours merge');
    t.equal(row.segments[0]!.text, 'ab', 'merged run text');
    t.equal(row.width, 3, 'width sums');
    t.equal(rowText(row), 'abc', 'text extraction');
    t.equal(textRow(''), EMPTY_ROW, 'empty text is the empty row');
  });

  it('clips rows cell-accurately, never splitting a wide char', (t) => {
    const row = textRow('ab日cd');
    t.equal(clipRow(row, 10), row, 'no clip needed returns the same row');
    t.equal(rowText(clipRow(row, 4)), 'ab日', 'clip after the wide char');
    const straddled = clipRow(row, 3);
    t.equal(rowText(straddled), 'ab', 'a straddling wide char is dropped');
    t.equal(straddled.width, 2, 'leaving the row a cell short');
  });

  it('encodes rows purely, opening and closing styles', (t) => {
    const row = joinRows(textRow('ok', internStyle({ fg: 'green' })), textRow('!', bold));
    t.equal(rowToAnsi(row), '\x1b[32mok\x1b[1;39m!\x1b[0m', 'minimal transitions inside');
    t.equal(rowToAnsi(textRow('hi')), 'hi', 'unstyled text is bare');
    t.equal(rowToAnsi(textRow('hi'), { pad: 4 }), 'hi  ', 'padding with default style');
    t.equal(
      rowToAnsi(textRow('hi'), { pad: 4, padStyle: { bg: 'blue' } }),
      'hi\x1b[44m  \x1b[0m',
      'padding can carry a background',
    );
    t.equal(rowToAnsi(textRow('hello'), { clip: 3 }), 'hel', 'clip before encode');
    t.equal(rowToAnsi(textRow('hi'), { pad: 2 }), 'hi', 'no padding when already at width');
  });

  it('encodes equal rows to equal bytes', (t) => {
    const a = rowToAnsi(joinRows(textRow('x', red), textRow('y')));
    const b = rowToAnsi(joinRows(textRow('x', red), textRow('y')));
    t.equal(a, b, 'the encoded string is a usable diff key');
  });

  it('encodes frames padded to width', (t) => {
    const frame = frameOf([textRow('ab'), EMPTY_ROW], 4);
    t.equal(frameToAnsi(frame), 'ab  \n    ', 'padded and newline-joined');
    t.equal(frameToAnsi(frame, { pad: false }), 'ab\n', 'ragged when asked');
  });

  it('diffs frames row-wise for screen repaints', (t) => {
    const before = frameOf([textRow('one'), textRow('two'), textRow('three')], 10);
    const after = frameOf([textRow('one'), textRow('TWO'), textRow('three')], 10);
    const paint = frameToScreen(after, before);
    t.equal(paint, '\x1b[2;1H\x1b[KTWO', 'only the changed row is written, erased before write');
    t.ok(
      frameToScreen(after, null).includes('\x1b[1;1H\x1b[Kone'),
      'no previous frame paints everything',
    );
    const shrunk = frameOf([textRow('one')], 10);
    t.ok(
      frameToScreen(shrunk, before).includes('\x1b[3;1H\x1b[K'),
      'rows beyond the new height are erased',
    );
    const offset = frameToScreen(after, before, { row: 5, column: 3 });
    t.equal(offset, '\x1b[6;3H\x1b[KTWO', 'origin offsets addressing');
  });

  it('repaints everything when the width changes', (t) => {
    const before = frameOf([textRow('one'), textRow('two')], 10);
    const after = frameOf([textRow('one'), textRow('two')], 12);
    const paint = frameToScreen(after, before);
    t.ok(paint.includes('one') && paint.includes('two'), 'width change invalidates the diff');
  });

  it('hit-tests to the deepest containing region', (t) => {
    const frame = frameOf([], 20, [
      { id: 'panel', x: 0, y: 0, width: 20, height: 10, depth: 1 },
      { id: 'row-1', x: 2, y: 3, width: 16, height: 1, depth: 3 },
      { id: 'list', x: 1, y: 2, width: 18, height: 6, depth: 2 },
    ]);
    t.equal(hitTest(frame, 5, 3), 'row-1', 'deepest wins');
    t.deepEqual(hitPath(frame, 5, 3), ['panel', 'list', 'row-1'], 'outermost first');
    t.equal(hitTest(frame, 0, 9), 'panel', 'outside inner regions');
    t.equal(hitTest(frame, 0, 15), undefined, 'outside everything');
  });

  it('parses ANSI text into styled rows', (t) => {
    const rows = parseAnsi('plain \x1b[1;33mBUSY\x1b[0m done\nnext');
    t.equal(rows.length, 2, 'newline splits rows');
    const [first, second] = rows;
    t.equal(rowText(first!), 'plain BUSY done', 'text is preserved');
    t.equal(first!.segments.length, 3, 'style changes split segments');
    t.equal(
      first!.segments[1]!.style,
      internStyle({ bold: true, fg: 'yellow' }),
      'SGR params land as interned styles',
    );
    t.equal(rowText(second!), 'next', 'second row');
  });

  it('drops non-SGR control sequences and expands tabs', (t) => {
    const rows = parseAnsi('a\x1b[2Jb\x1b]0;title\x07c\rd\te');
    t.equal(rows.length, 1, 'one row');
    t.equal(rowText(rows[0]!), 'abcd    e', 'ED dropped, OSC dropped, CR dropped, tab expanded');
    const st = parseAnsi('x\x1b]52;c;aGVsbG8=\x1b\\y');
    t.equal(rowText(st[0]!), 'xy', 'ST-terminated OSC is consumed');
  });

  it('round-trips encoded rows through the parser', (t) => {
    const original = joinRows(
      textRow('mix ', internStyle({ fg: 'cyan' })),
      textRow('bold', internStyle({ bold: true, bg: { ansi256: 17 } })),
      textRow(' end'),
    );
    const reparsed = parseAnsi(rowToAnsi(original));
    t.equal(reparsed.length, 1, 'one row back');
    t.equal(rowText(reparsed[0]!), rowText(original), 'text survives');
    t.deepEqual(
      reparsed[0]!.segments.map((s) => s.style),
      original.segments.map((s) => s.style),
      'styles survive the round trip as the same interned pointers',
    );
  });

  it('measures visible width through escapes and wide chars', (t) => {
    t.equal(visibleWidth('\x1b[31m日本\x1b[0m ok'), 7, 'wide-aware and escape-blind');
    t.equal(visibleWidth('plain'), 5, 'plain text');
  });

  it('carries a base style through parsing', (t) => {
    const rows = parseAnsi('dim \x1b[1mloud\x1b[22m dim', internStyle({ dim: true }));
    t.equal(rows[0]!.segments[0]!.style, internStyle({ dim: true }), 'base applies');
    t.equal(
      rows[0]!.segments[1]!.style,
      internStyle({ dim: true, bold: true }),
      'SGR layers over the base',
    );
    t.equal(
      rows[0]!.segments[2]!.style,
      internStyle({}),
      '22 clears intensity outright — the base is initial state, not a floor',
    );
  });
});
