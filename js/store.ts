/**
 * fino:store — provider-owned key/value storage with optional capabilities.
 *
 * `Store` is the smallest shared persistence contract in Fino. Keys are
 * strings and values are chosen by the provider: the interface does not
 * require JSON serialization, cloning, persistence, or a particular wire
 * representation. `Uint8Array` is a first-class value, so stores can expose
 * raw binary backends without base64 conversion.
 *
 * ## Capabilities
 *
 * Plain stores provide read, write, delete, deterministic listing, and
 * namespaces. Providers may additionally expose:
 *
 * - `atomic`, for opaque version tokens and checked multi-key commits; and
 * - `expiration`, for provider-managed TTL, including TTL writes inside
 *   atomic commits.
 *
 * Consumers require only the capabilities their correctness depends on.
 * Versions are concurrency tokens, not retained revision history. Cache policy
 * lives in `fino:cache` and delegates expiry to `expiration` when available.
 *
 * `memoryStore()` retains values by reference and performs no encoding.
 * `sqliteStore()` owns its representation and defaults to a binary codec that
 * supports ordinary JSON-like values plus nested `Uint8Array` values. Callers
 * can replace that codec for domain-specific data.
 *
 * ```ts no_run
 * import { memoryStore, sqliteStore } from 'fino:store';
 *
 * const memory = memoryStore();
 * await memory.set('packet', new Uint8Array([1, 2, 3]));
 *
 * const sqlite = await sqliteStore({ path: './application.db' });
 * await sqlite.namespace('users').set('ada', { name: 'Ada' });
 * ```
 */
import { Database } from 'fino:database/sqlite';
import type { FileSystem } from 'internal:file/provider';
import { v4 as uuidv4 } from 'fino:uuid';

/** One key/value pair returned by `Store.list()`. */
export interface StoreEntry<T = unknown> {
  /** Key within the current namespace. */
  key: string;
  /** Value in the representation chosen by the provider. */
  value: T;
}

/** A value paired with an opaque optimistic-concurrency token. */
export interface VersionedStoreEntry<T = unknown> extends StoreEntry<T> {
  /** Token that changes whenever this key is written successfully. */
  version: string;
}

/** Options for listing records in one namespace. */
export interface StoreListOptions {
  /** Return only keys beginning with this prefix. Defaults to every key. */
  prefix?: string;
}

/** One precondition for an atomic store commit. */
export interface StoreCheck {
  /** Key whose current version is checked. */
  key: string;
  /** Required version, or `null` when the key must not exist. */
  ifVersion: string | null;
}

/** One value written by an atomic store commit. */
export interface StoreWrite<T = unknown> {
  /** Key to create or replace. */
  key: string;
  /** Provider-supported value to store. */
  value: T;
  /**
   * Provider-managed lifetime in milliseconds.
   *
   * This option is valid only when the owning store exposes `expiration`.
   */
  ttlMs?: number;
}

/** One atomic group of checked writes and deletes. */
export interface StoreCommit {
  /** Preconditions evaluated before any mutation. */
  checks?: StoreCheck[];
  /** Values created or replaced when every check matches. */
  writes?: StoreWrite[];
  /** Keys removed when every check matches. Missing keys are ignored. */
  deletes?: string[];
}

/** Result of a successful atomic commit. */
export interface StoreCommitResult {
  /** Versioned entries produced by `writes`, in input order. */
  writes: VersionedStoreEntry[];
}

/** Optional optimistic-concurrency capability exposed by a store provider. */
export interface AtomicStoreCapability {
  /** Read a value with its current opaque version, or `null`. */
  getEntry<T = unknown>(key: string): Promise<VersionedStoreEntry<T> | null>;
  /** Apply checked writes and deletes atomically, or return `null` on conflict. */
  commit(mutation: StoreCommit): Promise<StoreCommitResult | null>;
}

/** Optional provider-managed expiry capability. */
export interface StoreExpirationCapability {
  /**
   * Atomically store `value` with a lifetime of `ttlMs` milliseconds.
   *
   * Non-positive lifetimes make the value immediately unavailable.
   */
  set<T = unknown>(key: string, value: T, ttlMs: number): Promise<void>;
}

/**
 * Generic asynchronous key/value storage.
 *
 * Providers define value identity and serialization. A memory store may return
 * the exact object that was written, while a remote or persistent provider may
 * decode a new value. Callers that need portable data should choose a value
 * representation accepted by every configured provider.
 */
