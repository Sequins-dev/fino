/**
 * fino:commands/code/ui/footer — the dynamic footer composition.
 *
 * Assembles the inline app's pinned bottom region from its bands, top to
 * bottom: streaming tail · activity indicator (with running-tool detail) ·
 * queued messages · approval band · slash selector · composer · agent
 * selector · status bar. Bands are omitted when empty, so an idle footer
 * shrinks to the composer, selectors, and status bar. When the terminal is
 * short, bands shed in reverse importance — the status bar and the
 * composer/approval band always survive.
 */
import type { InlineFrame } from 'fino:tty/tui';
import { tk, style } from 'fino:tty/components/theme';
import { clipAnsi } from 'fino:tty/components/text';
import type { Composer } from 'fino:tty/components/composer';
import type { SelectList } from 'fino:tty/components/list';
import { renderStatusBar, type Segment } from 'fino:tty/components/statusbar';
import { renderActivityLive, renderRunningTool } from 'fino:commands/code/ui/activity';
import { renderApprovalBand, type ApprovalPrompt } from 'fino:commands/code/ui/approval';

/** Everything the footer needs to paint one frame. */
export interface FooterState {
  width: number;
  height: number;
  busy: boolean;
  spinnerFrame: string;
  planMode: boolean;
  activity: string;
  turnStartedAt?: number;
  subagentsActive: number;
  /** Unsettled streaming tail, already rendered at commit width. */
  tailLines: string[];
  /** The tool currently running, shown in footer detail only. */
  runningTool?: { name: string; args?: unknown; output?: string };
  /** Queued message previews, oldest first. */
  queue: string[];
  approval?: { item: ApprovalPrompt; queueLength: number };
  /** Slash-command selector, when the input starts with `/`. */
  slash?: SelectList;
  /** The composer; absent for read-only (sub-agent, archived) views. */
  composer?: Composer;
  composerPlaceholder: string;
  /** Agent selector, when open (renders below the composer). */
  agentMenu?: SelectList;
  status: { left: Segment[]; right: Segment[] };
}

/** Streaming-tail rows kept visible in the footer. */
const TAIL_MAX_ROWS = 8;
/** Queued previews kept visible before the overflow row. */
const QUEUE_MAX_ROWS = 3;
/** Hard footer ceiling, before the terminal-height clamp. */
const FOOTER_MAX_ROWS = 20;

/**
 * Compose the footer frame for one paint.
 *
 * Returns the frame with the cursor placed at the composer's caret when the
 * composer is visible and editable, or hidden otherwise.
 */
export function composeFooter(state: FooterState): InlineFrame {
  const width = state.width;
  const budget = Math.max(3, Math.min(FOOTER_MAX_ROWS, state.height - 4));

  const statusPane = renderStatusBar({ left: state.status.left, right: state.status.right, width });
  const statusLines = statusPane.lines;

  const approvalLines =
    state.approval !== undefined
      ? renderApprovalBand(state.approval.item, state.approval.queueLength, width)
      : [];
  const showComposer = state.composer !== undefined && state.approval === undefined;

  const composerLines = showComposer
    ? state.composer!.render({
        width,
        placeholder: state.composerPlaceholder,
      })
    : [];
  const slashLines =
    showComposer && state.slash !== undefined ? state.slash.render(width).lines : [];
  const agentLines =
    state.agentMenu !== undefined && state.approval === undefined
      ? state.agentMenu.render(width).lines
      : [];

  let queueLines: string[] = [];
  if (state.queue.length > 0) {
    const shown = state.queue.slice(0, QUEUE_MAX_ROWS);
    queueLines = shown.map((text) =>
      clipAnsi(`${style('·', tk.dim)} ${style(text, tk.dim)}`, width),
    );
    const more = state.queue.length - shown.length;
    const hint = more > 0 ? `… ${more} more queued · Ctrl+S steers` : 'Ctrl+S steers the oldest';
    queueLines.push(style(clipAnsi(hint, width), tk.dim));
  }

  let activityLines: string[] = [];
  if (state.busy) {
    activityLines = [
      renderActivityLive({
        spinnerFrame: state.spinnerFrame,
        planMode: state.planMode,
        activity: state.activity,
        startedAt: state.turnStartedAt ?? Date.now(),
        subagentsActive: state.subagentsActive,
        queued: state.queue.length,
        width,
      }),
    ];
    if (state.runningTool !== undefined) {
      activityLines.push(
        ...renderRunningTool({ ...state.runningTool, width }),
      );
    }
  }

  const tail = state.busy ? capTail(state.tailLines, TAIL_MAX_ROWS) : [];

  // Assemble top-down, then shed from the least important band until the
  // frame fits the budget: tail rows beyond one, running-tool detail, queue
  // rows, the blank separators — never the composer/approval or status bar.
  const build = (tailRows: string[], activity: string[], queue: string[]): string[] => {
    const lines: string[] = [];
    if (tailRows.length > 0) lines.push(...tailRows);
    if (activity.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(...activity);
    }
    if (state.busy || queue.length > 0) lines.push('');
    if (queue.length > 0) lines.push(...queue);
    if (approvalLines.length > 0) lines.push(...approvalLines);
    if (slashLines.length > 0) lines.push(...slashLines);
    if (composerLines.length > 0) lines.push(...composerLines);
    if (agentLines.length > 0) lines.push(...agentLines);
    lines.push('');
    lines.push(...statusLines);
    return lines;
  };

  let tailRows = tail;
  let activity = activityLines;
  let queue = queueLines;
  let lines = build(tailRows, activity, queue);
  if (lines.length > budget) {
    queue = [];
    lines = build(tailRows, activity, queue);
  }
  if (lines.length > budget && activity.length > 1) {
    activity = activity.slice(0, 1);
    lines = build(tailRows, activity, queue);
  }
  while (lines.length > budget && tailRows.length > 1) {
    tailRows = tailRows.slice(1);
    lines = build(tailRows, activity, queue);
  }
  if (lines.length > budget && tailRows.length > 0) {
    tailRows = [];
    lines = build(tailRows, activity, queue);
  }

  let cursor: InlineFrame['cursor'] = null;
  if (showComposer) {
    const caret = state.composer!.cursor({ width });
    const composerTop = lines.length - statusLines.length - 1 - agentLines.length - composerLines.length;
    if (composerTop >= 0 && composerLines.length > 0) {
      cursor = { row: composerTop + caret.row, column: caret.column };
    }
  }
  return { lines, cursor };
}

function capTail(tail: string[], max: number): string[] {
  return tail.length > max ? tail.slice(tail.length - max) : tail;
}
