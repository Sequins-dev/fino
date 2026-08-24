/**
 * internal:cluster/balancer — tail-shedding policy for the node's queue.
 *
 * Reactors pull work from the head of the local queue; this is the only other
 * consumer, and it takes from the tail. When replicated peer metadata shows
 * this node carrying materially more pending work than a peer, it takes the
 * lowest-priority pre-init specs — pure data, free to place anywhere — and
 * offers them to that peer. Everything the reactors are actually running is
 * untouched: a spec that has begun initializing is no longer in the queue, and
 * an initialized workload is pinned to its node forever.
 *
 * Three properties keep this safe under load:
 *
 * - **Local execution always wins.** A marked spec stays claimable; if a
 *   reactor takes it while an offer is in flight, the commit fails and the
 *   offer result is discarded. Work is never removed from a node that was
 *   ready to run it.
 *
 * - **Rejection is free.** A peer that refuses (or an offer that errors)
 *   leaves the spec exactly where it was, with its queue position intact.
 *
 * - **Hysteresis, not reaction.** Shedding requires both a local queue above
 *   the high watermark and a peer materially lighter, so heartbeat-stale
 *   metadata cannot start work ping-ponging between two near-equal nodes.
 *
 * The policy is deliberately separated from transport and storage: it drives
 * injected ports, so it can be exercised deterministically and can move into
 * the system realm unchanged when the cluster client follows it there.
 *
 * @internal
 */

/** The local queue's tail-shedding surface (the FIN-149 natives). */
export interface ShedQueue {
  /** Current queue pressure. */
  depth(): { pendingSpecs: number; parkedLive: number; active: number };
  /** Mark the lowest-priority pre-init spec for shedding; 0 when none. */
  markLowest(): number;
  /** Commit removal of a marked spec; null when a reactor reclaimed it. */
  take(owner: number): number | null;
  /** Abandon a mark, returning the spec to normal claiming. */
  clear(owner: number): boolean;
  /** Return a taken spec to the queue at its original position. */
  resubmit(handle: number): number;
  /** The serializable form of a taken spec. */
  config(handle: number): {
    entry: string;
    root: string;
    rules: string;
    watch: boolean;
    repl: boolean;
    data: string | null;
    bootstrapData: string | null;
  };
  /** Release a taken spec after a peer has accepted ownership. */
  drop(handle: number): void;
}

/** One peer's advertised pressure, as replicated over heartbeats. */
export interface PeerPressure {
  nodeId: string;
  pendingSpecs: number;
}

/** Result of offering one spec to one peer. */
export interface OfferResult {
  accepted: boolean;
  reason?: string;
}

/** Transport for offering a spec to a peer. */
export interface OfferTransport {
  offer(
    nodeId: string,
    spec: ReturnType<ShedQueue['config']>,
    workloadId: number,
  ): Promise<OfferResult>;
}

/** Tuning knobs. FIN-41 refines these; the defaults are deliberately shy. */
export interface BalancerOptions {
  /** Local pending specs below which the node never sheds. */
  highWatermark?: number;
  /** Required excess over a peer before work moves, preventing oscillation. */
  minDelta?: number;
  /** Maximum specs shed per pass. */
  batch?: number;
  /** Deterministic peer sampler; defaults to power-of-two-choices. */
  samplePeers?: (candidates: PeerPressure[]) => PeerPressure | null;
  /** Called after a peer accepts, to move durable ownership. */
  onTransfer?: (workloadId: number, toNodeId: string) => Promise<void> | void;
}

/** Outcome of one balancing pass. */
export interface BalanceOutcome {
  /** Specs successfully handed to a peer. */
  shed: number;
  /** Offers a peer refused. */
  refused: number;
  /** Marks a local reactor reclaimed mid-offer. */
  reclaimed: number;
}

/**
 * Choose the lighter of two randomly sampled candidates.
 *
 * Sampling rather than always taking the global minimum is what stops every
 * loaded node in a cluster from dogpiling the one peer that currently looks
 * idlest — with stale metadata, that herd is how an idle node becomes the new
 * hotspot.
 */
function powerOfTwoChoices(candidates: PeerPressure[]): PeerPressure | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const first = candidates[Math.floor(Math.random() * candidates.length)]!;
  const second = candidates[Math.floor(Math.random() * candidates.length)]!;
  return first.pendingSpecs <= second.pendingSpecs ? first : second;
}

/** Tail-shedding balancer for one node's workload queue. */
export class QueueBalancer {
  #queue: ShedQueue;
  #transport: OfferTransport;
  #highWatermark: number;
  #minDelta: number;
  #batch: number;
  #samplePeers: (candidates: PeerPressure[]) => PeerPressure | null;
  #onTransfer: ((workloadId: number, toNodeId: string) => Promise<void> | void) | null;

  constructor(queue: ShedQueue, transport: OfferTransport, options: BalancerOptions = {}) {
    this.#queue = queue;
    this.#transport = transport;
    this.#highWatermark = options.highWatermark ?? 2;
    this.#minDelta = options.minDelta ?? 2;
    this.#batch = options.batch ?? 2;
    this.#samplePeers = options.samplePeers ?? powerOfTwoChoices;
    this.#onTransfer = options.onTransfer ?? null;
  }

  /**
   * Run one balancing pass against the current peer view.
   *
   * Returns without touching the queue when the node is not meaningfully
   * overloaded, so calling this on a timer is cheap in the common case.
   */
  async balance(peers: readonly PeerPressure[]): Promise<BalanceOutcome> {
    const outcome: BalanceOutcome = { shed: 0, refused: 0, reclaimed: 0 };
    const local = this.#queue.depth().pendingSpecs;
    if (local < this.#highWatermark) return outcome;

    for (let i = 0; i < this.#batch; i++) {
      // Re-read depth each iteration: shedding lowers local pressure, and the
      // node should stop as soon as it is no longer the heavy one.
      const pending = this.#queue.depth().pendingSpecs;
      if (pending < this.#highWatermark) break;
      const candidates = peers.filter((peer) => pending - peer.pendingSpecs >= this.#minDelta);
      const target = this.#samplePeers(candidates);
      if (target === null) break;

      const owner = this.#queue.markLowest();
      if (owner === 0) break;
      const handle = this.#queue.take(owner);
      if (handle === null) {
        // A reactor claimed it between mark and take: local execution wins.
        outcome.reclaimed++;
        continue;
      }

      let result: OfferResult;
      try {
        result = await this.#transport.offer(target.nodeId, this.#queue.config(handle), owner);
      } catch {
        result = { accepted: false, reason: 'offer failed' };
      }
      if (!result.accepted) {
        this.#queue.resubmit(handle);
        outcome.refused++;
        continue;
      }
      // Move durable ownership before forgetting the spec locally, so a crash
      // in this window leaves the record owned by the accepting node rather
      // than by nobody.
      await this.#onTransfer?.(owner, target.nodeId);
      this.#queue.drop(handle);
      outcome.shed++;
    }
    return outcome;
  }
}