export interface Store {
  /** Read `key`, returning `null` when it is absent or expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Store `value` unconditionally, clearing any previous expiry. */
  set<T = unknown>(key: string, value: T): Promise<void>;
  /** Delete `key`, returning whether it existed. */
  delete(key: string): Promise<boolean>;
  /** List entries in deterministic key order. */
  list<T = unknown>(options?: StoreListOptions): Promise<StoreEntry<T>[]>;
  /** Return a view over the same provider in a child namespace. */
  namespace(name: string): Store;
  /** Optional checked-transaction capability. */
  readonly atomic?: AtomicStoreCapability;
  /** Optional native/provider-managed expiry capability. */
  readonly expiration?: StoreExpirationCapability;
}

/** Store whose provider supports checked transactions. */
export interface AtomicStore extends Store {
  readonly atomic: AtomicStoreCapability;
  namespace(name: string): AtomicStore;
}

/** Store whose provider manages entry expiry. */
export interface ExpiringStore extends Store {
  readonly expiration: StoreExpirationCapability;
  namespace(name: string): ExpiringStore;
}

/** Store supporting both checked transactions and provider-managed expiry. */
export interface AtomicExpiringStore extends AtomicStore, ExpiringStore {
  namespace(name: string): AtomicExpiringStore;
}

/** Clock used by providers that implement expiry locally. */
export interface StoreClock {
  /** Return the current Unix timestamp in milliseconds. */
  now(): number;
}

/** Options for creating an in-memory store. */
export interface MemoryStoreOptions {
  /** Initial namespace. Defaults to `"default"`. */
  namespace?: string;
  /** Clock used by provider-managed expiry. Defaults to `Date.now()`. */
  clock?: StoreClock;
}

/** Provider-specific value codec used by `sqliteStore()`. */
export interface StoreCodec {
  /** Encode one value for a SQLite BLOB column. */
  encode(value: unknown): Uint8Array;
  /** Decode one SQLite BLOB value. */
  decode(bytes: Uint8Array): unknown;
}

/** Options for opening a SQLite store. */
export interface SqliteStoreOptions {
  /** SQLite database path. */
  path: string;
  /** Initial namespace. Defaults to `"default"`. */
  namespace?: string;
  /** Optional filesystem provider for the SQLite VFS. */
  fs?: FileSystem;
  /** Provider-owned value codec. Defaults to the built-in binary codec. */
  codec?: StoreCodec;
  /** Clock used by provider-managed expiry. Defaults to `Date.now()`. */
  clock?: StoreClock;
}

/** SQLite store handle that owns its database connection. */
export interface SqliteStore extends AtomicExpiringStore {
  /** Close the underlying database connection. */
  close(): Promise<void>;
  /** Close the store when leaving an `await using` scope. */
  [Symbol.asyncDispose](): Promise<void>;
}

type MemoryRecord = {
  value: unknown;
  version: string;
  expiresAt: number | null;
};

class StoreCommitConflict extends Error {}
const SQLITE_STORE_BUSY_TIMEOUT_MS = 5000;

const defaultClock: StoreClock = { now: () => Date.now() };

function childNamespace(parent: string, child: string): string {
  if (child.length === 0) throw new TypeError('Store namespace must not be empty');
  return `${parent}\0${child}`;
}

function normalizedTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) throw new TypeError('Store ttlMs must be finite');
  return Math.max(0, ttlMs);
}

function validateMutation(mutation: StoreCommit, supportsExpiration: boolean): void {
  const writeKeys = new Set<string>();
  for (const write of mutation.writes ?? []) {
    if (writeKeys.has(write.key)) throw new TypeError(`Store commit writes ${write.key} twice`);
    if (write.ttlMs !== undefined) {
      if (!supportsExpiration)
        throw new TypeError('Store commit TTL requires the expiration capability');
      normalizedTtl(write.ttlMs);
    }
    writeKeys.add(write.key);
  }
  const deleteKeys = new Set<string>();
  for (const key of mutation.deletes ?? []) {
    if (deleteKeys.has(key)) throw new TypeError(`Store commit deletes ${key} twice`);
    if (writeKeys.has(key)) throw new TypeError(`Store commit writes and deletes ${key}`);
    deleteKeys.add(key);
  }
  const checkKeys = new Set<string>();
  for (const check of mutation.checks ?? []) {
    if (checkKeys.has(check.key)) throw new TypeError(`Store commit checks ${check.key} twice`);
    checkKeys.add(check.key);
  }
}

