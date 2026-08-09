/**
 * fino:ai/subagents — concurrent, durable sub-agent pools for agent fan-out.
 *
 * A `SubagentPool` lets a parent agent delegate work to child agents that run
 * concurrently, each as its own durable `fino:ai/session` thread in the same
 * `SessionStore`. A child conversation mirrors the parent conversation one
 * level up: the parent agent plays the user role (task prompt, follow-ups,
 * mid-run steering), the child is the assistant, and human approval of gated
 * tools passes through unchanged. `subagentTools()` exposes the pool to the
 * parent model as ordinary tools — spawn (returns an id immediately),
 * status, send, a blocking wait, finalize, and cancel — while
 * `subagentCompleteTool()` gives each child a way to report that it believes
 * its task is done, parking it in `awaiting_review` until the parent
 * confirms with `subagent_finalize` or keeps iterating with `subagent_send`.
 *
 * ## Durability
 *
 * Every child state transition persists to `SessionStore.putMeta()` under
 * `subagents:<poolId>`, and child runs checkpoint through their sessions as
 * usual, so `SubagentPool.restore()` can resurrect a pool after a crash:
 * runs checkpointed `running` are re-driven, suspended approval requests are
 * re-surfaced, and reviewed or terminal children reload as they were.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { anthropic } from 'fino:ai/model';
 * import { SubagentPool, subagentTools } from 'fino:ai/subagents';
 *
 * const pool = new SubagentPool({
 *   id: threadId,
 *   store,
 *   buildAgent: (spec, ctx) => ({
 *     agent: agent({
 *       model: anthropic({ model: spec.model ?? 'claude-opus-4-8' }),
 *       instructions: `You are a sub-agent. Task: ${spec.task}`,
 *       tools: [ctx.completeTool],
 *     }),
 *   }),
 * });
 * const parent = agent({ model: anthropic(), tools: subagentTools(pool) });
 * ```
 */
import type { Agent } from 'fino:ai/agent';
import type { AgentEvent, ToolApprovalRequest } from 'fino:ai/runtime';
import type { ModelMessage, Usage } from 'fino:ai/model';
import { Session, session } from 'fino:ai/session';
import type { SessionStore, RunResult } from 'fino:ai/session';
import { tool, Tool } from 'fino:ai/tool';
import { createSignal } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
import { v } from 'fino:validate';

/**
 * Description of one sub-agent to spawn.
 *
 * The spec must stay JSON-serializable — it is persisted verbatim so the
 * pool can rebuild the same child agent after a restart.
 */
export interface SubagentSpec {
  /** Task prompt delivered to the child as its first user message. */
  task: string;
  /** Display name; defaults to `agent-<n>`. */
  name?: string;
  /**
   * Model id for the child. `undefined` means "same model as the parent" —
   * the `buildAgent` callback decides what that resolves to.
   */
  model?: string;
  /**
   * Restrict the child to read-only capabilities. Interpretation belongs to
   * `buildAgent`; harnesses use it to propagate a planning mode to children.
   */
  readOnly?: boolean;
}

/**
 * Result of `buildAgent`: the configured child agent and an optional
 * pre-assigned thread id.
 */
export interface SubagentBuild {
  /** Fully configured child agent, including `ctx.completeTool`. */
  agent: Agent;
  /** Thread id override; defaults to `<poolId>:<childId>`. */
  threadId?: string;
}

/**
 * Context handed to `buildAgent` alongside the spec.
 */
export interface SubagentBuildContext {
  /** Pool-assigned child id. */
  id: string;
  /**
   * The child's `subagent_complete` tool. Include it in the child agent's
   * tool list so the child can report task completion.
   */
  completeTool: Tool;
}

/**
 * Lifecycle status of a pooled sub-agent.
 *
 * `working` — a run is in flight. `awaiting_approval` — a gated tool call
 * suspended the child and someone must approve or reject it.
 * `awaiting_review` — the child's run ended (with or without a done report)
 * and the parent should finalize or iterate. `done` — finalized by the
 * parent. `failed` / `cancelled` — terminal error or abort.
 */
