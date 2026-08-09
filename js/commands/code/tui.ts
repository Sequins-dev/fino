/**
 * fino:commands/code/tui — interactive terminal interface for `fino code`.
 *
 * A chat TUI over `fino:tty/tui`: a scrolling transcript with
 * markdown-rendered assistant messages and tool activity lines, an input
 * band, and a status bar showing the model, the plan/code mode, and turn
 * state. Turn execution and durability live in `CodeEngine`; this module
 * only translates key events into engine calls and agent events into screen
 * updates. Redraws are throttled while tokens stream, the transcript follows
 * the tail unless the user scrolls up, and gated tool approvals render
 * inline and resolve on a single keypress.
 *
 * ```ts no_run
 * import { CodeEngine } from 'fino:commands/code/engine';
 * import { runCodeTui } from 'fino:commands/code/tui';
 *
 * const engine = await CodeEngine.create({ cwd: '/repo' });
 * await runCodeTui(engine);
 * ```
 */
import type { AgentEvent } from 'fino:ai/runtime';
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
import type { CodeEngine, PendingApproval } from 'fino:commands/code/engine';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const REDRAW_INTERVAL_MS = 33;

interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  done: boolean;
  toolState?: 'running' | 'ok' | 'error';
  toolId?: string;
  cachedLines?: string[];
  cachedKey?: string;
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
 * Run the interactive `fino code` TUI until the user exits.
 *
 * Enters the alternate screen, drives turns on the given engine, and always
 * restores the terminal — including on errors — before resolving.
 */
