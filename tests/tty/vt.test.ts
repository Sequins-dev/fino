import { describe, it } from 'fino:test/test';
import { Terminal } from 'internal:tty/vt';

describe('vt plain text', () => {
  it('writes text and advances the cursor', (t) => {
    const term = new Terminal({ cols: 10, rows: 3 });
    term.write('hello');
    t.equal(term.text()[0], 'hello');
    t.deepEqual(term.cursor, { row: 0, col: 5 });
    t.deepEqual(term.text(), ['hello', '', '']);
  });

  it('CR returns to column zero and overwrites', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('abc\rX');
    t.equal(term.text()[0], 'Xbc');
    t.deepEqual(term.cursor, { row: 0, col: 1 });
  });

  it('BS steps back and stops at column zero', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('ab\bX');
    t.equal(term.text()[0], 'aX');
    term.write('\r\b\bY');
    t.equal(term.text()[0], 'YX');
  });

  it('TAB advances to 8-column stops and clamps at the edge', (t) => {
    const term = new Terminal({ cols: 20, rows: 2 });
    term.write('a\tb\tc');
    t.equal(term.text()[0], 'a       b       c');
    const small = new Terminal({ cols: 10, rows: 2 });
    small.write('x\t\t');
    t.deepEqual(small.cursor, { row: 0, col: 9 });
  });
});

describe('vt cursor addressing', () => {
  it('CUP and HVP place the cursor 1-based', (t) => {
    const term = new Terminal({ cols: 10, rows: 4 });
    term.write('\x1b[3;5Hx');
    t.equal(term.text()[2], '    x');
    term.write('\x1b[2;3fy');
    t.equal(term.text()[1], '  y');
    term.write('\x1b[H');
    t.deepEqual(term.cursor, { row: 0, col: 0 });
  });

  it('CUP clamps to the grid', (t) => {
    const term = new Terminal({ cols: 10, rows: 4 });
    term.write('\x1b[99;99H');
    t.deepEqual(term.cursor, { row: 3, col: 9 });
  });

  it('CUU/CUD/CUF/CUB move relatively and clamp', (t) => {
    const term = new Terminal({ cols: 10, rows: 5 });
    term.write('\x1b[2;2H\x1b[2B\x1b[3C\x1b[1A\x1b[2D');
    t.deepEqual(term.cursor, { row: 2, col: 2 });
    term.write('\x1b[99A\x1b[99D');
    t.deepEqual(term.cursor, { row: 0, col: 0 });
  });

  it('CHA and VPA address one axis', (t) => {
    const term = new Terminal({ cols: 10, rows: 5 });
    term.write('\x1b[7G');
    t.deepEqual(term.cursor, { row: 0, col: 6 });
    term.write('\x1b[3d');
    t.deepEqual(term.cursor, { row: 2, col: 6 });
  });

  it('save/restore round-trips the cursor', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('ab\x1b[scd\x1b[uZ');
    t.equal(term.text()[0], 'abZd');
  });
});

describe('vt erase', () => {
  it('EL variants erase within the line', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('abcdef\x1b[1;3H\x1b[K');
    t.equal(term.text()[0], 'ab');
    term.write('\x1b[1;1Habcdef\x1b[1;3H\x1b[1K');
    t.equal(term.text()[0], '   def');
    term.write('\x1b[1;1Habcdef\x1b[1;3H\x1b[2K');
    t.equal(term.text()[0], '');
  });

  it('ED 0 erases from the cursor to end of screen', (t) => {
    const term = new Terminal({ cols: 6, rows: 4 });
    term.write('aaaaaa\r\nbbbbbb\r\ncccccc\r\ndddddd');
    term.write('\x1b[2;3H\x1b[J');
    t.deepEqual(term.text(), ['aaaaaa', 'bb', '', '']);
  });

  it('ED 1 erases from start of screen through the cursor', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('aaaaaa\r\nbbbbbb\r\ncccccc');
    term.write('\x1b[2;3H\x1b[1J');
    t.deepEqual(term.text(), ['', '   bbb', 'cccccc']);
  });

  it('ED 2 clears the screen, ED 3 clears scrollback', (t) => {
    const term = new Terminal({ cols: 6, rows: 2 });
    term.write('one\r\ntwo\r\nthree');
    t.deepEqual(term.scrollback(), ['one']);
    term.write('\x1b[2J');
    t.deepEqual(term.text(), ['', '']);
    t.deepEqual(term.scrollback(), ['one']);
    term.write('\x1b[3J');
    t.deepEqual(term.scrollback(), []);
  });
});