export type SubagentStatus =
  | 'working'
  | 'awaiting_approval'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * Pending gated-tool approval raised by a child run.
 */
export interface SubagentApproval {
  /** Single-use resume token for `approve()`/`reject()`. */
  token: string;
  /** The persisted tool approval request. */
  request: ToolApprovalRequest;
}

/**
 * Snapshot of one sub-agent's state.
 */
export interface SubagentState {
  /** Pool-assigned id, echoed by every subagent tool. */
  id: string;
  /** Display name. */
  name: string;
  /** Spec the child was spawned from. */
  spec: SubagentSpec;
  /** Current lifecycle status. */
  status: SubagentStatus;
  /** Durable thread id of the child conversation. */
  threadId: string;
  /** Run id of the latest child run, when one has started. */
  runId?: string;
  /** Summary the child reported through `subagent_complete`. */
  doneReport?: string;
  /** Last assistant text from the most recent completed run. */
  lastText?: string;
  /** Failure or cancellation detail. */
  error?: string;
  /** Pending approval while `awaiting_approval`. */
  approval?: SubagentApproval;
  /** Token usage accumulated across the child's runs. */
  usage: Usage;
}

/**
 * Options for `SubagentPool`.
 */
export interface SubagentPoolOptions {
  /**
   * Stable pool identity — conventionally the parent conversation's thread
   * id. Namespaces the persistence key and default child thread ids.
   */
  id: string;
  /** Store shared with the parent session; children persist here too. */
  store: SessionStore;
  /**
   * Build a child agent from a spec. Called on spawn and again on
   * `restore()`, so it must be deterministic for a given spec.
   */
  buildAgent: (
    spec: SubagentSpec,
    ctx: SubagentBuildContext,
  ) => SubagentBuild | Promise<SubagentBuild>;
  /** Per-child agent event fan-out for UIs (transcripts, progress). */
  onEvent?: (id: string, ev: AgentEvent) => void;
  /** Called after every child status transition. */
  onStatus?: (id: string, state: SubagentState) => void;
  /**
   * Called for every parent→child message: the spawn task and each
   * `send()`. Lets harnesses mirror the parent side of child transcripts.
   */
  onSend?: (id: string, message: string) => void;
}

interface ChildRecord {
  state: SubagentState;
  session?: Session;
  abort?: AbortController;
  reported?: string;
}

interface PersistedChild {
  id: string;
  name: string;
  spec: SubagentSpec;
  status: SubagentStatus;
  threadId: string;
  runId?: string;
  doneReport?: string;
  lastText?: string;
  error?: string;
  usage: Usage;
}

const SETTLED: ReadonlySet<SubagentStatus> = new Set([
  'awaiting_review',
  'done',
  'failed',
  'cancelled',
]);

function isApprovalPayload(payload: unknown): payload is ToolApprovalRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: unknown }).type === 'tool_approval'
  );
}

function cloneState(state: SubagentState): SubagentState {
  return JSON.parse(JSON.stringify(state)) as SubagentState;
}

/**
 * Pool of concurrent, durable sub-agents owned by one parent conversation.
 *
 * Spawned children run immediately and independently; the pool tracks their
 * lifecycle, persists every transition, fans out their agent events, and
 * exposes waiting, steering, approval, review, and cancellation. Use
 * `subagentTools()` to hand the pool to a parent model and `restore()` to
 * resurrect a pool after a process restart.
 */
export class SubagentPool {
  #opts: SubagentPoolOptions;
  #children = new Map<string, ChildRecord>();
  #counter = 0;
  #signal = createSignal<SubagentState[]>([]);
  #waiters: Array<() => void> = [];

  /**
   * Create an empty pool. Use `restore()` instead when reattaching to a
   * store that may hold persisted children for this pool id.
   */
  constructor(opts: SubagentPoolOptions) {
    this.#opts = opts;
  }

