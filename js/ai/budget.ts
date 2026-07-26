/**
 * fino:ai/budget — enforceable token, cost, and wall-clock limits.
 *
 * A `Budget` is an explicit capability. Create one per run, share one across a
 * durable session, or inject the same instance into every agent for a tenant.
 * Reservations are synchronous and atomic within a realm, so concurrent model
 * calls cannot all spend the same remaining capacity.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { Budget } from 'fino:ai/budget';
 *
 * const tenantBudget = new Budget({
 *   tokens: 100000,
 *   usd: 5,
 *   wallClockMs: 60000,
 *   onExhausted: 'suspend',
 * });
 * const bot = agent({ model, budget: tenantBudget, defaults: { maxTokens: 1000 } });
 * ```
 */
import type { Usage } from 'fino:ai/model';
import { SuspendSignal } from 'fino:ai/tool';
/**
 * Limits enforced by a `Budget`.
 */
export interface BudgetLimits {
  /** Maximum combined input and output tokens. */
  tokens?: number;
  /** Maximum recorded provider cost in US dollars. */
  usd?: number;
  /** Maximum elapsed milliseconds from budget creation. */
  wallClockMs?: number;
}
/**
 * Construction options for a budget.
 */
export interface BudgetOptions extends BudgetLimits {
  /**
   * Exhaustion behavior. `error` throws `BudgetExceededError`; `suspend`
   * throws `SuspendSignal` with a serializable budget snapshot.
   */
  onExhausted?: 'error' | 'suspend';
  /** Deterministic clock hook for tests and virtual schedulers. */
  clock?: () => number;
}
/**
 * Audited increase to an existing budget.
 */
export interface BudgetGrant extends BudgetLimits {
  /** Timestamp at which the grant was applied. */
  grantedAt: number;
  /** Operator or system identity that approved the increase. */
  approvedBy?: string;
  /** Human-readable approval rationale. */
  reason?: string;
}
/**
 * Serializable budget state suitable for durable session metadata.
 */
export interface BudgetSnapshot {
  /** Current ceilings, including approved increases. */
  limits: BudgetLimits;
  /** Exhaustion behavior retained across restore. */
  onExhausted: 'error' | 'suspend';
  /** Budget creation timestamp used for wall-clock enforcement. */
  startedAt: number;
  /** Committed input plus output tokens. */
  usedTokens: number;
  /** Committed provider cost in US dollars. */
  usedUsd: number;
  /** Capacity currently reserved by in-flight calls. */
  reservedTokens: number;
  /** Cost currently reserved by in-flight calls. */
  reservedUsd: number;
  /** Append-only approval history. */
  grants: BudgetGrant[];
}
/**
 * Error thrown when a budget configured with `onExhausted: 'error'` is spent.
 */
export class BudgetExceededError extends Error {
  /** Limit that rejected the operation. */
  readonly limit: 'tokens' | 'usd' | 'wallClockMs';
  /** Durable state at the point of rejection. */
  readonly snapshot: BudgetSnapshot;
  /** Create an exhaustion error. Applications normally receive this from a budget check. */
  constructor(limit: 'tokens' | 'usd' | 'wallClockMs', snapshot: BudgetSnapshot) {
    super(`AI budget exhausted: ${limit}`);
    this.name = 'BudgetExceededError';
    this.limit = limit;
    this.snapshot = snapshot;
  }
}
/**
 * Capacity held for one in-flight model call.
 *
 * Call `commit()` exactly once on a successful provider response or
 * `release()` when the provider fails before reporting usage. Both operations
 * are idempotent.
 */
export class BudgetLease {
  #budget: Budget;
  #tokens: number;
  #usd: number;
  #closed = false;
  /** @internal */
  constructor(budget: Budget, tokens: number, usd: number) {
    this.#budget = budget;
    this.#tokens = tokens;
    this.#usd = usd;
  }
  /**
   * Replace the reservation with actual provider usage and cost.
   */
  commit(usage: Usage, usd = 0): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#budget._settle(this.#tokens, this.#usd, usage, usd);
  }
  /**
   * Return reserved capacity after a provider failure or cancellation.
   */
  release(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#budget._release(this.#tokens, this.#usd);
  }
}
/**
 * Stateful enforcement surface for AI spend.
 */
