import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, env, execPath } from 'fino:process';
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of reader) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}
async function runCli(args: string[], cwd: string): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = new Process(execPath, args, {
    cwd,
    env: childEnv
  });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait()
  ]);
  return {
    stdout,
    stderr,
    code: result.code
  };
}
describe('CLI JSON output', () => {
  it('prints structured JSON for a task-backed builtin command', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-cli-json-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await fs.mkdir(root);
    const result = await runCli([
      '--json',
      'fmt',
      '--check',
      '.'
    ], root);
    const payload = JSON.parse(result.stdout.trim()) as {
      command: string;
      ok: boolean;
      check: boolean;
      message: string;
      files: string[];
    };
    t.equal(result.code, 0, result.stderr);
    t.equal(payload.command, 'fmt');
    t.equal(payload.ok, true);
    t.equal(payload.check, true);
    t.deepEqual(payload.files, ['.']);
    t.equal(payload.message, 'fino fmt: no source files found');
  });
  it('prints structured JSON for lint', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-cli-json-lint-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await fs.mkdir(root);
    const result = await runCli([
      '--json',
      'lint',
      '.'
    ], root);
    const payload = JSON.parse(result.stdout.trim()) as {
      command: string;
      ok: boolean;
      fix: boolean;
      message: string;
      files: string[];
    };
    t.equal(result.code, 0, result.stderr);
    t.equal(payload.command, 'lint');
    t.equal(payload.ok, true);
    t.equal(payload.fix, false);
    t.deepEqual(payload.files, ['.']);
    t.equal(payload.message, 'fino lint: no source files found');
  });
});