class MemoryStore implements AtomicExpiringStore {
  #namespaces: Map<string, Map<string, MemoryRecord>>;
  #namespace: string;
  #clock: StoreClock;

  readonly atomic: AtomicStoreCapability;
  readonly expiration: StoreExpirationCapability;

  constructor(
    namespaces: Map<string, Map<string, MemoryRecord>>,
    namespace: string,
    clock: StoreClock,
  ) {
    this.#namespaces = namespaces;
    this.#namespace = namespace;
    this.#clock = clock;
    this.atomic = {
      getEntry: <T>(key: string) => this.#getEntry<T>(key),
      commit: (mutation) => this.#commit(mutation),
    };
    this.expiration = {
      set: async <T>(key: string, value: T, ttlMs: number) => {
        const result = await this.#commit({ writes: [{ key, value, ttlMs }] });
        if (!result) throw new Error('unconditional memory-store write failed');
      },
    };
  }

  #entries(): Map<string, MemoryRecord> {
    let entries = this.#namespaces.get(this.#namespace);
    if (!entries) {
      entries = new Map();
      this.#namespaces.set(this.#namespace, entries);
    }
    return entries;
  }

  #record(key: string): MemoryRecord | null {
    const entries = this.#entries();
    const record = entries.get(key);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= this.#clock.now()) {
      entries.delete(key);
      return null;
    }
    return record;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.#record(key)?.value as T | undefined) ?? null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const result = await this.#commit({ writes: [{ key, value }] });
    if (!result) throw new Error('unconditional memory-store write failed');
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.#record(key) !== null;
    if (existed) this.#entries().delete(key);
    return existed;
  }

  async list<T = unknown>(options: StoreListOptions = {}): Promise<StoreEntry<T>[]> {
    const prefix = options.prefix ?? '';
    const result: StoreEntry<T>[] = [];
    for (const key of [...this.#entries().keys()].sort((a, b) => a.localeCompare(b))) {
      if (!key.startsWith(prefix)) continue;
      const record = this.#record(key);
      if (record) result.push({ key, value: record.value as T });
    }
    return result;
  }

  namespace(name: string): AtomicExpiringStore {
    return new MemoryStore(this.#namespaces, childNamespace(this.#namespace, name), this.#clock);
  }

  async #getEntry<T>(key: string): Promise<VersionedStoreEntry<T> | null> {
    const record = this.#record(key);
    return record ? { key, value: record.value as T, version: record.version } : null;
  }

  async #commit(mutation: StoreCommit): Promise<StoreCommitResult | null> {
    validateMutation(mutation, true);
    const entries = this.#entries();
    for (const check of mutation.checks ?? []) {
      const actual = this.#record(check.key)?.version ?? null;
      if (actual !== check.ifVersion) return null;
    }
    for (const key of mutation.deletes ?? []) entries.delete(key);
    const writes = (mutation.writes ?? []).map((write) => {
      const version = uuidv4().toString();
      entries.set(write.key, {
        value: write.value,
        version,
        expiresAt:
          write.ttlMs === undefined ? null : this.#clock.now() + normalizedTtl(write.ttlMs),
      });
      return { key: write.key, value: write.value, version };
    });
    return { writes };
  }
}

/** Create an in-memory store that retains values without encoding or cloning. */
export function memoryStore(options: MemoryStoreOptions = {}): AtomicExpiringStore {
  return new MemoryStore(new Map(), options.namespace ?? 'default', options.clock ?? defaultClock);
}

type EncodedNode =
  | null
  | boolean
  | number
  | string
  | ['bytes', string]
  | ['array', EncodedNode[]]
  | ['object', Array<[string, EncodedNode]>];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeNode(value: unknown, seen: Set<object>): EncodedNode {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('SQLite store values require finite numbers');
    return value;
  }
  if (value instanceof Uint8Array) return ['bytes', bytesToBase64(value)];
  if (typeof value !== 'object')
    throw new TypeError(`SQLite store cannot encode ${typeof value} values`);
  if (seen.has(value)) throw new TypeError('SQLite store cannot encode cyclic values');
  seen.add(value);
  try {
    if (Array.isArray(value)) return ['array', value.map((item) => encodeNode(item, seen))];
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('SQLite store default codec accepts only plain objects and arrays');
    return ['object', Object.entries(value).map(([key, item]) => [key, encodeNode(item, seen)])];
  } finally {
    seen.delete(value);
  }
}

