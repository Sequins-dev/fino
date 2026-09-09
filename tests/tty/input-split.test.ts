import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import type { PtyHandle } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import { decodeTuiInput } from 'fino:tty/tui';
import { trySignalChild } from 'internal:process/spawn';

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

async function echoPty(name: string, source = ECHO_APP, startupTimeout = 30_000): Promise<EchoPty> {
  const dir = `/tmp/fino-input-split-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const script = `${dir}/echo.ts`;
  await fs.mkdir(dir);
  await fs.writeFile(script, encoder.encode(source));
  let pty: PtyHandle | undefined;
  try {
    pty = await openPty(execPath, [script], { cols: 40, rows: 12 });
    await pty.waitFor((term) => term.text().join('').includes('READY'), {
      timeout: startupTimeout,
    });
    return {
      pty,
      async close(): Promise<void> {
        await pty!.close();
        await fs.unlink(script);
        await fs.rmdir(dir);
      },
    };
  } catch (error) {
    await pty?.close();
    await fs.unlink(script);
    await fs.rmdir(dir);
    throw error;
  }
}

function screen(pty: PtyHandle): string {
  return pty.term.text().join('').replace(/\s+/g, '');
}

describe('fino:tty/tui terminal input reassembly', () => {
  it('reassembles escape sequences split into separate read results', async (t) => {
    const source = new TextDecoder().decode(
      await fs.readFile(new URL('../fixtures/tty-input-split.ts', import.meta.url).pathname),
    );
    const session = await echoPty('escape', source);
    try {
      await session.pty.send('\x1B[A');
      await session.pty.waitFor((term) => term.text().join('').includes('<up>'));
      t.ok(!screen(session.pty).includes('<escape>'), 'the held prefix emits no stray Escape');

      await session.pty.send('\x1B[C');
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

  it('closes the child when fixture startup fails', async (t) => {
    let error: unknown;
    try {
      await echoPty('missing-ready', 'await new Promise(() => {});', 1);
    } catch (caught) {
      error = caught;
    }
    t.ok(error instanceof Error, 'startup reports its timeout');
    const child = /child (\d+):/.exec(String(error));
    t.ok(child !== null, 'timeout identifies the child');
    const pid = Number(child![1]);
    const alive = trySignalChild(pid, 0);
    // Keep the regression safe against the old helper that leaked the child.
    if (alive) trySignalChild(pid, 9);
    t.equal(alive, false, 'failed startup has already reaped its child');
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
