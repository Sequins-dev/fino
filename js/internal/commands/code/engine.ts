/**
 * internal:commands/code/engine — model registry, sessions, sub-agents, and turns for `fino code`.
 *
 * `CodeEngine` owns everything about the coding agent except presentation:
 * provider discovery through the `fino:ai` model registry, per-turn agent
 * construction (so the model and the mode can change between turns
 * while the durable SQLite thread keeps the conversation), streamed turn
 * execution through `Session` with `onEvent`, the approval loop for gated
 * tools, mid-turn steering, and a `fino:ai/subagents` pool for concurrent
 * delegated work. A turn is not just one parent run: it stays active until
 * the parent run settles AND the sub-agent pool is quiescent — if the parent
 * stops while children still work, the engine waits for them and
 * auto-continues the thread with a settlement summary so the parent reviews
 * every child. `recoverTurn()` resumes crashed or suspended turns (and the
 * restored pool's children) after a process restart.
 *
 * ```ts no_run
 * import { CodeEngine } from 'internal:commands/code/engine';
 *
 * const engine = await CodeEngine.create({ cwd: '/repo' });
 * const turn = await engine.runTurn('What modules serve HTTP?', {
 *   onEvent: (ev) => {
 *     if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
 *       print(ev.event.text);
 *     }
 *   },
 * });
 * ```
 */
import { agent, type Agent } from 'fino:ai/agent';
import type { AgentEvent, ToolApprovalRequest } from 'fino:ai/runtime';
import {
  anthropic,
  anthropicProvider,
  openai,
  openaiProvider,
  modelRegistry,
  type Model,
  type ModelInfo,
  type ModelMessage,
  type ModelRegistry,
} from 'fino:ai/model';
import { Budget } from 'fino:ai/budget';
import {
  InMemorySessionStore,
  session,
  Session,
  SqliteSessionStore,
  type RunResult,
  type SessionStore,
} from 'fino:ai/session';
import { SubagentPool, subagentTools } from 'fino:ai/subagents';
import type { SubagentBuildContext, SubagentSpec, SubagentState } from 'fino:ai/subagents';
import { join } from 'fino:file/path';
import { env } from 'fino:process';
import { createCodeTools } from 'internal:commands/code/tools';
import { codeSystemPrompt } from 'internal:commands/code/prompt';
import { foldEventsToTranscript, SessionTranscript } from 'internal:commands/code/transcript';

/**
 * How much a session is allowed to do without asking.
 *
 * The three levels are one dial rather than independent switches: `plan`
 * withholds the write tools entirely, `build` offers them but suspends for
 * approval, and `auto` runs them unattended. A session's mode also sets the
 * default for the sub-agents it spawns.
 */
export type CodeMode = 'plan' | 'build' | 'auto';

/**
 * Coarse engine activity for session lists and sidebars.
 *
 * `error` is a sticky state: a turn that ended by throwing (or in a status
 * other than `done`/`suspended`) stays in it until the next turn starts
 * working. Aborted turns are `idle`, not `error` — cancelling is a normal
 * outcome, not a failure to report.
 */
export type EngineActivity = 'working' | 'waiting' | 'idle' | 'error';

/**
 * Options for `CodeEngine.create()`.
 */
