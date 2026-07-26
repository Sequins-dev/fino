import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { Process, env, execPath } from 'fino:process';
const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const decodeUtf8 = (value: ArrayBuffer | ArrayBufferView): string =>
  new TextDecoder().decode(value);
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeUtf8(merged);
}
async function runRepl(input: string): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Process['wait']>>;
}> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = new Process(execPath, ['repl'], { env: childEnv });
  await proc.stdin.write(encodeUtf8(input));
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return {
    stdout,
    stderr,
    result,
  };
}
function sendEval(port: MessagePort, id: number, code: string): void {
  port.postMessage({
    __eval: true,
    id,
    code,
  });
}
function awaitResponse(port: MessagePort, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    port.addEventListener('message', function handler(ev: Event) {
      const msg = (ev as MessageEvent<Record<string, unknown>>).data;
      if (msg && (msg['id'] as number) === id) {
        port.removeEventListener('message', handler);
        resolve(msg);
      }
    });
  });
}
async function evalIn(
  port: MessagePort,
  id: number,
  code: string,
): Promise<Record<string, unknown>> {
  sendEval(port, id, code);
  return awaitResponse(port, id);
}
async function withRepl(fn: (port: MessagePort) => Promise<void>): Promise<void> {
  const realm = new Realm({ repl: true });
  const port = realm.port as MessagePort;
  port.start();
  const runPromise = realm.run();
  try {
    await fn(port);
  } finally {
    port.postMessage({ __terminate: true });
    port.close();
    await runPromise;
  }
}
describe('REPL realm', () => {
  it('evaluates a simple expression', async (t) => {
    await withRepl(async (port) => {
      const res = await evalIn(port, 1, '1 + 2');
      t.equal(res['__eval_result'], true, 'result flag set');
      t.equal(res['value'], 3, 'got correct value');
    });
  });
  it('persists state across multiple evals', async (t) => {
    await withRepl(async (port) => {
      const r1 = await evalIn(port, 1, 'let x = 42');
      t.equal(r1['__eval_result'], true, 'let declaration succeeds');
      const r2 = await evalIn(port, 2, 'x + 1');
      t.equal(r2['__eval_result'], true, 'variable visible');
      t.equal(r2['value'], 43, 'correct value');
    });
  });
  it('allows re-declaration of let in REPL mode', async (t) => {
    await withRepl(async (port) => {
      await evalIn(port, 1, 'let y = 10');
      const r2 = await evalIn(port, 2, 'let y = 20');
      t.equal(r2['__eval_result'], true, 'redeclare succeeds');
      const r3 = await evalIn(port, 3, 'y');
      t.equal(r3['value'], 20, 'updated value');
    });
  });
  it('returns error envelope for SyntaxError', async (t) => {
    await withRepl(async (port) => {
      const res = await evalIn(port, 1, '1 +');
      t.equal(res['__eval_error'], true, 'error flag set');
      t.ok(typeof res['message'] === 'string', 'message present');
    });
  });
  it('returns error envelope for ReferenceError', async (t) => {
    await withRepl(async (port) => {
      const res = await evalIn(port, 1, 'undeclaredVariableXyz');
      t.equal(res['__eval_error'], true, 'error flag set');
      t.ok(typeof res['message'] === 'string', 'message present');
    });
  });
  it('handles top-level await', async (t) => {
    await withRepl(async (port) => {
      const res = await evalIn(port, 1, 'await Promise.resolve(99)');
      t.equal(res['__eval_result'], true, 'result flag set');
      t.equal(res['value'], 99, 'awaited value correct');
    });
  });
  it('rejects repl with process, remote, or watch options', async (t) => {
    for (const option of ['process', 'remote', 'watch'] as const) {
      t.throws(
        () =>
          new Realm({
            repl: true,
            [option]: true,
          }),
        /repl: true is not supported with process, remote, or watch/,
        `throws for ${option} + repl`,
      );
    }
  });
});
describe('REPL CLI', () => {
  it('evaluates stdin expressions and exits on .exit', async (t) => {
    const { stdout, stderr, result } = await runRepl('1 + 2\n.exit\n');
    t.equal(result.code, 0, 'repl exits successfully');
    t.equal(stderr, '', 'repl does not write stderr');
    t.ok(stdout.includes('Fino REPL'), 'repl prints the banner');
    t.ok(stdout.includes('> 3\n'), 'repl prints expression results');
  });
  it('continues multiline input until brackets close', async (t) => {
    const { stdout, stderr, result } = await runRepl('({\nanswer: 42\n})\n.exit\n');
    t.equal(result.code, 0, 'multiline repl exits successfully');
    t.equal(stderr, '', 'multiline repl does not write stderr');
    t.ok(stdout.includes('... '), 'multiline repl prints continuation prompts');
    t.ok(stdout.includes('"answer": 42'), 'multiline expression result is formatted');
  });
  it('formats object and JSON-compatible results', async (t) => {
    const { stdout, stderr, result } = await runRepl('({ name: "fino", values: [1, 2] })\n.exit\n');
    t.equal(result.code, 0, 'object repl exits successfully');
    t.equal(stderr, '', 'object repl does not write stderr');
    t.ok(stdout.includes('"name": "fino"'), 'object result includes string properties');
    t.ok(
      stdout.includes('"values": [\n    1,\n    2\n  ]'),
      'object result includes nested JSON values',
    );
  });
  it('prints thrown errors and keeps the session alive', async (t) => {
    const { stdout, stderr, result } = await runRepl('throw new Error("boom")\n21 * 2\n.exit\n');
    t.equal(result.code, 0, 'error repl exits successfully');
    t.equal(stderr, '', 'error repl does not write stderr');
    t.ok(stdout.includes('boom'), 'thrown error message is printed');
    t.ok(stdout.includes('> 42\n'), 'repl continues after thrown errors');
  });
  it('edits input at the cursor with left and right arrows', async (t) => {
    const { stdout, stderr, result } = await runRepl('12\x1B[D+\x1B[C*10\n.exit\n');
    t.equal(result.code, 0, 'cursor-edit repl exits successfully');
    t.equal(stderr, '', 'cursor-edit repl does not write stderr');
    t.ok(
      stdout.includes('> 21\n'),
      'left and right arrows edit the submitted expression at the cursor',
    );
  });
  it('navigates submitted input history with up and down arrows', async (t) => {
    const { stdout, stderr, result } = await runRepl('1 + 2\n4 + 5\n\x1B[A\x1B[A\x1B[B\n.exit\n');
    t.equal(result.code, 0, 'history repl exits successfully');
    t.equal(stderr, '', 'history repl does not write stderr');
    const results = [...stdout.matchAll(/^> (\d+)$/gm)].map((match) => match[1]);
    t.deepEqual(
      results,
      ['3', '9', '9'],
      'up and down arrows recall previous submitted expressions',
    );
  });
  it('falls back when a result cannot be JSON stringified', async (t) => {
    const { stdout, stderr, result } = await runRepl('const a = {}; a.self = a; a\n.exit\n');
    t.equal(result.code, 0, 'circular object repl exits successfully');
    t.equal(stderr, '', 'circular object repl does not write stderr');
    t.ok(
      stdout.includes('> Object\n'),
      'circular object falls back to inspector description formatting',
    );
  });
  it('exits on stdin EOF, Ctrl-D, and Ctrl-C', async (t) => {
    const eof = await runRepl('1 + 1\n');
    const ctrlD = await runRepl('');
    const ctrlC = await runRepl('');
    t.equal(eof.result.code, 0, 'EOF exits successfully');
    t.ok(eof.stdout.includes('> 2\n'), 'EOF still evaluates preceding input');
    t.equal(ctrlD.result.code, 0, 'Ctrl-D exits successfully');
    t.equal(ctrlD.stderr, '', 'Ctrl-D does not write stderr');
    t.equal(ctrlC.result.code, 0, 'Ctrl-C exits successfully');
    t.equal(ctrlC.stderr, '', 'Ctrl-C does not write stderr');
  });
});
