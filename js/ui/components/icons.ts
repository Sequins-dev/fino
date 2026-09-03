/**
 * Semantic icon registry and component definitions.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** Per-target representations of one semantic icon. */
export interface IconForms {
  /** Monochrome terminal glyph. */
  tui: string;
  /** Browser representation. */
  html: string;
}

/** Built-in semantic icon registry. */
export const ICONS: Record<string, IconForms> = {
  folder: { tui: '▸', html: '📁' },
  'folder-open': { tui: '▾', html: '📂' },
  file: { tui: '·', html: '📄' },
  code: { tui: '◆', html: '📜' },
  doc: { tui: '¶', html: '📝' },
  config: { tui: '⚙', html: '🔧' },
  image: { tui: '▣', html: '🎨' },
  lock: { tui: '∗', html: '🔒' },
  shell: { tui: '$', html: '🐚' },
  'chevron-right': { tui: '▸', html: '▸' },
  'chevron-down': { tui: '▾', html: '▾' },
};

/** Resolve a semantic icon, preferring caller overrides and falling back to `file`. */
export function iconForm(
  name: string,
  target: keyof IconForms,
  overrides?: Record<string, IconForms>,
): string {
  return (overrides?.[name] ?? ICONS[name] ?? overrides?.file ?? ICONS.file!)[target];
}

/** Props accepted by {@link Icon}. */
export interface IconProps extends StyleProps, FlexChildProps, Props {
  /** Semantic icon name. */
  name: string;
  /** Accessible label; omitted icons are decorative. */
  label?: string;
  /** Per-name registry overrides. */
  icons?: Record<string, IconForms>;
}

/** Registry-backed semantic icon. */
export function Icon(props: IconProps): VNode {
  return h('ui:icon', props);
}

/** Props accepted by {@link IconButton}. */
export interface IconButtonProps extends StyleProps, FlexChildProps, Props {
  /** Semantic icon name. */
  icon: string;
  /** Accessible name for the icon-only control. */
  label: string;
  /** Activation callback. */
  onClick?: () => void;
  /** Whether to render the focused terminal state. */
  focused?: boolean;
  /** Whether interaction is disabled. */
  disabled?: boolean;
  /** Per-name registry overrides. */
  icons?: Record<string, IconForms>;
}

/** Accessible icon-only action button. */
export function IconButton(props: IconButtonProps): VNode {
  return h('ui:icon-button', props);
}
