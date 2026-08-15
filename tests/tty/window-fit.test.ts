import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
describe('gallery fills its window', () => {
  it('closes borders and fits at several widths', async (t) => {
    for (const cols of [70, 90] as const) {
      const pty = await openPty(execPath, ['gallery'], { cols, rows: 26 });
      try {
        await pty.waitFor((term) => term.text().some((l) => l.includes('Stories')));
        for (let i = 0; i < 90; i++) {
          if (pty.term.text().some((l) => l.includes('─ LineChart'))) break;
          await pty.sendMouse('wheel-down', 6, 4);
          await new Promise((r) => setTimeout(r, 35));
        }
        const rows = pty.term.text();
        const top = (rows[0] ?? '').trimEnd();
        const max = Math.max(...rows.map((l) => l.replace(/\s+$/, '').length));
        t.ok(top.endsWith('┐'), `border closes at ${cols} (…${top.slice(-3)})`);
        t.equal(max, cols, `content spans exactly ${cols} columns`);
      } finally {
        await pty.close();
      }
    }
  });
});
