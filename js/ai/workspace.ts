/**
 * fino:ai/workspace — a durable registry of user-level agent sessions.
 *
 * A `Session` (`fino:ai/session`) makes one conversation durable. An
 * application that lets a person keep several conversations — a chat sidebar,
 * a list of running jobs, a `sessions` subcommand — needs a layer above that:
 * which threads exist, what they are called, when each was last touched,
 * which are archived, and which are asking for attention right now. That
 * layer is `AgentWorkspace`.
 *
 * The workspace owns one shared `SessionStore` and the registry of sessions
 * in it, persisted under a single metadata key. It does not know what a
 * session *is*: the application supplies a `create()` factory returning
 * whatever per-session object it drives — an `Agent`, a `Session`, a custom
 * engine — and the workspace caches one instance per session id, tracks its
 * coarse activity, and closes it on archive, delete, or shutdown.
 *
 * Two rules are worth knowing before wiring it up:
 *
 * - **Sessions register on their first turn, not on creation.** `create()`
 *   hands back a live object immediately, but the registry row appears when
 *   the session reports its first turn through `onTurn`. Opening the
 *   application and closing it again therefore leaves no empty row behind.
 * - **`done` is the workspace's state, not the session's.** A turn that
 *   finishes while the user is looking elsewhere stays `done` until
 *   `markSeen()` retires it, so a list can flag unread results.
 *
 * ```ts no_run
 * import { AgentWorkspace } from 'fino:ai/workspace';
 * import { agent } from 'fino:ai/agent';
 * import { session } from 'fino:ai/session';
 * import { anthropic } from 'fino:ai/model';
 *
 * const workspace = await AgentWorkspace.open({
 *   path: '/repo/.fino/sessions.db',
 *   create: async (id, ctx) =>
 *     session({
 *       agent: agent({ model: anthropic({ model: 'claude-sonnet-4-5' }) }),
 *       store: ctx.store,
 *       threadId: id,
 *     }),
 * });
 *
 * const chat = await workspace.createSession();
 * await chat.run('what changed in the loader?');
 * for (const meta of workspace.list()) console.log(meta.id, meta.title);
 * await workspace.close();
 * ```
 */
import { InMemorySessionStore, SqliteSessionStore, type SessionStore } from 'fino:ai/session';
import { DiskFileSystem } from 'fino:file';
import { dirname } from 'fino:file/path';

/**
 * Registry entry for one user-level session.
 *
 * ```ts no_run
 * import type { AgentSessionMeta } from 'fino:ai/workspace';
 *
 * const row: AgentSessionMeta = {
 *   id: 'session-abc',
 *   title: 'investigate the flaky loader test',
 *   createdAt: Date.now(),
 *   updatedAt: Date.now(),
 *   archived: false,
 * };
 * ```
 */
export interface AgentSessionMeta {
  /** Session id — also the durable thread id in the shared store. */
  id: string;
  /** Human title, derived from the first turn's input until renamed. */
  title: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Last activity timestamp (ms); active session lists sort by this. */
  updatedAt: number;
  /** Archived sessions drop out of the active list into a history list. */
  archived: boolean;
  /**
   * Free-form model marker the session reported through `onModel`, restored
   * when the session reopens. Applications that never switch models can
   * ignore it.
   */
  model?: string;
}

/**
 * Coarse activity a session reports about itself.
 *
 * ```ts no_run
 * import type { AgentSessionState } from 'fino:ai/workspace';
 *
 * const state: AgentSessionState = 'waiting';
 * ```
 */
export type AgentSessionState = 'working' | 'waiting' | 'idle' | 'error';

/**
 * Activity the workspace tracks for list indicators.
 *
 * Adds `done` to the states a session reports: a turn that settled while the
 * user was looking at another session stays `done` until `markSeen()` retires
 * it.
 *
 * ```ts no_run
 * import type { AgentSessionActivity } from 'fino:ai/workspace';
 *
 * const activity: AgentSessionActivity = 'done';
 * ```
 */