describe('vt scrolling', () => {
  it('LF at the bottom scrolls the top row into scrollback', (t) => {
    const term = new Terminal({ cols: 10, rows: 3 });
    term.write('one\r\ntwo\r\nthree\r\nfour');
    t.deepEqual(term.text(), ['two', 'three', 'four']);
    t.deepEqual(term.scrollback(), ['one']);
  });

  it('a region starting at row 1 feeds scrollback', (t) => {
    const term = new Terminal({ cols: 10, rows: 4 });
    term.write('\x1b[1;2r');
    term.write('one\r\ntwo\r\nthree\r\n');
    t.deepEqual(term.scrollback(), ['one', 'two']);
    t.equal(term.text()[0], 'three');
  });

  it('an inner region scrolls without touching rows outside it', (t) => {
    const term = new Terminal({ cols: 10, rows: 4 });
    term.write('\x1b[1;1HAAA\x1b[2;1HBBB\x1b[3;1HCCC\x1b[4;1HDDD');
    term.write('\x1b[2;3r\x1b[3;1H\n');
    t.deepEqual(term.text(), ['AAA', 'CCC', '', 'DDD']);
    t.deepEqual(term.scrollback(), []);
  });

  it('DECSTBM set and reset home the cursor', (t) => {
    const term = new Terminal({ cols: 10, rows: 4 });
    term.write('\x1b[3;4H\x1b[1;3r');
    t.deepEqual(term.cursor, { row: 0, col: 0 });
    term.write('\x1b[2;2H\x1b[r');
    t.deepEqual(term.cursor, { row: 0, col: 0 });
  });

  it('wrap at the bottom margin scrolls the region', (t) => {
    const term = new Terminal({ cols: 4, rows: 4 });
    term.write('\x1b[1;3r\x1b[3;1Hwxyz');
    term.write('q');
    t.deepEqual(term.scrollback(), ['']);
    t.equal(term.text()[1], 'wxyz');
    t.equal(term.text()[2], 'q');
  });
});

describe('vt alternate screen', () => {
  it('enter/leave preserves the primary grid and cursor', (t) => {
    const term = new Terminal({ cols: 8, rows: 3 });
    term.write('main\r\nline2\x1b[2;3H');
    term.write('\x1b[?1049h');
    t.ok(term.altScreen);
    t.ok(term.modes.has(1049));
    t.deepEqual(term.text(), ['', '', '']);
    t.deepEqual(term.cursor, { row: 0, col: 0 });
    term.write('alt\x1b[3;1H\n');
    t.deepEqual(term.scrollback(), []);
    term.write('\x1b[?1049l');
    t.ok(!term.altScreen);
    t.ok(!term.modes.has(1049));
    t.deepEqual(term.text(), ['main', 'line2', '']);
    t.deepEqual(term.cursor, { row: 1, col: 2 });
    term.write('\x1b[3;1H\n');
    t.deepEqual(term.scrollback(), ['main']);
  });
});

describe('vt pending wrap', () => {
  it('filling a row parks the cursor in the last column', (t) => {
    const term = new Terminal({ cols: 5, rows: 3 });
    term.write('abcde');
    t.deepEqual(term.cursor, { row: 0, col: 4 });
    term.write('f');
    t.deepEqual(term.text(), ['abcde', 'f', '']);
  });

  it('CR clears the pending wrap', (t) => {
    const term = new Terminal({ cols: 5, rows: 2 });
    term.write('abcde\rx');
    t.deepEqual(term.text(), ['xbcde', '']);
  });

  it('LF clears the pending wrap and keeps the column', (t) => {
    const term = new Terminal({ cols: 5, rows: 2 });
    term.write('abcde\ny');
    t.deepEqual(term.text(), ['abcde', '    y']);
  });

  it('cursor addressing clears the pending wrap', (t) => {
    const term = new Terminal({ cols: 5, rows: 2 });
    term.write('abcde\x1b[1;1Hz');
    t.equal(term.text()[0], 'zbcde');
  });

  it('autowrap off overprints the last column', (t) => {
    const term = new Terminal({ cols: 5, rows: 2 });
    term.write('\x1b[?7labcdef');
    t.deepEqual(term.text(), ['abcdf', '']);
  });
});

