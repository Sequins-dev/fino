/**
* internal:realm/allocate — the realm placement seam.
*
* A realm is a serializable configuration; WHERE it runs is the allocator's
* decision, not the caller's (`fino:realm` exposes no placement options).
* This module is the chokepoint every non-process realm construction goes
* through, so growing the policy never touches `Realm` itself.
*
* Current policy: every ordinary realm is placed on the node's scheduler
* reactor set and recorded in its `NodeIsolateCollection`. Reactor-hosted
* parents submit allocation requests back to the owning node over the internal
* control channel instead of creating their own scheduler.
*
* See research-docs/research/realm-allocation.md.
*
* @internal
*/
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { isEngineThread } from 'internal:reactor-engine';
import { registerShutdownHook } from 'internal:shutdown';

// ---------------------------------------------------------------------------
// The node pool
// ---------------------------------------------------------------------------

/** How many scheduler threads the lazily-started node boots. */
let _node: SchedulerNode | null = null;
let _liveRealms = 0;
let _idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

let _shutdownHookRegistered = false;
const ALLOCATOR_CHANNEL = 'fino:internal:realm-allocator';
let _control: BroadcastChannel | null = null;
let _requestSeq = 0;
const _pending = new Map<string, {
  resolve(value: ScheduledRealmAllocation): void;
  reject(error: unknown): void;
}>();
const _remoteReleased = new Map<string, (reason: string) => void>();
const _served = new Map<string, ScheduledRealmAllocation>();
let _serverListening = false;

type AllocationMessage = {
  type: 'allocate';
  requestId: string;
  config: RealmAllocationConfig;
} | {
  type: 'allocated';
  requestId: string;
  workloadId: string;
  portHandle: number;
  portWakeFd: number;
} | {
  type: 'allocationFailed';
  requestId: string;
  error: string;
} | {
  type: 'released';
  requestId: string;
  reason: string;
} | {
  type: 'revoke';
  requestId: string;
  reason: string;
};

function controlChannel(): BroadcastChannel {
  if (_control !== null) return _control;
  const channel = new BroadcastChannel(ALLOCATOR_CHANNEL);
  channel.addEventListener('message', (event) => {
    const message = (event as MessageEvent<AllocationMessage>).data;
    if (message.type === 'allocated') {
      const pending = _pending.get(message.requestId);
      if (pending === undefined) return;
      _pending.delete(message.requestId);
      let release!: (reason: string) => void;
      const released = new Promise<string>((resolve) => { release = resolve; });
      _remoteReleased.set(message.requestId, release);
      pending.resolve({
        workloadId: message.workloadId,
        portHandle: message.portHandle,
        portWakeFd: message.portWakeFd,
        released,
        revoke(reason) {
          channel.postMessage({ type: 'revoke', requestId: message.requestId, reason } satisfies AllocationMessage);
        }
      });
    } else if (message.type === 'allocationFailed') {
      const pending = _pending.get(message.requestId);
      if (pending !== undefined) {
        _pending.delete(message.requestId);
        pending.reject(new Error(message.error));
      }
    } else if (message.type === 'released') {
      const release = _remoteReleased.get(message.requestId);
      if (release !== undefined) {
        _remoteReleased.delete(message.requestId);
        release(message.reason);
      }
    }
  });
  _control = channel;
  return channel;
}

function closeControlChannel(): void {
  const channel = _control;
  _control = null;
  _serverListening = false;
  channel?.close();
}

