/**
* fino:realm/self - child Realm's own communication port.
*
* `port` is this realm's channel to its parent — the same object the
* bootstrap exposes as `globalThis.realmPort` — regardless of where the
* allocator placed the realm (same-thread context or dedicated reactor
* thread). In the root realm it is `undefined`.
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
import type { MessagePort } from '../globals/messaging.ts';
/**
* Message port connecting this child realm to its parent, or `undefined` in
* the root realm. The instance is the bootstrap's own child port, so message
* listeners registered here and via `globalThis.realmPort` share delivery.
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
export const port = (globalThis as { realmPort?: MessagePort }).realmPort;
