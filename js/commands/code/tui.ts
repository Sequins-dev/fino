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
import type { ModelMessage } from 'fino:ai/model';
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
import type { CodeEngine, TurnResult } from 'fino:commands/code/engine';
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
const SESSION_TITLE_LINES = 3;
const TOOL_DETAIL_LINES = 60;
const SLASH_MAX_ROWS = 6;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;

interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'notice';
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
  status: string;
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
  | { kind: 'session'; id: string; archived: boolean }
  | { kind: 'child'; sessionId: string; childId: string }
  | { kind: 'divider'; label: string };

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
  { name: 'plan', args: '', description: 'Planning mode (read-only tools)', submits: true },
  { name: 'code', args: '', description: 'Code mode (full tool set)', submits: true },
  { name: 'auto', args: '', description: 'Toggle auto-approval of gated tools', submits: true },
  { name: 'agents', args: '', description: 'Sub-agent status for this session', submits: true },
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
  if (row.kind === 'action-new') return 'new';
  if (row.kind === 'divider') return `div:${row.label}`;
  if (row.kind === 'session') return `s:${row.id}`;
  return `c:${row.sessionId}:${row.childId}`;
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
  let modelHitRange: { start: number; end: number; key: string } | undefined;
  let transcriptHitRows: Array<{ row: number; entryIndex: number }> = [];
  let slashHitRows: Array<{ row: number; index: number }> = [];
  let slashTop = 0;
  let slashSelected = 0;
  let lastSlashFilter = '';

  /**
   * Resolve a pointer position to a hoverable target key, reusing the hit
   * regions the last paint recorded. Returns `undefined` over inert cells.
   */
  function hoverKeyAt(x: number, y: number): string | undefined {
    if (approvalQueue.length > 0 || contextMenu || modelMenu) return undefined;
    const inSidebar = sidebarVisible && x < SIDEBAR_WIDTH;
    const contentX = x - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0);
    if (inSidebar) {
      const entry = sidebarDisplayCache.lineMap[sidebarScroll + y];
      const row = entry ? sidebarDisplayCache.rows[entry.rowIndex] : undefined;
      if (!row || row.kind === 'divider') return undefined;
      return `sidebar:${entry!.rowIndex}`;
    }
    if (y === height - 1) {
      const hit = statusHits.find((h) => contentX >= h.start && contentX <= h.end);
      return hit?.key;
    }
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

  /**
   * The line above the input: a live indicator while a turn runs, blank
   * otherwise so the input stays visually separated from the transcript.
   */
  function activityLine(session: SessionUI, cw: number): string {
    if (!session.busy) return '';
    const spinner = SPINNER_FRAMES[spinnerFrame]!;
    const elapsed = session.turnStartedAt
      ? Math.max(0, Math.round((Date.now() - session.turnStartedAt) / 1000))
      : 0;
    const states = session.engine.subagentStates();
    const active = states.filter(
      (state) => state.status === 'working' || state.status === 'awaiting_approval',
    ).length;
    const parts = [session.engine.planMode ? 'Planning' : 'Working'];
    if (session.activity) parts.push(session.activity);
    parts.push(elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`);
    if (active > 0) parts.push(`${active} sub-agent${active === 1 ? '' : 's'}`);
    if (session.queue.length > 0) parts.push(`${session.queue.length} queued`);
    parts.push('Ctrl+C interrupts');
    return clipVisible(`${YELLOW}${spinner}${RESET} ${DIM}${parts.join(' · ')}${RESET}`, cw + 2);
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
    if (session) session.status = `Copied ${text.length} characters.`;
    redraw();
    return true;
  }

  function contentWidth(): number {
    return Math.max(20, width - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0) - 2);
  }

  function focused(): SessionUI | undefined {
    return sessions.get(focusedSessionId);
  }

  function paneRows(session: SessionUI): { queue: number; slash: number } {
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
    return { queue, slash };
  }

  /**
   * Rows the transcript viewport occupies, above the queue and slash panes.
   *
   * The trailing 3 rows are the blank separator, the input line, and the
   * status bar.
   */
  function transcriptHeightFor(session: SessionUI): number {
    const panes = paneRows(session);
    return Math.max(1, height - panes.queue - panes.slash - 3);
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

  function openModelMenu(session: SessionUI): void {
    modelMenu = { loading: true, entries: [], selected: 0, scroll: 0, snap: true };
    redraw();
    void session.engine
      .listModels()
      .then((models) => {
        if (!modelMenu) return;
        const byProvider = new Map<string, string[]>();
        for (const info of models) {
          const list = byProvider.get(info.provider) ?? [];
          list.push(info.id);
          byProvider.set(info.provider, list);
        }
        const entries: ModelMenuEntry[] = [];
        for (const [provider, ids] of [...byProvider.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          entries.push({ kind: 'header', label: provider });
          for (const id of ids.sort()) entries.push({ kind: 'model', provider, id });
        }
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
      })
      .catch((err: unknown) => {
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
      });
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
        focusedSessionId = workspace.list()[0]?.id ?? '';
        if (focusedSessionId && !sessions.has(focusedSessionId)) {
          await focusSession(focusedSessionId);
        }
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
      status: 'Ready',
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

  function sessionTitle(id: string): string {
    return workspace.meta(id)?.title ?? id;
  }

  async function focusSession(id: string, viewId = 'main'): Promise<void> {
    focusedSessionId = id;
    selectedKey = viewId === 'main' ? `s:${id}` : selectedKey;
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
    session.status = session.engine.planMode ? 'Planning…' : 'Working…';
    session.turnStartedAt = Date.now();
    session.activity = 'thinking';
    session.abort = new AbortController();
    syncSpinner();
    const main = view(session, 'main');
    const onEvent = (ev: AgentEvent): void => {
      if (ev.type === 'retry') session.status = `Retrying (${ev.attempt})…`;
      else if (ev.type === 'fallback') session.status = `Fallback to ${ev.model}…`;
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
        session.status = 'Waiting for approval…';
        session.activity = 'waiting for approval';
        redraw();
        const token = result.approval.token;
        const approved = await requestParentDecision(session, result.approval.request);
        session.status = 'Working…';
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

  function buildSidebarDisplay(): SidebarDisplay {
    const w = SIDEBAR_WIDTH;
    const rows = sidebarRows();
    const lines: string[] = [];
    const lineMap: Array<{ rowIndex: number; first: boolean }> = [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const selected = rowKey(row) === selectedKey;
      const hovered = hover === `sidebar:${rowIndex}`;
      const emit = (line: string, first: boolean, dim = false): void => {
        const padded = dim ? `${DIM}${padVisible(line, w)}${RESET}` : padVisible(line, w);
        // The selected row is already inverse, so hover has to add the
        // underline on top of it or it would read as no feedback at all.
        lines.push(
          selected
            ? `${INVERSE}${hovered ? UNDERLINE : ''}${padded}${RESET}`
            : hovered
              ? `${UNDERLINE}${padded}${RESET}`
              : padded,
        );
        lineMap.push({ rowIndex, first });
      };
      if (row.kind === 'action-new') {
        const label = padVisible(`${selected ? '+' : `${GREEN}+${RESET}`} new session`, w - 2);
        emit(`${label}${selected ? '«' : `${DIM}«${RESET}`} `, true);
        continue;
      }
      if (row.kind === 'divider') {
        lines.push(`${DIM}${padVisible(`— ${row.label} —`, w)}${RESET}`);
        lineMap.push({ rowIndex, first: true });
        continue;
      }
      if (row.kind === 'session') {
        const arrow = row.archived ? ' ' : expanded.has(row.id) ? '▾' : '▸';
        const indicator = selected ? '' : sessionIndicator(row.id);
        const plainIndicator =
          sessions.get(row.id)?.engine.activity === 'working'
            ? '⟳'
            : sessions.get(row.id)?.engine.activity === 'waiting'
              ? '▲'
              : '·';
        const titleLines = wrapPlain(sessionTitle(row.id), w - 5).slice(0, SESSION_TITLE_LINES);
        for (let i = 0; i < titleLines.length; i++) {
          const prefix = i === 0 ? `${arrow} ${selected ? plainIndicator : indicator} ` : '    ';
          emit(`${prefix}${titleLines[i]}`, i === 0, row.archived && !selected);
        }
        continue;
      }
      const session = sessions.get(row.sessionId);
      const state = session?.engine.subagentStates().find((s) => s.id === row.childId);
      const glyph = state ? CHILD_GLYPHS[state.status] : '·';
      const name = clipVisible(session?.viewNames.get(row.childId) ?? row.childId, w - 7);
      const active = state && (state.status === 'working' || state.status === 'awaiting_approval');
      emit(`   ${glyph} ${name}`, true, !selected && !active);
    }
    return { rows, lines, lineMap };
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
    if (firstLine < sidebarScroll) sidebarScroll = firstLine;
    if (firstLine >= sidebarScroll + height) sidebarScroll = firstLine - height + 1;
  }

  function focusSidebarRow(row: SidebarRow): void {
    selectedKey = rowKey(row);
    if (row.kind === 'divider') return;
    if (row.kind === 'action-new') {
      void workspace.createSession().then((engine) => {
        attachSession(engine);
        focusedSessionId = engine.threadId;
        selectedKey = `s:${engine.threadId}`;
        redraw();
      });
      return;
    }
    if (row.kind === 'session') {
      void focusSession(row.id, 'main');
      return;
    }
    void focusSession(row.sessionId, row.childId).then(() => {
      selectedKey = rowKey(row);
      redraw();
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
    transcriptHitRows = [];
    slashHitRows = [];
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
      const maxRows = Math.max(4, Math.min(menu.entries.length, transcriptHeight - 6));
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
      body.push('', `${DIM}Enter select · Esc close${RESET}`);
      const box = [top, ...body.map(pad), bottom];
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
    lines.push(activityLine(session, cw));
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
    const selectLabel = selection ? ' · SELECTION (Ctrl+E copies)' : '';
    const bg = session.engine.planMode ? MAGENTA_BG : BLUE_BG;
    // Build the bar from segments so clickable ones get hit ranges and a
    // hover highlight; inverse reads as a pressable control over the bar's
    // own background.
    statusHits = [];
    let statusLine = '';
    let column = 0;
    const segment = (text: string, key?: string): void => {
      const width = visibleWidth(text);
      if (key) {
        statusHits.push({ start: column, end: column + width - 1, key });
        statusLine += hover === key ? `${INVERSE}${text}${RESET}${bg}` : text;
      } else {
        statusLine += text;
      }
      column += width;
    };
    segment(sidebarVisible ? '«' : '≡', 'status:sidebar');
    segment(` ${clipVisible(sessionTitle(session.id), 24)}${viewLabel} · `);
    segment(session.engine.modelId, 'status:model');
    segment(` · ${modeLabel}${autoLabel}${selectLabel}${agentSegment} · ${session.status}`);
    modelHitRange = statusHits.find((hit) => hit.key === 'status:model');
    lines.push(`${bg}${padVisible(clipVisible(statusLine, cw + 1), cw + 2)}${RESET}`);
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
    for (let i = 0; i < height; i++) {
      const lineIndex = sidebarScroll + i;
      const cell = sidebarDisplayCache.lines[lineIndex] ?? ' '.repeat(SIDEBAR_WIDTH);
      lines.push(`${cell}${DIM}│${RESET}${content[i] ?? ''}`);
    }
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
            '/plan · /code — switch mode (Shift+Tab) · /auto — toggle auto-approval',
            '/agents — sub-agent status · /new — new session · /archive — archive session',
            'Ctrl+B or click ≡ — sidebar · Ctrl+N/P — next/prev session · Tab — cycle views',
            'Sidebar: click "+ new session", click ▸/▾ to expand, right-click for rename/archive/delete',
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
        selectedKey = `s:${engine.threadId}`;
        break;
      }
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
        if (event.y === height - 1 && contentX >= 0 && contentX <= 1) {
          sidebarVisible = !sidebarVisible;
          redraw();
          return;
        }
        if (
          session &&
          event.y === height - 1 &&
          modelHitRange &&
          contentX >= modelHitRange.start &&
          contentX <= modelHitRange.end
        ) {
          openModelMenu(session);
          return;
        }
        if (inSidebar) {
          const entry = sidebarDisplayCache.lineMap[sidebarScroll + event.y];
          const row = entry ? sidebarDisplayCache.rows[entry.rowIndex] : undefined;
          if (!row) return;
          if (row.kind === 'action-new' && event.x >= SIDEBAR_WIDTH - 2) {
            sidebarVisible = false;
            redraw();
            return;
          }
          if (row.kind === 'session' && !row.archived && entry!.first && event.x < 2) {
            if (expanded.has(row.id)) expanded.delete(row.id);
            else expanded.add(row.id);
            redraw();
            return;
          }
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
          const max = Math.max(0, sidebarDisplayCache.lines.length - height);
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
        session.status = 'Nothing selected — drag over the transcript first.';
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
      while (next >= 0 && next < rows.length && rows[next]!.kind === 'divider') {
        next += event.key === 'p' ? -1 : 1;
      }
      if (next >= 0 && next < rows.length) {
        const row = rows[next]!;
        selectedKey = rowKey(row);
        if (row.kind !== 'action-new') focusSidebarRow(row);
      }
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
      if (event.text === '/' || event.key === 'enter') {
        const engine = await workspace.createSession();
        attachSession(engine);
        focusedSessionId = engine.threadId;
        selectedKey = `s:${engine.threadId}`;
        redraw();
      }
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
      session.engine.setPlanMode(!session.engine.planMode);
      redraw();
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

  workspace.onChange(() => redraw());

  const initialId = opts.sessionId ?? workspace.list()[0]?.id;
  let initialSession: SessionUI | undefined;
  if (initialId) {
    const engine = workspace.engineFor(initialId) ?? (await workspace.openSession(initialId));
    initialSession = attachSession(engine);
    focusedSessionId = initialSession.id;
    selectedKey = `s:${initialSession.id}`;
    // Replay the thread before the first render pass so a resumed session
    // opens on its transcript rather than an empty view.
    await initialSession.historyReady;
    initialSession.views.get('main')!.entries.unshift({
      kind: 'notice',
      text: 'fino code — /help for commands, Ctrl+B or click ≡ for the session sidebar, Shift+Tab toggles plan mode.',
      done: true,
      pin: 'top',
    });
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
