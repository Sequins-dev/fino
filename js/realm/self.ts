/**
 * fino:realm/self - child Realm's own communication port.
 *
 * Reactor-pooled realms expose the transport port installed by their
 * bootstrap. Root and process realms return `undefined`.
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
import { usesProcessReadiness } from 'internal:scheduler-native';
import type { RealmPort } from '../internal/realm/transport-port.ts';
/**
 * Message port passed to this child realm, or `undefined` when none exists.
 *
 * Reactor-pooled child realms receive the transport port installed by their
 * bootstrap. Root, process, and remote realms return `undefined`.
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
export const port = usesProcessReadiness()
  ? (
      globalThis as {
        realmPort?: RealmPort;
      }
    ).realmPort
  : undefined;

/**
 * Be told when this realm's parent asks it to stop.
 *
 * A termination request is a control frame, so it never appears as a message on
 * the port and cannot be observed by listening for one. A realm that finishes
 * on its own does not need this; a realm whose work is a repeating timer or an
 * open watch does, because the loop exits only once the realm is done *and*
 * holds no live handles — nothing releases those handles unless the realm
 * itself decides to.
 *
 * The listener fires at most once, and fires immediately if the request has
 * already arrived. Returns an unsubscribe function.
 *
 * ```ts no_run
 * import { onTerminate } from 'fino:realm/self';
 *
 * let running = true;
 * onTerminate(() => {
 *   running = false;
 * });
 * while (running) await work();
 * ```
 */
export { onTerminate, terminateRequested } from 'internal:realm/lifecycle';
