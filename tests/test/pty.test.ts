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

// Child bootstrap competes with other full-suite processes on two-CPU CI.
// Give first output/exit 30 seconds; subsequent interactions keep short deadlines.
describe('fino:test/pty', () => {
  it('retains output when the child exits before the reader runs', async (t) => {
    await withScript(
      `import { writeStdout } from 'fino:tty'; await writeStdout('final output');`,
      async (pty) => {
        // Deliberately delay the pump while the child writes and exits.
        // An async timer would let the pump consume the output immediately.
        const until = performance.now() + 1000;
        while (performance.now() < until) {}
        t.equal(await pty.waitExit({ timeout: 30_000 }), 0);
        await pty.close();
        t.ok(screenIncludes(pty.term, 'final output'), 'close drains the final output');
      },
    );
  });

  it('captures plain output and reports a clean exit', async (t) => {
    await withScript(`console.log('hello pty');\n`, async (pty) => {
      t.ok(pty.pid > 0, 'child pid is reported');
      await pty.waitFor((term) => screenIncludes(term, 'hello pty'), { timeout: 30_000 });
      const code = await pty.waitExit();
      t.equal(code, 0, 'child exits with code 0');
      t.ok(screenIncludes(pty.term, 'hello pty'), 'screen retains the output');
    });
  });

  it('reports child exit and output progress when a screen wait times out', async (t) => {
    await withScript(
      `console.log('ready');\nimport { exit } from 'fino:process';\nexit(13);\n`,
      async (pty) => {
        await pty.waitFor((term) => screenIncludes(term, 'ready'), { timeout: 30_000 });
        t.equal(await pty.waitExit(), 13);
        await t.rejects(
          () => pty.waitFor(() => false, { timeout: 1 }),
          new RegExp(`child ${pty.pid}: exited with code 13; output bytes: [1-9]`),
          'timeout distinguishes an exited child from a running child with no output',
        );
      },
    );
  });

  it('closes an active session idempotently while I/O is pending', async (t) => {
    const dir = '/tmp/fino-pty-close-' + Math.floor(Math.random() * 1e9);
    await fs.mkdir(dir);
    const script = dir + '/app.ts';
    await fs.writeFile(script, encoder.encode(`await new Promise(() => {});\n`));
    const pty = await openPty(execPath, [script]);
    try {
      await t.rejects(
        () => pty.waitFor(() => false, { timeout: 1 }),
        new RegExp(`child ${pty.pid}: running; output bytes: 0; read state: pending`),
        'timeout reports a running child whose output read is still pending',
      );
      const first = pty.close();
      const second = pty.close();
      t.equal(first, second, 'concurrent close calls share one teardown promise');
      await first;
      await pty.close();
      t.ok(true, 'close remains safe after teardown completes');
    } finally {
      await fs.unlink(script);
      await fs.rmdir(dir);
    }
  });

  it('releases setup resources after a failed spawn', async (t) => {
    await t.rejects(
      () => openPty('/definitely/not/a/fino-command'),
      /posix_spawnp/,
      'invalid command rejects at the spawn boundary',
    );
    await withScript(`console.log('recovered');\n`, async (pty) => {
      await pty.waitFor((term) => screenIncludes(term, 'recovered'), { timeout: 30_000 });
      t.equal(await pty.waitExit(), 0, 'a later PTY session still works');
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
  async onEvent(event, app) {
    if (event.type !== 'key') return;
    if (event.ctrl && event.key === 'c') {
      app.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));
      exit(0);
      return;
    }
    count.set(count.get() + 1);
  },
});
`;
    await withScript(source, async (pty) => {
      await pty.waitFor((term) => term.altScreen && screenIncludes(term, 'count: 0'), {
        timeout: 30_000,
      });
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
      await pty.waitFor((term) => screenIncludes(term, 'resize harness running'), {
        timeout: 30_000,
      });
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

  it('routes SGR mouse clicks through the TUI input reader', async (t) => {
    const source = `
import { render, Text } from 'fino:tty/tui';
import { createSignal } from 'fino:ui';
import { exit } from 'fino:process';

const clicks = createSignal(0);
render(
  () => Text({ children: 'clicks: ' + clicks.get() }),
  {
    input: true,
    mouse: true,
    onEvent(event, app) {
      if (event.type === 'mouse' && event.action === 'press') {
        clicks.set(clicks.get() + 1);
      }
      if (event.type === 'key' && event.ctrl && event.key === 'c') {
        app.stop();
        exit(0);
      }
    },
  },
);
`;
    await withScript(source, async (pty) => {
      await pty.waitFor((term) => term.altScreen && screenIncludes(term, 'clicks: 0'), {
        timeout: 30_000,
      });
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