describe('vt SGR', () => {
  it('colored runs become styled spans', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[33mBUSY\x1b[0m ok');
    const spans = term.spans(0);
    t.equal(spans.length, 2);
    t.equal(spans[0]!.text, 'BUSY');
    t.ok(spans[0]!.sgr.includes(33));
    t.equal(spans[1]!.text, ' ok   ');
    t.deepEqual([...spans[1]!.sgr], []);
  });

  it('inverse span matches the reference shape', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[7mhot\x1b[0m cold');
    const spans = term.spans(0);
    t.deepEqual([...spans[0]!.sgr], [7]);
    t.equal(spans[0]!.text, 'hot');
    t.equal(spans[1]!.text, ' cold  ');
  });

  it('256-color and truecolor params are kept intact', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[38;5;196mX');
    t.deepEqual([...term.cellAt(0, 0).sgr], [38, 5, 196]);
    term.write('\x1b[0m\x1b[48;2;10;20;30mY');
    t.deepEqual([...term.cellAt(0, 1).sgr], [48, 2, 10, 20, 30]);
    term.write('\x1b[38;2;1;2;3mZ');
    t.deepEqual([...term.cellAt(0, 2).sgr], [38, 2, 1, 2, 3, 48, 2, 10, 20, 30]);
  });

  it('attributes accumulate and their offs cancel them', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[1;4;33mA');
    t.deepEqual([...term.cellAt(0, 0).sgr], [1, 4, 33]);
    term.write('\x1b[24mB');
    t.deepEqual([...term.cellAt(0, 1).sgr], [1, 33]);
    term.write('\x1b[22;39mC');
    t.deepEqual([...term.cellAt(0, 2).sgr], []);
  });

  it('background colors and defaults', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[41mA\x1b[103mB\x1b[49mC\x1b[mD');
    t.deepEqual([...term.cellAt(0, 0).sgr], [41]);
    t.deepEqual([...term.cellAt(0, 1).sgr], [103]);
    t.deepEqual([...term.cellAt(0, 2).sgr], []);
    t.deepEqual([...term.cellAt(0, 3).sgr], []);
  });
});

describe('vt modes', () => {
  it('defaults to autowrap on and cursor visible', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    t.ok(term.cursorVisible);
    t.ok(term.modes.has(7));
    t.ok(term.modes.has(25));
  });

  it('tracks private modes through h and l', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[?25l\x1b[?1000h\x1b[?1002;1006h\x1b[?2004h');
    t.ok(!term.cursorVisible);
    t.ok(term.modes.has(1000));
    t.ok(term.modes.has(1002));
    t.ok(term.modes.has(1006));
    t.ok(term.modes.has(2004));
    term.write('\x1b[?1049h');
    t.ok(term.modes.has(1006));
    t.ok(!term.cursorVisible);
    term.write('\x1b[?1049l\x1b[?25h\x1b[?1000l');
    t.ok(term.cursorVisible);
    t.ok(!term.modes.has(1000));
    t.ok(!term.modes.has(1049));
    term.write('\x1b[?7l');
    t.ok(!term.modes.has(7));
  });

  it('cursorVisible assignment toggles mode 25', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.cursorVisible = false;
    t.ok(!term.modes.has(25));
    term.cursorVisible = true;
    t.ok(term.modes.has(25));
  });
});

describe('vt OSC', () => {
  it('captures OSC 52 payloads with BEL and ST terminators', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b]52;c;aGVsbG8=\x07after');
    t.deepEqual(term.osc52, ['aGVsbG8=']);
    t.equal(term.text()[0], 'after');
    term.write('\x1b]52;p;Zm9v\x1b\\');
    t.deepEqual(term.osc52, ['aGVsbG8=', 'Zm9v']);
  });

  it('tracks the window title from OSC 0 and 2', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    t.equal(term.title, '');
    term.write('\x1b]0;My Title\x07');
    t.equal(term.title, 'My Title');
    term.write('\x1b]2;Second\x1b\\');
    t.equal(term.title, 'Second');
  });

  it('ignores unknown OSC without painting it', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b]133;A\x07ok\x1b[1;1H\x1b[K');
    t.equal(term.text()[0], '');
  });
});

describe('vt resize', () => {
  it('crops when the cursor survives the shrink', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('abcdef\r\nghijkl\r\nmnopqr\x1b[1;5H');
    term.resize(4, 2);
    t.deepEqual(term.text(), ['abcd', 'ghij']);
  });

  it('bottom anchor always scrolls by the height delta', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('abcdef\r\nghijkl\r\nmnopqr\x1b[1;5H');
    term.resize(4, 2, 'bottom');
    t.deepEqual(term.text(), ['ghij', 'mnop']);
  });

  it('scrolls shed rows into scrollback to keep the cursor', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('abcdef\r\nghijkl\r\nmnopqr\x1b[3;5H');
    term.resize(4, 2);
    t.deepEqual(term.text(), ['ghij', 'mnop']);
    t.deepEqual(term.scrollback(), ['abcdef']);
    t.deepEqual(term.cursor, { row: 1, col: 3 });
  });

  it('growing pads and the grid stays usable', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('abcdef\r\nghijkl\r\nmnopqr\x1b[3;5H');
    term.resize(4, 2);
    term.resize(6, 4);
    t.deepEqual(term.text(), ['ghij', 'mnop', '', '']);
    term.write('\x1b[4;1HZZ');
    t.equal(term.text()[3], 'ZZ');
  });

  it('resizing in alt mode fits the saved primary grid', (t) => {
    const term = new Terminal({ cols: 6, rows: 3 });
    term.write('primer\x1b[?1049h');
    term.resize(4, 2);
    term.write('\x1b[?1049l');
    t.deepEqual(term.text(), ['prim', '']);
  });
});

