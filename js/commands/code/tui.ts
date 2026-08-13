/**
 * fino:commands/code/tui — multi-session terminal interface for `fino code`.
 *
 * A workspace TUI over `fino:tty/tui`. A collapsible sidebar (hidden by
 * default for a clean single-session experience; `Ctrl+B` or the `≡` button
 * toggles it) lists open sessions ordered by recent activity with
 * working/waiting/idle indicators and word-wrapped titles, expands each
 * session into its nested sub-agent rows — active children bright, settled
 * ones dim — and keeps archived sessions in a history list below.
 * Right-clicking a session opens a context menu (rename, archive, delete).
 * Several sessions can run turns concurrently; the focused one renders as a
 * transcript with markdown-rendered assistant messages and
 * tool calls rendered as call signatures that expand to a format-aware
 * view of their input and output, a message queue with clickable
 * `[steer now]` actions, a slash-command autocomplete overlay, an input
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
import type { ModelInfo, ModelMessage } from 'fino:ai/model';
import { MarkdownTerminalStream } from 'fino:format/markdown';
import { createSignal, h } from 'fino:ui';
import {
  Box,
  Text,
  copyToClipboard,
  getTerminalSize,
  highlightSelection,
  render,
  selectionIsEmpty,
  selectionText,
  type Selection,
  type SelectionRegion,
  type TuiApp,
  type TuiEvent,
} from 'fino:tty/tui';
import { writeStdout } from 'fino:tty';
import { env } from 'fino:process';
import { basename } from 'fino:file/path';
import type { CodeEngine, CodeMode, TurnResult } from 'fino:commands/code/engine';
import type { CodeWorkspace } from 'fino:commands/code/workspace';
import { contentText, previewText } from 'fino:commands/code/transcript';
import {
  formatToolArgLines,
  formatToolOutputLines,
  formatToolSignature,
} from 'fino:commands/code/toolview';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const INVERSE = '\x1b[7m';
const UNDERLINE = '\x1b[4m';
const WHITE = '\x1b[97m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const REDRAW_INTERVAL_MS = 33;
const QUEUE_PANE_MAX = 3;
const SIDEBAR_WIDTH = 28;
const SESSION_TITLE_LINES = 3;
const TOOL_DETAIL_LINES = 60;
const SLASH_MAX_ROWS = 6;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;
const AGENT_MENU_MAX_ROWS = 8;
/** Rows kept clear above and below a centred popover. */
const MENU_MARGIN_ROWS = 2;
/** The mode is the one colored word in the status bar. */
const MODE_COLORS: Record<CodeMode, string> = {
  plan: '\x1b[35m',
  build: '\x1b[36m',
  auto: '\x1b[31m',
};
const MODE_ORDER: CodeMode[] = ['plan', 'build', 'auto'];
const MODE_HELP: Record<CodeMode, string> = {
  plan: 'plan mode: read-only tools (sub-agents inherit read-only)',
  build: 'build mode: full tool set, gated tools ask first',
  auto: 'auto mode: full tool set, gated tools run without asking',
};

interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'turn';
  text: string;
  done: boolean;
  toolState?: 'running' | 'ok' | 'error';
  toolId?: string;
  argsValue?: unknown;
  argsKey?: string;
  outputText?: string;
  expanded?: boolean;
  /**
   * Harness-generated entry kept across history reseeds: `top` for the
   * intro banner, `bottom` for status notes appended after the transcript.
   */
  pin?: 'top' | 'bottom';
  cachedLines?: string[];
  cachedKey?: string;
  /**
   * Incremental renderer for streaming assistant markdown, so each delta
   * only re-renders the block still being written.
   */
  stream?: { width: number; renderer: MarkdownTerminalStream };
}

interface TabView {
  entries: TranscriptEntry[];
  scrollOffset: number;
  stickToBottom: boolean;
  /** Whether durable history has been replayed into this view. */
  seeded?: boolean;
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
  /** Coarse session state, shown as a glyph in the status bar. */
  state: 'idle' | 'working' | 'waiting' | 'error';
  /** Transient status-bar message: a copy confirmation, a retry, an error. */
  flash?: string;
  /** Wall-clock start of the running turn, for the activity indicator. */
  turnStartedAt?: number;
  /** What the agent is doing right now, shown beside the spinner. */
  activity: string;
  seenChildApprovals: Set<string>;
  /** Resolves once durable history has been replayed into the main view. */
  historyReady: Promise<void>;
}

interface ApprovalItem {
  sessionId: string;
  sourceLabel: string;
  request: ToolApprovalRequest;
  decide: (approved: boolean) => void;
}

type SidebarRow =
  | { kind: 'action-new' }
  | { kind: 'session'; id: string; archived: boolean };

interface SidebarDisplay {
  rows: SidebarRow[];
  lines: string[];
  lineMap: Array<{ rowIndex: number; first: boolean }>;
}

interface ContextMenuState {
  sessionId: string;
  selected: number;
  confirmDelete: boolean;
}

type ModelMenuEntry =
  | { kind: 'header'; label: string }
  | { kind: 'model'; provider: string; id: string };

interface ModelMenuState {
  loading: boolean;
  error?: string;
  entries: ModelMenuEntry[];
  selected: number;
  scroll: number;
  /** Snap the scroll window to the selection on the next paint (keyboard). */
  snap: boolean;
}

interface SlashCommand {
  name: string;
  args: string;
  description: string;
  submits: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', args: '', description: 'Show commands and keys', submits: true },
  {
    name: 'model',
    args: '[id]',
    description: 'Pick a model, or switch directly by id',
    submits: true,
  },
  { name: 'plan', args: '', description: 'Plan mode — read-only tools', submits: true },
  { name: 'build', args: '', description: 'Build mode — tools ask before writing', submits: true },
  { name: 'auto', args: '', description: 'Auto mode — tools run without asking', submits: true },
  { name: 'agents', args: '', description: 'Switch between this session and its sub-agents', submits: true },
  { name: 'sessions', args: '', description: 'Toggle the session sidebar', submits: true },
  { name: 'title', args: '<name>', description: 'Rename this session', submits: false },
  { name: 'archive', args: '', description: 'Archive/unarchive this session', submits: true },
  { name: 'new', args: '', description: 'Start a new session', submits: true },
  { name: 'debug', args: '', description: 'Terminal and input reporting diagnostics', submits: true },
  { name: 'exit', args: '', description: 'Quit fino code', submits: true },
];

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

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
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

