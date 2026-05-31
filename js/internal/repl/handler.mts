/**
 * internal:repl/handler — REPL command handling.
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

export async function handleEval({ id, code, port }: EvalRequest): Promise<void> {
  const sourceName = `<repl:${++_evalCount}>`;
  let responseJson: string;
  try {
    responseJson = await (evaluate as (code: string, opts: { replMode: boolean; awaitPromise: boolean; sourceName: string }) => Promise<string>)(
      code,
      { replMode: true, awaitPromise: true, sourceName },
    );
  } catch (err) {
    port.postMessage({
      __eval_error: true,
      id,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }

  // responseJson is a CDP Runtime.evaluate response envelope:
  // { id, result: { result: { type, value, ... }, exceptionDetails? } }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(responseJson) as Record<string, unknown>;
  } catch {
    port.postMessage({ __eval_error: true, id, message: 'failed to parse inspector response' });
    return;
  }

  const result = parsed['result'] as Record<string, unknown> | undefined;
  if (!result) {
    port.postMessage({ __eval_error: true, id, message: 'no result in inspector response' });
    return;
  }

  const exceptionDetails = result['exceptionDetails'] as Record<string, unknown> | undefined;
  if (exceptionDetails) {
    const exc = exceptionDetails['exception'] as Record<string, unknown> | undefined;
    const message = (exceptionDetails['text'] as string | undefined) ??
      (exc?.['description'] as string | undefined) ??
      'Script threw an exception';
    port.postMessage({ __eval_error: true, id, message });
    return;
  }

  const remoteObj = result['result'] as Record<string, unknown> | undefined;
  if (!remoteObj) {
    port.postMessage({ __eval_result: true, id, value: undefined });
    return;
  }

  const type = remoteObj['type'] as string | undefined;
  if (type === 'undefined') {
    port.postMessage({ __eval_result: true, id, value: undefined });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(remoteObj, 'value')) {
    port.postMessage({ __eval_result: true, id, value: remoteObj['value'] });
    return;
  }

  const desc = (remoteObj['description'] as string | undefined) ?? `[${type ?? 'object'}]`;
  port.postMessage({ __eval_result: true, id, value: desc });
}
