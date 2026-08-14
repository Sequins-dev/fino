/**
 * internal:commands/code/ui/activity — the live turn activity indicator.
 *
 * The spinner line shown in the footer while a turn runs, and the
 * footer-only detail view of the currently running tool. The committed
 * counterpart — the dim `✔ 12s` line a finished turn leaves in the
 * transcript — is `renderTurnBlock` in `internal:commands/code/ui/blocks`.
 */
import { tk, style } from 'fino:tty/components/theme';
import { clipAnsi } from 'fino:tty/components/text';
import { formatToolSignature, formatToolOutputLines } from 'internal:commands/code/toolview';
import { formatDuration } from 'internal:commands/code/ui/blocks';

/** Live-state inputs for {@link renderActivityLive}. */
export interface ActivityProps {
  /** Current spinner glyph (the caller owns the clock). */
  spinnerFrame: string;
  planMode: boolean;
  /** What the agent is doing right now (tool name, "responding", …). */
  activity: string;
  /** Wall-clock start of the turn (ms). */
  startedAt: number;
  /** Wall-clock now (ms); injectable for tests. */
  now?: number;
  subagentsActive: number;
  queued: number;
  width: number;
}

/**
 * Render the one-line activity indicator: a yellow spinner and a dim
 * ` · `-joined summary of what is running and for how long.
 */
export function renderActivityLive(props: ActivityProps): string {
  const parts = [props.planMode ? 'Planning' : 'Working'];
  if (props.activity.length > 0) parts.push(props.activity);
  parts.push(formatDuration((props.now ?? Date.now()) - props.startedAt));
  if (props.subagentsActive > 0) {
    parts.push(`${props.subagentsActive} sub-agent${props.subagentsActive === 1 ? '' : 's'}`);
  }
  if (props.queued > 0) parts.push(`${props.queued} queued`);
  parts.push('Ctrl+C interrupts');
  return clipAnsi(
    `${tk.yellow}${props.spinnerFrame}${tk.reset} ${style(parts.join(' · '), tk.dim)}`,
    props.width,
  );
}

/** Detail lines kept for a running tool in the footer. */
const RUNNING_DETAIL_LINES = 6;

/**
 * Render the running tool's footer detail: its signature and the last few
 * lines of live output. This is the only place tool detail is ever visible —
 * once the tool completes, the committed block keeps just a short preview.
 */
export function renderRunningTool(
  opts: { name: string; args?: unknown; output?: string; width: number },
  now?: { startedAt: number; now?: number },
): string[] {
  const signature = formatToolSignature(opts.name, opts.args, {
    maxValue: Math.max(12, Math.floor(opts.width / 3)),
  });
  const elapsed =
    now !== undefined ? ` ${style(formatDuration((now.now ?? Date.now()) - now.startedAt), tk.dim)}` : '';
  const lines = [`${tk.yellow}●${tk.reset} ${clipAnsi(signature, Math.max(1, opts.width - 6))}${elapsed}`];
  if (opts.output !== undefined && opts.output.length > 0) {
    const body = formatToolOutputLines({
      name: opts.name,
      args: opts.args,
      output: opts.output,
      width: Math.max(1, opts.width - 4),
    });
    const shown = body.slice(-RUNNING_DETAIL_LINES);
    for (const line of shown) lines.push(`    ${clipAnsi(line, Math.max(1, opts.width - 4))}`);
  }
  return lines;
}
