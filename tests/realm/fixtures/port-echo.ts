/**
* Fixture: listens for raw port messages and echoes data back.
*
* Receives `{ tag: number, data: unknown }` and replies with `{ tag, data }`.
* Useful for testing low-level ThreadPort transfer semantics.
* Stays alive until terminated.
*/
import { port } from 'fino:realm/self';
const activePort = port ?? (globalThis as any).realmPort;
if (activePort === undefined) {
  throw new Error('port-echo: expected a port');
}
activePort.onmessage = (ev) => {
  const msg = (ev as MessageEvent).data as {
    tag: number;
    data: unknown;
  };
  if (msg && typeof msg === 'object' && typeof msg.tag === 'number') {
    activePort.postMessage({
      tag: msg.tag,
      data: msg.data
    });
  }
};
// Keep alive until terminated.
await new Promise<void>(() => {});
