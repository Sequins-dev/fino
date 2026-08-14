/**
 * fino:tty/components/box — bordered boxes and horizontal rules.
 */
import { visibleWidth } from '../tui.ts';
import { tk, style } from './theme.ts';
import { clipAnsi, padAnsi } from './text.ts';
function edge(
  left: string,
  label: string | undefined,
  right: string,
  innerWidth: number,
  paint: (text: string) => string,
): string {
  if (label === undefined || innerWidth < 2) {
    return paint(left + '─'.repeat(innerWidth) + right);
  }
  const text = clipAnsi(` ${label} `, innerWidth - 1);
  const fill = '─'.repeat(Math.max(0, innerWidth - 1 - visibleWidth(text)));
  return paint(left + '─') + text + paint(fill + right);
}
/**
 * Draw `body` inside a single-line box exactly `opts.width` cells wide.
 *
 * A `title` is embedded in the top border and a `footer` in the bottom one,
 * both as ` label `. `borderStyle` is a theme token applied to the border
 * characters only — body lines keep their own styling. `pad` adds inner
 * horizontal padding (default 1), and body lines are clipped to fit.
 *
 * ```ts
 * import { renderBox } from 'fino:tty/components/box';
 *
 * renderBox(['hi'], { width: 10, title: 'T' });
 * // ['┌─ T ────┐', '│ hi     │', '└────────┘']
 * ```
 */
export function renderBox(
  body: string[],
  opts: { width: number; title?: string; footer?: string; borderStyle?: string; pad?: number },
): string[] {
  const width = Math.max(2, opts.width);
  const pad = Math.max(0, opts.pad ?? 1);
  const token = opts.borderStyle;
  const paint = (text: string) => (token === undefined ? text : style(text, token));
  const innerWidth = width - 2;
  const contentWidth = Math.max(0, innerWidth - pad * 2);
  const gutter = ' '.repeat(pad);
  const lines = [edge('┌', opts.title, '┐', innerWidth, paint)];
  for (const line of body) {
    const content = padAnsi(clipAnsi(line, contentWidth), contentWidth);
    lines.push(paint('│') + gutter + content + gutter + paint('│'));
  }
  lines.push(edge('└', opts.footer, '┘', innerWidth, paint));
  return lines;
}
/**
 * A full-width horizontal `─` rule in the given theme token.
 *
 * ```ts
 * import { renderRule } from 'fino:tty/components/box';
 *
 * renderRule(4); // dim '────'
 * ```
 */
export function renderRule(width: number, styleToken = tk.dim as string): string {
  return style('─'.repeat(Math.max(0, width)), styleToken);
}
