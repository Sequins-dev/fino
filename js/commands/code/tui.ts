/**
 * fino:commands/code/tui — inline multi-session terminal interface for `fino code`.
 *
 * Chat history lives in the terminal's real scrollback: finalized blocks —
 * user messages, settled markdown, completed tool calls, turn markers — are
 * committed above a dynamic footer and never repainted, so they are natively
 * selectable, scroll with the terminal, survive exit, and work with the
 * terminal's own find. The footer is the only repainted region: the
 * streaming tail and activity indicator while a turn runs, queued messages,
 * the approval band, the slash-command selector, the composer, the
 * sub-agent selector, and a status bar with attention dots for the other
 * sessions (blue needs-input, red error, green done, yellow busy).
 *
 * The chat surface is keyboard-only — mouse capture stays off so the
 * terminal keeps selection. Modal views keep the mouse: `Ctrl+B` (or
 * `/sessions`) opens the full-screen session manager, `/model` the model
 * picker; both run in the alternate screen with capture on and restore the
 * inline surface when they close.
 *
 * Turn execution, durability, transcripts, and the sub-agent pools live in
 * `CodeEngine`/`CodeWorkspace`; this module maps keys and agent events onto
 * them and decides what gets committed when.
 *
 * ```ts no_run
 * import { CodeWorkspace } from 'fino:commands/code/workspace';
 * import { runCodeTui } from 'fino:commands/code/tui';
 *
 * const workspace = await CodeWorkspace.open({ cwd: '/repo' });
 * const engine = await workspace.createSession();
 * await runCodeTui(workspace, { sessionId: engine.threadId });
 * ```
 */
import type { AgentEvent, ToolApprovalRequest } from 'fino:ai/runtime';
import type { ModelInfo } from 'fino:ai/model';
import { createSignal } from 'fino:ui';
import { renderInline, type InlineApp, type TuiEvent, type TuiKeyEvent } from 'fino:tty/tui';
import { env } from 'fino:process';
import { basename } from 'fino:file/path';
import { tk, style } from 'fino:tty/components/theme';
import { Composer } from 'fino:tty/components/composer';
import { SelectList, type ListItem } from 'fino:tty/components/list';
import { SPINNER_FRAMES } from 'fino:tty/components/spinner';
import type { Segment } from 'fino:tty/components/statusbar';
import type { CodeEngine, TurnResult } from 'fino:commands/code/engine';
import type { CodeWorkspace } from 'fino:commands/code/workspace';
import { contentText, previewText } from 'fino:commands/code/transcript';
import {
  ATTENTION,
  ATTENTION_ORDER,
  CHILD_GLYPHS,
  MODE_COLORS,
  MODE_HELP,
  MODE_ORDER,
} from 'fino:commands/code/ui/theme';
import {
  assistantBlockPrefix,
  renderApprovalDecision,
  renderEntry,
  renderSessionHeader,
  renderToolBlock,
  turnMarkerText,
  type TranscriptEntry,
} from 'fino:commands/code/ui/blocks';
import {
  entriesFromHistory,
  inputHistoryFromMessages,
  seedEntries,
} from 'fino:commands/code/ui/history';
import { StreamTail } from 'fino:commands/code/ui/stream';
import { composeFooter, tailAllowance, type FooterState } from 'fino:commands/code/ui/footer';
import type { ApprovalPrompt } from 'fino:commands/code/ui/approval';
import { OverlayController } from 'fino:commands/code/ui/overlay';
import { SessionManagerView } from 'fino:commands/code/ui/views/session-manager';
import { ModelPickerView } from 'fino:commands/code/ui/views/model-picker';

const REDRAW_INTERVAL_MS = 33;
const SPINNER_INTERVAL_MS = 100;
const SLASH_MAX_ROWS = 6;
const AGENT_MENU_MAX_ROWS = 8;
/** Entries replayed into scrollback on a view switch or a width rebuild. */
const REPLAY_MAX = 200;
/** Quiet period after the last resize before rebuilding the transcript. */
const RESIZE_REFLOW_MS = 75;
/** How often a continuous drag rebuilds the transcript. */
const RESIZE_REFLOW_MAX_MS = 120;
/** Ceiling on the footer, above what the terminal height allows. */
const MAX_FOOTER_ROWS = 32;

interface SlashCommand {
  name: string;
  args: string;
  description: string;
  submits: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', args: '', description: 'Show commands and keys', submits: true },
  { name: 'model', args: '[id]', description: 'Pick a model, or switch directly by id', submits: true },
  { name: 'plan', args: '', description: 'Plan mode — read-only tools', submits: true },
  { name: 'build', args: '', description: 'Build mode — tools ask before writing', submits: true },
  { name: 'auto', args: '', description: 'Auto mode — tools run without asking', submits: true },
  { name: 'agents', args: '', description: 'Switch between this session and its sub-agents', submits: true },
  { name: 'sessions', args: '', description: 'Open the session manager', submits: true },
  { name: 'title', args: '<name>', description: 'Rename this session', submits: false },
  { name: 'archive', args: '', description: 'Archive/unarchive this session', submits: true },
  { name: 'new', args: '', description: 'Start a new session', submits: true },
  { name: 'debug', args: '', description: 'Terminal diagnostics', submits: true },
  { name: 'exit', args: '', description: 'Quit fino code', submits: true },
];

interface ViewLog {
  entries: TranscriptEntry[];
  /** Whether durable history has been replayed into this log. */
  seeded: boolean;
}