function ensureNode(): SchedulerNode {
  if (_node === null) {
    _node = new SchedulerNode({ capacity: 8 });
    _node.start();
    const channel = controlChannel();
    if (!_serverListening) channel.addEventListener('message', (event) => {
      const message = (event as MessageEvent<AllocationMessage>).data;
      if (message.type === 'allocate') {
        const placed = placeLocalRealm(message.config);
        if (placed === null) {
          channel.postMessage({ type: 'allocationFailed', requestId: message.requestId, error: 'local reactor capacity is exhausted' } satisfies AllocationMessage);
          return;
        }
        _served.set(message.requestId, placed);
        channel.postMessage({
          type: 'allocated',
          requestId: message.requestId,
          workloadId: placed.workloadId,
          portHandle: placed.portHandle,
          portWakeFd: placed.portWakeFd
        } satisfies AllocationMessage);
        void placed.released.then((reason) => {
          _served.delete(message.requestId);
          channel.postMessage({ type: 'released', requestId: message.requestId, reason } satisfies AllocationMessage);
        });
      } else if (message.type === 'revoke') {
        _served.get(message.requestId)?.revoke(message.reason);
      }
    });
    _serverListening = true;
    if (!_shutdownHookRegistered) {
      _shutdownHookRegistered = true;
      // The host realm winding down takes its scheduler with it: orphaned
      // scheduled realms (created but never run/terminated) must not hold the
      // process open.
      registerShutdownHook(() => {
        const node = _node;
        _node = null;
        _liveRealms = 0;
        if (_idleShutdownTimer !== null) {
          clearTimeout(_idleShutdownTimer);
          _idleShutdownTimer = null;
        }
        closeControlChannel();
        if (node !== null) return node.shutdown().then(() => undefined);
        return undefined;
      });
    }
  }
  return _node;
}

/**
* Idle shutdown: the node's scheduler threads, report pumps, and watchdog
* interval hold the host realm alive, so the pool winds down when its last
* realm releases. Debounced — back-to-back workloads (one test suite ending
* as the next begins) reuse the node instead of racing a teardown against a
* fresh placement; a genuinely idle process pays one 50ms tail.
*/
function releaseRealmRef(node: SchedulerNode): void {
  _liveRealms--;
  if (_liveRealms > 0 || _node !== node) return;
  if (_idleShutdownTimer !== null) clearTimeout(_idleShutdownTimer);
  _idleShutdownTimer = setTimeout(() => {
    _idleShutdownTimer = null;
    if (_liveRealms === 0 && _node === node) {
      _node = null;
      closeControlChannel();
      void node.shutdown();
    }
  }, 50);
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
* Place a realm config on the node scheduler. Returns `null` when all eligible
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
  tenantId?: string;
  localMobility?: 'movable' | 'pinned';
  replication?: 'replicated' | 'bound';
  scalingMin?: number;
  scalingMax?: number;
}

export function placeScheduledRealm(config: RealmAllocationConfig): ScheduledRealmAllocation | Promise<ScheduledRealmAllocation> | null {
  if (isEngineThread()) {
    const requestId = `realm-allocation-${_requestSeq++}`;
    const channel = controlChannel();
    const result = new Promise<ScheduledRealmAllocation>((resolve, reject) => _pending.set(requestId, { resolve, reject }));
    channel.postMessage({ type: 'allocate', requestId, config } satisfies AllocationMessage);
    return result;
  }
  return placeLocalRealm(config);
}

function placeLocalRealm(config: RealmAllocationConfig): ScheduledRealmAllocation | null {
  const node = ensureNode();
  const placed = node.deployRealm({
    entryPath: config.entry,
    rulesJson: config.rulesJson,
    ...config.tenantId !== undefined ? { tenantId: config.tenantId } : {},
    ...config.localMobility !== undefined ? { localMobility: config.localMobility } : {},
    ...config.replication !== undefined ? { replication: config.replication } : {},
    ...config.scalingMin !== undefined ? { scalingMin: config.scalingMin } : {},
    ...config.scalingMax !== undefined ? { scalingMax: config.scalingMax } : {},
    ...config.realmData !== undefined ? { realmData: config.realmData } : {},
    ...config.bootstrapData !== undefined ? { bootstrapData: config.bootstrapData } : {},
    ...config.watch !== undefined ? { watch: config.watch } : {},
    ...config.repl !== undefined ? { repl: config.repl } : {}
  });
  if (placed === null) return null;
  _liveRealms++;
  if (_idleShutdownTimer !== null) {
    clearTimeout(_idleShutdownTimer);
    _idleShutdownTimer = null;
  }
  const released = node.whenReleased(placed.workloadId);
  released.then(() => releaseRealmRef(node), () => releaseRealmRef(node));
  return {
    workloadId: placed.workloadId,
    portHandle: placed.portHandle,
    portWakeFd: placed.portWakeFd,
    released,
    revoke: (reason: string) => node.revoke(placed.workloadId, reason)
  };
}
