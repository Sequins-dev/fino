/**
 * fino:commands/code/tui — multi-session terminal interface for `fino code`.
 *
 * A workspace TUI over `fino:tty/tui`. A collapsible sidebar (hidden by
 * default for a clean single-session experience, `Ctrl+B` to toggle) lists
 * open sessions ordered by recent activity with working/waiting/idle
 * indicators, expands each session into its nested sub-agent rows — active
 * children bright, settled ones dim — and keeps archived sessions in a
 * history list below. Several sessions can run turns concurrently; the
 * focused one renders as a transcript with markdown-rendered assistant
 * messages, a message queue with clickable `[steer now]` actions, an input
 * line, and a status bar. Sub-agent views are read-only parent↔child
 * conversations. Tool approvals from every session and sub-agent surface in
 * one global blocking popover answered with `y`/`n`.
 *
 * Turn execution, durability, transcripts, and the sub-agent pools live in
 * `CodeEngine`/`CodeWorkspace`; this module maps keys, clicks, and agent
 * events onto them.
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
import type { SubagentState } from 'fino:ai/subagents';
import type { ModelMessage } from 'fino:ai/model';
import { renderMarkdownTerminal } from 'fino:format/markdown';
import { h } from 'fino:ui';
import { Box, Text, measureTerminalSize, render, type TuiApp, type TuiEvent } from 'fino:tty/tui';
import type { CodeEngine, TurnResult } from 'fino:commands/code/engine';
import type { CodeWorkspace } from 'fino:commands/code/workspace';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const INVERSE = '\x1b[7m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE_BG = '\x1b[44m';
const MAGENTA_BG = '\x1b[45m';
const RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const REDRAW_INTERVAL_MS = 33;
const QUEUE_PANE_MAX = 3;
const SIDEBAR_WIDTH = 28;

interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  done: boolean;
  toolState?: 'running' | 'ok' | 'error';
  toolId?: string;
  cachedLines?: string[];
  cachedKey?: string;
}

interface TabView {
  entries: TranscriptEntry[];
  scrollOffset: number;
  stickToBottom: boolean;
}

interface QueuedMessage {
  text: string;
}

interface SessionUI {
  id: string;
  engine: CodeEngine;
  views: Map<string, TabView>;
  viewOrder: string[];
  viewNames: Map<string, string>;
  focusedView: string;
  input: string;
  inputHistory: string[];
  historyIndex: number;
  queue: QueuedMessage[];
  busy: boolean;
  abort?: AbortController;
  status: string;
  seenChildApprovals: Set<string>;
}

interface ApprovalItem {
  sessionId: string;
  sourceLabel: string;
  request: ToolApprovalRequest;
  decide: (approved: boolean) => void;
}

type SidebarRow =
  | { kind: 'action-new' }
  | { kind: 'session'; id: string; archived: boolean }
  | { kind: 'child'; sessionId: string; childId: string }
  | { kind: 'divider'; label: string };

interface ContextMenuState {
  sessionId: string;
  selected: number;
  confirmDelete: boolean;
}

const CHILD_GLYPHS: Record<SubagentState['status'], string> = {
  working: '⟳',
  awaiting_approval: '?',
  awaiting_review: '✔',
  done: '●',
  failed: '✗',
  cancelled: '✗',
};

function visibleWidth(text: string): number {
  return Array.from(text.replace(ANSI_RE, '')).length;
}

function padVisible(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

function clipVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let out = '';
  let seen = 0;
  let index = 0;
  while (index < text.length && seen < width - 1) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(text);
    if (match && match.index === index) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(index)!);
    out += ch;
    seen += 1;
    index += ch.length;
  }
  return out + '…' + RESET;
}

function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const words = raw.split(' ');
    let line = '';
    for (const word of words) {
      if (word === '' && line === '') continue;
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
      while (line.length > limit) {
        lines.push(line.slice(0, limit));
        line = line.slice(limit);
      }
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
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
 * Run the interactive multi-session `fino code` TUI until the user exits.
 *
 * Enters the alternate screen, drives turns across the workspace's
 * sessions, and always restores the terminal — including on errors —
 * before resolving.
 */
