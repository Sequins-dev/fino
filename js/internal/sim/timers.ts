/**
 * internal:sim/timers — the virtual timer queue behind a simulated realm.
 *
 * A simulated realm never arms a kernel timer. `internal:runtime/loop` hands
 * every `timeout()` to this queue instead, and the realm's own step loop
 * advances the clock once it has nothing else to do. A wait of a day therefore
 * costs one step rather than a day, and the order timers fire in is fixed by
 * their deadlines rather than by how long the machine took to get there.
 *
 * Time advances only when the realm is quiescent, so a timer can never be
 * observed to overtake work that was already runnable.
 *
 * ```ts no_run
 * import { VirtualTimerQueue } from 'internal:sim/timers';
 *
 * const queue = new VirtualTimerQueue(0);
 * void queue.schedule(5_000).then(() => console.log('fired at', queue.now()));
 * queue.advance(); // logs: fired at 5000
 * ```
 *
 * @internal
 */
/**
 * A pending promise returned by `timeout()`, cancellable before it fires.
 *
 * @internal
 */
export interface CancelableTimer extends Promise<void> {
  /** Drop the timer without settling the promise. */
  cancel(): void;
}
interface PendingTimer {
  deadline: number;
  sequence: number;
  resolve: () => void;
}
/**
 * Virtual clock and timer heap for one simulated realm.
 *
 * @internal
 */
export class VirtualTimerQueue {
  #now: number;
  #timers = new Map<number, PendingTimer>();
  #nextId = 1;
  #nextSequence = 0;
  /**
   * Start the clock at `startMillis`, the wall time the simulation begins at.
   */
  constructor(startMillis: number) {
    this.#now = startMillis;
  }
  /**
   * Current virtual time in milliseconds.
   */
  now(): number {
    return this.#now;
  }
  /**
   * Number of timers still waiting to fire.
   */
  size(): number {
    return this.#timers.size;
  }
  /**
   * Deadline of the next timer to fire, or `null` when none are pending.
   */
  earliest(): number | null {
    let earliest: number | null = null;
    for (const timer of this.#timers.values()) {
      if (earliest === null || timer.deadline < earliest) earliest = timer.deadline;
    }
    return earliest;
  }
  /**
   * Schedule a timer `ms` milliseconds of virtual time from now.
   *
   * Negative and non-finite delays clamp to zero, matching the loop's real
   * `timeout()`. A cancelled timer never settles, also matching it.
   */
  schedule(ms: number): CancelableTimer {
    const id = this.#nextId++;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const promise = new Promise<void>((resolve) => {
      this.#timers.set(id, {
        deadline: this.#now + delay,
        sequence: this.#nextSequence++,
        resolve,
      });
    }) as CancelableTimer;
    promise.cancel = () => {
      this.#timers.delete(id);
    };
    return promise;
  }
  /**
   * Jump to the next deadline and settle every timer due at it.
   *
   * Timers sharing a deadline fire in scheduling order, so equal deadlines are
   * resolved by a rule rather than by map iteration. Returns how many fired,
   * which the step loop reports as progress.
   */
  advance(): number {
    const deadline = this.earliest();
    if (deadline === null) return 0;
    // Never move backwards: a timer scheduled with a zero delay during a turn
    // is already due at the current time.
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
