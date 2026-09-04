/** HTML lowerings and styles for disclosure components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import {
  componentStyleAttrs,
  controlledNativeValue,
  nativeAction,
} from 'internal:ui/components/html-runtime';
import { Details, Expander, TabList, Tabs } from 'internal:ui/components/disclosure';
import type { ExpanderPosition, TabItem } from 'internal:ui/components/disclosure';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

function expanderMark(open: boolean): VNode {
  return h('span', {
    className: `ui-expander${open ? ' is-open' : ''}`,
    'aria-hidden': 'true',
  });
}

function summaryContent(title: string, open: boolean, where: ExpanderPosition): VNode[] {
  const content: VNode[] = [];
  if (where === 'start') content.push(expanderMark(open));
  content.push(h('span', { className: 'ui-details-title' }, title));
  if (where === 'end') content.push(expanderMark(open));
  return content;
}

mapComponentLowering(Expander, 'html', (props) => {
  const { open, onToggle, disabled } = props;
  return nativeAction(
    h('button', {
      ...componentStyleAttrs(props as Props, `ui-expander${open ? ' is-open' : ''}`),
      'aria-label': open ? 'Collapse' : 'Expand',
    }),
    onToggle === undefined ? undefined : () => onToggle(!open),
    disabled === true,
  );
});

mapComponentLowering(Details, 'html', (props, children) => {
  const { title, open, onToggle, expander, focused: _focused } = props;
  const where = expander ?? 'start';
  const attrs = componentStyleAttrs(props as Props, 'ui-details');
  if (open) attrs.open = true;
  const content = summaryContent(title, open, where);
  const summary =
    onToggle === undefined
      ? h('summary', { className: 'ui-details-summary ui-row' }, ...content)
      : h(
          'summary',
          { className: 'ui-details-summary' },
          nativeAction(h('button', { className: 'ui-details-toggle ui-row' }, ...content), () =>
            onToggle(!open),
          ),
        );
  return h('details', attrs, summary, h('div', { className: 'ui-details-body' }, ...children));
});

function validTabChange(
  items: readonly TabItem[],
  value: string,
  onChange: ((key: string) => void) | undefined,
): ((key?: string) => void) | undefined {
  if (onChange === undefined) return undefined;
  return (key): void => {
    if (
      key !== undefined &&
      key !== value &&
      items.some((item) => item.key === key && item.disabled !== true)
    ) {
      onChange(key);
    }
  };
}

mapComponentLowering(TabList, 'html', (props) => {
  const { items, value, onChange } = props;
  return controlledNativeValue(validTabChange(items, value, onChange), (attrs) =>
    h(
      'nav',
      componentStyleAttrs(props as Props, 'ui-tabs'),
      ...items.map((item) => {
        const active = item.key === value;
        const disabled = active || item.disabled === true || attrs.disabled === true;
        return h(
          'button',
          {
            ...attrs,
            type: attrs.name === undefined ? 'button' : undefined,
            value: item.key,
            className:
              `ui-tab${active ? ' is-active' : ''}` +
              (item.disabled === true ? ' is-disabled' : ''),
            disabled,
            role: 'tab',
            'aria-selected': active ? 'true' : 'false',
          },
          item.label,
        );
      }),
    ),
  );
});

mapComponentLowering(Tabs, 'html', (props, children) =>
  h(
    'div',
    componentStyleAttrs(props as Props, 'ui-tabs-wrap'),
    h(TabList, props),
    h('div', { className: 'ui-tab-panel', role: 'tabpanel' }, ...children),
  ),
);

registerHtmlCss(`
.ui-row { display: flex; align-items: center; gap: 0.5rem; }
.ui-expander {
  width: 1rem; height: 1rem; border: 0; padding: 0; background: transparent;
  color: inherit; cursor: pointer;
}
.ui-expander::before { content: '›'; display: block; transition: transform 120ms ease; }
.ui-expander.is-open::before { transform: rotate(90deg); }
.ui-details { border-bottom: 1px solid var(--ui-border); }
.ui-details-summary { cursor: pointer; list-style: none; }
.ui-details-summary::-webkit-details-marker { display: none; }
.ui-details-toggle {
  width: 100%; border: 0; padding: 0.5rem 0; background: transparent;
  color: inherit; text-align: left; cursor: pointer;
}
.ui-details-title { font-weight: 600; }
.ui-details-body { padding: 0.25rem 0 0.75rem 1.5rem; }
.ui-tabs { display: flex; gap: 1rem; border-bottom: 1px solid var(--ui-border); }
.ui-tab {
  border: 0; border-bottom: 2px solid transparent; padding: 0.5rem 0;
  background: transparent; color: var(--tui-bright-black); cursor: pointer;
}
.ui-tab.is-active { color: var(--tui-fg); border-bottom-color: var(--tui-cyan); font-weight: 700; }
.ui-tab.is-disabled { opacity: 0.5; cursor: not-allowed; }
.ui-tab-panel { padding-top: 0.75rem; }
`);
