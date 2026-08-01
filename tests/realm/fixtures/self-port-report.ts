/**
 * Realm fixture — report child-side port visibility.
 */
import { port } from 'fino:realm/self';
const realmPort = (
  globalThis as {
    realmPort?: {
      postMessage(message: unknown): void;
      transport?: string;
    };
  }
).realmPort;
const activePort = port ?? realmPort;
if (activePort === undefined) {
  throw new Error('self-port-report: expected a child messaging port');
}
activePort.postMessage({
  selfPort: port !== undefined,
  realmPort: realmPort !== undefined,
  samePort: port !== undefined && realmPort !== undefined && port === realmPort,
  transport: (activePort as { transport?: string }).transport ?? null,
});
await new Promise<void>(() => {});
