import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

describe('terminal size', () => {
  it('reflects the real pty geometry', async (t) => {
    const dir = `/tmp/fino-pty-size-${Date.now().toString(36)}`;
    const fs = new DiskFileSystem();
    await fs.mkdir(dir);
    const script = `${dir}/app.ts`;
    await fs.writeFile(
      script,
      new TextEncoder().encode(
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
});
