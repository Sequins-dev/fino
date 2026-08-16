import { describe, it } from 'fino:test/test';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import { decodeTuiInput } from 'fino:tty/tui';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();

// Echoes each decoded event on its own line so the emulator can be asked what
// arrived. Not `render()` — this is about the reader, not the paint path.
const ECHO_APP = `
import { createTuiInput } from 'fino:tty/tui';
import { writeStdout } from 'fino:tty';
const input = createTuiInput({ mouse: false });
for (;;) {
  const event = await input.read();
  if (event === null) break;
  if (event.type === 'key' && event.key === 'q') break;
  await writeStdout('<' + event.key + (event.alt ? '+alt' : '') + '>\\r\\n');
}
input.close();
`;

async function echoPty(name: string): Promise<Awaited<ReturnType<typeof openPty>>> {
  const dir = `/tmp/fino-input-split-${name}`;
  await fs.mkdir(dir).catch(() => {});
  const script = `${dir}/echo.ts`;
  await fs.writeFile(script, encoder.encode(ECHO_APP));
  return openPty(execPath, [script], { cols: 40, rows: 12 });
}

function seen(pty: { term: { text(): string[] } }): string {
  return pty.term
    .text()
    .join('')
    .replace(/\s+/g, '');
}

describe('fino:tty/tui terminal input reassembly', () => {
  it('reads an escape sequence the tty split across reads', async (t) => {
    const pty = await echoPty('split');
    try {
      await pty.send('\x1B[B');
      await pty.waitFor((term) => term.text().join('').includes('<down>'));
      t.ok(true, 'a whole three-byte write decodes');

      // The bytes of one keypress, delivered one read at a time — what a tty
      // hands over when the reader is already awake and drains between them.
      await pty.send('\x1B');
      await new Promise((r) => setTimeout(r, 8));
      await pty.send('[');
      await new Promise((r) => setTimeout(r, 8));
      await pty.send('A');
      await pty.waitFor((term) => term.text().join('').includes('<up>'));
      t.ok(true, 'the same key split three ways still decodes as one key');

      await pty.send('\x1B[');
      await new Promise((r) => setTimeout(r, 8));
      await pty.send('C');
      await pty.waitFor((term) => term.text().join('').includes('<right>'));
      t.ok(true, 'a split before the final byte still decodes');
      t.ok(!seen(pty).includes('<escape>'), 'no stray Escape from the held prefix');
    } finally {
      await pty.close();
    }
  });

  it('still delivers Escape and alt-combinations', async (t) => {
    const pty = await echoPty('escape');
    try {
      await pty.send('\x1B');
      await pty.waitFor((term) => term.text().join('').includes('<escape>'), { timeout: 2000 });
      t.ok(true, 'a lone ESC arrives as Escape once nothing follows it');

      await pty.send('\x1Bb');
      await pty.waitFor((term) => term.text().join('').includes('<b+alt>'));
      t.ok(true, 'ESC with a letter behind it is still alt+key');
    } finally {
      await pty.close();
    }
  });

  it('decodeTuiInput treats its buffer as complete', (t) => {
    t.deepEqual(
      decodeTuiInput(encoder.encode('\x1B[B')).map((e) => (e.type === 'key' ? e.key : e.type)),
      ['down'],
      'a whole sequence decodes to one key',
    );
    t.deepEqual(
      decodeTuiInput(encoder.encode('\x1B')).map((e) => (e.type === 'key' ? e.key : e.type)),
      ['escape'],
      'a lone ESC in a complete buffer is the Escape key',
    );
  });
});