interface SessionUI {
  id: string;
  engine: CodeEngine;
  views: Map<string, ViewLog>;
  viewOrder: string[];
  viewNames: Map<string, string>;
  composer: Composer;
  queue: string[];
  busy: boolean;
  abort?: AbortController;
  /** Coarse session state; drives the turn marker and flashes. */
  state: 'idle' | 'working' | 'waiting' | 'error';
  /** Transient status-bar message: a retry, a mode change, an error. */
  flash?: string;
  turnStartedAt?: number;
  /** What the agent is doing right now, shown beside the spinner. */
  activity: string;
  seenChildApprovals: Set<string>;
  /** Resolves once durable history has been replayed into the main view. */
  historyReady: Promise<void>;
}

interface ApprovalItem {
  sessionId: string;
  prompt: ApprovalPrompt;
  decide: (approved: boolean) => void;
}

/**
 * Options for `runCodeTui()`.
 */
export interface CodeTuiOptions {
  /** Session to focus initially; defaults to the most recent. */
  sessionId?: string;
  /**
   * Attempt `engine.recoverTurn()` on the initial session — resume a
   * crashed run, re-present a suspended approval, pick up sub-agents.
   */
  recover?: boolean;
}

/**
 * Run the interactive inline `fino code` TUI until the user exits.
 *
 * Commits transcript blocks into the terminal's scrollback as they
 * finalize, repaints only the footer, drives turns across the workspace's
 * sessions, and always restores the terminal — including on errors —
 * before resolving.
 */
