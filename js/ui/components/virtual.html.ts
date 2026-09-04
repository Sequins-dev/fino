/** HTML lowering and scroll-action bridge markup for virtual lists. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  componentStyleAttrs,
  registerAction,
} from 'internal:ui/components/html-runtime';
import { VirtualList } from 'internal:ui/components/virtual';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

/** Browser row-height estimate used to convert scroll pixels to model rows. */
export const VIRTUAL_ROW_PX = 20;

function spacer(rows: number): VNode {
  return h('div', {
    className: 'ui-virtual-spacer',
    style: { height: `${rows * VIRTUAL_ROW_PX}px` },
    'aria-hidden': 'true',
  });
}

mapComponentLowering(VirtualList, 'html', (props, children) => {
  const { height, window: slice, offset, onScroll } = props;
  const attrs = componentStyleAttrs(props as Props, 'ui-virtual');
  attrs.style = {
    ...((attrs.style ?? {}) as Record<string, string>),
    height: `${Math.max(1, Math.floor(height)) * VIRTUAL_ROW_PX}px`,
  };
  const interactive = actionsActive() && onScroll !== undefined;
  if (interactive) {
    attrs['data-fi-scroll'] = '1';
    attrs['data-fi-row-height'] = String(VIRTUAL_ROW_PX);
  }
  const container = h(
    'div',
    attrs,
    slice.topPad > 0 ? spacer(slice.topPad) : null,
    ...children,
    slice.bottomPad > 0 ? spacer(slice.bottomPad) : null,
  );
  if (!interactive) return container;
  const action = registerAction((raw) => {
    const next = Number(raw);
    if (Number.isFinite(next)) onScroll!(Math.max(0, Math.floor(next)));
  });
  return actionForm(
    { act: action, change: true },
    h('input', { type: 'hidden', name: 'value', value: String(Math.max(0, Math.floor(offset))) }),
    container,
  );
});

registerHtmlCss(`
.ui-virtual { display: flex; flex-direction: column; overflow: auto; }
.ui-virtual-spacer { flex: 0 0 auto; }
`);
