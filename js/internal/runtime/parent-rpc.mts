/**
 * internal:parent-rpc — RPC channel from a child Realm to its parent's Facade handlers.
 *
 * When a facade proxy module calls `call(specifier, method, args)`, this module:
 *   1. Allocates a request id and stores a Promise resolver in `_pending`.
 *   2. Serialises `{__rpc_req, specifier, method, reqId, args}` and sends it to
 *      the parent via the realm's native channel (nativeSend).
 *   3. Returns the Promise.
 *
 * When the parent sends back `{__rpc_res, reqId, result|error}`, the port drain
 * function in messaging.mts calls `resolveRpc` or `rejectRpc` here to settle the
 * pending Promise.
 *
 * Only available in thread and process child Realms (where `nativeSend` has a live
 * channel_tx). Embedded child Realms are not a primary facade target.
 */

import { nativeSend } from 'internal:thread-port';
import { serialize } from 'internal:serializer';

// ---------------------------------------------------------------------------
// Pending call registry
// ---------------------------------------------------------------------------

let _nextId = 0;
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Make an RPC call to the parent's registered Facade handler.
 *
 * Serialises the request as a V8-ValueSerializer message and sends it through
 * the native channel. The returned Promise settles when the parent sends back
 * a `__rpc_res` message, which the drain function delivers via `resolveRpc` or
 * `rejectRpc`.
 */
export function call(specifier: string, method: string, args: unknown[]): Promise<unknown> {
  const reqId = _nextId++;
  return new Promise<unknown>((resolve, reject) => {
    _pending.set(reqId, { resolve, reject });
    const msg = { __rpc_req: true, specifier, method, reqId, args };
    const bytes = (_ser as (v: unknown) => Uint8Array[])(msg)[0];
    (_send as (b: Uint8Array, s: Uint8Array[], p: unknown[]) => void)(bytes, [], []);
  });
}

/**
 * Settle a pending call with a successful result.
 * Called by `ThreadPort._drain()` / `ProcessPort._drain()` on `__rpc_res`.
 */
export function resolveRpc(reqId: number, result: unknown): void {
  const entry = _pending.get(reqId);
  if (!entry) return;
  _pending.delete(reqId);
  entry.resolve(result);
}

/**
 * Settle a pending call with an error.
 * Called by `ThreadPort._drain()` / `ProcessPort._drain()` on `__rpc_res`.
 */
export function rejectRpc(reqId: number, error: string): void {
  const entry = _pending.get(reqId);
  if (!entry) return;
  _pending.delete(reqId);
  entry.reject(new Error(error));
}

// ---------------------------------------------------------------------------
// Lazy locals (avoid import-time side-effects)
// ---------------------------------------------------------------------------

const _ser  = serialize;
const _send = nativeSend;
