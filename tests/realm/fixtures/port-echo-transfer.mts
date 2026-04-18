/**
 * Fixture: receives a message from the parent with a transferred MessagePort
 * in event.ports[0], then sends a reply back through that port.
 *
 * Used to test cross-Isolate MessagePort transfer via ThreadPort.
 *
 * `realmPort` is set on globalThis by _bootstrap.mts for all child realms.
 */

// realmPort is set by _bootstrap.mts on globalThis.
const port = (globalThis as any).realmPort as ThreadPort | undefined;
if (!port) {
  throw new Error('port-echo-transfer: expected a realmPort');
}

port.addEventListener('message', (ev) => {
  const transferred = (ev as MessageEvent).ports?.[0];
  if (transferred) {
    transferred.postMessage('echo from thread');
    transferred.close();
  }
});

// Keep alive until terminated.
await new Promise<void>(() => {});
