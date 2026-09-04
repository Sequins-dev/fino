/**
 * internal:runtime/virtual-timers — deterministic timer scheduling.
 *
 * The queue owns virtual wall time and pending timer promises. Its caller
 * decides when execution is quiescent and calls `advance()`; this mechanism
 * does not encode simulation, Realm, or event-loop policy.
 *
 * @internal
 */

/** A timer promise that can be removed before it fires. @internal */
export interface CancelableVirtualTimer extends Promise<void> {
  /** Remove the timer without settling its promise. */
  cancel(): void;
  /** Exclude the timer from Realm liveness. */
  unref(): this;
  /** Include the timer in Realm liveness. */
  ref(): this;
  /** Report whether this pending timer contributes to Realm liveness. */
  hasRef(): boolean;
}

interface PendingTimer {
  deadline: number;
  sequence: number;
  referenced: boolean;
  resolve: () => void;
}

/** A deterministic clock and pending-timer queue. @internal */
export class VirtualTimerQueue {
  #now: number;
  #timers = new Map<number, PendingTimer>();
  #nextId = 1;
  #nextSequence = 0;

  /** Start at the supplied wall-clock millisecond value. */
  constructor(startMillis: number) {
    this.#now = startMillis;
  }

  /** Return current virtual wall time in milliseconds. */
  now(): number {
    return this.#now;
  }

  /** Return the number of timers waiting to fire. */
  size(): number {
    return this.#timers.size;
  }

  /** Return the number of timers that contribute to Realm liveness. */
  referencedSize(): number {
    let size = 0;
    for (const timer of this.#timers.values()) {
      if (timer.referenced) size++;
    }
    return size;
  }

  /** Return the earliest deadline, or `null` when the queue is empty. */
  earliest(): number | null {
    let earliest: number | null = null;
    for (const timer of this.#timers.values()) {
      if (earliest === null || timer.deadline < earliest) earliest = timer.deadline;
    }
    return earliest;
  }

  /**
   * Schedule a promise `delayMillis` after the current virtual time.
   *
   * Negative and non-finite delays clamp to zero. Cancelling removes the timer
   * and deliberately leaves its promise unsettled, matching runtime timers.
   */
  schedule(delayMillis: number): CancelableVirtualTimer {
    const id = this.#nextId++;
    const delay = Number.isFinite(delayMillis) && delayMillis > 0 ? delayMillis : 0;
    const promise = new Promise<void>((resolve) => {
      this.#timers.set(id, {
        deadline: this.#now + delay,
        sequence: this.#nextSequence++,
        referenced: true,
        resolve,
      });
    }) as CancelableVirtualTimer;
    promise.cancel = () => {
      this.#timers.delete(id);
    };
    promise.unref = () => {
      const timer = this.#timers.get(id);
      if (timer !== undefined) timer.referenced = false;
      return promise;
    };
    promise.ref = () => {
      const timer = this.#timers.get(id);
      if (timer !== undefined) timer.referenced = true;
      return promise;
    };
    promise.hasRef = () => this.#timers.get(id)?.referenced === true;
    return promise;
  }

  /**
   * Advance to the earliest deadline and settle every timer due there.
   *
   * Equal-deadline timers settle in insertion order. The return value is the
   * number fired, allowing an event loop to count the advance as progress.
   */
  advance(): number {
    const deadline = this.earliest();
    if (deadline === null) return 0;
    this.#now = Math.max(this.#now, deadline);

    const due: Array<{ id: number; timer: PendingTimer }> = [];
    for (const [id, timer] of this.#timers) {
      if (timer.deadline <= this.#now) due.push({ id, timer });
    }
    due.sort((left, right) => left.timer.sequence - right.timer.sequence);
    for (const { id } of due) this.#timers.delete(id);
    for (const { timer } of due) timer.resolve();
    return due.length;
  }
}
