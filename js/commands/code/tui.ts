/**
 * fino:commands/code/tui — interactive terminal interface for `fino code`.
 *
 * A tabbed chat TUI over `fino:tty/tui`. The main tab is the human ↔ agent
 * conversation: a scrolling transcript with markdown-rendered assistant
 * messages and tool activity, an input band, and a status bar. Every spawned
 * sub-agent gets its own read-only tab showing the parent ↔ child
 * conversation as it streams; sub-agents are agent-driven, so their tabs
 * have no input. Tool approvals — the parent's and every child's — surface
 * in one global modal popover that overlays the transcript regardless of the
 * active tab and blocks all other interaction until decided with `y`/`n`.
 *
 * While a turn is active (including while sub-agents work), typed messages
 * queue instead of sending; each queued message has a clickable
 * `[steer now]` action (Ctrl+S for the oldest) that injects it into the
 * running turn as a steering message, and whatever is still queued when the
 * turn ends is sent as the next turn. Turn execution, durability, and the
 * sub-agent pool live in `CodeEngine`; this module only maps keys, clicks,
 * and agent events onto engine calls and screen updates.
 *
 * ```ts no_run
 * import { CodeEngine } from 'fino:commands/code/engine';
 * import { runCodeTui } from 'fino:commands/code/tui';
 *
 * const engine = await CodeEngine.create({ cwd: '/repo' });
 * await runCodeTui(engine, { recover: true });
 * ```
 */
import type { AgentEvent, ToolApprovalRequest } from 'fino:ai/runtime';
import type { SubagentState } from 'fino:ai/subagents';
import type { ModelMessage } from 'fino:ai/model';
import { renderMarkdownTerminal } from 'fino:format/markdown';
import { h } from 'fino:ui';
import {
  Box,
  Input,
  ScrollView,
  Text,
  measureTerminalSize,
  render,
  type TuiApp,
  type TuiEvent,
} from 'fino:tty/tui';
import type { CodeEngine, TurnResult } from 'fino:commands/code/engine';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const INVERSE = '\x1b[7m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const REDRAW_INTERVAL_MS = 33;
const QUEUE_PANE_MAX = 3;

interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  done: boolean;
  toolState?: 'running' | 'ok' | 'error';
  toolId?: string;
  cachedLines?: string[];
  cachedKey?: string;
}

interface ApprovalItem {
  sourceLabel: string;
  request: ToolApprovalRequest;
  decide: (approved: boolean) => void;
}

interface QueuedMessage {
  text: string;
}

interface TabView {
  entries: TranscriptEntry[];
  scrollOffset: number;
  stickToBottom: boolean;
}

const STATUS_GLYPHS: Record<SubagentState['status'], string> = {
  working: '⟳',
  awaiting_approval: '?',
  awaiting_review: '✔',
  done: '●',
  failed: '✗',
  cancelled: '✗',
};

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
  /**
   * Attempt `engine.recoverTurn()` on startup — resume a crashed run,
   * re-present a suspended approval, and pick up restored sub-agents.
   */
  recover?: boolean;
}

/**
 * Run the interactive `fino code` TUI until the user exits.
 *
 * Enters the alternate screen, drives turns on the given engine, and always
 * restores the terminal — including on errors — before resolving.
 */
