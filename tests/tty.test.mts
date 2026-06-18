import { describe, it } from 'fino:test/test';
import { Process, execPath } from 'fino:process';
import { isatty, stderrIsTTY, stdinIsTTY, stdoutIsTTY } from 'fino:tty';

const enc = new TextEncoder();
const dec = new TextDecoder();

function joinChunks(chunks: Uint8Array[]): string {
  const out = chunks.reduce((acc: Uint8Array, chunk: Uint8Array) => {
    const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
    merged.set(acc);
    merged.set(chunk, acc.byteLength);
    return merged;
  }, new Uint8Array(0));
  return dec.decode(out);
}

describe('fino:tty', () => {
  it('exposes deterministic TTY flag snapshots', (t) => {
    t.equal(typeof stdinIsTTY, 'boolean', 'stdinIsTTY is boolean');
    t.equal(typeof stdoutIsTTY, 'boolean', 'stdoutIsTTY is boolean');
    t.equal(typeof stderrIsTTY, 'boolean', 'stderrIsTTY is boolean');
    t.equal(isatty(0), stdinIsTTY, 'stdin snapshot matches isatty(0)');
    t.equal(isatty(1), stdoutIsTTY, 'stdout snapshot matches isatty(1)');
    t.equal(isatty(2), stderrIsTTY, 'stderr snapshot matches isatty(2)');
    t.equal(isatty(-1), false, 'invalid fd is not a TTY');
  });

  it('reads one line and writes stdout/stderr in a child process', async (t) => {
    const proc = new Process(execPath, ['tests/fixtures/tty-helpers.mts']);
    await proc.stdin.write(enc.encode('hello tty\r\nignored'));
    proc.stdin.close();

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
    for await (const chunk of proc.stderr) stderrChunks.push(chunk);
    const result = await proc.wait();

    t.equal(result.code, 0, 'child exits successfully');
    t.equal(joinChunks(stdoutChunks), 'prompt>stdout:hello tty\n', 'readLine strips newline and ignores carriage return');
    t.equal(joinChunks(stderrChunks), 'stderr:ok\n', 'writeStderr writes text');
  });
});