export async function runCodeTui(
  workspace: CodeWorkspace,
  opts: CodeTuiOptions = {},
): Promise<void> {
  const terminal = await measureTerminalSize();
  let width = terminal.width;
  let height = terminal.height;

  const sessions = new Map<string, SessionUI>();
  let focusedSessionId = '';
  let sidebarVisible = false;
  let sidebarIndex = 0;
  let sidebarScroll = 0;
  const expanded = new Set<string>();
  const approvalQueue: ApprovalItem[] = [];
  let app: TuiApp;
  let lastPaint = 0;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let queueHitRows: Array<{ row: number; buttonStart: number; buttonEnd: number; index: number }> =
    [];
  let queueTop = 0;
  let sidebarRowsCache: SidebarRow[] = [];
  let contextMenu: ContextMenuState | undefined;
  let menuHitRows: Array<{ row: number; index: number }> = [];
  let menuTop = 0;

  function contextMenuItems(menu: ContextMenuState): string[] {
    const meta = workspace.meta(menu.sessionId);
    return [
      'Rename',
      meta?.archived ? 'Unarchive' : 'Archive',
      menu.confirmDelete ? 'Delete — press again to confirm' : 'Delete',
    ];
  }

  async function runContextMenuItem(menu: ContextMenuState, index: number): Promise<void> {
    const meta = workspace.meta(menu.sessionId);
    if (!meta) {
      contextMenu = undefined;
      redraw();
      return;
    }
    if (index === 0) {
      contextMenu = undefined;
      await focusSession(menu.sessionId);
      const session = focused();
      if (session)
        session.input = `/title ${meta.title === 'untitled' ? '' : meta.title}`.trimEnd() + ' ';
    } else if (index === 1) {
      contextMenu = undefined;
      await workspace.archiveSession(menu.sessionId, !meta.archived);
    } else if (index === 2) {
      if (!menu.confirmDelete) {
        menu.confirmDelete = true;
        redraw();
        return;
      }
      contextMenu = undefined;
      sessions.delete(menu.sessionId);
      await workspace.deleteSession(menu.sessionId);
      if (focusedSessionId === menu.sessionId) {
        focusedSessionId = workspace.list()[0]?.id ?? '';
        if (focusedSessionId && !sessions.has(focusedSessionId)) {
          await focusSession(focusedSessionId);
        }
      }
    }
    redraw();
  }

  function contentWidth(): number {
    return Math.max(20, width - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0) - 2);
  }

  function focused(): SessionUI | undefined {
    return sessions.get(focusedSessionId);
  }

  function view(session: SessionUI, id: string): TabView {
    let v = session.views.get(id);
    if (!v) {
      v = { entries: [], scrollOffset: 0, stickToBottom: true };
      session.views.set(id, v);
      session.viewOrder.push(id);
    }
    return v;
  }

  function entryLines(entry: TranscriptEntry, cw: number): string[] {
    const key = `${entry.kind}:${entry.done}:${entry.toolState ?? ''}:${entry.text.length}:${cw}`;
    if (entry.cachedKey === key && entry.cachedLines) return entry.cachedLines;
    let lines: string[];
    if (entry.kind === 'user') {
      lines = wrapPlain(entry.text, cw - 2).map(
        (line, index) => (index === 0 ? `${CYAN}❯${RESET} ` : '  ') + line,
      );
    } else if (entry.kind === 'assistant') {
      lines = entry.done
        ? renderMarkdownTerminal(entry.text, { width: cw }).split('\n')
        : wrapPlain(entry.text, cw);
    } else if (entry.kind === 'tool') {
      const mark =
        entry.toolState === 'running'
          ? `${YELLOW}●${RESET}`
          : entry.toolState === 'ok'
            ? `${GREEN}●${RESET}`
            : `${RED}●${RESET}`;
      lines = [`${mark} ${DIM}${entry.text}${RESET}`];
    } else {
      lines = wrapPlain(entry.text, cw).map((line) => `${DIM}${line}${RESET}`);
    }
    entry.cachedKey = key;
    entry.cachedLines = lines;
    return lines;
  }

  function transcriptRows(session: SessionUI): string[] {
    const cw = contentWidth();
    const tab = view(session, session.focusedView);
    const rows: string[] = [];
    for (const entry of tab.entries) {
      if (rows.length > 0) rows.push('');
      rows.push(...entryLines(entry, cw));
    }
    return rows;
  }

  function notice(session: SessionUI, text: string, viewId = 'main'): void {
    view(session, viewId).entries.push({ kind: 'notice', text, done: true });
    redraw();
  }

  function currentAssistant(tab: TabView): TranscriptEntry {
    const last = tab.entries[tab.entries.length - 1];
    if (last && last.kind === 'assistant' && !last.done) return last;
    const entry: TranscriptEntry = { kind: 'assistant', text: '', done: false };
    tab.entries.push(entry);
    return entry;
  }

  function finalizeAssistant(tab: TabView): void {
    const last = tab.entries[tab.entries.length - 1];
    if (last && last.kind === 'assistant' && !last.done) {
      if (last.text.trim().length === 0) tab.entries.pop();
      else last.done = true;
    }
  }

  function applyAgentEvent(tab: TabView, ev: AgentEvent): void {
    if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
      currentAssistant(tab).text += ev.event.text;
    } else if (ev.type === 'tool_start') {
      finalizeAssistant(tab);
      tab.entries.push({
        kind: 'tool',
        text: ev.name,
        done: true,
        toolState: 'running',
        toolId: ev.id,
      });
    } else if (ev.type === 'tool_result' || ev.type === 'tool_error') {
      for (let index = tab.entries.length - 1; index >= 0; index--) {
        const entry = tab.entries[index]!;
        if (entry.kind === 'tool' && entry.toolId === ev.id) {
          entry.toolState =
            ev.type === 'tool_error' || (ev.type === 'tool_result' && ev.isError) ? 'error' : 'ok';
          break;
        }
      }
    }
    redraw();
  }

  function seedFromHistory(tab: TabView, messages: ModelMessage[]): void {
    tab.entries = [];
    for (const message of messages) {
      if (message.role === 'user' && typeof message.content === 'string') {
        const synthetic = message.content.startsWith('[subagent settlement]');
        tab.entries.push({
          kind: synthetic ? 'notice' : 'user',
          text: message.content,
          done: true,
        });
      } else if (message.role === 'assistant') {
        if (typeof message.content === 'string') {
          tab.entries.push({ kind: 'assistant', text: message.content, done: true });
        } else {
          for (const part of message.content) {
            if (part.type === 'text' && part.text.trim().length > 0) {
              tab.entries.push({ kind: 'assistant', text: part.text, done: true });
            } else if (part.type === 'tool_use') {
              tab.entries.push({
                kind: 'tool',
                text: part.name,
                done: true,
                toolState: 'ok',
                toolId: part.id,
              });
            }
          }
        }
      }
    }
    redraw();
  }

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
      focusedView: 'main',
      input: '',
      inputHistory: [],
      historyIndex: -1,
      queue: [],
      busy: false,
      status: 'Ready',
      seenChildApprovals: new Set(),
    };
    sessions.set(id, session);
    view(session, 'main');
    void engine.history().then((messages) => {
      if (messages.length > 0 && view(session, 'main').entries.length === 0) {
        seedFromHistory(view(session, 'main'), messages);
      }
    });
    engine.onSubagentEvent((childId, ev) => {
      const state = engine.subagentStates().find((s) => s.id === childId);
      if (state) session.viewNames.set(childId, state.name);
      applyAgentEvent(view(session, childId), ev);
    });
    engine.onSubagentStatus((childId, state) => {
      session.viewNames.set(childId, state.name);
      const tab = view(session, childId);
      if (tab.entries.length === 0) {
        tab.entries.push({ kind: 'user', text: state.spec.task, done: true });
      }
      if (state.status === 'awaiting_approval' && state.approval) {
        const token = state.approval.token;
        if (!session.seenChildApprovals.has(token)) {
          session.seenChildApprovals.add(token);
          approvalQueue.push({
            sessionId: id,
            sourceLabel: `${sessionTitle(id)} / ${state.name}`,
            request: state.approval.request,
            decide: (approved) => {
              if (approved) engine.approveSubagent(childId);
              else engine.rejectSubagent(childId, 'rejected by user');
            },
          });
        }
      }
      if (state.status === 'awaiting_review' || state.status === 'done') {
        finalizeAssistant(tab);
        if (state.doneReport) {
          const marker = `suggests done: ${state.doneReport}`;
          if (!tab.entries.some((e) => e.kind === 'notice' && e.text === marker)) {
            tab.entries.push({ kind: 'notice', text: marker, done: true });
          }
        }
        void engine.subagentHistory(childId).then((messages) => {
          if (messages.length > 0) seedFromHistory(tab, messages);
        });
      }
      if (state.status === 'failed') {
        tab.entries.push({
          kind: 'notice',
          text: `failed: ${state.error ?? 'unknown'}`,
          done: true,
        });
      }
      redraw();
    });
    for (const state of engine.subagentStates()) {
      session.viewNames.set(state.id, state.name);
      const tab = view(session, state.id);
      void engine.subagentHistory(state.id).then((messages) => {
        if (messages.length > 0) seedFromHistory(tab, messages);
      });
    }
    return session;
  }

  function sessionTitle(id: string): string {
    return workspace.meta(id)?.title ?? id;
  }

  async function focusSession(id: string): Promise<void> {
    focusedSessionId = id;
    expanded.add(id);
    if (!sessions.has(id)) {
      const engine = await workspace.openSession(id);
      attachSession(engine);
    }
    redraw();
  }

  function requestParentDecision(
    session: SessionUI,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      approvalQueue.push({
        sessionId: session.id,
        sourceLabel: `${sessionTitle(session.id)} / main`,
        request,
        decide: resolve,
      });
      redraw();
    });
  }

  function flushQueueAsTurn(session: SessionUI): void {
    if (session.busy || session.queue.length === 0 || approvalQueue.length > 0) return;
    const text = session.queue
      .splice(0)
      .map((m) => m.text)
      .join('\n\n');
    view(session, 'main').entries.push({ kind: 'user', text, done: true });
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
    session.status = session.engine.planMode ? 'Planning…' : 'Working…';
    session.abort = new AbortController();
    redraw();
    const main = view(session, 'main');
    const onEvent = (ev: AgentEvent): void => {
      if (ev.type === 'retry') session.status = `Retrying (${ev.attempt})…`;
      else if (ev.type === 'fallback') session.status = `Fallback to ${ev.model}…`;
      applyAgentEvent(main, ev);
    };
    try {
      let result = await start({ onEvent, signal: session.abort.signal });
      while (result.status === 'suspended') {
        if (!result.approval) {
          notice(session, `suspended: ${result.suspendReason ?? 'external input required'}`);
          break;
        }
        session.status = 'Waiting for approval…';
        redraw();
        const token = result.approval.token;
        const approved = await requestParentDecision(session, result.approval.request);
        session.status = 'Working…';
        redraw();
        result = approved
          ? await session.engine.approve(token, { onEvent, signal: session.abort.signal })
          : await session.engine.reject(token, 'rejected by user', {
              onEvent,
              signal: session.abort.signal,
            });
      }
      finalizeAssistant(main);
      if (result.status === 'done') session.status = 'Ready';
      else if (result.status !== 'suspended') session.status = `Turn ${result.status}`;
    } catch (err) {
      finalizeAssistant(main);
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort')) {
        notice(session, '[turn cancelled]');
        session.status = 'Cancelled';
      } else {
        notice(session, `error: ${message}`);
        session.status = 'Error';
      }
    } finally {
      session.busy = false;
      session.abort = undefined;
      view(session, 'main').stickToBottom = true;
      redraw();
      flushQueueAsTurn(session);
    }
  }

  function steerMessage(session: SessionUI, index: number): void {
    const [message] = session.queue.splice(index, 1);
    if (!message) return;
    session.engine.steer(message.text);
    view(session, 'main').entries.push({
      kind: 'notice',
      text: `↳ steered: ${message.text}`,
      done: true,
    });
    redraw();
  }

  // --- sidebar ---------------------------------------------------------

  function sidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [{ kind: 'action-new' }];
    for (const meta of workspace.list()) {
      rows.push({ kind: 'session', id: meta.id, archived: false });
      if (expanded.has(meta.id)) {
        const session = sessions.get(meta.id);
        for (const state of session?.engine.subagentStates() ?? []) {
          rows.push({ kind: 'child', sessionId: meta.id, childId: state.id });
        }
      }
    }
    const archived = workspace.list({ archived: true });
    if (archived.length > 0) {
      rows.push({ kind: 'divider', label: 'archived' });
      for (const meta of archived) rows.push({ kind: 'session', id: meta.id, archived: true });
    }
    return rows;
  }

  function sessionIndicator(id: string): string {
    const activity = sessions.get(id)?.engine.activity ?? workspace.activity(id);
    if (activity === 'working') return `${YELLOW}⟳${RESET}`;
    if (activity === 'waiting') return `${RED}▲${RESET}`;
    return `${DIM}·${RESET}`;
  }

  function sidebarLine(row: SidebarRow, selected: boolean): string {
    const w = SIDEBAR_WIDTH;
    if (row.kind === 'action-new') {
      const label = padVisible(`${GREEN}+${RESET} new session`, w - 2) + `${DIM}«${RESET} `;
      return selected ? `${INVERSE}${label}${RESET}` : label;
    }
    if (row.kind === 'divider') {
      return `${DIM}${padVisible(`— ${row.label} —`, w)}${RESET}`;
    }
    if (row.kind === 'session') {
      const arrow = row.archived ? ' ' : expanded.has(row.id) ? '▾' : '▸';
      const title = clipVisible(sessionTitle(row.id), w - 5);
      const base = `${arrow} ${sessionIndicator(row.id)} ${title}`;
      const padded = padVisible(base, w);
      if (selected) return `${INVERSE}${padded}${RESET}`;
      return row.archived ? `${DIM}${padded}${RESET}` : padded;
    }
    const session = sessions.get(row.sessionId);
    const state = session?.engine.subagentStates().find((s) => s.id === row.childId);
    const glyph = state ? CHILD_GLYPHS[state.status] : '·';
    const name = clipVisible(session?.viewNames.get(row.childId) ?? row.childId, w - 7);
    const active = state && (state.status === 'working' || state.status === 'awaiting_approval');
    const base = `   ${glyph} ${name}`;
    const padded = padVisible(base, w);
    if (selected) return `${INVERSE}${padded}${RESET}`;
    return active ? padded : `${DIM}${padded}${RESET}`;
  }

  function focusSidebarRow(row: SidebarRow): void {
    if (row.kind === 'divider') return;
    if (row.kind === 'action-new') {
      void workspace.createSession().then((engine) => {
        attachSession(engine);
        focusedSessionId = engine.threadId;
        redraw();
      });
      return;
    }
    if (row.kind === 'session') {
      void focusSession(row.id);
      return;
    }
    void focusSession(row.sessionId).then(() => {
      const session = sessions.get(row.sessionId);
      if (session) {
        view(session, row.childId);
        session.focusedView = row.childId;
        redraw();
      }
    });
  }

  // --- rendering -------------------------------------------------------

  function popoverLines(cw: number): string[] {
    const item = approvalQueue[0];
    if (!item) return [];
    const args = JSON.stringify(item.request.args ?? {});
    const innerWidth = Math.max(30, Math.min(cw - 4, 76));
    const body = [
      `${BOLD}approval required${RESET}  ${DIM}(1 of ${approvalQueue.length})${RESET}`,
      '',
      `agent: ${BOLD}${item.sourceLabel}${RESET}`,
      `tool:  ${BOLD}${item.request.toolName}${RESET}${item.request.risk ? ` ${DIM}(${item.request.risk})${RESET}` : ''}`,
      ...wrapPlain(`args:  ${args}`, innerWidth - 4),
      '',
      `${BOLD}y${RESET} approve · ${BOLD}n${RESET} reject`,
    ];
    const top = `${YELLOW}┌${'─'.repeat(innerWidth - 2)}┐${RESET}`;
    const bottom = `${YELLOW}└${'─'.repeat(innerWidth - 2)}┘${RESET}`;
    const pad = (line: string): string =>
      `${YELLOW}│${RESET} ${padVisible(line, innerWidth - 4)} ${YELLOW}│${RESET}`;
    const box = [top, ...body.map(pad), bottom];
    const indent = ' '.repeat(Math.max(0, Math.floor((cw - innerWidth) / 2)));
    return box.map((line) => indent + line);
  }

  function contentLines(session: SessionUI | undefined): string[] {
    const cw = contentWidth();
    const lines: string[] = [];
    if (!session) {
      lines.push(
        '',
        `${DIM}no session — Ctrl+B or click ≡ for the sidebar, /new to start one${RESET}`,
      );
      while (lines.length < height - 2) lines.push('');
      lines.push(
        `${BLUE_BG}${padVisible(`${sidebarVisible ? '«' : '≡'} fino code`, cw + 2)}${RESET}`,
      );
      return lines;
    }
    const queueLines: string[] = [];
    queueHitRows = [];
    if (session.queue.length > 0) {
      const shown = session.queue.slice(0, QUEUE_PANE_MAX);
      for (let index = 0; index < shown.length; index++) {
        const label = ' [steer now]';
        const room = Math.max(4, cw - label.length - 4);
        const text = shown[index]!.text;
        const preview = text.length > room ? text.slice(0, room - 1) + '…' : text;
        queueHitRows.push({
          row: index,
          buttonStart: 2 + preview.length + 1,
          buttonEnd: 2 + preview.length + label.length,
          index,
        });
        queueLines.push(`${DIM}· ${preview}${RESET}${YELLOW}${label}${RESET}`);
      }
      if (session.queue.length > shown.length) {
        queueLines.push(`${DIM}… ${session.queue.length - shown.length} more queued${RESET}`);
      }
    }
    const transcriptHeight = Math.max(1, height - queueLines.length - 2);
    let rows: string[];
    const tab = view(session, session.focusedView);
    if (approvalQueue.length > 0) {
      const popover = popoverLines(cw);
      const padTop = Math.max(0, Math.floor((transcriptHeight - popover.length) / 2));
      rows = [...Array<string>(padTop).fill(''), ...popover];
    } else if (contextMenu) {
      const menu = contextMenu;
      const title = clipVisible(sessionTitle(menu.sessionId), 40);
      const items = contextMenuItems(menu);
      const innerWidth = Math.max(24, Math.min(cw - 4, 48));
      const top = `${YELLOW}┌${'─'.repeat(innerWidth - 2)}┐${RESET}`;
      const bottom = `${YELLOW}└${'─'.repeat(innerWidth - 2)}┘${RESET}`;
      const pad = (line: string): string =>
        `${YELLOW}│${RESET} ${padVisible(line, innerWidth - 4)} ${YELLOW}│${RESET}`;
      const body = [
        `${BOLD}${title}${RESET}`,
        '',
        ...items.map((item, index) =>
          index === menu.selected ? `${INVERSE} ${item} ${RESET}` : ` ${item} `,
        ),
        '',
        `${DIM}↑/↓ select · Enter run · Esc close${RESET}`,
      ];
      const box = [top, ...body.map(pad), bottom];
      const padTop = Math.max(0, Math.floor((transcriptHeight - box.length) / 2));
      const indent = ' '.repeat(Math.max(0, Math.floor((cw - innerWidth) / 2)));
      rows = [...Array<string>(padTop).fill(''), ...box.map((line) => indent + line)];
      menuTop = padTop + 3;
      menuHitRows = items.map((_, index) => ({ row: menuTop + index, index }));
    } else {
      rows = transcriptRows(session);
      const limit = Math.max(0, rows.length - transcriptHeight);
      if (tab.stickToBottom) tab.scrollOffset = limit;
      else tab.scrollOffset = Math.max(0, Math.min(tab.scrollOffset, limit));
      rows = rows.slice(tab.scrollOffset, tab.scrollOffset + transcriptHeight);
    }
    for (let i = 0; i < transcriptHeight; i++) lines.push(rows[i] ?? '');
    queueTop = transcriptHeight;
    lines.push(...queueLines);
    const isMain = session.focusedView === 'main';
    const placeholder =
      approvalQueue.length > 0
        ? 'decide the approval above (y/n)'
        : !isMain
          ? 'sub-agent view — agent-driven, Esc cancels its run'
          : session.busy
            ? 'type to queue; Enter queues, [steer now] steers'
            : session.engine.planMode
              ? 'describe what to plan…'
              : 'ask, or /help';
    const inputLine =
      isMain && session.input.length > 0
        ? `${CYAN}❯${RESET} ${session.input}▏`
        : `${CYAN}❯${RESET} ${DIM}${placeholder}${RESET}`;
    lines.push(clipVisible(inputLine, cw + 2));
    const states = session.engine.subagentStates();
    const activeCount = states.filter(
      (s) => s.status === 'working' || s.status === 'awaiting_approval',
    ).length;
    const agentSegment =
      states.length > 0
        ? ` · ${states.length} agents${activeCount > 0 ? ` (${activeCount} active)` : ''}`
        : '';
    const viewLabel = isMain ? '' : ` · ${session.viewNames.get(session.focusedView) ?? ''}`;
    const modeLabel = session.engine.planMode ? 'PLAN' : 'CODE';
    const autoLabel = session.engine.auto ? ' · auto' : '';
    const bg = session.engine.planMode ? MAGENTA_BG : BLUE_BG;
    const statusLine = `${sidebarVisible ? '«' : '≡'} ${clipVisible(sessionTitle(session.id), 24)}${viewLabel} · ${session.engine.modelId} · ${modeLabel}${autoLabel}${agentSegment} · ${session.status}`;
    lines.push(`${bg}${padVisible(clipVisible(statusLine, cw + 1), cw + 2)}${RESET}`);
    return lines;
  }

  function composedView() {
    const session = focused();
    const content = contentLines(session);
    if (!sidebarVisible) {
      return h(Box, { direction: 'column', gap: 0 }, ...content.map((line) => h(Text, null, line)));
    }
    sidebarRowsCache = sidebarRows();
    const rows = sidebarRowsCache;
    sidebarIndex = Math.max(0, Math.min(sidebarIndex, rows.length - 1));
    if (sidebarIndex < sidebarScroll) sidebarScroll = sidebarIndex;
    if (sidebarIndex >= sidebarScroll + height) sidebarScroll = sidebarIndex - height + 1;
    const lines: string[] = [];
    for (let i = 0; i < height; i++) {
      const rowIndex = sidebarScroll + i;
      const row = rows[rowIndex];
      const cell = row ? sidebarLine(row, rowIndex === sidebarIndex) : ' '.repeat(SIDEBAR_WIDTH);
      lines.push(`${cell}${DIM}│${RESET}${content[i] ?? ''}`);
    }
    return h(Box, { direction: 'column', gap: 0 }, ...lines.map((line) => h(Text, null, line)));
  }

  function paint(): void {
    lastPaint = Date.now();
    app.update(composedView());
  }

  function redraw(): void {
    const elapsed = Date.now() - lastPaint;
    if (elapsed >= REDRAW_INTERVAL_MS) {
      if (paintTimer !== undefined) {
        clearTimeout(paintTimer);
        paintTimer = undefined;
      }
      paint();
      return;
    }
    if (paintTimer === undefined) {
      paintTimer = setTimeout(() => {
        paintTimer = undefined;
        paint();
      }, REDRAW_INTERVAL_MS - elapsed);
    }
  }

  // --- commands --------------------------------------------------------

  async function handleCommand(session: SessionUI, line: string): Promise<void> {
    const [command, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command) {
      case 'help':
        notice(
          session,
          [
            '/model <id> — switch model · /models — list models · /title <t> — rename session',
            '/plan · /code — switch mode (Shift+Tab) · /auto — toggle auto-approval',
            '/agents — sub-agent status · /new — new session · /archive — archive session',
            'Ctrl+B or click ≡ — sidebar · Ctrl+N/P — next/prev session · Tab — cycle views',
            'Sidebar: click "+ new session", right-click a session to rename/archive/delete',
            'Esc — cancel turn (or child run in its view) · Enter queues during a turn; [steer now]/Ctrl+S steers',
          ].join('\n'),
        );
        break;
      case 'models': {
        session.status = 'Listing models…';
        redraw();
        try {
          const models = await session.engine.listModels();
          notice(
            session,
            models.length > 0
              ? models.map((m) => `${m.provider}: ${m.id}`).join('\n')
              : 'No models discovered.',
          );
        } catch (err) {
          notice(
            session,
            `model listing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        session.status = 'Ready';
        break;
      }
      case 'model':
        if (arg.length === 0) {
          notice(session, `current model: ${session.engine.modelId}`);
          break;
        }
        await session.engine.setModel(arg);
        notice(session, `model → ${session.engine.modelId}`);
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
        session.engine.setPlanMode(true);
        notice(session, 'planning mode: read-only tools (sub-agents inherit read-only)');
        break;
      case 'code':
        session.engine.setPlanMode(false);
        notice(session, 'code mode: full tool set');
        break;
      case 'auto':
        session.engine.setAuto(!session.engine.auto);
        notice(session, `auto-approval ${session.engine.auto ? 'on' : 'off'}`);
        break;
      case 'agents': {
        const states = session.engine.subagentStates();
        notice(
          session,
          states.length === 0
            ? 'No sub-agents in this session.'
            : states
                .map(
                  (s) =>
                    `${s.id} (${s.name}) [${s.status}]${s.doneReport ? ` — ${s.doneReport}` : ''}`,
                )
                .join('\n'),
        );
        break;
      }
      case 'sessions':
        sidebarVisible = !sidebarVisible;
        break;
      case 'archive': {
        const meta = workspace.meta(session.id);
        await workspace.archiveSession(session.id, !(meta?.archived ?? false));
        notice(session, meta?.archived ? 'session unarchived' : 'session archived');
        break;
      }
      case 'new': {
        const engine = await workspace.createSession();
        attachSession(engine);
        focusedSessionId = engine.threadId;
        break;
      }
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
    if (paintTimer !== undefined) clearTimeout(paintTimer);
    app.stop();
    finish?.();
  }

  function submit(session: SessionUI): void {
    const line = session.input.trim();
    if (line.length === 0) return;
    session.inputHistory.push(line);
    session.historyIndex = -1;
    session.input = '';
    if (line.startsWith('/')) {
      void handleCommand(session, line);
      return;
    }
    if (session.busy) {
      session.queue.push({ text: line });
      redraw();
      return;
    }
    view(session, 'main').entries.push({ kind: 'user', text: line, done: true });
    view(session, 'main').stickToBottom = true;
    void driveTurn(session, (hooks) => session.engine.runTurn(line, hooks));
  }

  function decideApproval(approved: boolean): void {
    const item = approvalQueue.shift();
    if (!item) return;
    item.decide(approved);
    redraw();
  }

  function cycleView(session: SessionUI, delta: number): void {
    const order = ['main', ...session.viewOrder.filter((id) => id !== 'main')];
    const index = order.indexOf(session.focusedView);
    const next = (index + delta + order.length) % order.length;
    session.focusedView = order[next]!;
    redraw();
  }

  async function handleEvent(event: TuiEvent): Promise<void> {
    const session = focused();
    if (event.type === 'mouse') {
      const inSidebar = sidebarVisible && event.x < SIDEBAR_WIDTH;
      const contentX = event.x - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0);
      if (event.action === 'press' && event.button === 'right' && inSidebar) {
        const row = sidebarRowsCache[sidebarScroll + event.y];
        if (row?.kind === 'session') {
          contextMenu = { sessionId: row.id, selected: 0, confirmDelete: false };
          redraw();
        }
        return;
      }
      if (event.action === 'press' && event.button === 'left') {
        if (contextMenu) {
          if (!inSidebar) {
            const hit = menuHitRows.find((r) => r.row === event.y);
            if (hit) {
              void runContextMenuItem(contextMenu, hit.index);
              return;
            }
          }
          contextMenu = undefined;
          redraw();
          return;
        }
        if (event.y === height - 1 && contentX >= 0 && contentX <= 1) {
          sidebarVisible = !sidebarVisible;
          redraw();
          return;
        }
        if (inSidebar) {
          if (event.y === 0 && event.x >= SIDEBAR_WIDTH - 2) {
            sidebarVisible = false;
            redraw();
            return;
          }
          const rowIndex = sidebarScroll + event.y;
          const row = sidebarRowsCache[rowIndex];
          if (row) {
            if (row.kind === 'session' && rowIndex === sidebarIndex && !row.archived) {
              if (expanded.has(row.id)) expanded.delete(row.id);
              else expanded.add(row.id);
            }
            sidebarIndex = rowIndex;
            focusSidebarRow(row);
          }
          redraw();
          return;
        }
        if (session && approvalQueue.length === 0) {
          const queueRow = event.y - queueTop;
          const hit = queueHitRows.find(
            (r) => r.row === queueRow && contentX >= r.buttonStart && contentX <= r.buttonEnd,
          );
          if (hit) {
            steerMessage(session, hit.index);
            return;
          }
        }
      }
      if (event.action === 'wheel') {
        if (inSidebar) {
          sidebarScroll = Math.max(0, sidebarScroll + (event.button === 'wheel-up' ? -3 : 3));
          redraw();
          return;
        }
        if (!session) return;
        const tab = view(session, session.focusedView);
        const rows = transcriptRows(session);
        const limit = Math.max(0, rows.length - Math.max(1, height - 2));
        if (event.button === 'wheel-up') {
          tab.scrollOffset = Math.max(0, tab.scrollOffset - 3);
          tab.stickToBottom = false;
        } else if (event.button === 'wheel-down') {
          tab.scrollOffset = Math.min(limit, tab.scrollOffset + 3);
          if (tab.scrollOffset >= limit) tab.stickToBottom = true;
        }
        redraw();
      }
      return;
    }
    if (event.ctrl && event.key === 'c') {
      if (session?.busy && session.abort) {
        session.abort.abort();
        return;
      }
      quit();
      return;
    }
    if (approvalQueue.length > 0) {
      if (!event.ctrl && !event.alt) {
        if (event.text === 'y' || event.text === 'Y') decideApproval(true);
        else if (event.text === 'n' || event.text === 'N') decideApproval(false);
      }
      return;
    }
    if (contextMenu) {
      const menu = contextMenu;
      const items = contextMenuItems(menu);
      if (event.key === 'escape') {
        contextMenu = undefined;
        redraw();
      } else if (event.key === 'up') {
        menu.selected = (menu.selected - 1 + items.length) % items.length;
        menu.confirmDelete = false;
        redraw();
      } else if (event.key === 'down') {
        menu.selected = (menu.selected + 1) % items.length;
        menu.confirmDelete = false;
        redraw();
      } else if (event.key === 'enter') {
        void runContextMenuItem(menu, menu.selected);
      }
      return;
    }
    if (event.ctrl && event.key === 'b') {
      sidebarVisible = !sidebarVisible;
      redraw();
      return;
    }
    // Ctrl+N / Ctrl+P instead of Ctrl+arrows: macOS reserves Ctrl+arrow
    // combinations for Mission Control.
    if (event.ctrl && (event.key === 'n' || event.key === 'p')) {
      if (!sidebarVisible) {
        sidebarVisible = true;
        sidebarRowsCache = sidebarRows();
      }
      const rows = sidebarRowsCache.length > 0 ? sidebarRowsCache : sidebarRows();
      sidebarRowsCache = rows;
      let next = sidebarIndex + (event.key === 'p' ? -1 : 1);
      while (next >= 0 && next < rows.length && rows[next]!.kind === 'divider') {
        next += event.key === 'p' ? -1 : 1;
      }
      if (next >= 0 && next < rows.length && rows[next]!.kind !== 'action-new') {
        sidebarIndex = next;
        focusSidebarRow(rows[next]!);
      } else if (next >= 0 && next < rows.length) {
        sidebarIndex = next;
      }
      redraw();
      return;
    }
    if (event.key === 'tab' && !event.shift) {
      if (session) cycleView(session, 1);
      return;
    }
    if (!session) {
      if (event.text === '/' || event.key === 'enter') {
        const engine = await workspace.createSession();
        attachSession(engine);
        focusedSessionId = engine.threadId;
        redraw();
      }
      return;
    }
    if (event.key === 'escape') {
      if (session.focusedView !== 'main') {
        session.engine.cancelSubagent(session.focusedView);
        notice(session, 'cancelling sub-agent run…', session.focusedView);
        return;
      }
      if (session.busy && session.abort) session.abort.abort();
      return;
    }
    if (event.key === 'tab' && event.shift) {
      session.engine.setPlanMode(!session.engine.planMode);
      redraw();
      return;
    }
    if (event.ctrl && event.key === 's') {
      steerMessage(session, 0);
      return;
    }
    if (event.key === 'pageup' || event.key === 'pagedown') {
      const tab = view(session, session.focusedView);
      const rows = transcriptRows(session);
      const pageSize = Math.max(1, height - 3);
      const limit = Math.max(0, rows.length - pageSize);
      if (event.key === 'pageup') {
        tab.scrollOffset = Math.max(0, tab.scrollOffset - pageSize);
        tab.stickToBottom = false;
      } else {
        tab.scrollOffset = Math.min(limit, tab.scrollOffset + pageSize);
        if (tab.scrollOffset >= limit) tab.stickToBottom = true;
      }
      redraw();
      return;
    }
    if (session.focusedView !== 'main') return;
    if (event.ctrl && event.key === 'u') {
      session.input = '';
      redraw();
      return;
    }
    if (event.key === 'backspace') {
      session.input = session.input.slice(0, -1);
      redraw();
      return;
    }
    if (event.key === 'enter') {
      submit(session);
      redraw();
      return;
    }
    if (event.key === 'up' && !session.busy) {
      if (session.inputHistory.length === 0) return;
      session.historyIndex =
        session.historyIndex === -1
          ? session.inputHistory.length - 1
          : Math.max(0, session.historyIndex - 1);
      session.input = session.inputHistory[session.historyIndex] ?? '';
      redraw();
      return;
    }
    if (event.key === 'down' && !session.busy) {
      if (session.historyIndex === -1) return;
      session.historyIndex += 1;
      if (session.historyIndex >= session.inputHistory.length) {
        session.historyIndex = -1;
        session.input = '';
      } else {
        session.input = session.inputHistory[session.historyIndex] ?? '';
      }
      redraw();
      return;
    }
    if (event.text && !event.ctrl && !event.alt) {
      session.input += event.text;
      redraw();
    }
  }

  workspace.onChange(() => redraw());

  const initialId = opts.sessionId ?? workspace.list()[0]?.id;
  if (initialId) {
    const engine = workspace.engineFor(initialId) ?? (await workspace.openSession(initialId));
    const session = attachSession(engine);
    focusedSessionId = session.id;
    session.views.get('main')!.entries.unshift({
      kind: 'notice',
      text: 'fino code — /help for commands, Ctrl+B or click ≡ for the session sidebar, Shift+Tab toggles plan mode.',
      done: true,
    });
    if (opts.recover) {
      void driveTurn(session, async (hooks) => {
        const recovered = await engine.recoverTurn(hooks);
        if (recovered) {
          notice(session, '[resumed interrupted turn]');
          return recovered;
        }
        return { status: 'done' } as TurnResult;
      });
    }
  }

  app = render(composedView(), {
    input: true,
    mouse: true,
    onEvent: handleEvent,
    onResize: (size) => {
      width = size.width;
      height = size.height;
      redraw();
    },
  });
  const initial = app.size();
  if (initial.width !== width || initial.height !== height) {
    width = initial.width;
    height = initial.height;
    paint();
  }

  try {
    await finished;
  } finally {
    app.stop();
    await workspace.close();
  }
}
