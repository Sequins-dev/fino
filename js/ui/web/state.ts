/**
 * fino:ui/web/state — durable server-driven UI view snapshots.
 *
 * View snapshots are per-view-instance state records. They hold server-owned
 * signal values, the latest rendered-region hashes, idempotency nonces, and a
 * monotonic version used for compare-and-swap saves and SSE reconnects. Stores
 * clone values on input and output so request-local mutation cannot leak across
 * events.
 *
 * ## Storage model
 *
 * A store keeps one current head snapshot per `viewId` plus retained history.
 * `save()` can be guarded with `expectVersion` so concurrent action requests do
 * not silently overwrite each other. A mismatch throws
 * `ViewVersionConflictError`; callers should reload the latest snapshot before
 * retrying.
 *
 * Snapshot `data`, `regions`, and `applied` must be JSON-serializable. Values
 * such as `undefined`, functions, symbols, and cyclic objects are rejected or
 * cannot round-trip through the database store. `sweep()` removes expired
 * heads, and implementations also delete their retained history for those
 * views.
 *
 * `InMemoryViewStore` is process-local and intended for tests or prototypes.
 * `DatabaseViewStore` persists through `fino:database` and creates its tables
 * on `open()`.
 *
 * ## Retention and operations
 *
 * Pass `historyLimit` to either provider to compact each view after a
 * successful save. Omit it to preserve the existing unbounded behavior while
 * application policy is being chosen; production deployments should set an
 * explicit bound. `compact()` can apply a new bound to existing views, while
 * `stats()` reports current head, history, and expired-head counts without
 * exposing provider-specific tables.
 *
 * Database operations on one `DatabaseViewStore` are serialized so concurrent
 * compare-and-swap attempts resolve to one winner and a
 * `ViewVersionConflictError` loser instead of overlapping transactions. Head
 * and history writes remain one transaction, including automatic compaction.
 *
 * ```ts no_run
 * import { DatabaseViewStore, type ViewSnapshot } from 'fino:ui/web/state';
 *
 * const store = await DatabaseViewStore.open('sqlite://ui.db', {
 *   historyLimit: 64,
 * });
 * const now = Date.now();
 *
 * const snapshot: ViewSnapshot = {
 *   viewId: 'todos-1',
 *   view: 'todos',
 *   version: 0,
 *   data: { items: [] },
 *   regions: {},
 *   applied: [],
 *   createdAt: now,
 *   updatedAt: now,
 *   expiresAt: now + 30 * 60_000,
 * };
 *
 * await store.save(snapshot);
 * const head = await store.load('todos-1');
 * ```
 */
import { Database, sql, type DatabaseConnection } from 'fino:database';

/**
 * Durable state for one mounted view instance.
 *
 * `version` is the compare-and-swap token and SSE event id. `data` contains
 * server-owned L2 values, while `regions` stores hashes for the latest rendered
 * HTML per patch target.
 *
 * ## Fields
 *
 * - `viewId` identifies one mounted view instance.
 * - `view` identifies the stable view definition.
 * - `version` advances monotonically and guards concurrent saves.
 * - `sessionId` optionally binds the snapshot to a browser session.
 * - `data` contains server-owned signal values.
 * - `regions` contains render hashes keyed by region element id.
 * - `applied` records recent action nonces for replay protection.
 * - `createdAt`, `updatedAt`, and `expiresAt` are Unix timestamps in
 *   milliseconds.
 */
export interface ViewSnapshot {
  /**
   * Random or keyed view instance id embedded in forms and live channels.
   */
  viewId: string;
  /**
   * Stable view definition id.
   */
  view: string;
  /**
   * Monotonic snapshot version used for compare-and-swap saves and SSE event
   * ids.
   */
  version: number;
  /**
   * Optional owning browser session id.
   */
  sessionId?: string;
  /**
   * JSON-serializable server-owned signal values.
   */
  data: Record<string, unknown>;
  /**
   * Last-rendered HTML hashes keyed by region element id.
   */
  regions: Record<string, string>;
  /**
   * Recent action nonces used to avoid double-submit replays.
   */
  applied: Array<{ rid: string; action: string }>;
  /**
   * Creation time in milliseconds since the Unix epoch.
   */
  createdAt: number;
  /**
   * Last update time in milliseconds since the Unix epoch.
   */
  updatedAt: number;
  /**
   * Expiration time in milliseconds since the Unix epoch.
   */
  expiresAt: number;
}