function decodeNode(value: EncodedNode): unknown {
  if (!Array.isArray(value)) return value;
  if (value[0] === 'bytes') return base64ToBytes(value[1]);
  if (value[0] === 'array') return value[1].map(decodeNode);
  return Object.fromEntries(value[1].map(([key, item]) => [key, decodeNode(item)]));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const defaultSqliteCodec: StoreCodec = {
  encode(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) {
      const encoded = new Uint8Array(value.byteLength + 1);
      encoded[0] = 0;
      encoded.set(value, 1);
      return encoded;
    }
    const body = textEncoder.encode(JSON.stringify(encodeNode(value, new Set())));
    const encoded = new Uint8Array(body.byteLength + 1);
    encoded[0] = 1;
    encoded.set(body, 1);
    return encoded;
  },
  decode(bytes: Uint8Array): unknown {
    if (bytes.byteLength === 0) throw new TypeError('SQLite store value is missing its codec tag');
    if (bytes[0] === 0) return bytes.slice(1);
    if (bytes[0] !== 1) throw new TypeError(`Unknown SQLite store codec tag ${bytes[0]}`);
    return decodeNode(JSON.parse(textDecoder.decode(bytes.slice(1))) as EncodedNode);
  },
};

class SqliteStoreImpl implements SqliteStore {
  #db: Database;
  #namespace: string;
  #ownsDb: boolean;
  #codec: StoreCodec;
  #clock: StoreClock;

  readonly atomic: AtomicStoreCapability;
  readonly expiration: StoreExpirationCapability;

  constructor(
    db: Database,
    namespace: string,
    ownsDb: boolean,
    codec: StoreCodec,
    clock: StoreClock,
  ) {
    this.#db = db;
    this.#namespace = namespace;
    this.#ownsDb = ownsDb;
    this.#codec = codec;
    this.#clock = clock;
    this.atomic = {
      getEntry: <T>(key: string) => this.#getEntry<T>(key),
      commit: (mutation) => this.#commit(mutation),
    };
    this.expiration = {
      set: async <T>(key: string, value: T, ttlMs: number) => {
        const result = await this.#commit({ writes: [{ key, value, ttlMs }] });
        if (!result) throw new Error('unconditional SQLite-store write failed');
      },
    };
  }

  static async open(options: SqliteStoreOptions): Promise<SqliteStoreImpl> {
    const db = await Database.open(options.path, { fs: options.fs });
    await db.exec(`PRAGMA busy_timeout=${SQLITE_STORE_BUSY_TIMEOUT_MS}`);
    await db.exec(`CREATE TABLE IF NOT EXISTS fino_store_entries (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value BLOB NOT NULL,
      version TEXT NOT NULL,
      expires_at REAL,
      PRIMARY KEY(namespace, key)
    )`);
    return new SqliteStoreImpl(
      db,
      options.namespace ?? 'default',
      true,
      options.codec ?? defaultSqliteCodec,
      options.clock ?? defaultClock,
    );
  }

