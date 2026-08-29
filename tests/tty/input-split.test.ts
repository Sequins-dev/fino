import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import type { PtyHandle } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import { decodeTuiInput } from 'fino:tty/tui';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();

const ECHO_APP = `
import { createTuiInput } from 'fino:tty/tui';
import { writeStdout } from 'fino:tty';
const input = createTuiInput({ mouse: false });
await writeStdout('READY\\r\\n');
for (;;) {
  const event = await input.read();
  if (event === null || (event.type === 'key' && event.key === 'q')) break;
  if (event.type === 'key') await writeStdout('<' + event.key + '>\\r\\n');
}
input.close();
`;

interface EchoPty {
  pty: PtyHandle;
  close(): Promise<void>;
}

async function echoPty(name: string): Promise<EchoPty> {
  const dir = `/tmp/fino-input-split-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const script = `${dir}/echo.ts`;
  await fs.mkdir(dir);
  await fs.writeFile(script, encoder.encode(ECHO_APP));
  try {
    const pty = await openPty(execPath, [script], { cols: 40, rows: 12 });
    await pty.waitFor((term) => term.text().join('').includes('READY'));
    return {
      pty,
      async close(): Promise<void> {
        await pty.close();
        await fs.unlink(script);
        await fs.rmdir(dir);
      },
    };
  } catch (error) {
    await fs.unlink(script);
    await fs.rmdir(dir);
    throw error;
  }
}

function screen(pty: PtyHandle): string {
  return pty.term.text().join('').replace(/\s+/g, '');
}

describe('fino:tty/tui terminal input reassembly', () => {
  it('reassembles escape sequences split across live reads', async (t) => {
    const session = await echoPty('escape');
    try {
      await session.pty.send('\x1B');
      await new Promise((resolve) => setTimeout(resolve, 8));
      await session.pty.send('[');
      await new Promise((resolve) => setTimeout(resolve, 8));
      await session.pty.send('A');
      await session.pty.waitFor((term) => term.text().join('').includes('<up>'));
      t.ok(!screen(session.pty).includes('<escape>'), 'the held prefix emits no stray Escape');

      await session.pty.send('\x1B[');
      await new Promise((resolve) => setTimeout(resolve, 8));
      await session.pty.send('C');
      await session.pty.waitFor((term) => term.text().join('').includes('<right>'));
      t.ok(true, 'a split before the final byte also decodes');
    } finally {
      await session.close();
    }
  });

  it('reassembles UTF-8 code points split across live reads', async (t) => {
    const session = await echoPty('utf8');
    try {
      const bytes = encoder.encode('界');
      await session.pty.send(bytes.slice(0, 1));
      await new Promise((resolve) => setTimeout(resolve, 8));
      await session.pty.send(bytes.slice(1));
      await session.pty.waitFor((term) => term.text().join('').includes('<界>'));
      t.ok(true, 'streaming UTF-8 decoding preserves a split code point');
    } finally {
      await session.close();
    }
  });

  it('still delivers bare Escape after the hold window', async (t) => {
    const session = await echoPty('bare');
    try {
      await session.pty.send('\x1B');
      await session.pty.waitFor((term) => term.text().join('').includes('<escape>'), {
        timeout: 2000,
      });
      t.ok(true, 'a prefix with no continuation becomes Escape');
    } finally {
      await session.close();
    }
  });

  it('keeps complete-buffer decoding synchronous', (t) => {
    t.deepEqual(
      decodeTuiInput(encoder.encode('\x1B[B')).map((event) =>
        event.type === 'key' ? event.key : event.type,
      ),
      ['down'],
      'a complete sequence is one key',
    );
    t.deepEqual(
      decodeTuiInput(encoder.encode('\x1B')).map((event) =>
        event.type === 'key' ? event.key : event.type,
      ),
      ['escape'],
      'a complete bare ESC is Escape',
    );
  });
});