  /**
   * Reload a pool's persisted children and resurrect their runs.
   *
   * Children whose latest run checkpointed as `running` or `error` are
   * re-driven from their committed history (`Session.attach` +
   * `redrive()`); suspended approval requests re-surface as
   * `awaiting_approval` with their original resume tokens; reviewed and
   * terminal children reload as recorded. Returns an empty pool when
   * nothing was persisted.
   */
  static async restore(opts: SubagentPoolOptions): Promise<SubagentPool> {
    const pool = new SubagentPool(opts);
    const persisted = (await opts.store.getMeta(pool.#metaKey())) as PersistedChild[] | null;
    if (!persisted) return pool;
    for (const child of persisted) {
      pool.#counter += 1;
      const record: ChildRecord = {
        state: {
          id: child.id,
          name: child.name,
          spec: child.spec,
          status: child.status,
          threadId: child.threadId,
          runId: child.runId,
          doneReport: child.doneReport,
          lastText: child.lastText,
          error: child.error,
          usage: child.usage,
        },
      };
      pool.#children.set(child.id, record);
      await pool.#resurrect(record);
    }
    pool.#publish();
    return pool;
  }

  async #resurrect(record: ChildRecord): Promise<void> {
    const { state } = record;
    if (!state.runId) {
      if (state.status === 'working' || state.status === 'awaiting_approval') {
        state.status = 'failed';
        state.error = 'lost before first checkpoint';
      }
      return;
    }
    const run = await this.#opts.store.loadRun(state.runId);
    if (!run) {
      if (state.status === 'working' || state.status === 'awaiting_approval') {
        state.status = 'failed';
        state.error = 'run checkpoint missing';
      }
      return;
    }
    if (state.status !== 'working' && state.status !== 'awaiting_approval') return;
    const built = await this.#opts.buildAgent(state.spec, {
      id: state.id,
      completeTool: this.#completeTool(state.id),
    });
    const sess = await Session.attach({
      store: this.#opts.store,
      agent: built.agent,
      threadId: state.threadId,
      runId: state.runId,
      onEvent: this.#childEvents(state.id),
    });
    record.session = sess;
    if (run.status === 'suspended') {
      if (run.suspendedOn && isApprovalPayload(run.suspendedOn.payload)) {
        state.status = 'awaiting_approval';
        state.approval = {
          token: run.suspendedOn.token,
          request: run.suspendedOn.payload,
        };
      } else {
        state.status = 'awaiting_review';
        state.doneReport ??= run.suspendedOn?.reason
          ? `suspended: ${run.suspendedOn.reason}`
          : undefined;
      }
      return;
    }
    if (run.status === 'done' || run.status === 'cancelled') {
      state.status = run.status === 'done' ? 'awaiting_review' : 'cancelled';
      return;
    }
    record.abort = new AbortController();
    this.#setStatus(record, 'working');
    void this.#drive(record, () => sess.redrive({ signal: record.abort!.signal }));
  }

  #metaKey(): string {
    return `subagents:${this.#opts.id}`;
  }

  #notifySend(id: string, message: string): void {
    try {
      this.#opts.onSend?.(id, message);
    } catch (_) {
      // observer errors must not fail sends
    }
  }

  #childEvents(id: string): (ev: AgentEvent) => void {
    return (ev) => {
      try {
        this.#opts.onEvent?.(id, ev);
      } catch (_) {
        // observer errors must not fail child runs
      }
    };
  }

  #completeTool(id: string): Tool {
    return subagentCompleteTool(this, id);
  }

  /**
   * Record a child's done report. Called by the child's
   * `subagent_complete` tool; applications normally never call it directly.
   */
  recordDoneReport(id: string, summary: string): void {
    const record = this.#require(id);
    record.reported = summary;
  }

  /**
   * Spawn a sub-agent and return its id immediately.
   *
   * The child's first run starts asynchronously; track it with `status()`,
   * `watch()`, or `waitForSettled()`.
   */
  async spawn(spec: SubagentSpec): Promise<string> {
    this.#counter += 1;
    const id = `sa_${this.#counter}`;
    const name = spec.name?.trim() || `agent-${this.#counter}`;
    const record: ChildRecord = {
      state: {
        id,
        name,
        spec: { ...spec, name },
        status: 'working',
        threadId: `${this.#opts.id}:${id}`,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
    this.#children.set(id, record);
    const built = await this.#opts.buildAgent(record.state.spec, {
      id,
      completeTool: this.#completeTool(id),
    });
    if (built.threadId) record.state.threadId = built.threadId;
    const sess = session({
      store: this.#opts.store,
      agent: built.agent,
      threadId: record.state.threadId,
      onEvent: this.#childEvents(id),
      onCheckpoint: (run) => {
        record.state.runId = run.runId;
      },
    });
    record.session = sess;
    record.abort = new AbortController();
    this.#setStatus(record, 'working');
    this.#notifySend(id, spec.task);
    void this.#drive(record, () => sess.start(spec.task, { signal: record.abort!.signal }));
    return id;
  }

  async #drive(record: ChildRecord, run: () => Promise<RunResult>): Promise<void> {
    try {
      const result = await run();
      record.state.runId = result.runId;
      this.#settle(record, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort')) {
        record.state.error = 'cancelled';
        this.#setStatus(record, 'cancelled');
      } else {
        record.state.error = message;
        this.#setStatus(record, 'failed');
      }
    }
  }

  #settle(record: ChildRecord, result: RunResult): void {
    record.state.usage = result.state.usage;
    if (result.status === 'suspended') {
      const on = result.state.suspendedOn;
      if (on && isApprovalPayload(on.payload)) {
        record.state.approval = { token: on.token, request: on.payload };
        this.#setStatus(record, 'awaiting_approval');
        return;
      }
      record.state.doneReport ??= on?.reason ? `suspended: ${on.reason}` : undefined;
      this.#setStatus(record, 'awaiting_review');
      return;
    }
    if (result.text) record.state.lastText = result.text;
    if (record.reported !== undefined) {
      record.state.doneReport = record.reported;
      record.reported = undefined;
    }
    this.#setStatus(record, 'awaiting_review');
  }

  #setStatus(record: ChildRecord, status: SubagentStatus): void {
    record.state.status = status;
    if (status !== 'awaiting_approval') record.state.approval = undefined;
    if (status !== 'working' && status !== 'awaiting_approval') {
      // Idle children hold no live session or abort controller; revival and
      // approval paths reattach from the store on demand.
      record.session = undefined;
      record.abort = undefined;
    }
    this.#publish();
    try {
      this.#opts.onStatus?.(record.state.id, cloneState(record.state));
    } catch (_) {
      // observer errors must not fail transitions
    }
    void this.#persist();
    const waiters = this.#waiters.splice(0);
    for (const wake of waiters) wake();
  }

  #publish(): void {
    this.#signal.set([...this.#children.values()].map((r) => cloneState(r.state)));
  }

  async #persist(): Promise<void> {
    const children: PersistedChild[] = [...this.#children.values()].map(({ state }) => ({
      id: state.id,
      name: state.name,
      spec: state.spec,
      status: state.status,
      threadId: state.threadId,
      runId: state.runId,
      doneReport: state.doneReport,
      lastText: state.lastText,
      error: state.error,
      usage: state.usage,
    }));
    try {
      await this.#opts.store.putMeta(this.#metaKey(), children);
    } catch (_) {
      // persistence is best-effort; the next transition retries
    }
  }

  #require(id: string): ChildRecord {
    const record = this.#children.get(id);
    if (!record) throw new Error(`Unknown subagent: ${id}`);
    return record;
  }

  /**
   * Snapshot the state of one child or, without an id, every child.
   */
  status(id?: string): SubagentState | SubagentState[] {
    if (id !== undefined) return cloneState(this.#require(id).state);
    return [...this.#children.values()].map((r) => cloneState(r.state));
  }

  /**
   * Retained signal of all child states, updated on every transition.
   */
  watch(): ReadonlySignal<SubagentState[]> {
    return this.#signal;
  }

  /**
   * Whether any child is still working or waiting on an approval decision —
   * i.e. whether the parent's turn should be considered still active.
   */
  get active(): boolean {
    return [...this.#children.values()].some(
      (r) => r.state.status === 'working' || r.state.status === 'awaiting_approval',
    );
  }

  /**
   * Deliver a message from the parent to a child.
   *
   * A working child is steered mid-run (the message injects at its next step
   * boundary); a child suspended on non-approval input is resumed with the
   * message; any settled child — awaiting review, finalized, failed, or
   * cancelled — is *revived*: a new run starts on its existing thread with
   * the full prior conversation intact, so sub-agents persist across parent
   * turns and can be picked back up whenever more input arrives. Idle
   * children hold no live session; revival reattaches from the store.
   */
  send(id: string, message: string): void {
    const record = this.#require(id);
    const { state } = record;
    this.#notifySend(id, message);
    if (state.status === 'working' || state.status === 'awaiting_approval') {
      if (!record.session) throw new Error(`Subagent ${id} has no session`);
      record.session.steer(message);
      return;
    }
    record.abort = new AbortController();
    state.doneReport = undefined;
    state.error = undefined;
    this.#setStatus(record, 'working');
    void this.#reviveAndDrive(record, message);
  }

  async #reviveAndDrive(record: ChildRecord, message: string): Promise<void> {
    let sess: Session;
    try {
      sess = await this.#sessionFor(record);
    } catch (err) {
      record.state.error = err instanceof Error ? err.message : String(err);
      this.#setStatus(record, 'failed');
      return;
    }
    const suspended = sess.state?.status === 'suspended' ? sess.state.suspendedOn : undefined;
    if (suspended && !isApprovalPayload(suspended.payload)) {
      await this.#drive(record, () =>
        sess.resume(suspended.token, message, { signal: record.abort!.signal }),
      );
      return;
    }
    await this.#drive(record, () => sess.start(message, { signal: record.abort!.signal }));
  }

  async #sessionFor(record: ChildRecord): Promise<Session> {
    if (record.session) return record.session;
    const { state } = record;
    const built = await this.#opts.buildAgent(state.spec, {
      id: state.id,
      completeTool: this.#completeTool(state.id),
    });
    if (state.runId && (await this.#opts.store.loadRun(state.runId))) {
      record.session = await Session.attach({
        store: this.#opts.store,
        agent: built.agent,
        threadId: state.threadId,
        runId: state.runId,
        onEvent: this.#childEvents(state.id),
        onCheckpoint: (run) => {
          record.state.runId = run.runId;
        },
      });
      return record.session;
    }
    record.session = session({
      store: this.#opts.store,
      agent: built.agent,
      threadId: state.threadId,
      onEvent: this.#childEvents(state.id),
      onCheckpoint: (run) => {
        record.state.runId = run.runId;
      },
    });
    return record.session;
  }

  /**
   * Approve a child's pending gated tool call and continue its run.
   */
  approve(id: string, opts: { approval?: unknown } = {}): void {
    const record = this.#require(id);
    const approval = record.state.approval;
    if (record.state.status !== 'awaiting_approval' || !approval || !record.session) {
      throw new Error(`Subagent ${id} has no pending approval`);
    }
    const sess = record.session;
    record.abort = new AbortController();
    this.#setStatus(record, 'working');
    void this.#drive(record, () =>
      sess.approveTool(approval.token, {
        approval: opts.approval,
        signal: record.abort!.signal,
      }),
    );
  }

  /**
   * Reject a child's pending gated tool call with a model-visible reason and
   * continue its run.
   */
  reject(id: string, reason?: string): void {
    const record = this.#require(id);
    const approval = record.state.approval;
    if (record.state.status !== 'awaiting_approval' || !approval || !record.session) {
      throw new Error(`Subagent ${id} has no pending approval`);
    }
    const sess = record.session;
    record.abort = new AbortController();
    this.#setStatus(record, 'working');
    void this.#drive(record, () =>
      sess.rejectTool(approval.token, reason, { signal: record.abort!.signal }),
    );
  }

  /**
   * Confirm a child's done suggestion and close its conversation.
   */
  finalize(id: string): void {
    const record = this.#require(id);
    if (record.state.status !== 'awaiting_review') {
      throw new Error(
        `Subagent ${id} is ${record.state.status}; only awaiting_review children can be finalized`,
      );
    }
    this.#setStatus(record, 'done');
  }

  /**
   * Abort a child's current run, or mark an idle child cancelled.
   */
  cancel(id: string): void {
    const record = this.#require(id);
    if (record.state.status === 'done' || record.state.status === 'cancelled') return;
    if (
      record.abort &&
      (record.state.status === 'working' || record.state.status === 'awaiting_approval')
    ) {
      record.abort.abort();
      return;
    }
    record.state.error ??= 'cancelled';
    this.#setStatus(record, 'cancelled');
  }

  /**
   * Wait until children settle — reach `awaiting_review`, `done`, `failed`,
   * or `cancelled`. `working` and `awaiting_approval` (a human decision is
   * part of the work) both count as unsettled.
   *
   * `mode: 'all'` (default) resolves when every targeted child is settled;
   * `'any'` resolves as soon as one is. Resolves with the settled children's
   * states. Resolves immediately when there are no targets.
   */
  async waitForSettled(
    opts: {
      ids?: string[];
      mode?: 'all' | 'any';
      signal?: AbortSignal;
    } = {},
  ): Promise<SubagentState[]> {
    const mode = opts.mode ?? 'all';
    const targets = (): ChildRecord[] => {
      if (opts.ids) return opts.ids.map((id) => this.#require(id));
      return [...this.#children.values()];
    };
    const settled = (): ChildRecord[] => targets().filter((r) => SETTLED.has(r.state.status));
    const complete = (): boolean => {
      const all = targets();
      if (all.length === 0) return true;
      const done = settled().length;
      return mode === 'any' ? done > 0 : done === all.length;
    };
    while (!complete()) {
      if (opts.signal?.aborted) throw new Error('waitForSettled aborted');
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    return settled().map((r) => cloneState(r.state));
  }

  /**
   * Render a child's durable conversation history.
   *
   * Loads the child thread's committed revision from the store — useful for
   * rebuilding transcript views after `restore()`.
   */
  async history(id: string): Promise<ModelMessage[]> {
    const record = this.#require(id);
    const thread = await this.#opts.store.loadThread(record.state.threadId);
    if (!thread?.historyRevisionId) return [];
    const history = await this.#opts.store.loadHistory(thread.historyRevisionId);
    return history?.render() ?? [];
  }
}

/**
 * Create the `subagent_complete` tool bound to one child.
 *
 * `SubagentPool` builds one per child and passes it to `buildAgent` as
 * `ctx.completeTool`; include it in the child agent's tools. Calling it
 * records the child's done report — the run then ends normally and the child
 * parks in `awaiting_review` for the parent's verdict.
 */
export function subagentCompleteTool(pool: SubagentPool, id: string): Tool {
  return tool({
    name: 'subagent_complete',
    description:
      'Report that you believe your assigned task is complete. Provide a concise summary of ' +
      'what you did and found; then stop. The parent agent will review and either accept or ' +
      'send follow-up instructions.',
    parameters: v.object({
      summary: v.string().describe('Concise completion summary for the parent agent'),
    }),
    execute: async ({ summary }: { summary: string }) => {
      pool.recordDoneReport(id, summary);
      return 'Completion report recorded. Stop when you have nothing further to add.';
    },
  });
}

function formatState(s: SubagentState): string {
  const parts = [`${s.id} (${s.name}) [${s.status}]`, `model: ${s.spec.model ?? 'inherit'}`];
  if (s.doneReport) parts.push(`report: ${s.doneReport}`);
  else if (s.lastText) parts.push(`last: ${s.lastText.slice(0, 200)}`);
  if (s.error) parts.push(`error: ${s.error}`);
  return parts.join(' | ');
}

/**
 * Build the parent-side subagent tool set for a pool.
 *
 * Hand the returned tools to the parent agent. `subagent_spawn` returns an
 * id immediately; `subagent_wait` blocks inside the tool call, which is what
 * keeps the parent's turn active while children work; `subagent_send`
 * steers or continues a child; `subagent_finalize` accepts a child's done
 * suggestion; `subagent_cancel` aborts one.
 *
 * ```ts no_run
 * import { agent } from 'fino:ai/agent';
 * import { subagentTools } from 'fino:ai/subagents';
 *
 * const parent = agent({ model, tools: [...codeTools, ...subagentTools(pool)] });
 * ```
 */
export function subagentTools(pool: SubagentPool): Tool[] {
  return [
    tool({
      name: 'subagent_spawn',
      description:
        'Spawn a sub-agent to work on one focused task concurrently. Returns its id ' +
        'immediately; the sub-agent starts working right away. Give it a complete, ' +
        'self-contained task prompt. Omit model to use your own model.',
      parameters: v.object({
        task: v.string().describe('Complete task prompt for the sub-agent'),
        name: v.string().optional().describe('Short display name, e.g. "research-http"'),
        model: v.string().optional().describe('Model id override; defaults to your model'),
        readOnly: v.boolean().optional().describe('Restrict the sub-agent to read-only tools'),
      }),
      execute: async (args: {
        task: string;
        name?: string;
        model?: string;
        readOnly?: boolean;
      }) => {
        const id = await pool.spawn(args);
        return JSON.stringify({ id });
      },
    }),
    tool({
      name: 'subagent_status',
      description:
        'Check sub-agent progress. Without an id, lists every sub-agent with status and ' +
        'latest activity. Read-only.',
      parameters: v.object({
        id: v.string().optional().describe('Sub-agent id; omit for all'),
      }),
      execute: async ({ id }: { id?: string }) => {
        const states = id ? [pool.status(id) as SubagentState] : (pool.status() as SubagentState[]);
        if (states.length === 0) return 'No subagents.';
        return states.map(formatState).join('\n');
      },
    }),
    tool({
      name: 'subagent_send',
      description:
        'Send a message to a sub-agent: steers it mid-run, starts its next run when it is ' +
        'awaiting review, or revives a finalized/failed/cancelled sub-agent on its existing ' +
        'conversation. Sub-agents persist across turns — use this to continue iterating with ' +
        'one after gathering more input, instead of spawning a fresh sub-agent without context.',
      parameters: v.object({
        id: v.string().describe('Sub-agent id'),
        message: v.string().describe('Instruction or feedback for the sub-agent'),
      }),
      execute: async ({ id, message }: { id: string; message: string }) => {
        pool.send(id, message);
        return `Sent to ${id}.`;
      },
    }),
    tool({
      name: 'subagent_wait',
      description:
        'Block until sub-agents settle (finish their run, fail, or are cancelled). ' +
        'mode "all" (default) waits for every listed (or all) sub-agent; "any" returns on ' +
        'the first. Returns each settled sub-agent with its done report — review each and ' +
        'either subagent_finalize or subagent_send follow-ups.',
      parameters: v.object({
        ids: v.array(v.string()).optional().describe('Sub-agent ids; omit for all'),
        mode: v.enum(['all', 'any']).optional().describe('Wait for all (default) or any'),
      }),
      execute: async ({ ids, mode }: { ids?: string[]; mode?: 'all' | 'any' }, ctx) => {
        const settled = await pool.waitForSettled({ ids, mode, signal: ctx.signal });
        if (settled.length === 0) return 'No subagents to wait for.';
        return settled.map(formatState).join('\n');
      },
    }),
    tool({
      name: 'subagent_finalize',
      description:
        "Accept a sub-agent's done report and close its conversation. Only valid while it " +
        'is awaiting review.',
      parameters: v.object({
        id: v.string().describe('Sub-agent id'),
      }),
      execute: async ({ id }: { id: string }) => {
        pool.finalize(id);
        return `Finalized ${id}.`;
      },
    }),
    tool({
      name: 'subagent_cancel',
      description: "Cancel a sub-agent's current run. Its transcript is kept.",
      parameters: v.object({
        id: v.string().describe('Sub-agent id'),
      }),
      execute: async ({ id }: { id: string }) => {
        pool.cancel(id);
        return `Cancelled ${id}.`;
      },
    }),
  ];
}