export class Budget {
  #limits: BudgetLimits;
  #onExhausted: 'error' | 'suspend';
  #clock: () => number;
  #startedAt: number;
  #usedTokens = 0;
  #usedUsd = 0;
  #reservedTokens = 0;
  #reservedUsd = 0;
  #grants: BudgetGrant[] = [];
  /**
   * Create a new unspent budget.
   */
  constructor(options: BudgetOptions) {
    this.#limits = {
      ...(options.tokens === undefined ? {} : { tokens: nonNegative('tokens', options.tokens) }),
      ...(options.usd === undefined ? {} : { usd: nonNegative('usd', options.usd) }),
      ...(options.wallClockMs === undefined
        ? {}
        : { wallClockMs: nonNegative('wallClockMs', options.wallClockMs) }),
    };
    this.#onExhausted = options.onExhausted ?? 'error';
    this.#clock = options.clock ?? Date.now;
    this.#startedAt = this.#clock();
  }
  /**
   * Restore a budget after restart.
   *
   * In-flight reservations are cleared because no provider call survives the
   * process. Committed usage, elapsed-time origin, limits, and grants remain.
   */
  static fromSnapshot(
    snapshot: BudgetSnapshot,
    options: {
      clock?: () => number;
    } = {},
  ): Budget {
    const budget = new Budget({
      ...snapshot.limits,
      onExhausted: snapshot.onExhausted,
      clock: options.clock,
    });
    budget.#startedAt = snapshot.startedAt;
    budget.#usedTokens = snapshot.usedTokens;
    budget.#usedUsd = snapshot.usedUsd;
    budget.#grants = snapshot.grants.map((grant) => ({ ...grant }));
    return budget;
  }
  /**
   * Check committed usage and elapsed time without reserving capacity.
   */
  check(): void {
    if (
      this.#limits.wallClockMs !== undefined &&
      this.#clock() - this.#startedAt > this.#limits.wallClockMs
    ) {
      this.#exhaust('wallClockMs');
    }
    if (
      this.#limits.tokens !== undefined &&
      this.#usedTokens + this.#reservedTokens >= this.#limits.tokens
    ) {
      this.#exhaust('tokens');
    }
    if (this.#limits.usd !== undefined && this.#usedUsd + this.#reservedUsd >= this.#limits.usd) {
      this.#exhaust('usd');
    }
  }
  /**
   * Atomically reserve predicted capacity before a model call.
   */
  reserve(
    predicted: {
      tokens?: number;
      usd?: number;
    } = {},
  ): BudgetLease {
    const tokens = nonNegative('tokens', predicted.tokens ?? 0);
    const usd = nonNegative('usd', predicted.usd ?? 0);
    this.check();
    if (
      this.#limits.tokens !== undefined &&
      this.#usedTokens + this.#reservedTokens + tokens > this.#limits.tokens
    ) {
      this.#exhaust('tokens');
    }
    if (
      this.#limits.usd !== undefined &&
      this.#usedUsd + this.#reservedUsd + usd > this.#limits.usd
    ) {
      this.#exhaust('usd');
    }
    this.#reservedTokens += tokens;
    this.#reservedUsd += usd;
    return new BudgetLease(this, tokens, usd);
  }
  /**
   * Increase ceilings after human or policy approval.
   *
   * The grant is append-only audit data and does not change committed usage.
   */
  grant(
    increase: BudgetLimits,
    audit: {
      approvedBy?: string;
      reason?: string;
    } = {},
  ): BudgetSnapshot {
    const grant: BudgetGrant = {
      ...(increase.tokens === undefined ? {} : { tokens: nonNegative('tokens', increase.tokens) }),
      ...(increase.usd === undefined ? {} : { usd: nonNegative('usd', increase.usd) }),
      ...(increase.wallClockMs === undefined
        ? {}
        : { wallClockMs: nonNegative('wallClockMs', increase.wallClockMs) }),
      grantedAt: this.#clock(),
      ...audit,
    };
    if (grant.tokens !== undefined) this.#limits.tokens = (this.#limits.tokens ?? 0) + grant.tokens;
    if (grant.usd !== undefined) this.#limits.usd = (this.#limits.usd ?? 0) + grant.usd;
    if (grant.wallClockMs !== undefined)
      this.#limits.wallClockMs = (this.#limits.wallClockMs ?? 0) + grant.wallClockMs;
    this.#grants.push(grant);
    return this.snapshot();
  }
  /**
   * Return a detached serializable state snapshot.
   */
  snapshot(): BudgetSnapshot {
    return {
      limits: { ...this.#limits },
      onExhausted: this.#onExhausted,
      startedAt: this.#startedAt,
      usedTokens: this.#usedTokens,
      usedUsd: this.#usedUsd,
      reservedTokens: this.#reservedTokens,
      reservedUsd: this.#reservedUsd,
      grants: this.#grants.map((grant) => ({ ...grant })),
    };
  }
  /** @internal */
  _settle(reservedTokens: number, reservedUsd: number, usage: Usage, usd: number): void {
    this._release(reservedTokens, reservedUsd);
    this.#usedTokens += usage.inputTokens + usage.outputTokens;
    this.#usedUsd += nonNegative('usd', usd);
  }
  /** @internal */
  _release(tokens: number, usd: number): void {
    this.#reservedTokens = Math.max(0, this.#reservedTokens - tokens);
    this.#reservedUsd = Math.max(0, this.#reservedUsd - usd);
  }
  #exhaust(limit: 'tokens' | 'usd' | 'wallClockMs'): never {
    const snapshot = this.snapshot();
    if (this.#onExhausted === 'suspend') {
      throw new SuspendSignal(`AI budget exhausted: ${limit}`, {
        type: 'budget',
        limit,
        budget: snapshot,
      });
    }
    throw new BudgetExceededError(limit, snapshot);
  }
}
function nonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}
