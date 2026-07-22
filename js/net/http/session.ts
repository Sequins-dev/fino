/**
* internal:net/http/session — revision-safe HTTP app session implementation.
*
* The public API is exported only by `fino:net/http/app`. Callers supply a
* revision-capable `fino:cache` backend directly; session lifecycle code owns
* record validation, TTL translation, sealed identifiers, and conditional
* writes.
*
* Session data is JSON-serialized by the supplied cache. It is suitable for
* authentication identity and small request-scoped metadata, not as a
* transactional application database. A distributed adapter must provide
* atomic per-key conditional writes and read-after-write behavior to preserve
* the security guarantees of invalidation and regeneration; eventual
* replication alone is insufficient for immediate global logout.
*
* ```ts no_run
* import { memoryCache } from 'fino:cache';
* import { sessions } from 'fino:net/http/app';
*
* const middleware = sessions({
*   store: memoryCache({ namespace: 'sessions' }),
*   keys: [{ id: 'primary', secret: process.env.SESSION_SECRET! }],
*   ttlMs: 3_600_000,
* });
* ```
*/
import type { CacheEntry, RevisionedCache } from 'fino:cache';
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
const defaultClock: SessionClock = { now: () => Date.now() };
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
  /** Caller-owned revision-capable cache used for session records. */
  store: RevisionedCache;
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
* import { memoryCache } from 'fino:cache';
* import { App, cookies, sessions } from 'fino:net/http/app';
*
* const app = new App();
* const authenticated = app.value('cookies', cookies()).value('session', sessions({
*   store: memoryCache({ namespace: 'sessions' }),
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
    let snapshot = decoded === null ? null : await options.store.getEntry<SessionRecord<T>>(decoded.id);
    const now = clock.now();
    if (snapshot !== null && snapshot.value.expiresAt <= now) {
      await options.store.delete(snapshot.value.id);
      snapshot = null;
    }
    const initialRecord: SessionRecord<T> = snapshot?.value ?? {
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
      let saved: CacheEntry<SessionRecord<T>> | null = snapshot;
      if (shouldSave) {
        const expected = session.isNew ? null : snapshot!.revision;
        const record: SessionRecord<T> = {
          id: session.id,
          data: session.data,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt
        };
        assertRecord(record);
        const ttlMs = record.expiresAt - finishNow;
        saved = ttlMs <= 0 ? null : await options.store.compareAndSet(record.id, record, {
          ifRevision: expected,
          ttlMs
        });
        if (saved === null && !dirty && !session.isNew && options.rolling === true) {
          const latest = await options.store.getEntry<SessionRecord<T>>(session.id);
          if (latest !== null) {
            latest.value.expiresAt = finishNow + options.ttlMs;
            assertRecord(latest.value);
            saved = await options.store.compareAndSet(session.id, latest.value, {
              ifRevision: latest.revision,
              ttlMs: options.ttlMs
            });
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
