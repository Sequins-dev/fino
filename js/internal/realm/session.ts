/**
 * `internal:realm/session` — lazy observation of realm boundary traffic.
 *
 * A session sits above the existing realm envelope and below higher-level
 * views such as facade calls or simulation journals. It does not move messages
 * and does not define another wire protocol. Instead, a transport offers two
 * lazy payload materializers for a frame that has already crossed its live
 * path: one structured-clone snapshot and one stable byte representation.
 * Session filters see metadata first, so neither materializer runs unless a
 * matching observer requests it.
 *
 * The capture modes mirror the WHATWG distinction between structured cloning,
 * transfer, and serialization for storage:
 * <https://html.spec.whatwg.org/multipage/structured-data.html#safe-passing-of-structured-data>.
 *
 * @internal
 */
import type { Envelope } from 'internal:realm/envelope';

/** Direction relative to the endpoint whose session is observed. @internal */
export type RealmFrameDirection = 'outbound' | 'inbound';

/** Payload representation requested by an observer. @internal */
export type RealmCapture = 'metadata' | 'snapshot' | 'storage';

/** Metadata available without cloning or copying a frame payload. @internal */
export interface RealmFrameMetadata extends Envelope {
  /** Order among frames seen while this session has observers. */
  sequence: number;
  /** Whether the frame is leaving or entering the observed endpoint. */
  direction: RealmFrameDirection;
  /** Total bytes in the serialized payload and transferred backing stores. */
  payloadBytes: number;
  /** Number of transferred `ArrayBuffer` backing stores. */
  arrayBufferTransfers: number;
  /** Number of transferred `MessagePort` channels. */
  portTransfers: number;
}

/** An observation that contains only routing and size metadata. @internal */
export interface RealmMetadataObservation extends RealmFrameMetadata {
  capture: 'metadata';
}

/** An observation with an independent structured-clone value. @internal */
export interface RealmSnapshotObservation extends RealmFrameMetadata {
  capture: 'snapshot';
  value: unknown;
}

/** An observation with stable structured-clone bytes. @internal */
export interface RealmStorageObservation extends RealmFrameMetadata {
  capture: 'storage';
  parts: readonly Uint8Array[];
}

/** A frame delivered in the representation requested by its observer. @internal */
export type RealmObservation =
  | RealmMetadataObservation
  | RealmSnapshotObservation
  | RealmStorageObservation;

/** A lazy session subscriber. @internal */
export interface RealmObserver {
  /** Representation needed by this subscriber. Defaults to metadata. */
  capture?: RealmCapture;
  /** Test inexpensive frame metadata before any payload is materialized. */
  filter?(metadata: RealmFrameMetadata): boolean;
  /** Receive each matching frame. */
  next(observation: RealmObservation): void;
  /** Receive capture or callback failures without affecting live delivery. */
  error?(error: unknown): void;
  /** Reject live `MessagePort` transfers because they cannot be persisted. */
  portable?: boolean;
}

/** Inputs supplied by a transport only when the session has observers. @internal */
export interface RealmFrameCapture {
  direction: RealmFrameDirection;
  envelope: Envelope;
  payloadBytes: number;
  arrayBufferTransfers: number;
  portTransfers: number;
  /** Produce one independent structured-clone snapshot on demand. */
  snapshot(): unknown;
  /** Produce one stable copy of the serialized payload parts on demand. */
  storage(): readonly Uint8Array[];
}

/**
 * Ordered, lazily captured traffic for one realm endpoint.
 *
 * @internal
 */
export class RealmSession {
  #observers = new Set<RealmObserver>();
  #sequence = 0;

  /** Whether the transport needs to offer frames to this session. */
  get observed(): boolean {
    return this.#observers.size > 0;
  }

  /** Whether any observer requires a portable, replayable stream. */
  get portable(): boolean {
    for (const observer of this.#observers) if (observer.portable === true) return true;
    return false;
  }

  /** Subscribe until the returned disposer is called. */
  observe(observer: RealmObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  /**
   * Match one frame and materialize only the representations that matched
   * observers request.
   *
   * @internal
   */
  _capture(frame: RealmFrameCapture): void {
    if (this.#observers.size === 0) return;
    const metadata: RealmFrameMetadata = {
      sequence: this.#sequence++,
      direction: frame.direction,
      kind: frame.envelope.kind,
      correlation: frame.envelope.correlation,
      payloadBytes: frame.payloadBytes,
      arrayBufferTransfers: frame.arrayBufferTransfers,
      portTransfers: frame.portTransfers,
    };
    const matched = [...this.#observers].filter((observer) => {
      try {
        return observer.filter?.(metadata) ?? true;
      } catch (error) {
        this.#report(observer, error);
        return false;
      }
    });
    if (matched.length === 0) return;

    const metadataObservers: RealmObserver[] = [];
    const snapshotObservers: RealmObserver[] = [];
    const storageObservers: RealmObserver[] = [];
    for (const observer of matched) {
      switch (observer.capture ?? 'metadata') {
        case 'snapshot':
          snapshotObservers.push(observer);
          break;
        case 'storage':
          storageObservers.push(observer);
          break;
        default:
          metadataObservers.push(observer);
          break;
      }
    }

    this.#deliver(metadataObservers, { ...metadata, capture: 'metadata' });
    if (snapshotObservers.length > 0) {
      try {
        this.#deliver(snapshotObservers, {
          ...metadata,
          capture: 'snapshot',
          value: frame.snapshot(),
        });
      } catch (error) {
        for (const observer of snapshotObservers) this.#report(observer, error);
      }
    }
    if (storageObservers.length > 0) {
      try {
        this.#deliver(storageObservers, {
          ...metadata,
          capture: 'storage',
          parts: frame.storage(),
        });
      } catch (error) {
        for (const observer of storageObservers) this.#report(observer, error);
      }
    }
  }

  #deliver(observers: RealmObserver[], observation: RealmObservation): void {
    for (const observer of observers) {
      try {
        observer.next(observation);
      } catch (error) {
        this.#report(observer, error);
      }
    }
  }

  #report(observer: RealmObserver, error: unknown): void {
    try {
      observer.error?.(error);
    } catch {
      // Observation is a side channel and must never break live delivery.
    }
  }
}
