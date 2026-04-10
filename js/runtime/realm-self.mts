/**
 * fino:realm/self — child Realm's own communication port.
 *
 * In a child Realm, `port` is the MessagePort that the parent passed in at
 * construction time. Use it to exchange messages with the parent.
 *
 * In the root Realm (and any child that was created without a port), `port`
 * is `undefined`.
 *
 * Module caching guarantees a single port instance per context. Importing
 * this module from both the entry module and the bootstrap always yields the
 * same object.
 */

import { getPort } from 'internal:realm-bridge';
import type { MessagePort } from '../internal/globals/messaging.mts';

export const port = getPort() as MessagePort | undefined;
