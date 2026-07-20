/**
* internal:realm/allocate — the realm placement seam.
*
* A realm is a serializable configuration; WHERE it runs is the allocator's
* decision, not the caller's (`fino:realm` exposes no placement options).
* This module is the chokepoint every non-process realm construction goes
* through, so growing the policy never touches `Realm` itself.
*
* Every ordinary realm is placed by the node orchestrator. Reactor-hosted
* parents submit allocation requests back to that owner over the internal
* control channel instead of creating another orchestrator.
*
* See research-docs/research/realm-allocation.md.
*
* @internal
*/
import { clusterOrchestrator } from 'internal:orchestrator/cluster-orchestrator';
import { getAllocationPortInfo } from 'internal:realm-bridge';
import { PortRpc, type WireCodec } from 'internal:realm/port-rpc';
import { ThreadPort } from 'internal:realm/transport-port';
import { registerShutdownHook } from 'internal:shutdown';

const ALLOCATION_CODEC: WireCodec = {
  encodeReq(id, head) {
    return { type: 'allocate', requestId: id, config: head['config'] };
  },
  decode(msg) {
    if (msg['type'] === 'allocated') return { kind: 'res', id: msg['requestId'] as number, result: msg };
    if (msg['type'] === 'allocationFailed') return { kind: 'err', id: msg['requestId'] as number, error: String(msg['error']) };
    return null;
  }
};

let _control: { channel: ThreadPort; rpc: PortRpc } | null = null;
const _ownerReleased = new Map<number, (reason: string) => void>();
let _controlShutdownHookRegistered = false;

type AllocationMessage = {
  type: 'allocate';
  requestId: number;
  config: RealmAllocationConfig;
} | {
  type: 'allocated';
  requestId: number;
  workloadId: string;
  portHandle: number;
  portWakeFd: number;
} | {
  type: 'allocationFailed';
  requestId: number;
  error: string;
} | {
  type: 'released';
  requestId: number;
  reason: string;
} | {
  type: 'revoke';
  requestId: number;
  reason: string;
};

function controlChannel(): { channel: ThreadPort; rpc: PortRpc } {
  if (_control !== null) return _control;
  const info = (getAllocationPortInfo as () => {
    handle: number;
    wakeReadFd: number;
  } | undefined)();
  if (info === undefined) throw new Error('realm allocator control port is unavailable');
  const channel = new ThreadPort(info.wakeReadFd, info.handle);
  const rpc = new PortRpc({
    send: (msg) => channel.postMessage(msg),
    codec: ALLOCATION_CODEC
  });
  channel.addEventListener('message', (event) => {
    const message = (event as MessageEvent<AllocationMessage>).data;
    if (rpc.dispatch(message)) return;
    // `released` is an owner push, not a response — it settles the
    // allocation's lifetime promise rather than a pending request.
    if (message.type === 'released') {
      const release = _ownerReleased.get(message.requestId);
      if (release !== undefined) {
        _ownerReleased.delete(message.requestId);
        release(message.reason);
      }
    }
  });
  channel.start();
  _control = { channel, rpc };
  if (!_controlShutdownHookRegistered) {
    _controlShutdownHookRegistered = true;
    registerShutdownHook(() => {
      _controlShutdownHookRegistered = false;
      closeControlChannel(new Error('realm allocator control port shut down'));
    });
  }
  return _control;
}

function closeControlChannel(reason = new Error('realm allocator control port closed')): void {
  const control = _control;
  _control = null;
  control?.channel.close();
  control?.rpc.rejectAll(reason);
  for (const release of _ownerReleased.values()) release(reason.message);
  _ownerReleased.clear();
}

