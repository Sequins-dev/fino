/**
 * internal:commands/code/workspace — the multi-session registry behind `fino code`.
 *
 * A `CodeWorkspace` owns one shared session store and the durable registry
 * of user-level sessions in it: their ids (thread ids), auto-derived titles,
 * activity timestamps, and archived flags, persisted under the store's
 * `code:sessions` metadata key. Each open session is a `CodeEngine` bound to
 * the shared store, so several sessions can run turns concurrently while
 * the workspace tracks which is working, waiting for input, or idle — the
 * data model behind the sidebar and `fino code sessions`.
 *
 * ```ts no_run
 * import { CodeWorkspace } from 'internal:commands/code/workspace';
 *
 * const workspace = await CodeWorkspace.open({ cwd: '/repo' });
 * const engine = await workspace.createSession();
 * await engine.runTurn('hello');
 * for (const meta of workspace.list()) console.log(meta.id, meta.title);
 * await workspace.close();
 * ```
 */
import { InMemorySessionStore, SqliteSessionStore, type SessionStore } from 'fino:ai/session';
import { DiskFileSystem } from 'fino:file';
import { dirname, join } from 'fino:file/path';
import {
  CodeEngine,
  readThreadHistory,
  readThreadTurns,
  type CodeEngineOptions,
  type CodeTurnRecord,
} from 'internal:commands/code/engine';
import type { ModelMessage } from 'fino:ai/model';

/**
 * Registry entry for one user-level session.
 */
export interface CodeSessionMeta {
  /** Session id — the durable thread id (`--thread <id>` reopens it). */
  id: string;
  /** Human title, derived from the first prompt; `/title` renames. */
  title: string;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** Last activity timestamp (ms); active session lists sort by this. */
  updatedAt: number;
  /** Archived sessions drop into the history list. */
  archived: boolean;
  /** Model id chosen for this session; restored when the session reopens. */
  model?: string;
}

/**
 * Coarse activity of a session for list indicators.
 *
 * `done` is the workspace's own state, not the engine's: a turn that finished
 * while the user was looking at another session stays `done` until
 * `markSeen()` retires it, so the sidebar can flag unread results.
 */
export type CodeSessionActivity = 'working' | 'waiting' | 'idle' | 'error' | 'done';

/**
 * Options for `CodeWorkspace.open()` — engine defaults applied to every
 * session, minus the per-session fields the workspace itself manages.
 */
export type CodeWorkspaceOptions = Omit<
  CodeEngineOptions,
  'store' | 'threadId' | 'continueThread' | 'onActivity' | 'onTurn'
>;

const REGISTRY_KEY = 'code:sessions';
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
 * Shared-store session registry and engine factory for `fino code`.
 *
 * Engines are cached per session id; `onChange` observers fire on every
 * registry or activity transition so UIs can re-render session lists.
 */
export class CodeWorkspace {
  #opts: CodeWorkspaceOptions;
  #store: SessionStore;
  #storeCloser?: () => Promise<void>;
  #sessions: CodeSessionMeta[] = [];
  #engines = new Map<string, CodeEngine>();
  #draftModels = new Map<string, string>();
  #activity = new Map<string, CodeSessionActivity>();
  #listeners = new Set<() => void>();

  private constructor(
    opts: CodeWorkspaceOptions,
    store: SessionStore,
    sessions: CodeSessionMeta[],
    storeCloser?: () => Promise<void>,
  ) {
    this.#opts = opts;
    this.#store = store;
    this.#sessions = sessions;
    this.#storeCloser = storeCloser;
  }

  /**
   * Open the workspace: open (or create) the shared store and load the
   * session registry.
   */
  static async open(opts: CodeWorkspaceOptions): Promise<CodeWorkspace> {
    let store: SessionStore;
    let storeCloser: (() => Promise<void>) | undefined;
    if (opts.sessionDb === false) {
      store = new InMemorySessionStore();
    } else {
      const path = opts.sessionDb ?? join(opts.cwd, '.fino', 'code', 'sessions.db').toString();
      await mkdirRecursive(new DiskFileSystem(), dirname(path).toString());
      const sqlite = await SqliteSessionStore.open(path);
      store = sqlite;
      storeCloser = () => sqlite.close();
    }
    const sessions = ((await store.getMeta(REGISTRY_KEY)) as CodeSessionMeta[] | null) ?? [];
    return new CodeWorkspace(opts, store, sessions, storeCloser);
  }

  /** The shared session store. */
  get store(): SessionStore {
    return this.#store;
  }

  /** Project root every session in this workspace works in. */
  get cwd(): string {
    return this.#opts.cwd;
  }