export async function runCodeTui(engine: CodeEngine): Promise<void> {
  const terminal = await measureTerminalSize();
  const width = terminal.width;
  const height = terminal.height;
  const contentWidth = Math.max(20, width - 2);
  const inputBandHeight = 3;
  const statusHeight = 1;
  const transcriptHeight = Math.max(1, height - inputBandHeight - statusHeight);

  const entries: TranscriptEntry[] = [
    {
      kind: 'notice',
      text: 'fino code — /help for commands, Shift+Tab toggles plan mode, Esc cancels a turn.',
      done: true,
    },
  ];
  let app: TuiApp;
  let input = '';
  const inputHistory: string[] = [];
  let historyIndex = -1;
  let status = 'Ready';
  let busy = false;
  let scrollOffset = 0;
  let stickToBottom = true;
  let pending: PendingApproval | undefined;
  let decide: ((approved: boolean) => void) | undefined;
  let currentAbort: AbortController | undefined;
  let lastPaint = 0;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

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

  function transcriptRows(): string[] {
    const rows: string[] = [];
    for (const entry of entries) {
      if (rows.length > 0) rows.push('');
      rows.push(...entryLines(entry));
    }
    if (pending) {
      rows.push('');
      const req = pending.request;
      const args = JSON.stringify(req.args ?? {});
      const summary = args.length > contentWidth * 3 ? args.slice(0, contentWidth * 3) + '…' : args;
      rows.push(`${YELLOW}▲ approval required:${RESET} ${BOLD}${req.toolName}${RESET}`);
      rows.push(...wrapPlain(summary, contentWidth - 2).map((line) => `  ${DIM}${line}${RESET}`));
      rows.push(`  ${BOLD}y${RESET} approve · ${BOLD}n${RESET} reject`);
    }
    return rows;
  }

  function maxScroll(rows: string[]): number {
    return Math.max(0, rows.length - transcriptHeight);
  }

  function view() {
    const rows = transcriptRows();
    const limit = maxScroll(rows);
    if (stickToBottom) scrollOffset = limit;
    else scrollOffset = Math.max(0, Math.min(scrollOffset, limit));
    const modeLabel = engine.planMode ? 'PLAN' : 'CODE';
    const autoLabel = engine.auto ? ' · auto' : '';
    const statusLine = ` ${engine.modelId} · ${modeLabel}${autoLabel} · ${status}`;
    const placeholder = engine.planMode ? 'describe what to plan…' : 'ask, or /help';
    return h(
      Box,
      { direction: 'column', gap: 0 },
      h(
        ScrollView,
        { height: transcriptHeight, offset: scrollOffset },
        ...rows.map((row) => h(Text, null, row)),
      ),
      h(
        Box,
        { height: inputBandHeight, paddingY: 1 },
        h(Input, { value: input.length > 0 ? input : placeholder, focused: true }),
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

  function notice(text: string): void {
    entries.push({ kind: 'notice', text, done: true });
    redraw();
  }

  function currentAssistant(): TranscriptEntry {
    const last = entries[entries.length - 1];
    if (last && last.kind === 'assistant' && !last.done) return last;
    const entry: TranscriptEntry = { kind: 'assistant', text: '', done: false };
    entries.push(entry);
    return entry;
  }

  function finalizeAssistant(): void {
    const last = entries[entries.length - 1];
    if (last && last.kind === 'assistant' && !last.done) {
      if (last.text.trim().length === 0) entries.pop();
      else last.done = true;
    }
  }

  function onEvent(ev: AgentEvent): void {
    if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
      currentAssistant().text += ev.event.text;
    } else if (ev.type === 'tool_start') {
      finalizeAssistant();
      entries.push({
        kind: 'tool',
        text: ev.name,
        done: true,
        toolState: 'running',
        toolId: ev.id,
      });
    } else if (ev.type === 'tool_result' || ev.type === 'tool_error') {
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (entry.kind === 'tool' && entry.toolId === ev.id) {
          entry.toolState =
            ev.type === 'tool_error' || (ev.type === 'tool_result' && ev.isError) ? 'error' : 'ok';
          break;
        }
      }
    } else if (ev.type === 'retry') {
      status = `Retrying (${ev.attempt})…`;
    } else if (ev.type === 'fallback') {
      status = `Fallback to ${ev.model}…`;
    }
    redraw();
  }

  function waitForDecision(): Promise<boolean> {
    return new Promise((resolve) => {
      decide = resolve;
    });
  }

  async function driveTurn(text: string): Promise<void> {
    busy = true;
    status = engine.planMode ? 'Planning…' : 'Working…';
    currentAbort = new AbortController();
    redraw();
    try {
      let result = await engine.runTurn(text, { onEvent, signal: currentAbort.signal });
      while (result.status === 'suspended') {
        if (!result.approval) {
          notice(`suspended: ${result.suspendReason ?? 'external input required'}`);
          break;
        }
        pending = result.approval;
        status = 'Waiting for approval…';
        redraw();
        const approved = await waitForDecision();
        const token = pending.token;
        pending = undefined;
        status = 'Working…';
        redraw();
        result = approved
          ? await engine.approve(token, { signal: currentAbort.signal })
          : await engine.reject(token, 'rejected by user', { signal: currentAbort.signal });
      }
      finalizeAssistant();
      if (result.status === 'done') status = 'Ready';
      else if (result.status !== 'suspended') status = `Turn ${result.status}`;
    } catch (err) {
      finalizeAssistant();
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
      pending = undefined;
      decide = undefined;
      currentAbort = undefined;
      stickToBottom = true;
      redraw();
    }
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
            '/new — fresh thread · /exit — quit · Esc — cancel turn · wheel/PgUp/PgDn — scroll',
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
        notice('planning mode: read-only tools, produces a plan');
        break;
      case 'code':
        engine.setPlanMode(false);
        notice('code mode: full tool set');
        break;
      case 'auto':
        engine.setAuto(!engine.auto);
        notice(`auto-approval ${engine.auto ? 'on' : 'off'}`);
        break;
      case 'new':
        engine.newThread();
        entries.length = 0;
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
      status = 'A turn is already running (Esc to cancel).';
      redraw();
      return;
    }
    entries.push({ kind: 'user', text: line, done: true });
    stickToBottom = true;
    void driveTurn(line);
  }

  async function handleEvent(event: TuiEvent): Promise<void> {
    if (event.type === 'mouse') {
      if (event.action === 'wheel') {
        const rows = transcriptRows();
        if (event.button === 'wheel-up') {
          scrollOffset = Math.max(0, scrollOffset - 3);
          stickToBottom = false;
        } else if (event.button === 'wheel-down') {
          scrollOffset = Math.min(maxScroll(rows), scrollOffset + 3);
          if (scrollOffset >= maxScroll(rows)) stickToBottom = true;
        }
        redraw();
      }
      return;
    }
    if (pending && decide && !event.ctrl && !event.alt) {
      if (event.text === 'y' || event.text === 'Y') {
        decide(true);
        decide = undefined;
        return;
      }
      if (event.text === 'n' || event.text === 'N') {
        decide(false);
        decide = undefined;
        return;
      }
    }
    if (event.ctrl && event.key === 'c') {
      if (busy && currentAbort) {
        if (decide) {
          decide(false);
          decide = undefined;
        }
        currentAbort.abort();
        return;
      }
      quit();
      return;
    }
    if (event.key === 'escape') {
      if (busy && currentAbort) {
        if (decide) {
          decide(false);
          decide = undefined;
        }
        currentAbort.abort();
      }
      return;
    }
    if (event.key === 'tab' && event.shift) {
      engine.setPlanMode(!engine.planMode);
      redraw();
      return;
    }
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
    if (event.key === 'pageup' || event.key === 'pagedown') {
      const rows = transcriptRows();
      const page = Math.max(1, transcriptHeight - 1);
      if (event.key === 'pageup') {
        scrollOffset = Math.max(0, scrollOffset - page);
        stickToBottom = false;
      } else {
        scrollOffset = Math.min(maxScroll(rows), scrollOffset + page);
        if (scrollOffset >= maxScroll(rows)) stickToBottom = true;
      }
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
  try {
    await finished;
  } finally {
    app.stop();
    await engine.close();
  }
}
