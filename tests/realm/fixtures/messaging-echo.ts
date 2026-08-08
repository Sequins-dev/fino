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
// Announced rather than waited for. A parent that sleeps instead has to guess how long
// a realm takes to boot, and anything it posts before this line is simply lost.
port.postMessage('ready');
// Keep alive until terminated — this TLA never resolves
await new Promise<void>(() => {});
