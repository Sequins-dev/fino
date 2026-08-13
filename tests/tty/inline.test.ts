import { describe, it } from 'fino:test/test';
import { composeInlineFrame, type InlineComposeState } from 'fino:tty/tui';

function state(overrides: Partial<InlineComposeState> = {}): InlineComposeState {
  return {
    width: 10,
    height: 10,
    footerRows: 2,
    historyBottom: 0,
    lastLines: [],
    cursor: null,
    ...overrides,
  };
}

describe('fino:tty/tui composeInlineFrame', () => {
  it('writes first history onto an empty screen without scrolling', (t) => {
    const { out, state: next } = composeInlineFrame(state(), { history: ['alpha', 'beta'] });
    t.ok(out.startsWith('\x1B[?25l'), 'hides the cursor during mutation');
    t.ok(out.includes('\x1B[1;8r'), 'region confined above the footer');
    t.ok(out.includes('\x1B[1;1Halpha\x1B[K'), 'first line lands on row 1 directly');
    t.ok(out.includes('\r\nbeta\x1B[K'), 'subsequent lines pushed with CR LF');
    t.ok(out.includes('\x1B[r'), 'region released');
    t.equal(next.historyBottom, 2, 'history bottom advanced');
    t.ok(!out.includes('\x1b7') && !out.includes('\x1B[s'), 'no cursor save/restore anywhere');
  });

  it('fills vacated rows before evicting into scrollback', (t) => {
    const start = state({ historyBottom: 4 });
    const { out, state: next } = composeInlineFrame(start, { history: ['one', 'two'] });
    t.ok(out.includes('\x1B[4;1H\r\none\x1B[K\r\ntwo\x1B[K'), 'parks at historyBottom, not the region bottom');
    t.equal(next.historyBottom, 6, 'vacated rows consumed');
  });

  it('caps historyBottom at the region bottom once full', (t) => {
    const start = state({ historyBottom: 8 });
    const { state: next } = composeInlineFrame(start, { history: ['a', 'b', 'c'] });
    t.equal(next.historyBottom, 8, 'stays at region bottom while scrolling');
  });

  it('grows the footer by evicting only what vacancy cannot absorb', (t) => {
    const full = state({ historyBottom: 8, lastLines: ['x', 'y'] });
    const grown = composeInlineFrame(full, { frame: { lines: ['a', 'b', 'c', 'd'] } });
    t.ok(grown.out.includes('\x1B[1;8r\x1B[8;1H\n\n\x1B[r'), 'two newlines evict two rows');
    t.equal(grown.state.footerRows, 4, 'footer grew');
    t.equal(grown.state.historyBottom, 6, 'history moved up by the eviction');

    const roomy = state({ historyBottom: 5, lastLines: ['x', 'y'] });
    const absorbed = composeInlineFrame(roomy, { frame: { lines: ['a', 'b', 'c', 'd'] } });
    t.ok(!absorbed.out.includes('\x1B[1;8r'), 'no eviction when vacancy covers the growth');
    t.equal(absorbed.state.historyBottom, 5, 'history untouched');
    t.equal(absorbed.state.footerRows, 4, 'footer grew in place');
  });

  it('clears the rows a shrinking footer leaves behind', (t) => {
    const start = state({
      footerRows: 4,
      historyBottom: 6,
      lastLines: ['a', 'b', 'c', 'd'],
    });
    const { out, state: next } = composeInlineFrame(start, { frame: { lines: ['a', 'b'] } });
    // The footer hugs history at row 7, so shrinking frees its last two rows.
    t.ok(out.includes('\x1B[9;1H\x1B[2K'), 'first freed row cleared');
    t.ok(out.includes('\x1B[10;1H\x1B[2K'), 'second freed row cleared');
    t.equal(next.footerRows, 2, 'footer shrank');
    t.equal(next.historyBottom, 6, 'history untouched by shrink');
  });

  it('keeps the footer against the history with no blank row between', (t) => {
    // A footer pinned to the bottom of a half-empty screen would leave the
    // rows between the transcript and itself blank; it follows the content
    // instead, and only stops once history reaches the pinned position.
    for (const historyBottom of [0, 1, 4, 7]) {
      const { out } = composeInlineFrame(state({ historyBottom }), {
        frame: { lines: ['input', 'status'] },
      });
      const rows = [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
      const firstFooterRow = Math.min(...rows.filter((r) => r > historyBottom));
      t.equal(firstFooterRow, historyBottom + 1, `footer hugs history at ${historyBottom}`);
    }
    const full = composeInlineFrame(state({ historyBottom: 8 }), {
      frame: { lines: ['input', 'status'] },
    });
    const rows = [...full.out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]));
    t.equal(Math.min(...rows.filter((r) => r > 8)), 9, 'pins at the bottom once history fills');
  });

  it('repaints only changed footer rows when geometry is stable', (t) => {
    const base = state({ historyBottom: 8 });
    const first = composeInlineFrame(base, { frame: { lines: ['input', 'status'] } });
    const second = composeInlineFrame(first.state, { frame: { lines: ['input!', 'status'] } });
    t.ok(second.out.includes('\x1B[9;1H'), 'changed row repainted');
    t.ok(!second.out.includes('\x1B[10;1H'), 'unchanged row skipped');
    const idle = composeInlineFrame(second.state, { frame: { lines: ['input!', 'status'] } });
    t.equal(idle.out, '', 'identical frame produces no output at all');
  });

  it('parks and shows the cursor at the frame cell, absolutely', (t) => {
    const base = state({ historyBottom: 8 });
    const { out, state: next } = composeInlineFrame(base, {
      frame: { lines: ['prompt', 'bar'], cursor: { row: 0, column: 3 } },
    });
    t.ok(out.endsWith('\x1B[9;4H\x1B[?25h'), 'absolute park then show');
    t.deepEqual(next.cursor, { row: 0, column: 3 }, 'cursor recorded');
    const moved = composeInlineFrame(next, {
      frame: { lines: ['prompt', 'bar'], cursor: { row: 0, column: 4 } },
    });
    t.ok(moved.out.endsWith('\x1B[9;5H\x1B[?25h'), 'cursor-only change still parks');
    const hidden = composeInlineFrame(moved.state, {
      frame: { lines: ['prompt', 'bar'], cursor: null },
    });
    t.ok(hidden.out.includes('\x1B[?25l'), 'hiding emits the hide');
    t.ok(!hidden.out.includes('\x1B[?25h'), 'no show when cursor is null');
  });

  it('pairs every scroll-region set with a reset in the same write', (t) => {
    const runs = [
      composeInlineFrame(state(), { history: ['a', 'b', 'c'] }).out,
      composeInlineFrame(state({ historyBottom: 8, lastLines: ['x', 'y'] }), {
        frame: { lines: ['a', 'b', 'c', 'd'] },
      }).out,
    ];
    for (const out of runs) {
      const sets = out.match(/\x1b\[\d+;\d+r/g)?.length ?? 0;
      const resets = out.match(/\x1b\[r/g)?.length ?? 0;
      t.equal(resets, sets, 'set and reset counts match');
    }
  });
});

describe('internal:tty/bindings inline sequences', () => {
  it('builds the exact DECSTBM, cursor, and erase sequences', async (t) => {
    const {
      setScrollRegion,
      resetScrollRegion,
      cursorTo,
      eraseToLineEnd,
      eraseLine,
      eraseBelow,
      queryCursorPosition,
    } = await import('internal:tty/bindings');
    t.equal(setScrollRegion(1, 20), '\x1B[1;20r', 'DECSTBM set');
    t.equal(resetScrollRegion(), '\x1B[r', 'DECSTBM reset');
    t.equal(cursorTo(5, 3), '\x1B[5;3H', 'CUP with column');
    t.equal(cursorTo(7), '\x1B[7;1H', 'CUP defaults to column 1');
    t.equal(eraseToLineEnd(), '\x1B[K', 'EL 0');
    t.equal(eraseLine(), '\x1B[2K', 'EL 2');
    t.equal(eraseBelow(), '\x1B[0J', 'ED 0');
    t.equal(queryCursorPosition(), '\x1B[6n', 'DSR 6');
  });
});

describe('fino:tty/tui text utilities', () => {
  it('measures visible width ignoring escapes', async (t) => {
    const { visibleWidth } = await import('fino:tty/tui');
    t.equal(visibleWidth('plain'), 5, 'plain text');
    t.equal(visibleWidth('\x1b[1m\x1b[36mbold cyan\x1b[0m'), 9, 'styled text');
    t.equal(visibleWidth('\x1b[5;1H\x1b[K'), 0, 'cursor and erase sequences are invisible');
    t.equal(visibleWidth(''), 0, 'empty');
  });

  it('strips escapes leaving visible characters', async (t) => {
    const { stripAnsi } = await import('fino:tty/tui');
    t.equal(stripAnsi('\x1b[36mcyan\x1b[0m tail'), 'cyan tail', 'SGR removed');
    t.equal(stripAnsi('\x1b[2Kcleared'), 'cleared', 'erase removed');
    t.equal(stripAnsi('no escapes'), 'no escapes', 'plain passthrough');
  });

  it('fitAnsi clips to visible width and closes with a reset', async (t) => {
    const { fitAnsi, visibleWidth } = await import('fino:tty/tui');
    const clipped = fitAnsi('\x1b[32mhello world\x1b[0m', 5);
    t.equal(visibleWidth(clipped), 5, 'clipped to width');
    t.ok(clipped.includes('\x1b[32mhello'), 'style and prefix preserved');
    t.ok(clipped.includes('\x1b[0m'), 'reset emitted after truncation');
    const padded = fitAnsi('\x1b[31mhi\x1b[0m', 6);
    t.equal(visibleWidth(padded), 6, 'padded to width');
    t.ok(padded.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') === 'hi    ', 'space padding');
    t.equal(fitAnsi('plain text here', 5), 'plain', 'unstyled text clips plainly');
  });
});