export interface CodeEngineOptions {
  /** Project root the agent works in. */
  cwd: string;
  /** Initial model id; defaults to `FINO_CODE_MODEL` or a provider default. */
  model?: string;
  /** Disambiguate the initial model's provider (`anthropic` or `openai`). */
  provider?: string;
  /**
   * Use this `Model` instance directly instead of resolving one from
   * provider credentials. Intended for tests and embedders with custom
   * providers; `setModel()` still switches through the registry afterwards.
   */
  chatModel?: Model;
  /** Permission level to start in; defaults to `build`. */
  mode?: CodeMode;
  /** Cross-turn USD spend cap enforced through `fino:ai/budget`. */
  maxCostUsd?: number;
  /** Docs build directory for the docs tools. Defaults to `<cwd>/docs`. */
  docsDir?: string;
  /**
   * SQLite session database path. Defaults to `<cwd>/.fino/code/sessions.db`;
   * pass `false` to keep the session in memory.
   */
  sessionDb?: string | false;
  /**
   * Use this already-open store instead of opening one. The engine does not
   * close an injected store; `CodeWorkspace` shares one across sessions.
   */
  store?: SessionStore;
  /** Continue this exact thread id. */
  threadId?: string;
  /** Continue the most recently updated thread in the store. */
  continueThread?: boolean;
  /**
   * JSONL transcript mirror directory. Defaults to
   * `<cwd>/.fino/code/transcripts`; pass `false` to disable mirroring.
   */
  transcriptsDir?: string | false;
  /**
   * Observe coarse engine activity for session lists and sidebars:
   * `working` while a turn drives, `waiting` when suspended on an approval,
   * `error` when a turn ended badly, `idle` between turns.
   */
  onActivity?: (status: EngineActivity) => void;
  /**
   * Called with each user turn input before it runs — used by
   * `CodeWorkspace` to derive session titles and activity timestamps.
   */
  onTurn?: (input: string) => void;
  /**
   * Called whenever the model changes via `setModel()` — used by
   * `CodeWorkspace` to remember each session's model choice durably.
   */
  onModelChange?: (modelId: string) => void;
}

/**
 * What one finished turn cost, recorded durably alongside the thread.
 *
 * The conversation history holds messages, not turns: nothing in it says
 * where one turn ended or how long it took. These records fill that gap so a
 * reopened session shows the same per-turn markers it showed while running.
 */
export interface CodeTurnRecord {
  /** When the turn finished (ms since epoch). */
  at: number;
  /** How long it ran, sub-agent settlement included. */
  durationMs: number;
  /** Terminal status of the turn. */
  status: RunResult['status'];
  /** History length when it ended, which is where the marker belongs. */
  messages: number;
}

/** Store key holding a thread's turn records. */
function turnsKey(threadId: string): string {
  return `code:turns:${threadId}`;
}

/**
 * Read a thread's conversation straight from a store.
 *
 * Standalone so a session can be displayed without an engine behind it —
 * an archived session is frozen and has no live agent to ask.
 */
export async function readThreadHistory(
  store: SessionStore,
  threadId: string,
): Promise<ModelMessage[]> {
  const thread = await store.loadThread(threadId);
  if (!thread?.historyRevisionId) return [];
  const history = await store.loadHistory(thread.historyRevisionId);
  return history?.render() ?? [];
}

/** Read a thread's per-turn records straight from a store. */
export async function readThreadTurns(
  store: SessionStore,
  threadId: string,
): Promise<CodeTurnRecord[]> {
  return ((await store.getMeta(turnsKey(threadId))) as CodeTurnRecord[] | null) ?? [];
}

/**
 * A pending approval request surfaced by a suspended turn.
 */
export interface PendingApproval {
  /** Single-use resume token for `approve()`/`reject()`. */
  token: string;
  /** Tool approval request persisted by the suspension. */
  request: ToolApprovalRequest;
}

/**
 * Result of one driven turn (or approval continuation).
 */
export interface TurnResult {
  /** `done`, `suspended`, or a terminal error status from the session. */
  status: RunResult['status'];
  /** Final assistant text when the run completed. */
  text?: string;
  /** Pending tool approval when the run suspended for one. */
  approval?: PendingApproval;
  /** Suspension reason for non-approval suspensions. */
  suspendReason?: string;
}

const MAX_TURN_CONTINUATIONS = 25;
/** Turn records kept per thread; older ones fall off the front. */
const MAX_TURN_RECORDS = 500;
const NON_CHAT_MODEL_ID =
  /dall-e|whisper|\btts\b|tts-|embed|moderation|audio|realtime|image|sora|transcribe|codex-embed/i;

function isApprovalPayload(payload: unknown): payload is ToolApprovalRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'tool_approval'
  );
}