/**
 * Retention options shared by every view-state provider.
 */
export interface ViewStateStoreOptions {
  /**
   * Maximum history entries retained per mounted view.
   *
   * Omit for unbounded history. `0` retains only the current head.
   */
  historyLimit?: number;
}

/**
 * Provider-independent operational snapshot counts.
 */
export interface ViewStateStoreStats {
  /** Number of current mounted-view heads. */
  heads: number;
  /** Total retained history entries across all views. */
  history: number;
  /** Current heads whose expiration is at or before the requested time. */
  expired: number;
}

/**
 * Storage contract for durable view snapshots.
 *
 * Stores clone snapshots on load and save. `save()` honors `expectVersion` as a
 * compare-and-swap guard and throws `ViewVersionConflictError` on mismatch.
 *
 * ## Methods
 *
 * - `load()` reads the current head snapshot or `null`.
 * - `save()` replaces the head and appends the same snapshot to history.
 * - `history()` returns retained snapshots newest first.
 * - `compact()` bounds retained history for one view.
 * - `delete()` removes the head and retained history.
 * - `sweep()` removes expired heads and returns the number deleted.
 * - `stats()` returns portable operational counts.
 */
export interface ViewStateStore {
  /**
   * Load the current head snapshot for `viewId`.
   *
   * Returns `null` when no snapshot exists. The returned snapshot is detached
   * from store state, so mutating it does not mutate the persisted head.
   */
  load(viewId: string): Promise<ViewSnapshot | null>;
  /**
   * Save a new head snapshot and append it to history.
   *
   * When `opts.expectVersion` is provided, the current head must have exactly
   * that version. Mismatches, including a missing current head, throw
   * `ViewVersionConflictError`.
   */
  save(snapshot: ViewSnapshot, opts?: { expectVersion?: number }): Promise<void>;
  /**
   * Return retained history for `viewId`, newest first.
   *
   * `opts.limit` caps the number of returned snapshots when provided.
   */
  history(viewId: string, opts?: { limit?: number }): Promise<ViewSnapshot[]>;
  /**
   * Retain only the newest `retain` history entries for `viewId`.
   *
   * Returns the number of entries deleted. The current head is unaffected.
   */
  compact(viewId: string, retain: number): Promise<number>;
  /**
   * Delete a snapshot head and its retained history.
   *
   * Unknown view ids are treated as a successful no-op.
   */
  delete(viewId: string): Promise<void>;
  /**
   * Delete expired snapshots and return the number of heads removed.
   *
   * `now` defaults to `Date.now()`. Snapshots with `expiresAt <= now` are
   * expired.
   */
  sweep(now?: number): Promise<number>;
  /**
   * Return current provider-independent head, history, and expiration counts.
   */
  stats(now?: number): Promise<ViewStateStoreStats>;
}

/**
 * Error thrown when a compare-and-swap snapshot save sees a different version.
 *
 * `actual` is `null` when the store has no current head for the view id.
 */
export class ViewVersionConflictError extends Error {
  /**
   * Create a conflict error for a failed `save(..., { expectVersion })`.
   */
  constructor(viewId: string, expected: number, actual: number | null) {
    super(
      `View snapshot version conflict for ${viewId}: expected ${expected}, got ${actual ?? 'missing'}`,
    );
    this.name = 'ViewVersionConflictError';
  }
}

function cloneSnapshot(snapshot: ViewSnapshot): ViewSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ViewSnapshot;
}

