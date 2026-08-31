/**
 * A minimal FIFO execution gate for asynchronous tasks.
 *
 * Tasks begin one at a time in admission order. A rejected task rejects only
 * its own caller and does not prevent later tasks from running.
 *
 * @internal
 */
export class Fifo {
  #tail: Promise<void> | null = null;

  /** Admit asynchronous work and resolve with its result after its FIFO turn. */
  run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
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
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#tail = tail;
    void tail.then(() => {
      if (this.#tail === tail) this.#tail = null;
    });
    return result;
  }
}
