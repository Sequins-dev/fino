/**
 * internal:commands/code/ui/footer — the dynamic footer composition.
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
import { renderActivityLive, renderRunningTool } from 'internal:commands/code/ui/activity';
import { renderApprovalBand, type ApprovalPrompt } from 'internal:commands/code/ui/approval';

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
  /**
   * Whether the committed transcript already ends with a blank row. The
   * footer supplies its own separator only when it does not, so the gap
   * above the footer is exactly one row either way.
   */
  transcriptEndsBlank?: boolean;
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
  status: Segment[];
}

/** Queued previews kept visible before the overflow row. */
const QUEUE_MAX_ROWS = 3;
/** Hard footer ceiling, before the terminal-height clamp. */
const FOOTER_MAX_ROWS = 24;
/** Most of the screen the streaming tail may claim. */
const TAIL_SCREEN_SHARE = 3;
/** Upper bound on the tail, however tall the terminal is. */
const TAIL_MAX_ROWS = 12;

/**
 * Rows the streaming tail may occupy in this footer before its head has to
 * be committed.
 *
 * Derived from what the rest of the footer actually needs right now, so the
 * side that decides what to flush and the side that decides what to draw can
 * never disagree — a tail row the renderer would have to drop is a line that
 * was never committed anywhere, and would simply vanish. The share is also
 * bounded: a footer that swallowed the terminal would leave no room for the
 * transcript it is supposed to be growing.
 */
export function tailAllowance(state: FooterState): number {
  const layout = footerLayout(state);
  const chrome = layout.build([]).length;
  return Math.max(
    1,
    Math.min(
      TAIL_MAX_ROWS,
      Math.floor(state.height / TAIL_SCREEN_SHARE),
      layout.budget - chrome,
    ),
  );
}

/**
 * Compose the footer frame for one paint.
 *
 * Returns the frame with the cursor placed at the composer's caret when the
 * composer is visible and editable, or hidden otherwise.
 */
export function composeFooter(state: FooterState): InlineFrame {
  const layout = footerLayout(state);
  const width = state.width;
  const tail = state.busy ? capTail(state.tailLines, tailAllowance(state)) : [];
  const lines = layout.build(tail);
  let cursor: InlineFrame['cursor'] = null;
  if (layout.composerLines.length > 0) {
    const caret = state.composer!.cursor({ width });
    const composerTop =
      lines.length -
      layout.statusLines.length -
      1 -
      layout.agentLines.length -
      layout.composerLines.length;
    if (composerTop >= 0) cursor = { row: composerTop + caret.row, column: caret.column };
  }
  return { lines, cursor };
}

interface FooterLayout {
  budget: number;
  statusLines: string[];
  composerLines: string[];
  agentLines: string[];
  build(tailRows: string[]): string[];
}

function footerLayout(state: FooterState): FooterLayout {
  const width = state.width;
  const budget = Math.max(3, Math.min(FOOTER_MAX_ROWS, state.height - 4));

  const statusPane = renderStatusBar({ segments: state.status, width });
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

  // Bands shed in reverse importance until the frame fits: the queue first,
  // then running-tool detail. The tail is never shed here — it is sized by
  // tailAllowance() instead, because a dropped tail row is an uncommitted
  // line that would disappear from the transcript entirely.
  const assemble = (tailRows: string[], activity: string[], queue: string[]): string[] => {
    // Exactly one blank row separates the footer from the committed
    // transcript above it, whichever band happens to come first.
    const lines: string[] = state.transcriptEndsBlank === true ? [] : [''];
    if (tailRows.length > 0) lines.push(...tailRows);
    if (activity.length > 0) {
      // The indicator keeps a blank row on either side, whether it follows
      // the live tail or the committed transcript directly.
      lines.push('');
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

  const build = (tailRows: string[]): string[] => {
    let activity = activityLines;
    let queue = queueLines;
    let lines = assemble(tailRows, activity, queue);
    if (lines.length > budget && queue.length > 0) {
      queue = [];
      lines = assemble(tailRows, activity, queue);
    }
    if (lines.length > budget && activity.length > 1) {
      activity = activity.slice(0, 1);
      lines = assemble(tailRows, activity, queue);
    }
    return lines;
  };

  return { budget, statusLines, composerLines: showComposer ? composerLines : [], agentLines, build };
}

function capTail(tail: string[], max: number): string[] {
  return tail.length > max ? tail.slice(tail.length - max) : tail;
}
