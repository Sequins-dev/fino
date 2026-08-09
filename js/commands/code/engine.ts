/**
 * fino:commands/code/engine — model registry, sessions, sub-agents, and turns for `fino code`.
 *
 * `CodeEngine` owns everything about the coding agent except presentation:
 * provider discovery through the `fino:ai` model registry, per-turn agent
 * construction (so the model and the plan/code mode can change between turns
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
 * import { CodeEngine } from 'fino:commands/code/engine';
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
import { createCodeTools } from 'fino:commands/code/tools';
import { codeSystemPrompt } from 'fino:commands/code/prompt';

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
  /** Start in planning mode (read-only tools, planning instructions). */
  planMode?: boolean;
  /** Execute gated tools without approval suspensions. */
  auto?: boolean;
  /** Cross-turn USD spend cap enforced through `fino:ai/budget`. */
  maxCostUsd?: number;
  /** Docs build directory for the docs tools. Defaults to `<cwd>/docs`. */
  docsDir?: string;
  /**
   * SQLite session database path. Defaults to `<cwd>/.fino/code/sessions.db`;
   * pass `false` to keep the session in memory.
   */
  sessionDb?: string | false;
  /** Continue this exact thread id. */
  threadId?: string;
  /** Continue the most recently updated thread in the store. */
  continueThread?: boolean;
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
 * plan/code modes, tool approval, steering, and sub-agent fan-out.
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
  #planMode: boolean;
  #budget?: Budget;
  #threadId: string;
  #active?: Session;
  #driving = false;
  #queuedSteer: string[] = [];
  #pool?: SubagentPool;
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
    this.#planMode = opts.planMode ?? false;
    this.#threadId = threadId;
    this.#storeCloser = storeCloser;
    if (opts.maxCostUsd !== undefined) this.#budget = new Budget({ usd: opts.maxCostUsd });
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
    if (opts.sessionDb === false) {
      store = new InMemorySessionStore();
    } else {
      const path = opts.sessionDb ?? join(opts.cwd, '.fino', 'code', 'sessions.db').toString();
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

  #poolOptions() {
    return {
      id: this.#threadId,
      store: this.#store,
      buildAgent: (spec: SubagentSpec, ctx: SubagentBuildContext) =>
        this.#buildChildAgent(spec, ctx),
      onEvent: (id: string, ev: AgentEvent) => {
        try {
          this.#subagentEventListener?.(id, ev);
        } catch (_) {
          // observer errors must not fail child runs
        }
      },
      onStatus: (id: string, state: SubagentState) => {
        try {
          this.#subagentStatusListener?.(id, state);
        } catch (_) {
          // observer errors must not fail transitions
        }
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
    spec.readOnly ??= this.#planMode;
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
            auto: this.#opts.auto ?? false,
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

  /** Whether planning mode is active for the next turn. */
  get planMode(): boolean {
    return this.#planMode;
  }

  /** Current durable thread id. */
  get threadId(): string {
    return this.#threadId;
  }

  /** Whether gated tools execute without approval. */
  get auto(): boolean {
    return this.#opts.auto ?? false;
  }

  /** Toggle auto-approval for gated tools on subsequent turns. */
  setAuto(auto: boolean): void {
    this.#opts = { ...this.#opts, auto };
  }

  /** Switch planning mode for subsequent turns; history is preserved. */
  setPlanMode(planMode: boolean): void {
    this.#planMode = planMode;
  }

  /** Start a fresh thread; the old thread and its sub-agents stay stored. */
  newThread(): string {
    this.#threadId = `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.#active = undefined;
    this.#pool = undefined;
    this.#queuedSteer = [];
    this.#reviewPrompted = new Set();
    return this.#threadId;
  }

  /**
   * List models discovered across the configured providers.
   */
  listModels(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    return this.#registry.list(opts);
  }

  /**
   * Switch the model used for subsequent turns.
   *
   * Resolves the id through the registry first; when discovery is
   * unavailable the id falls back to direct provider construction by prefix.
   */
  async setModel(id: string, opts: { provider?: string } = {}): Promise<void> {
    this.#model = await this.#resolveModel(id, opts);
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
        planMode: this.#planMode,
        subagents: true,
      }),
      tools: [
        ...createCodeTools({
          cwd: this.#opts.cwd,
          docsDir: this.#opts.docsDir,
          writes: !this.#planMode,
          auto: this.#opts.auto ?? false,
        }),
        ...subagentTools(pool),
      ],
      ...(this.#budget ? { budget: this.#budget } : {}),
    });
  }

  async #driveTracked(run: () => Promise<RunResult>): Promise<RunResult> {
    this.#driving = true;
    try {
      return await run();
    } finally {
      this.#driving = false;
    }
  }

  async #runOnThread(input: string, hooks: TurnHooks): Promise<RunResult> {
    const sess = session({
      store: this.#store,
      agent: this.#buildAgent(),
      threadId: this.#threadId,
      ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
    });
    this.#active = sess;
    const steered = this.#queuedSteer.splice(0);
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
    return this.#toTurn(result);
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
    return this.#finishTurn(await this.#runOnThread(input, hooks), hooks);
  }

  /**
   * Approve the pending gated tool call and continue the run.
   */
  async approve(token: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    const active = this.#active;
    if (!active) throw new Error('No active session to approve');
    return this.#finishTurn(
      await this.#driveTracked(() => active.approveTool(token, { signal: hooks.signal })),
      hooks,
    );
  }

  /**
   * Reject the pending gated tool call with a model-visible reason and
   * continue the run.
   */
  async reject(token: string, reason?: string, hooks: TurnHooks = {}): Promise<TurnResult> {
    const active = this.#active;
    if (!active) throw new Error('No active session to reject');
    return this.#finishTurn(
      await this.#driveTracked(() => active.rejectTool(token, reason, { signal: hooks.signal })),
      hooks,
    );
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
    if (latest && (latest.status === 'running' || latest.status === 'error')) {
      const sess = await Session.attach({
        store: this.#store,
        agent: this.#buildAgent(),
        threadId: this.#threadId,
        runId: latest.runId,
        ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
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
        ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
      });
      this.#active = sess;
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
   * Close the underlying session store.
   */
  async close(): Promise<void> {
    await this.#storeCloser?.();
  }

  #toTurn(result: RunResult): TurnResult {
    if (result.status === 'suspended') {
      const suspendedOn = result.state.suspendedOn;
      if (suspendedOn && isApprovalPayload(suspendedOn.payload)) {
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
