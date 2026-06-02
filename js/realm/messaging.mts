/**
 * fino:realm/messaging - MessagePort, MessageChannel, MessageEvent.
 *
 * Standard WHATWG messaging API. Use `MessageChannel` to create a pair of
 * entangled ports for bidirectional communication between realms. `MessagePort`
 * values use structured clone semantics for same-isolate realms and transport
 * serialization for thread, process, and remote realm ports.
 *
 * ```ts no_run
 * import { MessageChannel } from 'fino:realm/messaging';
 * import { Realm } from 'fino:realm';
 *
 * const channel = new MessageChannel();
 * const realm = new Realm({
 *   entry: './worker.mts',
 *   input: channel.port1,
 *   output: channel.port2,
 * });
 * realm.port.postMessage({ hello: true });
 * ```
 */

/**
 * Messaging primitives re-exported from the runtime globals module.
 *
 * `MessageChannel` creates two entangled ports, `MessagePort` represents one
 * endpoint, and `MessageEvent` wraps delivered data. Import from this module
 * when documenting or typing realm communication code.
 *
 * ```ts no_run
 * import { MessageChannel, MessageEvent, MessagePort } from 'fino:realm/messaging';
 *
 * const { port1, port2 }: { port1: MessagePort; port2: MessagePort } = new MessageChannel();
 * port1.addEventListener('message', (event: MessageEvent) => console.log(event.data));
 * port2.postMessage('ready');
 * port1.start();
 * ```
 */
export { MessagePort, MessageChannel, MessageEvent } from '../internal/globals/messaging.mts';
