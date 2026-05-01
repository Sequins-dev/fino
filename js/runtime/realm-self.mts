/**
 * fino:realm/self — child Realm's own communication port.
 *
 * In an embedded child Realm, `port` is the MessagePort the parent passed in
 * at construction time. Use it to exchange messages with the parent.
 *
 * In the root Realm, a process realm, a thread realm, or any child created
 * without an explicit port, `port` is `undefined`. Thread and process realms
 * communicate with their parent through `internal:thread-port` (`nativeSend` /
 * `nativeRecv`) rather than a MessagePort object — access that channel via the
 * bootstrap's `ThreadPort` or by calling `nativeSend` / `nativeRecv` directly.
 *
 * Module caching guarantees a single port instance per context. Importing
 * this module from both the entry module and the bootstrap always yields the
 * same object.
 */

import { getPort } from 'internal:realm-bridge';
import type { MessagePort } from '../internal/globals/messaging.mts';

export const port = getPort() as MessagePort | undefined;
