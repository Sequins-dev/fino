/**
 * fino:ui/components/theme — semantic style tokens for the component catalog.
 *
 * Components reference these tokens rather than raw colors, so a whole
 * surface restyles by swapping the token table. Each render target resolves
 * a `Style` its own way: the terminal emits SGR through `fino:tty/style`,
 * HTML maps the same fields onto CSS custom properties.
 *
 * ```ts no_run
 * import { styles } from 'fino:ui/components/theme';
 * import { Text } from 'fino:ui/components';
 *
 * Text({ style: [styles.bold, styles.accent], children: ['ready'] });
 * ```
 */
import type { Style } from 'fino:tty/style';

export type { Style };

/** The semantic token table. */
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

export type StyleToken = keyof typeof styles;
