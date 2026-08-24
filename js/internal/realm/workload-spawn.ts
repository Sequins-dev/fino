/**
 * internal:realm/workload-spawn — asking the host node to spawn a child.
 *
 * A workload has no cluster client. Module state is per isolate, so
 * `getCluster()` inside a deployed realm is always null, and handing the
 * workload a real client would hand it the node's identity along with it.
 *
 * Instead the workload asks its host over the port it already has. The host
 * supplies what the workload must not choose for itself — the child's
 * parentage in the ownership tree, the cask its entry resolves against, and a
 * quota — and answers on the same port. This mirrors how the system realm
 * receives its shedding capability: a scoped request/reply over an existing
 * port rather than an ambient global.
 *
 * The reserved keys (`__cluster_spawn`, `__cluster_spawn_ack`) follow the
 * convention already used for `__terminate`, `__call_error`, and the system
 * realm's `__shed_offer`, so no new channel is needed.
 *
 * @internal
 */
import { port as selfPort } from '../../realm/self.ts';

interface PendingSpawn {
  resolve: (childPortId: string) => void;
  reject: (error: Error) => void;
}

let nextId = 1;
const pending = new Map<number, PendingSpawn>();
let listening = false;

/**
 * Whether this realm can ask its host to spawn children.
 *
 * True inside a workload the cluster started. A realm with no port — the root
 * of a process, say — has nobody to ask.
 */
export function workloadSpawnAvailable(): boolean {
  return selfPort !== undefined;
}

function ensureListening(): void {
  if (listening || selfPort === undefined) return;
  listening = true;
  // The host's replies arrive as ordinary port messages, so this listener has
  // to coexist with whatever the workload itself installed. `addEventListener`
  // rather than `onmessage`: overwriting the application's handler to deliver
  // an internal reply would be a hostile thing for the runtime to do.
  selfPort.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { __cluster_spawn_ack?: Record<string, unknown> } | null;
    if (data === null || typeof data !== 'object') return;
    const ack = data.__cluster_spawn_ack;
    if (ack === undefined) return;
    const entry = pending.get(Number(ack.id));
    if (entry === undefined) return;
    pending.delete(Number(ack.id));
    if (typeof ack.childPortId === 'string') entry.resolve(ack.childPortId);
    else entry.reject(new Error(String(ack.error ?? 'remote spawn failed')));
  });
  selfPort.start?.();
}

/**
 * Ask the host node to spawn `entry` as a child of this workload.
 *
 * `entry` is relative to the cask this workload was deployed from; the host
 * resolves it there and refuses anything that escapes. Resolves with the
 * child's cluster port ID, or rejects with the host's reason — an entry
 * outside the cask, an exhausted quota, or no cask at all.
 */
export function requestWorkloadSpawn(entry: string, bootstrapData?: unknown): Promise<string> {
  if (selfPort === undefined) {
    return Promise.reject(new Error('fino:realm — this realm has no host to spawn through'));
  }
  ensureListening();
  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    selfPort.postMessage({
      __cluster_spawn: {
        id,
        entry,
        ...(bootstrapData === undefined ? {} : { bootstrapData }),
      },
    });
  });
}
