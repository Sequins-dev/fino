/**
* internal:repl/handler — REPL command handling.
*
* Runs inside the child realm created for the CLI REPL. Requests arrive over a
* `MessagePort`, are evaluated through the inspector API in REPL mode, and are
* posted back as compact result or error envelopes for the parent realm.
*
* ```js
* import { handleEval } from 'internal:repl/handler';
* console.log(typeof handleEval);
* ```
*
* @internal
*/
import { evaluate } from 'internal:inspector';
let _evalCount = 0;
interface EvalRequest {
  id: number;
  code: string;
  port: MessagePort;
}
/**
* Evaluate one REPL request and post the response to the supplied port.
*
* Successful evaluations post `{ __eval_result: true, id, value }`. Failures
* post `{ __eval_error: true, id, message, stack? }`. Inspector exception
* details are reduced to a user-facing message, and unserializable remote
* objects fall back to their inspector description. This function does not
* close the port and never throws for normal evaluation failures.
*
* ```js
* import { handleEval } from 'internal:repl/handler';
* const { port1, port2 } = new MessageChannel();
* port1.start();
* await handleEval({ id: 1, code: '1 + 1', port: port2 });
* ```
*
* @param request REPL evaluation request with id, source code, and reply port.
* @returns A promise that resolves after a result or error has been posted.
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