export type AgentSessionActivity = AgentSessionState | 'done';

/**
 * What the sessions in a workspace need from the user, folded into one set of
 * flags so an interface can show a single indicator.
 *
 * ```ts no_run
 * import type { AttentionSummary } from 'fino:ai/workspace';
 *
 * const quiet: AttentionSummary = { input: false, error: false, done: false, busy: false };
 * ```
 */
export interface AttentionSummary {
  /** Some session is suspended waiting for input or approval. */
  input: boolean;
  /** Some session ended a turn in error. */
  error: boolean;
  /** Some session has an unseen finished turn. */
  done: boolean;
  /** Some session is running a turn right now. */
  busy: boolean;
}

/**
 * What the workspace hands a `create()` factory: the shared store, the
 * registry entry when the session already has one, and the callbacks that
 * keep the registry in step with the session.
 *
 * A session object is expected to call `onActivity` as it moves between
 * states, `onTurn` when a turn begins, and `onModel` when it changes model.
 * All three are optional in the sense that a session that never calls them
 * simply never registers or changes activity.
 *
 * ```ts no_run
 * import { AgentWorkspace, type AgentSessionContext } from 'fino:ai/workspace';
 *
 * const workspace = await AgentWorkspace.open({
 *   create: async (id: string, ctx: AgentSessionContext) => ({
 *     id,
 *     store: ctx.store,
 *     run(input: string) {
 *       ctx.onTurn(input);
 *       ctx.onActivity('working');
 *       ctx.onActivity('idle');
 *     },
 *   }),
 * });
 * ```
 */
export interface AgentSessionContext {
  /** The store every session in the workspace shares. */
  store: SessionStore;
  /**
   * Registry entry when this session is already known — carries the title,
   * timestamps, and the `model` a reopened session last used.
   */
  meta?: AgentSessionMeta;
  /** Report a state change; `idle` after `working` becomes an unseen `done`. */
  onActivity(state: AgentSessionState): void;
  /**
   * Report the start of a turn with the input that began it. The first call
   * registers the session and derives its title.
   */
  onTurn(input: string): void;
  /** Record the model this session is now using. */
  onModel(model: string): void;
}

/**
 * Options for `AgentWorkspace.open()`.
 *
 * The store is chosen by what is supplied: an existing `store` is used as-is
 * and never closed by the workspace, a `path` opens (and owns) a
 * `SqliteSessionStore` with its parent directories created, and neither gives
 * an `InMemorySessionStore` for ephemeral runs.
 *
 * ```ts no_run
 * import { AgentWorkspace, type AgentWorkspaceOptions } from 'fino:ai/workspace';
 *
 * const opts: AgentWorkspaceOptions<{ id: string }> = {
 *   path: '/repo/.fino/sessions.db',
 *   key: 'myapp:sessions',
 *   idPrefix: 'myapp',
 *   create: async (id) => ({ id }),
 * };
 * const workspace = await AgentWorkspace.open(opts);
 * ```
 */
export interface AgentWorkspaceOptions<S> {
  /** Shared store to use. The workspace never closes a store it was given. */
  store?: SessionStore;
  /** SQLite path to open when no `store` is supplied; the workspace owns it. */
  path?: string;
  /** Metadata key holding the registry. Defaults to `ai:sessions`. */
  key?: string;
  /** Prefix for generated session ids. Defaults to `session`. */
  idPrefix?: string;
  /** Build the per-session object the application drives. */
  create(id: string, ctx: AgentSessionContext): Promise<S>;
  /** Release a session object on archive, delete, or workspace close. */
  close?(session: S): Promise<void>;
  /**
   * Extra metadata keys belonging to a session, deleted with it. The pool
   * state `fino:ai/subagents` keeps under `subagents:<id>` is always swept.
   */
  metaKeys?(id: string): string[];
}

const DEFAULT_KEY = 'ai:sessions';
const DEFAULT_PREFIX = 'session';
const TITLE_MAX = 48;