/** Serve one realm's private allocation control port until that owner exits. */
function serveAllocationPort(port: ThreadPort, ownerReleased: Promise<string>): void {
  const served = new Map<number, ScheduledRealmAllocation>();
  let closed = false;
  port.addEventListener('message', (event) => {
    const message = (event as MessageEvent<AllocationMessage>).data;
    if (closed) return;
    if (message.type === 'allocate') {
      const placed = placeLocalRealm(message.config);
      if (placed === null) {
        port.postMessage({ type: 'allocationFailed', requestId: message.requestId, error: 'local reactor capacity is exhausted' } satisfies AllocationMessage);
        return;
      }
      served.set(message.requestId, placed);
      port.postMessage({
        type: 'allocated',
        requestId: message.requestId,
        workloadId: placed.workloadId,
        portHandle: placed.portHandle,
        portWakeFd: placed.portWakeFd
      } satisfies AllocationMessage);
      void placed.released.then((reason) => {
        served.delete(message.requestId);
        if (!closed) port.postMessage({ type: 'released', requestId: message.requestId, reason } satisfies AllocationMessage);
      });
    } else if (message.type === 'revoke') {
      served.get(message.requestId)?.revoke(message.reason);
    }
  });
  port.start();
  void ownerReleased.then((reason) => {
    closed = true;
    for (const allocation of served.values()) allocation.revoke(`allocation-owner-released: ${reason}`);
    served.clear();
    port.close();
  });
}

/** A pool-hosted realm placement, returned to `Realm`. */
export interface ScheduledRealmAllocation {
  workloadId: string;
  /** Parent-side channel half: the Realm's port messages through it. */
  portHandle: number;
  portWakeFd: number;
  /** Resolves with the engine release reason when the realm exits. */
  released: Promise<string>;
  /** Hard-kill the workload (terminate() fallback when the port is closed). */
  revoke(reason: string): void;
}

/**
* Place a realm config through the node orchestrator. Returns `null` when all eligible
* reactors are at their admission limits.
*
* @internal
*/
export interface RealmAllocationConfig {
  entry: string;
  rulesJson: string;
  realmData?: string;
  bootstrapData?: string;
  watch?: boolean;
  repl?: boolean;
}

export function placeScheduledRealm(config: RealmAllocationConfig): ScheduledRealmAllocation | Promise<ScheduledRealmAllocation> | null {
  if (hasAllocationPort()) {
    const { channel, rpc } = controlChannel();
    return rpc.call({ config }).then((raw) => {
      const message = raw as Extract<AllocationMessage, { type: 'allocated' }>;
      let release!: (reason: string) => void;
      const released = new Promise<string>((resolve) => { release = resolve; });
      _ownerReleased.set(message.requestId, release);
      return {
        workloadId: message.workloadId,
        portHandle: message.portHandle,
        portWakeFd: message.portWakeFd,
        released,
        revoke(reason) {
          channel.postMessage({ type: 'revoke', requestId: message.requestId, reason } satisfies AllocationMessage);
        }
      } satisfies ScheduledRealmAllocation;
    });
  }
  return placeLocalRealm(config);
}

function hasAllocationPort(): boolean {
  if (_control !== null) return true;
  const info = (getAllocationPortInfo as () => unknown | undefined)();
  return info !== undefined;
}

function placeLocalRealm(config: RealmAllocationConfig): ScheduledRealmAllocation | null {
  const placed = clusterOrchestrator.allocateRealm({
    entryPath: config.entry,
    rulesJson: config.rulesJson,
    ...config.realmData !== undefined ? { realmData: config.realmData } : {},
    ...config.bootstrapData !== undefined ? { bootstrapData: config.bootstrapData } : {},
    ...config.watch !== undefined ? { watch: config.watch } : {},
    ...config.repl !== undefined ? { repl: config.repl } : {}
  });
  if (placed === null) return null;
  const released = placed.released;
  const allocationPort = new ThreadPort(placed.allocationPortWakeFd, placed.allocationPortHandle);
  serveAllocationPort(allocationPort, released);
  return {
    workloadId: placed.workloadId,
    portHandle: placed.portHandle,
    portWakeFd: placed.portWakeFd,
    released,
    revoke: placed.revoke
  };
}
