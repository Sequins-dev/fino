/**
 * fino:commands/code/engine — model registry, sessions, and turns for `fino code`.
 *
 * `CodeEngine` owns everything about the coding agent except presentation:
 * provider discovery through the `fino:ai` model registry, per-turn agent
 * construction (so the model and the plan/code mode can change between turns
 * while the durable SQLite thread keeps the conversation), streamed turn
 * execution through `Session` with `onEvent`, and the approval loop for gated
 * tools. The TUI and the one-shot CLI path are thin views over this class.
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

function isApprovalPayload(payload: unknown): payload is ToolApprovalRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'tool_approval'
  );
}

/**
 * Engine behind `fino code`: registry-backed models, durable streamed turns,
 * plan/code modes, and tool approval.
 *
 * Construction never touches the network; provider listings load lazily on
 * `listModels()`. The model and mode can change freely between turns — each
 * turn builds a fresh `Agent` over the same durable thread, so history
 * survives both.
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
   * pick the initial model, and open (or create) the session store.
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
    let threadId = opts.threadId;
    if (!threadId && opts.continueThread) {
      const runs = await store.listRuns();
      const latest = runs[runs.length - 1];
      threadId = latest?.threadId;
    }
    threadId ??= `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new CodeEngine(opts, registry, store, model, threadId, storeCloser);
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

  /** Start a fresh thread; the old thread stays in the store. */
  newThread(): string {
    this.#threadId = `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.#active = undefined;
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
    try {
      this.#model = await this.#registry.create(id, opts);
    } catch (_) {
      this.#model = createModelDirect(id, opts.provider, {
        hasAnthropic: Boolean(env.ANTHROPIC_API_KEY),
        hasOpenAI: Boolean(env.OPENAI_API_KEY ?? env.OPENAI_BASE_URL),
      });
    }
  }

  #buildAgent(): Agent {
    return agent({
      name: 'fino-code',
      model: this.#model,
      instructions: codeSystemPrompt({ cwd: this.#opts.cwd, planMode: this.#planMode }),
      tools: createCodeTools({
        cwd: this.#opts.cwd,
        docsDir: this.#opts.docsDir,
        writes: !this.#planMode,
        auto: this.#opts.auto ?? false,
      }),
      ...(this.#budget ? { budget: this.#budget } : {}),
    });
  }

  /**
   * Run one durable, streamed turn on the current thread.
   *
   * Events flow through `onEvent` while the session checkpoints each step.
   * When a gated tool suspends, the returned `TurnResult` carries the
   * approval request; continue with `approve()` or `reject()`.
   */
  async runTurn(
    input: string,
    opts: {
      onEvent?: (ev: AgentEvent) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<TurnResult> {
    const sess = session({
      store: this.#store,
      agent: this.#buildAgent(),
      threadId: this.#threadId,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
    this.#active = sess;
    return this.#toTurn(await sess.start(input, { signal: opts.signal }));
  }

  /**
   * Approve the pending gated tool call and continue the run.
   */
  async approve(token: string, opts: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    if (!this.#active) throw new Error('No active session to approve');
    return this.#toTurn(await this.#active.approveTool(token, { signal: opts.signal }));
  }

  /**
   * Reject the pending gated tool call with a model-visible reason and
   * continue the run.
   */
  async reject(
    token: string,
    reason?: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TurnResult> {
    if (!this.#active) throw new Error('No active session to reject');
    return this.#toTurn(await this.#active.rejectTool(token, reason, { signal: opts.signal }));
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