function rowKey(row: SidebarRow): string {
  return row.kind === 'action-new' ? 'new' : `s:${row.id}`;
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
  // ioctl(TIOCGWINSZ) is authoritative and synchronous; the cursor-position
  // round-trip measureTerminalSize() performs is redundant here and stalls on
  // terminals that never answer it.
  const terminal = getTerminalSize();
  let width = terminal.width;
  let height = terminal.height;

  const sessions = new Map<string, SessionUI>();
  let focusedSessionId = '';
  let sidebarVisible = false;
  let selectedKey = '';
  let sidebarScroll = 0;
  let sidebarTab: 'active' | 'archived' = 'active';
  let sidebarTabHits: Array<{ start: number; end: number; key: string }> = [];
  /** Session created but not yet registered: the blank chat behind `+`. */
  let draftId: string | undefined;
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
  let sidebarDisplayCache: SidebarDisplay = { rows: [], lines: [], lineMap: [] };
  let contextMenu: ContextMenuState | undefined;
  // The single source of truth the render thunk observes: every state
  // mutation routes through redraw(), which bumps this and lets the fino:ui
  // effect re-run composedView(). Nothing calls app.update().
  const revision = createSignal(0);
  let hover: string | undefined;
  let selection: Selection | undefined;
  let selectionAnchor: { x: number; y: number } | undefined;
  let selectionRegion: SelectionRegion | undefined;
  const inputStats = { move: 0, press: 0, drag: 0, release: 0, wheel: 0, key: 0 };
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let lastFrameLines: string[] = [];
  let statusHits: Array<{ start: number; end: number; key: string }> = [];
  let menuHitRows: Array<{ row: number; index: number }> = [];
  let modelMenu: ModelMenuState | undefined;
  let modelMenuHitRows: Array<{ row: number; index: number }> = [];
  let transcriptHitRows: Array<{ row: number; entryIndex: number }> = [];
  let slashHitRows: Array<{ row: number; index: number }> = [];
  let slashTop = 0;
  let slashSelected = 0;
  let lastSlashFilter = '';
  /** Open agent selector: the view ids it offers and the highlighted one. */
  let agentMenu: { views: string[]; selected: number; scroll: number } | undefined;
  let agentMenuTop = 0;
  let agentMenuHitRows: Array<{ row: number; index: number }> = [];
  /** Provider catalog, fetched once in the background and reused. */
  let catalog: Promise<ModelMenuEntry[]> | undefined;

  /**
   * Resolve a pointer position to a hoverable target key, reusing the hit
   * regions the last paint recorded. Returns `undefined` over inert cells.
   */
  function hoverKeyAt(x: number, y: number): string | undefined {
    if (approvalQueue.length > 0 || contextMenu || modelMenu) return undefined;
    const inSidebar = sidebarVisible && x < SIDEBAR_WIDTH;
    const contentX = x - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0);
    if (inSidebar) {
      if (y === height - 1) {
        return sidebarTabHits.find((hit) => x >= hit.start && x <= hit.end)?.key;
      }
      const entry = sidebarDisplayCache.lineMap[sidebarScroll + y];
      const row = entry ? sidebarDisplayCache.rows[entry.rowIndex] : undefined;
      if (!row) return undefined;
      return `sidebar:${entry!.rowIndex}`;
    }
    if (y === height - 1) {
      const hit = statusHits.find((h) => contentX >= h.start && contentX <= h.end);
      return hit?.key;
    }
    const agentHit = agentMenuHitRows.find((r) => r.row === y);
    if (agentHit) return `agent:${agentHit.index}`;
    const slashHit = slashHitRows.find((r) => r.row === y);
    if (slashHit) return `slash:${slashHit.index}`;
    const queueRow = y - queueTop;
    const queueHit = queueHitRows.find(
      (r) => r.row === queueRow && contentX >= r.buttonStart && contentX <= r.buttonEnd,
    );
    if (queueHit) return `queue:${queueHit.index}`;
    const toolHit = transcriptHitRows.find((r) => r.row === y);
    if (toolHit) return `tool:${toolHit.entryIndex}`;
    return undefined;
  }

  /**
   * Run the spinner clock exactly while some session has a turn in flight.
   *
   * The indicator has to keep moving even when the model produces nothing for
   * seconds at a time — that stall is precisely when a still frame reads as a
   * hang — so it is driven by a timer rather than by agent events.
   */
  function syncSpinner(): void {
    const busy = [...sessions.values()].some((session) => session.busy);
    if (busy === (spinnerTimer !== undefined)) return;
    if (busy) {
      spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        redraw();
      }, SPINNER_INTERVAL_MS);
      return;
    }
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  }

  function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  }

  /**
   * The band between the transcript and the input, shown only while a turn
   * runs. Once it ends the result moves into the transcript as a `turn`
   * entry, so it scrolls with the conversation it belongs to and stays put
   * ahead of the next message. Blank rows on either side keep it off both
   * neighbours.
   */
  function activityLines(session: SessionUI, cw: number): string[] {
    if (session.busy) {
      const spinner = SPINNER_FRAMES[spinnerFrame]!;
      const states = session.engine.subagentStates();
      const active = states.filter(
        (state) => state.status === 'working' || state.status === 'awaiting_approval',
      ).length;
      const parts = [session.engine.planMode ? 'Planning' : 'Working'];
      if (session.activity) parts.push(session.activity);
      parts.push(formatDuration(Date.now() - (session.turnStartedAt ?? Date.now())));
      if (active > 0) parts.push(`${active} sub-agent${active === 1 ? '' : 's'}`);
      if (session.queue.length > 0) parts.push(`${session.queue.length} queued`);
      parts.push('Ctrl+C interrupts');
      return [
        '',
        clipVisible(`${YELLOW}${spinner}${RESET} ${DIM}${parts.join(' · ')}${RESET}`, cw + 2),
        '',
      ];
    }
    return [''];
  }

  function activityRows(session: SessionUI): number {
    return session.busy ? 3 : 1;
  }

  /** Track the hovered target, repainting only when it actually changes. */
  function updateHover(x: number, y: number): void {
    const next = hoverKeyAt(x, y);
    if (next === hover) return;
    hover = next;
    redraw();
  }

  /**
   * Copy the current selection to the system clipboard.
   *
   * Terminals intercept the platform copy chord (Cmd+C on macOS) before the
   * application sees it, and it copies the terminal's own selection — which
   * an application-drawn highlight is not. So the clipboard is written as
   * soon as a selection is made, and the selection is kept on screen so it
   * stays visible and can be re-copied.
   */
  function copySelection(): boolean {
    if (!selection || selectionIsEmpty(selection)) return false;
    const text = selectionText(lastFrameLines, selection);
    if (text.length === 0) return false;
    void writeStdout(copyToClipboard(text));
    const session = focused();
    if (session) session.flash = `copied ${text.length} chars`;
    redraw();
    return true;
  }

  function contentWidth(): number {
    return Math.max(20, width - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0) - 2);
  }

  function focused(): SessionUI | undefined {
    return sessions.get(focusedSessionId);
  }

  /**
   * Views the agent selector offers: the session itself, then its sub-agents
   * in spawn order.
   */
  function agentViews(session: SessionUI): string[] {
    return ['main', ...session.viewOrder.filter((id) => id !== 'main')];
  }

  function openAgentMenu(session: SessionUI): void {
    const views = agentViews(session);
    const selected = Math.max(0, views.indexOf(session.focusedView));
    agentMenu = {
      views,
      selected,
      scroll: Math.max(0, Math.min(selected, views.length - AGENT_MENU_MAX_ROWS)),
    };
    redraw();
  }

  /**
   * The agent selector, rendered under the input so it reads as an extension
   * of the status bar segment that opens it.
   */
  function agentMenuLines(session: SessionUI, cw: number): string[] {
    agentMenuHitRows = [];
    const menu = agentMenu;
    if (!menu) return [];
    const states = new Map(session.engine.subagentStates().map((state) => [state.id, state]));
    const window = menu.views.slice(menu.scroll, menu.scroll + AGENT_MENU_MAX_ROWS);
    const lines = window.map((id, offset) => {
      const index = menu.scroll + offset;
      agentMenuHitRows.push({ row: agentMenuTop + offset, index });
      const state = states.get(id);
      const label =
        id === 'main'
          ? ` ❯ ${sessionTitle(session.id)}`
          : ` ${state ? CHILD_GLYPHS[state.status] : '·'} ${session.viewNames.get(id) ?? id}${
              state ? ` ${DIM}${state.status}${RESET}` : ''
            }`;
      const marked = id === session.focusedView ? `${label}  ${DIM}(viewing)${RESET}` : label;
      return index === menu.selected
        ? `${INVERSE}${padVisible(clipVisible(stripAnsi(marked), cw + 1), cw + 2)}${RESET}`
        : clipVisible(marked, cw + 2);
    });
    if (menu.views.length > AGENT_MENU_MAX_ROWS) {
      lines.push(`${DIM} … ${menu.views.length} agents — ↑/↓ to browse${RESET}`);
    }
    return lines;
  }

  function setMode(session: SessionUI, mode: CodeMode): void {
    session.engine.setMode(mode);
    notice(session, MODE_HELP[mode]);
  }

  /** Step through the permission levels: plan → build → auto → plan. */
  function cycleMode(session: SessionUI): void {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(session.engine.mode) + 1) % MODE_ORDER.length]!;
    setMode(session, next);
  }

  function chooseAgentView(session: SessionUI, index: number): void {
    const menu = agentMenu;
    const id = menu?.views[index];
    agentMenu = undefined;
    if (!id) {
      redraw();
      return;
    }
    void focusSession(session.id, id);
  }

  function moveAgentSelection(delta: number): void {
    const menu = agentMenu;
    if (!menu) return;
    menu.selected = Math.max(0, Math.min(menu.views.length - 1, menu.selected + delta));
    if (menu.selected < menu.scroll) menu.scroll = menu.selected;
    if (menu.selected >= menu.scroll + AGENT_MENU_MAX_ROWS) {
      menu.scroll = menu.selected - AGENT_MENU_MAX_ROWS + 1;
    }
    redraw();
  }

  function paneRows(session: SessionUI): { queue: number; slash: number; agents: number } {
    const queue =
      session.queue.length > 0
        ? Math.min(session.queue.length, QUEUE_PANE_MAX) +
          (session.queue.length > QUEUE_PANE_MAX ? 1 : 0)
        : 0;
    const matches = slashFilter(session);
    const slash =
      matches.length > 0
        ? Math.min(matches.length, SLASH_MAX_ROWS) + (matches.length > SLASH_MAX_ROWS ? 1 : 0)
        : 0;
    const views = agentMenu ? agentMenu.views.length : 0;
    const agents =
      views > 0 ? Math.min(views, AGENT_MENU_MAX_ROWS) + (views > AGENT_MENU_MAX_ROWS ? 1 : 0) : 0;
    return { queue, slash, agents };
  }

  /**
   * Rows the transcript viewport occupies: everything the panes, activity
   * band, input line, and status bar leave over.
   */
  function transcriptHeightFor(session: SessionUI): number {
    const panes = paneRows(session);
    const input = session.focusedView === 'main' ? 1 : 0;
    return Math.max(
      1,
      height - panes.queue - panes.slash - panes.agents - activityRows(session) - input - 1,
    );
  }

  /**
   * The pane a selection started in, or `undefined` where dragging selects
   * nothing.
   *
   * Selections are bounded by their pane the way a scroll container bounds
   * one in a browser: a drag begun in the transcript never picks up sidebar
   * rows beside it, and vice versa.
   */
  function selectionRegionAt(x: number, y: number): SelectionRegion | undefined {
    if (sidebarVisible && x < SIDEBAR_WIDTH) {
      return { x: 0, y: 0, width: SIDEBAR_WIDTH, height };
    }
    const session = focused();
    if (!session) return undefined;
    const left = sidebarVisible ? SIDEBAR_WIDTH + 1 : 0;
    const rows = transcriptHeightFor(session);
    if (y >= rows) return undefined;
    return { x: left, y: 0, width: Math.max(1, width - left), height: rows };
  }

  function scrollBy(session: SessionUI, delta: number): void {
    const tab = view(session, session.focusedView);
    const rows = tabRows(session).rows;
    const limit = Math.max(0, rows.length - transcriptHeightFor(session));
    if (delta < 0) {
      tab.scrollOffset = Math.max(0, tab.scrollOffset + delta);
      tab.stickToBottom = false;
    } else {
      tab.scrollOffset = Math.min(limit, tab.scrollOffset + delta);
      if (tab.scrollOffset >= limit) tab.stickToBottom = true;
    }
    redraw();
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

  // --- slash command overlay -------------------------------------------

  function slashFilter(session: SessionUI | undefined): SlashCommand[] {
    if (!session || session.focusedView !== 'main') return [];
    if (approvalQueue.length > 0 || contextMenu || modelMenu) return [];
    const input = session.input;
    if (!input.startsWith('/') || input.includes(' ')) return [];
    const prefix = input.slice(1).toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
    if (matches.length === 1 && matches[0]!.name === prefix) return [];
    return matches;
  }

  function applySlashCommand(session: SessionUI, command: SlashCommand): void {
    if (command.submits) {
      session.input = `/${command.name}`;
      submit(session);
    } else {
      session.input = `/${command.name} `;
    }
    redraw();
  }

  // --- model picker ----------------------------------------------------

  /**
   * Group a provider listing into the picker's header/model rows.
   */
  function modelEntries(models: ModelInfo[]): ModelMenuEntry[] {
    const byProvider = new Map<string, string[]>();
    for (const info of models) {
      const list = byProvider.get(info.provider) ?? [];
      list.push(info.id);
      byProvider.set(info.provider, list);
    }
    const entries: ModelMenuEntry[] = [];
    // Plain codepoint order: this V8 build has no ICU collation, so
    // localeCompare() throws rather than sorting.
    for (const [provider, ids] of [...byProvider.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      entries.push({ kind: 'header', label: provider });
      for (const id of ids.sort()) entries.push({ kind: 'model', provider, id });
    }
    return entries;
  }

  /**
   * Fetch the provider catalog once and keep it for the life of the app.
   *
   * Listing hits every configured provider's API, which is far too slow to do
   * while the user waits on an open picker, so it starts in the background at
   * launch. `force` re-fetches for the picker's refresh action.
   */
  function modelCatalog(session: SessionUI, force = false): Promise<ModelMenuEntry[]> {
    if (force) catalog = undefined;
    catalog ??= session.engine
      .listModels()
      .then(modelEntries)
      .catch((err: unknown) => {
        catalog = undefined;
        throw err;
      });
    return catalog;
  }

  function applyCatalog(session: SessionUI, entries: ModelMenuEntry[]): void {
    if (!modelMenu) return;
    const current = entries.findIndex(
      (entry) => entry.kind === 'model' && entry.id === session.engine.modelId,
    );
    const firstModel = entries.findIndex((entry) => entry.kind === 'model');
    modelMenu = {
      loading: false,
      entries,
      selected: current >= 0 ? current : Math.max(0, firstModel),
      scroll: 0,
      snap: true,
    };
    redraw();
  }

  function failCatalog(err: unknown): void {
    if (!modelMenu) return;
    modelMenu = {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      entries: [],
      selected: 0,
      scroll: 0,
      snap: true,
    };
    redraw();
  }

  function openModelMenu(session: SessionUI): void {
    modelMenu = { loading: true, entries: [], selected: 0, scroll: 0, snap: true };
    redraw();
    modelCatalog(session)
      .then((entries) => applyCatalog(session, entries))
      .catch(failCatalog);
  }

  function refreshModelCatalog(menu: ModelMenuState): void {
    const session = focused();
    if (!session) return;
    menu.loading = true;
    menu.error = undefined;
    redraw();
    modelCatalog(session, true)
      .then((entries) => applyCatalog(session, entries))
      .catch(failCatalog);
  }

  function moveModelSelection(menu: ModelMenuState, delta: number): void {
    let next = menu.selected + delta;
    while (next >= 0 && next < menu.entries.length && menu.entries[next]!.kind === 'header') {
      next += delta;
    }
    if (next >= 0 && next < menu.entries.length) {
      menu.selected = next;
      menu.snap = true;
    }
    redraw();
  }

  function chooseModel(session: SessionUI, menu: ModelMenuState, index: number): void {
    const entry = menu.entries[index];
    if (!entry || entry.kind !== 'model') return;
    modelMenu = undefined;
    void session.engine.setModel(entry.id, { provider: entry.provider }).then(() => {
      notice(session, `model → ${session.engine.modelId}`);
      redraw();
    });
    redraw();
  }

  // --- context menu ----------------------------------------------------

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
      if (session) {
        session.input = `/title ${meta.title === 'untitled' ? '' : meta.title}`.trimEnd() + ' ';
      }
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
        const next = workspace.list()[0]?.id;
        if (next) await focusSession(next);
        else await focusDraft();
      }
    }
    redraw();
  }

  // --- transcript ------------------------------------------------------

  /** Render assistant markdown, highlighting it continuously as it streams. */
  function assistantLines(entry: TranscriptEntry, cw: number): string[] {
    if (entry.stream?.width !== cw) {
      entry.stream = { width: cw, renderer: new MarkdownTerminalStream({ width: cw }) };
    }
    return entry.stream.renderer.render(entry.text);
  }

  function entryLines(entry: TranscriptEntry, cw: number, hovered = false): string[] {
    const key = [
      hovered,
      entry.kind,
      entry.done,
      entry.toolState ?? '',
      entry.expanded ?? false,
      entry.text.length,
      entry.argsKey ?? '',
      entry.outputText?.length ?? 0,
      cw,
    ].join(':');
    if (entry.cachedKey === key && entry.cachedLines) return entry.cachedLines;
    let lines: string[];
    if (entry.kind === 'user') {
      lines = wrapPlain(entry.text, cw - 2).map(
        (line, index) => (index === 0 ? `${CYAN}❯${RESET} ` : '  ') + line,
      );
    } else if (entry.kind === 'turn') {
      lines = [`${DIM}${clipVisible(entry.text, cw)}${RESET}`];
    } else if (entry.kind === 'assistant') {
      lines = assistantLines(entry, cw);
    } else if (entry.kind === 'tool') {
      const mark =
        entry.toolState === 'running'
          ? `${YELLOW}●${RESET}`
          : entry.toolState === 'ok'
            ? `${GREEN}●${RESET}`
            : `${RED}●${RESET}`;
      const disclosure = entry.expanded ? '▾' : '▸';
      const signature = formatToolSignature(entry.text, entry.argsValue, {
        maxValue: Math.max(12, Math.floor(cw / 3)),
      });
      const shown = clipVisible(signature, cw - 4);
      const head = hovered ? `${UNDERLINE}${shown}${RESET}` : shown;
      lines = [`${mark} ${head} ${DIM}${disclosure}${RESET}`];
      if (entry.expanded) {
        const section = (label: string, body: string[]): string[] => {
          if (body.length === 0) return [];
          const shown = body.slice(0, TOOL_DETAIL_LINES);
          if (body.length > shown.length) {
            shown.push(`${DIM}… (+${body.length - shown.length} more lines)${RESET}`);
          }
          return [
            `  ${DIM}${label}${RESET}`,
            ...shown.map((line) => `    ${clipVisible(line, cw - 4)}`),
          ];
        };
        const argLines =
          entry.argsValue === undefined
            ? []
            : formatToolArgLines(entry.text, entry.argsValue, { width: cw - 6 });
        const outputLines = entry.outputText
          ? formatToolOutputLines({
              name: entry.text,
              args: entry.argsValue,
              output: entry.outputText,
              width: cw - 6,
            })
          : [];
        lines.push(...section('input', argLines), ...section('output', outputLines));
        if (argLines.length === 0 && outputLines.length === 0) {
          lines.push(`    ${DIM}(no captured input/output)${RESET}`);
        }
      }
    } else {
      lines = wrapPlain(entry.text, cw).map((line) => `${DIM}${line}${RESET}`);
    }
    entry.cachedKey = key;
    entry.cachedLines = lines;
    return lines;
  }

  function tabRows(session: SessionUI): { rows: string[]; toolRows: Map<number, number> } {
    const cw = contentWidth();
    const tab = view(session, session.focusedView);
    const rows: string[] = [];
    const toolRows = new Map<number, number>();
    for (let index = 0; index < tab.entries.length; index++) {
      const entry = tab.entries[index]!;
      if (rows.length > 0) rows.push('');
      // A rule ahead of each prose answer marks where the agent starts
      // talking again after a run of tool calls.
      if (entry.kind === 'assistant') {
        rows.push(`${DIM}${'─'.repeat(Math.max(1, cw))}${RESET}`, '');
      }
      if (entry.kind === 'tool') toolRows.set(rows.length, index);
      rows.push(...entryLines(entry, cw, hover === `tool:${index}`));
    }
    return { rows, toolRows };
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
        ...(ev.args !== undefined
          ? { argsValue: ev.args, argsKey: previewText(JSON.stringify(ev.args), 200) }
          : {}),
      });
    } else if (ev.type === 'tool_result' || ev.type === 'tool_error') {
      for (let index = tab.entries.length - 1; index >= 0; index--) {
        const entry = tab.entries[index]!;
        if (entry.kind === 'tool' && entry.toolId === ev.id) {
          entry.toolState =
            ev.type === 'tool_error' || (ev.type === 'tool_result' && ev.isError) ? 'error' : 'ok';
          if (ev.type === 'tool_result' && ev.content !== undefined) {
            entry.outputText = previewText(contentText(ev.content));
          } else if (ev.type === 'tool_error') {
            entry.outputText = previewText(ev.message);
          }
          entry.cachedKey = undefined;
          break;
        }
      }
    }
    redraw();
  }

  function seedFromHistory(tab: TabView, messages: ModelMessage[]): void {
    // Durable history replaces the conversation, but harness-generated
    // notices (the intro banner, sub-agent status notes) are not in it and
    // must survive the reseed.
    const pinnedTop = tab.entries.filter((entry) => entry.pin === 'top');
    const pinnedBottom = tab.entries.filter((entry) => entry.pin === 'bottom');
    tab.entries = [];
    const toolEntries = new Map<string, TranscriptEntry>();
    for (const message of messages) {
      if (message.role === 'user' && typeof message.content === 'string') {
        const synthetic = message.content.startsWith('[subagent settlement]');
        tab.entries.push({
          kind: synthetic ? 'notice' : 'user',
          text: message.content,
          done: true,
        });
      } else if (message.role === 'user' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'tool_result') {
            const entry = toolEntries.get(part.toolCallId);
            if (entry) {
              entry.outputText = previewText(contentText(part.content));
              if (part.isError) entry.toolState = 'error';
            }
          }
        }
      } else if (message.role === 'assistant') {
        if (typeof message.content === 'string') {
          tab.entries.push({ kind: 'assistant', text: message.content, done: true });
        } else {
          for (const part of message.content) {
            if (part.type === 'text' && part.text.trim().length > 0) {
              tab.entries.push({ kind: 'assistant', text: part.text, done: true });
            } else if (part.type === 'tool_use') {
              const entry: TranscriptEntry = {
                kind: 'tool',
                text: part.name,
                done: true,
                toolState: 'ok',
                toolId: part.id,
                argsValue: part.args ?? {},
                argsKey: previewText(JSON.stringify(part.args ?? {}), 200),
              };
              toolEntries.set(part.id, entry);
              tab.entries.push(entry);
            }
          }
        }
      }
    }
    tab.entries = [...pinnedTop, ...tab.entries, ...pinnedBottom];
    tab.seeded = true;
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
      state: 'idle',
      activity: '',
      seenChildApprovals: new Set(),
      historyReady: Promise.resolve(),
    };
    sessions.set(id, session);
    view(session, 'main');
    session.historyReady = engine
      .history()
      .then((messages) => {
        const tab = view(session, 'main');
        const live = tab.entries.some((entry) => entry.pin === undefined);
        if (messages.length > 0 && !tab.seeded && !live) seedFromHistory(tab, messages);
      })
      .catch(() => {});
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
            tab.entries.push({ kind: 'notice', text: marker, done: true, pin: 'bottom' });
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
          pin: 'bottom',
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

  /** The project directory the workspace is rooted in. */
  function projectName(): string {
    return basename(workspace.cwd).toString() || workspace.cwd;
  }

  /** A session with no registry entry has not run a turn yet. */
  function isDraft(id: string): boolean {
    return workspace.meta(id) === undefined;
  }

  function sessionTitle(id: string): string {
    return workspace.meta(id)?.title ?? 'new session';
  }

  async function focusSession(id: string, viewId = 'main'): Promise<void> {
    focusedSessionId = id;
    selectedKey = viewId === 'main' ? (isDraft(id) ? 'new' : `s:${id}`) : selectedKey;
    if (!sessions.has(id)) {
      const engine = await workspace.openSession(id);
      attachSession(engine);
    }
    const session = sessions.get(id);
    if (session) {
      view(session, viewId);
      session.focusedView = viewId;
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
    session.state = 'working';
    session.flash = undefined;
    session.turnStartedAt = Date.now();
    session.activity = 'thinking';
    session.abort = new AbortController();
    syncSpinner();
    const main = view(session, 'main');
    const onEvent = (ev: AgentEvent): void => {
      if (ev.type === 'retry') session.flash = `retry ${ev.attempt}`;
      else if (ev.type === 'fallback') session.flash = `fallback → ${ev.model}`;
      if (ev.type === 'tool_start') session.activity = ev.name;
      else if (ev.type === 'tool_result') session.activity = 'thinking';
      else if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
        session.activity = 'responding';
      }
      applyAgentEvent(main, ev);
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
      finalizeAssistant(main);
      if (result.status === 'done') session.state = 'idle';
      else if (result.status !== 'suspended') {
        session.state = 'error';
        session.flash = `turn ${result.status}`;
      }
    } catch (err) {
      finalizeAssistant(main);
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
      main.entries.push({
        kind: 'turn',
        text: `✔ ${formatDuration(Date.now() - (session.turnStartedAt ?? Date.now()))}`,
        done: true,
      });
      session.turnStartedAt = undefined;
      session.activity = '';
      syncSpinner();
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
    const rows: SidebarRow[] = [];
    if (sidebarTab === 'active') rows.push({ kind: 'action-new' });
    for (const meta of workspace.list({ archived: sidebarTab === 'archived' })) {
      rows.push({ kind: 'session', id: meta.id, archived: sidebarTab === 'archived' });
    }
    return rows;
  }

  function sessionGlyph(id: string): string {
    const activity = sessions.get(id)?.engine.activity ?? workspace.activity(id);
    return activity === 'working' ? '⟳' : activity === 'waiting' ? '▲' : '·';
  }

  // Colors reset the surrounding inverse styling, so a selected row uses the
  // bare glyph from sessionGlyph() instead.
  function sessionIndicator(id: string): string {
    const activity = sessions.get(id)?.engine.activity ?? workspace.activity(id);
    if (activity === 'working') return `${YELLOW}⟳${RESET}`;
    if (activity === 'waiting') return `${RED}▲${RESET}`;
    return `${DIM}·${RESET}`;
  }

  function buildSidebarDisplay(): SidebarDisplay {
    const w = SIDEBAR_WIDTH;
    const rows = sidebarRows();
    const lines: string[] = [];
    const lineMap: Array<{ rowIndex: number; first: boolean }> = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const selected = rowKey(row) === selectedKey;
      const hovered = hover === `sidebar:${rowIndex}`;
      const push = (line: string, first = false): void => {
        lines.push(line);
        lineMap.push({ rowIndex, first });
      };
      // Every entry is a bordered card, so the list reads as separated items
      // and hover has a target the size of the whole entry. Hover recolors
      // the border rather than restyling the card, which would fight with the
      // selection highlight.
      const border = selected || hovered ? WHITE : DIM;
      const dim = row.archived && !selected;
      const inner = (line: string): string => {
        const body = padVisible(line, w - 4);
        return `${border}│${RESET}${selected ? INVERSE : dim ? DIM : ''} ${body} ${RESET}${border}│${RESET}`;
      };
      const titleLines =
        row.kind === 'action-new'
          ? ['new session']
          : wrapPlain(sessionTitle(row.id), w - 6).slice(0, SESSION_TITLE_LINES);
      const indicator =
        row.kind === 'action-new'
          ? selected
            ? '+'
            : `${GREEN}+${RESET}`
          : selected
            ? sessionGlyph(row.id)
            : sessionIndicator(row.id);
      push(`${border}┌${'─'.repeat(w - 2)}┐${RESET}`, true);
      for (let i = 0; i < titleLines.length; i++) {
        push(inner(`${i === 0 ? `${indicator} ` : '  '}${titleLines[i]}`));
      }
      push(`${border}└${'─'.repeat(w - 2)}┘${RESET}`);
    }
    return { rows, lines, lineMap };
  }

  /**
   * The sidebar's bottom row: which list is showing, level with the status
   * bar so the two read as one footer.
   */
  function sidebarTabLine(): string {
    const counts = {
      active: workspace.list().length,
      archived: workspace.list({ archived: true }).length,
    };
    sidebarTabHits = [];
    let line = '';
    let column = 0;
    const tab = (name: 'active' | 'archived'): void => {
      const text = ` ${name} ${counts[name]} `;
      sidebarTabHits.push({ start: column, end: column + text.length - 1, key: `tab:${name}` });
      const style =
        sidebarTab === name ? INVERSE : hover === `tab:${name}` ? `${WHITE}${UNDERLINE}` : DIM;
      line += `${style}${text}${RESET}`;
      column += text.length;
    };
    tab('active');
    line += `${DIM}│${RESET}`;
    column += 1;
    tab('archived');
    return padVisible(line, SIDEBAR_WIDTH);
  }

  function selectedRowIndex(display: SidebarDisplay): number {
    return display.rows.findIndex((row) => rowKey(row) === selectedKey);
  }

  function ensureSelectedVisible(display: SidebarDisplay): void {
    const rowIndex = selectedRowIndex(display);
    if (rowIndex < 0) return;
    const firstLine = display.lineMap.findIndex(
      (entry) => entry.rowIndex === rowIndex && entry.first,
    );
    if (firstLine < 0) return;
    const listRows = Math.max(1, height - 1);
    if (firstLine < sidebarScroll) sidebarScroll = firstLine;
    if (firstLine >= sidebarScroll + listRows) sidebarScroll = firstLine - listRows + 1;
  }

  function focusSidebarRow(row: SidebarRow): void {
    selectedKey = rowKey(row);
    if (row.kind === 'action-new') {
      void focusDraft();
      return;
    }
    void focusSession(row.id, 'main');
  }

  /**
   * Show the blank chat behind `+ new session`.
   *
   * The session exists but stays out of the registry until its first message,
   * so opening the app — or clicking `+` and changing your mind — leaves no
   * empty session behind. One draft is enough: clicking `+` again returns to
   * the same blank chat.
   */
  async function focusDraft(): Promise<void> {
    if (draftId === undefined || !isDraft(draftId)) {
      const engine = await workspace.createSession();
      draftId = engine.threadId;
      attachSession(engine);
    }
    await focusSession(draftId, 'main');
    selectedKey = 'new';
    redraw();
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
    transcriptHitRows = [];
    slashHitRows = [];
    if (!session) {
      lines.push(
        '',
        `${DIM}no session — Ctrl+B or click ≡ for the sidebar, /new to start one${RESET}`,
      );
      while (lines.length < height - 2) lines.push('');
      lines.push(`${BOLD}${padVisible(`${sidebarVisible ? '«' : '≡'} fino code`, cw + 2)}${RESET}`);
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
        const button =
          hover === `queue:${index}` ? `${INVERSE}${label}${RESET}` : `${YELLOW}${label}${RESET}`;
        queueLines.push(`${DIM}· ${preview}${RESET}${button}`);
      }
      if (session.queue.length > shown.length) {
        queueLines.push(`${DIM}… ${session.queue.length - shown.length} more queued${RESET}`);
      }
    }
    const slashMatches = slashFilter(session);
    const filterKey = session.input;
    if (filterKey !== lastSlashFilter) {
      lastSlashFilter = filterKey;
      slashSelected = 0;
    }
    slashSelected = Math.max(0, Math.min(slashSelected, Math.max(0, slashMatches.length - 1)));
    const slashLines: string[] = [];
    if (slashMatches.length > 0) {
      const start = Math.max(
        0,
        Math.min(slashSelected - SLASH_MAX_ROWS + 1, slashMatches.length - SLASH_MAX_ROWS),
      );
      const visible = slashMatches.slice(start, start + SLASH_MAX_ROWS);
      for (let i = 0; i < visible.length; i++) {
        const command = visible[i]!;
        const index = start + i;
        const label = ` /${command.name}${command.args ? ` ${command.args}` : ''}`;
        const line = `${label}  ${DIM}${command.description}${RESET}`;
        slashLines.push(
          index === slashSelected
            ? `${INVERSE}${padVisible(clipVisible(stripAnsi(line), cw + 1), cw + 2)}${RESET}`
            : clipVisible(line, cw + 2),
        );
      }
      if (slashMatches.length > SLASH_MAX_ROWS) {
        slashLines.push(`${DIM} … ${slashMatches.length} commands — ↑/↓ to browse${RESET}`);
      }
    }
    const transcriptHeight = transcriptHeightFor(session);
    let rows: string[];
    const tab = view(session, session.focusedView);
    if (approvalQueue.length > 0) {
      const popover = popoverLines(cw);
      const padTop = Math.max(0, Math.floor((transcriptHeight - popover.length) / 2));
      rows = [...Array<string>(padTop).fill(''), ...popover];
    } else if (modelMenu) {
      const menu = modelMenu;
      const innerWidth = Math.max(30, Math.min(cw - 4, 56));
      // The box is the list plus its border, title, blank rows, and footer;
      // subtract that and a margin so it never runs past the transcript.
      const chrome = 8;
      const maxRows = Math.max(
        1,
        Math.min(menu.entries.length, transcriptHeight - chrome - 2 * MENU_MARGIN_ROWS),
      );
      if (menu.snap) {
        if (menu.selected < menu.scroll) menu.scroll = menu.selected;
        if (menu.selected >= menu.scroll + maxRows) menu.scroll = menu.selected - maxRows + 1;
        menu.snap = false;
      }
      menu.scroll = Math.max(0, Math.min(menu.scroll, Math.max(0, menu.entries.length - maxRows)));
      const top = `${YELLOW}┌${'─'.repeat(innerWidth - 2)}┐${RESET}`;
      const bottom = `${YELLOW}└${'─'.repeat(innerWidth - 2)}┘${RESET}`;
      const pad = (line: string): string =>
        `${YELLOW}│${RESET} ${padVisible(clipVisible(line, innerWidth - 4), innerWidth - 4)} ${YELLOW}│${RESET}`;
      const body: string[] = [`${BOLD}select model${RESET}`, ''];
      const listTop = body.length + 1;
      modelMenuHitRows = [];
      if (menu.loading) {
        body.push(`${DIM}loading models…${RESET}`);
      } else if (menu.error) {
        body.push(...wrapPlain(`model listing failed: ${menu.error}`, innerWidth - 4));
      } else if (menu.entries.length === 0) {
        body.push(`${DIM}no models discovered${RESET}`);
      } else {
        const visible = menu.entries.slice(menu.scroll, menu.scroll + maxRows);
        for (let i = 0; i < visible.length; i++) {
          const entry = visible[i]!;
          const index = menu.scroll + i;
          if (entry.kind === 'header') {
            body.push(`${DIM}${BOLD}${entry.label}${RESET}`);
          } else {
            const marker = entry.id === session.engine.modelId ? '●' : ' ';
            const line = ` ${marker} ${entry.id}`;
            body.push(index === menu.selected ? `${INVERSE}${line}${RESET}` : line);
            modelMenuHitRows.push({ row: 0, index });
          }
        }
        if (menu.entries.length > maxRows) {
          body.push(`${DIM}↑/↓ scroll · ${menu.entries.length} entries${RESET}`);
        }
      }
      body.push('', `${DIM}Enter select · Ctrl+R refresh · Esc close${RESET}`);
      const box = [top, ...body.map(pad), bottom];
      // maxRows already reserves the margin, so centring what is left keeps
      // the box clear of both edges without pushing it off the bottom.
      const padTop = Math.max(0, Math.floor((transcriptHeight - box.length) / 2));
      const indent = ' '.repeat(Math.max(0, Math.floor((cw - innerWidth) / 2)));
      rows = [...Array<string>(padTop).fill(''), ...box.map((line) => indent + line)];
      if (!menu.loading && !menu.error) {
        const visible = menu.entries.slice(menu.scroll, menu.scroll + maxRows);
        modelMenuHitRows = [];
        for (let i = 0; i < visible.length; i++) {
          if (visible[i]!.kind === 'model') {
            modelMenuHitRows.push({ row: padTop + listTop + i, index: menu.scroll + i });
          }
        }
      }
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
          index === menu.selected
            ? `${INVERSE}${padVisible(` ${item} `, innerWidth - 4)}${RESET}`
            : ` ${item} `,
        ),
        '',
        `${DIM}↑/↓ select · Enter run · Esc close${RESET}`,
      ];
      const box = [top, ...body.map(pad), bottom];
      const padTop = Math.max(0, Math.floor((transcriptHeight - box.length) / 2));
      const indent = ' '.repeat(Math.max(0, Math.floor((cw - innerWidth) / 2)));
      rows = [...Array<string>(padTop).fill(''), ...box.map((line) => indent + line)];
      const menuTop = padTop + 3;
      menuHitRows = items.map((_, index) => ({ row: menuTop + index, index }));
    } else {
      const built = tabRows(session);
      rows = built.rows;
      const limit = Math.max(0, rows.length - transcriptHeight);
      if (tab.stickToBottom) tab.scrollOffset = limit;
      else tab.scrollOffset = Math.max(0, Math.min(tab.scrollOffset, limit));
      for (const [rowIndex, entryIndex] of built.toolRows) {
        const screenRow = rowIndex - tab.scrollOffset;
        if (screenRow >= 0 && screenRow < transcriptHeight) {
          transcriptHitRows.push({ row: screenRow, entryIndex });
        }
      }
      rows = rows.slice(tab.scrollOffset, tab.scrollOffset + transcriptHeight);
    }
    for (let i = 0; i < transcriptHeight; i++) lines.push(rows[i] ?? '');
    queueTop = transcriptHeight;
    lines.push(...queueLines);
    slashTop = transcriptHeight + queueLines.length;
    for (let i = 0; i < slashLines.length; i++) {
      slashHitRows.push({ row: slashTop + i, index: i });
    }
    lines.push(...slashLines);
    const isMain = session.focusedView === 'main';
    // A sub-agent view is a parent↔child conversation the user watches rather
    // than joins, so it gets the transcript row the input would have taken.
    if (isMain) {
      const placeholder =
        approvalQueue.length > 0
          ? 'decide the approval above (y/n)'
          : session.busy
            ? 'type to queue; Enter queues, [steer now] steers'
            : session.engine.planMode
              ? 'describe what to plan…'
              : 'ask, or /help';
      const inputLine =
        session.input.length > 0
          ? `${CYAN}❯${RESET} ${session.input}▏`
          : `${CYAN}❯${RESET} ${DIM}${placeholder}${RESET}`;
      lines.push(...activityLines(session, cw));
      lines.push(clipVisible(inputLine, cw + 2));
    } else {
      lines.push(...activityLines(session, cw));
    }
    agentMenuTop = lines.length;
    lines.push(...agentMenuLines(session, cw));
    const states = session.engine.subagentStates();
    const activeCount = states.filter(
      (s) => s.status === 'working' || s.status === 'awaiting_approval',
    ).length;
    const agentLabel = isMain
      ? states.length > 0
        ? `${states.length} agent${states.length === 1 ? '' : 's'}${
            activeCount > 0 ? ` (${activeCount} active)` : ''
          }`
        : ''
      : (session.viewNames.get(session.focusedView) ?? 'sub-agent');
    const selectLabel = selection ? ' · SELECTION (Ctrl+E copies)' : '';
    // Build the bar from segments so clickable ones get hit ranges and a
    // hover highlight. The bar keeps the terminal's own background — a filled
    // one made the text hard to read — so the mode is colored instead.
    statusHits = [];
    let statusLine = '';
    let column = 0;
    const segment = (text: string, key?: string, style = ''): void => {
      const width = visibleWidth(text);
      if (key) {
        statusHits.push({ start: column, end: column + width - 1, key });
        statusLine += hover === key ? `${INVERSE}${text}${RESET}` : `${style}${text}${RESET}`;
      } else {
        statusLine += `${style}${text}${RESET}`;
      }
      column += width;
    };
    segment(
      `${sidebarVisible ? '«' : '≡'} ${clipVisible(projectName(), 24)}`,
      'status:sidebar',
      BOLD,
    );
    segment(' · ', undefined, DIM);
    segment(session.engine.modelId, 'status:model');
    segment(' · ', undefined, DIM);
    segment(session.engine.mode.toUpperCase(), 'status:mode', MODE_COLORS[session.engine.mode]);
    if (agentLabel) {
      segment(' · ', undefined, DIM);
      segment(agentLabel, 'status:agents');
    }
    segment(`${selectLabel}${session.flash ? ` · ${session.flash}` : ''}`, undefined, DIM);
    lines.push(padVisible(clipVisible(statusLine, cw + 1), cw + 2));
    return lines;
  }

  function composedView() {
    const session = focused();
    const content = contentLines(session);
    if (!sidebarVisible) {
      lastFrameLines = content;
      const painted = selection ? highlightSelection(content, selection) : content;
      return h(Box, { direction: 'column', gap: 0 }, ...painted.map((line) => h(Text, null, line)));
    }
    sidebarDisplayCache = buildSidebarDisplay();
    ensureSelectedVisible(sidebarDisplayCache);
    const lines: string[] = [];
    // The last sidebar row is the list switcher, level with the status bar.
    const listRows = Math.max(1, height - 1);
    for (let i = 0; i < listRows; i++) {
      const lineIndex = sidebarScroll + i;
      const cell = sidebarDisplayCache.lines[lineIndex] ?? ' '.repeat(SIDEBAR_WIDTH);
      lines.push(`${cell}${DIM}│${RESET}${content[i] ?? ''}`);
    }
    lines.push(`${sidebarTabLine()}${DIM}│${RESET}${content[listRows] ?? ''}`);
    lastFrameLines = lines;
    const painted = selection ? highlightSelection(lines, selection) : lines;
    return h(Box, { direction: 'column', gap: 0 }, ...painted.map((line) => h(Text, null, line)));
  }

  /**
   * Mark the interface dirty.
   *
   * The render thunk reads `revision`, so bumping it is what re-renders —
   * there is no imperative paint call. Bumps are coalesced to the frame
   * interval because streamed tokens arrive far faster than a terminal can
   * usefully repaint.
   */
  function redraw(): void {
    const elapsed = Date.now() - lastPaint;
    if (elapsed >= REDRAW_INTERVAL_MS) {
      if (paintTimer !== undefined) {
        clearTimeout(paintTimer);
        paintTimer = undefined;
      }
      lastPaint = Date.now();
      revision.set(revision.get() + 1);
      return;
    }
    if (paintTimer === undefined) {
      paintTimer = setTimeout(() => {
        paintTimer = undefined;
        lastPaint = Date.now();
        revision.set(revision.get() + 1);
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
            '/model — model picker (or /model <id>, or click the model name in the status bar) · /title <t> — rename session',
            '/plan · /build · /auto — permission level (Shift+Tab or click the mode to cycle)',
            '/agents — switch between this session and its sub-agents (or click the agent count)',
            '/new — new session · /archive — archive session',
            'Ctrl+B or click ≡ — sidebar · Ctrl+N/P — next/prev session · Tab — cycle views',
            'Sidebar: click "+ new session", right-click a session for rename/archive/delete',
            'Transcript: click a tool call to expand its input/output (source and Markdown are formatted)',
            'Drag over the transcript to select text — it copies to the clipboard on release; Ctrl+E re-copies',
            'While a turn runs: Enter queues, [steer now]/Ctrl+S steers; the queue sends when the turn ends.',
          ].join('\n'),
        );
        break;
      case 'model':
        if (arg.length === 0) {
          openModelMenu(session);
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
        sidebarVisible = !sidebarVisible;
        break;
      case 'archive': {
        const meta = workspace.meta(session.id);
        await workspace.archiveSession(session.id, !(meta?.archived ?? false));
        notice(session, meta?.archived ? 'session unarchived' : 'session archived');
        break;
      }
      case 'new':
        await focusDraft();
        break;
      case 'debug': {
        // Hover, drag-selection and clicks each depend on a different mouse
        // reporting mode, so the counts say which ones this terminal sends:
        // no `move` events means it ignores any-motion tracking (mode 1003)
        // and hover affordances cannot light up while the pointer just moves.
        const counts = Object.entries(inputStats)
          .map(([name, count]) => `${name} ${count}`)
          .join(' · ');
        notice(
          session,
          [
            `terminal ${width}×${height} · TERM=${env.TERM ?? '?'}${
              env.TERM_PROGRAM ? ` · ${env.TERM_PROGRAM}` : ''
            }${env.TMUX ? ' · inside tmux' : ''}`,
            `input events: ${counts}`,
            'Move the pointer over the status bar and run /debug again: if `move`',
            'stays at 0 the terminal is not reporting motion (mode 1003).',
          ].join('\n'),
        );
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
    if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
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
    const slashMatches = slashFilter(session);
    if (event.type === 'mouse') {
      inputStats[event.action] += 1;
      // Terminals that do not report motion without a held button (mode 1003)
      // still deliver clicks and wheel events; tracking hover from those keeps
      // the affordances alive there instead of never lighting up at all.
      if (event.action !== 'move') updateHover(event.x, event.y);
      const inSidebar = sidebarVisible && event.x < SIDEBAR_WIDTH;
      const contentX = event.x - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0);
      if (event.action === 'press' && event.button === 'right' && inSidebar) {
        const entry = sidebarDisplayCache.lineMap[sidebarScroll + event.y];
        const row = entry ? sidebarDisplayCache.rows[entry.rowIndex] : undefined;
        if (row?.kind === 'session') {
          contextMenu = { sessionId: row.id, selected: 0, confirmDelete: false };
          redraw();
        }
        return;
      }
      if (event.action === 'press' && event.button === 'left') {
        if (selection) {
          selection = undefined;
          redraw();
        }
        // Arm a selection anchor for cells with no click action of their own;
        // the drag handler promotes it to a real selection, bounded by the
        // pane the press landed in.
        selectionRegion =
          hoverKeyAt(event.x, event.y) === undefined
            ? selectionRegionAt(event.x, event.y)
            : undefined;
        selectionAnchor = selectionRegion ? { x: event.x, y: event.y } : undefined;
        if (modelMenu) {
          if (!inSidebar && session) {
            const hit = modelMenuHitRows.find((r) => r.row === event.y);
            if (hit) {
              chooseModel(session, modelMenu, hit.index);
              return;
            }
          }
          modelMenu = undefined;
          redraw();
          return;
        }
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
        if (event.y === height - 1 && !inSidebar) {
          const hit = statusHits.find((h) => contentX >= h.start && contentX <= h.end);
          if (hit?.key === 'status:sidebar') {
            sidebarVisible = !sidebarVisible;
            redraw();
          } else if (session && hit?.key === 'status:model') {
            openModelMenu(session);
          } else if (session && hit?.key === 'status:mode') {
            cycleMode(session);
          } else if (session && hit?.key === 'status:agents') {
            if (agentMenu) {
              agentMenu = undefined;
              redraw();
            } else {
              openAgentMenu(session);
            }
          }
          return;
        }
        if (session && agentMenu && !inSidebar) {
          const hit = agentMenuHitRows.find((r) => r.row === event.y);
          if (hit) {
            chooseAgentView(session, hit.index);
            return;
          }
          agentMenu = undefined;
          redraw();
          return;
        }
        if (inSidebar) {
          if (event.y === height - 1) {
            const hit = sidebarTabHits.find((h) => event.x >= h.start && event.x <= h.end);
            if (hit) {
              sidebarTab = hit.key === 'tab:archived' ? 'archived' : 'active';
              sidebarScroll = 0;
              redraw();
            }
            return;
          }
          const entry = sidebarDisplayCache.lineMap[sidebarScroll + event.y];
          const row = entry ? sidebarDisplayCache.rows[entry.rowIndex] : undefined;
          if (!row) return;
          focusSidebarRow(row);
          redraw();
          return;
        }
        if (session && approvalQueue.length === 0 && !contextMenu) {
          const slashHit = slashHitRows.find((r) => r.row === event.y);
          if (slashHit && slashMatches.length > 0) {
            const start = Math.max(
              0,
              Math.min(slashSelected - SLASH_MAX_ROWS + 1, slashMatches.length - SLASH_MAX_ROWS),
            );
            const command = slashMatches[start + slashHit.index];
            if (command) applySlashCommand(session, command);
            return;
          }
          const queueRow = event.y - queueTop;
          const queueHit = queueHitRows.find(
            (r) => r.row === queueRow && contentX >= r.buttonStart && contentX <= r.buttonEnd,
          );
          if (queueHit) {
            steerMessage(session, queueHit.index);
            return;
          }
          const toolHit = transcriptHitRows.find((r) => r.row === event.y);
          if (toolHit) {
            const tab = view(session, session.focusedView);
            const entry = tab.entries[toolHit.entryIndex];
            if (entry?.kind === 'tool') {
              entry.expanded = !entry.expanded;
              redraw();
            }
            return;
          }
        }
      }
      if (event.action === 'drag') {
        // A drag that began on inert content is a text selection.
        if (selectionAnchor) {
          selection = {
            anchor: selectionAnchor,
            focus: { x: event.x, y: event.y },
            ...(selectionRegion ? { region: selectionRegion } : {}),
          };
          redraw();
        }
        return;
      }
      if (event.action === 'move') {
        updateHover(event.x, event.y);
        return;
      }
      if (event.action === 'release') {
        // A press that never turned into a drag leaves no selection behind.
        if (selection && selectionIsEmpty(selection)) selection = undefined;
        else if (selection && selectionAnchor) copySelection();
        selectionAnchor = undefined;
        selectionRegion = undefined;
        return;
      }
      if (event.action === 'wheel') {
        if (slashMatches.length > 0 && session && !inSidebar) {
          const delta = event.button === 'wheel-up' ? -1 : 1;
          slashSelected = Math.max(0, Math.min(slashMatches.length - 1, slashSelected + delta));
          redraw();
          return;
        }
        if (modelMenu && !inSidebar) {
          const menu = modelMenu;
          const delta = event.button === 'wheel-up' ? -3 : 3;
          menu.scroll = Math.max(0, menu.scroll + delta);
          redraw();
          return;
        }
        if (inSidebar) {
          const max = Math.max(0, sidebarDisplayCache.lines.length - Math.max(1, height - 1));
          sidebarScroll = Math.max(
            0,
            Math.min(max, sidebarScroll + (event.button === 'wheel-up' ? -3 : 3)),
          );
          redraw();
          return;
        }
        if (!session) return;
        scrollBy(session, event.button === 'wheel-up' ? -3 : 3);
      }
      return;
    }
    inputStats.key += 1;
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
    if (modelMenu && session) {
      const menu = modelMenu;
      if (event.key === 'escape') {
        modelMenu = undefined;
        redraw();
      } else if (event.key === 'up') {
        moveModelSelection(menu, -1);
      } else if (event.key === 'down') {
        moveModelSelection(menu, 1);
      } else if (event.key === 'enter') {
        chooseModel(session, menu, menu.selected);
      } else if (event.key === 'r' && event.ctrl) {
        void refreshModelCatalog(menu);
      }
      return;
    }
    if (agentMenu && session) {
      if (event.key === 'escape') {
        agentMenu = undefined;
        redraw();
      } else if (event.key === 'up') {
        moveAgentSelection(-1);
      } else if (event.key === 'down') {
        moveAgentSelection(1);
      } else if (event.key === 'enter') {
        chooseAgentView(session, agentMenu.selected);
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
    if (event.ctrl && event.key === 'e') {
      if (!copySelection() && session) {
        session.flash = 'nothing selected';
        redraw();
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
      if (!sidebarVisible) sidebarVisible = true;
      const display = buildSidebarDisplay();
      sidebarDisplayCache = display;
      const rows = display.rows;
      let index = selectedRowIndex(display);
      if (index < 0) index = 0;
      let next = index + (event.key === 'p' ? -1 : 1);
      if (next >= 0 && next < rows.length) focusSidebarRow(rows[next]!);
      redraw();
      return;
    }
    if (slashMatches.length > 0 && session) {
      if (event.key === 'up') {
        slashSelected = (slashSelected - 1 + slashMatches.length) % slashMatches.length;
        redraw();
        return;
      }
      if (event.key === 'down') {
        slashSelected = (slashSelected + 1) % slashMatches.length;
        redraw();
        return;
      }
      if (event.key === 'tab' && !event.shift) {
        const command = slashMatches[slashSelected];
        if (command) session.input = `/${command.name}${command.submits ? '' : ' '}`;
        redraw();
        return;
      }
      if (event.key === 'enter') {
        const command = slashMatches[slashSelected];
        if (command) applySlashCommand(session, command);
        return;
      }
      if (event.key === 'escape') {
        session.input = '';
        redraw();
        return;
      }
    }
    if (event.key === 'tab' && !event.shift) {
      if (session) cycleView(session, 1);
      return;
    }
    if (!session) {
      if (event.text === '/' || event.key === 'enter') await focusDraft();
      return;
    }
    if (event.key === 'escape') {
      if (selection) {
        selection = undefined;
        selectionAnchor = undefined;
        redraw();
        return;
      }
      if (session.focusedView !== 'main') {
        session.engine.cancelSubagent(session.focusedView);
        notice(session, 'cancelling sub-agent run…', session.focusedView);
        return;
      }
      if (session.busy && session.abort) session.abort.abort();
      return;
    }
    if (event.key === 'tab' && event.shift) {
      cycleMode(session);
      return;
    }
    if (event.ctrl && event.key === 's') {
      steerMessage(session, 0);
      return;
    }
    if (event.key === 'pageup' || event.key === 'pagedown') {
      const pageSize = Math.max(1, transcriptHeightFor(session) - 1);
      scrollBy(session, event.key === 'pageup' ? -pageSize : pageSize);
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

  workspace.onChange(() => {
    // The draft joins the registry when its first message runs; the sidebar
    // selection follows it from the `+` card to its own row.
    if (draftId !== undefined && !isDraft(draftId)) {
      if (selectedKey === 'new' && focusedSessionId === draftId) selectedKey = `s:${draftId}`;
      draftId = undefined;
    }
    redraw();
  });

  const initialId = opts.sessionId ?? workspace.list()[0]?.id;
  let initialSession: SessionUI | undefined;
  if (initialId) {
    const engine = workspace.engineFor(initialId) ?? (await workspace.openSession(initialId));
    initialSession = attachSession(engine);
    focusedSessionId = initialSession.id;
    selectedKey = isDraft(initialSession.id) ? 'new' : `s:${initialSession.id}`;
    if (isDraft(initialSession.id)) draftId = initialSession.id;
    // Replay the thread before the first render pass so a resumed session
    // opens on its transcript rather than an empty view.
    await initialSession.historyReady;
    initialSession.views.get('main')!.entries.unshift({
      kind: 'notice',
      text: 'fino code — /help for commands, Ctrl+B or click ≡ for the session sidebar, Shift+Tab cycles mode.',
      done: true,
      pin: 'top',
    });
    // Warm the provider catalog now so the model picker opens populated;
    // a failure here is not worth reporting until the picker is opened.
    void modelCatalog(initialSession).catch(() => {});
  }

  app = render(
    () => {
      revision.get();
      return composedView();
    },
    {
      input: true,
      mouse: true,
      motion: true,
      onEvent: handleEvent,
      onResize: (size) => {
        width = size.width;
        height = size.height;
        redraw();
      },
    },
  );
  const initial = app.size();
  if (initial.width !== width || initial.height !== height) {
    width = initial.width;
    height = initial.height;
    redraw();
  }
  // Recovery must start only after `app` exists: driveTurn repaints
  // synchronously, and an early throw would leave the session stuck busy.
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
    app.stop();
    await workspace.close();
  }
}
