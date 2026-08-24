/**
 * Realm fixture — multi-event messaging.
 * Listens on the realm port and echoes each message back with a prefix.
 * Stays alive until parent terminates it.
 */
import { port } from 'fino:realm/self';
// If no port, exit immediately (shouldn't happen in tests)
if (port === undefined) {
  throw new Error('messaging-echo: expected a port');
}
port.onmessage = (ev) => {
  port!.postMessage(`echo:${ev.data as string}`);
};
port.postMessage('ready');
// Keep alive until terminated — this TLA never resolves
await new Promise<void>(() => {});
