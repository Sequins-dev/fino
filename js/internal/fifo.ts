/**
 * A minimal FIFO execution gate for asynchronous tasks.
 *
 * Tasks begin one at a time in admission order. A rejected task rejects only
 * its own caller and does not prevent later tasks from running. Synchronous
 * work is accepted only when no asynchronous task is pending.
 *
 * @internal
 */
export class Fifo {
  #tail: Promise<void> | null = null;
  #pending = 0;

  /** Run synchronous work only when the FIFO has no pending asynchronous work. */
  runSync(operation: () => void): void {
    if (this.#pending > 0) throw new Error('FIFO has pending asynchronous tasks');
    operation();
  }

  /** Admit asynchronous work and resolve with its result after its FIFO turn. */
  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.#pending++;
    let result: Promise<T>;
    if (this.#tail === null) {
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
    } else {
      result = this.#tail.then(operation, operation);
    }
    const settled = result.then(
      (value) => {
        this.#pending--;
        return value;
      },
      (error) => {
        this.#pending--;
        throw error;
      },
    );
    const tail = settled.then(
      () => {},
      () => {},
    );
    this.#tail = tail;
    void tail.then(() => {
      if (this.#tail === tail) this.#tail = null;
    });
    return settled;
  }
}
