/**
* internal:parent-rpc — RPC channel from a child Realm to its parent's Facade
* handlers.
*
* A facade proxy module calls `call(specifier, method, args)`; the request is
* correlated over the realm's port channel (`globalThis.realmPort`) and the
* transport-port drain settles it through `resolveRpc`/`rejectRpc` when the
* parent responds. Streaming reads use `callStream` (`__rpc_chunk`/`__rpc_end`/
* `__rpc_err` envelopes routed to `pushChunk`/`endStream`/`errStream`), and
* write streams use `callSink`, whose terminal result flows back through the
* same response envelope.
*
* The correlation machine itself lives in `internal:realm/port-rpc`; this
* module contributes the parent-port transport and the handle-proxy wrapping
* that makes a returned `{ __handle }` behave like a local object. One shared
* id space across scalar, stream, and sink calls lets the single drain path
* disambiguate a response by its id.
*
* Only available in child Realms, where the realm port has a live transit
* channel to its parent. Application code uses the `fino:realm` Facade proxy
* modules, which build on top of it.
*
* @internal
*/
import { PortRpc, WriteSink } from 'internal:realm/port-rpc';

export { WriteSink };

function _sendMsg(msg: unknown): void {
  const port = (globalThis as Record<string, unknown>).realmPort as {
    postMessage(m: unknown): void;
  } | undefined;
  if (port === undefined) {
    throw new Error('parent-rpc: realmPort is not available in this realm');
  }
  port.postMessage(msg);
}

const _rpc = new PortRpc({
  send: _sendMsg,
  // A `{ __handle }` result becomes a transparent method proxy dispatching
  // back through this channel with the handle id as the specifier.
  wrapResult(result) {
    if (result !== null && typeof result === 'object' && typeof (result as {
      __handle?: unknown;
    }).__handle === 'string') {
      const h = result as {
        __handle: string;
        streams?: string[];
        sinks?: string[];
      };
      return _makeHandleProxy(h.__handle, h.streams ?? [], h.sinks ?? []);
    }
    return result;
  }
});

function _makeHandleProxy(handleId: string, streams: string[], sinks: string[]): object {
  const streamSet = new Set(streams);
  const sinkSet = new Set(sinks);
  return new Proxy(Object.create(null) as object, { get(_target, prop: string | symbol) {
    if (typeof prop !== 'string') return undefined;
    // Prevent the proxy from appearing thenable — if 'then' returns a function,
    // V8 treats the object as a Promise and calls .then(), causing infinite chains.
    if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
    if (streamSet.has(prop)) return (...args: unknown[]) => callStream(handleId, prop, args);
    if (sinkSet.has(prop)) return (...args: unknown[]) => callSink(handleId, prop, args);
    return (...args: unknown[]) => call(handleId, prop, args);
  } });
}

/** Call a parent Facade handler and resolve with its response. */
export function call(specifier: string, method: string, args: unknown[]): Promise<unknown> {
  return _rpc.call({ specifier, method, args });
}

/** Call a streaming handler; chunks buffer until the consumer iterates. */
export function callStream(specifier: string, method: string, args: unknown[]): AsyncIterable<unknown> {
  return _rpc.callStream({ specifier, method, args });
}

/** Open a write stream to a parent sink handler. */
export function callSink(specifier: string, method: string, args: unknown[]): WriteSink {
  return _rpc.callSink({ specifier, method, args });
}

/**
* Settle a pending scalar call (falling through to a write-stream's terminal
* result). Called by the transport-port drain on `__rpc_res`.
*/
export function resolveRpc(reqId: number, result: unknown): boolean {
  return _rpc.resolve(reqId, result);
}

/**
* Reject a pending scalar call (falling through to sink, then stream — the id
* may belong to a stream whose handler threw before its first chunk).
*/
export function rejectRpc(reqId: number, error: string): boolean {
  return _rpc.reject(reqId, error);
}

/** Deliver an `__rpc_chunk` payload to its pending stream. */
export function pushChunk(reqId: number, chunk: unknown): void {
  _rpc.pushChunk(reqId, chunk);
}

/** Complete a pending stream on `__rpc_end`. */
export function endStream(reqId: number): void {
  _rpc.endStream(reqId);
}

/** Fail a pending stream on `__rpc_err`. */
export function errStream(reqId: number, error: string): void {
  _rpc.errStream(reqId, error);
}