interface TurnHooks {
  onEvent?: (ev: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * Engine behind `fino code`: registry-backed models, durable streamed turns,
 * plan/build/auto modes, tool approval, steering, and sub-agent fan-out.
 *
 * Construction never touches the network; provider listings load lazily on
 * `listModels()`. The model and mode can change freely between turns — each
 * turn builds a fresh `Agent` over the same durable thread, so history
 * survives both. The parent's mode propagates to spawned sub-agents: a
 * planning-mode parent spawns read-only children unless the spawn overrides
 * it.
 */
export class CodeEngine {
  #opts: CodeEngineOptions;
  #registry: ModelRegistry;
  #store: SessionStore;
  #storeCloser?: () => Promise<void>;
  #model: Model;
  #mode: CodeMode;
  #budget?: Budget;
  #threadId: string;
  #active?: Session;
  #driving = false;
  #queuedSteer: string[] = [];
  #pool?: SubagentPool;
  #transcript?: SessionTranscript;
  #transcriptFold?: ReturnType<typeof foldEventsToTranscript>;
  #childFolds = new Map<string, ReturnType<typeof foldEventsToTranscript>>();
  #activity: EngineActivity = 'idle';
  #turnStartedAt?: number;
  #reviewPrompted = new Set<string>();
  #subagentEventListener?: (id: string, ev: AgentEvent) => void;
  #subagentStatusListener?: (id: string, state: SubagentState) => void;

  private constructor(
    opts: CodeEngineOptions,
    registry: ModelRegistry,
    store: SessionStore,
    model: Model,
    threadId: string,
    storeCloser?: () => Promise<void>,
  ) {
    this.#opts = opts;
    this.#registry = registry;
    this.#store = store;
    this.#model = model;
    this.#mode = opts.mode ?? 'build';
    this.#threadId = threadId;
    this.#storeCloser = storeCloser;
    if (opts.maxCostUsd !== undefined) this.#budget = new Budget({ usd: opts.maxCostUsd });
    const mirror =
      opts.transcriptsDir !== false &&
      !(opts.transcriptsDir === undefined && opts.sessionDb === false);
    if (mirror) {
      const dir = opts.transcriptsDir ?? join(opts.cwd, '.fino', 'code', 'transcripts').toString();
      this.#transcript = new SessionTranscript(dir, threadId);
      this.#transcriptFold = foldEventsToTranscript(this.#transcript.parent());
    }
  }

  /**
   * Create an engine: build the provider registry from available credentials,
   * pick the initial model, open (or create) the session store, and restore
   * any persisted sub-agent pool for a continued thread.
   *
   * Throws when no provider credentials are configured, naming the
   * environment variables that would fix it.
   */
  static async create(opts: CodeEngineOptions): Promise<CodeEngine> {
    const registry = modelRegistry();
    const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
    const hasOpenAI = Boolean(env.OPENAI_API_KEY ?? env.OPENAI_BASE_URL);
    if (hasAnthropic) registry.add(anthropicProvider());
    if (hasOpenAI) {
      registry.add(
        openaiProvider({
          ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
          ...(env.OPENAI_API_KEY ? {} : { apiKey: 'local' }),
        }),
      );
    }
    if (!opts.chatModel && !hasAnthropic && !hasOpenAI) {
      throw new Error(
        'fino code: no model provider configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENAI_BASE_URL',
      );
    }
    const model =
      opts.chatModel ??
      createModelDirect(opts.model ?? env.FINO_CODE_MODEL, opts.provider, {
        hasAnthropic,
        hasOpenAI,
      });
    let store: SessionStore;
    let storeCloser: (() => Promise<void>) | undefined;
    if (opts.store) {
      store = opts.store;
    } else if (opts.sessionDb === false) {
      store = new InMemorySessionStore();
    } else {
      const path = opts.sessionDb ?? join(opts.cwd, '.fino', 'code', 'sessions.db').toString();
      const { DiskFileSystem } = await import('fino:file');
      const { dirname } = await import('fino:file/path');
      const fs = new DiskFileSystem();
      const parent = dirname(path).toString();
      try {
        await fs.mkdir(parent);
      } catch (_) {
        try {
          await fs.mkdir(dirname(parent).toString());
          await fs.mkdir(parent);
        } catch (_) {
          // already exists, or open() below will report the real problem
        }
      }
      const sqlite = await SqliteSessionStore.open(path);
      store = sqlite;
      storeCloser = () => sqlite.close();
    }
    const continuing = Boolean(opts.threadId || opts.continueThread);
    let threadId = opts.threadId;
    if (!threadId && opts.continueThread) {
      const runs = await store.listRuns();
      const latest = runs.filter((run) => !run.threadId.includes(':')).pop();
      threadId = latest?.threadId;
    }
    threadId ??= `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const engine = new CodeEngine(opts, registry, store, model, threadId, storeCloser);
    if (continuing || opts.continueThread) await engine.#restorePool();
    return engine;
  }

  async #restorePool(): Promise<void> {
    this.#pool = await SubagentPool.restore(this.#poolOptions());
  }

  #childFold(id: string): ReturnType<typeof foldEventsToTranscript> | undefined {
    if (!this.#transcript) return undefined;
    let fold = this.#childFolds.get(id);
    if (!fold) {
      fold = foldEventsToTranscript(this.#transcript.child(id));
      this.#childFolds.set(id, fold);
    }
    return fold;
  }

  #poolOptions() {
    return {
      id: this.#threadId,
      store: this.#store,
      buildAgent: (spec: SubagentSpec, ctx: SubagentBuildContext) =>
        this.#buildChildAgent(spec, ctx),
      onEvent: (id: string, ev: AgentEvent) => {
        this.#childFold(id)?.onEvent(ev);
        try {
          this.#subagentEventListener?.(id, ev);
        } catch (_) {
          // observer errors must not fail child runs
        }
      },
      onStatus: (id: string, state: SubagentState) => {
        if (this.#transcript && state.status !== 'working') {
          this.#childFold(id)?.flush();
          this.#transcript.parent().append({
            type: 'subagent_status',
            id,
            name: state.name,
            status: state.status,
            ...(state.doneReport ? { doneReport: state.doneReport } : {}),
            ...(state.error ? { error: state.error } : {}),
          });
        }
        try {
          this.#subagentStatusListener?.(id, state);
        } catch (_) {
          // observer errors must not fail transitions
        }
      },
      onSend: (id: string, message: string) => {
        this.#transcript?.child(id).append({ type: 'user', text: message });
      },
    };
  }

  #ensurePool(): SubagentPool {
    this.#pool ??= new SubagentPool(this.#poolOptions());
    return this.#pool;
  }

  async #buildChildAgent(spec: SubagentSpec, ctx: SubagentBuildContext): Promise<{ agent: Agent }> {
    // Mutating the spec records the spawn-time default durably: the pool
    // persists this same object, so a restore rebuilds identical powers even
    // if the parent's mode changed since.
    spec.readOnly ??= this.planMode;
    const model = spec.model ? await this.#resolveModel(spec.model) : this.#model;
    return {
      agent: agent({
        name: `fino-code:${spec.name ?? ctx.id}`,
        model,
        instructions: codeSystemPrompt({ cwd: this.#opts.cwd, role: 'subagent' }),
        tools: [
          ...createCodeTools({
            cwd: this.#opts.cwd,
            docsDir: this.#opts.docsDir,
            writes: !spec.readOnly,
            auto: this.auto,
          }),
          ctx.completeTool,
        ],
        ...(this.#budget ? { budget: this.#budget } : {}),
      }),
    };
  }

  async #resolveModel(id: string, opts: { provider?: string } = {}): Promise<Model> {
    try {
      return await this.#registry.create(id, opts);
    } catch (_) {
      return createModelDirect(id, opts.provider, {
        hasAnthropic: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAI: Boolean(env.OPENAI_API_KEY ?? env.OPENAI_BASE_URL),
      });
    }
  }

  /** Current model id shown in status displays. */
  get modelId(): string {
    return this.#model.id ?? this.#model.name;
  }

  /** The permission level in effect for the next turn. */
  get mode(): CodeMode {
    return this.#mode;
  }

  /** Whether the current mode withholds write tools. */
  get planMode(): boolean {
    return this.#mode === 'plan';
  }

  /** Current durable thread id. */
  get threadId(): string {
    return this.#threadId;
  }

  /** Whether the current mode runs gated tools without approval. */
  get auto(): boolean {
    return this.#mode === 'auto';
  }

  /** Switch the permission level for subsequent turns; history is preserved. */
  setMode(mode: CodeMode): void {
    this.#mode = mode;
  }

  /** Start a fresh thread; the old thread and its sub-agents stay stored. */
  newThread(): string {
    this.#threadId = `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.#active = undefined;
    this.#pool = undefined;
    this.#queuedSteer = [];
    this.#reviewPrompted = new Set();
    if (this.#transcript) {
      void this.#transcript.close();
      const dir =
        this.#opts.transcriptsDir === false
          ? undefined
          : (this.#opts.transcriptsDir ??
            join(this.#opts.cwd, '.fino', 'code', 'transcripts').toString());
      if (dir) {
        this.#transcript = new SessionTranscript(dir, this.#threadId);
        this.#transcriptFold = foldEventsToTranscript(this.#transcript.parent());
        this.#childFolds = new Map();
      }
    }
    return this.#threadId;
  }

  /**
   * List chat-usable models discovered across the configured providers.
   *
   * Image, audio, embedding, and other non-text models are filtered out:
   * the agent can only drive models that hold a text conversation and call
   * tools, so listing anything else is noise.
   */
  async listModels(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    const models = await this.#registry.list(opts);
    return models.filter((info) => {
      if (info.capabilities?.toolCalling === false) return false;
      if (info.capabilities?.input && info.capabilities.input.text === false) return false;
      return !NON_CHAT_MODEL_ID.test(info.id);
    });
  }

  /**
   * Switch the model used for subsequent turns.
   *
   * Resolves the id through the registry first; when discovery is
   * unavailable the id falls back to direct provider construction by prefix.
   */
  async setModel(id: string, opts: { provider?: string } = {}): Promise<void> {
    let resolved: Model;
    try {
      resolved = await this.#registry.create(id, opts);
    } catch (_) {
      let catalog: ModelInfo[] = [];
      try {
        catalog = await this.#registry.list();
      } catch (_) {
        catalog = [];
      }
      if (catalog.length > 0) {
        throw new Error(`Model "${id}" not found across configured providers`);
      }
      // No live catalog to validate against (offline, or listing
      // unsupported): fall back to direct construction by id.
      resolved = createModelDirect(id, opts.provider, {
        hasAnthropic: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAI: Boolean(env.OPENAI_API_KEY ?? env.OPENAI_BASE_URL),
      });
    }
    this.#model = resolved;
    try {
      this.#opts.onModelChange?.(this.modelId);
    } catch (_) {
      // observer errors must not fail model switches
    }
  }

  /**
   * Deliver a mid-turn steering message to the parent agent.
   *
   * While a parent run is driving, the message injects at its next step
   * boundary; between runs (for example while the engine waits on
   * sub-agents) it queues and is prepended to the next run's input, so
   * steering is never lost.
   */
  steer(message: string): void {
    if (this.#driving && this.#active) {
      this.#transcript?.parent().append({ type: 'steer', text: message });
      this.#active.steer(message);
      return;
    }
    this.#queuedSteer.push(message);
  }

  /** Snapshot of all sub-agents on the current thread. */
  subagentStates(): SubagentState[] {
    return (this.#pool?.status() as SubagentState[] | undefined) ?? [];
  }

  /** Receive every sub-agent's agent events (transcript streaming). */
  onSubagentEvent(listener: (id: string, ev: AgentEvent) => void): void {
    this.#subagentEventListener = listener;
  }

  /** Receive sub-agent status transitions (tabs, approval popover). */
  onSubagentStatus(listener: (id: string, state: SubagentState) => void): void {
    this.#subagentStatusListener = listener;
  }

  /** Render a sub-agent's durable conversation history. */
  subagentHistory(id: string): Promise<ModelMessage[]> {
    const pool = this.#pool;
    if (!pool) return Promise.resolve([]);
    return pool.history(id);
  }

  /** Render this session's durable main-thread history. */
  async history(): Promise<ModelMessage[]> {
    return readThreadHistory(this.#store, this.#threadId);
  }

  /**
   * Per-turn records for this thread, oldest first.
   *
   * Kept in the session store beside the conversation — the same durable
   * place the sub-agent registry lives — so reopening a thread restores the
   * turn markers rather than rebuilding them from the JSONL mirror, which is
   * a mirror precisely so nothing depends on it.
   */
  async turns(): Promise<CodeTurnRecord[]> {
    return readThreadTurns(this.#store, this.#threadId);
  }

  #turnsKey(): string {
    return turnsKey(this.#threadId);
  }

  async #recordTurn(durationMs: number, status: RunResult['status']): Promise<void> {
    try {
      const messages = (await this.history()).length;
      const turns = await this.turns();
      turns.push({ at: Date.now(), durationMs, status, messages });
      await this.#store.putMeta(
        this.#turnsKey(),
        turns.length > MAX_TURN_RECORDS ? turns.slice(-MAX_TURN_RECORDS) : turns,
      );
    } catch (_) {
      // Bookkeeping must never fail a turn that already completed.
    }
  }

  /** Approve a sub-agent's pending gated tool call. */
  approveSubagent(id: string): void {
    this.#pool?.approve(id);
  }

  /** Reject a sub-agent's pending gated tool call. */
  rejectSubagent(id: string, reason?: string): void {
    this.#pool?.reject(id, reason);
  }

  /** Cancel a sub-agent's current run. */
  cancelSubagent(id: string): void {
    this.#pool?.cancel(id);
  }

  #buildAgent(): Agent {
    const pool = this.#ensurePool();
    return agent({
      name: 'fino-code',
      model: this.#model,
      instructions: codeSystemPrompt({
        cwd: this.#opts.cwd,
        planMode: this.planMode,
        subagents: true,
      }),
      tools: [
        ...createCodeTools({
          cwd: this.#opts.cwd,
          docsDir: this.#opts.docsDir,
          writes: !this.planMode,
          auto: this.auto,
        }),
        ...subagentTools(pool),
      ],
      ...(this.#budget ? { budget: this.#budget } : {}),
    });
  }

  #setActivity(activity: EngineActivity): void {
    if (this.#activity === activity) return;
    this.#activity = activity;
    try {
      this.#opts.onActivity?.(activity);
    } catch (_) {
      // observer errors must not fail turns
    }
  }

  /** Coarse activity for session lists: working, waiting, error, or idle. */
  get activity(): EngineActivity {
    return this.#activity;
  }

  // Cancelling a turn is a normal outcome, so only genuine failures leave the
  // session showing an error for the session list to surface.
  #settleActivity(err: unknown): void {
    this.#setActivity((err as Error | undefined)?.name === 'AbortError' ? 'idle' : 'error');
  }

  #turnEvents(hooks: TurnHooks): ((ev: AgentEvent) => void) | undefined {
    const fold = this.#transcriptFold;
    if (!fold) return hooks.onEvent;
    if (!hooks.onEvent) return fold.onEvent;
    const external = hooks.onEvent;
    return (ev) => {
      fold.onEvent(ev);
      external(ev);
    };
  }

  async #driveTracked(run: () => Promise<RunResult>): Promise<RunResult> {
    this.#driving = true;
    this.#setActivity('working');
    try {
      return await run();
    } finally {
      this.#driving = false;
    }
  }

  async #runOnThread(input: string, hooks: TurnHooks): Promise<RunResult> {
    const onEvent = this.#turnEvents(hooks);
    const sess = session({
      store: this.#store,
      agent: this.#buildAgent(),
      threadId: this.#threadId,
      ...(onEvent ? { onEvent } : {}),
    });
    this.#active = sess;
    const steered = this.#queuedSteer.splice(0);
    for (const text of steered) this.#transcript?.parent().append({ type: 'steer', text });
    this.#transcript?.parent().append({ type: 'user', text: input });
    const messages: ModelMessage[] = [
      ...steered.map((content): ModelMessage => ({ role: 'user', content })),
      { role: 'user', content: input },
    ];
    return this.#driveTracked(() => sess.start({ messages }, { signal: hooks.signal }));
  }

  #settlementMessage(settled: SubagentState[]): string {
    const lines = settled
      .filter((s) => s.status !== 'done')
      .map((s) => {
        this.#reviewPrompted.add(`${s.id}:${s.status}:${s.doneReport ?? ''}`);
        const detail = s.doneReport ?? s.lastText ?? s.error ?? '';
        return `- ${s.id} (${s.name}) [${s.status}] ${detail}`.trimEnd();
      });
    return [
      '[subagent settlement] The following sub-agents have settled and need your attention.',
      'Review each: subagent_finalize to accept a done report, subagent_send to iterate, or report their failure to the user.',
      ...lines,
    ].join('\n');
  }

