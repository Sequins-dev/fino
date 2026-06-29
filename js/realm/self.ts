/**
 * fino:realm/self - child Realm's own communication port.
 *
 * In an embedded child Realm, `port` is the MessagePort the parent passed in
 * at construction time. Use it to exchange messages with the parent.
 *
 * In the root Realm, a process realm, a thread realm, or any child created
 * without an explicit port, `port` is `undefined`. Thread and process realms
 * communicate with their parent through `internal:thread-port` (`nativeSend` /
 * `nativeRecv`) rather than a MessagePort object - access that channel via the
 * bootstrap's `ThreadPort` or by calling `nativeSend` / `nativeRecv` directly.
 *
 * Module caching guarantees a single port instance per context. Importing
 * this module from both the entry module and the bootstrap always yields the
 * same object.
 *
 * @example
 * ```ts no_run
 * import { port } from 'fino:realm/self';
 *
 * port?.addEventListener('message', (event) => {
 *   port?.postMessage({ echo: event.data });
 * });
 * port?.start();
 * ```
 */

import { getPort } from 'internal:realm-bridge';
import type { MessagePort } from '../globals/messaging.ts';

/**
 * Message port passed to this child realm, or `undefined` when none exists.
 *
 * Embedded child realms receive the `MessagePort` supplied by the parent or the
 * child side of the default channel created by `new Realm()`. Root, thread,
 * process, and remote realms do not expose this value through `fino:realm/self`.
 * Check for `undefined` before using it.
 *
 * ```ts no_run
 * import { port } from 'fino:realm/self';
 *
 * port?.addEventListener('message', (event) => {
 *   port?.postMessage({ echo: event.data });
 * });
 * port?.start();
 * ```
 */
export const port = getPort() as MessagePort | undefined;