export async function runCodeTui(engine: CodeEngine, opts: CodeTuiOptions = {}): Promise<void> {
  const terminal = await measureTerminalSize();
  const width = terminal.width;
  const height = terminal.height;
  const contentWidth = Math.max(20, width - 2);
  const inputBandHeight = 3;
  const statusHeight = 1;
  const tabBarHeight = 1;

  const tabIds: string[] = [];
  const tabNames = new Map<string, string>();
  const tabByChild = new Map<string, TabView>();
  let activeTab = 'main';
  function ensureTab(id: string, name: string): TabView {
    let view = tabByChild.get(id);
    if (!view) {
      view = { entries: [], scrollOffset: 0, stickToBottom: true };
      tabByChild.set(id, view);
      tabIds.push(id);
    }
    tabNames.set(id, name);
    return view;
  }
  const main = ensureTab('main', 'main');
  main.entries.push({
    kind: 'notice',
    text: 'fino code — /help for commands, Shift+Tab toggles plan mode, Ctrl+←/→ switch tabs, Esc cancels.',
    done: true,
  });

  let app: TuiApp;
  let input = '';
  const inputHistory: string[] = [];
  let historyIndex = -1;
  let status = 'Ready';
  let busy = false;
  const approvalQueue: ApprovalItem[] = [];
  const seenChildApprovals = new Set<string>();
  const messageQueue: QueuedMessage[] = [];
  let currentAbort: AbortController | undefined;
  let lastPaint = 0;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let tabHitSpans: Array<{ start: number; end: number; id: string }> = [];
  let queueHitRows: Array<{ row: number; buttonStart: number; buttonEnd: number; index: number }> =
    [];
  let queueTop = 0;

  function entryLines(entry: TranscriptEntry): string[] {
    const key = `${entry.kind}:${entry.done}:${entry.toolState ?? ''}:${entry.text.length}`;
    if (entry.cachedKey === key && entry.cachedLines) return entry.cachedLines;
    let lines: string[];
    if (entry.kind === 'user') {
      lines = wrapPlain(entry.text, contentWidth - 2).map(
        (line, index) => (index === 0 ? `${CYAN}❯${RESET} ` : '  ') + line,
      );
    } else if (entry.kind === 'assistant') {
      lines = entry.done
        ? renderMarkdownTerminal(entry.text, { width: contentWidth }).split('\n')
        : wrapPlain(entry.text, contentWidth);
    } else if (entry.kind === 'tool') {
      const mark =
        entry.toolState === 'running'
          ? `${YELLOW}●${RESET}`
          : entry.toolState === 'ok'
            ? `${GREEN}●${RESET}`
            : `${RED}●${RESET}`;
      lines = [`${mark} ${DIM}${entry.text}${RESET}`];
    } else {
      lines = wrapPlain(entry.text, contentWidth).map((line) => `${DIM}${line}${RESET}`);
    }
    entry.cachedKey = key;
    entry.cachedLines = lines;
    return lines;
  }

  function tabRows(view: TabView): string[] {
    const rows: string[] = [];
    for (const entry of view.entries) {
      if (rows.length > 0) rows.push('');
      rows.push(...entryLines(entry));
    }
    return rows;
  }

  function activeView(): TabView {
    return tabByChild.get(activeTab) ?? main;
  }

  function queuePaneLines(): string[] {
    if (messageQueue.length === 0) return [];
    const lines: string[] = [];
    queueHitRows = [];
    const shown = messageQueue.slice(0, QUEUE_PANE_MAX);
    for (let index = 0; index < shown.length; index++) {
      const label = ' [steer now]';
      const room = Math.max(4, width - label.length - 4);
      const text = shown[index]!.text;
      const preview = text.length > room ? text.slice(0, room - 1) + '…' : text;
      const line = `${DIM}· ${preview}${RESET}${YELLOW}${label}${RESET}`;
      queueHitRows.push({
        row: index,
        buttonStart: 2 + preview.length + 1,
        buttonEnd: 2 + preview.length + label.length,
        index,
      });
      lines.push(line);
    }
    if (messageQueue.length > shown.length) {
      lines.push(`${DIM}… ${messageQueue.length - shown.length} more queued${RESET}`);
    }
    return lines;
  }

  function tabBarLine(): string {
    tabHitSpans = [];
    let line = '';
    let col = 0;
    const states = new Map(engine.subagentStates().map((s) => [s.id, s]));
    for (const id of tabIds) {
      const name = tabNames.get(id) ?? id;
      const state = states.get(id);
      const glyph = state ? ` ${STATUS_GLYPHS[state.status]}` : '';
      const label = ` ${name}${glyph} `;
      const start = col;
      col += label.length + 1;
      tabHitSpans.push({ start, end: col - 1, id });
      const styled =
        id === activeTab
          ? `${INVERSE}${label}${RESET}`
          : state && (state.status === 'done' || state.status === 'cancelled')
            ? `${DIM}${label}${RESET}`
            : label;
      line += styled + ' ';
    }
    return line;
  }

  function popoverLines(): string[] {
    const item = approvalQueue[0];
    if (!item) return [];
    const args = JSON.stringify(item.request.args ?? {});
    const innerWidth = Math.max(30, Math.min(width - 8, 76));
    const body = [
      `${BOLD}approval required${RESET}  ${DIM}(${1} of ${approvalQueue.length})${RESET}`,
      '',
      `agent: ${BOLD}${item.sourceLabel}${RESET}`,
      `tool:  ${BOLD}${item.request.toolName}${RESET}${item.request.risk ? ` ${DIM}(${item.request.risk})${RESET}` : ''}`,
      ...wrapPlain(`args:  ${args}`, innerWidth - 4),
      '',
      `${BOLD}y${RESET} approve · ${BOLD}n${RESET} reject`,
    ];
    const top = `${YELLOW}┌${'─'.repeat(innerWidth - 2)}┐${RESET}`;
    const bottom = `${YELLOW}└${'─'.repeat(innerWidth - 2)}┘${RESET}`;
    const pad = (line: string): string => {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '').length;
      const fill = Math.max(0, innerWidth - 4 - visible);
      return `${YELLOW}│${RESET} ${line}${' '.repeat(fill)} ${YELLOW}│${RESET}`;
    };
    const box = [top, ...body.map(pad), bottom];
    const indent = ' '.repeat(Math.max(0, Math.floor((width - innerWidth) / 2)));
    return box.map((line) => indent + line);
  }

  function view() {
    const queueLines = queuePaneLines();
    const transcriptHeight = Math.max(
      1,
      height - tabBarHeight - inputBandHeight - statusHeight - queueLines.length,
    );
    const view = activeView();
    let rows: string[];
    if (approvalQueue.length > 0) {
      const popover = popoverLines();
      const padTop = Math.max(0, Math.floor((transcriptHeight - popover.length) / 2));
      rows = [...Array<string>(padTop).fill(''), ...popover];
      view.scrollOffset = 0;
    } else {
      rows = tabRows(view);
      const limit = Math.max(0, rows.length - transcriptHeight);
      if (view.stickToBottom) view.scrollOffset = limit;
      else view.scrollOffset = Math.max(0, Math.min(view.scrollOffset, limit));
    }
    queueTop = tabBarHeight + transcriptHeight;
    const states = engine.subagentStates();
    const activeCount = states.filter(
      (s) => s.status === 'working' || s.status === 'awaiting_approval',
    ).length;
    const agentSegment =
      states.length > 0
        ? ` · ${states.length} agents${activeCount > 0 ? ` (${activeCount} active)` : ''}`
        : '';
    const modeLabel = engine.planMode ? 'PLAN' : 'CODE';
    const autoLabel = engine.auto ? ' · auto' : '';
    const statusLine = ` ${engine.modelId} · ${modeLabel}${autoLabel}${agentSegment} · ${status}`;
    const isMain = activeTab === 'main';
    const placeholder =
      approvalQueue.length > 0
        ? 'decide the approval above (y/n)'
        : !isMain
          ? 'sub-agent tab — agent-driven, Esc cancels its run'
          : busy
            ? 'type to queue; Enter queues, [steer now] steers'
            : engine.planMode
              ? 'describe what to plan…'
              : 'ask, or /help';
    return h(
      Box,
      { direction: 'column', gap: 0 },
      h(Text, null, tabBarLine()),
      h(
        ScrollView,
        { height: transcriptHeight, offset: activeView().scrollOffset },
        ...rows.map((row) => h(Text, null, row)),
      ),
      ...queueLines.map((line) => h(Text, null, line)),
      h(
        Box,
        { height: inputBandHeight, paddingY: 1 },
        h(Input, {
          value: isMain && input.length > 0 ? input : placeholder,
          focused: isMain && approvalQueue.length === 0,
        }),
      ),
      h(Text, { background: engine.planMode ? 'magenta' : 'blue' }, statusLine),
    );
  }

  function paint(): void {
    lastPaint = Date.now();
    app.update(view());
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

  function notice(text: string, tab: TabView = main): void {
    tab.entries.push({ kind: 'notice', text, done: true });
    redraw();
  }

  function currentAssistant(view: TabView): TranscriptEntry {
    const last = view.entries[view.entries.length - 1];
    if (last && last.kind === 'assistant' && !last.done) return last;
    const entry: TranscriptEntry = { kind: 'assistant', text: '', done: false };
    view.entries.push(entry);
    return entry;
  }

  function finalizeAssistant(view: TabView): void {
    const last = view.entries[view.entries.length - 1];
    if (last && last.kind === 'assistant' && !last.done) {
      if (last.text.trim().length === 0) view.entries.pop();
      else last.done = true;
    }
  }

  function applyAgentEvent(view: TabView, ev: AgentEvent): void {
    if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
      currentAssistant(view).text += ev.event.text;
    } else if (ev.type === 'tool_start') {
      finalizeAssistant(view);
      view.entries.push({
        kind: 'tool',
        text: ev.name,
        done: true,
        toolState: 'running',
        toolId: ev.id,
      });
    } else if (ev.type === 'tool_result' || ev.type === 'tool_error') {
      for (let index = view.entries.length - 1; index >= 0; index--) {
        const entry = view.entries[index]!;
        if (entry.kind === 'tool' && entry.toolId === ev.id) {
          entry.toolState =
            ev.type === 'tool_error' || (ev.type === 'tool_result' && ev.isError) ? 'error' : 'ok';
          break;
        }
      }
    }
    redraw();
  }

  function onEvent(ev: AgentEvent): void {
    if (ev.type === 'retry') status = `Retrying (${ev.attempt})…`;
    else if (ev.type === 'fallback') status = `Fallback to ${ev.model}…`;
    applyAgentEvent(main, ev);
  }

  function seedChildTranscript(id: string, messages: ModelMessage[]): void {
    const view = tabByChild.get(id);
    if (!view) return;
    view.entries = [];
    for (const message of messages) {
      if (message.role === 'user' && typeof message.content === 'string') {
        view.entries.push({
          kind: 'user',
          text: message.content,
          done: true,
        });
      } else if (message.role === 'assistant') {
        if (typeof message.content === 'string') {
          view.entries.push({ kind: 'assistant', text: message.content, done: true });
        } else {
          for (const part of message.content) {
            if (part.type === 'text' && part.text.trim().length > 0) {
              view.entries.push({ kind: 'assistant', text: part.text, done: true });
            } else if (part.type === 'tool_use') {
              view.entries.push({
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

  engine.onSubagentEvent((id, ev) => {
    const state = engine.subagentStates().find((s) => s.id === id);
    const view = ensureTab(id, state?.name ?? id);
    applyAgentEvent(view, ev);
  });

  engine.onSubagentStatus((id, state) => {
    const view = ensureTab(id, state.name);
    if (view.entries.length === 0) {
      view.entries.push({ kind: 'user', text: state.spec.task, done: true });
    }
    if (state.status === 'awaiting_approval' && state.approval) {
      const token = state.approval.token;
      if (!seenChildApprovals.has(token)) {
        seenChildApprovals.add(token);
        approvalQueue.push({
          sourceLabel: state.name,
          request: state.approval.request,
          decide: (approved) => {
            if (approved) engine.approveSubagent(id);
            else engine.rejectSubagent(id, 'rejected by user');
          },
        });
      }
    }
    if (state.status === 'awaiting_review' || state.status === 'done') {
      finalizeAssistant(view);
      if (state.doneReport) {
        const marker = `suggests done: ${state.doneReport}`;
        if (!view.entries.some((e) => e.kind === 'notice' && e.text === marker)) {
          notice(marker, view);
        }
      }
      void engine.subagentHistory(id).then((messages) => {
        if (messages.length > 0) seedChildTranscript(id, messages);
      });
    }
    if (state.status === 'failed') notice(`failed: ${state.error ?? 'unknown error'}`, view);
    redraw();
  });

  function requestParentDecision(request: ToolApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      approvalQueue.push({
        sourceLabel: 'main',
        request,
        decide: resolve,
      });
      redraw();
    });
  }

  function flushQueueAsTurn(): void {
    if (busy || messageQueue.length === 0 || approvalQueue.length > 0) return;
    const text = messageQueue
      .splice(0)
      .map((m) => m.text)
      .join('\n\n');
    main.entries.push({ kind: 'user', text, done: true });
    void driveTurn(() => engine.runTurn(text, { onEvent, signal: currentAbort!.signal }));
  }

  async function driveTurn(start: () => Promise<TurnResult>): Promise<void> {
    busy = true;
    status = engine.planMode ? 'Planning…' : 'Working…';
    currentAbort = new AbortController();
    redraw();
    try {
      let result = await start();
      while (result.status === 'suspended') {
        if (!result.approval) {
          notice(`suspended: ${result.suspendReason ?? 'external input required'}`);
          break;
        }
        status = 'Waiting for approval…';
        redraw();
        const token = result.approval.token;
        const approved = await requestParentDecision(result.approval.request);
        status = 'Working…';
        redraw();
        result = approved
          ? await engine.approve(token, { onEvent, signal: currentAbort.signal })
          : await engine.reject(token, 'rejected by user', {
              onEvent,
              signal: currentAbort.signal,
            });
      }
      finalizeAssistant(main);
      if (result.status === 'done') status = 'Ready';
      else if (result.status !== 'suspended') status = `Turn ${result.status}`;
    } catch (err) {
      finalizeAssistant(main);
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort')) {
        notice('[turn cancelled]');
        status = 'Cancelled';
      } else {
        notice(`error: ${message}`);
        status = 'Error';
      }
    } finally {
      busy = false;
      currentAbort = undefined;
      main.stickToBottom = true;
      redraw();
      flushQueueAsTurn();
    }
  }

  function steerMessage(index: number): void {
    const [message] = messageQueue.splice(index, 1);
    if (!message) return;
    engine.steer(message.text);
    main.entries.push({ kind: 'notice', text: `↳ steered: ${message.text}`, done: true });
    redraw();
  }

  async function handleCommand(line: string): Promise<void> {
    const [command, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (command) {
      case 'help':
        notice(
          [
            '/model <id> — switch model · /models — list discovered models',
            '/plan · /code — switch mode (also Shift+Tab) · /auto — toggle auto-approval',
            '/agents — sub-agent status · Ctrl+←/→ or click — switch tabs',
            '/new — fresh thread · /exit — quit · Esc — cancel turn (or child run in its tab)',
            'While a turn runs: Enter queues, [steer now]/Ctrl+S steers, queue sends when the turn ends.',
          ].join('\n'),
        );
        break;
      case 'models': {
        status = 'Listing models…';
        redraw();
        try {
          const models = await engine.listModels();
          notice(
            models.length > 0
              ? models.map((m) => `${m.provider}: ${m.id}`).join('\n')
              : 'No models discovered.',
          );
        } catch (err) {
          notice(`model listing failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        status = 'Ready';
        break;
      }
      case 'model':
        if (arg.length === 0) {
          notice(`current model: ${engine.modelId}`);
          break;
        }
        await engine.setModel(arg);
        notice(`model → ${engine.modelId}`);
        break;
      case 'plan':
        engine.setPlanMode(true);
        notice('planning mode: read-only tools (sub-agents inherit read-only)');
        break;
      case 'code':
        engine.setPlanMode(false);
        notice('code mode: full tool set');
        break;
      case 'auto':
        engine.setAuto(!engine.auto);
        notice(`auto-approval ${engine.auto ? 'on' : 'off'}`);
        break;
      case 'agents': {
        const states = engine.subagentStates();
        notice(
          states.length === 0
            ? 'No sub-agents on this thread.'
            : states
                .map(
                  (s) =>
                    `${s.id} (${s.name}) [${s.status}]${s.doneReport ? ` — ${s.doneReport}` : ''}`,
                )
                .join('\n'),
        );
        break;
      }
      case 'new':
        engine.newThread();
        for (const id of [...tabIds]) {
          if (id !== 'main') {
            tabIds.splice(tabIds.indexOf(id), 1);
            tabByChild.delete(id);
          }
        }
        activeTab = 'main';
        main.entries.length = 0;
        messageQueue.length = 0;
        notice(`new thread ${engine.threadId}`);
        break;
      case 'exit':
      case 'quit':
        quit();
        break;
      default:
        notice(`unknown command: /${command} — try /help`);
    }
    redraw();
  }

  function quit(): void {
    if (paintTimer !== undefined) clearTimeout(paintTimer);
    app.stop();
    finish?.();
  }

  function submit(): void {
    const line = input.trim();
    if (line.length === 0) return;
    inputHistory.push(line);
    historyIndex = -1;
    input = '';
    if (line.startsWith('/')) {
      void handleCommand(line);
      return;
    }
    if (busy) {
      messageQueue.push({ text: line });
      redraw();
      return;
    }
    main.entries.push({ kind: 'user', text: line, done: true });
    main.stickToBottom = true;
    void driveTurn(() => engine.runTurn(line, { onEvent, signal: currentAbort!.signal }));
  }

  function switchTab(delta: number): void {
    const index = tabIds.indexOf(activeTab);
    const next = (index + delta + tabIds.length) % tabIds.length;
    activeTab = tabIds[next]!;
    redraw();
  }

  function decideApproval(approved: boolean): void {
    const item = approvalQueue.shift();
    if (!item) return;
    item.decide(approved);
    redraw();
  }

  async function handleEvent(event: TuiEvent): Promise<void> {
    if (event.type === 'mouse') {
      if (event.action === 'press' && event.button === 'left' && approvalQueue.length === 0) {
        if (event.y === 0) {
          const hit = tabHitSpans.find((span) => event.x >= span.start && event.x <= span.end);
          if (hit) {
            activeTab = hit.id;
            redraw();
          }
          return;
        }
        const queueRow = event.y - queueTop;
        const hit = queueHitRows.find(
          (r) => r.row === queueRow && event.x >= r.buttonStart && event.x <= r.buttonEnd,
        );
        if (hit) {
          steerMessage(hit.index);
          return;
        }
      }
      if (event.action === 'wheel') {
        const view = activeView();
        const rows = tabRows(view);
        const queueLines =
          messageQueue.length > 0 ? Math.min(messageQueue.length, QUEUE_PANE_MAX + 1) : 0;
        const transcriptHeight = Math.max(
          1,
          height - tabBarHeight - inputBandHeight - statusHeight - queueLines,
        );
        const limit = Math.max(0, rows.length - transcriptHeight);
        if (event.button === 'wheel-up') {
          view.scrollOffset = Math.max(0, view.scrollOffset - 3);
          view.stickToBottom = false;
        } else if (event.button === 'wheel-down') {
          view.scrollOffset = Math.min(limit, view.scrollOffset + 3);
          if (view.scrollOffset >= limit) view.stickToBottom = true;
        }
        redraw();
      }
      return;
    }
    if (event.ctrl && event.key === 'c') {
      if (busy && currentAbort) {
        currentAbort.abort();
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
    if (event.ctrl && (event.key === 'left' || event.key === 'right')) {
      switchTab(event.key === 'left' ? -1 : 1);
      return;
    }
    if (event.key === 'escape') {
      if (activeTab !== 'main') {
        engine.cancelSubagent(activeTab);
        notice('cancelling sub-agent run…', activeView());
        return;
      }
      if (busy && currentAbort) currentAbort.abort();
      return;
    }
    if (event.key === 'tab' && event.shift) {
      engine.setPlanMode(!engine.planMode);
      redraw();
      return;
    }
    if (event.ctrl && event.key === 's') {
      steerMessage(0);
      return;
    }
    if (event.key === 'pageup' || event.key === 'pagedown') {
      const view = activeView();
      const rows = tabRows(view);
      const transcriptHeight = Math.max(1, height - tabBarHeight - inputBandHeight - statusHeight);
      const limit = Math.max(0, rows.length - transcriptHeight);
      const page = Math.max(1, transcriptHeight - 1);
      if (event.key === 'pageup') {
        view.scrollOffset = Math.max(0, view.scrollOffset - page);
        view.stickToBottom = false;
      } else {
        view.scrollOffset = Math.min(limit, view.scrollOffset + page);
        if (view.scrollOffset >= limit) view.stickToBottom = true;
      }
      redraw();
      return;
    }
    if (activeTab !== 'main') return;
    if (event.ctrl && event.key === 'u') {
      input = '';
      redraw();
      return;
    }
    if (event.key === 'backspace') {
      input = input.slice(0, -1);
      redraw();
      return;
    }
    if (event.key === 'enter') {
      submit();
      redraw();
      return;
    }
    if (event.key === 'up' && !busy) {
      if (inputHistory.length === 0) return;
      historyIndex = historyIndex === -1 ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
      input = inputHistory[historyIndex] ?? '';
      redraw();
      return;
    }
    if (event.key === 'down' && !busy) {
      if (historyIndex === -1) return;
      historyIndex += 1;
      if (historyIndex >= inputHistory.length) {
        historyIndex = -1;
        input = '';
      } else {
        input = inputHistory[historyIndex] ?? '';
      }
      redraw();
      return;
    }
    if (event.text && !event.ctrl && !event.alt) {
      input += event.text;
      redraw();
    }
  }

  app = render(view(), {
    width,
    height,
    input: true,
    mouse: true,
    onEvent: handleEvent,
  });

  for (const state of engine.subagentStates()) {
    ensureTab(state.id, state.name);
    void engine.subagentHistory(state.id).then((messages) => {
      if (messages.length > 0) seedChildTranscript(state.id, messages);
    });
  }
  if (opts.recover) {
    void driveTurn(async () => {
      const recovered = await engine.recoverTurn({ onEvent, signal: currentAbort!.signal });
      if (recovered) {
        notice('[resumed interrupted turn]');
        return recovered;
      }
      return { status: 'done' } as TurnResult;
    });
  }

  try {
    await finished;
  } finally {
    app.stop();
    await engine.close();
  }
}
