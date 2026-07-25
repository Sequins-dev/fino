/**
* internal:orchestrator/idle — the shared idle-retirement state machine.
*
* Everything that drains an idle resource follows the same shape: count active
* holds, arm a timer when the last hold releases, re-check the retirement
* condition when the timer fires, then retire. This class owns that timer
* bookkeeping once so each adopter contributes only its policy (`delayMs`,
* `shouldRetire`) and its effect (`retire`).
*
* @internal
*/
export interface IdleRetirementOptions {
  /** Idle delay before retiring; a function is sampled at scheduling time. */
  delayMs: number | (() => number);
  /** Re-checked both when scheduling and when the timer fires. */
  shouldRetire(): boolean;
  retire(): void;
}

export class IdleRetirement {
  #held = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #options: IdleRetirementOptions;

  constructor(options: IdleRetirementOptions) {
    this.#options = options;
  }

  /** Active holds — retirement never fires while any are outstanding. */
  get held(): number {
    return this.#held;
  }

  /** Take a hold and cancel any pending retirement. */
  retain(): void {
    this.#held++;
    this.cancel();
  }

  /** Release a hold; the last release arms the retirement timer. */
  release(): void {
    this.#held = Math.max(0, this.#held - 1);
    if (this.#held === 0) this.poke();
  }

  /** (Re-)arm the retirement timer without changing the hold count. */
  poke(): void {
    this.cancel();
    if (this.#held !== 0 || !this.#options.shouldRetire()) return;
    const delay = this.#options.delayMs;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#held === 0 && this.#options.shouldRetire()) this.#options.retire();
    }, typeof delay === 'function' ? delay() : delay);
  }

  /** Cancel a pending retirement without touching the hold count. */
  cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

}
