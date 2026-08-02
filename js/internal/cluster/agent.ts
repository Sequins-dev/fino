/**
 * internal:cluster/agent — supervised owner of the per-node system realm.
 *
 * The agent spawns the system realm (`internal:cluster/system-realm`) in the
 * scheduler's system priority class, consumes the reports it pushes over the
 * realm port, and restarts it if it ever exits without being stopped — the
 * local-supervisor contract for node infrastructure. Soft state is only the
 * latest report; a restarted system realm rebuilds it within one interval.
 *
 * @internal
 */
import { Realm } from '../../realm/index.ts';
import type { NodeLoadSample } from 'internal:runtime/stats';

/** One observation pushed by the system realm. */
/** A shed offer the system realm asks the cluster client to execute. */
export interface ShedOfferRequest {
  id: number;
  toNodeId: string;
  shedHandle: number;
  workloadId: number;
}

export interface NodeReport {
  /** `Date.now()` on the system realm when the sample was taken. */
  at: number;
  /** Smoothed node-load sample (cpu, memory, loopIdle when applicable). */
  load: NodeLoadSample;
  /** Queue-pressure snapshot: pending specs, parked live isolates, active. */
  queue: {
    pendingSpecs: number;
    parkedLive: number;
    active: number;
  };
  /** Per-workload load deltas drained from the reactor pool. */
  workloads: Array<{
    owner: number;
    busyMicros: number;
    slices: number;
    loopTurns: number;
    activationDelayMicros: number;
    activations: number;
  }>;
}

const RESTART_DELAY_MS = 250;

/**
 * Supervised system-realm lifecycle plus access to its latest report.
 */
export class SystemRealmAgent {
  #realm: Realm | null = null;
  #latest: NodeReport | null = null;
  #stopped = true;
  #supervisor: Promise<void> | null = null;

  /** Spawn the system realm and begin supervising it. Idempotent. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#supervisor = this.#supervise();
  }

  /** The most recent report, or null before the first one arrives. */
  /**
   * Executes a shed offer on behalf of the system realm — the system realm
   * decides which spec moves where; the cluster client owns the network.
   * Null until the cluster wires it, in which case offers are refused.
   */
  onShedOffer:
    | ((offer: ShedOfferRequest) => Promise<{ accepted: boolean; reason?: string }>)
    | null = null;

  /** Push the latest replicated peer-pressure view down to the system realm. */
  postPeers(peers: Array<{ nodeId: string; pendingSpecs: number }>): void {
    this.#realm?.port.postMessage({ __peers: peers });
  }

  latest(): NodeReport | null {
    return this.#latest;
  }

  /** Resolve once at least one report has arrived. */
  async firstReport(timeoutMs = 10_000): Promise<NodeReport> {
    const deadline = Date.now() + timeoutMs;
    while (this.#latest === null) {
      if (this.#stopped) throw new Error('system realm agent is stopped');
      if (Date.now() > deadline) throw new Error('timed out waiting for a system realm report');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return this.#latest;
  }

  /** Test hook: the live system realm, or null between restarts. @internal */
  _currentRealm(): Realm | null {
    return this.#realm;
  }

  /** Stop supervising and terminate the system realm. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#realm?.port.postMessage({ __system_stop: true });
    this.#realm?.terminate();
    await this.#supervisor?.catch(() => {});
    this.#supervisor = null;
    this.#latest = null;
  }

  async #supervise(): Promise<void> {
    while (!this.#stopped) {
      const realm = new Realm({
        entry: 'internal:cluster/system-realm',
        _system: true,
      });
      this.#realm = realm;
      realm.port.onmessage = (event) => {
        const data = (event as MessageEvent).data as {
          __system_report?: NodeReport;
          __shed_offer?: ShedOfferRequest;
        };
        if (data === null || typeof data !== 'object') return;
        if (data.__system_report !== undefined) {
          this.#latest = data.__system_report;
        }
        if (data.__shed_offer !== undefined) {
          const offer = data.__shed_offer;
          const relay = this.onShedOffer;
          if (relay === null) {
            realm.port.postMessage({
              __shed_result: { id: offer.id, accepted: false, reason: 'no offer relay' },
            });
            return;
          }
          void relay(offer).then(
            (result) => {
              realm.port.postMessage({
                __shed_result: {
                  id: offer.id,
                  accepted: result.accepted,
                  ...(result.reason === undefined ? {} : { reason: result.reason }),
                },
              });
            },
            (err: unknown) => {
              realm.port.postMessage({
                __shed_result: {
                  id: offer.id,
                  accepted: false,
                  reason: err instanceof Error ? err.message : String(err),
                },
              });
            },
          );
        }
      };
      realm.port.start();
      try {
        await realm.run();
      } catch {
        // A crashed system realm is a supervision event, not a node failure.
      }
      this.#realm = null;
      if (!this.#stopped) {
        await new Promise<void>((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      }
    }
  }
}
