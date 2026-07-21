/**
* fino:security/session — revision-safe server sessions for HTTP applications.
*
* Session middleware, records, and stores live in this security-owned module
* so application code can use the same lifecycle with memory, SQLite, cache,
* and future distributed KV backends. Stores expose opaque revisions and
* conditional saves: a request may replace only the record it loaded, so a
* stale response cannot silently overwrite a newer login or recreate a session
* after logout. Backends may implement that guarantee with a transaction,
* compare-and-set primitive, or a brief internal key lock; locks are never held
* while application handlers run.
*
* Session data is JSON-serialized by the built-in stores. It is suitable for
* authentication identity and small request-scoped metadata, not as a
* transactional application database. A distributed adapter must provide
* atomic per-key conditional writes and read-after-write behavior to preserve
* the security guarantees of invalidation and regeneration; eventual
* replication alone is insufficient for immediate global logout.
*
* ```ts no_run
* import { memorySessionStore } from 'fino:security/session';
*
* const store = memorySessionStore();
* const saved = await store.save({
*   id: crypto.randomUUID(),
*   data: { userId: 'user-123' },
*   createdAt: Date.now(),
*   updatedAt: Date.now(),
*   expiresAt: Date.now() + 3_600_000,
* }, { ifRevision: null });
* ```
*/
import { memoryCache, sqliteCache, type CacheClock, type RevisionedCache, type SqliteCache } from 'fino:cache';
import type { FileSystem } from 'internal:file/provider';
import { CookieJar, sealCookie, unsealCookie, type BufferLike, type CookieOptions } from 'fino:security/cookie';
import { v4 as uuidv4 } from 'fino:uuid';
import type { HttpContext, Producer } from 'fino:net/http/app';
/** Clock used for session timestamps and expiry checks. */
export interface SessionClock {
  /** Return the current Unix timestamp in milliseconds. */
  now(): number;
}
/** Durable, backend-neutral representation of one server session. */
export interface SessionRecord<T = Record<string, unknown>> {
  /** Opaque session identifier stored only inside the sealed browser cookie. */
  id: string;
  /** JSON-serializable application data. */
  data: T;
  /** Unix timestamp in milliseconds when this session was first created. */
  createdAt: number;
  /** Unix timestamp in milliseconds for the last application-data update. */
  updatedAt: number;
  /** Absolute Unix timestamp in milliseconds after which the record is invalid. */
  expiresAt: number;
}
/** A loaded or saved session paired with its backend's opaque revision. */
export interface SessionSnapshot<T = Record<string, unknown>> {
  /** Session record visible to the middleware. */
  record: SessionRecord<T>;
  /** Opaque token required by the next conditional save. */
  revision: string;
}
/** Options for a revision-conditional session save. */
export interface SessionSaveOptions {
  /** Current revision, or `null` to create only when the ID is absent. */
  ifRevision: string | null;
}
/**
* Backend contract used by server-session middleware.
*
* `save()` must atomically compare `ifRevision` and write the replacement.
* It returns `null` on a missing or stale revision without changing the current
* record. `delete()` is unconditional so logout wins over any record currently
* stored; in-flight requests still carry an old revision and cannot recreate it.
*/
export interface SessionStore<T = Record<string, unknown>> {
  /** Load a live session and its revision, or `null` when missing or expired. */
  load(id: string): Promise<SessionSnapshot<T> | null>;
  /** Conditionally create or replace a session record. */
  save(record: SessionRecord<T>, options: SessionSaveOptions): Promise<SessionSnapshot<T> | null>;
  /** Unconditionally remove a session ID. Missing sessions are ignored. */
  delete(id: string): Promise<void>;
}
/** Options for adapting a revision-capable cache into a session store. */
export interface CacheSessionStoreOptions {
  /** Clock used to translate absolute session expiry into cache TTL. */
  clock?: SessionClock;
}
const defaultClock: SessionClock = { now: () => Date.now() };
class CacheBackedSessionStore<T> implements SessionStore<T> {
  readonly cache: RevisionedCache;
  readonly clock: SessionClock;
  constructor(cache: RevisionedCache, clock: SessionClock) {
    this.cache = cache;
    this.clock = clock;
  }
  async load(id: string): Promise<SessionSnapshot<T> | null> {
    const entry = await this.cache.getEntry<SessionRecord<T>>(id);
    if (entry === null) return null;
    if (entry.value.expiresAt <= this.clock.now()) {
      await this.cache.delete(id);
      return null;
    }
    return {
      record: entry.value,
      revision: entry.revision
    };
  }
  async save(record: SessionRecord<T>, options: SessionSaveOptions): Promise<SessionSnapshot<T> | null> {
    assertRecord(record);
    const ttlMs = record.expiresAt - this.clock.now();
    if (ttlMs <= 0) {
      await this.cache.delete(record.id);
      return null;
    }
    const entry = await this.cache.compareAndSet(record.id, record, {
      ifRevision: options.ifRevision,
      ttlMs
    });
    return entry === null ? null : {
      record: entry.value,
      revision: entry.revision
    };
  }
  delete(id: string): Promise<void> {
    return this.cache.delete(id);
  }
}
function assertRecord(record: SessionRecord<unknown>): void {
  if (record.id.length === 0) throw new TypeError('session id must not be empty');
  for (const [name, value] of [
    ['createdAt', record.createdAt],
    ['updatedAt', record.updatedAt],
    ['expiresAt', record.expiresAt]
  ] as const) {
    if (!Number.isFinite(value)) throw new TypeError(`session ${name} must be finite`);
  }
}
/**
* Adapt a `RevisionedCache` to the session-store contract.
*
* The supplied cache remains caller-owned. Its namespace is used unchanged,
* allowing applications to isolate session records before creating the adapter.
*/
export function cacheSessionStore<T = Record<string, unknown>>(cache: RevisionedCache, options: CacheSessionStoreOptions = {}): SessionStore<T> {
  return new CacheBackedSessionStore<T>(cache, options.clock ?? defaultClock);
}
/** Options for `memorySessionStore()`. */
export interface MemorySessionStoreOptions extends CacheSessionStoreOptions {
  /** Maximum sessions retained across namespaces. Defaults to unlimited. */
  maxEntries?: number;
  /** Cache namespace used for records. Defaults to `"sessions"`. */
  namespace?: string;
}
/** Create a process-local revision-safe session store for tests and local apps. */
export function memorySessionStore<T = Record<string, unknown>>(options: MemorySessionStoreOptions = {}): SessionStore<T> {
  const clock = options.clock ?? defaultClock;
  return cacheSessionStore<T>(memoryCache({
    maxEntries: options.maxEntries,
    namespace: options.namespace ?? 'sessions',
    clock: clock as CacheClock
  }), { clock });
}
/** Options for opening a SQLite-backed session store. */
export interface SqliteSessionStoreOptions extends CacheSessionStoreOptions {
  /** SQLite database path or URI. */
  path: string;
  /** Cache namespace used for records. Defaults to `"sessions"`. */
  namespace?: string;
  /** Optional filesystem provider used by SQLite. */
  fs?: FileSystem;
}
/** SQLite-backed session store that owns its database connection. */
export interface SqliteSessionStore<T = Record<string, unknown>> extends SessionStore<T> {
  /** Close the underlying SQLite cache connection. */
  close(): Promise<void>;
}
class OwnedSqliteSessionStore<T> extends CacheBackedSessionStore<T> implements SqliteSessionStore<T> {
  readonly #sqlite: SqliteCache;
  constructor(cache: SqliteCache, clock: SessionClock) {
    super(cache, clock);
    this.#sqlite = cache;
  }
  close(): Promise<void> {
    return this.#sqlite.close();
  }
}
/**
* Open a durable revision-safe session store over SQLite.
*
* Call `close()` when the owning application shuts down. Reopening the same
* path and namespace restores all records that have not expired.
*/
export async function sqliteSessionStore<T = Record<string, unknown>>(options: SqliteSessionStoreOptions): Promise<SqliteSessionStore<T>> {
  const clock = options.clock ?? defaultClock;
  const cache = await sqliteCache({
    path: options.path,
    namespace: options.namespace ?? 'sessions',
    clock: clock as CacheClock,
    fs: options.fs
  });
  return new OwnedSqliteSessionStore<T>(cache, clock);
}
/** One cookie-sealing key accepted by server-session middleware. */
export interface SessionKey {
  /** Stable short identifier written outside the sealed cookie payload. */
  id: string;
  /** Secret material used by AES-256-GCM cookie sealing. */
  secret: BufferLike;
}
/** Request-local session exposed to HTTP application handlers. */
export interface Session<T = Record<string, unknown>> extends SessionRecord<T> {
  /** Whether this request created or regenerated the session. */
  isNew: boolean;
  /**
  * Replace the session ID while retaining its data.
  *
  * Call this after authentication succeeds to prevent session fixation. The
  * old ID is deleted before the replacement is committed.
  */
  regenerate(): void;
  /** Delete the stored session and expire its browser cookie after the response. */
  invalidate(): void;
}
/** Options for the secure HTTP session producer. */
export interface SessionOptions<T = Record<string, unknown>> {
  /** Revision-safe backend used for session records. */
  store: SessionStore<T>;
  /** Sealing keys ordered primary-first; old keys remain readable for rotation. */
  keys: readonly [SessionKey, ...SessionKey[]];
  /** Session lifetime in milliseconds. Must be finite and greater than zero. */
  ttlMs: number;
  /** Cookie name. Defaults to `fino.sid`. */
  cookie?: string;
  /** Additional cookie policy merged over secure defaults. */
  cookieOptions?: CookieOptions;
  /** Extend expiry after each successful request. Defaults to `false`. */
  rolling?: boolean;
  /** Clock used for deterministic timestamps and expiry. */
  clock?: SessionClock;
}
/**
* Error raised when a request tries to commit data based on a stale revision.
*
* The middleware never guesses how to merge arbitrary session data or reruns a
* handler whose side effects may already have happened. Applications may turn
* this error into a conflict response or ask the client to retry safely.
*/
export class SessionConflictError extends Error {
  /** Conflicting session identifier. */
  readonly sessionId: string;
  /** Create a conflict error for `sessionId`. */
  constructor(sessionId: string) {
    super(`session '${sessionId}' changed during the request`);
    this.name = 'SessionConflictError';
    this.sessionId = sessionId;
  }
}
function validateSessionOptions<T>(options: SessionOptions<T>): void {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new TypeError('session ttlMs must be finite and greater than zero');
  if (options.keys.length === 0) throw new TypeError('session keys must not be empty');
  const ids = new Set<string>();
  for (const key of options.keys) {
    if (!/^[A-Za-z0-9_-]+$/.test(key.id)) throw new TypeError('session key id must contain only letters, numbers, underscores, or hyphens');
    if (ids.has(key.id)) throw new TypeError(`duplicate session key id '${key.id}'`);
    ids.add(key.id);
  }
}
function sealSessionId(id: string, key: SessionKey): string {
  return `${key.id}.${sealCookie(id, key.secret)}`;
}
function unsealSessionId(value: string, keys: readonly SessionKey[]): {
  id: string;
  keyIndex: number;
} | null {
  const separator = value.indexOf('.');
  if (separator < 1) return null;
  const keyId = value.slice(0, separator);
  const keyIndex = keys.findIndex((key) => key.id === keyId);
  if (keyIndex < 0) return null;
  const id = unsealCookie(value.slice(separator + 1), keys[keyIndex]!.secret);
  return id === null || id.length === 0 ? null : {
    id,
    keyIndex
  };
}
function sessionCookieOptions(options: SessionOptions<unknown>, now: number, expiresAt: number): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...options.cookieOptions,
    expires: new Date(expiresAt),
    maxAge: Math.max(0, Math.ceil((expiresAt - now) / 1e3))
  };
}
function deleteCookieOptions(options: SessionOptions<unknown>): CookieOptions {
  return {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...options.cookieOptions
  };
}
/**
* Create an HTTP app producer that loads and commits a secure server session.
*
* Install it with `.value('session', sessions(options))`, normally after the
* app's `cookies()` producer. The cookie contains only an AES-GCM-sealed
* session ID. New cookies use the first key; cookies opened with a later key
* are automatically resealed with the primary key after a successful request.
*
* Unchanged fixed-expiry sessions perform no store write. Rolling sessions
* conditionally extend expiry. Concurrent expiry-only updates may retry against
* the latest record, while conflicting application-data mutations raise
* `SessionConflictError` rather than lose an update.
*
* For OAuth/OIDC callbacks, capture the request session in
* `oauthCallback({ onSuccess })`, call `session.regenerate()` after the token
* exchange succeeds, and copy only the verified identity claims the
* application needs into `session.data`. Provider access and refresh tokens
* are not stored automatically.
*
* ```ts no_run
* import { App, cookies } from 'fino:net/http/app';
* import { memorySessionStore, sessions } from 'fino:security/session';
*
* const app = new App();
* const authenticated = app.value('cookies', cookies()).value('session', sessions({
*   store: memorySessionStore(),
*   keys: [{ id: '2026-07', secret: process.env.SESSION_SECRET! }],
*   ttlMs: 24 * 60 * 60_000,
* }));
* authenticated.get('/me').handle((ctx) => Response.json(ctx.session.data));
* ```
*/
export function sessions<T = Record<string, unknown>>(options: SessionOptions<T>): Producer {
  validateSessionOptions(options);
  const clock = options.clock ?? defaultClock;
  const cookie = options.cookie ?? 'fino.sid';
  const primary = options.keys[0]!;
  return async (ctx: HttpContext) => {
    const jar = ctx.cookies instanceof CookieJar ? ctx.cookies : new CookieJar(ctx.request.headers.get('cookie'));
    if (!(ctx.cookies instanceof CookieJar)) ctx.cookies = jar;
    const opened = jar.get(cookie);
    const decoded = opened === undefined ? null : unsealSessionId(opened, options.keys);
    let snapshot = decoded === null ? null : await options.store.load(decoded.id);
    const now = clock.now();
    if (snapshot !== null && snapshot.record.expiresAt <= now) {
      await options.store.delete(snapshot.record.id);
      snapshot = null;
    }
    const initialRecord: SessionRecord<T> = snapshot?.record ?? {
      id: uuidv4().toString(),
      data: {} as T,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + options.ttlMs
    };
    if (snapshot !== null && options.rolling === true) initialRecord.expiresAt = now + options.ttlMs;
    const originalId = initialRecord.id;
    const originalData = JSON.stringify(initialRecord.data);
    let invalidated = false;
    let regenerated = false;
    const session: Session<T> = {
      ...initialRecord,
      isNew: snapshot === null,
      regenerate() {
        if (invalidated) throw new Error('cannot regenerate an invalidated session');
        session.id = uuidv4().toString();
        session.createdAt = clock.now();
        session.updatedAt = session.createdAt;
        session.expiresAt = session.createdAt + options.ttlMs;
        session.isNew = true;
        regenerated = true;
      },
      invalidate() {
        invalidated = true;
      }
    };
    const previousApply = ctx.__sessionApply as undefined | ((response: Response) => Promise<void>);
    ctx.__sessionApply = async (response: Response) => {
      await previousApply?.(response);
      const finishNow = clock.now();
      if (invalidated) {
        await options.store.delete(originalId);
        if (session.id !== originalId) await options.store.delete(session.id);
        jar.delete(cookie, deleteCookieOptions(options as SessionOptions<unknown>));
        return;
      }
      const encodedData = JSON.stringify(session.data);
      const dirty = encodedData !== originalData;
      if (dirty) session.updatedAt = finishNow;
      if (options.rolling === true) session.expiresAt = finishNow + options.ttlMs;
      if (regenerated) await options.store.delete(originalId);
      const shouldSave = session.isNew || dirty || options.rolling === true;
      let saved: SessionSnapshot<T> | null = snapshot;
      if (shouldSave) {
        const expected = session.isNew ? null : snapshot!.revision;
        saved = await options.store.save({
          id: session.id,
          data: session.data,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt
        }, { ifRevision: expected });
        if (saved === null && !dirty && !session.isNew && options.rolling === true) {
          const latest = await options.store.load(session.id);
          if (latest !== null) {
            latest.record.expiresAt = finishNow + options.ttlMs;
            saved = await options.store.save(latest.record, { ifRevision: latest.revision });
          }
        }
        if (saved === null) {
          if (!dirty && !session.isNew) {
            jar.delete(cookie, deleteCookieOptions(options as SessionOptions<unknown>));
            return;
          }
          throw new SessionConflictError(session.id);
        }
      }
      const rotateKey = decoded !== null && decoded.keyIndex !== 0;
      if (session.isNew || options.rolling === true || rotateKey) {
        jar.set(cookie, sealSessionId(session.id, primary), sessionCookieOptions(options as SessionOptions<unknown>, finishNow, session.expiresAt));
      }
    };
    return session;
  };
}
