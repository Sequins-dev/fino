/**
 * fino:ui/components/theme — semantic style tokens shared by UI render targets.
 *
 * ```ts no_run
 * import { styles, Text } from 'fino:ui/components';
 *
 * Text({ style: [styles.bold, styles.accent], children: 'ready' });
 * ```
 */
import type { Style } from 'fino:tty/style';

export type { Style };

/** Default semantic style token table. */
export const styles = {
  accent: { fg: 'cyan' },
  muted: { fg: 'brightBlack' },
  danger: { fg: 'red' },
  success: { fg: 'green' },
  warning: { fg: 'yellow' },
  info: { fg: 'blue' },
  bold: { bold: true },
  dim: { dim: true },
  inverse: { inverse: true },
  underline: { underline: true },
  strike: { strike: true },
} as const satisfies Record<string, Style>;

/** Name of a default semantic style token. */
export type StyleToken = keyof typeof styles;
