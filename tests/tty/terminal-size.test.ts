import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
describe('terminal size', () => {
  it('reflects the real pty geometry', async (t) => {
    const dir = `/tmp/szp2-${Date.now().toString(36)}`;
    const fs = new DiskFileSystem();
    await fs.mkdir(dir);
    const script = `${dir}/p.ts`;
    await fs.writeFile(
      script,
      new TextEncoder().encode(
        `import { getTerminalSize } from 'fino:tty/tui';\nconst s = getTerminalSize();\nconsole.log('SIZE ' + s.width + 'x' + s.height);\n`,
      ),
    );
    for (const [cols, rows] of [
      [70, 26],
      [100, 30],
    ] as const) {
      const pty = await openPty(execPath, [script], { cols, rows });
      try {
        await pty.waitFor((term) => term.text().some((l) => l.includes('SIZE')));
        const line = pty.term
          .text()
          .find((l) => l.includes('SIZE'))!
          .trim();
        t.equal(line, `SIZE ${cols}x${rows}`, `app sees the real ${cols}x${rows} geometry`);
      } finally {
        await pty.close();
      }
    }
  });
});
