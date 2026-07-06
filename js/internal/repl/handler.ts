/**
* internal:repl-handler — evaluate REPL input inside the child REPL realm.
*
* This module is loaded only inside the child realm that the CLI creates for an
* interactive REPL session (a realm bootstrapped with `repl: true`). The parent
* realm owns the terminal; it forwards each line of typed input to the child as
* an `{ __eval: true, id, code, port }` message, and this module evaluates the
* code and posts a compact result or error envelope back over the same
* `MessagePort`. Isolating evaluation in a child realm keeps user code from
* touching the parent's globals while still sharing the process event loop.
*
* Evaluation goes through `internal:inspector` rather than a bare `eval`, so the
* input runs in REPL mode: bare declarations persist across turns, the final
* expression's value is returned, and top-level `await` is supported. Values are
* returned by-value when the inspector can serialize them (`returnByValue`),
* falling back to the remote object's textual description for things that cannot
* cross the boundary (functions, host objects, circular structures).
*
* The response envelopes are deliberately minimal so the parent can dispatch on
* a single flag without a shared schema: a success is
* `{ __eval_result: true, id, value }` and a failure is
* `{ __eval_error: true, id, message, stack? }`, where `id` echoes the request
* so the parent can correlate concurrent turns.
*
* ```ts no_run
*   import { handleEval } from 'internal:repl-handler';
*
*   const { port1, port2 } = new MessageChannel();
*   port1.start();
*   port1.addEventListener('message', (ev) => {
*     const msg = (ev as MessageEvent).data;
*     if (msg.__eval_result) console.log('=>', msg.value);
*     else if (msg.__eval_error) console.error('!!', msg.message);
*   });
*
*   await handleEval({ id: 1, code: 'const x = 6 * 7; x', port: port2 });
*   // the message listener above logs: => 42
* ```
*
* @internal
*/
import { evaluate } from 'internal:inspector';
let _evalCount = 0;
/**
* One unit of REPL work: the source line to run and the port to answer on.
*
* `id` is an opaque correlation token chosen by the parent and echoed back
* verbatim in the response envelope, so a parent that has several turns in
* flight can match each reply to its prompt. `code` is the raw source typed at
* the prompt, evaluated in REPL mode. `port` is the reply channel; the same port
* is typically reused for every turn of a session, and it is only written to,
* never closed, by the handler.
*/
interface EvalRequest {
  id: number;
  code: string;
  port: MessagePort;
}
/**
* Evaluate one REPL request and post exactly one response envelope to its port.
*
* The source is compiled under a private `<repl:N>` name (with a per-module
* counter so successive turns get distinct names in stack traces) and run
* through the inspector in REPL mode with `awaitPromise` enabled, so a top-level
* `await` resolves before the value is reported. The handler first asks the
* inspector to return the result by value; if that response carries no result
* payload it retries once with `returnByValue` disabled and reports the remote
* object's description instead. This two-pass strategy lets primitives and
* JSON-like values come back exactly while still yielding a readable string for
* values the inspector refuses to serialize.
*
* Every code path posts a single message and returns: successful turns post
* `{ __eval_result: true, id, value }` (with `value` set to `undefined` when the
* expression evaluates to `undefined`), and failures post
* `{ __eval_error: true, id, message, stack? }`. A thrown user exception is
* surfaced by reducing the inspector's exception details to a single
* user-facing `message`; a malformed or result-less inspector response becomes a
* diagnostic error envelope rather than a throw. Because failures are reported
* in-band, this function does not reject for ordinary evaluation errors and does
* not close the port — the caller keeps the session alive for the next turn.
*
* ```ts no_run
*   import { handleEval } from 'internal:repl-handler';
*
*   const { port1, port2 } = new MessageChannel();
*   port1.start();
*   port1.addEventListener('message', (ev) => {
*     const m = (ev as MessageEvent).data;
*     console.log(m.__eval_result ? m.value : `error: ${m.message}`);
*   });
*
*   await handleEval({ id: 1, code: 'await Promise.resolve(41) + 1', port: port2 });
*   // logs: 42
*   await handleEval({ id: 2, code: 'throw new Error("boom")', port: port2 });
*   // logs: error: Error: boom
* ```
*
* @internal
*/
export async function handleEval({ id, code, port }: EvalRequest): Promise<void> {
  const sourceName = `<repl:${++_evalCount}>`;
  const evaluateCode = (returnByValue: boolean) => (evaluate as (code: string, opts: {
    replMode: boolean;
    awaitPromise: boolean;
    returnByValue: boolean;
    sourceName: string;
  }) => Promise<string>)(code, {
    replMode: true,
    awaitPromise: true,
    returnByValue,
    sourceName
  });
  let responseJson: string;
  try {
    responseJson = await evaluateCode(true);
  } catch (err) {
    port.postMessage({
      __eval_error: true,
      id,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    return;
  }
  // responseJson is a CDP Runtime.evaluate response envelope:
  // { id, result: { result: { type, value, ... }, exceptionDetails? } }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseJson) as Record<string, unknown>;
  } catch {
    port.postMessage({
      __eval_error: true,
      id,
      message: 'failed to parse inspector response'
    });
    return;
  }
  const result = parsed['result'] as Record<string, unknown> | undefined;
  if (!result) {
    try {
      responseJson = await evaluateCode(false);
      parsed = JSON.parse(responseJson) as Record<string, unknown>;
    } catch {
      port.postMessage({
        __eval_error: true,
        id,
        message: 'no result in inspector response'
      });
      return;
    }
  }
  const fallbackResult = parsed['result'] as Record<string, unknown> | undefined;
  if (!fallbackResult) {
    port.postMessage({
      __eval_error: true,
      id,
      message: 'no result in inspector response'
    });
    return;
  }
  const exceptionDetails = fallbackResult['exceptionDetails'] as Record<string, unknown> | undefined;
  if (exceptionDetails) {
    const exc = exceptionDetails['exception'] as Record<string, unknown> | undefined;
    const message = exc?.['description'] as string | undefined ?? exceptionDetails['text'] as string | undefined ?? 'Script threw an exception';
    port.postMessage({
      __eval_error: true,
      id,
      message
    });
    return;
  }
  const remoteObj = fallbackResult['result'] as Record<string, unknown> | undefined;
  if (!remoteObj) {
    port.postMessage({
      __eval_result: true,
      id,
      value: undefined
    });
    return;
  }
  const type = remoteObj['type'] as string | undefined;
  if (type === 'undefined') {
    port.postMessage({
      __eval_result: true,
      id,
      value: undefined
    });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(remoteObj, 'value')) {
    port.postMessage({
      __eval_result: true,
      id,
      value: remoteObj['value']
    });
    return;
  }
  const desc = remoteObj['description'] as string | undefined ?? `[${type ?? 'object'}]`;
  port.postMessage({
    __eval_result: true,
    id,
    value: desc
  });
}
