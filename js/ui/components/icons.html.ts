/**
 * HTML lowerings and styles for icon components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { componentStyleAttrs, nativeAction } from 'internal:ui/components/html-runtime';
import { Icon, IconButton, iconForm } from 'internal:ui/components/icons';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

mapComponentLowering(Icon, 'html', (props) => {
  const { name, label, icons } = props;
  const attrs = componentStyleAttrs(props as Props, 'ui-icon');
  if (label === undefined) attrs['aria-hidden'] = 'true';
  else attrs.title = label;
  return h('span', attrs, iconForm(name, 'html', icons));
});

mapComponentLowering(IconButton, 'html', (props) => {
  const { icon, label, onClick, disabled, icons } = props;
  const attrs = componentStyleAttrs(props as Props, 'ui-icon-button');
  attrs['aria-label'] = label;
  const glyph = h(
    'span',
    { className: 'ui-icon', 'aria-hidden': 'true' },
    iconForm(icon, 'html', icons),
  );
  return nativeAction(h('button', attrs, glyph), onClick, disabled === true);
});

registerHtmlCss(`
.ui-icon { display: inline-block; flex: none; }
.ui-icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2rem; height: 2rem; border: 1px solid var(--ui-border);
  border-radius: 0.375rem; cursor: pointer;
}
.ui-icon-button:hover:not(:disabled) { border-color: var(--ui-accent); }
.ui-icon-button:disabled { opacity: 0.45; cursor: default; }
`);
