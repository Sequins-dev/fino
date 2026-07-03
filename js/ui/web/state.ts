/**
* fino:ui/web/state — durable server-driven UI view snapshots.
*
* View snapshots are per-view-instance state records. They hold server-owned
* signal values, the latest rendered-region hashes, idempotency nonces, and a
* monotonic version used for compare-and-swap saves and SSE reconnects. Stores
* clone values on input and output so request-local mutation cannot leak across
* events.
*
* ```ts no_run
* import { DatabaseViewStore } from 'fino:ui/web/state';
*
* const store = await DatabaseViewStore.open('sqlite://ui.db');
* const snap = await store.load(viewId);
* ```
*/
import { Database, sql, type DatabaseConnection } from 'fino:database';

/**
* Durable state for one mounted view instance.
*
* `version` is the compare-and-swap token and SSE event id. `data` contains
* server-owned L2 values, while `regions` stores hashes for the latest rendered
* HTML per patch target.
*/
export interface ViewSnapshot {
  /** Random or keyed view instance id embedded in forms and live channels. */
  viewId: string;
  /** Stable view definition id. */
  view: string;
  /** Monotonic snapshot version. */
  version: number;
  /** Optional owning browser session id. */
  sessionId?: string;
  /** JSON-serializable server-owned signal values. */
  data: Record<string, unknown>;
  /** Last-rendered HTML hashes keyed by region element id. */
  regions: Record<string, string>;
  /** Recent action nonces used to avoid double-submit replays. */
  applied: Array<{ rid: string; action: string }>;
  /** Creation time in milliseconds since the Unix epoch. */
  createdAt: number;
  /** Last update time in milliseconds since the Unix epoch. */
  updatedAt: number;
  /** Expiration time in milliseconds since the Unix epoch. */
  expiresAt: number;
}

/**
* Storage contract for durable view snapshots.
*
* Stores clone snapshots on load and save. `save()` honors `expectVersion` as a
* compare-and-swap guard and throws `ViewVersionConflictError` on mismatch.
*/
export interface ViewStateStore {
  /** Load the current head snapshot for `viewId`, or `null` when absent. */
  load(viewId: string): Promise<ViewSnapshot | null>;
  /** Save a new head snapshot and append it to history. */
  save(snapshot: ViewSnapshot, opts?: { expectVersion?: number }): Promise<void>;
  /** Return retained history newest first. */
  history(viewId: string, opts?: { limit?: number }): Promise<ViewSnapshot[]>;
  /** Delete a snapshot head and its retained history. */
  delete(viewId: string): Promise<void>;
  /** Delete expired snapshots and return the number of heads removed. */
  sweep(now?: number): Promise<number>;
}

/**
* Error thrown when a compare-and-swap snapshot save sees a different version.
*/
export class ViewVersionConflictError extends Error {
  constructor(viewId: string, expected: number, actual: number | null) {
    super(`View snapshot version conflict for ${viewId}: expected ${expected}, got ${actual ?? 'missing'}`);
    this.name = 'ViewVersionConflictError';
  }
}

function cloneSnapshot(snapshot: ViewSnapshot): ViewSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ViewSnapshot;
}

function assertJsonRecord(name: string, value: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) throw new TypeError(`View snapshot key "${key}" in ${name} is not JSON-serializable`);
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

/**
* In-memory view snapshot store for tests and single-process prototypes.
*/
export class InMemoryViewStore implements ViewStateStore {
  #heads = new Map<string, ViewSnapshot>();
  #history = new Map<string, ViewSnapshot[]>();

  async load(viewId: string): Promise<ViewSnapshot | null> {
    const snap = this.#heads.get(viewId);
    return snap ? cloneSnapshot(snap) : null;
  }

  async save(snapshot: ViewSnapshot, opts: { expectVersion?: number } = {}): Promise<void> {
    const current = this.#heads.get(snapshot.viewId);
    if (opts.expectVersion !== undefined && current?.version !== opts.expectVersion) {
      throw new ViewVersionConflictError(snapshot.viewId, opts.expectVersion, current?.version ?? null);
    }
    const next = validate(snapshot);
    this.#heads.set(next.viewId, next);
    const history = this.#history.get(next.viewId) ?? [];
    history.unshift(cloneSnapshot(next));
    this.#history.set(next.viewId, history);
  }

