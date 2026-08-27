/**
 * fino:ui/web/state — view-snapshot codecs over a generic atomic store.
 *
 * Applications pass the same `AtomicStore` used by other subsystems. These
 * functions own only the UI record layout: one current head per `viewId`,
 * retained history, JSON validation, optimistic saves, and expiry sweeps. The
 * store provider owns memory, persistence, serialization, and lifecycle.
 *
 * Snapshot values are cloned at this domain boundary, so request-local
 * mutation cannot leak through providers such as `memoryStore()` that retain
 * values by reference. `saveViewState()` can require the current snapshot
 * version and throws `ViewVersionConflictError` on mismatch.
 *
 * ```ts no_run
 * import { sqliteStore } from 'fino:store';
 * import { loadViewState, saveViewState } from 'fino:ui/web/state';
 *
 * const store = await sqliteStore({ path: './ui.db' });
 * await saveViewState(store, {
 *   viewId: 'todos-1', view: 'todos', version: 0,
 *   data: { items: [] }, regions: {}, applied: [],
 *   createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60_000,
 * });
 * const head = await loadViewState(store, 'todos-1');
 * ```
 */
import type { AtomicStore } from 'fino:store';

/** Durable state for one mounted view instance. */
export interface ViewSnapshot {
  /** Random or keyed view instance id embedded in forms and live channels. */
  viewId: string;
  /** Stable view definition id. */
  view: string;
  /** Monotonic application-level version and SSE event id. */
  version: number;
  /** Optional owning browser session id. */
  sessionId?: string;
  /** JSON-serializable server-owned signal values. */
  data: Record<string, unknown>;
  /** Last-rendered HTML hashes keyed by region element id. */
  regions: Record<string, string>;
  /** Recent action nonces used to avoid double-submit replays. */
  applied: Array<{ rid: string; action: string }>;
  /** Creation time in Unix milliseconds. */
  createdAt: number;
  /** Last update time in Unix milliseconds. */
  updatedAt: number;
  /** Expiration time in Unix milliseconds. */
  expiresAt: number;
}

/** Error raised when a guarded snapshot save observes another version. */
export class ViewVersionConflictError extends Error {
  /** Create a conflict describing expected and observed application versions. */
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

const VIEW_HEAD_PREFIX = 'head/';
const VIEW_HISTORY_PREFIX = 'history/';

function viewPart(viewId: string): string {
  return encodeURIComponent(viewId);
}

function viewHeadKey(viewId: string): string {
  return `${VIEW_HEAD_PREFIX}${viewPart(viewId)}`;
}

function viewHistoryPrefix(viewId: string): string {
  return `${VIEW_HISTORY_PREFIX}${viewPart(viewId)}/`;
}

function viewHistoryKey(snapshot: ViewSnapshot): string {
  return `${viewHistoryPrefix(snapshot.viewId)}${snapshot.version}`;
}

function stateStore(store: AtomicStore): AtomicStore {
  return store.namespace('fino:ui/web/state:v1');
}

/** Load a detached view head, or `null` when it is absent. */
export async function loadViewState(
  store: AtomicStore,
  viewId: string,
): Promise<ViewSnapshot | null> {
  const snapshot = await stateStore(store).get<ViewSnapshot>(viewHeadKey(viewId));
  return snapshot ? cloneSnapshot(snapshot) : null;
}

/** Atomically replace a view head and append the same snapshot to history. */
export async function saveViewState(
  store: AtomicStore,
  snapshot: ViewSnapshot,
  options: { expectVersion?: number } = {},
): Promise<void> {
  const values = stateStore(store);
  const next = validate(snapshot);
  const key = viewHeadKey(next.viewId);
  for (;;) {
    const current = await values.atomic.getEntry<ViewSnapshot>(key);
    if (options.expectVersion !== undefined && current?.value.version !== options.expectVersion) {
      throw new ViewVersionConflictError(
        next.viewId,
        options.expectVersion,
        current?.value.version ?? null,
      );
    }
    const committed = await values.atomic.commit({
      checks: [{ key, ifVersion: current?.version ?? null }],
      writes: [
        { key, value: next },
        { key: viewHistoryKey(next), value: next },
      ],
    });
    if (committed) return;
  }
}

/** Return retained snapshots newest first, optionally limited. */
export async function viewStateHistory(
  store: AtomicStore,
  viewId: string,
  options: { limit?: number } = {},
): Promise<ViewSnapshot[]> {
  const snapshots = (
    await stateStore(store).list<ViewSnapshot>({ prefix: viewHistoryPrefix(viewId) })
  )
    .map((entry) => cloneSnapshot(entry.value))
    .sort((a, b) => b.version - a.version || b.updatedAt - a.updatedAt);
  return options.limit === undefined ? snapshots : snapshots.slice(0, options.limit);
}

async function deleteVersion(
  store: AtomicStore,
  viewId: string,
  version: string,
): Promise<boolean> {
  const key = viewHeadKey(viewId);
  const history = await store.list({ prefix: viewHistoryPrefix(viewId) });
  return (
    (await store.atomic.commit({
      checks: [{ key, ifVersion: version }],
      deletes: [key, ...history.map((entry) => entry.key)],
    })) !== null
  );
}

/** Delete a view head and all retained history. */
export async function deleteViewState(store: AtomicStore, viewId: string): Promise<void> {
  const values = stateStore(store);
  const key = viewHeadKey(viewId);
  for (;;) {
    const current = await values.atomic.getEntry(key);
    if (!current) {
      const history = await values.list({ prefix: viewHistoryPrefix(viewId) });
      if (history.length > 0)
        await values.atomic.commit({ deletes: history.map((entry) => entry.key) });
      return;
    }
    if (await deleteVersion(values, viewId, current.version)) return;
  }
}

/** Delete expired view heads and return the number removed. */
export async function sweepViewState(
  store: AtomicStore,
  now: number = Date.now(),
): Promise<number> {
  const values = stateStore(store);
  const heads = await values.list<ViewSnapshot>({ prefix: VIEW_HEAD_PREFIX });
  let deleted = 0;
  for (const head of heads) {
    if (head.value.expiresAt > now) continue;
    const current = await values.atomic.getEntry<ViewSnapshot>(head.key);
    if (current && current.value.expiresAt <= now) {
      if (await deleteVersion(values, current.value.viewId, current.version)) deleted++;
    }
  }
  return deleted;
}
