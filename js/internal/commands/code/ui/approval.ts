/**
 * internal:commands/code/ui/approval — the footer approval band.
 *
 * Tool approvals render as a yellow-bordered band where the composer
 * normally sits: the same place the user's eyes already are, answered with
 * `y`/`n`, no overlay. While one is pending the composer is locked and the
 * selectors are suppressed; the decision commits to scrollback as a record
 * (`renderApprovalDecision` in `internal:commands/code/ui/blocks`).
 */
import { tk, style } from 'fino:tty/components/theme';
import { wrapPlain } from 'fino:tty/components/text';
import { renderBox } from 'fino:tty/components/box';
import type { ToolApprovalRequest } from 'fino:ai/runtime';

/** One queued approval, labeled with the session/agent it came from. */
export interface ApprovalPrompt {
  /** `session-title / agent` label for the requesting context. */
  sourceLabel: string;
  request: ToolApprovalRequest;
}

/**
 * Render the approval band: source, tool, risk, wrapped args, and the
 * `y`/`n` answer line, boxed in yellow at up to `width` columns.
 */
export function renderApprovalBand(
  item: ApprovalPrompt,
  queueLength: number,
  width: number,
): string[] {
  const inner = Math.max(20, Math.min(width - 4, 76));
  const args = JSON.stringify(item.request.args ?? {});
  const risk = item.request.risk ? ` ${style(`(${item.request.risk})`, tk.dim)}` : '';
  const body = [
    `${style('approval required', tk.bold)}  ${style(`(1 of ${queueLength})`, tk.dim)}`,
    '',
    `agent: ${style(item.sourceLabel, tk.bold)}`,
    `tool:  ${style(item.request.toolName, tk.bold)}${risk}`,
    ...wrapPlain(`args:  ${args}`, inner),
    '',
    `${style('y', tk.bold)} approve · ${style('n', tk.bold)} reject`,
  ];
  return renderBox(body, { width: inner + 4, borderStyle: tk.yellow });
}