  /**
   * Registry snapshot: active sessions by default (most recent first), or
   * archived ones with `archived: true`.
   */
  list(opts: { archived?: boolean } = {}): CodeSessionMeta[] {
    const archived = opts.archived ?? false;
    return this.#sessions
      .filter((s) => s.archived === archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ ...s }));
  }

  /** Registry entry for one session, or `undefined`. */
  meta(id: string): CodeSessionMeta | undefined {
    const found = this.#sessions.find((s) => s.id === id);
    return found ? { ...found } : undefined;
  }

  /** Coarse activity for list indicators; unopened sessions are idle. */
  activity(id: string): CodeSessionActivity {
    return this.#activity.get(id) ?? 'idle';
  }

  /**
   * Retire a session's unread `done` or `error` flag once the user has looked
   * at its result.
   */
  markSeen(id: string): void {
    const current = this.#activity.get(id);
    if (current !== 'done' && current !== 'error') return;
    this.#activity.set(id, 'idle');
    this.#notify();
  }

  /**
   * What the other sessions need from the user, folded into one set of flags
   * for a single indicator in the interface.
   *
   * `excludeId` drops the session the user is already looking at.
   */
  attentionSummary(excludeId?: string): {
    input: boolean;
    error: boolean;
    done: boolean;
    busy: boolean;
  } {
    const summary = { input: false, error: false, done: false, busy: false };
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

  /** The cached engine for an already-opened session, if any. */
  engineFor(id: string): CodeEngine | undefined {
    return this.#engines.get(id);
  }

  /** Subscribe to registry and activity changes; returns an unsubscribe. */
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
      await this.#store.putMeta(REGISTRY_KEY, this.#sessions);
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

  async #openEngine(id: string): Promise<CodeEngine> {
    const cached = this.#engines.get(id);
    if (cached) return cached;
    const stored = this.#sessions.find((s) => s.id === id);
    const engine = await CodeEngine.create({
      ...this.#opts,
      ...(stored?.model && !this.#opts.chatModel ? { model: stored.model } : {}),
      store: this.#store,
      threadId: id,
      onModelChange: (modelId) => {
        const meta = this.#sessions.find((s) => s.id === id);
        if (!meta) {
          // Chosen in a blank chat: held until the session registers.
          this.#draftModels.set(id, modelId);
          return;
        }
        meta.model = modelId;
        void this.#persist();
      },
      onActivity: (status) => {
        const settled = status === 'idle' && this.#activity.get(id) === 'working';
        this.#activity.set(id, settled ? 'done' : status);
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
    this.#engines.set(id, engine);
    return engine;
  }

  /**
   * Create a fresh session and return its engine.
   *
   * The session is not in the registry yet: it joins the list — and the
   * durable store — when its first turn runs, so opening the app and closing
   * it again leaves no empty session behind.
   */
  async createSession(): Promise<CodeEngine> {
    const id = `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return this.#openEngine(id);
  }

  /**
   * Open an existing session by id, registering it when the thread predates
   * the registry.
   */
  async openSession(id: string): Promise<CodeEngine> {
    // Opening an archived session is a request to work on it again, and a
    // live engine and the frozen state cannot coexist.
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
    return this.#openEngine(id);
  }

  /**
   * Open the most recently active unarchived session, or `null` when the
   * registry is empty.
   */
  async openLatest(): Promise<CodeEngine | null> {
    const [latest] = this.list();
    if (!latest) return null;
    return this.#openEngine(latest.id);
  }

  /**
   * Rename a session.
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
   * history list but keep their full thread, sub-agents, and transcripts.
   */
  async archiveSession(id: string, archived = true): Promise<void> {
    const meta = this.#sessions.find((s) => s.id === id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    meta.archived = archived;
    // An archived session is frozen: nothing should be able to run a turn on
    // it, so its engine is released and only re-created on unarchive.
    if (archived) {
      const engine = this.#engines.get(id);
      if (engine) {
        this.#engines.delete(id);
        this.#activity.delete(id);
        await engine.close();
      }
    }
    await this.#persist();
    this.#notify();
  }

  /**
   * Read an archived session's conversation without opening an engine.
   *
   * Archived sessions have no live agent behind them, so their transcript is
   * loaded straight from the store for display.
   */
  async readSession(id: string): Promise<{ messages: ModelMessage[]; turns: CodeTurnRecord[] }> {
    return {
      messages: await readThreadHistory(this.#store, id),
      turns: await readThreadTurns(this.#store, id),
    };
  }

  /**
   * Delete a session permanently: its registry entry, every run checkpoint
   * on its thread and its sub-agent threads, and the persisted sub-agent
   * pool. JSONL transcript mirrors on disk are left in place as the audit
   * trail of record.
   */
  async deleteSession(id: string): Promise<void> {
    const engine = this.#engines.get(id);
    if (engine) {
      await engine.close();
      this.#engines.delete(id);
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
    await this.#store.putMeta(`code:turns:${id}`, undefined);
    this.#draftModels.delete(id);
    await this.#persist();
    this.#notify();
  }

  /**
   * Close every open engine and the shared store.
   */
  async close(): Promise<void> {
    for (const engine of this.#engines.values()) await engine.close();
    this.#engines.clear();
    await this.#storeCloser?.();
  }
}
