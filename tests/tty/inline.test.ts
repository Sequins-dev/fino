import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import { composeInline, footerTop, type InlineState } from 'fino:tty/inline';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();

const APP = `
import { renderInline } from 'fino:tty/inline';
import { Text } from 'fino:ui/components';
import { createSignal } from 'fino:ui';
const count = createSignal(0);
let pushed = 0;
let done;
const wait = new Promise((resolve) => { done = resolve; });
const app = renderInline(() => Text({ children: ['> typed:' + count.get()] }), {
  onEvent(event) {
    if (event.type !== 'key') return;
    if (event.key === 'q') { app.stop().then(done); return; }
    if (event.key === 'a') { app.printAbove(['line ' + pushed]); pushed += 1; return; }
    count.set(count.get() + 1);
  },
});
await wait;
`;

const GROW_APP = `
import { renderInline } from 'fino:tty/inline';
import { Text, VStack } from 'fino:ui/components';
import { createSignal } from 'fino:ui';
const lines = createSignal(1);
let done;
const wait = new Promise((resolve) => { done = resolve; });
const app = renderInline(
  () => VStack({ children: Array.from({ length: lines.get() }, (_, i) => Text({ children: ['row' + i] })) }),
  {
    onEvent(event) {
      if (event.type !== 'key') return;
      if (event.key === 'q') { app.stop().then(done); return; }
      if (event.key === 'g') { lines.set(lines.get() + 1); return; }
      if (event.key === 'v') { app.printAbove(Text({ children: ['from a tree'] })); return; }
    },
  },
);
await wait;
`;

async function growPty(name: string, rows = 8) {
  const dir = `/tmp/fino-inline-${name}`;
  await fs.mkdir(dir).catch(() => {});
  const script = `${dir}/grow.ts`;
  await fs.writeFile(script, encoder.encode(GROW_APP));
  return openPty(execPath, [script], { cols: 40, rows });
}

async function inlinePty(name: string, rows = 10) {
  const dir = `/tmp/fino-inline-${name}`;
  await fs.mkdir(dir).catch(() => {});
  const script = `${dir}/app.ts`;
  await fs.writeFile(script, encoder.encode(APP));
  return openPty(execPath, [script], { cols: 40, rows });
}

function screen(pty: { term: { text(): string[] } }): string[] {
  return pty.term.text().map((l) => l.replace(/\s+$/, ''));
}

const base = (over: Partial<InlineState> = {}): InlineState => ({
  width: 20,
  height: 6,
  footerRows: 1,
  historyBottom: 0,
  lastLines: [],
  cursor: null,
  ...over,
});

describe('fino:tty/inline placement', () => {
  it('keeps the footer against the transcript until it reaches the bottom', (t) => {
    t.equal(footerTop(24, 3, 0), 1, 'an empty transcript puts the footer at the top');
    t.equal(footerTop(24, 3, 10), 11, 'the footer follows the transcript down');
    t.equal(footerTop(24, 3, 30), 22, 'a full screen pins the footer to the bottom');
    t.equal(footerTop(24, 1, 23), 24, 'a one-row footer pins to the last row');
  });

  it('confines a history push to the rows above the footer', (t) => {
    const first = composeInline(base(), { lines: ['> '], cursor: { row: 0, column: 2 } });
    t.equal(first.state.footerRows, 1, 'a one-line footer occupies one row');
    const pushed = composeInline(first.state, { history: ['one', 'two'] });
    t.ok(pushed.out.includes('\x1B[1;5r'), 'scrolling is confined to the rows above the footer');
    t.ok(pushed.out.endsWith('\x1B[?25h'), 'the cursor is restored after the write');
    t.ok(!pushed.out.includes('\x1B[r\x1B['.repeat(2)), 'the region is reset once, not per line');
    t.equal(pushed.state.historyBottom, 2, 'two committed lines occupy two rows');
  });

  it('never leaves a scroll region set across writes', (t) => {
    const state = composeInline(base(), { lines: ['> '] }).state;
    const pushed = composeInline(state, { history: ['a', 'b', 'c'] });
    const lastSet = pushed.out.lastIndexOf('\x1B[1;5r');
    const lastReset = pushed.out.lastIndexOf('\x1B[r');
    t.ok(lastReset > lastSet, 'the write ends with the region reset');
  });

  it('stops the transcript growing under the footer', (t) => {
    // height 6, one-row footer: history may occupy rows 1..5 and no further.
    let state = composeInline(base(), { lines: ['> '] }).state;
    for (let i = 0; i < 12; i++) state = composeInline(state, { history: [`l${i}`] }).state;
    t.equal(state.historyBottom, 5, 'the transcript stops one row above the footer');
  });

  it('scrolls the transcript up when the footer grows into it', (t) => {
    let state = composeInline(base(), { lines: ['> '] }).state;
    for (let i = 0; i < 8; i++) state = composeInline(state, { history: [`l${i}`] }).state;
    t.equal(state.historyBottom, 5, 'the transcript filled up to the footer');
    const grown = composeInline(state, { lines: ['a', 'b', 'c'] });
    t.equal(grown.state.footerRows, 3, 'the footer took three rows');
    t.equal(grown.state.historyBottom, 3, 'the transcript scrolled up to make room');
    t.ok(grown.out.includes('\x1B[1;5r'), 'the scroll used the previous region');
  });

  it('repaints only the footer rows that changed', (t) => {
    const first = composeInline(base(), { lines: ['aaa', 'bbb'] });
    const same = composeInline(first.state, { lines: ['aaa', 'bbb'] });
    t.equal(same.out, '', 'an identical footer writes nothing');
    const changed = composeInline(first.state, { lines: ['aaa', 'ccc'] });
    t.ok(!changed.out.includes('aaa'), 'the unchanged row is not rewritten');
    t.ok(changed.out.includes('ccc'), 'the changed row is rewritten');
  });
});

