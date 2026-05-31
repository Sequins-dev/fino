import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

function sendEval(port: MessagePort, id: number, code: string): void {
  port.postMessage({ __eval: true, id, code });
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

async function evalIn(port: MessagePort, id: number, code: string): Promise<Record<string, unknown>> {
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

  it('rejects repl with thread option', async (t) => {
    t.throws(
      () => new Realm({ repl: true, thread: true }),
      /repl: true is only supported for embedded realms/,
      'throws for thread + repl',
    );
  });
});