export async function runCodeTui(
  workspace: CodeWorkspace,
  opts: CodeTuiOptions = {},
): Promise<void> {
  const sessions = new Map<string, SessionUI>();
  const approvalQueue: ApprovalItem[] = [];
  /** The one live view whose blocks commit to scrollback. */
  let visible: { sessionId: string; viewId: string } | undefined;
  /** A frozen archived session on screen: replayed transcript, no engine. */
  let archived: { id: string; title: string; entries: TranscriptEntry[] } | undefined;
  /** Pending width rebuild, coalesced across a resize drag. */
  let reflowTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the transcript was last rebuilt, to pace a drag's rebuilds. */
  let lastReflowAt = 0;
  /** Streaming tail of the visible view's open assistant message. */
  let tail: StreamTail | undefined;
  /** The tool currently running in the visible view, for footer detail. */
  let runningTool: { id: string; name: string; args?: unknown } | undefined;
  let slash: SelectList | undefined;
  let agentMenu: SelectList | undefined;
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPaint = 0;
  /** Whether the last committed scrollback line was blank (block spacing). */
  let lastCommittedBlank = true;
  /** A reflowed tail restarts its block, so its next commit needs a separator. */
  let tailReflowed = false;
  let catalog: Promise<ModelInfo[]> | undefined;
  let quitting = false;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const revision = createSignal(0);

  let width = 80;
  let height = 24;

  // --- basics -----------------------------------------------------------

  function projectName(): string {
    return basename(workspace.cwd).toString() || workspace.cwd;
  }

  function sessionTitle(id: string): string {
    return workspace.meta(id)?.title ?? 'new session';
  }

  function focused(): SessionUI | undefined {
    return visible !== undefined ? sessions.get(visible.sessionId) : undefined;
  }

  function view(session: SessionUI, viewId: string): ViewLog {
    let log = session.views.get(viewId);
    if (!log) {
      log = { entries: [], seeded: false };
      session.views.set(viewId, log);
      if (!session.viewOrder.includes(viewId)) session.viewOrder.push(viewId);
    }
    return log;
  }

  function isVisible(sessionId: string, viewId: string): boolean {
    return visible !== undefined && visible.sessionId === sessionId && visible.viewId === viewId;
  }

  // --- paint loop -------------------------------------------------------

  function redraw(): void {
    if (paintTimer !== undefined || quitting) return;
    const wait = Math.max(0, REDRAW_INTERVAL_MS - (Date.now() - lastPaint));
    paintTimer = setTimeout(() => {
      paintTimer = undefined;
      lastPaint = Date.now();
      if (tail !== undefined) {
        commitTail(tail.takeSettled());
        // A block taller than the footer streams its stable head into
        // scrollback so its top is never scrolled out of view unseen.
        commitTail(tail.takeOverflow(currentTailAllowance()));
      }
      revision.set(revision.get() + 1);
      overlay.refresh();
    }, wait);
  }

  function syncSpinner(): void {
    const busy = [...sessions.values()].some((session) => session.busy);
    if (busy === (spinnerTimer !== undefined)) return;
    if (busy) {
      spinnerTimer = setInterval(() => {
        spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
        redraw();
      }, SPINNER_INTERVAL_MS);
      return;
    }
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  // --- commit pipeline --------------------------------------------------

  function commitRaw(lines: string[]): void {
    if (lines.length === 0) return;
    app.printAbove(lines);
    lastCommittedBlank = lines[lines.length - 1] === '';
  }

  /**
   * Commit streamed lines. They continue a block already on screen, so they
   * follow the transcript directly — unless a resize restarted the block
   * mid-message, which needs the usual blank between blocks re-stated.
   */
  function commitTail(lines: string[]): void {
    if (lines.length === 0) return;
    if (tailReflowed) {
      tailReflowed = false;
      commitBlock(lines);
      return;
    }
    commitRaw(lines);
  }

  /** Commit a discrete block, separated from the previous one by a blank. */
  function commitBlock(lines: string[]): void {
    if (lines.length === 0) return;
    commitRaw(lastCommittedBlank ? lines : ['', ...lines]);
  }

  function pushEntry(session: SessionUI, viewId: string, entry: TranscriptEntry): void {
    view(session, viewId).entries.push(entry);
    if (isVisible(session.id, viewId)) commitBlock(renderEntry(entry, width));
    redraw();
  }

  function notice(session: SessionUI, text: string, viewId = 'main'): void {
    pushEntry(session, viewId, { kind: 'notice', text, done: true });
  }

  function currentAssistant(log: ViewLog): TranscriptEntry {
    const last = log.entries[log.entries.length - 1];
    if (last && last.kind === 'assistant' && last.done === false) return last;
    const entry: TranscriptEntry = { kind: 'assistant', text: '', done: false };
    log.entries.push(entry);
    return entry;
  }

  function finalizeAssistant(session: SessionUI, viewId: string): void {
    const log = view(session, viewId);
    const last = log.entries[log.entries.length - 1];
    if (last && last.kind === 'assistant' && last.done === false) {
      if (last.text.trim().length === 0) log.entries.pop();
      else last.done = true;
    }
    if (isVisible(session.id, viewId)) flushTail();
  }

  function openTail(seedText: string): void {
    tail = new StreamTail(width);
    if (seedText.length > 0) tail.push(seedText);
    commitBlock(assistantBlockPrefix(width));
  }

  function flushTail(): void {
    if (tail === undefined) return;
    commitTail(tail.finish());
    tail = undefined;
  }

  function applyAgentEvent(session: SessionUI, viewId: string, ev: AgentEvent): void {
    const log = view(session, viewId);
    if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
      const entry = currentAssistant(log);
      entry.text += ev.event.text;
      if (isVisible(session.id, viewId)) {
        if (tail === undefined) openTail(entry.text);
        else tail.push(ev.event.text);
      }
    } else if (ev.type === 'tool_start') {
      finalizeAssistant(session, viewId);
      log.entries.push({
        kind: 'tool',
        text: ev.name,
        done: true,
        toolState: 'running',
        toolId: ev.id,
        ...(ev.args !== undefined ? { argsValue: ev.args } : {}),
      });
      if (isVisible(session.id, viewId)) {
        runningTool = { id: ev.id, name: ev.name, ...(ev.args !== undefined ? { args: ev.args } : {}) };
      }
    } else if (ev.type === 'tool_result' || ev.type === 'tool_error') {
      for (let index = log.entries.length - 1; index >= 0; index--) {
        const entry = log.entries[index]!;
        if (entry.kind === 'tool' && entry.toolId === ev.id) {
          entry.toolState =
            ev.type === 'tool_error' || (ev.type === 'tool_result' && ev.isError) ? 'error' : 'ok';
          if (ev.type === 'tool_result' && ev.content !== undefined) {
            entry.outputText = previewText(contentText(ev.content));
          } else if (ev.type === 'tool_error') {
            entry.outputText = previewText(ev.message);
          }
          if (isVisible(session.id, viewId)) {
            commitBlock(
              renderToolBlock(
                {
                  name: entry.text,
                  args: entry.argsValue,
                  state: entry.toolState === 'error' ? 'error' : 'ok',
                  ...(entry.outputText !== undefined ? { output: entry.outputText } : {}),
                },
                width,
              ),
            );
            if (runningTool?.id === ev.id) runningTool = undefined;
          }
          break;
        }
      }
    }
    redraw();
  }

  // --- view switching ---------------------------------------------------

  function replayView(session: SessionUI, viewId: string): void {
    const isChild = viewId !== 'main';
    const childState = isChild
      ? session.engine.subagentStates().find((state) => state.id === viewId)
      : undefined;
    const title = isChild
      ? (session.viewNames.get(viewId) ?? viewId)
      : sessionTitle(session.id);
    const subtitle = isChild
      ? `${childState?.status ?? 'sub-agent'} · read-only — Esc cancels, Tab returns`
      : `${session.engine.modelId} · ${session.engine.mode.toUpperCase()} · ${session.id}`;
    commitRaw(
      renderSessionHeader(
        {
          title,
          kind: isChild ? 'subagent' : 'session',
          subtitle,
          ...(childState !== undefined ? { childStatus: childState.status } : {}),
        },
        width,
      ),
    );
    const entries = view(session, viewId).entries;
    const shown = entries.slice(-REPLAY_MAX);
    if (entries.length > shown.length) {
      commitBlock([style(`… ${entries.length - shown.length} earlier entries omitted`, tk.dim)]);
    }
    let open: TranscriptEntry | undefined;
    for (const entry of shown) {
      if (entry.kind === 'assistant' && entry.done === false) {
        open = entry;
        continue;
      }
      commitBlock(renderEntry(entry, width));
    }
    if (open !== undefined && session.busy) openTail(open.text);
    const running = [...entries]
      .reverse()
      .find((entry) => entry.kind === 'tool' && entry.toolState === 'running');
    if (running !== undefined && session.busy) {
      runningTool = {
        id: running.toolId ?? '',
        name: running.text,
        ...(running.argsValue !== undefined ? { args: running.argsValue } : {}),
      };
    }
  }

  function replayArchived(frozen: { id: string; title: string; entries: TranscriptEntry[] }): void {
    commitRaw(
      renderSessionHeader(
        {
          title: frozen.title,
          kind: 'archived',
          subtitle: 'archived · read-only — unarchive from the session manager to continue',
        },
        width,
      ),
    );
    const shown = frozen.entries.slice(-REPLAY_MAX);
    if (frozen.entries.length > shown.length) {
      commitBlock([
        style(`… ${frozen.entries.length - shown.length} earlier entries omitted`, tk.dim),
      ]);
    }
    for (const entry of shown) commitBlock(renderEntry(entry, width));
  }

  /**
   * Re-emit the visible transcript at the current width.
   *
   * Rows already in scrollback carry the width they were written at and the
   * terminal will not re-wrap them, so following a resize means discarding
   * them and rendering the conversation again from the entries it came from.
   * Everything past the replay cap — and anything the user had scrolled back
   * to — is lost in the process, which is why this only runs when the width
   * actually changed and only once the drag has settled.
   */
  function reflowTranscript(): void {
    lastReflowAt = Date.now();
    if (overlay.active !== null) return;
    // The message in flight is re-rendered from its entry, so the tail it was
    // building at the old width is dropped rather than committed.
    tail = undefined;
    runningTool = undefined;
    tailReflowed = false;
    app.resetHistory();
    lastCommittedBlank = true;
    if (archived !== undefined) {
      replayArchived(archived);
    } else if (visible !== undefined) {
      const session = sessions.get(visible.sessionId);
      if (session !== undefined) replayView(session, visible.viewId);
    }
    redraw();
  }

  function scheduleReflow(): void {
    // The renderer holds its surface still from the moment a resize arrives
    // until this rebuild clears it, so the first one runs immediately: any
    // wait here is a wait with the screen frozen. The rest of a drag is
    // rebuilt at a steady interval, since redrawing the conversation for
    // every intermediate size a drag reports would be wasted work.
    const now = Date.now();
    const since = now - lastReflowAt;
    if (reflowTimer !== undefined) clearTimeout(reflowTimer);
    if (since >= RESIZE_REFLOW_MAX_MS) {
      reflowTimer = undefined;
      reflowTranscript();
      return;
    }
    reflowTimer = setTimeout(
      () => {
        reflowTimer = undefined;
        reflowTranscript();
      },
      Math.max(RESIZE_REFLOW_MS, RESIZE_REFLOW_MAX_MS - since),
    );
  }

  async function switchView(sessionId: string, viewId = 'main'): Promise<void> {
    flushTail();
    runningTool = undefined;
    archived = undefined;
    agentMenu = undefined;
    if (!sessions.has(sessionId)) {
      const engine = await workspace.openSession(sessionId);
      attachSession(engine);
    }
    const session = sessions.get(sessionId)!;
    view(session, viewId);
    visible = { sessionId, viewId };
    await session.historyReady;
    replayView(session, viewId);
    workspace.markSeen(sessionId);
    syncSlash(session);
    redraw();
  }

  async function showArchived(id: string): Promise<void> {
    flushTail();
    runningTool = undefined;
    agentMenu = undefined;
    visible = undefined;
    const { messages, turns } = await workspace.readSession(id);
    archived = { id, title: sessionTitle(id), entries: entriesFromHistory(messages, turns) };
    replayArchived(archived);
    workspace.markSeen(id);
    redraw();
  }

  async function newDraft(): Promise<void> {
    const engine = await workspace.createSession();
    attachSession(engine);
    await switchView(engine.threadId);
  }

  function stepSession(delta: number): void {
    const list = workspace.list();
    if (list.length === 0) return;
    const index = list.findIndex((meta) => meta.id === visible?.sessionId);
    const next = list[(index + delta + list.length) % list.length];
    if (next && next.id !== visible?.sessionId) void switchView(next.id);
  }

  async function deleteSession(id: string): Promise<void> {
    sessions.delete(id);
    await workspace.deleteSession(id);
    if (visible?.sessionId === id || archived?.id === id) {
      const next = workspace.list()[0]?.id;
      if (next !== undefined) await switchView(next);
      else await newDraft();
    }
    redraw();
  }

  // --- session attach and turn driving ---------------------------------

  function attachSession(engine: CodeEngine): SessionUI {
    const id = engine.threadId;
    const existing = sessions.get(id);
    if (existing) return existing;
    const session: SessionUI = {
      id,
      engine,
      views: new Map(),
      viewOrder: [],
      viewNames: new Map([['main', 'main']]),
      composer: new Composer(),
      queue: [],
      busy: false,
      state: 'idle',
      activity: '',
      seenChildApprovals: new Set(),
      historyReady: Promise.resolve(),
    };
    sessions.set(id, session);
    view(session, 'main');
    session.historyReady = Promise.all([engine.history(), engine.turns()])
      .then(([messages, turns]) => {
        const log = view(session, 'main');
        const live = log.entries.some((entry) => entry.pin === undefined);
        if (messages.length > 0 && !log.seeded && !live) {
          log.entries = seedEntries(log.entries, messages, turns);
          log.seeded = true;
          session.composer.setHistory(inputHistoryFromMessages(messages));
        }
      })
      .catch(() => {});
    engine.onSubagentEvent((childId, ev) => {
      const state = engine.subagentStates().find((s) => s.id === childId);
      if (state) session.viewNames.set(childId, state.name);
      applyAgentEvent(session, childId, ev);
    });
    engine.onSubagentStatus((childId, state) => {
      session.viewNames.set(childId, state.name);
      const log = view(session, childId);
      if (log.entries.length === 0) {
        log.entries.push({ kind: 'user', text: state.spec.task, done: true });
      }
      if (state.status === 'awaiting_approval' && state.approval) {
        const token = state.approval.token;
        if (!session.seenChildApprovals.has(token)) {
          session.seenChildApprovals.add(token);
          approvalQueue.push({
            sessionId: id,
            prompt: {
              sourceLabel: `${sessionTitle(id)} / ${state.name}`,
              request: state.approval.request,
            },
            decide: (approved) => {
              if (approved) engine.approveSubagent(childId);
              else engine.rejectSubagent(childId, 'rejected by user');
            },
          });
        }
      }
      if (state.status === 'awaiting_review' || state.status === 'done') {
        finalizeAssistant(session, childId);
        if (state.doneReport) {
          const marker = `suggests done: ${state.doneReport}`;
          if (!log.entries.some((e) => e.kind === 'notice' && e.text === marker)) {
            pushEntry(session, childId, { kind: 'notice', text: marker, done: true, pin: 'bottom' });
          }
        }
        void engine.subagentHistory(childId).then((messages) => {
          if (messages.length > 0) log.entries = seedEntries(log.entries, messages);
        });
      }
      if (state.status === 'failed') {
        pushEntry(session, childId, {
          kind: 'notice',
          text: `failed: ${state.error ?? 'unknown'}`,
          done: true,
          pin: 'bottom',
        });
      }
      redraw();
    });
    for (const state of engine.subagentStates()) {
      session.viewNames.set(state.id, state.name);
      const log = view(session, state.id);
      void engine.subagentHistory(state.id).then((messages) => {
        if (messages.length > 0) log.entries = seedEntries(log.entries, messages);
      });
    }
    return session;
  }

  function requestParentDecision(
    session: SessionUI,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      approvalQueue.push({
        sessionId: session.id,
        prompt: { sourceLabel: `${sessionTitle(session.id)} / main`, request },
        decide: resolve,
      });
      redraw();
    });
  }

  function decideApproval(approved: boolean): void {
    const item = approvalQueue.shift();
    if (!item) return;
    item.decide(approved);
    const session = sessions.get(item.sessionId);
    if (session) {
      pushEntry(session, 'main', {
        kind: 'notice',
        text: `${approved ? '✔ approved' : '✗ rejected'} ${item.prompt.request.toolName} — ${item.prompt.sourceLabel}`,
        done: true,
      });
    } else if (visible !== undefined) {
      commitBlock(
        renderApprovalDecision(
          {
            sourceLabel: item.prompt.sourceLabel,
            toolName: item.prompt.request.toolName,
            approved,
          },
          width,
        ),
      );
    }
    redraw();
  }

  function flushQueueAsTurn(session: SessionUI): void {
    if (session.busy || session.queue.length === 0 || approvalQueue.length > 0) return;
    const text = session.queue.splice(0).join('\n\n');
    pushEntry(session, 'main', { kind: 'user', text, done: true });
    void driveTurn(session, (hooks) => session.engine.runTurn(text, hooks));
  }

  async function driveTurn(
    session: SessionUI,
    start: (hooks: {
      onEvent: (ev: AgentEvent) => void;
      signal: AbortSignal;
    }) => Promise<TurnResult>,
  ): Promise<void> {
    session.busy = true;
    session.state = 'working';
    session.flash = undefined;
    session.turnStartedAt = Date.now();
    session.activity = 'thinking';
    session.abort = new AbortController();
    syncSpinner();
    const onEvent = (ev: AgentEvent): void => {
      if (ev.type === 'retry') session.flash = `retry ${ev.attempt}`;
      else if (ev.type === 'fallback') session.flash = `fallback → ${ev.model}`;
      if (ev.type === 'tool_start') session.activity = ev.name;
      else if (ev.type === 'tool_result') session.activity = 'thinking';
      else if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
        session.activity = 'responding';
      }
      applyAgentEvent(session, 'main', ev);
    };
    try {
      redraw();
      let result = await start({ onEvent, signal: session.abort.signal });
      while (result.status === 'suspended') {
        if (!result.approval) {
          notice(session, `suspended: ${result.suspendReason ?? 'external input required'}`);
          break;
        }
        session.state = 'waiting';
        session.activity = 'waiting for approval';
        redraw();
        const token = result.approval.token;
        const approved = await requestParentDecision(session, result.approval.request);
        session.state = 'working';
        session.activity = 'thinking';
        redraw();
        result = approved
          ? await session.engine.approve(token, { onEvent, signal: session.abort.signal })
          : await session.engine.reject(token, 'rejected by user', {
              onEvent,
              signal: session.abort.signal,
            });
      }
      finalizeAssistant(session, 'main');
      if (result.status === 'done') session.state = 'idle';
      else if (result.status !== 'suspended') {
        session.state = 'error';
        session.flash = `turn ${result.status}`;
      }
    } catch (err) {
      finalizeAssistant(session, 'main');
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort')) {
        notice(session, '[turn cancelled]');
        session.state = 'idle';
        session.flash = 'cancelled';
      } else {
        notice(session, `error: ${message}`);
        session.state = 'error';
        session.flash = 'error';
      }
    } finally {
      session.busy = false;
      session.abort = undefined;
      if (isVisible(session.id, 'main')) {
        flushTail();
        runningTool = undefined;
      }
      pushEntry(session, 'main', {
        kind: 'turn',
        text: turnMarkerText({
          at: Date.now(),
          durationMs: Date.now() - (session.turnStartedAt ?? Date.now()),
          status: session.state === 'error' ? 'error' : 'done',
          messages: 0,
        }),
        done: true,
      });
      session.turnStartedAt = undefined;
      session.activity = '';
      syncSpinner();
      redraw();
      flushQueueAsTurn(session);
    }
  }

  function steerMessage(session: SessionUI, index: number): void {
    const [message] = session.queue.splice(index, 1);
    if (message === undefined) return;
    session.engine.steer(message);
    pushEntry(session, 'main', { kind: 'notice', text: `↳ steered: ${message}`, done: true });
  }

  // --- commands and menus ----------------------------------------------

  function setMode(session: SessionUI, mode: (typeof MODE_ORDER)[number]): void {
    session.engine.setMode(mode);
    notice(session, MODE_HELP[mode]);
  }

  function cycleMode(session: SessionUI): void {
    const index = MODE_ORDER.indexOf(session.engine.mode);
    setMode(session, MODE_ORDER[(index + 1) % MODE_ORDER.length]!);
  }

  function cycleView(session: SessionUI, delta: number): void {
    const order = ['main', ...session.viewOrder.filter((id) => id !== 'main')];
    const index = Math.max(0, order.indexOf(visible?.viewId ?? 'main'));
    const next = order[(index + delta + order.length) % order.length]!;
    void switchView(session.id, next);
  }

  function modelCatalog(session: SessionUI, force = false): Promise<ModelInfo[]> {
    if (force) catalog = undefined;
    catalog ??= session.engine.listModels().catch((err: unknown) => {
      catalog = undefined;
      throw err;
    });
    return catalog;
  }

  function openModelPicker(session: SessionUI): void {
    overlay.open(
      new ModelPickerView({
        currentModel: () => session.engine.modelId,
        load: (force) => modelCatalog(session, force),
        onPick: (modelId) => {
          void session.engine
            .setModel(modelId)
            .then(() => notice(session, `model → ${session.engine.modelId}`))
            .catch((err: unknown) =>
              notice(session, err instanceof Error ? err.message : String(err)),
            );
        },
        refresh: () => overlay.refresh(),
      }),
    );
  }

  function openSessionManager(): void {
    overlay.open(
      new SessionManagerView({
        projectName: projectName(),
        list: (o) => workspace.list(o),
        activityFor: (id) => workspace.activity(id),
        onOpen: (id) => void switchView(id),
        onOpenArchived: (id) => void showArchived(id),
        onNew: () => void newDraft(),
        onRename: (id, title) => void workspace.setTitle(id, title),
        onArchive: (id, flag) => void workspace.archiveSession(id, flag),
        onDelete: (id) => void deleteSession(id),
      }),
    );
  }

  function openAgentMenu(session: SessionUI): void {
    const states = session.engine.subagentStates();
    const items: ListItem[] = [
      {
        kind: 'item',
        key: 'main',
        label: sessionTitle(session.id),
        glyph: `${tk.cyan}❯${tk.reset}`,
        current: visible?.viewId === 'main',
      },
      ...states.map(
        (state): ListItem => ({
          kind: 'item',
          key: state.id,
          label: state.name,
          glyph: CHILD_GLYPHS[state.status],
          detail: state.status,
          current: visible?.viewId === state.id,
        }),
      ),
    ];
    agentMenu = new SelectList({ maxRows: AGENT_MENU_MAX_ROWS });
    agentMenu.setItems(items);
    agentMenu.selectKey(visible?.viewId ?? 'main');
    redraw();
  }

  async function handleCommand(session: SessionUI, line: string): Promise<void> {
    const [command, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command) {
      case 'help':
        notice(
          session,
          [
            '/model — model picker (or /model <id>) · /title <t> — rename session',
            '/plan · /build · /auto — permission level (Shift+Tab cycles)',
            '/agents or Ctrl+G — switch between this session and its sub-agents',
            '/sessions or Ctrl+B — session manager · /new — new session · /archive',
            'Ctrl+N/P — next/prev session · Tab — cycle views · Esc — cancel',
            'Select and copy with the mouse — the terminal owns selection here;',
            'scroll with the terminal (wheel, PgUp, or your scrollback keys).',
            'While a turn runs: Enter queues, Ctrl+S steers; the queue sends when the turn ends.',
          ].join('\n'),
        );
        break;
      case 'model':
        if (arg.length === 0) {
          openModelPicker(session);
          break;
        }
        try {
          await session.engine.setModel(arg);
          notice(session, `model → ${session.engine.modelId}`);
        } catch (err) {
          notice(session, err instanceof Error ? err.message : String(err));
        }
        break;
      case 'title':
        if (arg.length === 0) {
          notice(session, `title: ${sessionTitle(session.id)}`);
          break;
        }
        await workspace.setTitle(session.id, arg);
        notice(session, `title → ${sessionTitle(session.id)}`);
        break;
      case 'plan':
      case 'build':
      case 'auto':
        setMode(session, command);
        break;
      case 'agents':
        openAgentMenu(session);
        break;
      case 'sessions':
        openSessionManager();
        break;
      case 'archive': {
        const meta = workspace.meta(session.id);
        await workspace.archiveSession(session.id, !(meta?.archived ?? false));
        notice(session, meta?.archived ? 'session unarchived' : 'session archived');
        break;
      }
      case 'new':
        await newDraft();
        break;
      case 'debug':
        notice(
          session,
          [
            `terminal ${width}×${height} · TERM=${env.TERM ?? '?'}${
              env.TERM_PROGRAM ? ` · ${env.TERM_PROGRAM}` : ''
            }${env.TMUX ? ' · inside tmux' : ''}`,
            'inline mode: chat history lives in terminal scrollback (native selection);',
            'mouse capture is on only inside the session manager and model picker.',
          ].join('\n'),
        );
        break;
      case 'exit':
      case 'quit':
        quit();
        break;
      default:
        notice(session, `unknown command: /${command} — try /help`);
    }
    redraw();
  }

  function quit(): void {
    if (quitting) return;
    quitting = true;
    if (paintTimer !== undefined) clearTimeout(paintTimer);
    if (reflowTimer !== undefined) clearTimeout(reflowTimer);
    if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    finish?.();
  }

  function submit(session: SessionUI): void {
    const line = session.composer.text.trim();
    if (line.length === 0) return;
    session.composer.pushHistory(line);
    session.composer.clear();
    syncSlash(session);
    if (line.startsWith('/')) {
      void handleCommand(session, line);
      return;
    }
    if (session.busy) {
      session.queue.push(line);
      redraw();
      return;
    }
    pushEntry(session, 'main', { kind: 'user', text: line, done: true });
    void driveTurn(session, (hooks) => session.engine.runTurn(line, hooks));
  }

  // --- slash selector ---------------------------------------------------

  function slashMatches(session: SessionUI): SlashCommand[] {
    if (visible === undefined || visible.viewId !== 'main') return [];
    if (approvalQueue.length > 0) return [];
    const input = session.composer.text;
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const prefix = input.slice(1).toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
    if (matches.length === 1 && matches[0]!.name === prefix) return [];
    return matches;
  }

  function syncSlash(session: SessionUI): void {
    const matches = slashMatches(session);
    if (matches.length === 0) {
      slash = undefined;
      return;
    }
    slash ??= new SelectList({ maxRows: SLASH_MAX_ROWS });
    slash.setItems(
      matches.map(
        (c): ListItem => ({
          kind: 'item',
          key: c.name,
          label: `/${c.name}${c.args.length > 0 ? ` ${c.args}` : ''}`,
          detail: c.description,
        }),
      ),
      { keepKey: true },
    );
  }

  function applySlashCommand(session: SessionUI, name: string): void {
    const command = SLASH_COMMANDS.find((c) => c.name === name);
    if (!command) return;
    if (command.submits) {
      session.composer.buffer.setText(`/${command.name}`);
      submit(session);
    } else {
      session.composer.buffer.setText(`/${command.name} `);
      syncSlash(session);
    }
    redraw();
  }

  // --- footer -----------------------------------------------------------

  /**
   * The four attention dots, as one segment beside the project name.
   *
   * They sit with the rest of the bar rather than against the right edge: a
   * right-aligned cluster has to be re-placed the moment the window changes
   * width, and until it is, it hangs off the end of the row.
   */
  function attentionDots(): string {
    const summary = workspace.attentionSummary(visible?.sessionId ?? archived?.id);
    const flags: Record<(typeof ATTENTION_ORDER)[number], boolean> = {
      busy: summary.busy,
      input:
        summary.input ||
        approvalQueue.some((item) => item.sessionId !== visible?.sessionId),
      error: summary.error,
      done: summary.done,
    };
    // Filled when lit, hollow when not — a dim `·` would read as one of the
    // separators the rest of the bar is built from.
    return ATTENTION_ORDER.map((kind) =>
      flags[kind] ? `${ATTENTION[kind]}●${tk.reset}` : style('○', tk.dim),
    ).join(' ');
  }

  function statusSegments(session: SessionUI | undefined): Segment[] {
    const left: Segment[] = [
      { text: `≡ ${projectName()}`, key: 'sessions', style: tk.bold },
      { text: attentionDots(), attached: true },
    ];
    if (archived !== undefined) {
      left.push({ text: archived.title });
      left.push({ text: 'ARCHIVED · read-only', style: tk.dim });
    } else if (session !== undefined) {
      left.push({ text: session.engine.modelId, key: 'model' });
      left.push({
        text: session.engine.mode.toUpperCase(),
        key: 'mode',
        style: MODE_COLORS[session.engine.mode],
      });
      const states = session.engine.subagentStates();
      if (visible !== undefined && visible.viewId !== 'main') {
        left.push({
          text: `agent: ${session.viewNames.get(visible.viewId) ?? visible.viewId}`,
          key: 'agents',
        });
      } else if (states.length > 0) {
        const active = states.filter(
          (s) => s.status === 'working' || s.status === 'awaiting_approval',
        ).length;
        left.push({ text: `${states.length} agents (${active} active)`, key: 'agents' });
      }
      if (session.flash !== undefined) left.push({ text: session.flash, style: tk.dim });
    }
    return left;
  }

  function composerPlaceholder(session: SessionUI): string {
    if (approvalQueue.length > 0) return 'decide the approval above (y/n)';
    if (session.busy) return 'type to queue; Enter queues, Ctrl+S steers';
    if (session.engine.planMode) return 'describe what to plan…';
    return 'ask, or /help';
  }

  function footerState(tailLines: string[]): FooterState {
    const session = focused();
    const editable = session !== undefined && visible?.viewId === 'main' && archived === undefined;
    const busy = session?.busy ?? false;
    const states = session?.engine.subagentStates() ?? [];
    return {
      width,
      height,
      busy,
      spinnerFrame: SPINNER_FRAMES[spinnerIndex]!,
      planMode: session?.engine.planMode ?? false,
      activity: session?.activity ?? '',
      ...(session?.turnStartedAt !== undefined ? { turnStartedAt: session.turnStartedAt } : {}),
      subagentsActive: states.filter(
        (s) => s.status === 'working' || s.status === 'awaiting_approval',
      ).length,
      tailLines,
      transcriptEndsBlank: lastCommittedBlank,
      ...(runningTool !== undefined && busy ? { runningTool } : {}),
      queue: session?.queue ?? [],
      ...(approvalQueue.length > 0
        ? { approval: { item: approvalQueue[0]!.prompt, queueLength: approvalQueue.length } }
        : {}),
      ...(slash !== undefined && editable ? { slash } : {}),
      ...(editable ? { composer: session.composer } : {}),
      composerPlaceholder: session !== undefined ? composerPlaceholder(session) : '',
      ...(agentMenu !== undefined ? { agentMenu } : {}),
      status: statusSegments(session),
    };
  }

  /** Tail rows this footer can show — what must be committed, and what is drawn. */
  function currentTailAllowance(): number {
    return tailAllowance(footerState([]));
  }

  function footerFrame(): ReturnType<typeof composeFooter> {
    return composeFooter(footerState(tail?.tailLines(currentTailAllowance()) ?? []));
  }

  // --- input ------------------------------------------------------------

  async function handleEvent(event: TuiEvent): Promise<void> {
    if (overlay.handleEvent(event)) return;
    if (event.type !== 'key') return;
    const session = focused();
    if (approvalQueue.length > 0) {
      if (event.key === 'y') decideApproval(true);
      else if (event.key === 'n') decideApproval(false);
      return;
    }
    if (event.ctrl && event.key === 'c') {
      if (session?.busy) session.abort?.abort();
      else quit();
      return;
    }
    if (event.ctrl && event.key === 'b') {
      openSessionManager();
      return;
    }
    if (event.ctrl && event.key === 'n') {
      stepSession(1);
      return;
    }
    if (event.ctrl && event.key === 'p') {
      stepSession(-1);
      return;
    }
    if (event.ctrl && event.key === 'g') {
      if (session) {
        if (agentMenu !== undefined) agentMenu = undefined;
        else openAgentMenu(session);
        redraw();
      }
      return;
    }
    if (event.ctrl && event.key === 's') {
      if (session !== undefined && session.queue.length > 0) steerMessage(session, 0);
      return;
    }
    if (event.key === 'escape') {
      if (agentMenu !== undefined) {
        agentMenu = undefined;
        redraw();
        return;
      }
      if (session !== undefined && visible !== undefined && visible.viewId !== 'main') {
        session.engine.cancelSubagent(visible.viewId);
        notice(session, 'cancelled', visible.viewId);
        return;
      }
      if (session?.busy) session.abort?.abort();
      return;
    }
    if (agentMenu !== undefined && session !== undefined) {
      if (event.key === 'up' || event.key === 'down') {
        agentMenu.move(event.key === 'down' ? 1 : -1);
        redraw();
        return;
      }
      if (event.key === 'enter') {
        const key = agentMenu.selectedKey;
        agentMenu = undefined;
        if (key !== undefined) void switchView(session.id, key);
        return;
      }
      agentMenu = undefined;
      redraw();
    }
    if (event.key === 'tab' && event.shift !== true) {
      if (slash !== undefined && session !== undefined) {
        const key = slash.selectedKey;
        const command = SLASH_COMMANDS.find((c) => c.name === key);
        if (command !== undefined) {
          session.composer.buffer.setText(`/${command.name}${command.submits ? '' : ' '}`);
          syncSlash(session);
          redraw();
        }
        return;
      }
      if (session !== undefined) cycleView(session, 1);
      return;
    }
    if (event.key === 'tab' && event.shift === true) {
      if (session !== undefined) cycleMode(session);
      return;
    }
    if (slash !== undefined && session !== undefined) {
      if (event.key === 'up' || event.key === 'down') {
        slash.move(event.key === 'down' ? 1 : -1);
        redraw();
        return;
      }
      if (event.key === 'enter') {
        const key = slash.selectedKey;
        if (key !== undefined) applySlashCommand(session, key);
        return;
      }
    }
    if (session === undefined || archived !== undefined || visible?.viewId !== 'main') return;
    const action = session.composer.handleKey(event as TuiKeyEvent, width);
    if (action === 'submit') {
      submit(session);
    } else if (action === 'edited') {
      syncSlash(session);
      redraw();
    }
  }

  // --- wiring -----------------------------------------------------------

  const app: InlineApp = renderInline(() => {
    revision.get();
    return footerFrame();
  }, {
    input: true,
    mouse: false,
    motion: true,
    maxFooterRows: MAX_FOOTER_ROWS,
    onEvent: handleEvent,
    onResize: (size) => {
      // Width decides how the text wraps, and height decides how much of the
      // screen the renderer had to clear to keep its own footer from being
      // stranded — either way the transcript is re-emitted from source.
      width = size.width;
      height = size.height;
      scheduleReflow();
      redraw();
    },
  });
  const overlay = new OverlayController(app);
  const initial = app.size();
  width = initial.width;
  height = initial.height;

  workspace.onChange(() => {
    // Archiving releases the engine, so a live view of that session would be
    // holding a closed one; it becomes the frozen view instead.
    for (const id of [...sessions.keys()]) {
      if (!workspace.meta(id)?.archived) continue;
      if (visible?.sessionId === id) void showArchived(id);
      else sessions.delete(id);
    }
    // The focused session's outcomes are already on screen; only background
    // sessions should light attention dots.
    if (visible !== undefined) workspace.markSeen(visible.sessionId);
    overlay.refresh();
    redraw();
  });

  const initialId = opts.sessionId ?? workspace.list()[0]?.id;
  let initialSession: SessionUI | undefined;
  if (initialId !== undefined) {
    const engine = workspace.engineFor(initialId) ?? (await workspace.openSession(initialId));
    initialSession = attachSession(engine);
    await initialSession.historyReady;
    view(initialSession, 'main').entries.unshift({
      kind: 'notice',
      text: 'fino code — /help for commands, Ctrl+B for sessions, Shift+Tab cycles mode. Select text with the mouse; the terminal owns scrollback.',
      done: true,
      pin: 'top',
    });
    await switchView(initialSession.id);
    // Warm the provider catalog now so the model picker opens populated;
    // a failure here is not worth reporting until the picker is opened.
    void modelCatalog(initialSession).catch(() => {});
  }

  if (opts.recover && initialSession) {
    const session = initialSession;
    void driveTurn(session, async (hooks) => {
      const recovered = await session.engine.recoverTurn(hooks);
      if (recovered) {
        notice(session, '[resumed interrupted turn]');
        return recovered;
      }
      return { status: 'done' } as TurnResult;
    });
  }

  try {
    await finished;
  } finally {
    await app.stop();
    await workspace.close();
  }
}
