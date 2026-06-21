/**
 * Small async byte queue used by HTTP/3 request and response bodies.
 *
 * @internal
 */

export class H3BodyQueue implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = [];
  #waiters: Array<{
    resolve(value: IteratorResult<Uint8Array>): void;
    reject(reason: unknown): void;
  }> = [];
  #closed = false;
  #error: unknown = null;

  push(chunk: Uint8Array): void {
    if (this.#closed || this.#error !== null) return;
    if (chunk.byteLength === 0) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: chunk });
    } else {
      this.#chunks.push(chunk);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve({ done: true, value: undefined as any });
  }

  error(reason: unknown): void {
    if (this.#closed || this.#error !== null) return;
    this.#error = reason;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.#chunks.length > 0) {
          return Promise.resolve({ done: false, value: this.#chunks.shift()! });
        }
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined as any });
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}
