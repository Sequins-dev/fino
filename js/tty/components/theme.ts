/**
 * fino:tty/components/theme — the ANSI styling tokens every component uses.
 *
 * Raw escape literals live only here; components compose colors through
 * `tk` and `style()` so the palette stays swappable in one place.
 */
/**
 * The theme tokens: named SGR escape sequences.
 *
 * ```ts
 * import { tk } from 'fino:tty/components/theme';
 *
 * tk.cyan; // '\x1b[36m'
 * ```
 */
export const tk = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  inverse: '\x1b[7m',
  underline: '\x1b[4m',
  white: '\x1b[97m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
} as const;
/** One of the escape sequences in {@link tk}. */
export type ThemeToken = (typeof tk)[keyof typeof tk];
/**
 * Wrap `text` in the given tokens, closing with a reset.
 *
 * With no tokens the text comes back unchanged, so callers can style
 * conditionally without branching.
 *
 * ```ts
 * import { tk, style } from 'fino:tty/components/theme';
 *
 * style('hi', tk.bold, tk.cyan); // '\x1b[1m\x1b[36mhi\x1b[0m'
 * style('hi'); // 'hi'
 * ```
 */
export function style(text: string, ...tokens: string[]): string {
  if (tokens.length === 0) return text;
  return tokens.join('') + text + tk.reset;
}
