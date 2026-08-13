/**
 * fino:tty/components/spinner — a braille spinner the caller ticks.
 */
/** The braille frames a {@link Spinner} cycles through. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/**
 * A spinner that never touches the terminal: the caller ticks it on its own
 * cadence and paints `frame()` wherever it belongs.
 *
 * ```ts
 * import { Spinner } from 'fino:tty/components/spinner';
 *
 * const spinner = new Spinner();
 * spinner.frame(); // '⠋'
 * spinner.tick();
 * spinner.frame(); // '⠙'
 * ```
 */
export class Spinner {
  #index = 0;
  /** The current frame. */
  frame(): string {
    return SPINNER_FRAMES[this.#index]!;
  }
  /** Advance to the next frame, wrapping at the end. */
  tick(): void {
    this.#index = (this.#index + 1) % SPINNER_FRAMES.length;
  }
}
