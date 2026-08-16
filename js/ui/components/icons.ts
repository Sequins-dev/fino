/**
 * internal:ui/components/icons — the semantic icon registry and the two
 * components that draw from it.
 *
 * The registry is data: names map to per-target forms, and each render target
 * picks its own column through `iconForm`. Nothing here decides presentation
 * beyond which string a target is handed.
 *
 * @internal
 */
import { h, type NormalizedChild, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  handlerOf,
  idAttr,
  register,
} from 'internal:ui/components/html-runtime';
import type { FlexChildProps, StyleProps } from 'internal:ui/components/primitives';

/** Per-target representations of one registry icon. */
export interface IconForms {
  /** Terminal form: a character or short glyph run. */
  tui: string;
  /** Web form: emoji or markup a render target may inline. */
  html: string;
}

/**
 * Built-in icon registry: semantic names to per-target forms. The registry is
 * data — each render target picks its own column via `iconForm`.
 */
// The terminal column stays monochrome width-1 glyphs — colored emoji read
// wrong in a TUI. Folder open/closed double as the file tree's expander.
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

/**
 * Resolve an icon name to its form for a target, consulting `overrides`
 * before the built-in registry. Unknown names fall back to the `file` icon.
 */
export function iconForm(
  name: string,
  target: keyof IconForms,
  overrides?: Record<string, IconForms>,
): string {
  const entry = overrides?.[name] ?? ICONS[name] ?? ICONS.file!;
  return entry[target];
}

/** Props accepted by `Icon`. */
export interface IconProps extends StyleProps, FlexChildProps, Props {
  /** Registry icon name. */
  name: string;
  /** Accessible label; icons are decorative without one. */
  label?: string;
  /** Per-name registry overrides. */
  icons?: Record<string, IconForms>;
  id?: string;
}
/** Registry-backed icon; each render target draws its own form. */
export function Icon(all: IconProps): VNode {
  const { children = [], ...props } = all as IconProps & { children?: NormalizedChild[] };
  const { name, label, icons, id } = props;
  const attrs: Props = { className: 'ui-icon', ...idAttr(id) };
  if (label !== undefined) attrs.title = label;
  else attrs['aria-hidden'] = 'true';
  return h('span', attrs, iconForm(name, 'html', icons));
}

/** Props accepted by `IconButton`. */
export interface IconButtonProps extends StyleProps, FlexChildProps, Props {
  /** Registry icon name. */
  icon: string;
  /** Accessible name — the icon alone carries no text, so this is required. */
  label: string;
  onClick?: () => void;
  focused?: boolean;
  disabled?: boolean;
  /** Per-name registry overrides, forwarded to `iconForm`. */
  icons?: Record<string, IconForms>;
  id?: string;
}
/** Icon-only button: a focusable click target whose accessible name comes from `label`, not visible text. */
export function IconButton(all: IconButtonProps): VNode {
  const { children = [], ...props } = all as IconButtonProps & { children?: NormalizedChild[] };
  const { icon, label, onClick, disabled, icons, id } = props;
  const click = handlerOf<() => void>(onClick);
  const enabled = disabled !== true && click !== undefined;
  const glyph = h(
    'span',
    { className: 'ui-icon', 'aria-hidden': 'true' },
    iconForm(icon, 'html', icons),
  );
  if (actionsActive() && enabled) {
    const act = register(() => click!());
    return actionForm(
      {},
      h(
        'button',
        { className: 'ui-icon-button', name: 'do', value: act, 'aria-label': label, ...idAttr(id) },
        glyph,
      ),
    );
  }
  const attrs: Props = {
    className: 'ui-icon-button',
    type: 'button',
    'aria-label': label,
    ...idAttr(id),
  };
  if (!enabled) attrs.disabled = true;
  return h('button', attrs, glyph);
}
