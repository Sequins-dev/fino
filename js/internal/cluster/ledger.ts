/**
 * internal:cluster/ledger — durable workload records for the control plane.
 *
 * The ledger is what makes a workload survive the loss of the only node
 * processing it. A record is committed here *before* its spawn is
 * acknowledged, so a crash can never leave work that nothing remembers: the
 * dead node's lease expires, the record returns to the unclaimed pool, and
 * reconciliation grants it elsewhere.
 *
 * Ownership is a lease — `{ nodeId, incarnation, expiresAt }` — rather than a
 * durable assignment, because a node that stops renewing is indistinguishable
 * from one that died. Transfers are fenced by an assignment epoch that
 * increments on every ownership change, so a grant computed against a stale
 * view is rejected instead of duplicating work.
 *
 * This is the single-leader form (SQLite on the leader). The record shape is
 * chosen so the same rows can later become entries in a quorum-replicated log
 * without changing callers.
 *
 * @internal
 */
import { Database, type DatabaseConnection, type DbValue } from 'fino:database';

/** Lifecycle of one workload record. */
export type WorkloadState =
  /** No node owns it; the next eligible claimant may take it. */
  | 'unclaimed'
  /** Leased to a node that has not yet reported initialization. */
  | 'claimed'
  /** Isolate initialized: pinned to its owner until it exits or drains. */
  | 'initialized'
  /** Finished; retained briefly for observability. */
  | 'settled';

