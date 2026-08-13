/**
 * fino:tty/components/text — line-shaping helpers over the ANSI-aware
 * measuring in `fino:tty/tui`.
 */
import { fitAnsi, visibleWidth } from '../tui.ts';
/**
 * Pad a possibly-styled line with trailing spaces to `width` visible cells.
 *
 * Never clips: lines already at or past the width come back unchanged.
 *
 * ```ts
 * import { padAnsi } from 'fino:tty/components/text';
 *
 * padAnsi('hi', 4); // 'hi  '
 * ```
 */
export function padAnsi(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}
/**
 * Clip a possibly-styled line to `width` visible cells.
 *
 * When clipping actually happens the visible text ends with a `…` (which
 * takes the last cell) and any open styling is reset first, so a truncated
 * run never leaks color. No padding is added.
 *
 * ```ts
 * import { clipAnsi } from 'fino:tty/components/text';
 *
 * clipAnsi('hello world', 5); // 'hell…'
 * clipAnsi('hi', 5); // 'hi'
 * ```
 */
export function clipAnsi(text: string, width: number): string {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return '…';
  return fitAnsi(text, width - 1) + '…';
}
/**
 * Word-wrap unstyled text to `width` cells.
 *
 * Breaks on spaces, hard-breaks words longer than the width, and honors
 * embedded newlines. Never returns an empty array — empty input wraps to
 * `['']`.
 *
 * ```ts
 * import { wrapPlain } from 'fino:tty/components/text';
 *
 * wrapPlain('hello wide world', 6); // ['hello', 'wide', 'world']
 * ```
 */
export function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let rest = paragraph;
    for (;;) {
      if (rest.length <= limit) {
        out.push(rest);
        break;
      }
      const window = rest.slice(0, limit + 1);
      const space = window.lastIndexOf(' ');
      if (space > 0) {
        out.push(rest.slice(0, space));
        rest = rest.slice(space + 1);
      } else {
        out.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
    }
  }
  return out.length > 0 ? out : [''];
}
/**
 * Prefix each line: the first with `prefix`, the rest with `contPrefix`
 * (which defaults to `prefix`).
 *
 * ```ts
 * import { indent } from 'fino:tty/components/text';
 *
 * indent(['a', 'b'], '- ', '  '); // ['- a', '  b']
 * ```
 */
export function indent(lines: string[], prefix: string, contPrefix = prefix): string[] {
  return lines.map((line, index) => (index === 0 ? prefix : contPrefix) + line);
}