describe('fino:tty/inline in a real terminal', () => {
  it('renders a footer, commits above it, and stays interactive', async (t) => {
    const pty = await inlinePty('basic');
    try {
      await pty.waitFor((term) => term.text().some((l) => l.includes('typed:0')));
      t.ok(true, 'the footer paints without taking the alternate screen');
      t.ok(!pty.term.altScreen, 'inline rendering stays in the primary buffer');

      await pty.sendKey('a');
      await pty.waitFor((term) => term.text().some((l) => l.includes('line 0')));
      const withHistory = screen(pty);
      t.equal(withHistory[0], 'line 0', 'the committed line is at the top');
      t.ok(withHistory[1]?.includes('typed:0'), 'the footer sits directly under the transcript');

      await pty.sendKey('x');
      await pty.waitFor((term) => term.text().some((l) => l.includes('typed:1')));
      t.ok(true, 'keys still reach the app after committing');
      t.ok(screen(pty)[0] === 'line 0', 'repainting the footer leaves the transcript untouched');

      await pty.sendKey('q');
      const code = await pty.waitExit();
      t.equal(code, 0, 'the app exits cleanly');
      // `waitExit` resolves when the child exits, not when the emulator has
      // applied its final bytes, so the teardown paint has to be awaited.
      await pty.waitFor((term) => !term.text().some((l) => l.includes('typed:')));
      t.ok(true, 'the footer is cleared on exit');
      t.ok(
        pty.term.text().some((l) => l.includes('line 0')),
        'the transcript survives after the footer is cleared',
      );
    } finally {
      await pty.close();
    }
  });

  it('evicts the oldest rows once the transcript fills the screen', async (t) => {
    const pty = await inlinePty('scroll', 6);
    try {
      await pty.waitFor((term) => term.text().some((l) => l.includes('typed:0')));
      for (let i = 0; i < 9; i++) {
        await pty.sendKey('a');
        await new Promise((r) => setTimeout(r, 30));
      }
      await pty
        .waitFor((term) => term.text().some((l) => l.includes('line 0')), {
          timeout: 3000,
        })
        .catch(() => {});
      const rows = screen(pty).filter((l) => l.startsWith('line '));
      t.ok(rows.length <= 5, 'the transcript never covers the footer row');
      t.equal(rows[rows.length - 1], 'line 8', 'the newest commit sits nearest the footer');
      t.ok(!rows.includes('line 0'), 'the oldest commits scrolled off the screen');
      t.deepEqual(
        rows,
        ['line 4', 'line 5', 'line 6', 'line 7', 'line 8'],
        'the visible transcript is the most recent window of commits',
      );
      await pty.sendKey('q');
      await pty.waitExit().catch(() => {});
    } finally {
      await pty.close();
    }
  });

  it('commits a component tree into the transcript', async (t) => {
    const pty = await growPty('tree');
    try {
      await pty.waitFor((term) => term.text().some((l) => l.includes('row0')));
      await pty.sendKey('v');
      await pty.waitFor((term) => term.text().some((l) => l.includes('from a tree')));
      const rows = screen(pty);
      t.equal(rows[0], 'from a tree', 'the tree was laid out and committed as a line');
      t.ok(rows[1]?.includes('row0'), 'the footer still sits under the transcript');
      await pty.sendKey('q');
      await pty.waitExit().catch(() => {});
    } finally {
      await pty.close();
    }
  });

  it('grows the footer without disturbing the transcript', async (t) => {
    const pty = await growPty('grow');
    try {
      await pty.waitFor((term) => term.text().some((l) => l.includes('row0')));
      await pty.sendKey('v');
      await pty.waitFor((term) => term.text().some((l) => l.includes('from a tree')));
      for (const _ of [0, 1, 2]) {
        await pty.sendKey('g');
        await new Promise((r) => setTimeout(r, 60));
      }
      await pty.waitFor((term) => term.text().some((l) => l.includes('row3')));
      const rows = screen(pty);
      t.equal(rows[0], 'from a tree', 'the committed line stayed put as the footer grew');
      t.deepEqual(
        rows.slice(1, 5),
        ['row0', 'row1', 'row2', 'row3'],
        'the footer occupies one row per line, directly under the transcript',
      );
      await pty.sendKey('q');
      const code = await pty.waitExit();
      t.equal(code, 0, 'a multi-row footer still exits cleanly');
      await pty.waitFor((term) => !term.text().some((l) => l.includes('row0')));
      t.ok(true, 'every footer row is cleared');
      t.ok(
        pty.term.text().some((l) => l.includes('from a tree')),
        'the transcript survives after the footer is cleared',
      );
    } finally {
      await pty.close();
    }
  });
});