/** One durable workload record. */
export interface WorkloadRecord {
  /** Cluster-unique workload id (`{nodeId}/{handle}` shape). */
  id: string;
  /** Serialized realm configuration — the movable, replicable unit. */
  spec: string;
  state: WorkloadState;
  /** Current owner, or null while unclaimed. */
  owner: string | null;
  /** Owner's process incarnation, fencing grants against a restarted node. */
  ownerIncarnation: number | null;
  /** Lease deadline in epoch ms; past-due leases are reclaimable. */
  leaseExpiresAt: number | null;
  /** Increments on every ownership change; stale-epoch writes are refused. */
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

function rowToRecord(row: Record<string, DbValue>): WorkloadRecord {
  return {
    id: String(row.id),
    spec: String(row.spec),
    state: String(row.state) as WorkloadState,
    owner: row.owner === null ? null : String(row.owner),
    ownerIncarnation: row.owner_incarnation === null ? null : Number(row.owner_incarnation),
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    epoch: Number(row.epoch),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Durable store of workload records held by the control-plane leader. */
export class WorkloadLedger {
  #db: DatabaseConnection;

  private constructor(db: DatabaseConnection) {
    this.#db = db;
  }

  /** Open (creating and migrating) a ledger at `path`. */
  static async open(path: string): Promise<WorkloadLedger> {
    const db = await Database.open(path);
    if (db.driver === 'sqlite') {
      // No WAL: multi-connection WAL needs VFS shared memory the JS VFS does
      // not provide (same constraint as the jobs store).
      await db.exec('PRAGMA journal_mode=TRUNCATE');
      await db.exec('PRAGMA busy_timeout=5000');
      await db.exec('PRAGMA synchronous=NORMAL');
    }
    await db.exec(`CREATE TABLE IF NOT EXISTS workloads (
        id                TEXT PRIMARY KEY,
        spec              TEXT NOT NULL,
        state             TEXT NOT NULL,
        owner             TEXT,
        owner_incarnation BIGINT,
        lease_expires_at  BIGINT,
        epoch             INTEGER NOT NULL DEFAULT 0,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL
      )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_workloads_state ON workloads(state)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_workloads_lease ON workloads(lease_expires_at)');
    return new WorkloadLedger(db);
  }

  /**
   * Commit a workload record. Call this before acknowledging the spawn — that
   * ordering is the whole guarantee.
   */
  async commit(id: string, spec: string, now = Date.now()): Promise<WorkloadRecord> {
    const stmt = this.#db.prepare(
      `INSERT INTO workloads (id, spec, state, owner, owner_incarnation, lease_expires_at, epoch, created_at, updated_at)
       VALUES (:id, :spec, 'unclaimed', NULL, NULL, NULL, 0, :now, :now)
       ON CONFLICT(id) DO UPDATE SET spec = :spec, updated_at = :now`,
    );
    try {
      await stmt.run({ id, spec, now });
    } finally {
      stmt.finalize();
    }
    return (await this.get(id))!;
  }

  /** Read one record, or null when it is not in the ledger. */
  async get(id: string): Promise<WorkloadRecord | null> {
    const stmt = this.#db.prepare('SELECT * FROM workloads WHERE id = :id');
    try {
      const row = await stmt.get({ id });
      return row === undefined || row === null ? null : rowToRecord(row);
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Grant ownership of an unclaimed (or lease-expired) record to a node.
   *
   * Returns the updated record, or null when another claimant won the race or
   * the caller's `expectEpoch` is stale — the caller must then re-read rather
   * than assume ownership.
   */
  async claim(
    id: string,
    owner: string,
    incarnation: number,
    leaseMs: number,
    options: { expectEpoch?: number; now?: number } = {},
  ): Promise<WorkloadRecord | null> {
    const now = options.now ?? Date.now();
    const expiresAt = now + leaseMs;
    const epochGuard = options.expectEpoch === undefined ? '' : ' AND epoch = :expectEpoch';
    const stmt = this.#db.prepare(
      `UPDATE workloads SET
         state = 'claimed',
         owner = :owner,
         owner_incarnation = :incarnation,
         lease_expires_at = :expiresAt,
         epoch = epoch + 1,
         updated_at = :now
       WHERE id = :id
         AND state IN ('unclaimed', 'claimed')
         AND (owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= :now OR owner = :owner)
         ${epochGuard}`,
    );
    try {
      await stmt.run({
        id,
        owner,
        incarnation,
        expiresAt,
        now,
        ...(options.expectEpoch === undefined ? {} : { expectEpoch: options.expectEpoch }),
      });
    } finally {
      stmt.finalize();
    }
    const record = await this.get(id);
    if (record === null || record.owner !== owner) return null;
    return record;
  }

  /**
   * Extend every lease one owner holds — the heartbeat path. One statement,
   * so a beat's cost does not grow with the node's workload count.
   */
  async renewAll(owner: string, incarnation: number, leaseMs: number, now = Date.now()): Promise<void> {
    const stmt = this.#db.prepare(
      `UPDATE workloads SET lease_expires_at = :expiresAt, updated_at = :now
       WHERE owner = :owner AND owner_incarnation = :incarnation
         AND state IN ('claimed', 'initialized')`,
    );
    try {
      await stmt.run({ owner, incarnation, expiresAt: now + leaseMs, now });
    } finally {
      stmt.finalize();
    }
  }

  /** Extend the current owner's lease. Fails (null) if ownership moved. */
  async renew(
    id: string,
    owner: string,
    incarnation: number,
    leaseMs: number,
    now = Date.now(),
  ): Promise<WorkloadRecord | null> {
    const stmt = this.#db.prepare(
      `UPDATE workloads SET lease_expires_at = :expiresAt, updated_at = :now
       WHERE id = :id AND owner = :owner AND owner_incarnation = :incarnation`,
    );
    try {
      await stmt.run({ id, owner, incarnation, expiresAt: now + leaseMs, now });
    } finally {
      stmt.finalize();
    }
    const record = await this.get(id);
    if (record === null || record.owner !== owner) return null;
    return record;
  }

  /**
   * Mark a claimed record initialized: its isolate now exists, so it is
   * pinned to this owner and can no longer be re-granted elsewhere while the
   * owner lives.
   */
  async markInitialized(
    id: string,
    owner: string,
    incarnation: number,
    now = Date.now(),
  ): Promise<WorkloadRecord | null> {
    const stmt = this.#db.prepare(
      `UPDATE workloads SET state = 'initialized', updated_at = :now
       WHERE id = :id AND owner = :owner AND owner_incarnation = :incarnation AND state = 'claimed'`,
    );
    try {
      await stmt.run({ id, owner, incarnation, now });
    } finally {
      stmt.finalize();
    }
    const record = await this.get(id);
    return record !== null && record.state === 'initialized' ? record : null;
  }

  /**
   * Release a record back to the unclaimed pool — the shed path, and the
   * drain path. Bumps the epoch so in-flight grants against the old view are
   * refused.
   */
  async release(id: string, owner: string, now = Date.now()): Promise<WorkloadRecord | null> {
    const stmt = this.#db.prepare(
      `UPDATE workloads SET
         state = 'unclaimed', owner = NULL, owner_incarnation = NULL,
         lease_expires_at = NULL, epoch = epoch + 1, updated_at = :now
       WHERE id = :id AND owner = :owner`,
    );
    try {
      await stmt.run({ id, owner, now });
    } finally {
      stmt.finalize();
    }
    return this.get(id);
  }

  /** Record a workload as finished. */
  async settle(id: string, now = Date.now()): Promise<void> {
    const stmt = this.#db.prepare(
      `UPDATE workloads SET state = 'settled', owner = NULL, owner_incarnation = NULL,
         lease_expires_at = NULL, updated_at = :now WHERE id = :id`,
    );
    try {
      await stmt.run({ id, now });
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Return every record whose lease has expired to the unclaimed pool and
   * report them. This is the crash-recovery path: a node that stopped
   * renewing loses its workloads to whoever claims them next.
   */
  async sweepExpired(now = Date.now()): Promise<WorkloadRecord[]> {
    const select = this.#db.prepare(
      `SELECT * FROM workloads
       WHERE state IN ('claimed', 'initialized')
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= :now`,
    );
    let rows: Record<string, DbValue>[];
    try {
      rows = await select.all({ now });
    } finally {
      select.finalize();
    }
    if (rows.length === 0) return [];
    const update = this.#db.prepare(
      `UPDATE workloads SET
         state = 'unclaimed', owner = NULL, owner_incarnation = NULL,
         lease_expires_at = NULL, epoch = epoch + 1, updated_at = :now
       WHERE id = :id`,
    );
    try {
      for (const row of rows) await update.run({ id: String(row.id), now });
    } finally {
      update.finalize();
    }
    const reclaimed: WorkloadRecord[] = [];
    for (const row of rows) {
      const record = await this.get(String(row.id));
      if (record !== null) reclaimed.push(record);
    }
    return reclaimed;
  }

  /**
   * Records eligible for granting: unclaimed, or claimed with an expired
   * lease. On leader restart this is exactly the set to re-offer.
   */
  async grantable(now = Date.now(), limit = 100): Promise<WorkloadRecord[]> {
    const stmt = this.#db.prepare(
      `SELECT * FROM workloads
       WHERE state = 'unclaimed'
          OR (state IN ('claimed', 'initialized') AND lease_expires_at IS NOT NULL AND lease_expires_at <= :now)
       ORDER BY created_at ASC LIMIT :limit`,
    );
    try {
      const rows = await stmt.all({ now, limit });
      return rows.map(rowToRecord);
    } finally {
      stmt.finalize();
    }
  }

  /** Every record owned by one node — the drain and node-loss working set. */
  async ownedBy(owner: string): Promise<WorkloadRecord[]> {
    const stmt = this.#db.prepare(
      `SELECT * FROM workloads WHERE owner = :owner ORDER BY created_at ASC`,
    );
    try {
      const rows = await stmt.all({ owner });
      return rows.map(rowToRecord);
    } finally {
      stmt.finalize();
    }
  }

  /** Close the underlying database. */
  async close(): Promise<void> {
    await this.#db.close();
  }
}
