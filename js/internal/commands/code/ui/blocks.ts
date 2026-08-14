/**
 * internal:commands/code/ui/blocks — committed-form transcript renderers.
 *
 * Every function here renders one transcript block into the pre-styled,
 * pre-wrapped lines that get committed into terminal scrollback. Committed
 * lines are immutable — there is no hover, no expansion, no re-render — so
 * each renderer produces the final form for a given width. Pure functions,
 * snapshot-testable.
 */
import { tk, style } from 'fino:tty/components/theme';
import { clipAnsi, wrapPlain } from 'fino:tty/components/text';
import { renderRule } from 'fino:tty/components/box';
import { renderMarkdownTerminal } from 'fino:format/markdown';
import {
  formatToolSignature,
  formatToolOutputLines,
} from 'internal:commands/code/toolview';
import { TOOL_MARKS, CHILD_GLYPHS } from 'internal:commands/code/ui/theme';
import type { SubagentState } from 'fino:ai/subagents';
import type { CodeTurnRecord } from 'internal:commands/code/engine';

/**
 * One transcript block in a view's log.
 *
 * The committed-scrollback model keeps only what the block renderers need to
 * replay a view: no expansion state, no line caches, no per-entry stream
 * renderers. `pin` marks host-generated entries (an intro banner, sub-agent
 * status notes) that survive history reseeds.
 */
export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'turn';
  text: string;
  /** False while an assistant message is still streaming. */
  done?: boolean;
  toolState?: 'running' | 'ok' | 'error';
  toolId?: string;
  argsValue?: unknown;
  outputText?: string;
  pin?: 'top' | 'bottom';
}

/** Output-preview lines kept in a committed tool block. */
const TOOL_PREVIEW_LINES = 2;

/**
 * Render a user message: a cyan `❯` gutter with wrapped, indented text.
 */
export function renderUserBlock(text: string, width: number): string[] {
  return wrapPlain(text, Math.max(1, width - 2)).map(
    (line, index) => (index === 0 ? `${tk.cyan}❯${tk.reset} ` : '  ') + line,
  );
}

/**
 * Render a finished assistant message: the rule that marks where prose
 * resumes, a blank row, then the markdown rendered at `width`.
 *
 * Streaming commits produce the same shape incrementally — the rule and the
 * blank land when the message opens, the markdown lines as blocks settle —
 * so replayed and streamed transcripts look identical.
 */
export function renderAssistantBlock(markdown: string, width: number): string[] {
  return [...assistantBlockPrefix(width), ...renderMarkdownTerminal(markdown, { width }).split('\n')];
}

/**
 * The rule-plus-blank prefix that opens every assistant block. The streaming
 * pipeline commits this on the first delta, before any settled markdown.
 */
export function assistantBlockPrefix(width: number): string[] {
  // One column short of the terminal: a row that fills the last column can be
  // recorded as soft-wrapped and joined with the row below it when the window
  // is narrowed, which drags the following line out of alignment.
  return [renderRule(Math.max(1, width - 1)), ''];
}

/**
 * Render a committed tool call: a state-colored bullet, the call signature,
 * and a short dim preview of its output. Detail beyond the preview is only
 * ever visible in the footer while the tool runs.
 */
export function renderToolBlock(
  entry: { name: string; args?: unknown; state: 'ok' | 'error'; output?: string },
  width: number,
): string[] {
  const mark = `${TOOL_MARKS[entry.state]}●${tk.reset}`;
  const signature = formatToolSignature(entry.name, entry.args, {
    maxValue: Math.max(12, Math.floor(width / 3)),
  });
  const lines = [`${mark} ${clipAnsi(signature, Math.max(1, width - 2))}`];
  if (entry.output !== undefined && entry.output.length > 0) {
    const preview = formatToolOutputLines({
      name: entry.name,
      args: entry.args,
      output: entry.output,
      width: Math.max(1, width - 4),
    }).slice(0, TOOL_PREVIEW_LINES);
    for (const line of preview) lines.push(`    ${style(clipAnsi(line, width - 4), tk.dim)}`);
  }
  return lines;
}

/**
 * Render a notice: dim wrapped text for host-generated remarks.
 */
export function renderNoticeBlock(text: string, width: number): string[] {
  return wrapPlain(text, Math.max(1, width)).map((line) => style(line, tk.dim));
}

/**
 * Render a turn marker: the outcome and how long the turn took, dim.
 */
export function renderTurnBlock(turn: CodeTurnRecord, width: number): string[] {
  return [style(clipAnsi(turnMarkerText(turn), width), tk.dim)];
}

/** One line of turn bookkeeping: the outcome and how long it took. */
export function turnMarkerText(turn: CodeTurnRecord): string {
  const mark = turn.status === 'done' ? '✔' : '✗';
  return `${mark} ${formatDuration(turn.durationMs)}`;
}

/** Compact duration for turn markers and the activity indicator. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

/**
 * Render the record of an approval decision, committed once it is made so
 * the transcript keeps what was asked and what was answered.
 */
export function renderApprovalDecision(
  opts: { sourceLabel: string; toolName: string; approved: boolean },
  width: number,
): string[] {
  const mark = opts.approved ? '✔ approved' : '✗ rejected';
  return [style(clipAnsi(`${mark} ${opts.toolName} — ${opts.sourceLabel}`, width), tk.dim)];
}

/**
 * Render the divider block printed on every view switch, before the target
 * view's history replays: a heavy rule, the title, and a dim subtitle. Old
 * content stays above it in scrollback, the way `cat` output accumulates.
 */
export function renderSessionHeader(
  opts: {
    title: string;
    kind: 'session' | 'subagent' | 'archived';
    subtitle?: string;
    childStatus?: SubagentState['status'];
  },
  width: number,
): string[] {
  const rule = style('━'.repeat(Math.max(1, width - 1)), tk.dim);
  const glyph =
    opts.kind === 'subagent' ? `${CHILD_GLYPHS[opts.childStatus ?? 'working']} ` : '» ';
  const title = clipAnsi(`${glyph}${opts.title}`, width);
  const lines = ['', rule, style(title, tk.bold, tk.white)];
  if (opts.subtitle !== undefined && opts.subtitle.length > 0) {
    lines.push(style(clipAnsi(opts.subtitle, width), tk.dim));
  }
  lines.push('');
  return lines;
}

/**
 * Render one stored transcript entry in its committed form — the dispatch
 * used when a view's history replays into scrollback.
 */
export function renderEntry(entry: TranscriptEntry, width: number): string[] {
  switch (entry.kind) {
    case 'user':
      return renderUserBlock(entry.text, width);
    case 'assistant':
      return renderAssistantBlock(entry.text, width);
    case 'tool':
      return renderToolBlock(
        {
          name: entry.text,
          args: entry.argsValue,
          state: entry.toolState === 'error' ? 'error' : 'ok',
          ...(entry.outputText !== undefined ? { output: entry.outputText } : {}),
        },
        width,
      );
    case 'turn':
      return [style(clipAnsi(entry.text, width), tk.dim)];
    case 'notice':
      return renderNoticeBlock(entry.text, width);
  }
}