function assertJsonRecord(name: string, value: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined)
      throw new TypeError(`View snapshot key "${key}" in ${name} is not JSON-serializable`);
    try {
      const encoded = JSON.stringify(entry);
      if (encoded === undefined) throw new TypeError();
      JSON.parse(encoded);
    } catch {
      throw new TypeError(`View snapshot key "${key}" in ${name} is not JSON-serializable`);
    }
  }
}

function validate(snapshot: ViewSnapshot): ViewSnapshot {
  assertJsonRecord('data', snapshot.data);
  assertJsonRecord('regions', snapshot.regions);
  JSON.stringify(snapshot.applied);
  return cloneSnapshot(snapshot);
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function historyLimit(options: ViewStateStoreOptions): number | undefined {
  return options.historyLimit === undefined
    ? undefined
    : nonNegativeInteger(options.historyLimit, 'historyLimit');
}

function queryLimit(value: number | undefined): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, 'limit');
}

/**
 * In-memory view snapshot store for tests and single-process prototypes.
 *
 * Snapshots live only in this JavaScript process. The store still clones on
 * load/save, appends history, validates JSON-serializable snapshot fields, and
 * enforces `expectVersion` the same way as `DatabaseViewStore`.
 */
export class InMemoryViewStore implements ViewStateStore {
  #heads = new Map<string, ViewSnapshot>();
  #history = new Map<string, ViewSnapshot[]>();
  #historyLimit: number | undefined;

  /**
   * Create an in-memory store with optional bounded per-view history.
   */
  constructor(options: ViewStateStoreOptions = {}) {
    this.#historyLimit = historyLimit(options);
  }

  /**
   * Load the current in-memory head snapshot for `viewId`, or `null`.
   */
  async load(viewId: string): Promise<ViewSnapshot | null> {
    const snap = this.#heads.get(viewId);
    return snap ? cloneSnapshot(snap) : null;
  }

