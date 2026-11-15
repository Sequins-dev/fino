/**
 * internal:abort — disposable cancellation subscriptions, waits, and deadlines.
 *
 * These Realm-local mechanisms retain AbortSignal's reason and compose with
 * caller-owned resource policy. Rejecting a wait does not stop its operation;
 * callers must cancel or close underlying work themselves. Disposal removes
 * subscriptions and timers without aborting the signal or operation.
 *
 * @internal
 */

/** Minimal structural signal contract shared by runtime and native signal adapters. */
export interface AbortSource {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: string, callback: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, callback: () => void): void;
}

/**
 * Subscribe once, removing the listener before invoking `callback`.
 * Already-aborted signals invoke it immediately. Missing signals do nothing.
 * The returned disposer is idempotent; callback exceptions propagate normally.
 */
export function onAbort(
  signal: AbortSource | null | undefined,
  callback: (reason: unknown) => void,
): () => void {
  if (!signal) return () => {};
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', abort);
  };
  const abort = () => {
    if (disposed) return;
    dispose();
    callback(signal.reason);
  };
  if (signal.aborted) {
    disposed = true;
    callback(signal.reason);
  } else {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }
  return dispose;
}

/**
 * Invoke `operation` unless already aborted and wait for its result or abort.
 * Both late fulfillment and rejection are observed after cancellation, avoiding
 * unhandled rejection. All settlement paths remove the abort subscription.
 * The operation starts synchronously; active cancellation is caller-owned.
 */
export function withAbort<T>(
  operation: () => T | PromiseLike<T>,
  signal?: AbortSource | null,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let dispose = () => {};
    const settle = (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      dispose();
      if (success) resolve(value as T);
      else reject(value);
    };
    dispose = onAbort(signal, (reason) => settle(false, reason));
    if (settled) {
      dispose();
      return;
    }
    try {
      Promise.resolve(operation()).then(
        (value) => settle(true, value),
        (reason) => settle(false, reason),
      );
    } catch (error) {
      settle(false, error);
    }
  });
}

/** Deadline configuration. The default scheduler uses Realm-owned timers. */
export interface AbortScopeOptions {
  /** Parent signal whose cancellation is forwarded with its exact reason. */
  signal?: AbortSource | null;
  /** Optional finite non-negative delay in milliseconds. */
  timeoutMs?: number;
  /** Reason for expiry; defaults to a TimeoutError DOMException. */
  timeoutReason?: unknown;
  /** Schedule an asynchronous callback and return its idempotent cancellation. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Owned signal plus cleanup; neither this object nor its resources cross Realms. */
export interface AbortScope {
  /** Signal aborted by the parent, deadline, or explicit abort. */
  signal: AbortSignal;
  /** Abort with `reason` and release all owned subscriptions and timers. */
  abort(reason?: unknown): void;
  /** Release resources without aborting. Repeated calls are safe. */
  dispose(): void;
}

/**
 * Create an owned cancellation scope linked to an optional parent and deadline.
 * The first abort reason wins. Expiry, parent cancellation, explicit abort, and
 * disposal release the timer and parent subscription. A pre-aborted parent
 * prevents scheduling the timer. Disposed signals can still be aborted explicitly.
 */
export function abortScope(options: AbortScopeOptions = {}): AbortScope {
  const delay = options.timeoutMs;
  if (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
    throw new RangeError('timeoutMs must be finite and non-negative');
  const controller = new AbortController();
  let disposed = false;
  let parent = () => {};
  let timer = () => {};
  let own = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    own();
    parent();
    timer();
  };
  own = onAbort(controller.signal, dispose);
  parent = onAbort(options.signal, (reason) => controller.abort(reason));
  if (disposed) parent();
  if (!disposed && delay !== undefined) {
    const schedule =
      options.schedule ??
      ((callback: () => void, ms: number) => {
        const handle = setTimeout(callback, ms);
        return () => clearTimeout(handle);
      });
    try {
      timer = schedule(
        () =>
          controller.abort(
            options.timeoutReason === undefined
              ? new DOMException('The operation timed out.', 'TimeoutError')
              : options.timeoutReason,
          ),
        delay,
      );
      if (disposed) timer();
    } catch (error) {
      dispose();
      throw error;
    }
  }
  return { signal: controller.signal, abort: (reason) => controller.abort(reason), dispose };
}
