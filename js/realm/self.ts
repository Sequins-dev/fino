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
import { getPort } from 'internal:realm-bridge';
import { usesProcessReadiness } from 'internal:scheduler-native';
import type { MessagePort } from '../globals/messaging.ts';
import type { ThreadPort } from '../internal/realm/transport-port.ts';
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
export const port =
  (getPort() as MessagePort | undefined) ??
  (usesProcessReadiness()
    ? (
        globalThis as {
          realmPort?: ThreadPort;
        }
      ).realmPort
    : undefined);