describe('vt input chunking', () => {
  it('buffers a split CSI across writes', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[1;');
    term.write('3Hx');
    t.equal(term.text()[0], '  x');
  });

  it('buffers a bare trailing ESC', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('ab\x1b');
    term.write('[1;1Hz');
    t.equal(term.text()[0], 'zb');
  });

  it('buffers a split OSC and SGR', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b]0;par');
    term.write('tial\x07x');
    t.equal(term.title, 'partial');
    t.equal(term.text()[0], 'x');
    term.write('\x1b[3');
    term.write('3mQ');
    t.ok(term.cellAt(0, 1).sgr.includes(33));
  });

  it('decodes Uint8Array input, including split UTF-8', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    const enc = new TextEncoder();
    term.write(enc.encode('hi \x1b[33m!'));
    t.equal(term.text()[0], 'hi !');
    t.ok(term.cellAt(0, 3).sgr.includes(33));
    const two = new Terminal({ cols: 10, rows: 2 });
    two.write(new Uint8Array([0xc3]));
    two.write(new Uint8Array([0xa9]));
    t.equal(two.cellAt(0, 0).char, 'é');
  });
});

describe('vt cell access', () => {
  it('cellAt returns char and style', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    term.write('\x1b[31mR');
    t.equal(term.cellAt(0, 0).char, 'R');
    t.deepEqual([...term.cellAt(0, 0).sgr], [31]);
    t.equal(term.cellAt(1, 5).char, ' ');
  });

  it('cellAt and spans reject out-of-range coordinates', (t) => {
    const term = new Terminal({ cols: 10, rows: 2 });
    t.throws(() => term.cellAt(5, 0), /range/);
    t.throws(() => term.cellAt(0, 99), /range/);
    t.throws(() => term.spans(9), /range/);
  });
});
