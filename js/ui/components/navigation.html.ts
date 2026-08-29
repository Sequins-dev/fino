/** HTML lowerings and styles for navigation components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { componentStyleAttrs, controlledNativeValue } from 'internal:ui/components/html-runtime';
import { Breadcrumbs, Pagination, Steps, paginationRange } from 'internal:ui/components/navigation';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

mapComponentLowering(Breadcrumbs, 'html', (props) => {
  const { items, onNavigate } = props;
  const valid = new Set(items.slice(0, -1).map((item) => item.key));
  return controlledNativeValue(
    onNavigate === undefined
      ? undefined
      : (key) => {
          if (key !== undefined && valid.has(key)) onNavigate(key);
        },
    (attrs) =>
      h(
        'nav',
        {
          ...componentStyleAttrs(props as Props, 'ui-crumbs'),
          'aria-label': 'breadcrumbs',
        },
        ...items.flatMap((item, index) => {
          const current = index === items.length - 1;
          const entry: VNode = current
            ? h('strong', null, item.label)
            : h(
                'button',
                {
                  ...attrs,
                  type: attrs.name === undefined ? 'button' : undefined,
                  className: 'ui-crumb',
                  value: item.key,
                },
                item.label,
              );
          return index === 0
            ? [entry]
            : [h('span', { className: 'ui-crumbs-sep', 'aria-hidden': 'true' }, '/'), entry];
        }),
      ),
  );
});

mapComponentLowering(Pagination, 'html', (props) => {
  const { page, pages, siblings, onChange } = props;
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const range = paginationRange(current, total, siblings);
  return controlledNativeValue(
    onChange === undefined
      ? undefined
      : (raw) => {
          const target = Number(raw);
          if (Number.isInteger(target) && target >= 1 && target <= total && target !== current) {
            onChange(target);
          }
        },
    (attrs) => {
      const button = (target: number, label: string, disabled: boolean): VNode =>
        h(
          'button',
          {
            ...attrs,
            type: attrs.name === undefined ? 'button' : undefined,
            value: String(target),
            className: `ui-pager-button${target === current ? ' is-current' : ''}`,
            disabled: disabled || attrs.disabled === true,
            'aria-current': target === current ? 'page' : undefined,
          },
          label,
        );
      return h(
        'nav',
        componentStyleAttrs(props as Props, 'ui-pager'),
        button(current - 1, '‹', current === 1),
        ...range.map((entry, index) =>
          entry === 'ellipsis'
            ? h('span', { key: `e:${index}`, className: 'ui-pager-ellipsis' }, '…')
            : button(entry, String(entry), entry === current),
        ),
        button(current + 1, '›', current === total),
      );
    },
  );
});

mapComponentLowering(Steps, 'html', (props) => {
  const at = props.steps.findIndex((step) => step.key === props.current);
  return h(
    'ol',
    componentStyleAttrs(props as Props, 'ui-steps'),
    ...props.steps.map((step, index) => {
      const state = at !== -1 && index < at ? 'done' : index === at ? 'current' : 'upcoming';
      return h(
        'li',
        { className: `is-${state}` },
        h('span', { className: 'ui-step-dot', 'aria-hidden': 'true' }),
        h('span', null, step.label),
      );
    }),
  );
});

registerHtmlCss(`
.ui-crumbs, .ui-pager, .ui-steps { display: flex; align-items: center; gap: 0.5rem; }
.ui-crumbs button, .ui-pager button { border: 0; background: transparent; color: inherit; cursor: pointer; }
.ui-crumbs-sep, .ui-pager-ellipsis { color: var(--tui-bright-black); }
.ui-pager-button { min-width: 2rem; padding: 0.35rem 0.5rem; border-radius: 0.25rem !important; }
.ui-pager-button.is-current { background: var(--ui-selected); font-weight: 700; }
.ui-steps { padding: 0; list-style: none; }
.ui-steps li { display: flex; align-items: center; gap: 0.4rem; }
.ui-steps li + li::before { content: ''; width: 1.5rem; border-top: 1px solid var(--ui-border); }
.ui-step-dot { width: 0.6rem; height: 0.6rem; border: 1px solid currentColor; border-radius: 50%; }
.ui-steps .is-done { color: var(--tui-green); }
.ui-steps .is-current { color: var(--tui-cyan); font-weight: 700; }
.ui-steps .is-upcoming { color: var(--tui-bright-black); }
`);
