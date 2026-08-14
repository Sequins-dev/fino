/**
 * internal:commands/code/workspace — the multi-session registry behind `fino code`.
 *
 * The registry itself is generic and lives in `fino:ai/workspace`: session
 * ids, titles, timestamps, archived flags, activity tracking, and the
 * lifecycle of one object per session. `CodeWorkspace` binds that machinery
 * to `CodeEngine` — it supplies the engine factory, the `code:sessions`
 * metadata key and `code-` id prefix that name this application's registry,
 * the per-session turn records to sweep on delete, and the engine-less read
 * path archived sessions are displayed through.
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
import type { SessionStore } from 'fino:ai/session';
import { join } from 'fino:file/path';
import {
  AgentWorkspace,
  type AgentSessionActivity,
  type AgentSessionMeta,
  type AttentionSummary,
} from 'fino:ai/workspace';
import {
  CodeEngine,
  readThreadHistory,
  readThreadTurns,
  type CodeEngineOptions,
  type CodeTurnRecord,
} from 'internal:commands/code/engine';
import type { ModelMessage } from 'fino:ai/model';

/**
 * Registry entry for one `fino code` session.
 */
export type CodeSessionMeta = AgentSessionMeta;

/**
 * Coarse activity of a session for list indicators.
 */
export type CodeSessionActivity = AgentSessionActivity;

/**
 * Options for `CodeWorkspace.open()` — engine defaults applied to every
 * session, minus the per-session fields the workspace itself manages.
 */
export type CodeWorkspaceOptions = Omit<
  CodeEngineOptions,
  'store' | 'threadId' | 'continueThread' | 'onActivity' | 'onTurn'
>;

const REGISTRY_KEY = 'code:sessions';

/**
 * Shared-store session registry and engine factory for `fino code`.
 */
export class CodeWorkspace {
  #opts: CodeWorkspaceOptions;
  #inner: AgentWorkspace<CodeEngine>;

  private constructor(opts: CodeWorkspaceOptions, inner: AgentWorkspace<CodeEngine>) {
    this.#opts = opts;
    this.#inner = inner;
  }

  /**
   * Open the workspace: open (or create) the shared store and load the
   * session registry.
   */
  static async open(opts: CodeWorkspaceOptions): Promise<CodeWorkspace> {
    const path =
      opts.sessionDb === false
        ? undefined
        : (opts.sessionDb ?? join(opts.cwd, '.fino', 'code', 'sessions.db').toString());
    const inner = await AgentWorkspace.open<CodeEngine>({
      ...(path !== undefined ? { path } : {}),
      key: REGISTRY_KEY,
      idPrefix: 'code',
      metaKeys: (id) => [`code:turns:${id}`],
      close: (engine) => engine.close(),
      create: (id, ctx) =>
        CodeEngine.create({
          ...opts,
          ...(ctx.meta?.model && !opts.chatModel ? { model: ctx.meta.model } : {}),
          store: ctx.store,
          threadId: id,
          onModelChange: ctx.onModel,
          onActivity: ctx.onActivity,
          onTurn: ctx.onTurn,
        }),
    });
    return new CodeWorkspace(opts, inner);
  }

  /** The shared session store. */
  get store(): SessionStore {
    return this.#inner.store;
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
    return this.#inner.list(opts);
  }

  /** Registry entry for one session, or `undefined`. */
  meta(id: string): CodeSessionMeta | undefined {
    return this.#inner.meta(id);
  }

  /** Coarse activity for list indicators; unopened sessions are idle. */
  activity(id: string): CodeSessionActivity {
    return this.#inner.activity(id);
  }

  /**
   * Retire a session's unread `done` or `error` flag once the user has looked
   * at its result.
   */
  markSeen(id: string): void {
    this.#inner.markSeen(id);
  }

  /**
   * What the other sessions need from the user, folded into one set of flags
   * for a single indicator in the interface.
   */
  attentionSummary(excludeId?: string): AttentionSummary {
    return this.#inner.attentionSummary(excludeId);
  }

  /** The cached engine for an already-opened session, if any. */
  engineFor(id: string): CodeEngine | undefined {
    return this.#inner.sessionFor(id);
  }

  /** Subscribe to registry and activity changes; returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    return this.#inner.onChange(listener);
  }

  /**
   * Create a fresh session and return its engine.
   *
   * The session is not in the registry yet: it joins the list — and the
   * durable store — when its first turn runs.
   */
  async createSession(): Promise<CodeEngine> {
    return this.#inner.createSession();
  }

  /**
   * Open an existing session by id, registering it when the thread predates
   * the registry.
   */
  async openSession(id: string): Promise<CodeEngine> {
    return this.#inner.openSession(id);
  }

  /**
   * Open the most recently active unarchived session, or `null` when the
   * registry is empty.
   */
  async openLatest(): Promise<CodeEngine | null> {
    return this.#inner.openLatest();
  }

  /**
   * Rename a session.
   */
  async setTitle(id: string, title: string): Promise<void> {
    await this.#inner.setTitle(id, title);
  }

  /**
   * Archive (or unarchive) a session — archived sessions drop into the
   * history list but keep their full thread, sub-agents, and transcripts.
   */
  async archiveSession(id: string, archived = true): Promise<void> {
    await this.#inner.archiveSession(id, archived);
  }

  /**
   * Read an archived session's conversation without opening an engine.
   *
   * Archived sessions have no live agent behind them, so their transcript is
   * loaded straight from the store for display.
   */
  async readSession(id: string): Promise<{ messages: ModelMessage[]; turns: CodeTurnRecord[] }> {
    return {
      messages: await readThreadHistory(this.store, id),
      turns: await readThreadTurns(this.store, id),
    };
  }

  /**
   * Delete a session permanently: its registry entry, every run checkpoint
   * on its thread and its sub-agent threads, the persisted sub-agent pool,
   * and its turn records. JSONL transcript mirrors on disk are left in place
   * as the audit trail of record.
   */
  async deleteSession(id: string): Promise<void> {
    await this.#inner.deleteSession(id);
  }

  /**
   * Close every open engine and the shared store.
   */
  async close(): Promise<void> {
    await this.#inner.close();
  }
}
