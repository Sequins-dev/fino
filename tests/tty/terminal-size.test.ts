import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const encoder = new TextEncoder();

describe('terminal size', () => {
  it('reflects the real pty geometry', async (t) => {
    const dir = `/tmp/fino-pty-size-${Date.now().toString(36)}`;
    const fs = new DiskFileSystem();
    await fs.mkdir(dir);
    const script = `${dir}/app.ts`;
    await fs.writeFile(
      script,
      encoder.encode(
        `import { getTerminalSize } from 'fino:tty/tui';\nconst size = getTerminalSize();\nconsole.log('SIZE ' + size.width + 'x' + size.height);\n`,
      ),
    );
    try {
      for (const [cols, rows] of [
        [70, 26],
        [100, 30],
      ] as const) {
        const pty = await openPty(execPath, [script], { cols, rows });
        try {
          await pty.waitFor((term) => term.text().some((line) => line.includes('SIZE')));
          const line = pty.term
            .text()
            .find((text) => text.includes('SIZE'))!
            .trim();
          t.equal(line, `SIZE ${cols}x${rows}`, `child sees the real ${cols}x${rows} geometry`);
        } finally {
          await pty.close();
        }
      }
    } finally {
      await fs.unlink(script);
      await fs.rmdir(dir);
    }
  });

  it('reflows a live TUI after the pty is resized', async (t) => {
    const dir = `/tmp/fino-pty-resize-${Date.now().toString(36)}`;
    const fs = new DiskFileSystem();
    await fs.mkdir(dir);
    const script = `${dir}/app.ts`;
    await fs.writeFile(
      script,
      encoder.encode(`
import { h } from 'fino:ui';
import { Box, Spacer, Text, render } from 'fino:tty/tui';
import type { TuiApp } from 'fino:tty/tui';
import { signalArmed } from 'fino:process';
const tree = (label: string) =>
  h(Box, { direction: 'row' }, h(Text, null, label), h(Spacer, { flex: 1 }), h(Text, null, 'R'));
let app: TuiApp;
app = render(tree('WAIT'), {
  input: true,
  mouse: false,
  async onEvent(event) {
    if (event.type !== 'key' || event.key !== 'r') return;
    await signalArmed('SIGWINCH');
    app.update(tree('READY'));
  },
});
`),
    );
    const pty = await openPty(execPath, [script], { cols: 20, rows: 4 });
    try {
      await pty.waitFor((term) => term.text()[0]?.startsWith('WAIT'));
      await pty.send('r');
      await pty.waitFor((term) => term.text()[0]?.startsWith('READY'));
      t.equal(pty.term.text()[0]?.lastIndexOf('R'), 19, 'initial frame uses the startup width');
      pty.resize(30, 6);
      await pty.waitFor((term) => term.text()[0]?.lastIndexOf('R') === 29);
      t.equal(pty.term.text()[0]?.lastIndexOf('R'), 29, 'SIGWINCH reflows the retained tree');
    } finally {
      await pty.close();
      await fs.unlink(script);
      await fs.rmdir(dir);
    }
  });
});
