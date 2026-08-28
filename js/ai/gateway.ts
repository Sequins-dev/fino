/**
 * fino:ai/gateway — per-key model policy and credential-safe realm facades.
 *
 * `GatewayPolicy` uses a generic atomic store counter to smooth requests
 * over a fixed window. `gatewayModel()` applies it immediately before provider
 * work. `modelFacade()` keeps the real model and its credentials in the parent
 * realm while exposing only generation methods to a child.
 *
 * ```ts no_run
 * import { memoryStore } from 'fino:store';
 * import { gatewayModel, GatewayPolicy } from 'fino:ai/gateway';
 *
 * const policy = new GatewayPolicy({
 *   store: memoryStore(),
 *   requests: 60,
 *   windowMs: 60000,
 * });
 * const tenantModel = gatewayModel(parentModel, { policy, key: 'tenant-42' });
 * ```
 */
import type { AtomicExpiringStore } from 'fino:store';
import type { GenerateRequest, Model, ModelStream } from 'fino:ai/model';
import { ModelStreamImpl } from 'internal:ai/shared';
import { Facade } from 'fino:realm';
interface Counter {
  count: number;
  resetAt: number;
}
/**
 * Fixed-window gateway policy options.
 */
export interface GatewayPolicyOptions {
  /** Generic store used for atomic, expiring counters. */
  store: AtomicExpiringStore;
  /** Requests allowed for each key in one window. */
  requests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Deterministic clock hook. Defaults to `Date.now`. */
  clock?: () => number;
}
/**
 * Error returned when a gateway key has exhausted its current window.
 */
export class GatewayRateLimitError extends Error {
  /** Rejected tenant/API key. */
  readonly key: string;
  /** Milliseconds until the counter window resets. */
  readonly retryAfterMs: number;
  /** Absolute reset timestamp. */
  readonly retryAt: number;
  /** Configured request limit. */
  readonly limit: number;
  /** Create structured retry metadata for a rejected key. */
  constructor(key: string, retryAt: number, now: number, limit: number) {
    super(`AI gateway rate limit exceeded for ${key}`);
    this.name = 'GatewayRateLimitError';
    this.key = key;
    this.retryAt = retryAt;
    this.retryAfterMs = Math.max(0, retryAt - now);
    this.limit = limit;
  }
}
/**
 * Atomic per-key request counter backed directly by `fino:store`.
 */
export class GatewayPolicy {
  #store: AtomicExpiringStore;
  #requests: number;
  #windowMs: number;
  #clock: () => number;
  /**
   * Create a policy. Counters are isolated by the exact key passed to
   * `acquire()`.
   */
  constructor(options: GatewayPolicyOptions) {
    if (!Number.isInteger(options.requests) || options.requests <= 0) {
      throw new RangeError('requests must be a positive integer');
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError('windowMs must be positive');
    }
    this.#store = options.store.namespace('fino:ai:gateway');
    this.#requests = options.requests;
    this.#windowMs = options.windowMs;
    this.#clock = options.clock ?? Date.now;
  }
  /**
   * Consume one request from `key`, retrying optimistic-store conflicts.
   *
   * Throws `GatewayRateLimitError` before provider invocation when the current
   * window is full.
   */
  async acquire(key: string): Promise<{
    remaining: number;
    resetAt: number;
  }> {
    if (!key) throw new TypeError('gateway key must not be empty');
    for (let attempt = 0; attempt < 32; attempt++) {
      const now = this.#clock();
      const entry = await this.#store.atomic.getEntry<Counter>(key);
      const expired = entry === null || entry.value.resetAt <= now;
      const current: Counter = expired
        ? {
            count: 0,
            resetAt: now + this.#windowMs,
          }
        : entry.value;
      if (current.count >= this.#requests) {
        throw new GatewayRateLimitError(key, current.resetAt, now, this.#requests);
      }
      const next = {
        count: current.count + 1,
        resetAt: current.resetAt,
      };
      const saved = await this.#store.atomic.commit({
        checks: [{ key, ifVersion: expired ? null : entry!.version }],
        writes: [{ key, value: next, ttlMs: Math.max(1, current.resetAt - now) }],
      });
      if (saved !== null) {
        return {
          remaining: this.#requests - next.count,
          resetAt: next.resetAt,
        };
      }
    }
    throw new Error(`AI gateway counter contention for ${key}`);
  }
}
/**
 * Options for `gatewayModel()`.
 */
export interface GatewayModelOptions {
  /** Policy checked before every generation. */
  policy: GatewayPolicy;
  /** Static key or parent-side resolver for the current tenant/API key. */
  key: string | (() => string);
}
/**
 * Wrap a model with per-key gateway policy.
 */
export function gatewayModel(base: Model, options: GatewayModelOptions): Model {
  const key = () => (typeof options.key === 'function' ? options.key() : options.key);
  return {
    id: base.id,
    name: base.name,
    provider: base.provider,
    capabilities: base.capabilities,
    stream(request: GenerateRequest): ModelStream {
      async function* events() {
        await options.policy.acquire(key());
        yield* base.stream(request);
      }
      return new ModelStreamImpl(events());
    },
    async generate(request: GenerateRequest) {
      await options.policy.acquire(key());
      return base.generate(request);
    },
  };
}
/**
 * Options for a child-realm model facade.
 */
export interface ModelFacadeOptions {
  /** Synthetic module specifier imported by the child. */
  specifier: string;
}
/**
 * Expose model generation without exposing the model object or credentials.
 *
 * `resolve` runs in the parent for every call. Return a newly configured model
 * to rotate credentials, or `null` to revoke access immediately.
 */
export function modelFacade(resolve: () => Model | null, options: ModelFacadeOptions): Facade {
  const current = () => {
    const model = resolve();
    if (model === null) throw new Error('Model capability has been revoked');
    return model;
  };
  return new Facade(options.specifier, ['generate'])
    .handle('generate', async (request) => current().generate(request as GenerateRequest))
    .stream('stream', async function* (request) {
      yield* current().stream(request as GenerateRequest);
    });
}