async function mkdirRecursive(fs: DiskFileSystem, dir: string): Promise<void> {
  try {
    await fs.mkdir(dir);
    return;
  } catch (_) {
    // parent may be missing, or the directory already exists
  }
  const parent = dirname(dir).toString();
  if (parent !== dir) {
    await mkdirRecursive(fs, parent);
    try {
      await fs.mkdir(dir);
    } catch (_) {
      // already exists
    }
  }
}

function deriveTitle(input: string): string {
  const flat = input.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return 'untitled';
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX - 1) + '…' : flat;
}

/**
 * Shared-store session registry and lifecycle manager.
 *
 * Session objects are cached per id; `onChange` observers fire on every
 * registry or activity transition so a list view can re-render.
 *
 * ```ts no_run
 * import { AgentWorkspace } from 'fino:ai/workspace';
 *
 * const workspace = await AgentWorkspace.open({
 *   create: async (id) => ({ id }),
 * });
 * const stop = workspace.onChange(() => console.log(workspace.list()));
 * await workspace.createSession();
 * stop();
 * await workspace.close();
 * ```
 */
export class AgentWorkspace<S> {
  #opts: AgentWorkspaceOptions<S>;
  #key: string;
  #prefix: string;
  #store: SessionStore;
  #storeCloser?: () => Promise<void>;
  #sessions: AgentSessionMeta[];
  #objects = new Map<string, S>();
  #draftModels = new Map<string, string>();
  #activity = new Map<string, AgentSessionActivity>();
  #listeners = new Set<() => void>();

  private constructor(
    opts: AgentWorkspaceOptions<S>,
    store: SessionStore,
    sessions: AgentSessionMeta[],
    storeCloser?: () => Promise<void>,
  ) {
    this.#opts = opts;
    this.#key = opts.key ?? DEFAULT_KEY;
    this.#prefix = opts.idPrefix ?? DEFAULT_PREFIX;
    this.#store = store;
    this.#sessions = sessions;
    this.#storeCloser = storeCloser;
  }

  /**
   * Open the workspace: resolve the shared store and load the registry.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * ```
   */
  static async open<S>(opts: AgentWorkspaceOptions<S>): Promise<AgentWorkspace<S>> {
    let store: SessionStore;
    let storeCloser: (() => Promise<void>) | undefined;
    if (opts.store) {
      store = opts.store;
    } else if (opts.path !== undefined) {
      await mkdirRecursive(new DiskFileSystem(), dirname(opts.path).toString());
      const sqlite = await SqliteSessionStore.open(opts.path);
      store = sqlite;
      storeCloser = () => sqlite.close();
    } else {
      store = new InMemorySessionStore();
    }
    const key = opts.key ?? DEFAULT_KEY;
    const sessions = ((await store.getMeta(key)) as AgentSessionMeta[] | null) ?? [];
    return new AgentWorkspace<S>(opts, store, sessions, storeCloser);
  }

  /**
   * The shared session store.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const runs = await workspace.store.listRuns();
   * ```
   */
  get store(): SessionStore {
    return this.#store;
  }

