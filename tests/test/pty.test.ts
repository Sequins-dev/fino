import { describe, it } from 'fino:test/test';
import { openPty, type PtyHandle } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();

async function withScript(
  source: string,
  run: (pty: PtyHandle) => Promise<void>,
  options?: { cols?: number; rows?: number },
): Promise<void> {
  const dir = '/tmp/fino-pty-test-' + Math.floor(Math.random() * 1e9);
  await fs.mkdir(dir);
  const script = dir + '/app.ts';
  await fs.writeFile(script, encoder.encode(source));
  const pty = await openPty(execPath, [script], options);
  try {
    await run(pty);
  } finally {
    await pty.close();
    try {
      await fs.unlink(script);
      await fs.rmdir(dir);
    } catch {}
  }
}

function screenIncludes(term: { text(): string[] }, needle: string): boolean {
  return term.text().some((line) => line.includes(needle));
}

describe('fino:test/pty', () => {
  it('captures plain output and reports a clean exit', async (t) => {
    await withScript(`console.log('hello pty');\n`, async (pty) => {
      t.ok(pty.pid > 0, 'child pid is reported');
      await pty.waitFor((term) => screenIncludes(term, 'hello pty'));
      const code = await pty.waitExit();
      t.equal(code, 0, 'child exits with code 0');
      t.ok(screenIncludes(pty.term, 'hello pty'), 'screen retains the output');
    });
  });

  it('drives a live TUI: alt screen, keyboard input, and teardown', async (t) => {
    const source = `
import { render, Text } from 'fino:tty/tui';
import { createSignal } from 'fino:ui';
import { exit } from 'fino:process';

const count = createSignal(0);
render(() => Text({ children: 'count: ' + count.get() }), {
  input: true,
  mouse: false,
  onEvent(event, app) {
    if (event.type !== 'key') return;
    if (event.ctrl && event.key === 'c') {
      app.stop();
      exit(0);
      return;
    }
    count.set(count.get() + 1);
  },
});
`;
    await withScript(source, async (pty) => {
      await pty.waitFor((term) => term.altScreen && screenIncludes(term, 'count: 0'));
      t.ok(pty.term.modes.has(1049), 'alt-screen mode 1049 is tracked');
      t.ok(!pty.term.modes.has(25), 'cursor is hidden while the app runs');
      await pty.sendKey('a');
      await pty.waitFor((term) => screenIncludes(term, 'count: 1'));
      await pty.sendKey('ctrl+c');
      const code = await pty.waitExit();
      t.equal(code, 0, 'app exits cleanly on ctrl+c');
      await pty.waitFor((term) => !term.altScreen && term.modes.has(25));
      t.ok(!pty.term.altScreen, 'alt screen is left after exit');
      t.ok(pty.term.modes.has(25), 'cursor visibility is restored after exit');
    });
  });

  it('resizes the pty while the app keeps running', async (t) => {
    const source = `
import { render, Text } from 'fino:tty/tui';

render(() => Text({ children: 'resize harness running' }), {
  input: true,
  mouse: false,
  onEvent() {},
});
`;
    await withScript(source, async (pty) => {
      t.equal(pty.term.cols, 80, 'emulator starts at the requested width');
      t.equal(pty.term.rows, 24, 'emulator starts at the requested height');
      await pty.waitFor((term) => screenIncludes(term, 'resize harness running'));
      pty.resize(100, 30);
      t.equal(pty.term.cols, 100, 'emulator grid tracks the new width');
      t.equal(pty.term.rows, 30, 'emulator grid tracks the new height');
      await t.rejects(
        () => pty.waitExit({ timeout: 250 }),
        /timed out/,
        'app is still running after the resize',
      );
      t.ok(screenIncludes(pty.term, 'resize harness running'), 'content survives the resize');
    });
  });

  it('routes SGR mouse clicks to a Clickable', async (t) => {
    const source = `
import { render, Text, Clickable } from 'fino:tty/tui';
import { createSignal } from 'fino:ui';
import { exit } from 'fino:process';

const clicks = createSignal(0);
render(
  () =>
    Clickable({
      onClick() {
        clicks.set(clicks.get() + 1);
      },
      children: Text({ children: 'clicks: ' + clicks.get() }),
    }),
  {
    input: true,
    mouse: true,
    onEvent(event, app) {
      if (event.type === 'key' && event.ctrl && event.key === 'c') {
        app.stop();
        exit(0);
      }
    },
  },
);
`;
    await withScript(source, async (pty) => {
      await pty.waitFor((term) => term.altScreen && screenIncludes(term, 'clicks: 0'));
      t.ok(
        [1000, 1002, 1006].some((mode) => pty.term.modes.has(mode)),
        'mouse capture mode is enabled while the app runs',
      );
      await pty.sendMouse('press', 2, 0);
      await pty.sendMouse('release', 2, 0);
      await pty.waitFor((term) => screenIncludes(term, 'clicks: 1'));
      t.ok(screenIncludes(pty.term, 'clicks: 1'), 'click incremented the counter');
      await pty.sendKey('ctrl+c');
      const code = await pty.waitExit();
      t.equal(code, 0, 'app exits cleanly after mouse interaction');
    });
  });
});
