/**
 * fino:realm/messaging - MessagePort, MessageChannel, MessageEvent.
 *
 * Standard WHATWG messaging API. Use `MessageChannel` to create a pair of
 * entangled ports for bidirectional communication between realms. `MessagePort`
 * values use structured clone semantics for same-isolate realms and transport
 * serialization for thread, process, and remote realm ports.
 *
 * HTML channel messaging model:
 * https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging
 *
 * Same-isolate messages use the runtime structured-clone subset documented on
 * global `structuredClone()` in `js/globals/encoding.ts`, so functions,
 * symbols, weak collections, streams, and objects with unsupported prototypes
 * fail synchronously during `postMessage()`.
 *
 * Realm transport matrix:
 *
 * | Realm port | Clone path | Transfer support |
 * | --- | --- | --- |
 * | Same-isolate `MessagePort` | Runtime structured-clone subset. | `ArrayBuffer` and `MessagePort`. |
 * | Thread `ThreadPort` | Serializer transport. | `ArrayBuffer` and `MessagePort`. |
 * | Process `ProcessPort` | Serializer transport over process realm handles. | `ArrayBuffer`; `MessagePort` rejects. |
 * | Remote/cluster calls | Cluster transport serialization. | No live `MessagePort` transfer contract. |
 *
 * A transferred `MessagePort` is neutered on the sender side and re-entangled
 * for the receiver where the transport supports it. Other structured-clone
 * transferables such as streams are not supported yet.
 *
 * ```ts no_run
 * import { MessageChannel } from 'fino:realm/messaging';
 * import { Realm } from 'fino:realm';
 *
 * const channel = new MessageChannel();
 * const realm = new Realm({
 *   entry: './worker.ts',
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
 * when documenting or typing realm communication code. `MessageEvent.ports` is
 * a frozen array copy containing transferred ports, or an empty frozen array
 * when no ports were transferred.
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
export { MessagePort, MessageChannel, MessageEvent } from '../globals/messaging.ts';