  /**
   * Registry snapshot: active sessions by default (most recent first), or
   * archived ones with `archived: true`.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const history = workspace.list({ archived: true });
   * ```
   */
  list(opts: { archived?: boolean } = {}): AgentSessionMeta[] {
    const archived = opts.archived ?? false;
    return this.#sessions
      .filter((s) => s.archived === archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ ...s }));
  }

  /**
   * Registry entry for one session, or `undefined` when it has never run a
   * turn.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * console.log(workspace.meta('session-abc')?.title);
   * ```
   */
  meta(id: string): AgentSessionMeta | undefined {
    const found = this.#sessions.find((s) => s.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Coarse activity for list indicators; unopened sessions are idle.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * console.log(workspace.activity('session-abc'));
   * ```
   */
  activity(id: string): AgentSessionActivity {
    return this.#activity.get(id) ?? 'idle';
  }

  /**
   * Retire a session's unread `done` or `error` flag once the user has looked
   * at its result. Any other activity is left alone.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * workspace.markSeen('session-abc');
   * ```
   */
  markSeen(id: string): void {
    const current = this.#activity.get(id);
    if (current !== 'done' && current !== 'error') return;
    this.#activity.set(id, 'idle');
    this.#notify();
  }

  /**
   * What the registered, unarchived sessions need from the user, folded into
   * one set of flags.
   *
   * `excludeId` drops the session the user is already looking at.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const { input, busy } = workspace.attentionSummary('session-abc');
   * ```
   */
  attentionSummary(excludeId?: string): AttentionSummary {
    const summary: AttentionSummary = { input: false, error: false, done: false, busy: false };
    for (const meta of this.#sessions) {
      if (meta.archived || meta.id === excludeId) continue;
      switch (this.#activity.get(meta.id)) {
        case 'waiting':
          summary.input = true;
          break;
        case 'error':
          summary.error = true;
          break;
        case 'done':
          summary.done = true;
          break;
        case 'working':
          summary.busy = true;
          break;
      }
    }
    return summary;
  }

  /**
   * The cached object for an already-opened session, if any.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const live = workspace.sessionFor('session-abc');
   * ```
   */
  sessionFor(id: string): S | undefined {
    return this.#objects.get(id);
  }

  /**
   * Subscribe to registry and activity changes; returns an unsubscribe.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const stop = workspace.onChange(() => console.log('registry changed'));
   * stop();
   * ```
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (_) {
        // observer errors must not fail workspace operations
      }
    }
  }

  async #persist(): Promise<void> {
    try {
      await this.#store.putMeta(this.#key, this.#sessions);
    } catch (_) {
      // best-effort; the next mutation retries
    }
  }

  #touch(id: string): void {
    const meta = this.#sessions.find((s) => s.id === id);
    if (meta) meta.updatedAt = Date.now();
    void this.#persist();
    this.#notify();
  }

  async #open(id: string): Promise<S> {
    const cached = this.#objects.get(id);
    if (cached) return cached;
    const stored = this.#sessions.find((s) => s.id === id);
    const created = await this.#opts.create(id, {
      store: this.#store,
      ...(stored ? { meta: { ...stored } } : {}),
      onModel: (model) => {
        const meta = this.#sessions.find((s) => s.id === id);
        if (!meta) {
          // Chosen in a blank session: held until the session registers.
          this.#draftModels.set(id, model);
          return;
        }
        meta.model = model;
        void this.#persist();
      },
      onActivity: (state) => {
        const settled = state === 'idle' && this.#activity.get(id) === 'working';
        this.#activity.set(id, settled ? 'done' : state);
        this.#touch(id);
      },
      onTurn: (input) => {
        // A session earns its registry entry by being used. Registering at
        // creation left an "untitled" row behind every time the app was
        // opened and closed without a prompt.
        const meta = this.#sessions.find((s) => s.id === id);
        if (!meta) {
          const now = Date.now();
          const model = this.#draftModels.get(id);
          this.#draftModels.delete(id);
          this.#sessions.push({
            id,
            title: deriveTitle(input),
            createdAt: now,
            updatedAt: now,
            archived: false,
            ...(model ? { model } : {}),
          });
          void this.#persist();
          this.#notify();
          return;
        }
        if (meta.title === 'untitled') {
          meta.title = deriveTitle(input);
          void this.#persist();
        }
        this.#touch(id);
      },
    });
    this.#objects.set(id, created);
    return created;
  }

  /**
   * Create a fresh session and return its object.
   *
   * The session is not in the registry yet: it joins the list — and the
   * durable store — when its first turn runs, so opening the application and
   * closing it again leaves no empty session behind.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const fresh = await workspace.createSession();
   * ```
   */
  async createSession(): Promise<S> {
    const id = `${this.#prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return this.#open(id);
  }

  /**
   * Open an existing session by id, registering it when the thread predates
   * the registry, and unarchiving it when it was frozen.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const revived = await workspace.openSession('session-abc');
   * ```
   */
  async openSession(id: string): Promise<S> {
    // Opening an archived session is a request to work on it again, and a
    // live object and the frozen state cannot coexist.
    const stored = this.#sessions.find((s) => s.id === id);
    if (stored?.archived) {
      stored.archived = false;
      await this.#persist();
      this.#notify();
    }
    if (!this.#sessions.some((s) => s.id === id)) {
      const now = Date.now();
      this.#sessions.push({
        id,
        title: 'untitled',
        createdAt: now,
        updatedAt: now,
        archived: false,
      });
      await this.#persist();
      this.#notify();
    }
    return this.#open(id);
  }

  /**
   * Open the most recently active unarchived session, or `null` when the
   * registry is empty.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * const latest = (await workspace.openLatest()) ?? (await workspace.createSession());
   * ```
   */
  async openLatest(): Promise<S | null> {
    const [latest] = this.list();
    if (!latest) return null;
    return this.#open(latest.id);
  }

  /**
   * Rename a session. The title is normalized and truncated the same way a
   * derived one is.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * await workspace.setTitle('session-abc', 'loader investigation');
   * ```
   */
  async setTitle(id: string, title: string): Promise<void> {
    const meta = this.#sessions.find((s) => s.id === id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    meta.title = deriveTitle(title);
    await this.#persist();
    this.#notify();
  }

  /**
   * Archive (or unarchive) a session — archived sessions drop into the
   * history list but keep their full thread and everything hanging off it.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * await workspace.archiveSession('session-abc');
   * await workspace.archiveSession('session-abc', false);
   * ```
   */
  async archiveSession(id: string, archived = true): Promise<void> {
    const meta = this.#sessions.find((s) => s.id === id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    meta.archived = archived;
    // An archived session is frozen: nothing should be able to run a turn on
    // it, so its object is released and only re-created on unarchive.
    if (archived) {
      const object = this.#objects.get(id);
      if (object !== undefined) {
        this.#objects.delete(id);
        this.#activity.delete(id);
        await this.#opts.close?.(object);
      }
    }
    await this.#persist();
    this.#notify();
  }

  /**
   * Delete a session permanently: its registry entry, every run checkpoint on
   * its thread and its sub-agent threads (`<id>:*`), the `fino:ai/subagents`
   * pool state, and any extra keys named by `metaKeys`. Files an application
   * wrote outside the store — JSONL transcripts, artifacts — are left in
   * place.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * await workspace.deleteSession('session-abc');
   * ```
   */
  async deleteSession(id: string): Promise<void> {
    const object = this.#objects.get(id);
    if (object !== undefined) {
      await this.#opts.close?.(object);
      this.#objects.delete(id);
    }
    this.#sessions = this.#sessions.filter((s) => s.id !== id);
    this.#activity.delete(id);
    const runs = await this.#store.listRuns();
    for (const run of runs) {
      if (run.threadId === id || run.threadId.startsWith(`${id}:`)) {
        await this.#store.deleteRun(run.runId);
      }
    }
    await this.#store.putMeta(`subagents:${id}`, undefined);
    for (const key of this.#opts.metaKeys?.(id) ?? []) {
      await this.#store.putMeta(key, undefined);
    }
    this.#draftModels.delete(id);
    await this.#persist();
    this.#notify();
  }

  /**
   * Close every open session object and, when the workspace opened it, the
   * shared store.
   *
   * ```ts no_run
   * import { AgentWorkspace } from 'fino:ai/workspace';
   *
   * const workspace = await AgentWorkspace.open({ create: async (id) => ({ id }) });
   * await workspace.close();
   * ```
   */
  async close(): Promise<void> {
    for (const object of this.#objects.values()) await this.#opts.close?.(object);
    this.#objects.clear();
    await this.#storeCloser?.();
  }
}