  async #deleteExpired(key?: string): Promise<void> {
    const stmt = this.#db.prepare(
      key === undefined
        ? `DELETE FROM fino_store_entries
           WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?`
        : `DELETE FROM fino_store_entries
           WHERE namespace = ? AND key = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
    );
    try {
      if (key === undefined) await stmt.run(this.#namespace, this.#clock.now());
      else await stmt.run(this.#namespace, key, this.#clock.now());
    } finally {
      stmt.finalize();
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (await this.#getEntry<T>(key))?.value ?? null;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const result = await this.#commit({ writes: [{ key, value }] });
    if (!result) throw new Error('unconditional SQLite-store write failed');
  }

  async delete(key: string): Promise<boolean> {
    await this.#deleteExpired(key);
    const stmt = this.#db.prepare(`DELETE FROM fino_store_entries WHERE namespace = ? AND key = ?`);
    try {
      const result = await stmt.run(this.#namespace, key);
      return Number(result.changes) > 0;
    } finally {
      stmt.finalize();
    }
  }

  async list<T = unknown>(options: StoreListOptions = {}): Promise<StoreEntry<T>[]> {
    await this.#deleteExpired();
    const prefix = options.prefix ?? '';
    const stmt = this.#db.prepare(
      `SELECT key, value FROM fino_store_entries
       WHERE namespace = ? AND substr(key, 1, length(?)) = ? ORDER BY key ASC`,
    );
    try {
      const rows = await stmt.all(this.#namespace, prefix, prefix);
      return rows.map((row) => ({
        key: row.key as string,
        value: this.#codec.decode(row.value as Uint8Array) as T,
      }));
    } finally {
      stmt.finalize();
    }
  }

  namespace(name: string): SqliteStore {
    return new SqliteStoreImpl(
      this.#db,
      childNamespace(this.#namespace, name),
      false,
      this.#codec,
      this.#clock,
    );
  }

  async #getEntry<T>(key: string): Promise<VersionedStoreEntry<T> | null> {
    await this.#deleteExpired(key);
    const stmt = this.#db.prepare(
      `SELECT value, version FROM fino_store_entries WHERE namespace = ? AND key = ?`,
    );
    try {
      const row = await stmt.get(this.#namespace, key);
      return row
        ? {
            key,
            value: this.#codec.decode(row.value as Uint8Array) as T,
            version: row.version as string,
          }
        : null;
    } finally {
      stmt.finalize();
    }
  }

  async #commit(mutation: StoreCommit): Promise<StoreCommitResult | null> {
    validateMutation(mutation, true);
    const writes = (mutation.writes ?? []).map((write) => ({
      ...write,
      encoded: this.#codec.encode(write.value),
      version: uuidv4().toString(),
      expiresAt: write.ttlMs === undefined ? null : this.#clock.now() + normalizedTtl(write.ttlMs),
    }));
    try {
      const applyMutation = async () => {
        const expired = this.#db.prepare(
          `DELETE FROM fino_store_entries
           WHERE namespace = ? AND key = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
        );
        const claimMissing = this.#db.prepare(
          `INSERT OR IGNORE INTO fino_store_entries(namespace, key, value, version, expires_at)
           VALUES(?, ?, ?, ?, NULL)`,
        );
        const claimVersion = this.#db.prepare(
          `UPDATE fino_store_entries SET version = version
           WHERE namespace = ? AND key = ? AND version = ?`,
        );
        const remove = this.#db.prepare(
          `DELETE FROM fino_store_entries WHERE namespace = ? AND key = ?`,
        );
        const put = this.#db.prepare(
          `INSERT INTO fino_store_entries(namespace, key, value, version, expires_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value = excluded.value,
             version = excluded.version,
             expires_at = excluded.expires_at`,
        );
        const claimedMissing = new Set<string>();
        try {
          const placeholder = new Uint8Array([0]);
          for (const check of [...(mutation.checks ?? [])].sort((a, b) =>
            a.key.localeCompare(b.key),
          )) {
            await expired.run(this.#namespace, check.key, this.#clock.now());
            const result =
              check.ifVersion === null
                ? await claimMissing.run(
                    this.#namespace,
                    check.key,
                    placeholder,
                    uuidv4().toString(),
                  )
                : await claimVersion.run(this.#namespace, check.key, check.ifVersion);
            if (Number(result.changes) !== 1) throw new StoreCommitConflict();
            if (check.ifVersion === null) claimedMissing.add(check.key);
          }
          for (const key of mutation.deletes ?? []) await remove.run(this.#namespace, key);
          for (const write of writes)
            await put.run(
              this.#namespace,
              write.key,
              write.encoded,
              write.version,
              write.expiresAt,
            );
          const mutated = new Set([
            ...(mutation.deletes ?? []),
            ...writes.map((write) => write.key),
          ]);
          for (const key of claimedMissing) {
            if (!mutated.has(key)) await remove.run(this.#namespace, key);
          }
        } finally {
          expired.finalize();
          claimMissing.finalize();
          claimVersion.finalize();
          remove.finalize();
          put.finalize();
        }
      };
      await this.#db._transaction('immediate', applyMutation, {
        busyTimeoutMs: SQLITE_STORE_BUSY_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof StoreCommitConflict) return null;
      throw error;
    }
    return {
      writes: writes.map((write) => ({
        key: write.key,
        value: write.value,
        version: write.version,
      })),
    };
  }

  async close(): Promise<void> {
    if (this.#ownsDb) await this.#db.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Open a SQLite store with provider-owned binary serialization and TTL. */
export function sqliteStore(options: SqliteStoreOptions): Promise<SqliteStore> {
  return SqliteStoreImpl.open(options);
}
