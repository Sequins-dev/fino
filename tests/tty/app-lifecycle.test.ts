import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const APP = `
import { h } from 'fino:ui';
import { Text, createTuiInput, render } from 'fino:tty/tui';
import type { TuiApp } from 'fino:tty/tui';
import { writeStdout } from 'fino:tty';
import { DiskFileSystem } from 'fino:file';

try {
  render(() => { throw new Error('startup failed'); });
} catch (_) {
  await writeStdout('STARTUP RESTORED\\r\\n');
}

const cancelled = createTuiInput({ mouse: false });
setTimeout(() => cancelled.close(), 20);
const cancelledEvent = await cancelled.read();
await writeStdout('INPUT CANCELLED ' + String(cancelledEvent === null) + '\\r\\n');

let app: TuiApp;
app = render(h(Text, null, 'press q'), {
  input: true,
  mouse: false,
  async onEvent(event) {
    if (event.type !== 'key' || event.key !== 'q') return;
    app.stop();
    app.stop();
    await writeStdout('STOP RESTORED\\r\\n');
  },
});
await new DiskFileSystem().writeFile('__READY_MARKER__', new Uint8Array([1]));
`;

describe('fino:tty/tui app lifecycle', () => {
  it('restores terminal state after startup failure and idempotent stop', async (t) => {
    const dir = `/tmp/fino-tui-lifecycle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const script = `${dir}/app.ts`;
    const ready = `${dir}/input-ready`;
    const fs = new DiskFileSystem();
    await fs.mkdir(dir);
    await fs.writeFile(script, new TextEncoder().encode(APP.replace('__READY_MARKER__', ready)));
    const pty = await openPty(execPath, [script], { cols: 30, rows: 6 });
    try {
      const readyDeadline = performance.now() + 10_000;
      while (true) {
        try {
          await fs.lstat(ready);
          break;
        } catch {
          if (performance.now() >= readyDeadline) throw new Error('TUI input did not become ready');
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
      }
      await pty.send('q');
      await pty.waitFor((term) => term.text().join('').includes('STOP RESTORED'));
      t.equal(await pty.waitExit(), 0, 'the app exits after its input reader is closed');
      const restored = pty.term.text().join('\n');
      t.ok(restored.includes('STARTUP RESTORED'), 'startup failure returned to the primary screen');
      t.ok(restored.includes('INPUT CANCELLED true'), 'close cancels a blocked terminal read');
      t.ok(restored.includes('STOP RESTORED'), 'stop returned to the primary screen exactly once');
    } finally {
      await pty.close();
      await fs.unlink(ready);
      await fs.unlink(script);
      await fs.rmdir(dir);
    }
  });
});