  async history(viewId: string, opts: { limit?: number } = {}): Promise<ViewSnapshot[]> {
    const entries = this.#history.get(viewId) ?? [];
    return entries.slice(0, opts.limit).map(cloneSnapshot);
  }

  async delete(viewId: string): Promise<void> {
    this.#heads.delete(viewId);
    this.#history.delete(viewId);
  }

  async sweep(now: number = Date.now()): Promise<number> {
    let deleted = 0;
    for (const [viewId, snap] of this.#heads) {
      if (snap.expiresAt > now) continue;
      await this.delete(viewId);
      deleted++;
    }
    return deleted;
  }
}

/**
* Database-backed view snapshot store.
*
* `open()` accepts the same target strings as `Database.open()`, including
* SQLite paths and future generic database targets.
*/
export class DatabaseViewStore implements ViewStateStore {
  #db: DatabaseConnection;

  private constructor(db: DatabaseConnection) {
    this.#db = db;
  }

  static async open(target: string, opts?: { fs?: object }): Promise<DatabaseViewStore> {
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
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_ui_view_snapshots_expires ON ui_view_snapshots(expires_at)`);
    return new DatabaseViewStore(db);
  }

  async load(viewId: string): Promise<ViewSnapshot | null> {
    const stmt = this.#db.prepare(sql`SELECT snapshot FROM ui_view_snapshots WHERE view_id = ${viewId}`);
    try {
      const row = await stmt.get();
      return row ? JSON.parse(row.snapshot as string) as ViewSnapshot : null;
    } finally {
      stmt.finalize();
    }
  }

  async save(snapshot: ViewSnapshot, opts: { expectVersion?: number } = {}): Promise<void> {
    const next = validate(snapshot);
    await this.#db.transaction(async () => {
      const current = await this.load(next.viewId);
      if (opts.expectVersion !== undefined && current?.version !== opts.expectVersion) {
        throw new ViewVersionConflictError(next.viewId, opts.expectVersion, current?.version ?? null);
      }
      const encoded = JSON.stringify(next);
      const head = this.#db.prepare(sql`INSERT INTO ui_view_snapshots(view_id, view, version, snapshot, expires_at, updated_at)
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
      const hist = this.#db.prepare(sql`INSERT OR REPLACE INTO ui_view_snapshot_history(view_id, version, snapshot, updated_at)
        VALUES(${next.viewId}, ${next.version}, ${encoded}, ${next.updatedAt})`);
      try {
        await hist.run();
      } finally {
        hist.finalize();
      }
    });
  }

  async history(viewId: string, opts: { limit?: number } = {}): Promise<ViewSnapshot[]> {
    let query = sql`SELECT snapshot FROM ui_view_snapshot_history WHERE view_id = ${viewId} ORDER BY version DESC`;
    if (opts.limit !== undefined) query = sql`${query} LIMIT ${Math.floor(opts.limit)}`;
    const stmt = this.#db.prepare(query);
    try {
      const rows = await stmt.all();
      return rows.map((row) => JSON.parse(row.snapshot as string) as ViewSnapshot);
    } finally {
      stmt.finalize();
    }
  }

  async delete(viewId: string): Promise<void> {
    await this.#db.transaction(async () => {
      const head = this.#db.prepare(sql`DELETE FROM ui_view_snapshots WHERE view_id = ${viewId}`);
      try {
        await head.run();
      } finally {
        head.finalize();
      }
      const hist = this.#db.prepare(sql`DELETE FROM ui_view_snapshot_history WHERE view_id = ${viewId}`);
      try {
        await hist.run();
      } finally {
        hist.finalize();
      }
    });
  }

  async sweep(now: number = Date.now()): Promise<number> {
    const expired = this.#db.prepare(sql`SELECT view_id FROM ui_view_snapshots WHERE expires_at <= ${now}`);
    try {
      const rows = await expired.all();
      for (const row of rows) await this.delete(row.view_id as string);
      return rows.length;
    } finally {
      expired.finalize();
    }
  }

  async close(): Promise<void> {
    await this.#db.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