  #needsSettlementPrompt(): boolean {
    const pool = this.#pool;
    if (!pool) return false;
    return (pool.status() as SubagentState[]).some(
      (s) =>
        s.status === 'awaiting_review' &&
        !this.#reviewPrompted.has(`${s.id}:${s.status}:${s.doneReport ?? ''}`),
    );
  }

  async #finishTurn(result: RunResult, hooks: TurnHooks): Promise<TurnResult> {
    if (result.unconsumedSteering?.length) this.#queuedSteer.unshift(...result.unconsumedSteering);
    let continuations = 0;
    while (result.status === 'done' && continuations < MAX_TURN_CONTINUATIONS) {
      const pool = this.#pool;
      if (!pool) break;
      if (!pool.active && !this.#needsSettlementPrompt()) break;
      const settled = await pool.waitForSettled({ signal: hooks.signal });
      const message = this.#settlementMessage(settled);
      continuations += 1;
      result = await this.#runOnThread(message, hooks);
      if (result.unconsumedSteering?.length) {
        this.#queuedSteer.unshift(...result.unconsumedSteering);
      }
    }
    const turn = this.#toTurn(result);
    this.#transcriptFold?.flush();
    if (turn.status !== 'suspended') {
      // Duration spans the whole turn, sub-agent settlement included, which
      // is what the interface reports when the turn finishes.
      const durationMs = Date.now() - (this.#turnStartedAt ?? Date.now());
      this.#turnStartedAt = undefined;
      this.#transcript?.parent().append({
        type: 'turn_end',
        status: turn.status,
        durationMs,
      });
      await this.#recordTurn(durationMs, turn.status);
    }
    if (turn.status === 'suspended') this.#setActivity('waiting');
    else if (turn.status === 'done' || turn.status === 'cancelled') this.#setActivity('idle');
    else this.#setActivity('error');
    return turn;
  }

  /**
   * Run one durable, streamed turn on the current thread.
   *
   * Events flow through `onEvent` while the session checkpoints each step.
   * When a gated tool suspends, the returned `TurnResult` carries the
   * approval request; continue with `approve()` or `reject()`. The turn does
   * not complete while sub-agents are active: if the parent run ends first,
   * the engine waits for the pool to settle and auto-continues the thread
   * with a settlement summary for review.
   */
  async runTurn(input: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    this.#turnStartedAt = Date.now();
    try {
      this.#opts.onTurn?.(input);
    } catch (_) {
      // observer errors must not fail turns
    }
    try {
      return await this.#finishTurn(await this.#runOnThread(input, hooks), hooks);
    } catch (err) {
      this.#settleActivity(err);
      throw err;
    }
  }

  /**
   * Approve the pending gated tool call and continue the run.
   */
  async approve(token: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    const active = this.#active;
    if (!active) throw new Error('No active session to approve');
    this.#transcript?.parent().append({ type: 'approval_decision', approved: true });
    try {
      return await this.#finishTurn(
        await this.#driveTracked(() => active.approveTool(token, { signal: hooks.signal })),
        hooks,
      );
    } catch (err) {
      this.#settleActivity(err);
      throw err;
    }
  }

  /**
   * Reject the pending gated tool call with a model-visible reason and
   * continue the run.
   */
  async reject(token: string, reason?: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    const active = this.#active;
    if (!active) throw new Error('No active session to reject');
    this.#transcript?.parent().append({
      type: 'approval_decision',
      approved: false,
      ...(reason ? { reason } : {}),
    });
    try {
      return await this.#finishTurn(
        await this.#driveTracked(() => active.rejectTool(token, reason, { signal: hooks.signal })),
        hooks,
      );
    } catch (err) {
      this.#settleActivity(err);
      throw err;
    }
  }

  /**
   * Resume an interrupted turn after a restart, or return `null` when the
   * continued thread has nothing to recover.
   *
   * A latest run checkpointed `running` or `error` is re-driven from its
   * committed history; a `suspended` run re-surfaces its approval request;
   * and a thread whose parent finished but whose restored sub-agents are
   * still active re-enters the settlement loop.
   */
  async recoverTurn(hooks: TurnHooks = {}): Promise<TurnResult | null> {
    const runs = await this.#store.listRuns({ threadId: this.#threadId });
    const latest = runs[runs.length - 1];
    const onEvent = this.#turnEvents(hooks);
    if (latest && (latest.status === 'running' || latest.status === 'error')) {
      const sess = await Session.attach({
        store: this.#store,
        agent: this.#buildAgent(),
        threadId: this.#threadId,
        runId: latest.runId,
        ...(onEvent ? { onEvent } : {}),
      });
      this.#active = sess;
      return this.#finishTurn(
        await this.#driveTracked(() => sess.redrive({ signal: hooks.signal })),
        hooks,
      );
    }
    if (latest && latest.status === 'suspended') {
      const sess = await Session.attach({
        store: this.#store,
        agent: this.#buildAgent(),
        threadId: this.#threadId,
        runId: latest.runId,
        ...(onEvent ? { onEvent } : {}),
      });
      this.#active = sess;
      this.#setActivity('waiting');
      return this.#toTurn({ runId: latest.runId, status: 'suspended', state: latest });
    }
    if (this.#pool && (this.#pool.active || this.#needsSettlementPrompt())) {
      const settled = await this.#pool.waitForSettled({ signal: hooks.signal });
      const message = this.#settlementMessage(settled);
      return this.#finishTurn(await this.#runOnThread(message, hooks), hooks);
    }
    return null;
  }

  /**
   * Close the transcript mirror and, when this engine opened its own store,
   * the session store. Injected (workspace-shared) stores stay open.
   */
  async close(): Promise<void> {
    await this.#transcript?.close();
    await this.#storeCloser?.();
  }

  #toTurn(result: RunResult): TurnResult {
    if (result.status === 'suspended') {
      const suspendedOn = result.state.suspendedOn;
      if (suspendedOn && isApprovalPayload(suspendedOn.payload)) {
        this.#transcript?.parent().append({
          type: 'approval_request',
          tool: suspendedOn.payload.toolName,
          args: suspendedOn.payload.args ?? {},
        });
        return {
          status: 'suspended',
          approval: { token: suspendedOn.token, request: suspendedOn.payload },
        };
      }
      return { status: 'suspended', suspendReason: suspendedOn?.reason };
    }
    return { status: result.status, text: result.text };
  }
}

function createModelDirect(
  id: string | undefined,
  provider: string | undefined,
  available: { hasAnthropic: boolean; hasOpenAI: boolean },
): Model {
  const wantsAnthropic =
    provider === 'anthropic' || (provider === undefined && (id?.startsWith('claude') ?? true));
  if (wantsAnthropic && available.hasAnthropic) {
    return anthropic(id ? { model: id } : {});
  }
  if (provider === 'anthropic') {
    throw new Error('fino code: ANTHROPIC_API_KEY is not set');
  }
  if (available.hasOpenAI) {
    return openai({
      ...(id ? { model: id } : {}),
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
      ...(env.OPENAI_API_KEY ? {} : { apiKey: 'local' }),
    });
  }
  if (available.hasAnthropic) {
    return anthropic(id ? { model: id } : {});
  }
  throw new Error('fino code: no provider available for the requested model');
}