  /**
   * Save an in-memory head snapshot and prepend it to retained history.
   *
   * `opts.expectVersion`, when provided, must match the current head version.
   * The snapshot is validated for JSON-compatible `data`, `regions`, and
   * `applied` values before storage.
   */
  async save(snapshot: ViewSnapshot, opts: { expectVersion?: number } = {}): Promise<void> {
    const current = this.#heads.get(snapshot.viewId);
    if (opts.expectVersion !== undefined && current?.version !== opts.expectVersion) {
      throw new ViewVersionConflictError(
        snapshot.viewId,
        opts.expectVersion,
        current?.version ?? null,
      );
    }
    const next = validate(snapshot);
    this.#heads.set(next.viewId, next);
    const history = this.#history.get(next.viewId) ?? [];
    history.unshift(cloneSnapshot(next));
    if (this.#historyLimit !== undefined)
      history.length = Math.min(history.length, this.#historyLimit);
    this.#history.set(next.viewId, history);
  }

  /**
   * Return retained in-memory history for `viewId`, newest first.
   */
  async history(viewId: string, opts: { limit?: number } = {}): Promise<ViewSnapshot[]> {
    const entries = this.#history.get(viewId) ?? [];
    return entries.slice(0, queryLimit(opts.limit)).map(cloneSnapshot);
  }

  /**
   * Compact one in-memory view history to its newest `retain` entries.
   */
  async compact(viewId: string, retain: number): Promise<number> {
    nonNegativeInteger(retain, 'retain');
    const entries = this.#history.get(viewId) ?? [];
    const deleted = Math.max(0, entries.length - retain);
    entries.length = Math.min(entries.length, retain);
    if (entries.length === 0) this.#history.delete(viewId);
    return deleted;
  }

  /**
   * Delete an in-memory head snapshot and all retained history for `viewId`.
   */
  async delete(viewId: string): Promise<void> {
    this.#heads.delete(viewId);
    this.#history.delete(viewId);
  }

  /**
   * Delete expired in-memory heads and return the number removed.
   */
  async sweep(now: number = Date.now()): Promise<number> {
    let deleted = 0;
    for (const [viewId, snap] of this.#heads) {
      if (snap.expiresAt > now) continue;
      await this.delete(viewId);
      deleted++;
    }
    return deleted;
  }

  /**
   * Return current in-memory head, history, and expiration counts.
   */
  async stats(now: number = Date.now()): Promise<ViewStateStoreStats> {
    let history = 0;
    let expired = 0;
    for (const entries of this.#history.values()) history += entries.length;
    for (const snapshot of this.#heads.values()) {
      if (snapshot.expiresAt <= now) expired++;
    }
    return {
      heads: this.#heads.size,
      history,
      expired,
    };
  }
}

/**
 * Database-backed view snapshot store.
 *
 * `open()` accepts the same target strings as `Database.open()`, including
 * SQLite paths and future generic database targets.
 *
 * The store writes the current head to `ui_view_snapshots` and appends each
 * saved version to `ui_view_snapshot_history`. `save()` runs in a transaction
 * so the head and history stay consistent.
 */
export class DatabaseViewStore implements ViewStateStore {
  #db: DatabaseConnection;
  #historyLimit: number | undefined;
  #operations: Promise<void> = Promise.resolve();

  private constructor(db: DatabaseConnection, options: ViewStateStoreOptions) {
    this.#db = db;
    this.#historyLimit = historyLimit(options);
  }

  /**
   * Open a database-backed view store and create required tables.
   *
   * `target` is passed to `Database.open()`, so values such as `:memory:`,
   * `sqlite://path/to/ui.db`, or other supported database targets are accepted.
   * `opts.fs` is forwarded for filesystem-backed database providers.
   */
  static async open(
    target: string,
    opts: ViewStateStoreOptions & { fs?: object } = {},
  ): Promise<DatabaseViewStore> {
    historyLimit(opts);
    const db = await Database.open(target, { fs: opts?.fs as never });
    await db.exec(`CREATE TABLE IF NOT EXISTS ui_view_snapshots (
      view_id TEXT PRIMARY KEY,
      view TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS ui_view_snapshot_history (
      view_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(view_id, version)
    )`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ui_view_snapshots_expires ON ui_view_snapshots(expires_at)`,
    );
    return new DatabaseViewStore(db, opts);
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #load(viewId: string): Promise<ViewSnapshot | null> {
    const stmt = this.#db.prepare(
      sql`SELECT snapshot FROM ui_view_snapshots WHERE view_id = ${viewId}`,
    );
    try {
      const row = await stmt.get();
      return row ? (JSON.parse(row.snapshot as string) as ViewSnapshot) : null;
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Load the current database head snapshot for `viewId`, or `null`.
   */
  async load(viewId: string): Promise<ViewSnapshot | null> {
    return this.#run(() => this.#load(viewId));
  }

  /**
   * Save a database head snapshot and append it to history in one transaction.
   *
   * `opts.expectVersion`, when provided, must match the currently loaded head
   * version. The snapshot is validated before any database writes occur.
   */
  async save(snapshot: ViewSnapshot, opts: { expectVersion?: number } = {}): Promise<void> {
    const next = validate(snapshot);
    await this.#run(() =>
      this.#db.transaction(async () => {
        const current = await this.#load(next.viewId);
        if (opts.expectVersion !== undefined && current?.version !== opts.expectVersion) {
          throw new ViewVersionConflictError(
            next.viewId,
            opts.expectVersion,
            current?.version ?? null,
          );
        }
        const encoded = JSON.stringify(next);
        const head = this.#db
          .prepare(sql`INSERT INTO ui_view_snapshots(view_id, view, version, snapshot, expires_at, updated_at)
        VALUES(${next.viewId}, ${next.view}, ${next.version}, ${encoded}, ${next.expiresAt}, ${next.updatedAt})
        ON CONFLICT(view_id) DO UPDATE SET
          view = excluded.view,
          version = excluded.version,
          snapshot = excluded.snapshot,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`);
        try {
          await head.run();
        } finally {
          head.finalize();
        }
        const hist = this.#db
          .prepare(sql`INSERT OR REPLACE INTO ui_view_snapshot_history(view_id, version, snapshot, updated_at)
        VALUES(${next.viewId}, ${next.version}, ${encoded}, ${next.updatedAt})`);
        try {
          await hist.run();
        } finally {
          hist.finalize();
        }
        if (this.#historyLimit !== undefined) await this.#compact(next.viewId, this.#historyLimit);
      }),
    );
  }

  async #history(viewId: string, limit: number | undefined): Promise<ViewSnapshot[]> {
    let query = sql`SELECT snapshot FROM ui_view_snapshot_history WHERE view_id = ${viewId} ORDER BY version DESC`;
    if (limit !== undefined) query = sql`${query} LIMIT ${limit}`;
    const stmt = this.#db.prepare(query);
    try {
      const rows = await stmt.all();
      return rows.map((row) => JSON.parse(row.snapshot as string) as ViewSnapshot);
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Return retained database history for `viewId`, newest first.
   */
  async history(viewId: string, opts: { limit?: number } = {}): Promise<ViewSnapshot[]> {
    const limit = queryLimit(opts.limit);
    return this.#run(() => this.#history(viewId, limit));
  }

  async #compact(viewId: string, retain: number): Promise<number> {
    const stmt = this.#db.prepare(
      sql`DELETE FROM ui_view_snapshot_history
        WHERE view_id = ${viewId}
          AND version NOT IN (
            SELECT version
            FROM ui_view_snapshot_history
            WHERE view_id = ${viewId}
            ORDER BY version DESC
            LIMIT ${retain}
          )`,
    );
    try {
      return (await stmt.run()).changes;
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Compact one database view history to its newest `retain` entries.
   */
  async compact(viewId: string, retain: number): Promise<number> {
    nonNegativeInteger(retain, 'retain');
    return this.#run(() => this.#compact(viewId, retain));
  }

  async #delete(viewId: string): Promise<void> {
    const head = this.#db.prepare(sql`DELETE FROM ui_view_snapshots WHERE view_id = ${viewId}`);
    try {
      await head.run();
    } finally {
      head.finalize();
    }
    const hist = this.#db.prepare(
      sql`DELETE FROM ui_view_snapshot_history WHERE view_id = ${viewId}`,
    );
    try {
      await hist.run();
    } finally {
      hist.finalize();
    }
  }

  /**
   * Delete a database head snapshot and all retained history for `viewId`.
   */
  async delete(viewId: string): Promise<void> {
    await this.#run(() => this.#db.transaction(() => this.#delete(viewId)));
  }

  /**
   * Delete expired database heads and return the number removed.
   *
   * Each expired view is deleted through `delete()`, so retained history is
   * removed with the head snapshot.
   */
  async sweep(now: number = Date.now()): Promise<number> {
    return this.#run(() =>
      this.#db.transaction(async () => {
        const expired = this.#db.prepare(
          sql`SELECT view_id FROM ui_view_snapshots WHERE expires_at <= ${now}`,
        );
        try {
          const rows = await expired.all();
          for (const row of rows) await this.#delete(row.view_id as string);
          return rows.length;
        } finally {
          expired.finalize();
        }
      }),
    );
  }

  /**
   * Return current database head, history, and expiration counts.
   */
  async stats(now: number = Date.now()): Promise<ViewStateStoreStats> {
    return this.#run(async () => {
      const stmt = this.#db.prepare(
        sql`SELECT
          (SELECT COUNT(*) FROM ui_view_snapshots) AS heads,
          (SELECT COUNT(*) FROM ui_view_snapshot_history) AS history,
          (SELECT COUNT(*) FROM ui_view_snapshots WHERE expires_at <= ${now}) AS expired`,
      );
      try {
        const row = await stmt.get();
        return {
          heads: Number(row?.heads ?? 0),
          history: Number(row?.history ?? 0),
          expired: Number(row?.expired ?? 0),
        };
      } finally {
        stmt.finalize();
      }
    });
  }

  /**
   * Close the underlying database connection.
   */
  async close(): Promise<void> {
    await this.#run(() => this.#db.close());
  }

  /**
   * Dispose the underlying database connection when used with `await using`.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
